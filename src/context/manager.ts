/**
 * ContextManager —— 两层上下文策略（specs/context.md）：
 *
 * 1. **单结果截断**（afterToolCall 钩子）：超 maxToolResultChars 的文本部分
 *    头尾保留 + 显式截断标记；
 * 2. **预算压缩**（transformContext 钩子）：token 估算（≈chars/4，确定性离线）
 *    超 compactAboveTokens → 旧回合替换为 LLM 摘要，最近 keepRecentMessages
 *    逐字保留，切点落在 user 消息边界（assistant 的工具结果永不和它拆开）。
 *
 * token 估算与切点逻辑复用 pi-agent-core 的纯函数（estimateTokens）；
 * 摘要由调用方注入的 summarizer 生成（默认走当前模型的 completeSimple）。
 */

import type { AfterToolCallContext, AfterToolCallResult, AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-agent-core";

export type Summarizer = (transcript: string, signal?: AbortSignal) => Promise<string>;

export interface ContextManagerOptions {
  readonly maxToolResultChars?: number;
  /** 0 = 关闭自动压缩。 */
  readonly compactAboveTokens?: number;
  readonly keepRecentMessages?: number;
  readonly summarize: Summarizer;
}

const TRUNCATION_MARKER = (dropped: number): string => `\n[…截断：省略 ${dropped} 字符，完整输出未保留…]`;

/** 头尾保留：日志在头、错误在尾，两头的上下文价值最高。 */
function truncateMiddle(text: string, limit: number): { text: string; dropped: number } {
  if (text.length <= limit) return { text, dropped: 0 };
  const keep = Math.floor(limit / 2);
  const dropped = text.length - limit;
  return { text: `${text.slice(0, keep)}${TRUNCATION_MARKER(dropped)}${text.slice(text.length - keep)}`, dropped };
}

export class ContextManager {
  private readonly maxToolResultChars: number;
  private readonly compactAboveTokens: number;
  private readonly keepRecentMessages: number;
  private readonly summarize: Summarizer;

  constructor(options: ContextManagerOptions) {
    this.maxToolResultChars = options.maxToolResultChars ?? 20_000;
    this.compactAboveTokens = options.compactAboveTokens ?? 80_000;
    this.keepRecentMessages = options.keepRecentMessages ?? 12;
    this.summarize = options.summarize;
  }

  /** afterToolCall 钩子：超长文本结果截断（details 原样保留给 UI）。 */
  handleAfterToolCall(context: AfterToolCallContext): AfterToolCallResult | undefined {
    let droppedTotal = 0;
    const content = context.result.content.map((part) => {
      if (part.type !== "text") return part;
      const truncated = truncateMiddle(part.text, this.maxToolResultChars);
      if (truncated.dropped === 0) return part;
      droppedTotal += truncated.dropped;
      return { type: "text" as const, text: truncated.text };
    });
    if (droppedTotal === 0) return undefined;
    return { content, details: context.result.details, isError: context.isError };
  }

  estimate(messages: readonly AgentMessage[]): number {
    return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  }

  /** transformContext 钩子：超预算时压缩，否则原样返回。 */
  makeTransformContext(): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
    return async (messages, signal) => {
      if (this.compactAboveTokens <= 0) return messages;
      if (this.estimate(messages) <= this.compactAboveTokens) return messages;
      return this.compact(messages, signal);
    };
  }

  /** 压缩：[摘要, ...recent]。切点在 user 消息边界；没有可安全压缩的切点时原样返回。 */
  async compact(messages: readonly AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    const cut = this.cutPoint(messages);
    if (cut <= 0) return [...messages];
    const old = messages.slice(0, cut);
    const recent = messages.slice(cut);
    const summary = await this.summarize(transcriptText(old), signal);
    const summaryMessage: AgentMessage = {
      role: "user",
      content: `<conversation-summary>\n${summary}\n</conversation-summary>`,
      timestamp: Date.now(),
    };
    return [summaryMessage, ...recent];
  }

  /**
   * 切点：从后往前的第 keepRecentMessages 个 **user 消息** 的位置——
   * assistant 回合（含它的工具结果）永远不会被从中间拆开。
   */
  private cutPoint(messages: readonly AgentMessage[]): number {
    let seen = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as { role?: string; content?: unknown } | undefined;
      if (message === undefined || message.role !== "user") continue;
      if (typeof message.content !== "string") continue;
      if (message.content.includes("<conversation-summary>")) continue; // 已是压缩产物
      seen += 1;
      if (seen > this.keepRecentMessages) return index;
    }
    return 0;
  }
}

function transcriptText(messages: readonly AgentMessage[]): string {
  return messages
    .map((raw) => {
      const message = raw as { role?: string; content?: unknown };
      const content = message.content;
      const role = message.role ?? "?";
      if (typeof content === "string") return `${role}: ${content}`;
      if (Array.isArray(content)) {
        return `${role}: ${content
          .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : `[${String((part as { type: unknown }).type ?? "content")}]`))
          .join(" ")}`;
      }
      return `${role}: …`;
    })
    .join("\n\n");
}
