/**
 * 对话投影 —— 「发给模型的对话」是状态的**有界投影**，不是状态本身。
 *
 * 这个文件只回答一个问题：**给定状态与策略参数，模型这一轮应该看到什么？**
 * 它不回答「请求怎么翻译成 provider 的形状」——那是适配器的事；也不回答
 * 「策略参数默认取多少」——那是配置与装配层的事。Core 拥有的是词汇与纯函数。
 *
 * 三条边界在这里落地（SDD，docs/sdd/03-architecture.md §3.1）：
 *
 * 1. **投影产物刻意不是 `Message`。** 折叠产物若冒充 `Observation`，就等于
 *    伪造了一条"进入过状态与事件日志的观测"——而事件日志是唯一真相。
 *    所以折叠结果用 `ProjectedTurn` 自己的词汇表达，适配器翻译时一眼可辨。
 * 2. **确定性。** 同一个 (state, policy) 永远得到逐字节相同的投影：
 *    不读时钟、不调模型、不看全局。于是投影可以单测钉死、可以 golden 钉死，
 *    也可以在回放出状态之后随时重放出来（FR-1.3）。
 * 3. **保护窗口优先于预算。** 最近 `keepRecentTurns` 轮永远逐字保留——预算是
 *    软目标（超了就折叠更早的轮），窗口是硬约束（宁可超预算也不拆保护窗口）。
 *    窗口里的内容是模型正在干活的现场；预算不够时该调的是策略参数，
 *    不是悄悄丢掉现场。
 *
 * 「轮」的定义：一条 `assistant` 决策开一轮，紧随其后的 `tool` 观测与
 * `human` 回答并入本轮。切点只落在轮边界——call_tool 的意图与它的观测
 * 永远在同一侧（对齐 tinycode 的经验：切点不拆散决策与其工具结果）。
 */

import type { AgentState, Message, Observation, ToolIntent } from "./types.js";

// ---------------------------------------------------------------------------
// 词汇
// ---------------------------------------------------------------------------

/**
 * 投影策略。全部由调用方注入——Core 不认识配置（与预算同理：
 * 「折到多狠」是驱动方的政策，「什么叫投影」才是 Core 的语义）。
 */
export interface ProjectionPolicy {
  /** 保护窗口：最近 K 轮逐字保留。 */
  readonly keepRecentTurns: number;
  /** 投影估算预算（估算货币见 `estimateTokens`）；超过时从最旧的轮开始折叠。 */
  readonly projectionTokenBudget: number;
  /** 折叠后的单条观测摘要上限（字符）。 */
  readonly foldedObservationChars: number;
  /** 折叠后的单条决策文本上限（字符）。 */
  readonly foldedDecisionChars: number;
}

/**
 * 投影产物的一个轮次。
 *
 * `verbatim` 是对状态里消息的**原样引用**（适配器按既有路径翻译）；
 * `folded` 是确定性的摘要行（适配器渲染成一条带可见标记的消息）。
 */
export type ProjectedTurn =
  | { readonly kind: "verbatim"; readonly messages: readonly Message[] }
  | { readonly kind: "folded"; readonly digest: readonly string[] };

export interface ProjectedConversation {
  readonly turns: readonly ProjectedTurn[];
  /** 估算 token（`estimateTokens` 货币）。供预算联动与测试断言。 */
  readonly estimatedTokens: number;
  /** 实际折叠掉的轮数（0 = 投影等于全量）。可观测性字段，不进事件日志。 */
  readonly foldedTurns: number;
}

// ---------------------------------------------------------------------------
// 估算货币
// ---------------------------------------------------------------------------

/**
 * 确定性 token 估算（≈ chars/4，与 tinycode 同款、完全离线）。
 *
 * 它是**投影预算自己的尺子**，不是 provider 的确切计数：预算的意思是
 * 「按这把尺子量入界」，同一把尺子量出来才有可比性。要求它等于 provider
 * 的真实计费 token，等于让投影去猜一个只有 provider 知道的事实——那不是
 * 估算，是编造。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// 轮的划分
// ---------------------------------------------------------------------------

interface Turn {
  readonly messages: readonly Message[];
}

/**
 * transcript → 轮。**完整性与保序性**是它的硬约束：
 * 所有消息恰好出现一次，顺序不变——这是「无折叠时投影与全量等价」的前提。
 */
function splitTurns(transcript: readonly Message[]): readonly Turn[] {
  const turns: Turn[] = [];
  let current: Message[] | null = null;

  for (const message of transcript) {
    if (message.role === "assistant") {
      current = [message];
      turns.push({ messages: current });
      continue;
    }
    // tool 观测与 human 回答都属于"造成它的那轮"：没有 assistant 开头的
    // 孤儿消息在合法状态里不存在（reduce 保证），这里原样收进当前轮。
    if (current === null) {
      current = [message];
      turns.push({ messages: current });
      continue;
    }
    current.push(message);
  }

  return turns;
}

// ---------------------------------------------------------------------------
// 折叠摘要：确定性拼接，无模型参与
// ---------------------------------------------------------------------------

/** 意图参数摘要的上限。它携带 path / pattern 等证据结构，上限给得比观测宽松。 */
const ARGS_DIGEST_CHARS = 160;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（截断）`;
}

function argsDigest(intent: ToolIntent): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(intent.args) ?? "{}";
  } catch {
    rendered = String(intent.args);
  }
  return clip(rendered, ARGS_DIGEST_CHARS);
}

function observationDigest(observation: Observation, policy: ProjectionPolicy): string {
  if (observation.error !== null) {
    return `失败（${observation.error.code}）：${clip(observation.error.message, policy.foldedObservationChars)}`;
  }
  let rendered: string;
  if (typeof observation.value === "string") {
    rendered = observation.value;
  } else {
    try {
      rendered = JSON.stringify(observation.value) ?? "undefined";
    } catch {
      rendered = String(observation.value);
    }
  }
  if (observation.truncated) rendered += "（进入状态前已被截断）";
  return clip(rendered, policy.foldedObservationChars);
}

/**
 * 一轮 → 摘要行。每行都以 `[已折叠]` 开头（"截断必须可见"的既有规矩），
 * 并携带轮号与证据结构（工具名 + 参数），Evidence 的可追溯性不因折叠丢失。
 */
function foldTurn(turn: Turn, policy: ProjectionPolicy): readonly string[] {
  const digest: string[] = [];
  const head = turn.messages[0];

  if (head !== undefined && head.role === "assistant" && head.decision.kind === "call_tool") {
    const intent = head.decision.intent;
    const observation = turn.messages.find(
      (message): message is Extract<Message, { role: "tool" }> => message.role === "tool",
    )?.observation;
    if (observation === undefined) {
      digest.push(`[已折叠] ${intent.name}(${argsDigest(intent)}) → 调用没有回来`);
    } else {
      digest.push(`[已折叠] ${intent.name}(${argsDigest(intent)}) → ${observationDigest(observation, policy)}`);
    }
    return digest;
  }

  // 终态决策与人的问答：文本折叠到决策上限。
  for (const message of turn.messages) {
    if (message.role === "assistant") {
      if (message.decision.kind === "respond") {
        digest.push(`[已折叠] 决策：应答——${clip(message.decision.report.summary, policy.foldedDecisionChars)}`);
      } else if (message.decision.kind === "ask_human") {
        digest.push(`[已折叠] 决策：向人提问——${clip(message.decision.question, policy.foldedDecisionChars)}`);
      }
      // call_tool 已在上面处理过。
    } else if (message.role === "human") {
      digest.push(`[已折叠] 人的回答——${clip(message.answer, policy.foldedDecisionChars)}`);
    }
  }
  return digest;
}

// ---------------------------------------------------------------------------
// 投影本体
// ---------------------------------------------------------------------------

/** 一轮逐字保留时的成本（估算货币的字符侧）。 */
function turnChars(turn: Turn): number {
  return JSON.stringify(turn.messages).length;
}

function foldedChars(digest: readonly string[]): number {
  return digest.join("\n").length;
}

/**
 * 把状态投影为「发给模型的对话」。
 *
 * 算法：全部逐字 → 若估算超预算，从最旧的轮开始逐轮折叠，直到入界
 * 或只剩保护窗口。折叠是不可逆的近似，所以顺序只有一个方向：越旧越先折。
 */
export function projectConversation(
  state: AgentState,
  policy: ProjectionPolicy,
): ProjectedConversation {
  const turns = splitTurns(state.transcript);
  const maxFold = Math.max(0, turns.length - Math.max(0, policy.keepRecentTurns));

  const foldedDigests: (readonly string[] | undefined)[] = turns.map(() => undefined);
  let chars = 0;
  for (const turn of turns) chars += turnChars(turn);

  const tokensOf = (chars: number): number => Math.ceil(chars / 4);

  let foldedCount = 0;
  while (foldedCount < maxFold && tokensOf(chars) > policy.projectionTokenBudget) {
    const turn = turns[foldedCount];
    if (turn === undefined) break; // 不可达：foldedCount < maxFold ≤ turns.length
    const digest = foldTurn(turn, policy);
    foldedDigests[foldedCount] = digest;
    chars += foldedChars(digest) - turnChars(turn);
    foldedCount += 1;
  }

  const out: ProjectedTurn[] = turns.map((turn, index) => {
    const digest = foldedDigests[index];
    return digest === undefined
      ? { kind: "verbatim", messages: turn.messages }
      : { kind: "folded", digest };
  });

  return {
    turns: out,
    estimatedTokens: tokensOf(chars),
    foldedTurns: foldedCount,
  };
}
