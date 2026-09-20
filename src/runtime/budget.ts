/**
 * 预算 —— 这次 Run 最多走多远，以及「走过头了」由谁喊停。
 *
 * 这个文件只回答一个问题：**一次 Run 什么时候必须停下来，而不是等模型自己收工？**
 * 它不回答「为什么这次 Run 停了」——归因（是用户取消，还是我们自己的墙钟）在
 * `termination.ts`；它也不回答「停了之后日志里写什么」——那是驱动方的事。
 *
 * 三条边界在这里落地：
 *
 * 1. **Core 永不检查预算。** 步 3 的循环里没有 maxIterations、没有超时，它的边界
 *    只由模型的终态决策决定，而且有一行编译期证明守着这件事。执法在这里——
 *    「循环语义在 Core，循环驱动在 Runtime」最容易被破坏的就是这一处。
 * 2. **检查发生在动作之前，不是之后。** 问模型之前、发起工具之前。事后检查等于
 *    「超支了再说」：那次调用已经花掉了钱，而且可能已经写下了一个文件。
 * 3. **「什么叫空转」的谓词在 Core**（步 3 的 `hasProgress`），这里只负责在它说
 *    不前进的时候喊停。谓词换掉，执法不用动。
 *
 * 墙钟不在这里执法：它不是一个检查点，而是一条会在任意时刻响的信号——由
 * `termination.ts` 组合出来，由端口自己用它打断在途调用。所以这个守卫只管两样
 * 数得清的东西（轮数、工具次数）和一样说得清的东西（有没有前进）。
 */

import { hasProgress } from "../core/loop.js";
import type { AgentState, RunBudget, RunErrorCode, ToolIntent } from "../core/types.js";

/**
 * 我们自己喊停时用的那三个码。
 *
 * 为什么写成 `Extract` 而不是另写一个联合：这三个码必须**本来就是** `RunErrorCode`
 * 的一部分。谁把 `budget_iterations` 从词汇里删掉，这一行立刻编译不过——
 * 于是「预算停下来时，trace 说得出一个合法原因」这件事不会悄悄失效。
 */
export type BudgetStopCode = Extract<
  RunErrorCode,
  "budget_iterations" | "budget_tools" | "no_progress"
>;

/** 这次 Run 停下来的原因，由我们这一侧给出。 */
export type RunStop =
  | { readonly kind: "budget"; readonly code: BudgetStopCode; readonly message: string }
  | { readonly kind: "cancelled"; readonly message: string };

/**
 * 「这次 Run 必须停」。
 *
 * 它是一个**异常**，因为这是唯一能穿过端口包装层、把控制权从 Core 的循环里抢回来的
 * 手段：Core 不知道预算的存在，所以它不检查任何返回值；驱动方要拦住「下一次调用」，
 * 就只能在调用真正发出之前抛出来。
 *
 * 带 `stop` 而不是带一句话：驱动方要按它决定落哪个事件
 * （`budget` → `run_failed{code}`、`cancelled` → `run_cancelled`），
 * 而不是从消息文本里认字符串。
 */
export class RunStoppedError extends Error {
  readonly stop: RunStop;

  constructor(stop: RunStop) {
    super(stop.message);
    this.name = "RunStoppedError";
    this.stop = stop;
  }
}

/**
 * 「这一轮有没有前进」。
 *
 * 默认实现是 Core 的 `hasProgress`：谓词属于 Core，执法属于这里。这个类型存在的
 * 意义是让执法层可以被单独验证——今天的 Core 谓词在结构上抓不到空转（每一轮
 * `call_tool` 必然增加一条观测），所以「执法本身有效」只能靠换一个谓词来证明。
 * 这件事没有掩饰，写在 `docs/05-budget-cancellation.md` 里。
 */
export type ProgressPredicate = (before: AgentState, after: AgentState) => boolean;

/**
 * 默认预算。**有界**，这是刻意的：一个「默认不限」的 Runtime 会在真实使用里安静地
 * 跑很久（模型反复调同一个工具，一次几毛钱），而默认有界只会让一次跑不完的 Run
 * 停下来说清楚原因。
 *
 * 这些数字是工程判断，不是从第一性原理推导出来的——所以它们都写在这里、改得动：
 * - `maxIterations: 32`：一次「读几处代码 → 下结论」的任务通常 5〜15 轮；
 * - `maxToolCalls: 64`：比迭代数宽，因为一轮可以调多个工具；
 * - `timeoutMs` 10 分钟：够一次真实任务，又不至于让一次卡死的 Run 挂着过夜；
 * - `maxRetries: 2`：重试本身是步 8 的事（要先有 provider 错误分类），本步不动它；
 * - token 两项为 `null`：本步**不执法**，理由见 docs/05（没有对应的失败码，
 *   也没有 usage 来源）。`null` 在这里的含义是「不设上限」，与「我们还没法测」是
 *   同一件事——在能测之前，设一个数字只是自欺。
 */
export const DEFAULT_BUDGET: RunBudget = Object.freeze({
  maxIterations: 32,
  maxToolCalls: 64,
  maxRetries: 2,
  timeoutMs: 10 * 60 * 1000,
  maxInputTokens: null,
  maxOutputTokens: null,
});

/** 预算的执法者。三个检查点，每个都站在一次「动作」的前面。 */
export interface BudgetGuard {
  /** 每一轮**问模型之前**。`state` 是这一轮的入参状态。 */
  beforeModel(state: AgentState): void;
  /**
   * 每一次**决定要发起工具调用**之后、`tool_started` 之前。
   *
   * 记在「意图点」而不是工具端口的包装层里，是为了让事件说实话：超限的那次调用
   * 不该在日志里留下一条 `tool_started`——它从来没有开始过。端口那一层仍然有一道
   * 最后时刻的检查（`assertNotCancelled`），但预算的账只在这里记一次。
   */
  beforeTool(intent: ToolIntent): void;
  /**
   * 最后一刻的取消检查：调用真正交出去之前再问一次信号。
   *
   * 它守的是一个很窄的窗口——**检查与调用之间的那几个 `await`**（落一次日志、
   * 送一次事件）。窗口里取消一次，本来会有一条调用被发出去；有这一句之后，
   * 「中止之后不再发起任何调用」就不依赖「希望每个适配器都记得看信号」，
   * 而是结构性的。
   */
  assertNotCancelled(what: string): void;
}

export interface BudgetGuardOptions {
  readonly budget: RunBudget;
  /** 组合之后的信号（外部取消 + 墙钟）。已经中止时，守卫拒绝再发起任何调用。 */
  readonly signal: AbortSignal;
  readonly progress?: ProgressPredicate;
}

/**
 * 建一个守卫。它是有状态的（记着上一轮的状态与已经发起的工具次数），
 * 而状态属于**一次 Run**：每次 `run()` 建一个新的，所以两个 Run 不共享账本。
 *
 * 冲突时只报一个码，顺序是：**取消 → 没前进 → 轮数 → 工具次数**。
 * 最具体的先说：一个已经被取消的 Run 不该报告任何预算结论（那会让人以为是预算
 * 把它停下来的），而「没前进」比「轮数用完」更能说明当时发生了什么。
 */
export function createBudgetGuard(options: BudgetGuardOptions): BudgetGuard {
  const budget = options.budget;
  const signal = options.signal;
  const progress = options.progress ?? hasProgress;

  /** 上一轮**开始时**的状态。用来比较「这一轮有没有前进」；第一轮没有可比的对象。 */
  let previous: AgentState | null = null;
  let toolCalls = 0;

  const cancelled = (before: string): never => {
    throw new RunStoppedError({
      kind: "cancelled",
      message: `取消发生在${before}之前：这次 Run 不再发起任何调用`,
    });
  };

  return {
    beforeModel(state) {
      if (signal.aborted) cancelled("模型调用");

      if (previous !== null && !progress(previous, state)) {
        throw new RunStoppedError({
          kind: "budget",
          code: "no_progress",
          message: `走过 ${state.iteration} 轮之后，这一轮没有为状态增加任何新观测：问同一个问题等于空转`,
        });
      }
      previous = state;

      // `state.iteration` 是**已经走过**的轮数，所以 `>=` 恰好表示「这一轮不该开始」。
      if (state.iteration >= budget.maxIterations) {
        throw new RunStoppedError({
          kind: "budget",
          code: "budget_iterations",
          message: `已经走过 ${state.iteration} 轮，迭代预算 ${budget.maxIterations} 用完`,
        });
      }
    },

    beforeTool(intent) {
      if (signal.aborted) cancelled("工具调用");

      if (toolCalls >= budget.maxToolCalls) {
        throw new RunStoppedError({
          kind: "budget",
          code: "budget_tools",
          message:
            `已经发起 ${toolCalls} 次工具调用，工具预算 ${budget.maxToolCalls} 用完` +
            `（这一次要调的是 ${intent.name}，它没有被执行）`,
        });
      }
      toolCalls += 1;
    },

    assertNotCancelled(what) {
      if (signal.aborted) cancelled(what);
    },
  };
}
