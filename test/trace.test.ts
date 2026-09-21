import { describe, expect, it } from "vitest";

// 步 9 的命题之一：**一份日志要能回答「干了什么、为什么停、花了多少」**。
//
// 它是 `RunTrace` 的证据，所以与 `replay-idempotence.test.ts` 用同一条纪律：
// 主要的断言都对着**一次真跑完的运行**（生产执行层 + 真 Runtime），而不是对着
// 手写的期望值——手写的期望值证明的只是「我记得自己写了什么」。
//
// 只有两种情形用手搭的事件：真实运行**产生不出来**的那些（两个终态事件、
// 一条找不到起点的 `tool_completed`）和"日志到此为止、Run 还在跑"（那是
// 观察者随时可能撞上的中间态，不该为了测它去暂停一个真的生成器）。
import type { AgentEvent, Decision, Report, Task, ToolIntent } from "../src/core/types.js";
import { sequentialIds } from "../src/runtime/ids.js";
import { createRuntime } from "../src/runtime/run-agent.js";
import { memoryRunLog } from "../src/runtime/run-log.js";
import { traceOf } from "../src/runtime/trace.js";
import { createToolRunner } from "../src/runtime/tool-runner.js";
import { scriptedModel } from "../src/testing/fake-model.js";
import { fakeClock, fakeTools } from "../src/testing/fake-tools.js";
import type { FakeToolBehavior } from "../src/testing/fake-tools.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-9",
  goal: "这份日志能不能说清一次 Run 干了什么、为什么停、花了多少？",
  repoRoot: "/repo",
  checks: ["trace 的三个问题都有答案"],
};

const READ = "src/core/loop.ts";
const readFile: ToolIntent = { name: "read_file", args: { path: READ } };

const callTool = (intent: ToolIntent): Decision => ({ kind: "call_tool", intent });
const respond = (summary: string, claims: Report["claims"] = []): Decision => ({
  kind: "respond",
  report: { summary, claims },
});
const askHuman = (question: string): Decision => ({ kind: "ask_human", question });

const ok = (value: unknown): FakeToolBehavior => ({ value, error: null });
const READS: Readonly<Record<string, FakeToolBehavior>> = {
  read_file: ok("export function reduce() {}\n"),
};

/** 「这里一定有东西」：把 `T | null | undefined` 收窄成 `T`，缺了就当场说清缺什么。 */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`缺少 ${what}`);
  return value;
}

/**
 * 真跑一次，把事件流留下。
 *
 * 与 `replay-idempotence.test.ts` 的同名夹具刻意重复而不是抽成共享模块：
 * 两个文件要的是同一件事的**不同侧面**（那边要终态状态，这边要事件流），
 * 而共享夹具会把两个测试的演化绑在一起——步 10 的 golden 语料要的是
 * 「每一次运行都能被独立地描述」。
 */
async function liveRun(
  script: readonly Decision[],
  behaviors: Readonly<Record<string, FakeToolBehavior>> = READS,
  signal?: AbortSignal,
): Promise<readonly AgentEvent[]> {
  const runner = createToolRunner({ tools: fakeTools(behaviors), clock: fakeClock() });
  const runtime = createRuntime({
    model: scriptedModel(script),
    ...runner.toolDeps(),
    log: memoryRunLog(),
    ids: sequentialIds("t"),
    clock: fakeClock(),
    modelName: "fake-model",
  });

  const events: AgentEvent[] = [];
  for await (const event of runtime.run(task, signal)) events.push(event);
  return events;
}

/** 手搭一条事件。`sequence` 由数组下标补齐，其余字段各测试自己给。 */
function ev<T extends AgentEvent["type"]>(
  sequence: number,
  type: T,
  payload: Omit<Extract<AgentEvent, { type: T }>, "runId" | "sequence" | "timestamp" | "type">,
): Extract<AgentEvent, { type: T }> {
  return {
    runId: "t-run-1",
    sequence,
    timestamp: 1000 + sequence,
    type,
    ...payload,
  } as Extract<AgentEvent, { type: T }>;
}

// ---------------------------------------------------------------------------
// 一、一次完整的 Run：三个问题各有答案
// ---------------------------------------------------------------------------

describe("一次跑完的 Run", () => {
  it("调用了什么：一步一次调用，参数取自它前面那条决策", async () => {
    const trace = traceOf(await liveRun([callTool(readFile), respond("读完了")]));

    expect(trace.steps).toHaveLength(1);
    const step = must(trace.steps[0], "第一步");
    expect(step.index).toBe(1);
    expect(step.round).toBe(1);
    expect(step.tool).toBe("read_file");
    // `tool_started` 事件本身**不带参数**（步 2 的词汇如此），参数只在它前面那条
    // `decision_made` 里。所以这一条断言真正检查的是那个跨事件的取法。
    expect(step.args).toEqual({ path: READ });
    expect(step.status).toBe("success");
    expect(step.errorCode).toBeNull();
    expect(step.truncated).toBe(false);
  });

  it("为什么停：completed + 材料齐", async () => {
    const trace = traceOf(await liveRun([callTool(readFile), respond("读完了")]));

    expect(trace.stop).toEqual({ kind: "completed", status: "complete", missingMaterial: [] });
    expect(trace.status).toBe("completed");
  });

  it("交付的结论就是 `run_completed` 里那一份，一个字不改", async () => {
    const report: Report = {
      summary: "找到了",
      claims: [
        {
          text: "循环把观察交给 reduce",
          evidence: [
            {
              path: READ,
              lines: [1, 2],
              excerpt: "export function reduce() {}",
              provenance: { source: "read_file", at: 42 },
            },
          ],
        },
      ],
    };
    const trace = traceOf(await liveRun([callTool(readFile), respond(report.summary, report.claims)]));

    expect(trace.report).toEqual(report);
  });

  it("花了多少：账目取自 `usage_reported`，不重算", async () => {
    const trace = traceOf(await liveRun([callTool(readFile), respond("读完了")]));

    const usage = must(trace.usage, "账目");
    expect(usage.toolCalls).toBe(1);
    // 假模型不报 token（`null` ≠ 0）。这条断言守的是"没测到不等于没花钱"。
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.model).toBe("fake-model");
  });

  it("模型名只记第一个非空的：重试会让 `model_requested` 出现两次", () => {
    const trace = traceOf([
      ev(0, "run_started", {}),
      ev(1, "model_requested", { model: "first/model" }),
      ev(2, "model_requested", { model: "first/model" }),
      ev(3, "run_failed", { error: { code: "provider_unavailable", message: "重试也没成" } }),
    ]);

    expect(trace.model).toBe("first/model");
  });

  it("一条工具都没有调用时不假装有：steps 是空数组，而不是一条空步骤", async () => {
    const trace = traceOf(await liveRun([respond("不用看代码也能答")]));

    expect(trace.steps).toEqual([]);
    expect(trace.stop.kind).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 二、其余四种收场
// ---------------------------------------------------------------------------

describe("别的收场", () => {
  // `RunTrace.status` 与 `RunTrace.stop.status` 不是一回事，这一条区别值得钉住：
  //
  // - `status`（`RunStatus`，六个值）回答**走完了没有**，它与 `SessionStore` 用的是
  //   同一个函数。所以一次"有结论但缺材料"的 Run 在这里是 `completed`——
  //   从"还要不要接着处理它"的角度看，它确实走完了。
  // - `stop.status`（`complete` / `partial`，两个值）回答**走得完不完整**。
  //
  // 把 partial 塞进 `RunStatus` 会让恢复逻辑把一个已经交付了结论的 Run 当成"没走完"
  // 重新拾起来，那是最不该发生的一类重复劳动。
  it("缺材料 → completed / partial，而且缺什么被点名", async () => {
    // 工具报错 → 观测带 `error` → 步 6 的 `missingMaterial` 记下它 → 终态是 partial。
    const trace = traceOf(
      await liveRun([callTool(readFile), respond("材料不全也先给结论")], {
        read_file: { value: null, error: { code: "tool_failed", message: "文件不存在" } },
      }),
    );

    expect(trace.status).toBe("completed");
    expect(trace.stop.kind).toBe("completed");
    const stop = must(trace.stop, "停止原因");
    if (stop.kind !== "completed") throw new Error("应该是 completed");
    expect(stop.status).toBe("partial");
    expect(stop.missingMaterial.length).toBeGreaterThan(0);
    expect(stop.missingMaterial.join(" ")).toContain("read_file");

    // 工具失败不等于这一步不存在：它仍然是 trace 里的一次调用，只是带上了码。
    const step = must(trace.steps[0], "第一步");
    expect(step.status).toBe("error");
    expect(step.errorCode).toBe("tool_failed");
  });

  it("挂起等人 → awaiting_human，且**不抛错**（这是与回放的关键差别）", async () => {
    const events = await liveRun([askHuman("要我读哪个目录？")]);
    const trace = traceOf(events);

    expect(trace.stop).toEqual({ kind: "awaiting_human", question: "要我读哪个目录？" });
    expect(trace.question).toBe("要我读哪个目录？");
    // 挂起没有终态事件，所以由 `runStatusOf` 说出它的位置——而它的位置是一个
    // 有名字的状态，不是含糊的 `running`：它在等一个只有人能给的输入。
    expect(trace.status).toBe("awaiting_human");
  });

  it("挂起时账目仍然存在：花了多少不因为没结束而变成未知", async () => {
    const trace = traceOf(await liveRun([askHuman("要我读哪个目录？")]));

    const usage = must(trace.usage, "账目");
    expect(usage.toolCalls).toBe(0);
  });

  it("失败 → failed，码与原文原样保留（概括是分析，不是这一层的事）", () => {
    // 这条用手搭的事件：让真 Runtime 失败需要注入一个会出错的模型端口，
    // 而那件事在 `runtime-budget.test.ts` 里已经被验证过了。这里要测的是
    // trace **怎么读**那条 `run_failed`，不是它怎么被生产出来。
    const trace = traceOf([
      ev(0, "run_started", {}),
      ev(1, "run_failed", { error: { code: "auth", message: "provider 说这个 key 没配" } }),
    ]);

    expect(trace.stop).toEqual({
      kind: "failed",
      code: "auth",
      message: "provider 说这个 key 没配",
    });
    expect(trace.status).toBe("failed");
  });

  it("被取消 → cancelled，退出信息不含任何码（取消不是失败）", async () => {
    const controller = new AbortController();
    controller.abort();
    const trace = traceOf(await liveRun([callTool(readFile), respond("读完了")], READS, controller.signal));

    expect(trace.stop).toEqual({ kind: "cancelled" });
    // 取消也要留下账目：那是"花了多少"这个问题的答案。
    expect(trace.usage).not.toBeNull();
  });

  it("日志到此为止 → unfinished，并说出位置；一条 `tool_started` 没有配对时是 unfinished 而不是成功", () => {
    const trace = traceOf([
      ev(0, "run_started", {}),
      ev(1, "model_requested", { model: "m" }),
      ev(2, "decision_made", { decision: callTool(readFile) }),
      ev(3, "tool_started", { toolCallId: "t-tool-1", toolName: "read_file" }),
    ]);

    expect(trace.stop).toEqual({ kind: "unfinished", status: "running" });
    const step = must(trace.steps[0], "第一步");
    // 诚实的第三种状态：不是 success（那会撒谎），也不是 error（那会嫁祸给工具）。
    expect(step.status).toBe("unfinished");
    expect(step.durationMs).toBe(0);
    expect(step.errorCode).toBeNull();
  });

  it("空日志：是一个还没开跑的 Run，不是一个错误", () => {
    const trace = traceOf([]);

    expect(trace.runId).toBe("");
    expect(trace.status).toBe("queued");
    expect(trace.startedAt).toBeNull();
    expect(trace.endedAt).toBeNull();
    expect(trace.eventCount).toBe(0);
    expect(trace.steps).toEqual([]);
    expect(trace.usage).toBeNull();
    expect(trace.report).toBeNull();
    expect(trace.stop).toEqual({ kind: "unfinished", status: "queued" });
  });
});

// ---------------------------------------------------------------------------
// 三、截断要跨事件取：它只写在 `observation_added` 上
// ---------------------------------------------------------------------------

describe("截断标记", () => {
  it("`tool_completed` 上没有 truncated，所以它只能从后面那条观测里取回来", () => {
    const observation = {
      tool: "read_file",
      value: "预览…",
      error: null,
      truncated: true,
      provenance: { source: "read_file", at: 3 },
    };
    const trace = traceOf([
      ev(0, "run_started", {}),
      ev(1, "decision_made", { decision: callTool(readFile) }),
      ev(2, "tool_started", { toolCallId: "c1", toolName: "read_file" }),
      ev(3, "tool_completed", {
        toolCallId: "c1",
        toolName: "read_file",
        status: "success",
        result: "预览…",
        error: null,
        durationMs: 7,
      }),
      ev(4, "observation_added", { name: "read_file", observation }),
      ev(5, "run_completed", { status: "partial", result: { summary: "s", claims: [] }, missingMaterial: [] }),
    ]);

    const step = must(trace.steps[0], "第一步");
    expect(step.truncated).toBe(true);
    expect(step.durationMs).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 四、矛盾的日志被拒绝，而不是被猜
// ---------------------------------------------------------------------------

describe("trace 不接受矛盾的日志", () => {
  it("两个终态事件：不在两个互相矛盾的说法里挑一个", () => {
    expect(() =>
      traceOf([
        ev(0, "run_started", {}),
        ev(1, "run_cancelled", {}),
        ev(2, "run_completed", { status: "complete", result: { summary: "s", claims: [] }, missingMaterial: [] }),
      ]),
    ).toThrow(/只能结束一次/);
  });

  it("一条 `tool_completed` 找不到它的 `tool_started`", () => {
    expect(() =>
      traceOf([
        ev(0, "run_started", {}),
        ev(1, "tool_completed", {
          toolCallId: "孤零零",
          toolName: "read_file",
          status: "success",
          result: null,
          error: null,
          durationMs: 1,
        }),
      ]),
    ).toThrow(/找不到它对应的 tool_started/);
  });

  it("与回放共用同一把尺：有洞的日志同样被拒", () => {
    expect(() =>
      traceOf([
        ev(0, "run_started", {}),
        { ...ev(1, "run_started", {}), sequence: 5 },
      ]),
    ).toThrow(/从头开始的连续前缀/);
  });
});

// ---------------------------------------------------------------------------
// 五、与回放的分工：trace 读事实，回放重建状态
// ---------------------------------------------------------------------------

describe("trace 与回放的分工", () => {
  it("回放拒绝的日志（人的回答已经进来），trace 仍然说得清发生了什么", async () => {
    const { replayAgentState } = await import("../src/runtime/replay.js");
    const events: AgentEvent[] = [
      ev(0, "run_started", {}),
      ev(1, "decision_made", { decision: askHuman("要我读哪个目录？") }),
      ev(2, "human_input_requested", { question: "要我读哪个目录？" }),
      // 回放对下面这两条抛错：怎么把人的回答写进 transcript 还没有定论。
      ev(3, "human_input_received", { input: "src/" }),
      ev(4, "run_resumed", {}),
    ];

    expect(() => replayAgentState(events, task)).toThrow();
    expect(() => traceOf(events)).not.toThrow();

    const trace = traceOf(events);
    expect(trace.question).toBe("要我读哪个目录？");
    expect(trace.eventCount).toBe(5);
  });
});
