/**
 * bootstrap —— 从配置组装出一套可运行的 Agent（模型 + 工具 + 钩子 + 事件日志）。
 *
 * 这是产品面（CLI/TUI）唯一的接线点：接线只有一份，Agent 逻辑只有一份。
 * 各能力模块（tools/permissions/context/session/skills/mcp）在后续 Phase 落地时
 * 从这里接入。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createModelRegistry } from "../model/registry.js";
import { eventLogFor, type EventLog } from "../runtime/log.js";
import { buildSystemPrompt } from "./prompt.js";
import { createKuseAgent } from "./agent.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { KuseConfig } from "../config/schema.js";

export interface HarnessOptions {
  /** 项目根目录（工作区围栏与项目记忆的基准）。 */
  readonly projectRoot: string;
  readonly config: KuseConfig;
  /** 事件日志与会话文件的根目录。缺省 `<projectRoot>/.kusecode/runs`。 */
  readonly dataRoot?: string;
}

export interface Harness {
  readonly sessionId: string;
  readonly log: EventLog;
  /** 预留：各能力模块落地后由这里注入工具与钩子。 */
  run(text: string): Promise<string>;
  abort(): void;
  waitForIdle(): Promise<void>;
}

/** 数据根解析：显式指定 > `<projectRoot>/.kusecode/runs`。 */
export function dataRootFor(projectRoot: string, config: KuseConfig): string {
  return config.dataRoot ?? join(projectRoot, ".kusecode", "runs");
}

export async function bootstrapHarness(options: HarnessOptions): Promise<Harness> {
  const dataRoot = options.dataRoot ?? dataRootFor(options.projectRoot, options.config);
  await mkdir(join(dataRoot, "sessions"), { recursive: true });

  const sessionId = randomUUID();
  const log = eventLogFor(dataRoot, sessionId);
  const registry = createModelRegistry();
  if (options.config.model === "mock" || options.config.model === null) {
    // 第一版：mock 是"没有凭据也能跑"的默认路径（真实 provider 解析在 Phase 12 CLI 完善）。
    if (options.config.model === "mock") registry.enableMock();
  }
  const resolved = await registry.resolve(options.config.model === "mock" ? null : options.config.model);

  /** 在途的日志写入。run() 返回前必须清空——调用方读到的日志要完整。 */
  const pending: Promise<unknown>[] = [];
  const append = (event: { type: string } & Record<string, unknown>): void => {
    pending.push(
      log.append(event).catch(() => {
        // 日志写不进去不该让 Agent 崩溃——但这是一个可见的损失，留给 trace 的缺失说明。
      }),
    );
  };

  const agent = createKuseAgent({
    models: registry.models,
    model: resolved.model,
    systemPrompt: buildSystemPrompt(options.projectRoot, []),
    tools: [],
    hooks: {
      onEvent: (event) => {
        recordEvent(append, event);
      },
    },
  });

  return {
    sessionId,
    log,
    run: async (text) => {
      append({ type: "run_started", goal: text });
      try {
        await agent.prompt(text);
      } catch (error) {
        append({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        await Promise.all(pending);
        throw error;
      }
      // 事件日志的写入全部落定后 run 才返回：调用方（CLI/TUI）此刻读日志，
      // 读到的一定是完整真相——包括"为什么停"与最后一条消息。
      await Promise.all(pending);
      return lastAssistantText(agent.messages());
    },
    abort: () => agent.abort(),
    waitForIdle: () => agent.waitForIdle(),
  };
}

/** SDK 事件 → 日志事件（5 种词汇之一；原始事件整体保留在 details 里）。 */
function recordEvent(
  append: (event: { type: string } & Record<string, unknown>) => void,
  event: AgentEvent,
): void {
  switch (event.type) {
    case "message_end": {
      const message = event.message;
      if (message.role === "assistant" && message.stopReason === "error") {
        // 模型错误必须可见（trace 的"为什么停"），不能安静地只留一条空消息。
        append({
          type: "error",
          message: message.errorMessage ?? "provider error",
        });
      }
      append({
        type: "message_end",
        role: message.role,
        ...(message.role === "assistant"
          ? {
              usage: {
                inputTokens: message.usage?.input ?? null,
                outputTokens: message.usage?.output ?? null,
                costUsd: message.usage?.cost?.total ?? null,
              },
              stopReason: message.stopReason ?? null,
            }
          : {}),
        text: textOf(message),
      });
      return;
    }
    case "tool_execution_start":
      append({ type: "tool_call", tool: event.toolName, args: event.args });
      return;
    case "tool_execution_end":
      append({
        type: "tool_result",
        tool: event.toolName,
        isError: event.result?.isError ?? false,
      });
      return;
    case "agent_end":
      append({ type: "agent_end" });
      return;
    default:
      // 其余事件（流式增量等）不落日志：token 增量不是审计证据。
      return;
  }
}

/** 最后一条 assistant 消息的文本（一次性模式的最终回答）。 */
function lastAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
        .join("");
      if (text.length > 0) return text;
    }
  }
  return "";
}

function textOf(message: { readonly role: string; readonly content?: unknown }): string {
  if (message.role !== "assistant" && message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content.slice(0, 500);
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("")
      .slice(0, 500);
  }
  return "";
}
