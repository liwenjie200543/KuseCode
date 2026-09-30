/**
 * bootstrap —— 从配置组装出一套可运行的 Agent（模型 + 工具 + 钩子 + 事件日志 + 会话）。
 *
 * 这是产品面（CLI/TUI）唯一的接线点：接线只有一份，Agent 逻辑只有一份。
 * 能力模块（tools/permissions/context/session/skills）在这里接入对应钩子。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createModelRegistry } from "../model/registry.js";
import { ToolRegistry } from "../tools/registry.js";
import { createDefaultTools } from "../tools/index.js";
import { NodeExecutionEnv } from "./env.js";
import { PermissionManager } from "../permissions/manager.js";
import { ContextManager } from "../context/manager.js";
import { SessionManager } from "../session/manager.js";
import { SubAgentManager, createSubAgentTools } from "../agents/manager.js";
import { createLoadSkillTool, discoverSkills, skillsPromptSection } from "../skills/loader.js";
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
  /** mock 剧本句柄（--model mock 时注入剧本用；否则 null）。 */
  readonly mockHandle: import("@earendil-works/pi-ai").FauxProviderHandle | null;
  /** 产品面注入询问回调（TUI 对话框）；headless 保持 null（confirm 默认拒绝）。 */
  setPermissionPrompt(
    prompt:
      | ((request: { toolName: string; title: string; reason: string }) => Promise<"once" | "always" | "deny">)
      | null,
  ): void;
  /** 一次性任务：返回最终 assistant 文本；返回前日志已全部落盘。 */
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

  let sessionId: string = "";
  const env = new NodeExecutionEnv(options.projectRoot);

  // 工具集：SDK 内建 4 件 + 搜索三件套 + load_skill。
  const toolRegistry = new ToolRegistry();
  for (const entry of createDefaultTools(env)) toolRegistry.register(entry);
  const skills = await discoverSkills(env, options.projectRoot);
  toolRegistry.register({ tool: createLoadSkillTool(skills), risk: "safe" });
  // 权限：risk 声明来自注册表，模式来自配置。
  const permissions = new PermissionManager({
    mode: options.config.permissionMode,
    riskFor: (name) => toolRegistry.get(name)?.risk,
  });

  // 模型：mock 是无凭据时的确定性离线路径。
  const registry = createModelRegistry();
  if (options.config.model === "mock") registry.enableMock();
  const resolved = await registry.resolve(options.config.model === "mock" ? null : options.config.model);

  // 子代理：worker 只拿只读工具（从注册表挑选），复用同一模型与循环。
  const subAgents = new SubAgentManager({
    models: registry.models,
    model: resolved.model,
    projectRoot: options.projectRoot,
    workerTools: ["read", "grep", "find", "ls"]
      .map((name) => toolRegistry.get(name)?.tool)
      .filter((tool) => tool !== undefined),
  });
  for (const tool of createSubAgentTools(subAgents)) {
    toolRegistry.register({ tool, risk: "safe" });
  }


  // 会话：终态消息落盘；事件日志与会话共用同一个 id。
  const session = new SessionManager(join(dataRoot, "sessions"));
  sessionId = await session.start(options.projectRoot, resolved.name);
  const log = eventLogFor(dataRoot, sessionId);

  // 上下文：截断 + 压缩（摘要走当前模型）。
  const contextOptions = options.config.context ?? {};
  const context = new ContextManager({
    ...(contextOptions.maxToolResultChars === undefined
      ? {}
      : { maxToolResultChars: contextOptions.maxToolResultChars }),
    ...(contextOptions.compactAboveTokens === undefined
      ? {}
      : { compactAboveTokens: contextOptions.compactAboveTokens }),
    ...(contextOptions.keepRecentMessages === undefined
      ? {}
      : { keepRecentMessages: contextOptions.keepRecentMessages }),
    summarize: async (transcript, signal) => {
      const completeOptions = signal === undefined ? undefined : { signal };
      const message = await registry.models.completeSimple(
        resolved.model,
        {
          systemPrompt:
            "把这段编码会话压缩成一份交接摘要：目标、试过什么、改了哪些文件（带路径）、当前状态、下一步。保留代码标识符原文，不要客套。",
          messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
        },
        completeOptions,
      );
      const text = message.content
        .map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      return text.length > 0 ? text : "(空摘要)";
    },
  });


  /** 在途日志写入。run() 返回前必须清空——调用方读到的日志才完整。 */
  const pending: Promise<unknown>[] = [];
  const append = (event: { type: string } & Record<string, unknown>): void => {
    pending.push(
      log.append(event).catch(() => {
        // 日志写不进去不该让 Agent 崩溃——但这是可见的损失，留给 trace 的缺失说明。
      }),
    );
  };

  const agent = createKuseAgent({
    models: registry.models,
    model: resolved.model,
    systemPrompt: [
      buildSystemPrompt(options.projectRoot, toolRegistry.names()),
      skillsPromptSection(skills),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n"),
    tools: toolRegistry.list(),
    hooks: {
      beforeToolCall: async (toolName, args) => {
        const decision = await permissions.check(toolName, args as Record<string, unknown>);
        return decision.action === "deny" ? decision.reason : null;
      },
      afterToolCall: async (hookContext) => context.handleAfterToolCall(hookContext),
      transformContext: context.makeTransformContext(),
      onEvent: (event) => {
        recordEvent(append, event);
        // 会话落盘同样纳入 pending：run() 返回即全部可见。
        if (event.type === "message_end") {
          pending.push(session.record(event.message).catch(() => {}));
        }
      },
    },
  });

  return {
    sessionId,
    log,
    mockHandle: registry.mockHandle,
    setPermissionPrompt: (prompt) => permissions.setPrompt(prompt),
    run: async (text) => {
      append({ type: "run_started", goal: text });
      try {
        await agent.prompt(text);
      } catch (error) {
        append({ type: "error", message: error instanceof Error ? error.message : String(error) });
        await Promise.all(pending);
        throw error;
      }
      // 日志全部落定后 run 才返回：调用方此刻读日志，读到的一定是完整真相。
      await Promise.all(pending);
      return lastAssistantText(agent.messages());
    },
    abort: () => agent.abort(),
    waitForIdle: () => agent.waitForIdle(),
  };
}

/** SDK 事件 → 日志事件（5 种词汇；token 增量等非审计事件不落日志）。 */
function recordEvent(
  append: (event: { type: string } & Record<string, unknown>) => void,
  event: AgentEvent,
): void {
  switch (event.type) {
    case "message_end": {
      const message = event.message;
      if (message.role === "assistant" && message.stopReason === "error") {
        // 模型错误必须可见（trace 的"为什么停"），不能安静地只留一条空消息。
        append({ type: "error", message: message.errorMessage ?? "provider error" });
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
      append({ type: "tool_result", tool: event.toolName, isError: event.result?.isError ?? false });
      return;
    case "agent_end":
      append({ type: "agent_end" });
      return;
    default:
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
        .map((part) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
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
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join("")
      .slice(0, 500);
  }
  return "";
}
