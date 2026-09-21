/**
 * trace —— 事件日志的**第三个**纯投影。
 *
 * 一份日志已经回答了三个不同的问题，而它们各自需要一个消费者：
 *
 * | 问题 | 消费者 | 形状 |
 * |---|---|---|
 * | 那串事件说的是哪个**状态**？ | 回放（`./replay.ts`） | `AgentState` |
 * | 那次 Run 停在**哪儿**？ | `runStatusOf`（同上） | `RunStatus` |
 * | 它**干了什么、为什么停、花了多少**？ | 本文件 | `RunTrace` |
 *
 * 三者都是纯函数，都不碰磁盘、不看时钟、不问端口——日志是唯一真相，
 * 而它们是同一份真相的三种看法。
 *
 * ## 与回放的一处关键区别（刻意的）
 *
 * 回放对 `human_input_received` / `run_resumed` **抛错**，因为它要重建状态，
 * 而"人的回答怎么进 transcript"那一步还不存在（见 `./replay.ts` 的 `unsupported`）。
 * 本文件**不抛**：它不重建状态，只读事实。于是一份回放拒绝重建的日志，
 * 仍然可以被 trace 描述出来——"这个 Run 收过一个人的回答，然后接着跑了"
 * 是一个可以陈述的事实，哪怕我们还不知道它把状态推进到了哪里。
 *
 * 这不是对回放的宽容，而是两个问题各自的严格程度不同：状态的每一格都必须有依据，
 * 而"发生了什么"只要是日志里写着的事就能说。
 *
 * ## 它不重算任何 Runtime 已经数过的东西
 *
 * "花了多少"的答案是 `usage_reported` 事件本身。这里不做 token 加法、不数工具次数、
 * 不重算时长——那些数字由 Runtime 在事件产生的那一刻记下，重算一遍就会多出一个
 * 会与它分叉的真相。日志里没有那条事件时，诚实的答案是 `usage: null`
 * （"这次 Run 没有账目"），而不是我们自己算一个看起来差不多的数。
 */

import type { AgentEvent, Report, RunErrorCode, RunStatus } from "../core/types.js";
import { assertContiguousPrefix, isTerminalEvent, runStatusOf } from "./replay.js";

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/**
 * 一次工具调用在 trace 里的样子。
 *
 * `status: "unfinished"` 是一个真实存在且必须可表达的终局：`tool_started` 写下了、
 * 而 `tool_completed` 没有——调用在途中 Run 就结束了。把它归成 `error` 会让它看起来
 * 像"工具报错了"，而归成 `success` 是撒谎。步 6 的文档把它记成"有意图、无观测"，
 * 这里是同一个事实的另一个说法。
 */
export interface TraceStep {
  /** 第几次调用，从 1 起。 */
  readonly index: number;
  /** 第几个决策，从 1 起。注意它不是 `AgentState.iteration`（那是"已走过几轮"）。 */
  readonly round: number;
  /** 事件的关联 id。它是「这次调用」在日志里的名字，也是 `tool_started` 与
   * `tool_completed` 配对的依据。 */
  readonly toolCallId: string;
  readonly tool: string;
  /** 模型给的参数原文。给人看时用 `digestIntent` 压成一行，JSON 模式下是结构化数据。 */
  readonly args: Readonly<Record<string, unknown>>;
  readonly status: "success" | "error" | "unfinished";
  /** `status === "error"` 时的工具侧失败码（`ToolErrorCode`，不是 `RunErrorCode`）。 */
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** 结果是否因超长被替换成预览。它只写在 `observation_added` 上，所以要跨事件取。 */
  readonly truncated: boolean;
  readonly startedAt: number;
  /** `tool_completed` 报的耗时；没有完成时是 0。 */
  readonly durationMs: number;
}

/**
 * 「为什么停」—— 唯一的答案。
 *
 * 五个分支穷尽了日志可能的收场：三个终态事件、一种挂起（没有终态事件）、
 * 以及"日志到此为止，Run 还没走完"。最后一种不是失败：一个正在跑的 Run
 * 被读日志的人也看到，那正是 `queued` / `running` 这两个状态存在的理由。
 */
export type TraceStop =
  | {
      readonly kind: "completed";
      readonly status: "complete" | "partial";
      readonly missingMaterial: readonly string[];
    }
  | { readonly kind: "failed"; readonly code: RunErrorCode; readonly message: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "awaiting_human"; readonly question: string }
  | { readonly kind: "unfinished"; readonly status: RunStatus };

/** `usage_reported` 的载荷，原样。不重算、不四舍五入、不补零。 */
export interface TraceUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCalls: number;
  readonly durationMs: number;
  readonly model: string | null;
}

/** 一次 Run 的 trace。契约的 Trace 一节要求它回答的三个问题都在这里。 */
export interface RunTrace {
  readonly runId: string;
  /** 由终态事件（或没有终态事件）算出的位置。与 `SessionStore` 用的是同一个函数。 */
  readonly status: RunStatus;
  /** `run_started` 的时刻；日志是空的时候为 `null`。 */
  readonly startedAt: number | null;
  /** 最后一条事件的时刻；日志是空的时候为 `null`。 */
  readonly endedAt: number | null;
  /** 日志一共有多少条事件。它是"这次 Run 说了多少话"的体量指示。 */
  readonly eventCount: number;
  /** 按序调用了什么。 */
  readonly steps: readonly TraceStep[];
  /** 为什么停。 */
  readonly stop: TraceStop;
  /** 花了多少。没有 `usage_reported` 事件时是 `null`（"没有账目"，不是"零"）。 */
  readonly usage: TraceUsage | null;
  /** 交付的结论。只有 `run_completed` 才有。 */
  readonly report: Report | null;
  /** 这次 Run 收到的那个待答问题（`human_input_requested`）。 */
  readonly question: string | null;
  /** 模型名（`model_requested` / `usage_reported` 报的）。 */
  readonly model: string | null;
}

// ---------------------------------------------------------------------------
// 折叠
// ---------------------------------------------------------------------------

/** 边折边改的中间形状：步骤在 `tool_completed` / `observation_added` 到达时才补齐。 */
interface MutableStep {
  index: number;
  round: number;
  toolCallId: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
  status: "success" | "error" | "unfinished";
  errorCode: string | null;
  errorMessage: string | null;
  truncated: boolean;
  startedAt: number;
  durationMs: number;
}

/**
 * 一串事件 → 一次 Run 的 trace。
 * 输入的要求与回放**完全一样**（`assertContiguousPrefix`），因为它在回答同一个
 * 层面的问题："这串事件说的是哪一次 Run"。有洞、有重复、从中间截一段出来的
 * 事件序列，不构成任何一次 Run。
 *
 * 一次 Run 至多一个终态事件，这里也照查不误：有的日志写着两个结尾时，
 * 一个"总耗时"或"最终结论"都是在两个互相矛盾的版本里挑一个，
 * 而挑出来的那一个不会被标注成"这是猜的"。
 */
export function traceOf(events: readonly AgentEvent[]): RunTrace {
  assertContiguousPrefix(events);

  const terminals = events.filter((event) => isTerminalEvent(event.type));
  if (terminals.length > 1) {
    throw new Error(
      `日志里有 ${terminals.length} 个终态事件（${terminals
        .map((event) => event.type)
        .join(" 与 ")}）：一次 Run 只能结束一次，所以 trace 也只有一个答案`,
    );
  }

  const first = events[0];
  const last = events[events.length - 1];
  const runId = first?.runId ?? "";

  const steps: MutableStep[] = [];
  /** 最近一次 `call_tool` 决策的意图——`tool_started` 不带参数，参数在它前面那条决策里。 */
  let lastIntent: Readonly<Record<string, unknown>> = {};
  let lastIntentName: string | null = null;
  let rounds = 0;
  /** 已经 `tool_completed`、还在等 `observation_added` 的那一步（`truncated` 在那边）。 */
  let awaitingObservation: MutableStep | null = null;

  let report: RunTrace["report"] = null;
  let question: string | null = null;
  let usage: TraceUsage | null = null;
  let model: string | null = null;
  let stop: TraceStop | null = null;

  for (const event of events) {
    switch (event.type) {
      case "run_started":
        break;

      case "model_requested":
        // 模型名只记第一个非空的：重试会让这个事件出现多次，而"用的是哪个模型"
        // 在一次 Run 里不该变（变的是模型之外的东西）。
        model ??= event.model;
        break;

      case "decision_made": {
        rounds += 1;
        if (event.decision.kind === "call_tool") {
          lastIntent = event.decision.intent.args;
          lastIntentName = event.decision.intent.name;
        }
        break;
      }

      case "tool_started": {
        steps.push({
          index: steps.length + 1,
          round: rounds,
          toolCallId: event.toolCallId,
          tool: event.toolName,
          // 参数取自前面那条决策。名字对不上时宁可用空对象，也不把别人的参数安上去。
          args: lastIntentName === event.toolName ? lastIntent : {},
          status: "unfinished",
          errorCode: null,
          errorMessage: null,
          truncated: false,
          startedAt: event.timestamp,
          durationMs: 0,
        });
        break;
      }

      case "tool_completed": {
        const step = steps.find((candidate) => candidate.toolCallId === event.toolCallId);
        if (step === undefined) {
          throw new Error(
            `有一条 tool_completed 找不到它对应的 tool_started（${event.toolCallId}）：` +
              `日志自相矛盾`,
          );
        }
        step.status = event.status;
        step.errorCode = event.error?.code ?? null;
        step.errorMessage = event.error?.message ?? null;
        step.durationMs = event.durationMs;
        awaitingObservation = step;
        break;
      }

      case "observation_added": {
        // 末尾"有意图、无观测"的补写（history.ts 里那条诚实的工具结果）不会产生
        // 事件，所以这里对不上只是日志不完整，不是矛盾——安静地跳过比抛出去更合适：
        // trace 的描述能力不该因为一条可选事件缺失而整体失效。
        if (awaitingObservation !== null) {
          awaitingObservation.truncated = event.observation.truncated;
          awaitingObservation = null;
        }
        break;
      }

      case "human_input_requested":
        question = event.question;
        break;

      case "human_input_received":
      case "run_resumed":
        // 见文件头：回放拒绝这两条（要重建状态），trace 接受它们（只读事实）。
        break;

      case "usage_reported":
        usage = event.usage;
        model ??= event.usage.model;
        break;

      case "run_completed":
        report = event.result;
        stop = {
          kind: "completed",
          status: event.status,
          missingMaterial: event.missingMaterial,
        };
        break;

      case "run_failed":
        stop = { kind: "failed", code: event.error.code, message: event.error.message };
        break;

      case "run_cancelled":
        stop = { kind: "cancelled" };
        break;

      default: {
        // 步 7 用 `never` 把"加了第 14 种事件"变成编译错误；这里做同一件事。
        const unhandled: never = event;
        throw new Error(`trace 没有处理这种事件：${JSON.stringify(unhandled)}`);
      }
    }
  }

  return {
    runId,
    status: runStatusOf(events),
    startedAt: first?.timestamp ?? null,
    endedAt: last?.timestamp ?? null,
    eventCount: events.length,
    steps: Object.freeze(steps.map((step) => Object.freeze(step))),
    stop: stop ?? (question !== null ? { kind: "awaiting_human", question } : {
      kind: "unfinished",
      status: runStatusOf(events),
    }),
    usage,
    report,
    question,
    model,
  };
}
