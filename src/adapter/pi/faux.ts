/**
 * 离线 provider —— 一个**不联网、不需要凭据**的真 provider。
 *
 * 它不是替身，也不是 mock：它是 `pi-ai` 自己提供的 `fauxProvider`，走真的注册、
 * 真的 auth 解析、真的 `AssistantMessageEventStream`，只是"模型"由一个函数给出。
 * 所以拿它驱动一次 Run，走的是**生产代码路径**（真适配器、真流解码、真工具、
 * 真文件系统、真事件日志），唯一被替换的是推理本身。
 *
 * ## 为什么它值得作为一个产品能力存在
 *
 * 两个理由，都不是"测试方便"：
 *
 * 1. **接线要能被证明。** 一个需要凭据才能验证的系统，在拿到凭据之前没人知道
 *    它通不通。离线模式让"会话存储、工具 allowlist、路径围栏、事件日志、
 *    trace"这一整条链路可以在任何机器上被端到端跑一遍——它是一个**冒烟测试**，
 *    而且是一个走生产路径的冒烟测试。
 * 2. **回归语料需要一个确定的模型。** 步 10 的 golden transcripts 要能逐字节复现，
 *    而真 provider 的方差（同一句话两次给出不同工具调用）会让"语义有没有变"
 *    这件事永远无法回答。
 *
 * ## 它不会假装自己回答了问题
 *
 * 这件事必须做得很明确，否则一个离线运行会被误读成"Agent 的结论"。三重标识：
 * 报告的第一句写清它遵循的是固定流程、`usage_reported.model` 是 `faux/…`、
 * 而 CLI 在离线模式下会往 stderr 打一行说明。**结论里的事实是从真材料里抄的**
 * （路径、行号、原文都来自工具返回值），但"抄哪些行"不是推理的结果——
 * 这一点由报告自己说出来，而不是由读的人去猜。
 *
 * ## 流程为什么会随材料变
 *
 * `FauxResponseFactory` 拿得到 provider 收到的 `Context`，所以它看得见前面每次
 * 调用的结果——包括每条工具结果里 `details` 携带的**结构化返回值**（我们的适配器
 * 写进去的，见 `history.ts`）。于是离线流程可以"读到哪算到哪"：
 * 列目录 → 按模式搜索 → 读第一条命中的那个文件 → 交结论。这不是固定的用例脚本，
 * 它对任何仓库都成立。
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context as PiContext,
  Model,
  Models,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { ASK_HUMAN_TOOL, SUBMIT_REPORT_TOOL } from "./protocol.js";

/** 离线流程默认找什么。它是搜索的模式，也是报告里那句话的一部分。 */
export const DEFAULT_OFFLINE_PATTERN = "TODO";

export interface OfflineProviderOptions {
  /** provider 名字。默认 `faux`。它会出现在 `model_requested.model` 里。 */
  readonly provider?: string;
  /** 模型 id。默认 `offline-script`。 */
  readonly modelId?: string;
  /** 搜索的模式（JavaScript 正则，不区分大小写）。默认 `TODO`。 */
  readonly pattern?: string;
  /** 一条 evidence 里最多保留多少条命中。默认 3。 */
  readonly maxEvidence?: number;
}

export interface OfflineProvider {
  readonly models: Models;
  readonly model: Model<string>;
  /** 它遵循的流程，一句话。用来在输出里如实说明结论是怎么来的。 */
  readonly procedure: string;
  /** 这些响应一共被取用了几次。用来断言"流程真的走了这么多轮"。 */
  readonly calls: () => number;
}

/** 一段文本压成一行、截断。摘要出现在报告里，所以它必须有界。 */
function clip(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 最后一条工具结果。它是"上一步看到了什么"的唯一来源。 */
function lastResult(context: PiContext): ToolResultMessage | null {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message !== undefined && message.role === "toolResult") return message;
  }
  return null;
}

interface Match {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

function matchesOf(result: ToolResultMessage): readonly Match[] {
  const details = asRecord(result.details);
  const raw = details?.["matches"];
  if (!Array.isArray(raw)) return [];
  const out: Match[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const path = record?.["path"];
    const line = record?.["line"];
    const text = record?.["text"];
    if (typeof path === "string" && typeof line === "number" && typeof text === "string") {
      out.push({ path, line, text });
    }
  }
  return out;
}

/**
 * 结论：从**真实材料**里抄出来的那几条事实。
 *
 * 注意每一条 claim 的 evidence 都是上一次工具结果里真实存在的东西——
 * 于是它与步 9 的证据核对（`src/runtime/verify.ts`）天然对得上。
 * 对不上就说明抽取写错了，而那种错误会让核对当场把它标成"没看过的行"。
 */
function buildReport(
  search: ToolResultMessage | null,
  read: ToolResultMessage | null,
  pattern: string,
  maxEvidence: number,
): Record<string, unknown> {
  const matches = search === null ? [] : matchesOf(search);
  const readDetails = asRecord(read?.details);
  const claims: Record<string, unknown>[] = [];

  claims.push({
    text: `按模式「${pattern}」在仓库里搜到 ${matches.length} 行命中，其中前 ${Math.min(
      matches.length,
      maxEvidence,
    )} 条来自这些文件的这些行。`,
    evidence: matches.slice(0, maxEvidence).map((match) => ({
      path: match.path,
      lines: [match.line, match.line],
      excerpt: clip(match.text),
    })),
  });

  const readPath = readDetails?.["path"];
  const startLine = readDetails?.["startLine"];
  const endLine = readDetails?.["endLine"];
  const lines = readDetails?.["lines"];
  const firstLine = Array.isArray(lines) ? asRecord(lines[0]) : null;
  const firstText = firstLine?.["text"];

  if (typeof readPath === "string" && typeof startLine === "number" && typeof endLine === "number") {
    claims.push({
      text: `读了 ${readPath} 的第 ${startLine}-${endLine} 行，这是第一条命中所在的文件。`,
      evidence: [
        {
          path: readPath,
          lines: [startLine, endLine],
          excerpt: typeof firstText === "string" ? clip(firstText) : "",
        },
      ],
    });
  } else {
    // 没有读到文件：这条论断**明说没有依据**（空数组），而不是省略它。
    claims.push({
      text: "没有成功读到任何文件的内容。",
      evidence: [],
    });
  }

  return {
    summary:
      `离线脚本模式：按固定流程读了这个仓库（list_dir → search_text → read_file）。` +
      `下面的事实是从工具返回的材料里抄出来的，不是模型推理的结论。` +
      (matches.length === 0 ? `模式「${pattern}」一行也没命中。` : ""),
    claims,
  };
}

/**
 * 下一步做什么。
 *
 * 它按**上一轮看到了什么**分派，所以流程会随材料变化（第一步一定是列目录，
 * 之后每一步都取决于上一步的结果），而不是一串写死的用例。
 */
function planNext(context: PiContext, options: Required<OfflineProviderOptions>): AssistantMessage {
  const last = lastResult(context);

  if (last === null) {
    // 第 1 轮：先看清楚这个仓库的根目录长什么样。
    return fauxAssistantMessage(fauxToolCall("list_dir", { path: "." }));
  }

  if (last.toolName === "list_dir") {
    // `maxMatches` 故意很小：搜索结果是**可被截断**的（超过 `OBSERVATION_CHAR_LIMIT`
    // 之后 `value` 会被替换成一段文本预览，结构就没了），而离线流程要读它的结构。
    // 这条约束是实测撞出来的：不限条数时一次搜索就把结果顶出上限，
    // 于是"命中 0 条"——一个由截断造成的假相。
    return fauxAssistantMessage(
      fauxToolCall("search_text", { pattern: options.pattern, maxMatches: 5 }),
    );
  }

  if (last.toolName === "search_text") {
    const first = matchesOf(last)[0];
    if (first !== undefined) {
      return fauxAssistantMessage(
        fauxToolCall("read_file", { path: first.path, startLine: 1, endLine: 40 }),
      );
    }
    // 一行也没命中：没有可读的文件，直接交结论（那条无依据的论断会被核对标出来）。
    return fauxAssistantMessage(
      fauxToolCall(SUBMIT_REPORT_TOOL, buildReport(last, null, options.pattern, options.maxEvidence)),
    );
  }

  if (last.toolName === "read_file") {
    // 读过了：交结论。搜索的那一条结果要往前找回来，因为报告同时引用它们。
    const search = context.messages
      .filter((message): message is ToolResultMessage => message.role === "toolResult")
      .filter((message) => message.toolName === "search_text")
      .at(-1);
    return fauxAssistantMessage(
      fauxToolCall(
        SUBMIT_REPORT_TOOL,
        buildReport(search ?? null, last, options.pattern, options.maxEvidence),
      ),
    );
  }

  // 到不了这里。真到了就说明流程比预期多走了一轮，而"多走一轮"必须可见：
  // 它比安静地重复上一个动作好——重复动作会一直烧预算直到被墙钟拦住。
  return fauxAssistantMessage(
    `离线脚本没有为工具 ${last.toolName} 定义下一步。` +
      `这条消息会被适配器当成一次普通的文本应答交付（claims 为空），` +
      `而不是一个编造的结论。`,
    { stopReason: "stop" },
  );
}

/**
 * 建一个离线 provider，并把它注册进一个全新的 `Models`。
 *
 * 返回的 `models` 直接交给 `piModelAdapter`——**它和真 provider 的接线完全一样**，
 * 这也是"SDK 可替换"在这里的一次实际使用：换 provider 不改任何一行调用方代码。
 */
export function offlineProvider(options: OfflineProviderOptions = {}): OfflineProvider {
  const resolved: Required<OfflineProviderOptions> = {
    provider: options.provider ?? "faux",
    modelId: options.modelId ?? "offline-script",
    pattern: options.pattern ?? DEFAULT_OFFLINE_PATTERN,
    maxEvidence: options.maxEvidence ?? 3,
  };

  const handle = fauxProvider({
    provider: resolved.provider,
    api: resolved.provider,
    models: [{ id: resolved.modelId, name: `${resolved.provider}/${resolved.modelId}` }],
  });

  const models = createModels();
  models.setProvider(handle.provider);

  const model = handle.getModel(resolved.modelId);
  if (model === undefined) {
    throw new Error(
      `离线 provider 没有注册出模型 ${resolved.modelId}：` +
        `fauxProvider 的 models 定义与这里要的名字不一致`,
    );
  }

  /**
   * 每一步都把自己重新排进队列。
   *
   * faux 的脚本是**按次取用**的（`pendingResponses.shift()`），取完就报
   * "No more faux responses queued"。而离线流程要走几轮取决于仓库内容，
   * 事先算不出来。所以工厂在返回当前这一步的同时把"下一步"再排一条进去——
   * 队列于是永远有一条，而分支发生在 `planNext` 里，不在这里。
   */
  const respond = (context: PiContext): AssistantMessage => {
    const message = planNext(context, resolved);
    handle.appendResponses([respond]);
    return message;
  };
  handle.setResponses([respond]);

  return {
    models,
    model,
    procedure: `list_dir(.) → search_text(${resolved.pattern}) → read_file(第一条命中) → ${SUBMIT_REPORT_TOOL}`,
    calls: () => handle.state.callCount,
  };
}

/** 离线 provider 能用的协议工具名。留一个引用，说明 `ask_human` 也在词汇里。 */
export const OFFLINE_TERMINAL_TOOLS = Object.freeze([SUBMIT_REPORT_TOOL, ASK_HUMAN_TOOL]);
