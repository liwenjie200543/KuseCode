/**
 * provider 的失败说法 → Core 的失败词汇。
 *
 * 这个文件只回答一个问题：**provider 报了一个错，它在这十个码里是哪一个？**
 *
 * 它存在，是因为步 4 定下了一条边界：`toRunError` 只接受**已经是合法
 * `RunErrorCode`** 的输入，它不猜、不从消息文本里认字符串——Runtime 不认识
 * provider。于是"认识 provider"这件事必须发生在别处，而且只能发生一次。
 * 这里就是那一次。
 *
 * 三条实现约定：
 *
 * 1. **纯函数，没有 import 任何 SDK 类型。** 输入是"一个 stopReason 加一句话"
 *    或者"一个抛出物"，都是普通数据。于是这张映射表可以在没有网络、没有凭据、
 *    没有 SDK 的情况下被逐条验证——provider 的错误分类里最容易错的部分，
 *    恰好是唯一不需要真机就能测的部分。
 * 2. **先看状态码，再看文本。** 状态码是结构化的、不会撒谎的；文本是兜底。
 *    只有状态码认不出来时才去读消息。
 * 3. **认不出来就是 `runtime_error`。** 不做"大概是限流吧"的猜测：一个猜错的
 *    分类会让 Runtime 去重试一个不该重试的请求（`auth` 重试三次只是浪费三次），
 *    而 `runtime_error` 至少是诚实的。
 *
 * 这张表的每一条都能追溯到真实记录：`402 Insufficient Balance` →
 * `provider_unavailable` 来自 2026-08-22 的那次真机验证（deepseek 余额耗尽）。
 */

import type { RunErrorCode } from "../../core/types.js";

/** provider 失败归一之后的样子。 */
export interface ProviderFailure {
  /** `null` = 这次失败不该由我们给它一个码（例如信号中止），归因留给 Runtime。 */
  readonly code: RunErrorCode | null;
  readonly message: string;
}

/**
 * 适配器自己抛出来的失败，带着一个**合法**的 `RunErrorCode`。
 *
 * 它的全部意义就是 `code` 这个字段：步 4 的 `toRunError` 会原样保留带合法 `code`
 * 的抛出物，所以适配器不需要、也不应该去 import Runtime——它只要抛出一个
 * 形状正确的对象，Runtime 就认得。
 *
 * `code` 为 `null` 时**不带** `code` 字段：那时 Runtime 会去问自己的信号
 * （"这是用户取消还是墙钟到点"），而这是只有它回答得了的问题。
 */
export class AdapterError extends Error {
  /**
   * 用 `declare` 而不是普通的字段声明，是一个**语义**上的要求，不是风格问题。
   *
   * `target: ES2022` 下 `useDefineForClassFields` 默认为真：一个普通的
   * `readonly code: RunErrorCode | undefined` 声明会在**每个**实例上定义
   * `code` 属性（值为 `undefined`），于是 `"code" in error` 恒为真——
   * 下面那句"不带 `code` 字段"就成了一句空话。而下游正是靠"有没有这个字段"
   * 决定要不要自己归因的（`toRunError`、`providerFailureFromThrow` 都这么做），
   * 所以这个属性一旦存在，取消与超时的归因就会被悄悄接管。
   */
  declare readonly code: RunErrorCode | undefined;

  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = "AdapterError";
    if (failure.code !== null) this.code = failure.code;
  }
}

/** 把一次归一过的失败变成可以抛出去的东西。 */
export function adapterError(failure: ProviderFailure): AdapterError {
  return new AdapterError(failure);
}

// ---------------------------------------------------------------------------
// 一张可审计的表：先按状态码，再按文本
// ---------------------------------------------------------------------------

/**
 * 状态码 → 失败码。
 *
 * 只有 HTTP 会给的东西放这里。`402` 单独列出来而不是并进 4xx：
 * 它的含义（余额/额度）与 `401`（凭据不对）完全不同，后果也不同——
 * 前者恢复额度就能重跑，后者怎么重试都没用。
 */
const BY_STATUS: Readonly<Record<number, RunErrorCode>> = Object.freeze({
  400: "runtime_error",
  401: "auth",
  402: "provider_unavailable",
  403: "auth",
  404: "runtime_error",
  408: "timeout",
  409: "runtime_error",
  413: "runtime_error",
  422: "invalid_tool",
  429: "rate_limited",
  500: "provider_unavailable",
  502: "provider_unavailable",
  503: "provider_unavailable",
  504: "provider_unavailable",
  529: "provider_unavailable",
});

/**
 * 文本 → 失败码。**顺序即优先级**，第一条命中就返回。
 *
 * 顺序是有理由的，不是随手排的：`insufficient` 必须排在 `rate limit` 前面，
 * 因为有些 provider 的额度耗尽消息里同时出现 "rate limit reached for your plan"；
 * 把它认成 `rate_limited` 会让 Runtime 重试三次，而真正的修法是去充值。
 */
const BY_TEXT: readonly (readonly [RegExp, RunErrorCode])[] = Object.freeze([
  // 额度/余额——恢复额度才能重跑，重试没有意义（但它是"provider 侧不可用"）
  [/insufficient|balance|quota|credit|billing|payment required|out of budget/i, "provider_unavailable"],
  // 凭据
  [/unauthori[sz]ed|invalid[_ -]?api[_ -]?key|api key|forbidden|authentication|no credentials/i, "auth"],
  // 限流
  [/rate[ _-]?limit|too many requests|slow down/i, "rate_limited"],
  // 单次超时
  [/timed?[ _-]?out|timeout|etimedout|deadline exceeded/i, "timeout"],
  // 传输层/Provider 侧不可用
  [
    /unavailable|overloaded|econnreset|econnrefused|enotfound|eai_again|socket hang up|network error|fetch failed|upstream/i,
    "provider_unavailable",
  ],
  // 参数/工具形状被 provider 拒（不是我们的工具 schema 校验，那是 step 6 的 invalid_tool）
  [/invalid[_ -]?(request|tool|schema)|tool[_ -]?use.*(fail|invalid)/i, "invalid_tool"],
]);

/** 从一句话里认出 HTTP 状态码。`\b` 保证 `1402` 不会被当成 `402`。 */
const STATUS_IN_TEXT = /\b([45]\d{2})\b/;

function codeFromText(text: string): RunErrorCode | null {
  const status = STATUS_IN_TEXT.exec(text);
  if (status !== null) {
    const parsed = Number.parseInt(status[1] ?? "", 10);
    const byStatus = BY_STATUS[parsed];
    if (byStatus !== undefined) return byStatus;
  }
  for (const [pattern, code] of BY_TEXT) {
    if (pattern.test(text)) return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 三个入口
// ---------------------------------------------------------------------------

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/**
 * 抛出物 → 失败。
 *
 * `signal.aborted` 时**不给码**（`code: null`）：这次失败的原因是我们自己的信号，
 * 而不是 provider 说了什么。给它一个码就等于替 Runtime 回答了一个它已经知道
 * 答案的问题，而且答得比它差——Runtime 手上有 `cause()`，能分清"用户取消"
 * 与"墙钟到点"，这里分不清。
 */
export function providerFailureFromThrow(error: unknown, signal: AbortSignal): ProviderFailure {
  const message = textOf(error);

  if (signal.aborted) return { code: null, message };
  // 抛出来的 AbortError 但没有中止的信号：是 SDK 自己打断的，不是我们
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "provider_unavailable", message: `provider 侧中止了这次请求：${message}` };
  }

  // 带合法 code 的抛出物原样保留——与 `toRunError` 同一条规则，
  // 但这里多一层：`oauth` 也要认（它是 provider 的词汇，不是我们的）。
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      if (code === "oauth") return { code: "auth", message };
      if (isKnownRunErrorCode(code)) return { code, message };
    }
  }

  const byText = codeFromText(message);
  if (byText !== null) return { code: byText, message };
  return { code: "runtime_error", message };
}

/**
 * 一轮的收场（`stopReason` + `errorMessage`）→ 失败。
 *
 * **这是流式路径唯一的失败入口**：pi-ai 的 `AssistantMessageEventStream` 在 provider
 * 出错时不是 reject，而是以 `{type: "error", error: AssistantMessage}` 收尾。所以
 * 「只看 try/catch」会漏掉全部 provider 错误——这是本文件最值得记住的一句话。
 */
export function providerFailureFromStopReason(
  stopReason: string,
  errorMessage: string | undefined,
  signal: AbortSignal,
): ProviderFailure | null {
  if (stopReason === "error") {
    const message = errorMessage ?? "provider 报了一个没有消息的错误";
    if (signal.aborted) return { code: null, message };
    const byText = codeFromText(message);
    return { code: byText ?? "runtime_error", message };
  }
  if (stopReason === "aborted") {
    const message = errorMessage ?? "请求被中止";
    // 我们的信号响了：不抢 Runtime 的归因权
    if (signal.aborted) return { code: null, message };
    return { code: "provider_unavailable", message: `provider 侧中止了这次请求：${message}` };
  }
  return null;
}

/**
 * 这个字串是不是一个合法 `RunErrorCode`。
 *
 * 本地再写一份而不是从 Runtime import：适配器与 Runtime 之间不该有依赖
 * （那会让"适配器可以整包删掉"这件事不再成立）。代价是这张表有两处，
 * 好处是它由 `satisfies` 在两边各自钉住，谁加码谁编译失败。
 */
const RUN_ERROR_CODE_SET = {
  budget_iterations: true,
  budget_tools: true,
  budget_timeout: true,
  budget_tokens: true,
  no_progress: true,
  rate_limited: true,
  timeout: true,
  auth: true,
  invalid_tool: true,
  provider_unavailable: true,
  runtime_error: true,
} as const satisfies Record<RunErrorCode, true>;

function isKnownRunErrorCode(value: string): value is RunErrorCode {
  return Object.prototype.hasOwnProperty.call(RUN_ERROR_CODE_SET, value);
}
