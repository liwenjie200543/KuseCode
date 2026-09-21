import type { AgentEvent } from "../../../../src/index";

/**
 * 事件 → 一行可读文本。纯函数、穷尽 switch（不认识的形状编译不过），
 * 渲染层不解读业务语义，只忠实转述事件自己说了什么。
 */
export interface EventLabel {
  readonly tone: "info" | "tool" | "ok" | "warn" | "error" | "human";
  readonly text: string;
}

export function eventLabel(event: AgentEvent): EventLabel {
  switch (event.type) {
    case "run_started":
      return { tone: "info", text: "Run 开始" };
    case "model_requested":
      return { tone: "info", text: `请求模型 ${event.model ?? "未知"}` };
    case "decision_made":
      switch (event.decision.kind) {
        case "call_tool":
          return { tone: "tool", text: `决定调用工具 ${event.decision.intent.name}` };
        case "respond":
          return { tone: "ok", text: `决定交付：${event.decision.report.summary}` };
        case "ask_human":
          return { tone: "human", text: `需要人：${event.decision.question}` };
        default: {
          const _exhaustive: never = event.decision;
          return { tone: "warn", text: `未知决策 ${JSON.stringify(_exhaustive)}` };
        }
      }
    case "tool_started":
      return { tone: "tool", text: `工具开始 ${event.toolName}` };
    case "tool_completed":
      return {
        tone: event.status === "success" ? "tool" : "error",
        text:
          event.status === "success"
            ? `工具完成 ${event.toolName}（${event.durationMs}ms）`
            : `工具失败 ${event.toolName}：${event.error?.message ?? "未知错误"}`,
      };
    case "observation_added":
      return { tone: "info", text: `观测入账 ${event.name}` };
    case "human_input_requested":
      return { tone: "human", text: `等待人的输入：${event.question}` };
    case "human_input_received":
      return { tone: "human", text: `收到输入：${event.input}` };
    case "run_resumed":
      return { tone: "info", text: "Run 恢复" };
    case "usage_reported": {
      const u = event.usage;
      const tokens =
        u.inputTokens === null && u.outputTokens === null
          ? "账目未知"
          : `${u.inputTokens ?? "?"} 入 / ${u.outputTokens ?? "?"} 出`;
      return { tone: "info", text: `用量：${tokens}，工具 ${u.toolCalls} 次，${u.durationMs}ms` };
    }
    case "run_completed":
      return {
        tone: event.status === "complete" ? "ok" : "warn",
        text: `Run 完成（${event.status === "complete" ? "完整" : "部分"}）：${event.result.summary}`,
      };
    case "run_failed":
      return { tone: "error", text: `Run 失败 [${event.error.code}] ${event.error.message}` };
    case "run_cancelled":
      return { tone: "warn", text: "Run 已取消" };
    default: {
      const _exhaustive: never = event;
      return { tone: "warn", text: `未知事件 ${JSON.stringify(_exhaustive)}` };
    }
  }
}
