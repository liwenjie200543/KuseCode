import { describe, expect, it } from "vitest";

// 步 5 的命题：**一次 Run 可预测地终止；取消之后不再发起任何调用。**
// 这个测试是它的证据，而它的断言分两类，两类都不可替代：
//
//   - 事件流说了什么（停在哪个事件、用哪个码、有没有第二条第终态事件）；
//   - 以及**计数**：模型被问了几次、工具真的跑到哪一步。
//
// 第二类不能省：只看事件流，一个「中止之后又偷偷发了一次调用」的 Runtime 可能
// 仍然长得对——那次调用只是没有进事件。计数由假适配器提供，是唯一的独立证人。
import { observationsOf } from "../src/core/loop.js";
import type {
  AgentEvent,
  AgentRuntime,
  Decision,
  ModelPort,
  RunBudget,
  Task,
  ToolIntent,
  ToolPort,
} from "../src/core/types.js";
import { decidingModel, scriptedModel } from "../src/testing/fake-model.js";
import type { FakeModel } from "../src/testing/fake-model.js";
import type { FakeToolBehavior } from "../src/testing/fake-tools.js";
import { fakeClock, fakeObservationAssembler, fakeTools } from "../src/testing/fake-tools.js";
import { inFlight, manualTimeouts } from "../src/testing/fake-signals.js";
import type { ManualTimeouts } from "../src/testing/fake-signals.js";
import { DEFAULT_BUDGET } from "../src/runtime/budget.js";
import type { ProgressPredicate } from "../src/runtime/budget.js";
import { sequentialIds } from "../src/runtime/ids.js";
import { memoryRunLog } from "../src/runtime/run-log.js";
import type { RunLog } from "../src/runtime/run-log.js";
import { createRuntime } from "../src/runtime/run-agent.js";
import { createRunSignal } from "../src/runtime/termination.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-5",
  goal: "这次 Run 为什么停下来？",
  repoRoot: "/repo",
  checks: ["停止原因在日志里说清楚了吗"],
};

const readFile: ToolIntent = { name: "read_file", args: { path: "src/runtime/budget.ts" } };
const callTool = (intent: ToolIntent): Decision => ({ kind: "call_tool", intent });
const respond = (summary: string): Decision => ({ kind: "respond", report: { summary, claims: [] } });

const toolBehaviors: Readonly<Record<string, FakeToolBehavior>> = {
  read_file: { value: "export function createBudgetGuard() {}", error: null },
};

/** 一个不肯自己收工的模型：脚本只剩一条时无限重复，于是只有预算或取消能停下它。 */
function keepsCallingTools(): FakeModel {
  return scriptedModel([callTool(readFile)], { repeatLast: true });
}

/**
 * 测试用的预算：**墙钟默认关掉**（`Infinity`）。
 *
 * 理由不是方便，是确定性：同一份断言不该依赖「这次跑得比 10 分钟快」。
 * 墙钟那一组自己显式打开它，并且分成两条——一条用手动计时器（确定），
 * 一条用真实定时器（证明默认工厂真的接上了）。
 */
function budget(overrides: Partial<RunBudget> = {}): RunBudget {
  return { ...DEFAULT_BUDGET, timeoutMs: Number.POSITIVE_INFINITY, ...overrides };
}

const TERMINAL_TYPES: readonly AgentEvent["type"][] = [
  "run_completed",
  "run_failed",
  "run_cancelled",
];

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`缺少 ${what}`);
  return value;
}

function only<K extends AgentEvent["type"]>(
  events: readonly AgentEvent[],
  type: K,
): Extract<AgentEvent, { type: K }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: K }> => event.type === type);
}

function typesOf(events: readonly AgentEvent[]): AgentEvent["type"][] {
  return events.map((event) => event.type);
}

/** 唯一一条失败事件的码。取不到就直接失败，而不是让断言在 `undefined` 上悄悄通过。 */
function failureCode(events: readonly AgentEvent[]): string {
  return must(only(events, "run_failed")[0], "run_failed").error.code;
}

/** 工具端口外面套一层计数器：意图到达执行层几次、真正返回结果几次。 */
interface ToolSpy extends ToolPort {
  /** 意图到达执行层的次数（守卫放行的都算）。 */
  readonly calls: readonly ToolIntent[];
  /** 真的返回了结果的次数（守卫拦下或被打断的不会出现在这里）。 */
  readonly completed: readonly ToolIntent[];
}

interface HarnessOptions {
  readonly model?: ModelPort;
  readonly tools?: ToolPort;
  readonly budget?: Partial<RunBudget>;
  readonly timeouts?: ManualTimeouts;
  readonly progress?: ProgressPredicate;
  readonly log?: RunLog;
}

interface Harness {
  readonly model: ModelPort;
  readonly tools: ToolSpy;
  readonly log: RunLog;
  readonly runtime: AgentRuntime;
  readonly run: (signal?: AbortSignal) => Promise<readonly AgentEvent[]>;
}

function harness(options: HarnessOptions = {}): Harness {
  const model = options.model ?? scriptedModel([respond("不看了")]);
  const inner = options.tools ?? fakeTools(toolBehaviors);
  const log = options.log ?? memoryRunLog();

  const calls: ToolIntent[] = [];
  const completed: ToolIntent[] = [];
  const tools: ToolSpy = {
    names: inner.names,
    async execute(intent, signal) {
      calls.push(intent);
      const outcome = await inner.execute(intent, signal);
      completed.push(intent);
      return outcome;
    },
    get calls(): readonly ToolIntent[] {
      return calls;
    },
    get completed(): readonly ToolIntent[] {
      return completed;
    },
  };

  const runtime = createRuntime({
    model,
    tools,
    assembleObservation: fakeObservationAssembler({ now: fakeClock() }),
    log,
    ids: sequentialIds("b"),
    clock: fakeClock(),
    modelName: "fake-model",
    budget: budget(options.budget ?? {}),
    ...(options.timeouts === undefined ? {} : { timeoutSignal: options.timeouts.timeouts }),
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });

  const run = async (signal?: AbortSignal): Promise<readonly AgentEvent[]> => {
    const events: AgentEvent[] = [];
    const stream = signal === undefined ? runtime.run(task) : runtime.run(task, signal);
    for await (const event of stream) events.push(event);
    return events;
  };

  return { model, tools, log, runtime, run };
}

// ---------------------------------------------------------------------------
// 一、迭代预算
// ---------------------------------------------------------------------------

describe("迭代预算：Core 一行都不知道，Runtime 每一轮之前查", () => {
  it("走满 maxIterations 就停：run_failed{budget_iterations}，恰好问了那么多次", async () => {
    const h = harness({
      model: keepsCallingTools(),
      budget: { maxIterations: 3, maxToolCalls: 100 },
    });
    const events = await h.run();

    expect(failureCode(events)).toBe("budget_iterations");
    expect((h.model as FakeModel).calls).toBe(3);
    expect(h.tools.completed).toHaveLength(3);
    // 被拒的那一轮连请求都没发出去：model_requested 的条数 == 真的发出去的请求数。
    expect(only(events, "model_requested")).toHaveLength(3);
    expect(typesOf(events).at(-1)).toBe("run_failed");
  });

  it("预算够用时不受影响：2 轮之内收工，一条失败事件都没有", async () => {
    const h = harness({
      model: scriptedModel([callTool(readFile), respond("看完了")]),
      budget: { maxIterations: 2 },
    });
    const events = await h.run();

    expect(typesOf(events).at(-1)).toBe("run_completed");
    expect(only(events, "run_failed")).toHaveLength(0);
    expect((h.model as FakeModel).calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 二、工具预算
// ---------------------------------------------------------------------------

describe("工具预算：检查在发起之前，所以超限的那次从未发生", () => {
  it("工具预算用完 → run_failed{budget_tools}，超限那次连端口都没碰到", async () => {
    const h = harness({
      model: keepsCallingTools(),
      budget: { maxIterations: 100, maxToolCalls: 2 },
    });
    const events = await h.run();

    expect(failureCode(events)).toBe("budget_tools");
    // 超限那次连端口都没碰到：`calls` 是意图到达执行层的次数，它没有第三次。
    expect(h.tools.calls).toHaveLength(2);
    expect(h.tools.completed).toHaveLength(2);
    // 事件也不说谎：被拦下的那次调用没有 `tool_started`。
    // （检查站在 `tool_started` 之前，所以日志里不会出现一条「开始了但从没开始」的记录。）
    expect(only(events, "tool_started")).toHaveLength(2);
    expect(only(events, "tool_completed")).toHaveLength(2);
    expect(must(only(events, "run_failed")[0], "run_failed").error.message).toContain("read_file");
    // 代价如实记下来：这一次 Run 多问了模型一次——不问就不知道下一个决策是不是要调工具。
    expect((h.model as FakeModel).calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 三、墙钟：budget_timeout 与适配器的 timeout 是两个码
// ---------------------------------------------------------------------------

describe("墙钟", () => {
  it("按 budget.timeoutMs 设计时器；到点 → run_failed{budget_timeout}", async () => {
    const timeouts = manualTimeouts();
    const model = decidingModel((_state, signal) => {
      timeouts.fire(); // 请求刚发出去，墙钟就到点了
      return inFlight(signal); // 像真实适配器一样，被信号打断
    });
    const h = harness({ model, timeouts, budget: { timeoutMs: 5_000 } });
    const events = await h.run();

    // 计时器是**按预算**设的，不是别处顺手来的。
    expect(timeouts.requested).toEqual([5_000]);
    expect(failureCode(events)).toBe("budget_timeout");
    expect(must(only(events, "run_failed")[0], "run_failed").error.message).toContain("5000");
    expect((h.model as FakeModel).calls).toBe(1);
    expect(h.tools.calls).toHaveLength(0);
  });

  it("默认的墙钟真的是 AbortSignal.timeout：真实定时器也会让它停", async () => {
    // 这一条用真实时间（5ms）。上一条用手动替身、确定性更好，但它证明不了
    // 「默认工厂接上了」——那需要一次真的定时器。
    const h = harness({
      model: decidingModel((_state, signal) => inFlight(signal)),
      budget: { timeoutMs: 5 },
    });
    const events = await h.run();

    expect(failureCode(events)).toBe("budget_timeout");
    expect((h.model as FakeModel).calls).toBe(1);
  });

  it("不设墙钟就干脆不建计时器（关掉一条预算是显式的）", async () => {
    const timeouts = manualTimeouts();
    const h = harness({ timeouts, budget: { maxIterations: 2 } });
    const events = await h.run();

    expect(timeouts.requested).toEqual([]);
    expect(typesOf(events).at(-1)).toBe("run_completed");
  });
});

// ---------------------------------------------------------------------------
// 四、取消：中止之后不再发起任何调用
// ---------------------------------------------------------------------------

describe("取消：中止之后不再发起任何调用", () => {
  it("模型在途时取消：在途调用被打断、走 run_cancelled、此后不再问模型", async () => {
    const controller = new AbortController();
    const model = decidingModel((_state, signal) => {
      controller.abort(); // 人按了停，而请求正在途
      return inFlight(signal);
    });
    const h = harness({ model });
    const events = await h.run(controller.signal);

    expect(typesOf(events)).toEqual(["run_started", "model_requested", "run_cancelled"]);
    expect((h.model as FakeModel).calls).toBe(1);
    expect(h.tools.calls).toHaveLength(0);
    // 恰好一条终态事件：取消不会被算成「取消 + 失败」两件事。
    expect(events.filter((event) => TERMINAL_TYPES.includes(event.type))).toHaveLength(1);
  });

  it("工具在途时取消：有 tool_started、没有 tool_completed，Run 以 run_cancelled 收尾", async () => {
    const controller = new AbortController();
    const tools: ToolPort = {
      names: ["read_file"],
      execute: (_intent, signal) => {
        controller.abort();
        return inFlight(signal);
      },
    };
    const h = harness({
      model: scriptedModel([callTool(readFile), respond("不会被问到")]),
      tools,
    });
    const events = await h.run(controller.signal);

    expect(typesOf(events)).toEqual([
      "run_started",
      "model_requested",
      "decision_made",
      "tool_started",
      "run_cancelled",
    ]);
    // 「有意图、无观测」在这一刻是真实的：意图落下了，结果永远不会回来——
    // 这正是步 3 让那一轮产出两次的意义所在。
    expect(only(events, "tool_completed")).toHaveLength(0);
    expect(only(events, "observation_added")).toHaveLength(0);
    expect((h.model as FakeModel).calls).toBe(1);
  });

  it("取消恰好落在一个 await 窗口里：最后一道检查拦住工具调用，它从未被交出去", async () => {
    // 这条钉的是最窄的那个窗口——从「意图已下、tool_started 已落」到「工具真正被调用」
    // 之间还有两次 await。取消在这里发生一次，就会有第三道闸门要处理。
    const controller = new AbortController();
    const base = memoryRunLog();
    const abortingLog: RunLog = {
      async append(event) {
        await base.append(event);
        if (event.type === "tool_started") controller.abort();
      },
      read: (runId) => base.read(runId),
    };
    const h = harness({
      model: scriptedModel([callTool(readFile), respond("不会被问到")]),
      log: abortingLog,
    });
    const events = await h.run(controller.signal);

    // 工具端口一次都没被碰到：闸门在它前面。
    expect(h.tools.calls).toHaveLength(0);
    expect(typesOf(events)).toEqual([
      "run_started",
      "model_requested",
      "decision_made",
      "tool_started",
      "run_cancelled",
    ]);
    // 日志里有一条 tool_started 而没有 tool_completed——这不是丢失，是步 4 定义的
    // 「有意图、无观测」：我们确实决定要开这一次调用，然后是取消把它拦在了门口。
  });

  it("取消不是失败：同一个脚本，端口抛错是 run_failed，被取消是 run_cancelled", async () => {
    const byThrow = harness({
      model: decidingModel(() => {
        throw new Error("provider 挂了");
      }),
    });
    const controller = new AbortController();
    const cancelled = harness({
      model: decidingModel((_state, signal) => {
        controller.abort();
        return inFlight(signal);
      }),
    });

    expect(typesOf(await byThrow.run()).at(-1)).toBe("run_failed");
    expect(typesOf(await cancelled.run(controller.signal)).at(-1)).toBe("run_cancelled");
  });
});

// ---------------------------------------------------------------------------
// 五、被遗弃的流也有终态：日志不许停在没有结尾的地方
// ---------------------------------------------------------------------------

describe("消费者离场：日志仍然收尾", () => {
  it("半路 break：日志补一条 run_cancelled，消费者看到的是它的前缀", async () => {
    const h = harness({ model: scriptedModel([callTool(readFile), respond("看完了")]) });
    const seen: AgentEvent[] = [];

    for await (const event of h.runtime.run(task)) {
      seen.push(event);
      if (event.type === "tool_completed") break;
    }

    const all = h.log.read(must(seen[0], "首个事件").runId);
    // 前缀性质没有被破坏：消费者一条不多、一条不少、顺序一致。
    expect(all.slice(0, seen.length)).toEqual(seen);
    // 多出来的两条：write-ahead 的 `observation_added`，以及最后补的终态。
    expect(all.length).toBe(seen.length + 2);
    expect(typesOf(all).at(-1)).toBe("run_cancelled");
    // 恰好一条终态事件——它补上了步 4 那个「没有名字的结局」，也没有多余地补第二条。
    expect(all.filter((event) => TERMINAL_TYPES.includes(event.type))).toHaveLength(1);
    // 工作当场停下：循环只走了一轮，没有第二种「离场之后还在继续跑」的行为。
    expect((h.model as FakeModel).calls).toBe(1);
    expect(h.tools.completed).toHaveLength(1);
  });

  it("挂起（ask_human）不算被遗弃：它的日志不该被写上一个终态事件", async () => {
    // 挂起是「还活着」（RunStatus.awaiting_human），不是「不会再做任何事」。
    // 把它写成终态，等于把一次等待答案的 Run 说成已经结束了。
    const h = harness({ model: scriptedModel([{ kind: "ask_human", question: "以哪一条为准？" }]) });
    const events = await h.run();

    expect(typesOf(events).at(-1)).toBe("human_input_requested");
    expect(events.filter((event) => TERMINAL_TYPES.includes(event.type))).toHaveLength(0);
    expect(h.log.read(must(events[0], "首个事件").runId)).toEqual(events);
  });

  it("正常收工的 Run 不会被补一条 run_cancelled", async () => {
    const h = harness({ model: scriptedModel([respond("看完了")]) });
    const events = await h.run();

    expect(typesOf(events).at(-1)).toBe("run_completed");
    expect(only(events, "run_cancelled")).toHaveLength(0);
    expect(h.log.read(must(events[0], "首个事件").runId)).toEqual(events);
  });
});

// ---------------------------------------------------------------------------
// 六、空转的执法，以及它的触发条件
// ---------------------------------------------------------------------------

/** 一个**更严**的候选谓词：这一次有没有带来「信息上」新的观测。 */
const newInformation: ProgressPredicate = (before, after) => {
  const fingerprint = (observation: { tool: string; value: unknown }): string =>
    `${observation.tool}:${JSON.stringify(observation.value)}`;
  const seen = new Set(observationsOf(before).map(fingerprint));
  return observationsOf(after).some((observation) => !seen.has(fingerprint(observation)));
};

describe("空转的执法：谓词在 Core，执法在这里", () => {
  it("默认谓词（Core 的 hasProgress）在今天的 Core 里抓不到空转——这是结构事实", async () => {
    // 模型反复读同一个文件、每次拿到一模一样的内容，Core 的谓词仍然认为每轮都前进了。
    // 原因是结构性的：一次 `call_tool` 必然往状态里写一条观测（`reduce` 干的），
    // 所以「观测数没增加」在今天不可能发生。
    //
    // 这条测试钉住的是这个事实，不是遗憾：换掉谓词等于换掉「什么叫空转」的语义，
    // 那要有真实的空转证据才动。下一节证明执法本身已经就位。
    const h = harness({
      model: keepsCallingTools(),
      budget: { maxIterations: 3, maxToolCalls: 10 },
    });
    const events = await h.run();

    expect(failureCode(events)).toBe("budget_iterations");
    expect(only(events, "observation_added")).toHaveLength(3);
  });

  it("换成更严的谓词，同一段脚本立刻被认作空转：run_failed{no_progress}，且不再有任何调用", async () => {
    const h = harness({
      model: keepsCallingTools(),
      progress: newInformation,
      budget: { maxIterations: 10, maxToolCalls: 10 },
    });
    const events = await h.run();

    expect(failureCode(events)).toBe("no_progress");
    // 第二轮读到的和第一轮一模一样，所以到**第三轮**的边界上才被认作空转：
    // 检查只能做在轮边界上——「这一轮带来了什么」要等它结束才知道。
    // 这是「动作之前检查」的另一面，不是延迟，是唯一可能的位置。
    expect((h.model as FakeModel).calls).toBe(2);
    expect(h.tools.completed).toHaveLength(2);
  });

  it("更严的谓词也有边界：结果真的变了仍然算前进（否则它就成了关掉 Agent 的开关）", async () => {
    let reads = 0;
    const changing = fakeTools({
      read_file: () => {
        reads += 1;
        return { value: `第 ${reads} 次读到的内容`, error: null };
      },
    });
    const h = harness({
      model: keepsCallingTools(),
      tools: changing,
      progress: newInformation,
      budget: { maxIterations: 3, maxToolCalls: 10 },
    });
    const events = await h.run();

    // 一路都在前进，所以停下来的原因是迭代预算，不是空转。
    // 这个方向的不对称是刻意的：漏判一次空转只是多跑几轮，误判一次会把健康的 Run 干掉。
    expect(failureCode(events)).toBe("budget_iterations");
    expect(h.tools.completed).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 七、信号本身：组合与归因
// ---------------------------------------------------------------------------

describe("createRunSignal：组合是无损的，归因是先响的那个", () => {
  it("只有外部信号时交出去的就是它本身", () => {
    const controller = new AbortController();
    const run = createRunSignal({
      external: controller.signal,
      timeoutMs: Number.POSITIVE_INFINITY,
    });

    expect(run.signal).toBe(controller.signal);
    expect(run.cause()).toBeNull();
    controller.abort();
    expect(run.signal.aborted).toBe(true);
    expect(run.cause()).toBe("external");
  });

  it("两个来源都没有时给一条永不中止的（不是 undefined）", () => {
    const run = createRunSignal({ timeoutMs: null });
    expect(run.signal).toBeInstanceOf(AbortSignal);
    expect(run.signal.aborted).toBe(false);
    expect(run.cause()).toBeNull();
  });

  it("先响的说了算：外部先响，之后墙钟再响也不改口", () => {
    const controller = new AbortController();
    const timeouts = manualTimeouts();
    const run = createRunSignal({
      external: controller.signal,
      timeoutMs: 1_000,
      timeoutSignal: timeouts.timeouts,
    });

    controller.abort();
    timeouts.fire();
    expect(run.cause()).toBe("external");
  });

  it("墙钟先响就是墙钟（它对应 budget_timeout，不是 run_cancelled）", () => {
    const controller = new AbortController();
    const timeouts = manualTimeouts();
    const run = createRunSignal({
      external: controller.signal,
      timeoutMs: 1_000,
      timeoutSignal: timeouts.timeouts,
    });

    timeouts.fire();
    expect(run.cause()).toBe("wall_clock");
    expect(run.signal.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false); // 外部那条没有被我们动过
  });

  it("创建时就已中止的外部信号立刻归因给外部", () => {
    const controller = new AbortController();
    controller.abort();
    const run = createRunSignal({ external: controller.signal });
    expect(run.cause()).toBe("external");
  });

  it("dispose 会真的摘掉监听器", () => {
    const controller = new AbortController();
    const run = createRunSignal({ external: controller.signal });

    run.dispose();
    controller.abort();
    // 摘掉之后没人再记录归因。注意信号自己仍然会中止（它是同一条对象），
    // 变的只是「我们还记不记得为什么」——这正是 dispose 的职责。
    expect(run.signal.aborted).toBe(true);
    expect(run.cause()).toBeNull();

    run.dispose(); // 幂等
  });
});
