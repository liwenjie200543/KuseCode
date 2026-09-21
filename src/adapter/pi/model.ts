/**
 * `ModelPort` 的 Pi 实现。
 *
 * ## 为什么是 pi-ai 的"单轮流"，而不是 `createAgentSession`
 *
 * Pi Agent SDK 里有两个层次，而它们回答的是不同的问题：
 *
 * | 层次 | 它拥有的东西 | 与本项目的关系 |
 * |---|---|---|
 * | `@earendil-works/pi-coding-agent`（coding agent 层） | **整个循环**：它自己问模型、自己执行工具、自己把结果喂回去 | 它的核心价值正好是步 3 已经归 Core 的东西 |
 * | `@earendil-works/pi-ai`（AI 层） | **一次模型请求**：messages + tools → 一轮 assistant 消息 | 它正好是 `ModelPort.decide` 要的东西 |
 *
 * 用 coding agent 层来实现 `decide`，等于让 SDK 拥有循环：工具会由它执行、
 * 我们步 6 的八道关会被绕开、事件顺序会由它决定。那不是"把 SDK 挡在端口后面"，
 * 那是把端口拆了。所以这一层用 **pi-ai**，而 coding agent 层的 `defineTool`
 * 只在 `tools.ts` 里用来证明同一个 `ToolPort` 也能驱动 SDK 自己的循环——
 * 双向都能走通，才叫"可替换"。
 *
 * ## 一条必须记住的协议事实
 *
 * 流在 provider 出错时**不 reject**，而是以 `{type:"error"}` 收尾并带一个
 * `stopReason: "error"` 的 `AssistantMessage`。所以失败判据是 `stopReason`，
 * 不是异常——只写 try/catch 会漏掉全部 provider 错误。
 *
 * 顺带一处刻意的配置：请求里写死 `maxRetries: 0`。SDK 自己有客户端重试，
 * 而重试策略属于 Runtime（要按归一化之后的码决定值不值得重试、要计入
 * `maxRetries` 预算、要写进事件流）。**两处都重试就会有一个没人数得清的账**，
 * 所以这里把它关掉，只留一个重试者。
 */

import { Type } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  Model,
  Models,
  SimpleStreamOptions,
  Tool as PiTool,
  TSchema,
} from "@earendil-works/pi-ai";
import type { AgentState, Decision, ModelPort, ModelUsage, ModelUsageLedger, RunErrorCode } from "../../core/types.js";
import { redactor, secretsFromEnv } from "../../core/redact.js";
import { UsageAccumulator } from "../../core/usage.js";
import type { ToolCatalog } from "./catalog.js";
import { decideFromMessage } from "./decision.js";
import { AdapterError, adapterError, providerFailureFromThrow } from "./errors.js";
import { buildSystemPrompt, buildRequest } from "./history.js";
import { usageFromMessage } from "./usage.js";

export interface PiModelAdapterOptions {
  /** 模型集合（含已注册的 provider）。测试里可以是 `fauxProvider` 注册的那个。 */
  readonly models: Models;
  /** 具体用哪个模型。 */
  readonly model: Model<string>;
  /** 模型这次能看见的工具。 */
  readonly catalog: ToolCatalog;
  /**
   * 这一轮请求的采样选项。默认 `{}`；
   * `maxRetries` 由本适配器写死为 0，调用方改不了（见文件头）。
   */
  readonly options?: Omit<SimpleStreamOptions, "signal" | "maxRetries">;
  /** 覆盖默认的 system prompt。 */
  readonly systemPrompt?: string;
  /** 给 `Evidence.provenance.at` 与重建消息用。默认 `Date.now`。 */
  readonly clock?: () => number;
  /** 每一轮流事件的观察者。用于 trace / 流式呈现；不改变决策语义。 */
  readonly onEvent?: (event: AssistantMessageEvent) => void;
  /**
   * 抹掉一句话里的凭据。默认按**本进程环境**构造（见 `src/core/redact.ts`）。
   *
   * 它接在这里而不是接在日志上，是因为这里是**外部字符串进入我们词汇表的
   * 唯一一条路**：provider 的报错原文经过 `providerFailureFromStopReason` /
   * `providerFailureFromThrow` 变成 `RunError.message`，然后落进事件日志。
   * 一个把 key 回显进错误消息的 provider，就足以让凭据出现在证据里——
   * 而"证据里只有材料，没有我们的凭据"是这个项目对日志的基本承诺。
   *
   * 注入它是为了让它可测：测试可以给一份假的环境，而不是去改真的 `process.env`。
   */
  readonly redact?: (text: string) => string;
}

/**
 * 一次 Run 的账本。用信号的**对象身份**当键，所以两个 Run 不可能共享一个账本。
 *
 * 累加交给 Core 的 `UsageAccumulator`，因为"`null` 不是加法单位元"这条规则
 * 只有一份：账本的初始状态是**空**（`UsageAccumulator` 内部的 `null`），
 * 而不是"未知"（`{null, null}`）。后者会让第一次累加变成 `null + 120 = null`，
 * 于是账本永远是未知——这个错真的发生过，而它安静得没有任何异常会响。
 */
interface LedgerEntry {
  readonly usage: UsageAccumulator;
}

/** JSON Schema → provider 要的 TypeBox 形状。原样保留，不做有损转换。 */
function toPiTool(entry: { name: string; description: string; parameters: unknown }): PiTool {
  return {
    name: entry.name,
    description: entry.description,
    // `Type.Unsafe` 让我们的 JSON Schema 原封不动地过河：转换不该改变语义。
    // 断言是必要的，也是诚实的：schema 的形状由我们自己的 `spec.parse` 保证，
    // 而不是由 provider 的类型定义保证（那正是"声明与校验是两件事"）。
    parameters: Type.Unsafe(entry.parameters as TSchema),
  };
}

/**
 * 抹掉一个失败里的凭据，**不改变它的归因**。
 *
 * 两条必须同时成立：
 *
 * 1. **有 `code` 就还是有 `code`，没有就还是没有。** `code: null` 是"这次失败得由
 *    Runtime 归因"的表示（我们喊停时用的），重新构造一个带 `code: undefined` 的
 *    对象会把"归因权交回去了"这件事悄悄推翻——步 8 修过一次同样的错，
 *    所以这里用 `hasOwnProperty` 判断，而不是 `error.code !== undefined`。
 * 2. **只有 `AdapterError` 会被重造。** provider 的说法一律经它变成抛出物，
 *    而我们自己代码里的 bug（例如 `decideFromMessage` 里那句"Core 违反了契约"）
 *    不该被换成一个新对象——那会把真正的栈换掉，让一个内部错误看起来像
 *    provider 的错误。
 *
 * 消息没变（大多数情况）时原样抛出，保住原始栈。
 */
function redactCause(error: unknown, redact: (text: string) => string): unknown {
  if (!(error instanceof AdapterError)) return error;
  const message = redact(error.message);
  if (message === error.message) return error;
  const hasCode = Object.prototype.hasOwnProperty.call(error, "code");
  return new AdapterError({ code: hasCode ? (error.code as RunErrorCode) : null, message });
}

/**
 * 建一个 Pi 模型适配器。
 *
 * 返回的 `ModelPort` 只做三件事：组装请求、把 provider 的说法翻译成决策、
 * 记账。它不认识预算、不认识重试、不认识事件流——那三件事分别属于
 * `budget.ts`、`run-agent.ts` 与调用方，都属于 Runtime。
 */
export function piModelAdapter(options: PiModelAdapterOptions): ModelPort {
  const { models, model, catalog } = options;
  const clock = options.clock ?? ((): number => Date.now());
  const systemPrompt = options.systemPrompt ?? buildSystemPrompt();
  const requestOptions = options.options ?? {};
  const onEvent = options.onEvent;
  // 默认按本进程环境抹：不传它的时候，凭据仍然进不了日志（那条承诺不该依赖调用方）。
  const redact = options.redact ?? redactor(secretsFromEnv(process.env));

  const identity = { api: model.api, provider: model.provider, model: model.id };
  const piTools: readonly PiTool[] = catalog.entries.map(toPiTool);

  /** 账本的登记处。弱键：Run 结束、信号被回收之后条目不会留着。 */
  const ledgers = new WeakMap<AbortSignal, LedgerEntry>();

  return {
    beginRun(signal: AbortSignal): ModelUsageLedger {
      const entry: LedgerEntry = { usage: new UsageAccumulator() };
      ledgers.set(signal, entry);
      return {
        // 一次都没记过账时答"未知"（`{null, null}`），不答零。
        usage: (): ModelUsage => entry.usage.total(),
      };
    },

    async decide(state: AgentState, signal: AbortSignal): Promise<Decision> {
      // 外层这一圈只做一件事：把**任何**从这轮里逃出来的失败抹一遍凭据。
      // 它包住整轮（而不是只包流），因为 provider 的文本有两条出口——
      // 流里的 `stopReason`（`decideFromMessage` 抛）与流外的抛出物（下一层抛），
      // 漏掉任何一条，"凭据不进日志"就只成立一半。
      try {
        // 任务面的字段全部来自 Core 的投影；工具声明来自适配器的目录。
        const request = buildRequest({
          state,
          availableTools: catalog.allNames,
          identity,
          tools: catalog.entries,
          systemPrompt,
        });

        const context: PiContext = {
          systemPrompt: request.systemPrompt,
          messages: [...request.messages],
          tools: [...piTools],
        };

        let final: AssistantMessage | null = null;
        try {
          const stream = models.streamSimple(model, context, {
            ...requestOptions,
            signal,
            // 见文件头：重试只有一个所有者，就是 Runtime
            maxRetries: 0,
          });
          for await (const event of stream) {
            onEvent?.(event);
            if (event.type === "done") final = event.message;
            else if (event.type === "error") final = event.error;
          }
          // 流没有给出终态消息（理论上不会）：向它要最终结果
          final ??= await stream.result();
        } catch (error) {
          // 抛在流外面的是传输层问题（连接、鉴权解析、provider 未注册）
          throw adapterError(providerFailureFromThrow(error, signal));
        }

        const message: AssistantMessage = final;
        const entry = ledgers.get(signal);
        if (entry !== undefined) {
          // 记这一轮的账。空账本的第一次报账由 `UsageAccumulator` 处理成"替换"。
          entry.usage.add(usageFromMessage(message));
        }

        return decideFromMessage(message, { clock, signal });
      } catch (error) {
        throw redactCause(error, redact);
      }
    },
  };
}

/**
 * 从环境变量建一个"真实 provider"的模型集合。
 *
 * 它不在本步的验证范围里（没有凭据就没有真机会话），但把它写出来是为了让
 * `docs/08` 里的映射表有一条可执行的落点：**没有它，"怎么接真实 provider"
 * 就只是一段文档**。凭据从环境读，绝不写进代码、状态或事件。
 */
export async function envModelIdentity(): Promise<{ provider: string; model: string } | null> {
  const raw = process.env["KUSECODE_MODEL"]?.trim();
  if (raw === undefined || raw.length === 0) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}
