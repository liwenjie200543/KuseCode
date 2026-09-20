/**
 * Core 的状态 → provider 的对话。
 *
 * 这个文件只回答一个问题：**模型这一次到底看到了什么？**
 *
 * ## 一个必须说清楚的设计取舍
 *
 * 步 3 的文档说：「适配器（步 8）构建 provider 请求时必须用 `renderContext`，
 * 而不是自己挑字段——否则「模型能看到什么」就变成适配器决定的」。本文件遵守
 * 这条约束的方式是：**任务面的每一个字段都从 `renderContext` 拿**
 * （`goal` / `repoRoot` / `checks` / `availableTools` / `iteration`），
 * 适配器一个都没有自己发明。
 *
 * 但对话**不是**从 `Context.observations` 拼出来的，而是从 `state.transcript` 翻译的。
 * 理由是后者严格多于前者，而且多出来的正是真实 provider 需要的东西：
 * `Observation` 只说得清「哪个工具产出了这条材料」，说不清「当初读的是哪个文件」——
 * 那在 `Message.role === "tool"` 的 `intent` 里。只给结果不给请求，模型会反复读
 * 同一个文件，而 provider 的 tool-call 协议本身也要求结果跟在对应的调用之后。
 *
 * 这个取舍**不会**让两份真相分叉，因为 `Context.observations` 就是
 * `observationsOf(state.transcript)`——它是 transcript 的一个**有损投影**，
 * 不是另一个来源。`test/pi-adapter.test.ts` 里有一条断言把这件事钉住：
 * 同一份状态下，投影里的观测序列与翻译出的对话里的工具结果逐条相等。
 */

import type {
  Message as PiMessage,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { observationsOf, renderContext } from "../../core/loop.js";
import type { AgentState, Context, Observation, Task } from "../../core/types.js";

/** 回放出来的 assistant 消息需要的 provider 元数据。它们不影响我们的语义。 */
export interface ProviderIdentity {
  readonly api: string;
  readonly provider: string;
  readonly model: string;
}

/**
 * 重建出来的 assistant 消息要带一个 `usage`，但那个数字**不是账目**。
 *
 * 为什么必须是零：这次 Run 的真实用量只来自**实时的那几次调用**
 * （见 `usage.ts` 与 `model.ts`），重建出来的历史消息若带一个非零用量，
 * 就会被误当成"花过的钱"。零在这里的含义是"这一条不参与记账"。
 */
const NO_USAGE: Usage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

/**
 * 重建历史消息时用的工具调用 id。
 *
 * 我们的 `Message.role === "tool"` **没有** `toolCallId`（Core 不认识 provider 的
 * 关联 id），所以这里按位置生成一个：`call_<assistant 消息的下标>`。
 *
 * 用下标而不是随机数，是因为它必须是**确定的**：同一份状态每次都要翻译出同一串 id，
 * 否则回放、缓存与"同样的输入得到同样的请求"这三件事都不成立。
 */
function toolCallIdFor(assistantIndex: number): string {
  return `call_${assistantIndex}`;
}

function textBlock(text: string): { readonly type: "text"; readonly text: string } {
  return { type: "text", text };
}

/**
 * 一次观测 → 工具结果的正文。
 *
 * 失败也是一条**内容**而不是一个空结果：模型必须看得见"这次没拿到"，
 * 否则它会把缺失当成"那里什么都没有"——这正是 `missingMaterial` 要防的事。
 * 截断同样要可见（`truncated`），不然模型会以为拿到的是全文。
 */
export function renderObservationText(observation: Observation): string {
  const parts: string[] = [];
  if (observation.error !== null) {
    parts.push(`调用失败（${observation.error.code}）：${observation.error.message}`);
  }
  if (observation.value !== undefined) {
    let rendered: string;
    try {
      rendered = typeof observation.value === "string" ? observation.value : JSON.stringify(observation.value, null, 2);
    } catch {
      rendered = String(observation.value);
    }
    parts.push(rendered);
  }
  if (observation.truncated) {
    parts.push("（结果因超长被截断，上面是预览，不是全文）");
  }
  return parts.join("\n\n");
}

/** 把一条 `Message` 序列翻译成 provider 的消息序列。 */
function buildMessages(task: Task, state: AgentState, identity: ProviderIdentity): PiMessage[] {
  const messages: PiMessage[] = [
    {
      role: "user",
      content: [
        `目标：${task.goal}`,
        `仓库根目录：${task.repoRoot}`,
        task.checks.length > 0 ? `必须覆盖的检查维度：\n${task.checks.map((c) => `- ${c}`).join("\n")}` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n\n"),
      timestamp: 0,
    },
  ];

  let assistantIndex = -1;
  for (const message of state.transcript) {
    if (message.role === "assistant") {
      assistantIndex += 1;
      const { decision } = message;
      if (decision.kind === "call_tool") {
        const call: ToolCall = {
          type: "toolCall",
          id: toolCallIdFor(assistantIndex),
          name: decision.intent.name,
          // `ToolIntent.args` 是 `Readonly<Record<string, unknown>>`，而 provider 要的是
          // 可变对象：复制一次，免得下游改动回写进 Core 的状态。
          arguments: { ...decision.intent.args },
        };
        messages.push({
          role: "assistant",
          content: [call],
          api: identity.api,
          provider: identity.provider,
          model: identity.model,
          usage: NO_USAGE,
          stopReason: "toolUse",
          timestamp: 0,
        });
        continue;
      }
      // respond / ask_human：它们在 Core 里是"模型说的话"，翻成文本最接近原意
      const text =
        decision.kind === "respond" ? decision.report.summary : decision.question;
      messages.push({
        role: "assistant",
        content: [textBlock(text)],
        api: identity.api,
        provider: identity.provider,
        model: identity.model,
        usage: NO_USAGE,
        stopReason: "stop",
        timestamp: 0,
      });
      continue;
    }

    if (message.role === "human") {
      messages.push({ role: "user", content: message.answer, timestamp: 0 });
      continue;
    }

    // role === "tool"：结果必须挂回它对应的那次调用
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: toolCallIdFor(assistantIndex),
      toolName: message.intent.name,
      content: [textBlock(renderObservationText(message.observation))],
      details: message.observation.value,
      isError: message.observation.error !== null,
      timestamp: 0,
    };
    messages.push(result);
  }

  // 一个**有意图但没有结果**的调用（执行期间 Run 结束）如果留在末尾，
  // provider 会收到一个悬空的 tool call 并拒绝这次请求。补一条诚实的工具结果，
  // 而不是把那半个动作从历史里抹掉——"这一次没有返回"是一个真实发生过的状态。
  const last = state.transcript[state.transcript.length - 1];
  if (last !== undefined && last.role === "assistant" && last.decision.kind === "call_tool") {
    messages.push({
      role: "toolResult",
      toolCallId: toolCallIdFor(assistantIndex),
      toolName: last.decision.intent.name,
      content: [textBlock("这次调用没有返回结果：Run 在它执行期间结束了。")],
      isError: true,
      timestamp: 0,
    });
  }

  return messages;
}

/** 模型要遵守的那段说明。它是适配器的词汇，不是 Core 的（Core 不认识 system prompt）。 */
export function buildSystemPrompt(): string {
  return [
    "你在一个 Agent 循环里工作：每一步要么读取材料，要么交付结论。",
    "你可以调用工具去读仓库内容；工具的真实性由运行时校验，不要臆造工具名。",
    "禁止凭记忆回答仓库里的内容——凡是你没有从工具结果里看到的，都不要写进结论。",
    "当你掌握的材料足够回答目标时，调用 submit_report 交付结论。",
    "submit_report 的每一条 claim 都要在 evidence 里给出文件路径与行号；",
    "确实没有找到依据的结论也要写出来，把 evidence 留成空数组，不要为了让结论好看而省略它。",
    "当你无法通过读取仓库得出结论、且只有人才能提供所需信息时，调用 ask_human。",
  ].join("\n");
}

/** Core 的 `renderContext` → 任务面信息。适配器不发明任何字段。 */
export function taskFacingContext(state: AgentState, availableTools: readonly string[]): Context {
  return renderContext(state, availableTools);
}

/** 投影与对话必须说同一件事：这条断言是 `test/pi-adapter.test.ts` 的锚点。 */
export function observationCountOf(state: AgentState): number {
  return observationsOf(state).length;
}

export interface BuildRequestOptions {
  readonly state: AgentState;
  readonly availableTools: readonly string[];
  readonly identity: ProviderIdentity;
  /** 工具声明（真实工具 + 协议工具）。schema 属于适配器。 */
  readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[];
  /** 覆盖默认的 system prompt。省略时用 `buildSystemPrompt()`。 */
  readonly systemPrompt?: string;
}

/** 一次请求的全部内容。它就是"模型能看到什么"的完整答案。 */
export interface ProviderRequest {
  readonly systemPrompt: string;
  readonly messages: readonly PiMessage[];
  readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[];
  /** Core 的投影，保留下来供测试对照（不额外进请求）。 */
  readonly context: Context;
}

/**
 * 组装一次请求。
 *
 * 返回值里同时带上了 `context`：它不是发给 provider 的东西，而是**证据**——
 * 让测试能证明适配器用的是 `renderContext` 的字段，而不是自己挑的。
 */
export function buildRequest(options: BuildRequestOptions): ProviderRequest {
  const context = taskFacingContext(options.state, options.availableTools);
  return {
    systemPrompt: options.systemPrompt ?? buildSystemPrompt(),
    messages: buildMessages(options.state.task, options.state, options.identity),
    tools: options.tools,
    context,
  };
}
