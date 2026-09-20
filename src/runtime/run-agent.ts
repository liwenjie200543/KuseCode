/**
 * 一次 Run 的驱动 —— 把 Core 的循环翻译成一串有序、可审计的事件。
 *
 * 这个文件只回答一个问题：**一次 Run 怎么发生、怎么被看见？**
 * 它不回答「一步之后发生什么」——那是步 3 的 Core，它只是消费者。
 *
 * 三条边界在这里落地：
 *
 * 1. **一个 Run 不是一次应答，是一串有序可审计的事件。** 返回值不是 `Report`，
 *    是 `AgentEvent` 的流；终态结论（`run_completed` / `run_failed`）也只是这条流
 *    里的一个事件，不是「返回值」。
 * 2. **事件流是产品级契约，里面没有任何 SDK 类型。** 事件塞不进 provider 的响应对象，
 *    也塞不进 SDK 的错误类型——适配器（步 8）的职责是把 provider 的说法翻译成
 *    Core 的词汇，而不是把 Core 的词汇变成 provider 的形状。
 * 3. **异常不是结局。** 任何一步失败都落成一个 `run_failed` 事件，
 *    而不是一个抛给调用方的异常——「进程外部的一次失败必须变成一个
 *    有类型、可见、可恢复的 Run 状态」（步 2）。
 *
 * Runtime 做什么、Core 不做什么，这里划得很清楚：事件顺序、身份（`runId` /
 * `toolCallId`）、时钟、预算与取消的执法、终态事件的构造都在这一侧；循环语义、
 * 状态推进、「什么叫空转」的谓词都在那一侧。所以本文件没有重试、没有持久化实现、
 * 也没有一行 provider 的词汇——重试要等适配器的错误分类（步 8），存储是步 7。
 *
 * 步 5 给这个文件添的是**停止**：一条组合出来的信号（外部取消 + 墙钟）交给端口，
 * 两个「动作之前」的检查点拦住超支的调用，以及一处把「为什么停」翻译成事件的归因。
 * 三件事都在这一侧，因为它们回答的都是「这次 Run 怎么发生」。
 */

import { isTerminal, runCoreLoop } from "../core/loop.js";
import type { AssembleObservation, LoopDeps, TerminalDecision } from "../core/loop.js";
import type {
  AgentEvent,
  AgentRuntime,
  AgentState,
  ModelPort,
  RunBudget,
  RunErrorCode,
  Task,
  ToolPort,
} from "../core/types.js";
import { DEFAULT_BUDGET, RunStoppedError, createBudgetGuard } from "./budget.js";
import type { ProgressPredicate } from "./budget.js";
import { cryptoIds } from "./ids.js";
import type { IdFactory } from "./ids.js";
import type { RunLog } from "./run-log.js";
import { createRunSignal } from "./termination.js";
import type { TimeoutSignalFactory } from "./termination.js";

// ---------------------------------------------------------------------------
// 一次新 Run 的起点
// ---------------------------------------------------------------------------

/**
 * 一次全新 Run 的状态：一个空的 transcript。
 *
 * 它为什么在 Runtime 而不在 Core：构造状态是「一次 Run 如何开始」的一部分，
 * 而 Core 只回答「一步之后发生什么」——循环拿到的是**已经存在**的状态。
 * 于是 Core 里没有一行构造状态的代码，也就不可能存在第二套「初始状态长什么样」。
 */
export function emptyStateFor(task: Task): AgentState {
  return { task, transcript: [], iteration: 0, pendingQuestion: null };
}

// ---------------------------------------------------------------------------
// 缺失的材料：字段契约在此，填充语义在步 6
// ---------------------------------------------------------------------------

/**
 * 从终态算出「哪些该拿到却没拿到」。
 *
 * `RunOutcome.missingMaterial` 的字段契约在这里定下：它是**材料的名字**的列表，
 * 驱动 `run_completed` 的 `status`——非空即 `partial`。
 *
 * 但本步不实现它，默认返回空数组。理由是它需要证据，而证据还在路上：
 * 判断一条材料缺失要看执行层（步 6 的失败观测与被截断的观测），现在写等于编造。
 *
 * 为什么留一条接缝、而不是直接把 `missingMaterial: []` 写死：因为 `status` 的
 * `complete` / `partial` 分支必须有东西驱动。写死之后，`status` 就是一个常量，
 * 步 6 得回来改 Runtime 的代码；留接缝则步 6 只加一个实现，
 * 与步 3 把 `assembleObservation` 留成接缝是同一手法。
 */
export type CollectMissingMaterial = (state: AgentState) => readonly string[];

// ---------------------------------------------------------------------------
// 驱动方的依赖
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  readonly model: ModelPort;
  readonly tools: ToolPort;
  /** `ToolOutcome → Observation` 的组装点。步 6 的 tool-runner 是它的生产实现。 */
  readonly assembleObservation: AssembleObservation;
  /**
   * 事件落在哪里。**必填，没有默认值。**
   *
   * 一个「默认的内存日志」看起来方便，实际是个陷阱：调用方拿不到它，
   * 于是这次 Run 的所有证据都被悄悄扔掉。事件日志是唯一真相，
   * 「真相落在哪里」必须由调用方指名。
   */
  readonly log: RunLog;
  /** 身份的生成方式。默认 `cryptoIds()`；测试与 golden 用 `sequentialIds()`。 */
  readonly ids?: IdFactory;
  /** 时间来源（`timestamp` 与 `durationMs`）。默认 `Date.now`。 */
  readonly clock?: () => number;
  /** `model_requested` 里报告的名字。不知道就写 null，不要发明一个。 */
  readonly modelName?: string | null;
  /** 见 `CollectMissingMaterial`。默认 `() => []`。 */
  readonly collectMissingMaterial?: CollectMissingMaterial;
  /**
   * 预算。省略时用 `DEFAULT_BUDGET`——**有界的那个**。
   *
   * 这里给默认值，与 `log` 必须由调用方指名并不矛盾：一个默认的日志会安静地扔掉
   * 证据，而一个默认的预算只会让一次跑不完的 Run 停下来说清原因。
   * 想关掉某一条就显式写 `Infinity`——轮数、工具次数、墙钟都认它
   * （`timeoutMs` 非有限时 `createRunSignal` 干脆不设计时器）。那是调用方的选择，
   * 不是我们替他默认的。
   */
  readonly budget?: RunBudget;
  /** 墙钟的来源。默认 `AbortSignal.timeout`，见 `termination.ts`。 */
  readonly timeoutSignal?: TimeoutSignalFactory;
  /** 「这一轮有没有前进」的谓词。默认 Core 的 `hasProgress`，见 `budget.ts`。 */
  readonly progress?: ProgressPredicate;
}

// ---------------------------------------------------------------------------
// 失败归一化：RunErrorCode 是 Runtime 认识的全部失败
// ---------------------------------------------------------------------------

/**
 * 失败分类表，用 `satisfies` 钉住**恰好**覆盖 `RunErrorCode`。
 *
 * 这张表不是查找表，是一道编译期证明：谁往 `RunErrorCode` 里加了一个码，
 * 这里就编译不过，于是「Runtime 能不能接住它」被迫当场回答，
 * 而不是等某次真实运行里出现一个没人认识的字串。
 */
const RUN_ERROR_CODES = {
  budget_iterations: true,
  budget_tools: true,
  budget_timeout: true,
  no_progress: true,
  rate_limited: true,
  timeout: true,
  auth: true,
  invalid_tool: true,
  provider_unavailable: true,
  runtime_error: true,
} as const satisfies Record<RunErrorCode, true>;

/** 这个字串是不是一个 Runtime 认识的失败码。 */
function isRunErrorCode(value: string): value is RunErrorCode {
  return RUN_ERROR_CODES[value as RunErrorCode] === true;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return typeof error === "string" ? error : String(error);
}

/**
 * 把任意抛出物归一成 `RunErrorCode` + 一句话。
 *
 * 规则只有一条：**带合法 `code` 的抛出物原样保留，其余一律 `runtime_error`。**
 * Runtime 不认识 provider，但它认识这十个码，所以它只接受「已经是合法分类」的输入，
 * 不猜、不映射、不从消息文本里认字符串。
 *
 * provider 特有的错误（限流、超时、鉴权失败）怎么变成这十个码，是**适配器**的事,
 * 映射表在步 8 的 `docs/pi-port-mapping.md`。这里是那张表的落点，不是那张表本身——
 * 这也是为什么本文件里没有一行代码提到任何 provider 的词汇。
 */
export function toRunError(error: unknown): { readonly code: RunErrorCode; readonly message: string } {
  const message = messageOf(error);
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && isRunErrorCode(code)) return { code, message };
  }
  return { code: "runtime_error", message };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * 事件的「未定稿」：`runId` / `sequence` / `timestamp` 由驱动方一手填，
 * 调用方只提供这个变体自己的载荷。
 *
 * 那三个键名在这里被写死了一次，代价是：若步 2 的 `EventBase` 将来多出一个
 * 必填字段，本文件会立刻编译失败（缺字段）。它响，不会悄悄漏。
 */
type EventBaseKeys = "runId" | "sequence" | "timestamp" | "type";
type EventPayload<K extends AgentEvent["type"]> = Omit<Extract<AgentEvent, { type: K }>, EventBaseKeys>;

/**
 * 建一个 Runtime。
 *
 * 返回的对象只有 `run` 一个方法（`AgentRuntime`），因为它对外只承诺一件事：
 * 给我一个 Task，我给你一条事件流。
 */
export function createRuntime(options: RunAgentOptions): AgentRuntime {
  const innerModel = options.model;
  const tools = options.tools;
  const assembleObservation = options.assembleObservation;
  const log = options.log;
  const ids = options.ids ?? cryptoIds();
  const clock = options.clock ?? ((): number => Date.now());
  const modelName = options.modelName ?? null;
  const collectMissingMaterial = options.collectMissingMaterial ?? ((): readonly string[] => []);
  const budget = options.budget ?? DEFAULT_BUDGET;

  async function* run(task: Task, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, void> {
    const runId = ids.runId();

    // 这次 Run 的信号：外部取消与墙钟的合流。调用方没传就只剩墙钟；两条都没有时
    // 它是一条永不中止的信号——「这条 Run 不会因信号而停」是显式写下的，
    // 而不是某个 `??` 顺手带来的副作用。
    const runSignal = createRunSignal({
      ...(signal === undefined ? {} : { external: signal }),
      timeoutMs: budget.timeoutMs,
      ...(options.timeoutSignal === undefined ? {} : { timeoutSignal: options.timeoutSignal }),
    });

    // 预算是**一次 Run 的**账本（守卫记着上一轮的入参状态与已经发起的工具次数），
    // 所以它在这一层建：两个 Run 不共享账本。
    const guard = createBudgetGuard({
      budget,
      signal: runSignal.signal,
      ...(options.progress === undefined ? {} : { progress: options.progress }),
    });

    let sequence = 0;
    let state = emptyStateFor(task);
    let lastTerminal: TerminalDecision | null = null;
    /**
     * 这次 Run 是否已经走到一个**我们自己选择的停点**：收工、失败、挂起等人，
     * 或者（`finally` 里）判明它被遗弃了。
     *
     * 它是最后一条路径的完备性所依赖的东西：生成器被关闭（消费者半路离场）时，
     * `finally` 必须能分清「已经好好停了」与「还没停就没人管了」——后者要在日志里
     * 留下一条终态事件，否则一次 Run 的日志可以停在一个没有结尾的地方，
     * 而「没有结尾」与「崩了」在回放看来是同一件事。
     */
    let settled = false;
    let pendingTool: { readonly id: string; readonly name: string; readonly startedAt: number } | null =
      null;

    /**
     * 已落日志、还没交给消费者的事件。
     *
     * 为什么需要一条队列：`model_requested` 产生在**端口内部**——只有那里才说得清
     * 「请求此刻发出」——而 `yield` 只能发生在驱动方的函数体里。于是「产生」与「送出」
     * 必须拆开：事件产生时立刻落日志、进队列；控制权回到驱动方时按序送出。
     *
     * 拆开之后有一条不变量，它不只是实现细节：
     * **「已送出的前缀 + 队列 = 日志」**——所以消费者看到的永远是日志的一个前缀，
     * 不可能看到一条不在日志里的事件，也不可能看到乱序。
     * 「日志是唯一真相，事件流是它的投影」在代码里就是这个形状。
     */
    const queue: AgentEvent[] = [];

    /**
     * 写一条事件：**先落日志，再排队等送出**。
     *
     * `sequence` 的所有权就在这几行里：它是这个闭包的私有变量，外部构造不出
     * `AgentEvent`，所以「单调递增」是结构性的，不靠调用方自觉。
     *
     * 顺序是刻意的（write-ahead）：记录先存在，然后才有人看见它。
     * 若消费者在处理某条事件时崩溃，这条事件仍在日志里——「日志是唯一真相」
     * 要求真相不依赖观察者的存活。代价是消费者提前 break 时，日志可能比它多几条；
     * 那不是丢失，是多记，而且多记的都在前缀之后（下面有测试钉住这一条）。
     *
     * `sequence` 在 `append` **之前**前进。若 append 抛错，序号就出现了一个洞，
     * 后续写入会被日志的连续性检查拒绝（见 `assertAppendOnly`），异常最终逃出生成器。
     * 这也是刻意的：一个坏掉的日志不该让这次 Run 看起来正常。
     */
    const emit = async <K extends AgentEvent["type"]>(
      type: K,
      payload: EventPayload<K>,
    ): Promise<void> => {
      const event = { ...payload, runId, sequence, timestamp: clock(), type } as Extract<
        AgentEvent,
        { type: K }
      >;
      sequence += 1;
      await log.append(event);
      queue.push(event);
    };

    /** 把这个批次里已经落日志的事件按序送给消费者。 */
    async function* deliver(): AsyncGenerator<AgentEvent, void, void> {
      while (queue.length > 0) {
        const event = queue.shift();
        if (event !== undefined) yield event;
      }
    }

    /**
     * 「为什么停」→「日志里写什么」。判据的**顺序**是这段代码的全部要点：
     *
     * 1. 先问我们自己那条信号。它响了，那么无论端口抛的是什么，停止原因都是我们
     *    已经知道的那个事实——外部取消记为 `run_cancelled`（它不是失败，
     *    `RunErrorCode` 里没有也不该有「用户取消了」这一项）；墙钟到点记为
     *    `run_failed{budget_timeout}`。注意 `budget_timeout` 与适配器的 `timeout`
     *    是两个码：一个是这次 Run 的墙钟，一个是单次请求的超时，合成一个码会让
     *    trace 答不出「是谁的时间到了」。
     * 2. 再问预算守卫。它抛的 `RunStoppedError` 本来就带一个合法的码，原样写进事件，
     *    不做二次翻译。`kind: "cancelled"` 是守卫自己发现信号已经响了的那条路径；
     *    正常情况下第 1 步就拦住了它，这里是兜底而不是死代码。
     * 3. 最后才是任意抛出物：`toRunError` 保留合法的码，其余落到 `runtime_error`。
     *
     * 这里**没有** rethrow：调用方按事件流判断生死，不靠 try/catch。唯一的例外是
     * 事件本身写不下去（日志坏了）——那时异常必须逃出去，把一次失败的 Run 伪装成
     * 正常收场比崩溃更糟。
     */
    const emitStop = async (error: unknown): Promise<void> => {
      const cause = runSignal.cause();

      if (cause === "external") {
        await emit("run_cancelled", {});
        return;
      }
      if (cause === "wall_clock") {
        await emit("run_failed", {
          error: {
            code: "budget_timeout",
            message: `墙钟到点：这次 Run 已经跑了 ${budget.timeoutMs}ms`,
          },
        });
        return;
      }
      if (error instanceof RunStoppedError) {
        if (error.stop.kind === "cancelled") {
          await emit("run_cancelled", {});
          return;
        }
        await emit("run_failed", { error: { code: error.stop.code, message: error.stop.message } });
        return;
      }
      await emit("run_failed", { error: toRunError(error) });
    };

    /**
     * 模型端口外面包的一层，做两件事：执法预算，然后发射 `model_requested`。
     *
     * 为什么不让循环在决策之后补记一条 `model_requested`：事件的顺序与时间戳必须是
     * **真的**。「请求已发出」发生在真正发起请求的那一刻，不是事后回忆。包一层端口是
     * 唯一能做到这件事的位置——步 3 的文档预言了它，步 5 的预算记账果然落到了同一处。
     *
     * 预算检查在 `model_requested` **之前**：没有发出去的请求不该在日志里留下一条
     * 说自己发过的事件。
     */
    const guardedModel: ModelPort = {
      async decide(modelState: AgentState, modelSignal: AbortSignal) {
        guard.beforeModel(modelState);
        await emit("model_requested", { model: modelName });
        // 落日志、送事件这两个 await 之间取消一次的话，本来会有一条请求被发出去。
        guard.assertNotCancelled("模型调用");
        return innerModel.decide(modelState, modelSignal);
      },
    };

    /**
     * 工具端口外面包的一层，只做一件事：最后一刻的取消检查。
     *
     * 工具是由 Core 的循环发起的，驱动方够不着调用点，所以「中止之后不再发起任何
     * 工具调用」的最后一道闸门只能在这里。它不记账——工具预算的账记在驱动方的
     * 「意图点」（见 `budget.ts` 的 `beforeTool`），这样超限那次调用不会先在日志里
     * 留下一条 `tool_started` 再被拒。
     *
     * `names` 原样透传：allowlist 的判断属于执行层（步 6 的 tool-runner，今天在假工具里），
     * 这里与 Core 都不该有第二份。
     */
    const guardedTools: ToolPort = {
      names: tools.names,
      async execute(intent, toolSignal) {
        guard.assertNotCancelled("工具调用");
        return tools.execute(intent, toolSignal);
      },
    };

    const deps: LoopDeps = { model: guardedModel, tools: guardedTools, assembleObservation };

    try {
      await emit("run_started", {});
      yield* deliver();

      // 这里就是步 3 说好的消费方式：`observation === null` 区分「意图」与「结果」
      // 两次产出，终态决策只产出一次，generator 的返回值用不上（终态从 turn 里就看得到）。
      for await (const turn of runCoreLoop(state, deps, runSignal.signal)) {
        // 控制权刚回到驱动方：先把端口那一侧产生的事件送出去。
        // `model_requested` 就在这里——它产生于 `decide` 内部，只能等控制权回来才送得出去，
        // 送出之后才是 decision_made，顺序与真实因果一致。
        yield* deliver();

        const decision = turn.decision;
        state = turn.state;

        if (isTerminal(decision)) {
          lastTerminal = decision;
          await emit("decision_made", { decision });
        } else if (turn.observation === null) {
          // 第一次产出：意图已下、工具还没跑。`tool_started` 的时间戳因此是真的，
          // 而「工具跑到一半被取消」（有意图、无观测）也只有在这个顺序下表达得出来。
          await emit("decision_made", { decision });
          // 这是驱动方看到「模型要调工具了」的第一刻，也是最后一个能拦住它的位置：
          // 再往下就是一次真正的执行（可能有副作用）。检查放在 `tool_started` 之前，
          // 所以被拦下的那次调用不会先在日志里留下一句「开始了」。
          guard.beforeTool(decision.intent);
          const toolCallId = ids.toolCallId();
          pendingTool = { id: toolCallId, name: decision.intent.name, startedAt: clock() };
          await emit("tool_started", { toolCallId, toolName: decision.intent.name });
        } else {
          // 第二次产出：执行结束、观测已回。
          if (pendingTool === null) {
            throw new Error(
              "收到一条没有对应 tool_started 的观测：Core 违反了「一轮产出两次」的协议",
            );
          }
          const tool = pendingTool;
          pendingTool = null;
          await emit("tool_completed", {
            toolCallId: tool.id,
            toolName: tool.name,
            status: turn.observation.error === null ? "success" : "error",
            result: turn.observation.value,
            error: turn.observation.error,
            durationMs: clock() - tool.startedAt,
          });
          await emit("observation_added", {
            name: turn.observation.tool,
            observation: turn.observation,
          });
        }

        yield* deliver();
      }

      // 循环停下来了。停在人类那一侧、还是干完了，由终态状态决定——
      // 而不是由「循环返回了什么」决定：状态是唯一真相，这里也不破这个例。
      //
      // `settled` 在这里先置位、再落事件：它代表「已经决定这次 Run 停在哪里」。
      // 若落事件本身失败（日志坏了），异常原样逃出去，`finally` 不需要、也不该
      // 再补一条——补了会把「日志坏了」这件事盖掉。
      if (state.pendingQuestion !== null) {
        settled = true;
        await emit("human_input_requested", { question: state.pendingQuestion });
      } else if (lastTerminal !== null && lastTerminal.kind === "respond") {
        settled = true;
        const missingMaterial = collectMissingMaterial(state);
        await emit("run_completed", {
          status: missingMaterial.length > 0 ? "partial" : "complete",
          result: lastTerminal.report,
          missingMaterial,
        });
      } else {
        // 到不了这里：循环只有两种停法（终态决策 / 一开始就停在人类那侧）。
        // 真到了，说明 Core 违反了契约——让它以一个有类型的失败事件结束，
        // 而不是让这次 Run 看起来像是正常收工了。
        throw new Error("循环结束了，但既没有待答问题、也没有应答——Core 违反了它的契约");
      }

      yield* deliver();
    } catch (error) {
      settled = true;
      await emitStop(error);
      yield* deliver();
    } finally {
      runSignal.dispose();
      if (!settled) {
        // 走到这里说明消费者在 Run 结束前离场了：`for await ... break` 会关闭生成器，
        // 工作当场停下（此刻没有任何调用在途——关闭只发生在 yield 点上），
        // 而日志还停在一个没有结尾的地方。
        //
        // 补一条 `run_cancelled`。它与「外部信号响了」共用同一个名字，因为它们的
        // 含义本来就相同：**这次 Run 不会再做任何事。** 区别只有一个——这一条
        // 写得下，但没人看得见（消费者已经走了）。日志是唯一真相，真相要收尾；
        // 事件流是它的投影，投影停在消费者离场的那一刻。
        await emit("run_cancelled", {});
      }
    }
  }

  return { run };
}
