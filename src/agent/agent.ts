/**
 * Agent Core —— 循环来自 `pi-agent-core` 的 `Agent`，这里只装**策略钩子**：
 *
 * ```text
 * while (!done) {                      ← SDK 负责
 *   transformContext(messages)         ← context/（压缩，Phase 6 接入）
 *   stream(model, context)             ← model/（凭据与目录）
 *   beforeToolCall(toolCall)           ← permissions/（allow / ask / deny，Phase 5）
 *   executeTool(...)                   ← tools/（registry，Phase 4）
 *   afterToolCall(result)              ← context/（截断，Phase 6）
 *   subscribe(event)                   ← 会话落盘 + 事件日志 + UI
 * }
 * ```
 *
 * 本文件不实现循环语义、不解析工具调用、不管理重试——那些是 SDK 的事。
 * 我们的全部职责：把钩子接到对应模块，把事件转成日志记录并转发给调用方。
 */

import {
  Agent,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentEvent,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";

/** 钩子的可选策略。全部缺省 = 直接放行 / 不处理（最小可用的 Agent）。 */
export interface AgentHooks {
  /** 权限闸门：返回非 null 字符串即拒绝，模型看得见拒绝理由。 */
  beforeToolCall?: (toolName: string, args: unknown) => Promise<string | null>;
  /** 结果卫生（截断）：返回 undefined 表示不处理。 */
  afterToolCall?: (context: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
  /** 请求前上下文改写（压缩）。 */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** 事件观察者（会话落盘、日志、UI 都从这里走）。 */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface KuseAgentOptions {
  readonly models: Models;
  readonly model: Model<string>;
  readonly systemPrompt: string;
  readonly tools: readonly import("@earendil-works/pi-agent-core").AgentTool<any>[];
  readonly hooks?: AgentHooks;
}

/** 事件流：异步可迭代；`agent_end` 之后收尾（下一次 prompt 会重新开始推事件）。 */
export type AgentEventStream = AsyncIterable<AgentEvent> & { readonly settled: Promise<void> };

export interface KuseAgent {
  readonly agent: Agent;
  readonly events: AgentEventStream;
  prompt(text: string): Promise<void>;
  abort(): void;
  waitForIdle(): Promise<void>;
  messages(): unknown[];
}

export function createKuseAgent(options: KuseAgentOptions): KuseAgent {
  const { hooks } = options;
  const queue: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let settle: (() => void) | null = null;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const push = (event: AgentEvent): void => {
    queue.push(event);
    if (event.type === "agent_end") {
      done = true;
      settle?.();
    }
    notify?.();
    void hooks?.onEvent?.(event);
  };

  const beforeToolCall = hooks?.beforeToolCall;
  const afterToolCall = hooks?.afterToolCall;
  const transformContext = hooks?.transformContext;
  const agent = new Agent({
    streamFn: options.models.streamSimple.bind(options.models),
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: "minimal",
      tools: [...options.tools],
    },
    ...(beforeToolCall === undefined
      ? {}
      : {
          beforeToolCall: async (context: { toolCall: { name: string }; args: unknown }) => {
            const reason = await beforeToolCall(context.toolCall.name, context.args);
            return reason === null ? undefined : { block: true, reason };
          },
        }),
    ...(afterToolCall === undefined ? {} : { afterToolCall }),
    ...(transformContext === undefined ? {} : { transformContext }),
  });

  agent.subscribe(push);

  const events: AgentEventStream = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift();
          if (event !== undefined) yield event;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    },
    settled,
  };

  return {
    agent,
    events,
    prompt: (text) => agent.prompt(text),
    abort: () => agent.abort(),
    waitForIdle: () => agent.waitForIdle(),
    messages: () => agent.state.messages as unknown[],
  };
}
