/**
 * provider 的用量说法 → Core 的用量账目。
 *
 * 这个文件很短，而它之所以短，是因为**算术不在这里**：`addUsage` /
 * `unknownUsage` / `UsageAccumulator` 属于 `src/core/usage.ts`——`ModelUsage`
 * 是 Core 的类型，它的运算法则也该只有一份。适配器只负责一件事：
 * 把 provider 的 `AssistuntMessage.usage` 翻译成 Core 认的两个数。
 *
 * 它同时记录了一个**真实存在的缺口**，而不是把它藏起来：
 *
 * > deepseek 路径下 `agent_end` 的 assistant message 不带 usage 字段
 * > （2026-08-22 真机验证，verification-log 缺口 2）。
 *
 * 于是这里的核心判断不是"怎么换算 token 数"（那是 provider 的事），而是
 * **"不知道的时候要回答 `null`，而不是 `0`"**。`0` 会顺着 `usage_reported`
 * 一路流进成本报告，把"没测到"说成"没花钱"——这是本项目最不能接受的一类谎言
 * （与 `run_completed` 不许把 partial 说成 complete 是同一条规矩）。
 *
 * `cacheRead` / `cacheWrite` / `reasoning` / `cost` 都**不进** Core 的用量
 * 载荷：`usage_reported` 的字段是步 2 定下的（input/output/toolCalls/durationMs/model），
 * 而成本换算需要价格表——那是产品面的事，不是 Core 的词汇。把它们丢在适配器里
 * 是有代价的（成本追踪今天做不了），所以它写进了 docs/08 的局限一节。
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelUsage } from "../../core/types.js";

// 算术从 Core 原样转发：适配器与假模型用的是**同一份**规则。这里再写一遍
// 曾在步 8 出过一次错（`null` 当加法单位元，账本永远是未知）。
export { addUsage, unknownUsage, UsageAccumulator } from "../../core/usage.js";

/**
 * 一个可能缺失的数字 → `number | null`。
 *
 * provider 的响应是**不可信输入**：类型上说 `input` 是 `number`，真机上它可能是
 * `undefined`。所以这里做的是运行时检查，不是类型体操。
 */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 一轮的用量。两项都可能为 `null`（provider 没报）。 */
export function usageFromMessage(message: AssistantMessage): ModelUsage {
  const usage: unknown = message.usage;
  if (usage === null || typeof usage !== "object") {
    return { inputTokens: null, outputTokens: null };
  }
  const record = usage as { input?: unknown; output?: unknown };
  return {
    inputTokens: tokenCount(record.input),
    outputTokens: tokenCount(record.output),
  };
}
