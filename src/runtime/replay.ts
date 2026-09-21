/**
 * 回放 —— 从事件重建状态。
 *
 * 这个文件只回答一个问题：**一串事件说的是哪个状态？**
 * 它不回答「事件从哪来、写到哪去」——那是 `src/store/`。回放没有一行 I/O：
 * 不读文件、不读时钟、不调模型、不碰网络。所以它在 `src/runtime/` 而不是
 * `src/store/`：**从事件重建状态是语义，事件的载体是存储。** 换载体（文件、
 * 数据库、远端）不该改这一行代码，也不该改它的结论。
 *
 * 三条边界在这里落地：
 *
 * 1. **它调用的是步 3 的同一个 `reduce`，不是「等价实现」。** 这是整条链上最关键的
 *    一处复用：只要存在第二份「把决策应用到状态上」的代码，「回放重建出完全相同的
 *    状态」就只能在测试里碰运气。三条路径（实时执行、回放、单元测试）共用同一个
 *    纯函数，于是这句话是结构事实，而不是一条需要遵守的纪律。
 * 2. **状态只由事件推进。** 这里没有一条规则去读时钟、读文件、或者问端口。
 *    `provenance.at`、`durationMs`、`timestamp` 全部沿用事件里的原值——
 *    回放时重新取时间，等于让同一份日志每次读出不同的状态。
 * 3. **重建不了的事件必须响亮地拒绝，而不是跳过。** 跳过会安静地重建出一个少了
 *    某一步的状态，而「少了人那一步的状态」与「本来就没有人那一步的状态」
 *    在回放看来一模一样——那正是「日志是唯一真相」最不能容忍的一种错误。
 *
 * 三个输入不变量（都由这一侧检查，不信调用方）：
 *
 * - 输入必须是**从头开始的连续前缀**：`sequence` 从 0 起严格 +1。有洞、有重复、
 *   或者从中间截一段出来，都不是一次 Run 的状态。
 * - 一次 Run **至多一个终态事件**：写得出两个终态，说明日志自己矛盾了。
 * - 每一条 `observation_added` 都必须找到它对应的意图：观测不是凭空来的。
 *
 * 还有一个结构性的事实：`replayAgentState` 的主体是一个**穷尽 13 种事件**的
 * `switch`。谁往词汇表里加第 14 种，那个 switch 立刻编译不过——
 * 「回放认不认识它」被迫当场回答。
 */

import { reduce } from "../core/loop.js";
import type { AgentEvent, AgentState, Decision, RunStatus, Task } from "../core/types.js";
import { emptyStateFor } from "./run-agent.js";

// ---------------------------------------------------------------------------
// 终态事件
// ---------------------------------------------------------------------------

/**
 * 终态事件：一次 Run 只能有一个，而且它宣告这次 Run 结束了。
 *
 * 它单独列出来的理由见 `runStatusOf` 下面那张表——那里是同一个词汇的另一个用途。
 */
const TERMINAL_EVENTS = ["run_completed", "run_failed", "run_cancelled"] as const;

/** 这一条事件是不是终态事件。按事件类型判断，不按「状态最后变成什么」判断。 */
export function isTerminalEvent(type: AgentEvent["type"]): boolean {
  return (TERMINAL_EVENTS as readonly string[]).includes(type);
}

/**
 * 输入必须是一条**从头开始的连续前缀**：`sequence` 从 0 起、严格 +1。
 *
 * 这条检查从 `replayAgentState` 里抽出来，是因为步 9 的 trace（`./trace.ts`）
 * 需要**同一条**前置条件：它同样在回答"这串事件说的是哪次 Run"。
 * 两份实现会让这两处对"什么算一份完整的日志"给出不同答案，而它们必须一致——
 * 一份 trace 不该比回放更宽容，否则 trace 会信心十足地描述一次回放拒绝承认的运行。
 */
export function assertContiguousPrefix(events: readonly AgentEvent[]): void {
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index) {
      throw new Error(
        `事件流必须是一条从头开始的连续前缀：第 ${index + 1} 条的 sequence ` +
          `应该是 ${index}，日志里却是 ${event.sequence}` +
          `（有洞、有重复，或者这不是从头开始的一段）`,
      );
    }
  }
}

/**
 * 到不了这里。它存在是为了让下面那个 `switch (event.type)` 的**穷尽性**变成
 * 编译期的事：谁往步 2 的 `AgentEvent` 里加第 14 种事件，那个 switch 就漏了一个
 * 分支，于是 `event` 在 `default` 里不再是 `never`，这一行立刻编译不过。
 *
 * 于是「回放认不认识这种事件」被迫当场回答，而不是等某次真实回放里悄悄落进
 * 一个默认分支。这与 `RUN_ERROR_CODES` 钉住 `RunErrorCode` 是同一手法：
 * **词汇表长了，处理它的地方必须跟着长。**
 */
function unhandled(value: never): never {
  throw new Error(`回放没有处理这种事件：${JSON.stringify(value)}`);
}

function unsupported(eventType: AgentEvent["type"]): never {
  throw new Error(
    `回放重建不了 ${eventType}：把人的回答写进 transcript 的那一步还不存在——` +
      `reduce 只接受决策，而 \`Message\` 里的 role: "human" 没有对应的状态推进。` +
      `挂起与恢复的语义（谁交回答案、怎么重新进入循环）落地之前，回放对这类事件` +
      `只能说「我不知道」，而不是猜一个少了人那一步的状态`,
  );
}

// ---------------------------------------------------------------------------
// 回放
// ---------------------------------------------------------------------------

/**
 * 从事件重建状态。
 *
 * `task` 必须由调用方给出，因为它不在事件里：`run_started` 的载荷是空的
 * （步 2 定的词汇如此，`docs/04-run-events.md` 的局限二记着这件事）。
 * 它的答案在 `Task` 的持久化里——会话索引（`src/store/session-store.ts`）
 * 存的就是这个：**日志答不出来的东西才需要被存下来。**
 *
 * 一轮的状态推进恰好发生一次，与实时循环一模一样：
 *
 * ```text
 * decision_made  { call_tool }   →  意图记下来，状态不动
 * observation_added              →  reduce(状态, 那个意图, 这条观测)   ← 一次
 * decision_made  { respond | ask_human } →  reduce(状态, 这个决策)     ← 一次
 * ```
 *
 * 为什么 `call_tool` 的意图不能当场推进状态：实时循环在第一次产出时也**没有**
 * 推进它——`yield { decision, observation: null, state }` 交出去的还是进入这一轮的
 * 状态，`reduce` 是执行结束之后才调用的。回放要是当场推进，同一轮就会被算两遍
 * （`iteration` 多一、transcript 多一条空的意图）。所以这条规则不是选择，
 * 是**照抄实时语义**。代价见 `docs/07-durability-replay.md` 的局限二。
 */
export function replayAgentState(events: readonly AgentEvent[], task: Task): AgentState {
  assertContiguousPrefix(events);

  let state = emptyStateFor(task);
  /** 已经决定、还没有观测回来的那一次调用。 */
  let pending: Extract<Decision, { kind: "call_tool" }> | null = null;
  let terminal: AgentEvent["type"] | null = null;

  for (const [index, event] of events.entries()) {
    if (
      terminal !== null &&
      (event.type === "decision_made" || event.type === "observation_added")
    ) {
      throw new Error(
        `日志在 ${terminal} 之后还在推进状态（${event.type}）：` +
          `一次 Run 结束之后再没有状态可以推进`,
      );
    }

    switch (event.type) {
      // 只有三种事件能改变状态：两条推进、一条结束。其余的都是「记录」，
      // 不是「状态」——它们的存在理由分别是给人看（tool_started / tool_completed /
      // model_requested）、把已经发生的事说出来（human_input_requested，
      // 问题在 decision_made{ask_human} 那一步就已经进了 pendingQuestion）、
      // 或者记账（usage_reported，它是账目不是状态；今天还没有生产者，步 8 才有）。
      case "decision_made": {
        const decision = event.decision;
        if (decision.kind === "call_tool") {
          if (pending !== null) {
            throw new Error(
              `上一条 call_tool（${pending.intent.name}）还没有观测，又来了一条决策：` +
                `一次 Run 不可能同时有两次调用在途`,
            );
          }
          pending = decision;
          break;
        }
        // respond / ask_human：终态决策只产出一次，也就只推进一次。
        state = reduce(state, decision);
        break;
      }

      case "observation_added": {
        if (pending === null) {
          throw new Error(
            `有一条观测没有对应的意图（${event.observation.tool}）：` +
              `观测只能来自一次已经决定的调用，日志不完整`,
          );
        }
        const decision = pending;
        pending = null;
        state = reduce(state, decision, event.observation);
        break;
      }

      case "run_started": {
        if (index !== 0) {
          throw new Error(`run_started 只能出现在第 1 条，实际出现在第 ${index + 1} 条`);
        }
        break;
      }

      case "run_completed":
      case "run_failed":
      case "run_cancelled": {
        if (terminal !== null) {
          throw new Error(
            `日志里有两个终态事件（${terminal} 与 ${event.type}）：一次 Run 只能结束一次`,
          );
        }
        terminal = event.type;
        break;
      }

      case "human_input_received":
      case "run_resumed":
        unsupported(event.type);

      case "model_requested":
      case "tool_started":
      case "tool_completed":
      case "human_input_requested":
      case "usage_reported":
        break;

      default:
        unhandled(event);
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// 这个 Run 停在哪儿
// ---------------------------------------------------------------------------

/**
 * 事件 → 「这个 Run 停在哪儿」。
 *
 * 它与 `replayAgentState` 分开，因为两者回答的问题不同、严格程度也不同：
 * 状态重建需要「人那一步怎么进 transcript」的语义（还没有），而「停在哪儿」
 * 只需要看终态事件。所以一份含 `human_input_received` 的日志，回放会拒绝它，
 * 而状态仍然答得出来——这不是不一致，是两个问题各自知道自己要什么。
 *
 * 它同样是表驱动的，同样被编译期钉住：谁加了新事件类型，就必须在这里表态
 * 「它影响不影响这个 Run 的位置」。`null` 的意思是「不影响」。
 *
 * `queued` 因此第一次有了生产者：**已经登记进会话、但一条事件都还没有的 Run**，
 * 正是「排队中」这个状态字面上的意思。而这恰好是崩溃恢复要回答的第一个问题。
 */
const STATUS_TRANSITIONS = {
  run_started: "running",
  model_requested: null,
  decision_made: null,
  tool_started: null,
  tool_completed: null,
  observation_added: null,
  human_input_requested: "awaiting_human",
  human_input_received: null,
  run_resumed: "running",
  usage_reported: null,
  run_completed: "completed",
  run_failed: "failed",
  run_cancelled: "cancelled",
} as const satisfies Record<AgentEvent["type"], RunStatus | null>;

export function runStatusOf(events: readonly AgentEvent[]): RunStatus {
  let status: RunStatus = "queued";
  for (const event of events) {
    const next: RunStatus | null = STATUS_TRANSITIONS[event.type];
    if (next !== null) status = next;
  }
  return status;
}

/** 这个状态是不是终态。终态之外（`queued` / `running` / `awaiting_human`）都算
 * 「还没走完」，恢复要接着处理它们。 */
export function isRunOver(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
