/**
 * 最小循环 —— 一次 Run 的**循环语义**。
 *
 * 这个文件只回答一个问题：**给定状态和两个端口，下一步发生什么？**
 * 它不回答「这次 Run 怎么被驱动、被记账、被取消、被持久化」——那属于 Runtime。
 *
 * 三条边界在这里落地：
 *
 * 1. **循环语义在 Core，循环驱动在 Runtime。** 所以这里没有调度、没有预算、
 *    没有重试、没有持久化，只有一个 generator：驱动方推它一下，它产出一步。
 * 2. **`reduce` 是唯一的状态推进函数。** 实时执行（步 4）、事件回放（步 7）、
 *    单元测试（本步）全都走它。只要存在第二份「等价实现」，
 *    「回放重建出完全相同的状态」就只能在测试里碰运气，而不能在结构上成立。
 * 3. **Core 不检查任何预算。** 没有 maxIterations、没有墙钟超时。循环的边界只由
 *    模型给出的终态决策决定；「超出预算就停」是驱动方的执法（步 5）。
 *    `test/core-loop.test.ts` 里有一行编译期证明：谁给 `LoopDeps` 加上预算字段，
 *    那一行就编译不过。
 */

import type {
  AgentState,
  Context,
  Decision,
  Message,
  ModelPort,
  Observation,
  ToolIntent,
  ToolOutcome,
  ToolPort,
} from "./types.js";

// ---------------------------------------------------------------------------
// 依赖：循环需要什么，不需要什么
// ---------------------------------------------------------------------------

/**
 * `ToolOutcome` → `Observation` 的组装点。
 *
 * 它存在的唯一理由是那条安全默认：工具输出是不可信输入，
 * **`provenance` 与 `truncated` 只能由这一侧写入**，工具自己填不了。
 *
 * 实现属于 Runtime（步 6 的 tool-runner 是它的生产实现）。Core 拥有的是这条
 * 接缝的位置——所以「组装策略」可以换，而「组装这件事必然发生过」不会丢。
 */
export type AssembleObservation = (intent: ToolIntent, outcome: ToolOutcome) => Observation;

/**
 * 循环的全部外部依赖。
 *
 * 注意这里没有 budget、没有 maxIterations、没有 clock、没有 store：
 * 循环不认识时间，也不认识账本。它只认识两个端口和一条组装接缝。
 */
export interface LoopDeps {
  readonly model: ModelPort;
  readonly tools: ToolPort;
  readonly assembleObservation: AssembleObservation;
}

// ---------------------------------------------------------------------------
// 投影：状态 → 人/模型能看到的东西
// ---------------------------------------------------------------------------

/**
 * 状态里的观测列表。
 *
 * 从 transcript 派生，而不是在状态里另存一份：多一份投影就多一个会在回放时
 * 分叉的真相。这也解释了为什么 `Message.role === "tool"` 必须带 observation。
 */
export function observationsOf(state: AgentState): readonly Observation[] {
  const observations: Observation[] = [];
  for (const message of state.transcript) {
    if (message.role === "tool") observations.push(message.observation);
  }
  return observations;
}

/**
 * 状态 → 模型可见的**有界投影**。
 *
 * 模型能看到的只有六个字段；`pendingQuestion`、`transcript` 的原始顺序、
 * 以及 task 里未来可能出现的任何字段,都不在其中。
 * 适配器（步 8）构建 provider 请求时必须用它，而不是自己挑字段——
 * 否则「模型能看到什么」就变成适配器决定的了。
 */
export function renderContext(state: AgentState, availableTools: readonly string[]): Context {
  return {
    goal: state.task.goal,
    repoRoot: state.task.repoRoot,
    checks: state.task.checks,
    observations: observationsOf(state),
    availableTools,
    iteration: state.iteration,
  };
}

// ---------------------------------------------------------------------------
// 谓词：什么时候停，什么时候算前进
// ---------------------------------------------------------------------------

/** 让循环停下来的那两种决策。 */
export type TerminalDecision = Extract<Decision, { kind: "respond" | "ask_human" }>;

/**
 * 这个决策是否让循环停下来。
 *
 * 只有两种停法，而且不是巧合：`respond` 是「干完了」，`ask_human` 是
 * 「我自己没法再往前了，需要人」。两者都不再产生工具调用，所以循环交还控制权。
 *
 * 它不区分终态的性质——`respond` → `run_completed`、`ask_human` →
 * `awaiting_human` 的映射是驱动方的事（步 4）。
 *
 * 写成类型谓词不只是为了省一次 `kind` 判断：调用方在 `else` 分支里因此**结构上**
 * 只剩 `call_tool` 一种可能，不可能忘记处理某个分支。
 */
export function isTerminal(decision: Decision): decision is TerminalDecision {
  return decision.kind === "respond" || decision.kind === "ask_human";
}

/**
 * 这个状态是否停在人类那一侧。
 *
 * 本步只到状态层：问题被记下来，循环因此不再自作主张。
 * 真正的挂起/恢复（谁把回答交回来、怎么重新进入循环）在步 4/5。
 */
export function isAwaitingHuman(state: AgentState): boolean {
  return state.pendingQuestion !== null;
}

/**
 * 一轮之后状态是否真的前进了。
 *
 * 判据只有一条：**这一轮有没有为 transcript 增加一条此前没有的观测**。
 * 没有新观测的一轮就是空转——模型问了一次、什么也没拿到、还要接着问。
 *
 * 谓词在 Core（这一句就是「什么叫空转」的定义），执法在 Runtime（步 5 的
 * `no_progress`）——和预算一样，停不停由驱动方说了算。
 *
 * 注意它只数观测，不看 `iteration`：`iteration` 每轮必然 +1，
 * 用它当判据等于没有判据。
 */
export function hasProgress(before: AgentState, after: AgentState): boolean {
  return observationsOf(after).length > observationsOf(before).length;
}

// ---------------------------------------------------------------------------
// 状态推进：唯一的那一个函数
// ---------------------------------------------------------------------------

/**
 * 应用一个决策（以及它可能带来的观测），产出新状态。**纯函数。**
 *
 * 实时执行、事件回放、单元测试三条路径共用它，所以它不能有 I/O、不能读时钟、
 * 不能摸全局变量——一旦它开始「看现在几点」或者「问一下存储」，回放就不再幂等。
 *
 * 语义逐条：
 * - 决策永远进 transcript（`role: "assistant"`）：状态里必须留下"模型说过什么"。
 * - `call_tool` **且**观测非 null 时，追一条 `role: "tool"` 的消息。观测为 null
 *   表示"意图已下、结果从未回来"（被打断，或还没跑），那是一个真实存在的状态，
 *   不能靠一条伪造的空观测来掩盖。
 * - `ask_human` 把问题记进 `pendingQuestion`；**任何非 `ask_human` 的决策都会把它
 *   清空**，于是「有问题待答」与「最后一次决策是提问」这两件事恒等价。
 * - `iteration` 每减少一次 +1：它数的是"已经走过几轮"，不是"还剩几轮"。
 */
export function reduce(
  state: AgentState,
  decision: Decision,
  observation: Observation | null = null,
): AgentState {
  const transcript: Message[] = [...state.transcript, { role: "assistant", decision }];
  if (decision.kind === "call_tool" && observation !== null) {
    transcript.push({ role: "tool", intent: decision.intent, observation });
  }

  return {
    task: state.task,
    transcript,
    iteration: state.iteration + 1,
    pendingQuestion: decision.kind === "ask_human" ? decision.question : null,
  };
}

// ---------------------------------------------------------------------------
// 一步：问模型
// ---------------------------------------------------------------------------

/**
 * 一步：给定状态，产出一个决策。仅此而已。
 *
 * 它不推进状态（那是 `reduce` 的事），也不执行工具（那是循环的事）——
 * 把"问"和"做"分开，才能让回放在不调用模型的前提下重建出同样的状态。
 */
export async function step(
  state: AgentState,
  deps: LoopDeps,
  signal: AbortSignal,
): Promise<Decision> {
  return deps.model.decide(state, signal);
}

// ---------------------------------------------------------------------------
// 循环：每轮产出 {decision, observation, state}
// ---------------------------------------------------------------------------

/**
 * 一轮的产出。
 *
 * **一轮可能有两次产出**，这是刻意的：
 *
 * ```text
 * 决策已下、执行未开始  → { decision: call_tool, observation: null, state: 进入这一轮的状态 }
 * 执行结束、观测已回     → { decision: call_tool, observation: <观测>, state: reduce 之后的状态 }
 * ```
 *
 * 为什么不让执行发生在第一次产出之前？因为驱动方必须能在工具开跑**之前**
 * 拿到决策，否则 `decision_made` 只能排在 `tool_completed` 后面——事件流的顺序
 * 会与真实因果相反，`tool_started` 的时间戳也成了事后补的。可审计的日志不接受
 * 这两件事。代价是驱动方要按 `observation === null` 区分这两次产出。
 *
 * 终态决策（`respond` / `ask_human`）只产出一次：`observation` 为 null，
 * 因为"说完就走"本来就不产生观测。
 */
export interface LoopTurn {
  readonly decision: Decision;
  /** 观测；`null` = 这一轮的观测还没回来，或这一轮不产生观测。 */
  readonly observation: Observation | null;
  /** 这一步之后的权威状态，由 `reduce` 产出。 */
  readonly state: AgentState;
}

/**
 * 最小循环本体：Task → Context → 模型决策 → 工具 → 观测 → 状态推进 → 下一轮/收工。
 *
 * 它是个 generator，不是一个 `while(true)` 里跑完的黑盒，理由有三：
 * 驱动方要在每一轮之前执法预算与取消（步 5）、要把每一步翻译成事件（步 4）、
 * 要能在任何一步停下来而不丢状态。这些都要求控制权在每轮边界上交还一次。
 *
 * 返回值是终态：`respond`/`ask_human` 之后的状态，或"一开始就停在人类那侧"的入参状态。
 * 这个循环**不设上限**——脚本化的假模型问几次就有几次，真模型想转多少轮就转多少轮，
 * 由驱动方决定什么时候喊停。
 */
export async function* runCoreLoop(
  initial: AgentState,
  deps: LoopDeps,
  signal: AbortSignal,
): AsyncGenerator<LoopTurn, AgentState, void> {
  let state = initial;

  while (true) {
    // 停在人类那一侧时，循环不该自己去猜答案——恢复是驱动方的事（步 4/5）。
    if (isAwaitingHuman(state)) return state;

    const decision = await step(state, deps, signal);

    if (isTerminal(decision)) {
      state = reduce(state, decision);
      yield { decision, observation: null, state };
      return state;
    }

    // 意图先交出去：驱动方在此刻落 `decision_made` / `tool_started`。
    yield { decision, observation: null, state };

    const outcome = await deps.tools.execute(decision.intent, signal);
    const observation = deps.assembleObservation(decision.intent, outcome);
    state = reduce(state, decision, observation);
    yield { decision, observation, state };
  }
}
