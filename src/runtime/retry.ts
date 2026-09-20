/**
 * 重试 —— 什么错误值得再来一次，以及等多久。
 *
 * 这个文件只回答一个问题：**provider 报了一个（已经归一过的）失败码，要不要重发？**
 *
 * 它分成两半，而这两半的所有者不同，这一点是这个文件存在的理由：
 *
 * - **"这个码是什么意思"** 是适配器的事（`src/adapter/pi/errors.ts` 把 provider 的
 *   说法翻成 `RunErrorCode`）；
 * - **"这个意思值不值得重试"** 是 Runtime 的政策，就是这里。
 *
 * 所以本文件只认 `RunErrorCode`，一行 provider 词汇都没有，也因此不需要 SDK
 * 就能被完整验证——重试逻辑最容易错的地方（该重试的没重试、不该重试的反复重试、
 * 取消之后还在重试）全都能用假端口钉住。
 *
 * 分类只有两类，判据是「重发能不能改变结果」：
 *
 * | 重试 | 为什么 | 不重试 | 为什么 |
 * |---|---|---|---|
 * | `rate_limited` | 等一会儿就好了 | `auth` | 凭据不对，重试三次只是浪费三次 |
 * | `timeout` | 上游可能只是慢 | `invalid_tool` | 请求本身是坏的，重发还是一样的请求 |
 * | `provider_unavailable` | 5xx / 断连通常是瞬时的 | `runtime_error` | 我们不认识它，重试等于赌 |
 * | | | `budget_*` / `no_progress` | 那是**我们自己**停的，不是 provider 的问题 |
 *
 * 最后一条最容易被写错：把 `budget_iterations` 拿去重试，等于一边说"预算用完了"
 * 一边继续花钱。
 */

import type { RunErrorCode } from "../core/types.js";

/**
 * 重试政策。
 *
 * `maxRetries` 是**额外**次数，不是总次数：`maxRetries: 2` 表示最多三次尝试。
 * 这个约定与 SDK 自己的同名选项一致（`ProviderRequestOptions.maxRetries`），
 * 免得两个"重试 2 次"合起来变成四次请求而没人发现。
 */
export interface RetryPolicy {
  readonly maxRetries: number;
  /** 第一次重试前等多久；之后每次翻倍。 */
  readonly baseDelayMs: number;
  /** 退避的上限。没有它，第 10 次重试会等 17 分钟。 */
  readonly maxDelayMs: number;
}

/** 默认退避：250ms 起，翻倍，封顶 4s。 */
export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
});

/** 值得重试的失败码。表就是分类本身，写成数据以便逐条验证。 */
const RETRYABLE = {
  // provider 侧，通常是瞬时的
  rate_limited: true,
  timeout: true,
  provider_unavailable: true,
  // 重发不会改变结果的
  auth: false,
  invalid_tool: false,
  runtime_error: false,
  // 我们自己停的
  budget_iterations: false,
  budget_tools: false,
  budget_timeout: false,
  budget_tokens: false,
  no_progress: false,
} as const satisfies Record<RunErrorCode, boolean>;

/**
 * 这个失败值得重试吗。
 *
 * `null`（没有码，例如信号中止）**永远不重试**：那意味着归因权在 Runtime 手上，
 * 而 Runtime 只在"我们自己的信号响了"时才留下没有码的失败——那正是最不该重试的
 * 情况。这条判断是整个文件里最重要的一行，它让"取消之后还在偷偷重试"在结构上
 * 不可能发生。
 */
export function isRetryable(code: RunErrorCode | null): boolean {
  if (code === null) return false;
  return RETRYABLE[code];
}

/**
 * 第 `attempt` 次失败之后该等多久（`attempt` 从 0 开始）。
 *
 * 指数退避 + 封顶。不做抖动（jitter）：抖动是为了避免多个客户端同时重试打垮上游，
 * 而这里单进程、单 Run，加抖动只会让测试变得不确定——**没有收益的随机性就是噪声**。
 */
export function retryDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const exponent = Math.max(0, attempt);
  // 先封顶指数再乘，避免 baseDelayMs * 2**40 变成一个溢出的数
  const cap = Math.ceil(policy.maxDelayMs / Math.max(1, policy.baseDelayMs));
  const factor = Math.min(2 ** exponent, cap);
  return Math.min(policy.baseDelayMs * factor, policy.maxDelayMs);
}

/** 还该不该再试一次：`attempt` 是**已经失败**的次数（从 1 开始数）。 */
export function shouldRetry(code: RunErrorCode | null, failedAttempts: number, policy: RetryPolicy): boolean {
  return isRetryable(code) && failedAttempts <= policy.maxRetries;
}

/**
 * 从预算里取出重试政策。
 *
 * `maxRetries` 的所有者是 `RunBudget`（步 2 的词汇），退避参数是本文件的政策。
 * 这样"重试几次"是调用方在预算里说的话，而"怎么等"是我们的事——
 * 一个不该由调用方每次重复选择的细节。
 */
export function retryPolicyFrom(
  maxRetries: number,
  overrides: Partial<Omit<RetryPolicy, "maxRetries">> = {},
): RetryPolicy {
  return {
    maxRetries: Math.max(0, Math.floor(maxRetries)),
    baseDelayMs: overrides.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: overrides.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
  };
}
