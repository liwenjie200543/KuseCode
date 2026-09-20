/**
 * 一轮的**收场** → 一个 `Decision`。
 *
 * 这个文件是适配器的语义中心：它是"provider 说了什么"与"Core 的词汇"之间
 * 唯一的翻译点。放在这里的每一条判断都能被单测直接钉住，因为它接收的只是
 * 一个普通对象（`AssistantMessage`），不需要网络、凭据或真机。
 *
 * 四个容易搞错的地方，都在这里显式处理：
 *
 * 1. **stream 出错不 reject。** pi-ai 的流在 provider 失败时以 `{type:"error"}`
 *    收尾并携带一个 `stopReason: "error"` 的 `AssistantMessage`。所以"只看
 *    try/catch"会漏掉全部 provider 错误——判据必须是 `stopReason`，不是异常。
 * 2. **一条消息里可能有多个工具调用。** Core 的 `call_tool` 只有一个 `intent`
 *    （`reduce` 也只追一条观测），所以适配器只表达得了第一个。**多余的当场抛错，
 *    不丢。** 悄悄丢掉一个模型主动发起的动作，是最不该发生的那种损失。
 * 3. **`length` 不是一句答案。** 输出被 `maxTokens` 截断时模型没说完，
 *    把它当成一个 `respond` 交付出去，等于把半截话伪装成结论。
 * 4. **文字里没有依据时 `claims` 是空数组。** 那不是"忘了填"，而是 Core 明确定义的
 *    "我说了但没找到依据"——一个必须可见的状态。
 */

import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { Decision, Provenance } from "../../core/types.js";
import { AdapterError, adapterError, providerFailureFromStopReason } from "./errors.js";
import { ASK_HUMAN_TOOL, SUBMIT_REPORT_TOOL, isTerminalTool, readQuestion, readReport } from "./protocol.js";

export interface DecodeOptions {
  /** 给 `Evidence.provenance.at` 用。注入以便测试确定。 */
  readonly clock: () => number;
  /** 这次 Run 的信号。用来判断"是我们喊停的"还是 provider 自己中止的。 */
  readonly signal: AbortSignal;
}

/** 消息里所有工具调用，按出现顺序。 */
export function toolCallsOf(message: AssistantMessage): readonly ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

/** 消息里的纯文本部分（`respond` 的兜底答案就是它）。 */
export function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function requireText(message: AssistantMessage, what: string): string {
  const text = textOf(message);
  if (text.length === 0) {
    throw new AdapterError({
      code: "runtime_error",
      message: `${what}，但消息里没有任何文本内容（stopReason=${message.stopReason}）`,
    });
  }
  return text;
}

/**
 * 把一轮的消息翻译成一个决策。
 *
 * 抛出的 `AdapterError` 带合法 `RunErrorCode`（或在中止时**不带**码，
 * 让 Runtime 用自己手上的信号去归因）。
 */
export function decideFromMessage(message: AssistantMessage, options: DecodeOptions): Decision {
  // ① provider 的失败说法优先：一个 stopReason 为 error 的消息，内容不值得相信
  const failure = providerFailureFromStopReason(message.stopReason, message.errorMessage, options.signal);
  if (failure !== null) throw adapterError(failure);

  if (message.stopReason === "deferred") {
    throw new AdapterError({
      code: "runtime_error",
      message: "provider 返回了一个延后响应（deferred），而这条通道只处理同步的一轮",
    });
  }

  const calls = toolCallsOf(message);
  const provenance: Provenance = { source: "model", at: options.clock() };

  // ② 协议工具：模型在说"我干完了"或"我需要人"
  if (calls.length === 1) {
    const call = calls[0] as ToolCall;
    if (call.name === SUBMIT_REPORT_TOOL) {
      return { kind: "respond", report: readReport(call.arguments, provenance) };
    }
    if (call.name === ASK_HUMAN_TOOL) {
      return { kind: "ask_human", question: readQuestion(call.arguments) };
    }
    // 真实工具：名字的合法性由执行层判断（step 6 的 allowlist 是唯一一份），
    // 适配器不做第二次否决——否则"谁能调什么"就有了两个可以不一致的答案。
    return { kind: "call_tool", intent: { name: call.name, args: call.arguments } };
  }

  // ③ 多个工具调用：Core 表达不了，宁可当场失败也不丢
  if (calls.length > 1) {
    const names = calls.map((call) => call.name).join(", ");
    const terminal = calls.filter((call) => isTerminalTool(call.name)).map((call) => call.name);
    throw new AdapterError({
      code: "runtime_error",
      message:
        `一轮里出现了 ${calls.length} 个工具调用（${names}），而 Core 的一个决策只能表达` +
        `一个意图。适配器不丢弃模型发起的动作，所以这一轮以失败结束。` +
        (terminal.length > 0 ? `其中包含协议工具（${terminal.join(", ")}）。` : "") +
        `修法在 Core：给 Decision 一个批量意图，而不是在这里挑一个。`,
    });
  }

  // ④ 没有工具调用：输出被截断时不能冒充结论
  if (message.stopReason === "length") {
    throw new AdapterError({
      code: "runtime_error",
      message:
        "模型的输出因为 maxTokens 用尽而被截断（stopReason=length），这一轮没有形成完整结论。" +
        "它可能只是半句话——把半句话当成答案交付出去，比一次可见的失败更糟。",
    });
  }

  // ⑤ 纯文本：模型忽略了协议、直接给了答案。这是**合法的**收场，
  //    因为 Core 里"没有依据"有明确的表示：claims 为空数组。
  return { kind: "respond", report: { summary: requireText(message, "模型没有调用工具"), claims: [] } };
}
