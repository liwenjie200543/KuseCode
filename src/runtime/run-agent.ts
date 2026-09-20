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
 * `toolCallId`）、时钟、终态事件的构造都在这一侧；循环语义、状态推进、
 * 「什么叫空转」的谓词都在那一侧。所以本文件没有 budget、没有重试、没有持久化实现
 * ——预算与取消是步 5，存储是步 7。
 */

import { isTerminal, runCoreLoop } from "../core/loop.js";
import type { AssembleObservation, LoopDeps, TerminalDecision } from "../core/loop.js";
import type {
  AgentEvent,
  AgentRuntime,
  AgentState,
  ModelPort,
  RunErrorCode,
  Task,
  ToolPort,
} from "../core/types.js";
import { cryptoIds } from "./ids.js";
import type { IdFactory } from "./ids.js";
import type { RunLog } from "./run-log.js";

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

  async function* run(task: Task, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, void> {
    const runId = ids.runId();
    // 没有外部信号时也要给出一条：循环与两个端口的签名都要它（步 3）。
    // 这条默认信号永不中止——「没传 signal 就等于这次 Run 不会取消」是显式写下的，
    // 而不是某个 `??` 顺手带来的副作用。
    const abort = signal ?? new AbortController().signal;

    let sequence = 0;
    let state = emptyStateFor(task);
    let lastTerminal: TerminalDecision | null = null;
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
     * 端口外面包的一层，只为发射 `model_requested`。
     *
     * 为什么不让循环在决策之后补记一条：事件的顺序与时间戳必须是**真的**。
     * 「请求已发出」发生在真正发起请求的那一刻，不是事后回忆。包一层端口是唯一
     * 能做到这件事的位置——而且它顺便证明了端口这层抽象是可组合的，
     * 步 5（预算记账）与步 9（trace）还会用同一手法再包一次。
     */
    const observingModel: ModelPort = {
      async decide(modelState: AgentState, modelSignal: AbortSignal) {
        await emit("model_requested", { model: modelName });
        return innerModel.decide(modelState, modelSignal);
      },
    };

    const deps: LoopDeps = { model: observingModel, tools, assembleObservation };

    try {
      await emit("run_started", {});
      yield* deliver();

      // 这里就是步 3 说好的消费方式：`observation === null` 区分「意图」与「结果」
      // 两次产出，终态决策只产出一次，generator 的返回值用不上（终态从 turn 里就看得到）。
      for await (const turn of runCoreLoop(state, deps, abort)) {
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
      if (state.pendingQuestion !== null) {
        await emit("human_input_requested", { question: state.pendingQuestion });
      } else if (lastTerminal !== null && lastTerminal.kind === "respond") {
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
      // 外部失败必须变成有类型、可见的状态，而不是一个异常（步 2 的 RunErrorCode 为此存在）。
      // 注意这里**没有** rethrow：调用方按事件流判断生死，不靠 try/catch。
      //
      // 如果连这条 run_failed 都写不下去（日志自身坏了，`append` 再抛），
      // 异常会从这里逃出去——这是对的。悄悄吞掉比崩溃更糟：那会让一次失败的 Run
      // 看起来像一次正常结束的 Run。
      await emit("run_failed", { error: toRunError(error) });
      yield* deliver();
    }
  }

  return { run };
}
