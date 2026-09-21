import { describe, expect, it } from "vitest";

// 步 7 的命题：**事件日志是唯一真相，回放是幂等的。**
//
// 这个文件是它的证据，所以每一处「实时状态」都取自一次真的跑过的运行：
// Core 循环每一轮交出来的状态、或者 Runtime 在收工时亲手交出来的状态。
// 拿一个手写的期望值来比，证明的只是「我记得自己写了什么」。
import { observationsOf, runCoreLoop } from "../src/core/loop.js";
import type { AgentEvent, AgentState, Decision, Task, ToolIntent } from "../src/core/types.js";
import { sequentialIds } from "../src/runtime/ids.js";
import { isRunOver, replayAgentState, runStatusOf } from "../src/runtime/replay.js";
import { createRuntime, emptyStateFor } from "../src/runtime/run-agent.js";
import { memoryRunLog } from "../src/runtime/run-log.js";
import type { RunLog } from "../src/runtime/run-log.js";
import { collectMissingMaterial, createToolRunner } from "../src/runtime/tool-runner.js";
import { scriptedModel } from "../src/testing/fake-model.js";
import { fakeClock, fakeTools } from "../src/testing/fake-tools.js";
import type { FakeToolBehavior } from "../src/testing/fake-tools.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-7",
  goal: "这次 Run 的状态，能不能从它的日志里一模一样地重建出来？",
  repoRoot: "/repo",
  checks: ["回放重建出的状态与实时状态深相等"],
};

const readFile: ToolIntent = { name: "read_file", args: { path: "src/core/loop.ts" } };
const readOther: ToolIntent = { name: "read_file", args: { path: "src/runtime/run-agent.ts" } };

const callTool = (intent: ToolIntent): Decision => ({ kind: "call_tool", intent });
const respond = (summary: string): Decision => ({ kind: "respond", report: { summary, claims: [] } });
const askHuman = (question: string): Decision => ({ kind: "ask_human", question });

const ok = (value: unknown): FakeToolBehavior => ({ value, error: null });

const READS: Readonly<Record<string, FakeToolBehavior>> = {
  read_file: ok("export function reduce() {}"),
};

/** 一次跑一半的调用：它是「取消」与「单次超时」两条路径的载体。 */
const brokenRead = (code: string): Readonly<Record<string, FakeToolBehavior>> => ({
  read_file: { value: null, error: { code, message: "这一条材料没拿到" } },
});

/** 「这里一定有东西」：把 `T | null | undefined` 收窄成 `T`，缺了就当场说清缺什么。 */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`缺少 ${what}`);
  return value;
}

// ---------------------------------------------------------------------------
// 两条「实时」参照：Runtime 亲手交出来的状态，与 Core 循环每一轮交出来的状态
// ---------------------------------------------------------------------------

interface LiveRun {
  readonly events: readonly AgentEvent[];
  readonly runId: string;
  readonly log: RunLog;
  /** Runtime 在 `run_completed` 那一刻亲手交出来的终态状态；别的路径没有。 */
  readonly handedOut: AgentState | null;
}

/**
 * 跑一次真的 Run（生产执行层 + 真 Runtime），把事件流与终态状态都留下来。
 *
 * `collectMissingMaterial` 被包了一层薄薄的探针：它是 Runtime 唯一一处把**终态状态**
 * 交出来的接缝（步 4 留的），所以探针拿到的那一份就是这次 Run 的实时终态。
 * 用它而不是「再算一遍」，是为了让断言比较的是同一次运行里的两个东西。
 */
async function liveRun(
  script: readonly Decision[],
  behaviors: Readonly<Record<string, FakeToolBehavior>> = READS,
  signal?: AbortSignal,
): Promise<LiveRun> {
  const log = memoryRunLog();
  const runner = createToolRunner({ tools: fakeTools(behaviors), clock: fakeClock() });
  const box: { state: AgentState | null } = { state: null };

  const runtime = createRuntime({
    model: scriptedModel(script),
    ...runner.toolDeps(),
    log,
    ids: sequentialIds("t"),
    clock: fakeClock(),
    modelName: "fake-model",
    collectMissingMaterial: (state: AgentState) => {
      box.state = state;
      return collectMissingMaterial(state);
    },
  });

  const events: AgentEvent[] = [];
  for await (const event of runtime.run(task, signal)) events.push(event);

  return { events, runId: must(events[0], "第一条事件").runId, log, handedOut: box.state };
}

/**
 * 同一段脚本、同一个执行层，用 Core 的循环本体跑一遍，记下它每一轮交出来的状态。
 *
 * 最后记下的那一个，就是这次 Run 真的走到的状态——回放必须重建出它。
 * 这条参照对**每一条**路径都成立，包括被停下的那一条（那时循环没有返回值，
 * 但它每一轮交出来的状态仍然是实时状态）。
 */
async function liveLoopState(
  script: readonly Decision[],
  behaviors: Readonly<Record<string, FakeToolBehavior>> = READS,
  signal?: AbortSignal,
): Promise<AgentState> {
  const runner = createToolRunner({ tools: fakeTools(behaviors), clock: fakeClock() });
  const generator = runCoreLoop(
    emptyStateFor(task),
    {
      model: scriptedModel(script),
      tools: runner.tools,
      assembleObservation: runner.assembleObservation,
    },
    signal ?? new AbortController().signal,
  );

  let state = emptyStateFor(task);
  try {
    let step = await generator.next();
    while (step.done !== true) {
      state = step.value.state;
      step = await generator.next();
    }
  } catch {
    // 被停下的 Run 没有返回值：最后交出来的那个状态就是它走到的状态。
  }
  return state;
}

// ---------------------------------------------------------------------------
// 手工拼一条日志
// ---------------------------------------------------------------------------

type PayloadOf<K extends AgentEvent["type"]> = Omit<
  Extract<AgentEvent, { type: K }>,
  "runId" | "sequence" | "timestamp" | "type"
>;

const RUN_ID = "t-run-1";
const BASE = 1_700_000_000_000;

/**
 * 拼一条事件。
 *
 * 只在测试里允许这么做：手工拼出来的日志是「被外部改过」或者「进程被杀掉」这两类
 * 输入的替身，而它们恰恰是回放最需要防的情况——真实的写入方（Runtime）造不出它们。
 */
function ev<K extends AgentEvent["type"]>(sequence: number, type: K, payload: PayloadOf<K>): AgentEvent {
  // 与 Runtime 的私有 `emit` 同一手法：基字段由这一层填，载荷由调用方给。
  return { ...payload, runId: RUN_ID, sequence, timestamp: BASE + sequence, type } as AgentEvent;
}

// ---------------------------------------------------------------------------
// 一、回放重建出的，就是实时真的存在过的那个状态
// ---------------------------------------------------------------------------

describe("回放重建出的状态，与实时状态深相等", () => {
  const shapes: ReadonlyArray<readonly [string, readonly Decision[]]> = [
    ["一趟收工", [respond("看完了")]],
    ["工具之后应答", [callTool(readFile), respond("读完了")]],
    ["两次调用", [callTool(readFile), callTool(readOther), respond("两处都看了")]],
    ["问到人（挂起）", [callTool(readFile), askHuman("要我看哪个分支？")]],
  ];

  for (const [name, script] of shapes) {
    it(`${name}：回放 === 实时循环走到的那一步`, async () => {
      const live = await liveRun(script);
      const reference = await liveLoopState(script);

      // 输入是**日志**，不是事件流：真相落在日志里，回放读的是它。
      expect(replayAgentState(live.log.read(live.runId), task)).toEqual(reference);
    });
  }

  it("取消在工具调用中途：状态停在最后一次成功的推进上", async () => {
    const controller = new AbortController();
    const aborting: Readonly<Record<string, FakeToolBehavior>> = {
      read_file: (_intent, signal) => {
        controller.abort();
        throw signal.reason;
      },
    };

    const live = await liveRun([callTool(readFile), respond("读不到就算了")], aborting, controller.signal);
    const reference = await liveLoopState([callTool(readFile), respond("读不到就算了")], aborting, controller.signal);

    // 日志停在半路，但每一轮的状态仍然是实时的——回放照抄它。
    expect(replayAgentState(live.events, task)).toEqual(reference);
    expect(runStatusOf(live.events)).toBe("cancelled");
  });

  it("Runtime 亲手交出来的终态状态，与回放重建的状态深相等", async () => {
    for (const script of [
      [respond("看完了")],
      [callTool(readFile), respond("读完了")],
    ] as const) {
      const live = await liveRun(script);
      // 这一条比上面更硬：参照物来自**同一次运行**，不是同一段脚本的另一次运行。
      expect(replayAgentState(live.events, task)).toEqual(must(live.handedOut, "Runtime 交出的终态状态"));
    }
  });

  it("有一个工具失败时也一样：终态是 partial，而状态仍然逐字段相等", async () => {
    const script = [callTool(readFile), respond("只拿到一部分")];
    const live = await liveRun(script, brokenRead("tool_failed"));

    const completed = live.events[live.events.length - 1];
    expect(completed?.type).toBe("run_completed");

    const replayed = replayAgentState(live.events, task);
    expect(replayed).toEqual(must(live.handedOut, "Runtime 交出的终态状态"));
    expect(collectMissingMaterial(replayed)).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 二、幂等：同一份日志，读多少次都一样
// ---------------------------------------------------------------------------

describe("回放是幂等的", () => {
  it("同一份事件回放两次，结果深相等", async () => {
    const live = await liveRun([callTool(readFile), respond("读完了")]);

    expect(replayAgentState(live.events, task)).toEqual(replayAgentState(live.events, task));
  });

  it("回放不修改它的输入：事件流与日志都原样留着", async () => {
    const live = await liveRun([callTool(readFile), callTool(readOther), respond("两处都看了")]);
    const before = JSON.stringify(live.events);

    replayAgentState(live.events, task);

    expect(JSON.stringify(live.events)).toBe(before);
    // 日志本身也不受影响：回放读的是快照，而日志仍然完整。
    expect(JSON.stringify(live.log.read(live.runId))).toBe(before);
  });

  it("**日志的任意前缀都是一个合法的恢复点**：每一个前缀都读得出一个自洽的状态", async () => {
    const live = await liveRun([callTool(readFile), callTool(readOther), respond("两处都看了")]);

    for (let length = 0; length <= live.events.length; length += 1) {
      const prefix = live.events.slice(0, length);
      const state = replayAgentState(prefix, task);

      const observations = prefix.filter((event) => event.type === "observation_added").length;
      const terminals = prefix.filter(
        (event) =>
          event.type === "decision_made" && event.decision.kind !== "call_tool",
      ).length;

      // 这些等式不是「另一种实现」：它们说的是状态的形状由什么决定——
      // 状态每推进一次恰好来自一个终态决策或一条观测（步 3 的 reduce 的定义）。
      expect(state.iteration, `前缀长度 ${length} 的轮数`).toBe(observations + terminals);
      expect(state.transcript.length, `前缀长度 ${length} 的 transcript`).toBe(
        state.iteration + observations,
      );
      expect(observationsOf(state)).toHaveLength(observations);
    }
  });

  it("回放一个空日志：得到一次全新 Run 的起点（登记了但还没跑的 Run）", () => {
    expect(replayAgentState([], task)).toEqual(emptyStateFor(task));
    expect(runStatusOf([])).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// 三、输入不变量：不完整或矛盾的日志被拒绝，而不是被猜
// ---------------------------------------------------------------------------

describe("回放的输入必须是一条完整的日志", () => {
  // 步 9：这条检查被提出来成了 `assertContiguousPrefix`，因为 trace 也要用同一把尺
  // （`src/runtime/trace.ts` 读的是事实，但读之前同样得确认拿到的是一条从头开始的流）。
  // 顺带把消息写清楚了一点：它现在报出**实际看到的 sequence**，而不只是说"不对"。
  it("从中间截一段出来（第一条不是 sequence 0）被拒绝", async () => {
    const live = await liveRun([callTool(readFile), respond("读完了")]);
    const tail = live.events.slice(1);

    expect(() => replayAgentState(tail, task)).toThrow(/从头开始的连续前缀/);
  });

  it("有洞的事件流被拒绝", async () => {
    const live = await liveRun([callTool(readFile), respond("读完了")]);
    const withHole = [must(live.events[0], "0"), must(live.events[2], "2")];

    expect(() => replayAgentState(withHole, task)).toThrow(/有洞、有重复|连续前缀/);
  });

  it("run_started 不在第一条被拒绝", async () => {
    const log = [ev(0, "model_requested", { model: "m" }), ev(1, "run_started", {})];

    expect(() => replayAgentState(log, task)).toThrow(/run_started 只能出现在第 1 条/);
  });

  it("两个终态事件被拒绝：一次 Run 只能结束一次", async () => {
    const log = [
      ev(0, "run_started", {}),
      ev(1, "run_cancelled", {}),
      ev(2, "run_failed", { error: { code: "runtime_error", message: "又结束了一次" } }),
    ];

    expect(() => replayAgentState(log, task)).toThrow(/两个终态事件/);
  });

  it("终态之后还在推进状态的事件被拒绝", async () => {
    const log = [
      ev(0, "run_started", {}),
      ev(1, "run_completed", {
        status: "complete",
        result: { summary: "完了", claims: [] },
        missingMaterial: [],
      }),
      ev(2, "decision_made", { decision: respond("又说了一句") }),
    ];

    expect(() => replayAgentState(log, task)).toThrow(/还在推进状态/);
  });

  it("观测找不到对应的意图时被拒绝", async () => {
    const log = [
      ev(0, "run_started", {}),
      ev(1, "observation_added", {
        name: "read_file",
        observation: {
          tool: "read_file",
          value: "凭空来的一条观测",
          error: null,
          truncated: false,
          provenance: { source: "read_file", at: BASE },
        },
      }),
    ];

    expect(() => replayAgentState(log, task)).toThrow(/没有对应的意图/);
  });

  it("两次调用同时在途被拒绝：上一条意图还没有观测", async () => {
    const log = [
      ev(0, "run_started", {}),
      ev(1, "decision_made", { decision: callTool(readFile) }),
      ev(2, "decision_made", { decision: callTool(readOther) }),
    ];

    expect(() => replayAgentState(log, task)).toThrow(/还没有观测/);
  });
});

// ---------------------------------------------------------------------------
// 四、重建不了的事件：响亮地拒绝，而不是猜
// ---------------------------------------------------------------------------

describe("回放拒绝它重建不了的事件", () => {
  const hungRun = [
    ev(0, "run_started", {}),
    ev(1, "model_requested", { model: "fake-model" }),
    ev(2, "decision_made", { decision: askHuman("要我看哪个分支？") }),
    ev(3, "human_input_requested", { question: "要我看哪个分支？" }),
    ev(4, "human_input_received", { input: "看 main" }),
  ];

  it("human_input_received：把人的回答写进状态的那一步还不存在，所以拒绝而不是跳过", () => {
    expect(() => replayAgentState(hungRun, task)).toThrow(/reduce 只接受决策/);
    expect(() => replayAgentState(hungRun, task)).toThrow(/role: "human"/);
  });

  it("run_resumed 同样被拒绝", () => {
    const log = [...hungRun.slice(0, 4), ev(4, "run_resumed", {})];

    expect(() => replayAgentState(log, task)).toThrow(/重建不了 run_resumed/);
  });

  it("但「这个 Run 停在哪儿」答得出来：两个问题，两种严格程度", () => {
    // 状态重建需要「人那一步怎么进 transcript」的语义；「停在哪儿」只需要看终态事件。
    // 这个不对称是刻意的，两边都知道自己要什么。
    expect(runStatusOf(hungRun)).toBe("awaiting_human");
  });
});

// ---------------------------------------------------------------------------
// 五、一个被证伪的预测（如实记录）
// ---------------------------------------------------------------------------

describe("步 6 留下的那条预测，被这一步证伪了", () => {
  it("回放一个停在「意图已下、观测未回」的前缀：状态里没有那条意图", async () => {
    const live = await liveRun([callTool(readFile), respond("读完了")]);
    const started = live.events.findIndex((event) => event.type === "tool_started");
    const prefix = live.events.slice(0, started + 1);

    const state = replayAgentState(prefix, task);

    // 步 6 的 `collectMissingMaterial` 留下过一条预测：「有 call_tool 的意图、后面没有
    // 对应的观测」这条来源今天够不着，但**回放从任意前缀重建状态时会走到它**。
    // 实际不是：回放照抄实时语义（`reduce` 只在观测到位时被调用一次），
    // 所以 transcript 里永远不会出现「assistant 的 call_tool 没有配对消息」这个形状。
    // 于是那条来源仍然只能靠手工构造状态到达（步 6 的单元测试就是这么做的）。
    expect(state.transcript).toEqual([]);
    expect(collectMissingMaterial(state)).toEqual([]);

    // 要丢掉的东西没有丢：那条在途的调用在**日志**里看得见。
    // 缺的是状态的投影，不是证据——这也是为什么这一步不急着补一个「猜测式」的重建。
    expect(prefix.map((event) => event.type)).toEqual([
      "run_started",
      "model_requested",
      "decision_made",
      "tool_started",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 六、这个 Run 停在哪儿
// ---------------------------------------------------------------------------

describe("runStatusOf：从事件得出这个 Run 的位置", () => {
  const cases: ReadonlyArray<readonly [string, readonly AgentEvent[], ReturnType<typeof runStatusOf>]> = [
    ["没有事件 = 登记了还没跑", [], "queued"],
    ["刚起步", [ev(0, "run_started", {})], "running"],
    ["问着人", [ev(0, "run_started", {}), ev(1, "human_input_requested", { question: "?" })], "awaiting_human"],
    [
      "干完了",
      [
        ev(0, "run_started", {}),
        ev(1, "run_completed", {
          status: "partial",
          result: { summary: "只拿到一部分", claims: [] },
          missingMaterial: ["read_file：调用没有回来"],
        }),
      ],
      "completed",
    ],
    ["失败了", [ev(0, "run_started", {}), ev(1, "run_failed", { error: { code: "no_progress", message: "空转" } })], "failed"],
    ["被取消了", [ev(0, "run_started", {}), ev(1, "run_cancelled", {})], "cancelled"],
  ];

  for (const [name, events, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(runStatusOf(events)).toBe(expected);
    });
  }

  it("收工之后跟一条账目（usage_reported），状态仍然是 completed", () => {
    const log = [
      ev(0, "run_started", {}),
      ev(1, "run_completed", { status: "complete", result: { summary: "完了", claims: [] }, missingMaterial: [] }),
      ev(2, "usage_reported", {
        usage: { inputTokens: null, outputTokens: null, toolCalls: 0, durationMs: 12, model: null },
      }),
    ];

    // 账目不是状态：它跟在终态后面，不改变这个 Run 停在哪里。
    expect(runStatusOf(log)).toBe("completed");
    expect(replayAgentState(log, task).iteration).toBe(0);
  });

  it("终态之外都算「还没走完」", () => {
    expect(isRunOver("completed")).toBe(true);
    expect(isRunOver("failed")).toBe(true);
    expect(isRunOver("cancelled")).toBe(true);
    expect(isRunOver("awaiting_human")).toBe(false);
    expect(isRunOver("running")).toBe(false);
    expect(isRunOver("queued")).toBe(false);
  });
});
