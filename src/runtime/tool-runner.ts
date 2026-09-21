/**
 * 工具执行层 —— 一次工具调用从哪里进来，以什么形状出去。
 *
 * 这个文件只回答一个问题：**一个不可信的调用，如何变成一条可信的观测？**
 * 它不回答「观测进状态之后发生什么」——那是步 3 的 Core。
 *
 * 三条边界在这里落地：
 *
 * 1. **工具的输出是不可信输入。** 名字、参数、返回值、抛出的异常，四样都不可信，
 *    四样都要在进入状态之前过一道关。`ToolOutcome` 与 `Observation` 分成两个类型
 *    （步 2）就是为了让这一道关有个落点：工具只能产出 `{ value, error }`，
 *    `provenance` 与 `truncated` 只能由这一侧写入，工具填不了，也伪造不了。
 * 2. **一次工具失败是数据，不是结局。** 它落成一条 `error` 非 null 的观测，
 *    Run 继续往下走，终态是 `partial` 加上点名缺失的材料——而不是一次
 *    `run_failed`。唯一不与失败等价的抛出物是**我们自己那条停止信号**：
 *    停止不是工具的错，它必须原样交回驱动方去归因（步 5）。
 * 3. **能进日志的东西，才是能进状态的东西。** 事件日志是唯一真相，而它最终是
 *    JSONL（步 7）——所以参数与返回值都必须能被 JSON 无损表示。JSON 里会**静默**
 *    变形的东西（`undefined`、函数、`Map`、循环引用、`NaN`）在这里被拦下：
 *    静默丢掉一个字段比报一个错糟得多，因为它看起来像是这条材料本来就没有那部分。
 *
 * `ToolOutcome → Observation` 的转换**只在这个文件里发生**（步 2 的编译期证明
 * 就是为这一步准备的），Core 一行都不用改：它只认识 `assembleObservation` 这条
 * 接缝的位置，不认识截断阈值、超时、allowlist——那些都是执行策略。
 */

import type { AssembleObservation } from "../core/loop.js";
import type {
  AgentState,
  Observation,
  ToolError,
  ToolIntent,
  ToolOutcome,
  ToolPort,
} from "../core/types.js";
import { createRunSignal } from "./termination.js";
import type { TimeoutSignalFactory } from "./termination.js";
import type { RunAgentOptions } from "./run-agent.js";

// ---------------------------------------------------------------------------
// 两个常量：都是工程判断，都不是配置项
// ---------------------------------------------------------------------------

/**
 * 一条观测的字符上限。超出的部分被替换成一段文本预览，并在观测上留下
 * `truncated: true`。
 *
 * 它守住的不是「大文件不好」，而是两条更硬的事实：
 * - 事件日志是唯一真相，一条 Run 的日志必须**有界**——否则一次读 20 个文件的
 *   Run 会写出一份几十 MB 的证据，回放、trace、传输都会跟着一起贵；
 * - 截断**必须可见**。悄悄砍掉一段材料，等于让一次「部分拿到」看起来像「全部拿到」。
 *
 * 8000 这个数字是判断，不是推导（与步 5 的 `DEFAULT_BUDGET` 同一性质）：够放下
 * 一次真实的文件片段或一段 grep 输出，又不至于让状态膨胀。**故意不做成配置项**——
 * 没有任何证据表明它需要按调用方变化，而多一个旋钮就多一种「同一个任务在不同
 * 配置下产出了不同的证据」的可能，那正是回放最怕的事。
 */
export const OBSERVATION_CHAR_LIMIT = 8_000;

/**
 * 单次工具调用的超时。与 `budget_timeout`（整次 Run 的墙钟，步 5）分开：
 * 一个是「这次 Run 该收工了」，一个是「这一条材料别等了」。
 *
 * 60 秒同样是判断：一次真实的文件读取或命令执行不该比它更久，而卡死的调用
 * 必须有个尽头——尽头之后 Run 还能继续，缺的材料会被点名。
 */
export const CALL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// 执行层的错误码：与 RunErrorCode 是两个词汇表
// ---------------------------------------------------------------------------

/**
 * 执行层会产生的全部工具错误码。
 *
 * 它们**不是** `RunErrorCode`，这是刻意的：两个词汇表回答的问题不同。
 * `RunErrorCode` 说的是「这一次 Run 为什么不干了」，工具错误说的是「这一条材料
 * 为什么没拿到」。一次工具失败不结束 Run，所以它不该借用 Run 级的码——
 * 否则 `tool_completed` 上出现一个 `rate_limited`，读者会以为 provider 限流了
 * 整个 Run，而实际上只是某个工具自己撞上了限流。
 *
 * `timeout` 是唯一两边同名的：意思确实是同一件事（一次调用的时间到了），
 * 区别只在后果——工具超时被隔离（Run 继续），模型请求超时是致命的（步 8）。
 * 这个不对称有理由：「这一条材料还能不要吗」在两侧的答案不同。
 */
export const TOOL_ERROR_CODES = {
  invalid_tool: "工具名不在端口声明的 allowlist 里",
  invalid_args: "参数不是可 JSON 无损表示的值",
  invalid_result: "工具返回值不是可 JSON 无损表示的值",
  timeout: "单次调用超时",
  tool_failed: "工具抛出了异常",
} as const satisfies Record<string, string>;

export type ToolErrorCode = keyof typeof TOOL_ERROR_CODES;

function toolError(code: ToolErrorCode, message: string): ToolError {
  return { code, message };
}

/** 一条「这一次调用没拿到材料」的原始结果。 */
function failed(code: ToolErrorCode, message: string): ToolOutcome {
  return { value: null, error: toolError(code, message) };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return typeof error === "string" ? error : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组（${value.length} 项）`;
  const type = typeof value;
  if (type !== "object") return type;
  const constructor = (value as { constructor?: { name?: string } }).constructor;
  return `${constructor?.name ?? "匿名对象"} 实例`;
}

// ---------------------------------------------------------------------------
// 「能进日志吗」—— 参数与返回值共用的一条准入规则
// ---------------------------------------------------------------------------

/**
 * 找出第一个让这个值无法被 JSON 无损表示的**问题**；没有就返回 null。
 *
 * 为什么是「无损」而不是「能序列化」：`JSON.stringify` 会因为几个原因**安静地**
 * 改变值，而安静的改变恰恰是这份系统最不能容忍的一类错误——
 *
 * - `undefined` / 函数 / symbol 作为对象的键，JSON 直接**丢掉这个键**；
 * - 数组里的空位与 `undefined` 变成 `null`；
 * - `NaN` / `Infinity` 变成 `null`；
 * - `Map` / `Set` / `Error` 这类对象取可枚举自有属性，通常得到 `{}`——整个内容没了；
 * - 循环引用让 `JSON.stringify` **抛错**（这个至少不安静，但会在写日志那一刻爆，
 *   而不是在数据进来的那一刻）。
 *
 * 声明了 `toJSON` 的对象按它自己的契约接受（`Date` 就是这一类）：`toJSON` 是
 * 「我知道怎么表示我自己」的显式承诺，我们不替它验证它的输出——那是它的事。
 *
 * `path` 是给人看的（`args.path`、`value[2]`）：一条拒绝必须说得清是哪一部分有问题，
 * 否则模型只会收到「参数非法」然后原样重试。
 */
function findJsonProblem(value: unknown, path: string): string | null {
  try {
    return walkJson(value, path, new Set<object>());
  } catch (error) {
    // getter 抛错、代理陷阱之类：遍历本身失败，那也是一种「进不了日志」。
    return `${path} 无法遍历：${messageOf(error)}`;
  }
}

function walkJson(value: unknown, path: string, ancestors: Set<object>): string | null {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : `${path} 是 ${String(value)}（JSON 里会变成 null）`;
    case "undefined":
      return `${path} 是 undefined（JSON 会静默丢掉这个键）`;
    case "bigint":
      return `${path} 是 bigint（JSON 序列化会直接抛错）`;
    case "function":
    case "symbol":
      return `${path} 是 ${typeof value}（JSON 会静默丢掉这个键）`;
    default:
      break;
  }

  const object = value as object;

  // 只判环，不是判重：同一个对象在兄弟位置出现两次是合法的。
  if (ancestors.has(object)) return `${path} 是循环引用（JSON 序列化会直接抛错）`;
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index += 1) {
        if (!(index in object)) return `${path}[${index}] 是空位（JSON 会把它变成 null）`;
        const problem = walkJson(object[index], `${path}[${index}]`, ancestors);
        if (problem !== null) return problem;
      }
      return null;
    }

    if (hasToJson(object)) return null;

    const prototype = Object.getPrototypeOf(object) as object | null;
    if (prototype !== null && prototype !== Object.prototype) {
      return (
        `${path} 是 ${describeValue(value)}（不是普通对象，JSON 只取它的可枚举自有属性，` +
        `Map / Set / Error 会静默变成 {}）`
      );
    }

    for (const [key, inner] of Object.entries(object)) {
      const problem = walkJson(inner, `${path}.${key}`, ancestors);
      if (problem !== null) return problem;
    }
    return null;
  } finally {
    ancestors.delete(object);
  }
}

function hasToJson(object: object): boolean {
  return typeof (object as { toJSON?: unknown }).toJSON === "function";
}

// ---------------------------------------------------------------------------
// 关卡：名字、参数、返回值
// ---------------------------------------------------------------------------

/**
 * 名字与参数的准入检查。通过返回 null。
 *
 * allowlist 判断放在这里，而不是指望适配器自己检查：`ToolPort.names` 是端口
 * **声明**它能做什么，而「模型只能从这里面选」必须有人执法。这一步的假工具
 * （步 3）也做了同样的检查，那不是重复——那边是模拟，这边是执行层的执法点。
 */
function rejectIntent(intent: ToolIntent, allowed: ReadonlySet<string>, names: readonly string[]): ToolError | null {
  if (!allowed.has(intent.name)) {
    return toolError(
      "invalid_tool",
      `没有名为 ${intent.name} 的工具（allowlist：${names.length === 0 ? "空" : names.join(", ")}）`,
    );
  }

  if (!isRecord(intent.args)) {
    return toolError("invalid_args", `参数必须是一个对象，收到 ${describeValue(intent.args)}`);
  }

  const problem = findJsonProblem(intent.args, "args");
  if (problem !== null) return toolError("invalid_args", `参数进不了事件日志：${problem}`);

  return null;
}

/**
 * 把执行层交回来的东西归一成一条 `ToolOutcome`。
 *
 * `ToolPort.execute` 的**签名**承诺返回 `ToolOutcome`，但签名拦不住一个真实适配器
 * 在运行时交回别的形状——而它是不可信的，所以要当场检查。检查之后，
 * 「返回值能进日志」这条准入规则和参数用的是同一个 `findJsonProblem`：
 * **进出的东西受同一条规则管**，这条边界才有意义。
 */
function normalizeOutcome(outcome: unknown): ToolOutcome {
  // 关卡 5：交回来的东西是不是一个 `ToolOutcome`。
  if (!isRecord(outcome)) {
    return failed("tool_failed", `执行层返回的不是一个 ToolOutcome，而是 ${describeValue(outcome)}`);
  }

  const { value, error } = outcome as { readonly value?: unknown; readonly error?: unknown };

  // 关卡 6：返回值能不能进日志。
  const problem = findJsonProblem(value, "value");
  if (problem !== null) return failed("invalid_result", `工具返回的值进不了事件日志：${problem}`);
  if (error === null || error === undefined) return { value, error: null };

  // 错误的形状也要检查：它会进日志、会被 `missingMaterial` 读，所以它必须是一个
  // 能读的 `{ code, message }`——一个字符串形式的错误在这里被拦下，而不是等到
  // 某个只读消费者对着 `undefined` 发愣。
  if (!isRecord(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string") {
    return failed(
      "tool_failed",
      `执行层报的错误不是 { code, message }：${describeValue(error)}——` +
        `观测的错误字段会进入日志，所以它必须有一个能读的形状`,
    );
  }

  return { value, error: { code: error["code"], message: error["message"] } };
}

// ---------------------------------------------------------------------------
// 执行层本体
// ---------------------------------------------------------------------------

export interface ToolRunnerOptions {
  /** 真正干活的端口。执行层在外面包一层，不是替它。 */
  readonly tools: ToolPort;
  /** `provenance.at` 的来源。真实时间是 `Date.now`；测试与 golden 用确定性时钟。 */
  readonly clock: () => number;
  /** 单次调用超时的来源。默认 `AbortSignal.timeout`，见 `termination.ts`。 */
  readonly timeoutSignal?: TimeoutSignalFactory;
}

/**
 * 这一层交给 Runtime 的**全部**字段。
 *
 * 三个而不是两个——这一点是被测试抓出来的：`tools` 与 `assembleObservation` 是
 * 「一次调用怎么发生」的写侧，而 `collectMissingMaterial` 是它的读侧
 * （从终态算出缺了什么）。只交前两个的话，调用方很容易接上执行层却忘了接读侧的
 * 默认实现，于是**一次工具失败的 Run 会被报成 `complete`**——失败被完整地记录，
 * 然后被安静地忽略。这类错误不会报错，只会让结论比证据更自信。
 *
 * 形状从 `RunAgentOptions` 里取（字段改名会在这里当场编译不过），再用 `Required`
 * 去掉可选性：源类型里这三个都是可选的（不接线也能跑），但**这一层一旦交出来，
 * 就必须三个都交**。少了任何一个都是编译错误，而不是运行时的一次静默降级——
 * 第一次写这个文件时正是漏了第三个，而它是被测试抓到的，不是被类型。
 */
export type ToolLayerDeps = Required<
  Pick<RunAgentOptions, "tools" | "assembleObservation" | "collectMissingMaterial">
>;

export interface ToolRunner {
  /** 交给驱动的工具端口：校验、超时、失败隔离都在它后面。 */
  readonly tools: ToolPort;
  /** 交给驱动的组装接缝：截断与 `provenance` 在这里发生。 */
  readonly assembleObservation: AssembleObservation;
  /** 三个字段一起摊进 `createRuntime`——配对是结构性的，不靠记性。 */
  readonly toolDeps: () => ToolLayerDeps;
}

export function createToolRunner(options: ToolRunnerOptions): ToolRunner {
  const inner = options.tools;
  const clock = options.clock;
  const createTimeout = options.timeoutSignal ?? AbortSignal.timeout;
  const allowed = new Set(inner.names);

  /**
   * 组装：`ToolOutcome` → `Observation`。**这是整个文件里唯一发生这件事的地方。**
   *
   * 它写工具写不了的两个字段，所以一个坏工具伪造不了证据的来源：
   * - `provenance.source` 是工具名（谁取回来的），`at` 来自注入的时钟——
   *   回放时沿用原值，不重新取时间；
   * - `truncated` 由这里算，因为截断发生在这里。
   *
   * 截断是**替换**不是省略：超长时 `value` 变成一段文本预览。保留原值的类型
   * 是不可能的（砍掉一半的 JSON 不是一个对象），所以预览是字符串这件事本身就是
   * `truncated: true` 的含义——看到它的人知道手上不是完整材料，也不是一个可解析的值。
   */
  const assembleObservation: AssembleObservation = (intent, outcome): Observation => {
    let truncated = false;

    // 关卡 7：结果超过上限就换成一段预览。不保留原类型是刻意的，
    // 所以 `truncated: true` 的准确含义是「`value` 是一段预览，不是原始值」。
    let value = outcome.value;
    const rendered = JSON.stringify(value);
    if (rendered.length > OBSERVATION_CHAR_LIMIT) {
      value = rendered.slice(0, OBSERVATION_CHAR_LIMIT);
      truncated = true;
    }

    let error = outcome.error;
    if (error !== null && error.message.length > OBSERVATION_CHAR_LIMIT) {
      error = { code: error.code, message: error.message.slice(0, OBSERVATION_CHAR_LIMIT) };
      truncated = true;
    }

    return {
      // 关卡 8：来源与时刻由我们写。工具写不了这两个字段，也伪造不了——
      // 它交回来的东西在关卡 5 已经被重建过一次了。
      tool: intent.name,
      value,
      error,
      truncated,
      provenance: { source: intent.name, at: clock() },
    };
  };

  const tools: ToolPort = {
    names: inner.names,
    async execute(intent, signal): Promise<ToolOutcome> {
      // 关卡 1、2：名字与参数。被拒的调用**一次都不会到达端口**，
      // 这一点由测试用内层端口的调用计数断言，而不是看事件流。
      const rejection = rejectIntent(intent, allowed, inner.names);
      if (rejection !== null) return { value: null, error: rejection };

      // 关卡 3：这次 Run 已经被停了。那不是工具的失败，所以不落成观测，
      // 原样抛回去让驱动方归因。
      if (signal.aborted) throw signal.reason;

      // 关卡 4：单次调用的超时。用步 5 那套组合信号——外部（这次 Run 的信号）
      // 加我们自己的墙钟（这一次调用的计时器），并且**先响的说了算**。
      // 于是「是 Run 被取消了，还是这一次调用自己超时了」有一个自己说得清的答案，
      // 不需要去猜工具抛出来的异常长什么样。这是步 5 那套机制第一次被第二处复用，
      // 而它不需要为这一处改一行。
      const call = createRunSignal({
        external: signal,
        timeoutMs: CALL_TIMEOUT_MS,
        timeoutSignal: createTimeout,
      });

      try {
        const outcome = await inner.execute(intent, call.signal);
        return normalizeOutcome(outcome);
      } catch (error) {
        const cause = call.cause();

        // Run 被停了：抛出物是 provider 的词汇，Runtime 一个都不认（步 5）。
        if (cause === "external") throw error;

        // 我们自己的计时器到点：这是一条**可隔离的**失败——材料没拿到，Run 还能继续。
        if (cause === "wall_clock") {
          return failed(
            "timeout",
            `单次调用超时：${CALL_TIMEOUT_MS}ms 之内 ${intent.name} 没有返回` +
              `（这一步不会结束 Run，缺的材料会被点名）`,
          );
        }

        // 工具自己抛了。端口契约说它该用 `error` 字段回报失败，但契约拦不住
        // 一个真实的适配器，而「一次工具失败」不该把整次 Run 带走。
        return failed(
          "tool_failed",
          `${intent.name} 抛出了异常：${messageOf(error)}（这一步不会结束 Run，缺的材料会被点名）`,
        );
      } finally {
        // 摘掉挂在这次 Run 信号上的监听器。不摘的话，一次 64 次工具调用的 Run
        // 会在同一条信号上留下 64 个监听器——它们不会出错，只会一直在。
        call.dispose();
      }
    },
  };

  return {
    tools,
    assembleObservation,
    toolDeps: () => ({ tools, assembleObservation, collectMissingMaterial }),
  };
}

// ---------------------------------------------------------------------------
// 缺了什么材料：读侧
// ---------------------------------------------------------------------------

/** 一条清单项里，参数摘要最长这么多字符。它是给人看的，不是给机器解析的。 */
const ARG_DIGEST_CHAR_LIMIT = 80;

/**
 * 从终态状态算出「哪些该拿到却没拿到」。
 *
 * 它是执行层的**读侧**，与上面那些错误码住在同一个文件里不是巧合：
 * 「什么算失败」（写侧）与「什么算缺失」（读侧）必须是同一套判断，
 * 分开放就一定会有一次它们悄悄不一致。`run_completed.status` 的
 * `complete` / `partial` 由这份清单驱动（非空即 `partial`）。
 *
 * 三条来源，都从 transcript 派生（状态里没有第二份投影，步 2）：
 * 1. 观测带 `error` ——工具失败了；
 * 2. 观测 `truncated` ——拿到了，但只拿到一部分；
 * 3. 有 `call_tool` 的意图、后面没有对应的观测 ——调用没有回来。
 *    今天从 `run_completed` 这条路径上是够不着的（一旦调用被停止信号打断，
 *    这次 Run 就不会走到 `run_completed`），但它是状态的合法形状，
 *    而回放（步 7）会从任意前缀重建状态——那时它就会出现。所以它在这里，
 *    不因为「现在不会发生」而省略。
 *
 * 清单项是 `工具名(参数摘要)：原因`，因为缺失的粒度不是「read_file 这个工具没了」，
 * 而是「这次 read_file 没读回来」。同一条重复出现只记一次（同一个工具用同样的参数
 * 失败三次是同一份材料缺了三次，不是三份材料）。
 */
export function collectMissingMaterial(state: AgentState): readonly string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  const push = (entry: string): void => {
    if (seen.has(entry)) return;
    seen.add(entry);
    missing.push(entry);
  };

  const transcript = state.transcript;

  for (let index = 0; index < transcript.length; index += 1) {
    const message = transcript[index];
    if (message === undefined) continue;
    if (message.role !== "tool") continue;

    if (message.observation.error !== null) {
      const { code, message: text } = message.observation.error;
      push(`${digestIntent(message.intent)}：${code}——${short(text, ARG_DIGEST_CHAR_LIMIT)}`);
    } else if (message.observation.truncated) {
      push(
        `${digestIntent(message.intent)}：结果被截断` +
          `（只保留了前 ${OBSERVATION_CHAR_LIMIT} 个字符）`,
      );
    }
  }

  for (let index = 0; index < transcript.length; index += 1) {
    const message = transcript[index];
    if (message === undefined) continue;
    if (message.role !== "assistant") continue;
    if (message.decision.kind !== "call_tool") continue;

    const next = transcript[index + 1];
    if (next !== undefined && next.role === "tool") continue;

    push(`${digestIntent(message.decision.intent)}：调用没有回来（有意图、无观测）`);
  }

  return missing;
}

/**
 * 「一次调用」压成一行：`工具名(参数摘要)`，有长度上限。
 *
 * 它导出，是因为它是**两处的同一句话**：`missingMaterial` 的清单项要用它
 * （"哪个调用没拿到材料"），步 9 的 trace 也要用它（"按序调用了什么"）。
 * 各写一份的话，同一份日志在两处会被描述成不同的样子——而清单与 trace
 * 必须能互相核对，否则"缺了什么"就没法和"做过什么"对上账。
 */
export function digestIntent(intent: ToolIntent): string {
  const keys = Object.keys(intent.args);
  if (keys.length === 0) return intent.name;
  const digest = JSON.stringify(intent.args);
  return `${intent.name}(${short(digest, ARG_DIGEST_CHAR_LIMIT)})`;
}

function short(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
