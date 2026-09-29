/**
 * trace —— 事件日志的纯投影：这次会话**干了什么、为什么停、花了多少**。
 *
 * 它不重算任何 SDK 已经数过的东西（token 数来自最后一条 assistant 消息的
 * usage），也不维护自己的状态——日志是唯一真相，trace 是同一份真相的读法。
 */

import type { LogEvent } from "./log.js";

export interface TraceStep {
  readonly tool: string;
  readonly args: unknown;
}

export interface TraceUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

export interface Trace {
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** 按序的工具调用（含参数）。 */
  readonly steps: readonly TraceStep[];
  /** 遇到的错误（工具错误与模型错误都算），按序。 */
  readonly errors: readonly string[];
  /** 最后一条 assistant 消息的 token 账目；没有任何账目时是 null（未知，不是零）。 */
  readonly usage: TraceUsage | null;
  /** 事件条数。 */
  readonly eventCount: number;
}

export function traceOf(events: readonly LogEvent[]): Trace {
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  const steps: TraceStep[] = [];
  const errors: string[] = [];
  let usage: TraceUsage | null = null;

  for (const event of events) {
    startedAt ??= event.ts;
    endedAt = event.ts;
    if (event.type === "tool_call") {
      steps.push({ tool: String(event["tool"] ?? "?"), args: event["args"] });
    } else if (event.type === "error") {
      errors.push(String(event["message"] ?? "unknown"));
    } else if (event.type === "message_end" && event["role"] === "assistant") {
      const u = event["usage"] as TraceUsage | undefined;
      if (u !== undefined && u !== null) {
        usage = {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          costUsd: u.costUsd,
        };
      }
    }
  }

  return { startedAt, endedAt, steps, errors, usage, eventCount: events.length };
}
