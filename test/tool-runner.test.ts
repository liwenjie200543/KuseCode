import { describe, expect, it } from "vitest";

// 步 6 的命题：**工具的输出是不可信输入；一次工具失败不会污染状态，也不会结束 Run。**
//
// 这份测试的断言分两类，两类都不可替代：
//
//   - 观测长什么样（`Observation` 的五个字段、错误码、`truncated`）；
//   - 以及**端口有没有被碰到**：被拒绝的调用一次都不该到达执行层。
//
// 第二类不能省。只看观测，一个「先调用再说不合法」的执行层看起来完全正确——
// 但那次调用已经产生了副作用，而事件流里看不出区别。计数由假端口提供，是唯一的独立证人。
import { reduce } from "../src/core/loop.js";
import type {
  AgentEvent,
  AgentState,
  Decision,
  ModelPort,
  Observation,
  Task,
  ToolError,
  ToolIntent,
  ToolOutcome,
} from "../src/core/types.js";
import { scriptedModel } from "../src/testing/fake-model.js";
import type { FakeModel } from "../src/testing/fake-model.js";
import { fakeClock, fakeTools, forgingProvenance } from "../src/testing/fake-tools.js";
import type { FakeToolBehavior, FakeTools } from "../src/testing/fake-tools.js";
import { inFlight, manualTimeouts } from "../src/testing/fake-signals.js";
import type { ManualTimeouts } from "../src/testing/fake-signals.js";
import { DEFAULT_BUDGET } from "../src/runtime/budget.js";
import { sequentialIds } from "../src/runtime/ids.js";
import { memoryRunLog } from "../src/runtime/run-log.js";
import type { RunLog } from "../src/runtime/run-log.js";
import { createRuntime } from "../src/runtime/run-agent.js";
import {
  CALL_TIMEOUT_MS,
  OBSERVATION_CHAR_LIMIT,
  collectMissingMaterial,
  createToolRunner,
} from "../src/runtime/tool-runner.js";
import type { ToolRunner } from "../src/runtime/tool-runner.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-6",
  goal: "这条材料是从哪来的？",
  repoRoot: "/repo",
  checks: ["每条论断都能追到证据吗"],
};

const readFile: ToolIntent = { name: "read_file", args: { path: "src/runtime/tool-runner.ts" } };
const ghost: ToolIntent = { name: "delete_everything", args: {} };
const callTool = (intent: ToolIntent): Decision => ({ kind: "call_tool", intent });
const respond = (summary: string): Decision => ({ kind: "respond", report: { summary, claims: [] } });

/** 一次正常的读取。它是绝大多数用例的基线。 */
const goodRead: FakeToolBehavior = { value: "执行层：allowlist、参数、超时、截断", error: null };

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

/** 事件流里唯一一条观测。取不到就直接失败，而不是让断言在 undefined 上悄悄通过。 */
function observationOf(events: readonly AgentEvent[]): Observation {
  return must(only(events, "observation_added")[0], "observation_added").observation;
}

/** 终态事件里的 `missingMaterial`。 */
function missingOf(events: readonly AgentEvent[]): readonly string[] {
  return must(only(events, "run_completed")[0], "run_completed").missingMaterial;
}

function statusOf(events: readonly AgentEvent[]): "complete" | "partial" {
  return must(only(events, "run_completed")[0], "run_completed").status;
}

interface HarnessOptions {
  readonly behaviors?: Readonly<Record<string, FakeToolBehavior>>;
  readonly model?: ModelPort;
  readonly timeouts?: ManualTimeouts;
  readonly log?: RunLog;
}

interface Harness {
  readonly tools: FakeTools;
  readonly runner: ToolRunner;
  readonly model: FakeModel;
  readonly timeouts: ManualTimeouts;
  readonly log: RunLog;
  readonly run: (signal?: AbortSignal) => Promise<readonly AgentEvent[]>;
}

/**
 * 夹一个**接好线的** Run：执行层的两半都来自同一个 `runner`，
 * 走的是 `toolDeps()`——也就是生产代码要走的那个形状。
 *
 * 墙钟预算在这里关掉（`Infinity`），理由与步 5 的夹具一样：确定性。
 * 另外它还有一个副作用是用得上的——关掉之后，`manualTimeouts` 里出现的
 * 计时器只可能来自**单次调用**，于是「超时是按谁设的」这件事没有歧义。
 */
function harness(options: HarnessOptions = {}): Harness {
  const tools = fakeTools(options.behaviors ?? { read_file: goodRead });
  const timeouts = options.timeouts ?? manualTimeouts();
  const log = options.log ?? memoryRunLog();
  const model = (options.model ?? scriptedModel([respond("不看了")])) as FakeModel;

  const runner = createToolRunner({
    tools,
    clock: fakeClock(),
    timeoutSignal: timeouts.timeouts,
  });

  const runtime = createRuntime({
    ...runner.toolDeps(),
    model,
    log,
    ids: sequentialIds("t"),
    clock: fakeClock(),
    modelName: "fake-model",
    budget: { ...DEFAULT_BUDGET, timeoutMs: Number.POSITIVE_INFINITY },
  });

  const run = async (signal?: AbortSignal): Promise<readonly AgentEvent[]> => {
    const events: AgentEvent[] = [];
    const stream = signal === undefined ? runtime.run(task) : runtime.run(task, signal);
    for await (const event of stream) events.push(event);
    return events;
  };

  return { tools, runner, model, timeouts, log, run };
}

// ---------------------------------------------------------------------------
// 一、名字与参数：被拒绝的调用一次都不会到达执行层
// ---------------------------------------------------------------------------

describe("关卡一：名字与参数，拒绝发生在调用之前", () => {
  it("allowlist 之外的名字被拒：端口一次都没被碰到，Run 继续并报告缺失", async () => {
    const h = harness({
      model: scriptedModel([callTool(ghost), respond("删不掉就算了")]),
    });
    const events = await h.run();

    const observation = observationOf(events);
    expect(observation.error?.code).toBe("invalid_tool");
    expect(observation.error?.message).toContain("delete_everything");
    expect(observation.error?.message).toContain("read_file");

    // 独立证人：`calls` 是意图到达端口的次数。执行层在它前面就拦住了。
    expect(h.tools.calls).toHaveLength(0);
    expect(h.tools.executed).toHaveLength(0);

    // 一次工具失败不结束 Run：模型被接着问，终态是诚实的 partial。
    expect(h.model.calls).toBe(2);
    expect(typesOf(events).at(-1)).toBe("run_completed");
    expect(statusOf(events)).toBe("partial");
    expect(missingOf(events).join("\n")).toContain("delete_everything");
  });

  it("参数不是对象 → invalid_args，端口一次都没被碰到", async () => {
    const h = harness({
      model: scriptedModel([
        callTool({ name: "read_file", args: [] as unknown as Record<string, unknown> }),
        respond("算了"),
      ]),
    });
    const events = await h.run();

    expect(observationOf(events).error?.code).toBe("invalid_args");
    expect(observationOf(events).error?.message).toContain("数组");
    expect(h.tools.calls).toHaveLength(0);
  });

  it("参数里含 JSON 会静默丢掉的东西 → 拒绝，且消息点得出是哪一条路径", async () => {
    // `JSON.stringify` 会把 `lines: [1, undefined]` 悄悄变成 `[1, null]`。
    // 静默变形比报错糟得多：它让一条被改过的参数看起来像是模型本来就这么说的。
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ path: "a.ts", lines: [1, undefined] }, "args.lines[1] 是 undefined"],
      [{ path: () => "a.ts" }, "args.path 是 function"],
      [{ path: "a.ts", retries: Number.NaN }, "args.retries 是 NaN"],
    ];

    for (const [args, expected] of cases) {
      const h = harness({ model: scriptedModel([callTool({ name: "read_file", args }), respond("算")]) });
      const events = await h.run();

      expect(observationOf(events).error?.code, expected).toBe("invalid_args");
      expect(observationOf(events).error?.message, expected).toContain(expected);
      expect(h.tools.calls, expected).toHaveLength(0);
    }
  });

  it("参数是循环引用 → 拒绝，而不是让序列化在写日志那一刻爆掉", async () => {
    const circular: Record<string, unknown> = { path: "a.ts" };
    circular["self"] = circular;

    const h = harness({
      model: scriptedModel([callTool({ name: "read_file", args: circular }), respond("算")]),
    });
    const events = await h.run();

    expect(observationOf(events).error?.code).toBe("invalid_args");
    expect(observationOf(events).error?.message).toContain("循环引用");
  });

  it("合法的嵌套参数照常通过（守卫不能把健康调用一起干掉）", async () => {
    const h = harness({
      model: scriptedModel([
        callTool({ name: "read_file", args: { path: "a.ts", lines: [1, 2] } }),
        respond("读到了"),
      ]),
    });
    const events = await h.run();

    expect(h.tools.executed).toHaveLength(1);
    expect(observationOf(events).error).toBeNull();
    expect(statusOf(events)).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// 二、返回值也不可信：失败的调用是一条数据，不是一次崩溃
// ---------------------------------------------------------------------------

describe("关卡二：返回值，失败的调用变成一条数据", () => {
  it("工具返回了 JSON 表示不了的值（Map 会静默变成 {}）→ invalid_result，Run 继续", async () => {
    const h = harness({
      behaviors: { read_file: { value: new Map([["path", "a.ts"]]), error: null } },
      model: scriptedModel([callTool(readFile), respond("拿到的形状不对")]),
    });
    const events = await h.run();

    const observation = observationOf(events);
    expect(observation.error?.code).toBe("invalid_result");
    expect(observation.error?.message).toContain("value");
    // 被拒的值不进状态：观测里的 value 是 null，不是那个 Map。
    expect(observation.value).toBeNull();

    expect(typesOf(events).at(-1)).toBe("run_completed");
    expect(statusOf(events)).toBe("partial");
  });

  it("工具抛异常 → tool_failed 观测，Run 照样走完（失败被隔离）", async () => {
    const h = harness({
      behaviors: {
        read_file: () => {
          throw new Error("ENOENT: 没有这个文件");
        },
      },
      model: scriptedModel([callTool(readFile), respond("读不到就直说")]),
    });
    const events = await h.run();

    const observation = observationOf(events);
    expect(observation.error?.code).toBe("tool_failed");
    expect(observation.error?.message).toContain("ENOENT");
    // 关键：没有 run_failed。一次工具失败不是一次 Run 失败。
    expect(only(events, "run_failed")).toHaveLength(0);
    expect(only(events, "run_completed")).toHaveLength(1);
    expect(statusOf(events)).toBe("partial");
    // 终态报告还是原样透传——模型自己说的话没有被执行层改写。
    expect(must(only(events, "run_completed")[0], "run_completed").result.summary).toBe("读不到就直说");
  });

  it("执行层交回的不是一个 ToolOutcome → tool_failed（签名拦不住运行时）", async () => {
    const h = harness({
      behaviors: { read_file: (() => undefined) as unknown as FakeToolBehavior },
      model: scriptedModel([callTool(readFile), respond("算")]),
    });
    const events = await h.run();

    expect(observationOf(events).error?.code).toBe("tool_failed");
    expect(observationOf(events).error?.message).toContain("不是一个 ToolOutcome");
  });

  it("错误字段形状不对（字符串而不是 {code, message}）→ tool_failed", async () => {
    const h = harness({
      behaviors: {
        read_file: (() => ({ value: null, error: "boom" })) as unknown as FakeToolBehavior,
      },
      model: scriptedModel([callTool(readFile), respond("算")]),
    });
    const events = await h.run();

    expect(observationOf(events).error?.code).toBe("tool_failed");
    expect(observationOf(events).error?.message).toContain("{ code, message }");
  });
});

// ---------------------------------------------------------------------------
// 三、单次调用超时 vs 整次 Run 被停：两个码，两种后果
// ---------------------------------------------------------------------------

describe("关卡三：单次调用的超时是可隔离的，Run 被停不是", () => {
  it("单次调用超时 → 观测是 timeout、Run 继续；这不是 budget_timeout", async () => {
    const timeouts = manualTimeouts();
    const h = harness({
      timeouts,
      behaviors: {
        read_file: (_intent, signal) => {
          timeouts.fire(); // 调用刚进去，这一次调用的计时器就到点了
          return inFlight<ToolOutcome>(signal); // 像真实适配器一样，被信号打断
        },
      },
      model: scriptedModel([callTool(readFile), respond("这条材料没拿到")]),
    });
    const events = await h.run();

    // 计时器是**按单次调用的上限**设的，不是别的数字。
    expect(timeouts.requested).toEqual([CALL_TIMEOUT_MS]);
    expect(observationOf(events).error?.code).toBe("timeout");
    // 两个码的区别就在这里：Run 级的墙钟会 `run_failed{budget_timeout}`，
    // 而单次调用的超时只是少了一条材料——Run 活着走到终态。
    expect(only(events, "run_failed")).toHaveLength(0);
    expect(typesOf(events).at(-1)).toBe("run_completed");
    expect(statusOf(events)).toBe("partial");
    // 调用确实开跑过（不是被拦在门外）：它在端口上留下了痕迹。
    expect(h.tools.executed).toHaveLength(1);
  });

  it("Run 被取消时，在途的工具调用不会变成 timeout 观测——那是停止，不是工具失败", async () => {
    const controller = new AbortController();
    const h = harness({
      behaviors: {
        read_file: (_intent, signal) => {
          controller.abort(); // 人按了停，而调用正在途
          return inFlight<ToolOutcome>(signal);
        },
      },
      model: scriptedModel([callTool(readFile), respond("不会被问到")]),
    });
    const events = await h.run(controller.signal);

    expect(typesOf(events)).toEqual([
      "run_started",
      "model_requested",
      "decision_made",
      "tool_started",
      "run_cancelled",
    ]);
    // 没有观测、没有 tool_completed，也没有一条把责任推给工具的 timeout。
    // 归因的判据是**我们自己那条信号**，不是抛出物长什么样（步 5）——
    // 执行层只是把这条规则在更靠内的位置又用了一次。
    expect(only(events, "observation_added")).toHaveLength(0);
    expect(only(events, "tool_completed")).toHaveLength(0);
    expect(only(events, "run_failed")).toHaveLength(0);
  });

  it("调用发起之前就已经中止：执行层直接拒绝，一次都不往下走", async () => {
    // 这条路径从驱动走不到（守卫在更前面就拦住了），所以直接对执行层断言。
    const controller = new AbortController();
    controller.abort("人按了停");
    const h = harness({});

    await expect(h.runner.tools.execute(readFile, controller.signal)).rejects.toBe("人按了停");
    expect(h.tools.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 四、截断：可见，且原文进不了日志
// ---------------------------------------------------------------------------

describe("截断：可见，而且原文不会进状态", () => {
  /** 尾部有一个独有的标记，用来证明原文真的没进日志。 */
  const TAIL = "尾部标记不该出现在任何地方";
  const longResult = Array.from({ length: 400 }, (_, index) => `第 ${index} 行：${"填".repeat(40)}`).concat(
    TAIL,
  );

  it("超长结果被截断：value 变成预览、truncated 为真、原文的尾部不在日志里", async () => {
    const h = harness({
      behaviors: { read_file: { value: longResult, error: null } },
      model: scriptedModel([callTool(readFile), respond("只看了一部分")]),
    });
    const events = await h.run();

    const observation = observationOf(events);
    expect(observation.truncated).toBe(true);
    // 截断是**替换**不是省略：类型从数组变成了文本预览。这不是损失，是事实——
    // 砍掉一半的 JSON 已经不是一个数组了。
    expect(typeof observation.value).toBe("string");
    expect((observation.value as string).length).toBe(OBSERVATION_CHAR_LIMIT);

    // 日志是唯一真相，而它的每一条都在上限之内：整份日志里找不到原文的尾部。
    const log = h.log.read(must(events[0], "首个事件").runId);
    expect(JSON.stringify(log)).not.toContain(TAIL);
    expect(h.tools.executed).toHaveLength(1);

    // 截断也被点名：终态是 partial，清单里说得出是哪一条材料只拿到了一部分。
    expect(statusOf(events)).toBe("partial");
    expect(missingOf(events).join("\n")).toContain("结果被截断");
  });

  it("短结果不截断：这个标记是算出来的，不是随手置上的", async () => {
    const h = harness({ model: scriptedModel([callTool(readFile), respond("看完了")]) });
    const events = await h.run();

    expect(observationOf(events).truncated).toBe(false);
    expect(statusOf(events)).toBe("complete");
    expect(missingOf(events)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 五、provenance：只能由我们写
// ---------------------------------------------------------------------------

describe("provenance：工具填不了，也伪造不了", () => {
  it("工具试图注入 provenance 与 truncated：无效，观测里是我们写的那一份", async () => {
    // 用一个从固定起点走的确定性时钟，好把 `at` 钉死——它同时证明了这个字段
    // 来自**注入的**时钟，而不是某处偷偷读的 `Date.now()`。
    const clock = fakeClock(1_700_000_000_000, 1);
    const tools = fakeTools({ read_file: () => forgingProvenance("文件内容") });
    const runner = createToolRunner({ tools, clock });
    const model = scriptedModel([callTool(readFile), respond("看完了")]);
    const log = memoryRunLog();
    const runtime = createRuntime({
      ...runner.toolDeps(),
      model,
      log,
      ids: sequentialIds("p"),
      clock: fakeClock(),
      budget: { ...DEFAULT_BUDGET, timeoutMs: Number.POSITIVE_INFINITY },
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run(task)) events.push(event);

    const observation = observationOf(events);
    expect(observation.provenance).toEqual({ source: "read_file", at: 1_700_000_000_000 });
    // 伪造的 `truncated: true` 也没有活下来：截断是**算**出来的（这一步没超长）。
    expect(observation.truncated).toBe(false);
    // 结构上的证明：观测**恰好**是这五个键。工具多塞的键一个都没进来。
    expect(Object.keys(observation).sort()).toEqual([
      "error",
      "provenance",
      "tool",
      "truncated",
      "value",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 六、缺了什么材料：同一份判断的读侧
// ---------------------------------------------------------------------------

describe("missingMaterial：三条来源，且读侧与写侧用同一套判断", () => {
  const obs = (fields: {
    readonly tool?: string;
    readonly error?: ToolError | null;
    readonly truncated?: boolean;
  }): Observation => ({
    tool: fields.tool ?? "read_file",
    value: "内容",
    error: fields.error ?? null,
    truncated: fields.truncated ?? false,
    provenance: { source: fields.tool ?? "read_file", at: 1 },
  });

  it("三种缺失都算，重复只记一次，正常的观测不进清单", () => {
    // 状态由 `reduce` 推进——与实时执行、回放走的是同一个函数（步 3）。
    let state: AgentState = { task, transcript: [], iteration: 0, pendingQuestion: null };

    const failed: ToolError = { code: "tool_failed", message: "ENOENT" };
    state = reduce(state, callTool(readFile), obs({ error: failed }));
    state = reduce(state, callTool(readFile), obs({ error: failed })); // 同一份材料，第二次
    state = reduce(state, callTool({ name: "grep", args: { pattern: "x" } }), obs({ tool: "grep", truncated: true }));
    state = reduce(state, callTool({ name: "list_dir", args: { path: "." } })); // 有意图、无观测
    state = reduce(state, callTool({ name: "read_file", args: { path: "ok.ts" } }), obs({}));

    const missing = collectMissingMaterial(state);
    expect(missing).toHaveLength(3);
    expect(missing.join("\n")).toContain("tool_failed");
    expect(missing.join("\n")).toContain("grep");
    expect(missing.join("\n")).toContain("调用没有回来");
    // 读成功的那条不出现，重复的那条只出现一次。
    expect(missing.join("\n")).not.toContain("ok.ts");
    expect(missing.filter((entry) => entry.includes("read_file"))).toHaveLength(1);
  });

  it("一次都没出错 → 清单是空的，终态是 complete", async () => {
    const h = harness({
      model: scriptedModel([callTool(readFile), callTool(readFile), respond("两处都看了")]),
    });
    const events = await h.run();

    expect(missingOf(events)).toEqual([]);
    expect(statusOf(events)).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// 七、接线：三件一起交付，少一件都是编译不过
// ---------------------------------------------------------------------------

describe("接线：这一层的三个出口必须一起来", () => {
  it("toolDeps() 交出全部三个字段，且与单独取出的两半是同一个对象", () => {
    // 第一个版本只交出了写侧的两半，于是 `collectMissingMaterial` 退回了 Runtime 的
    // 默认实现 `() => []`——一次带 `tool_failed` 观测的 Run 被报成 `complete`。
    // 那是被测试抓到的（`expected 'complete' to be 'partial'`），修法不是「记得传」，
    // 而是让漏掉它编译不过（`Required<Pick<RunAgentOptions, …>>`，见 docs/06 第二节末尾）。
    const h = harness({});
    const deps = h.runner.toolDeps();

    expect(deps.tools).toBe(h.runner.tools);
    expect(deps.assembleObservation).toBe(h.runner.assembleObservation);
    expect(Object.keys(deps).sort()).toEqual([
      "assembleObservation",
      "collectMissingMaterial",
      "tools",
    ]);
  });
});
