import { describe, expect, it } from "vitest";

// 步 4 的命题：**一次 Task 就是一条有序、可回放的事件流。**
// 这个测试是它的证据，所以断言全部落在事件流上，而不是落在「内部状态对不对」上——
// 状态是被事件流重建出来的东西（步 7），事件流才是契约。
import { observationsOf } from "../src/core/loop.js";
import type {
  AgentEvent,
  AgentRuntime,
  AgentState,
  Decision,
  ModelPort,
  Task,
  ToolIntent,
  ToolPort,
} from "../src/core/types.js";
import { decidingModel, scriptedModel } from "../src/testing/fake-model.js";
import type { FakeToolBehavior } from "../src/testing/fake-tools.js";
import { fakeClock, fakeObservationAssembler, fakeTools } from "../src/testing/fake-tools.js";
import { cryptoIds, sequentialIds } from "../src/runtime/ids.js";
import type { IdFactory } from "../src/runtime/ids.js";
import { memoryRunLog } from "../src/runtime/run-log.js";
import type { RunLog } from "../src/runtime/run-log.js";
import { createRuntime, emptyStateFor, toRunError } from "../src/runtime/run-agent.js";
import type { CollectMissingMaterial } from "../src/runtime/run-agent.js";

// ---------------------------------------------------------------------------
// 夹具：一个真实的 Task、一批脚本化的决策与工具
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-4",
  goal: "这个仓库的证据链是怎么串起来的？",
  repoRoot: "/repo",
  checks: ["每条论断都能指到文件与行号吗"],
};

const readFile: ToolIntent = { name: "read_file", args: { path: "src/core/loop.ts" } };
const grep: ToolIntent = { name: "grep", args: { pattern: "reduce" } };

const callTool = (intent: ToolIntent): Decision => ({ kind: "call_tool", intent });
const respond = (summary: string): Decision => ({ kind: "respond", report: { summary, claims: [] } });
const askHuman = (question: string): Decision => ({ kind: "ask_human", question });

const toolBehaviors: Readonly<Record<string, FakeToolBehavior>> = {
  read_file: { value: "export function reduce() {}", error: null },
  grep: { value: ["loop.ts:1"], error: null },
};

const MODEL_NAME = "fake-model";

/** 终态事件：出现即意味着这次 Run 结束了（`awaiting_human` 不算结束，它是挂起）。 */
const TERMINAL_TYPES: readonly AgentEvent["type"][] = ["run_completed", "run_failed", "run_cancelled"];

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

interface Harness {
  readonly model: ReturnType<typeof scriptedModel> | ModelPort;
  readonly tools: FakeToolsHandle;
  readonly log: RunLog;
  readonly runtime: AgentRuntime;
  /** 消费整条流并收集事件——这就是「一次 Run」的样子。 */
  readonly run: (signal?: AbortSignal) => Promise<readonly AgentEvent[]>;
}

interface FakeToolsHandle extends ToolPort {
  readonly calls: readonly ToolIntent[];
  readonly executed: readonly ToolIntent[];
  readonly signals: readonly AbortSignal[];
}

interface HarnessOptions {
  readonly model?: ModelPort;
  readonly tools?: ToolPort;
  readonly log?: RunLog;
  readonly ids?: IdFactory;
  readonly clock?: () => number;
  readonly modelName?: string | null;
  readonly collectMissingMaterial?: CollectMissingMaterial;
}

function harness(
  script: readonly Decision[] = [respond("看完了")],
  behaviors: Readonly<Record<string, FakeToolBehavior>> = toolBehaviors,
  options: HarnessOptions = {},
): Harness {
  const model = options.model ?? scriptedModel(script);
  const tools = options.tools ?? fakeTools(behaviors);
  const log = options.log ?? memoryRunLog();
  const runtime = createRuntime({
    model,
    tools,
    assembleObservation: fakeObservationAssembler({ now: fakeClock() }),
    log,
    ids: options.ids ?? sequentialIds("t"),
    clock: options.clock ?? fakeClock(),
    modelName: options.modelName === undefined ? MODEL_NAME : options.modelName,
    // collectMissingMaterial 用不到时就不传：默认值是 `() => []`，
    // 恰好也是本步要断言的那一支（步 6 之前 missingMaterial 只能是空的）。
    ...(options.collectMissingMaterial === undefined
      ? {}
      : { collectMissingMaterial: options.collectMissingMaterial }),
  });

  const run = async (signal?: AbortSignal): Promise<readonly AgentEvent[]> => {
    const events: AgentEvent[] = [];
    // signal 是可选的，用 `run(task)` / `run(task, signal)` 两种调用验证两条路径。
    const stream = signal === undefined ? runtime.run(task) : runtime.run(task, signal);
    for await (const event of stream) events.push(event);
    return events;
  };

  return { model, tools: tools as FakeToolsHandle, log, runtime, run };
}

// ---------------------------------------------------------------------------
// 一、形状与顺序
// ---------------------------------------------------------------------------

describe("一条事件流的形状", () => {
  it("run_started 是第一条，sequence 从 0 起严格 +1，runId 全程一致", async () => {
    const h = harness([callTool(readFile), respond("证据齐了")]);
    const events = await h.run();

    expect(typesOf(events)[0]).toBe("run_started");
    // 步 8 之后多一条 `usage_reported`（账目排在终态之前），所以是 0..9
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // 身份来自注入的工厂，而不是随手 uuid——所以这条断言是确定的，不是「大概不重复」。
    const runIds = new Set(events.map((event) => event.runId));
    expect(runIds).toEqual(new Set(["t-run-1"]));
  });

  it("事件顺序就是因果顺序（一次工具调用）", async () => {
    const h = harness([callTool(readFile), respond("证据齐了")]);
    const events = await h.run();

    expect(typesOf(events)).toEqual([
      "run_started",
      "model_requested", // 请求真的发出之前
      "decision_made", // 意图已下
      "tool_started", // 工具真的开跑之前
      "tool_completed", // 执行结束
      "observation_added", // 结果被组装成观测、进了状态
      "model_requested", // 下一轮
      "decision_made",
      // 步 8：账目排在终态事件**之前**。它是账，不是结论——回放的状态机也把它
      // 标成"不影响状态"，所以这个顺序只关乎"先看清花了多少，再看为什么停"。
      "usage_reported",
      "run_completed",
    ]);
  });

  it("时间戳单调，来自 Runtime 注入的时钟（不是 Date.now 混进来）", async () => {
    const h = harness([callTool(readFile), respond("好了")]);
    const events = await h.run();

    const timestamps = events.map((event) => event.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(new Set(timestamps).size).toBe(timestamps.length); // 严格递增
    expect(must(timestamps[0], "run_started 的时间戳")).toBe(1_700_000_000_000);
  });

  it("decision_made 的条数等于模型被问的次数（终态决策也落一条）", async () => {
    const h = harness([callTool(readFile), callTool(grep), respond("好了")]);
    const events = await h.run();
    const model = h.model as ReturnType<typeof scriptedModel>;

    expect(only(events, "decision_made")).toHaveLength(3);
    expect(model.calls).toBe(3);
  });

  it("model_requested 在真正发起请求之前落进日志，而不是事后补记", async () => {
    const log = memoryRunLog();
    const seen: { readonly at: string[]; readonly consumerSaw: number }[] = [];
    let currentRunId: string | null = null;
    let consumerSaw = 0;

    // 模型在被问的那一刻，自己去看日志里已经有什么。这是因果证明：
    // 若 model_requested 是决策之后补记的，这里就看不到它。
    const model = decidingModel(() => {
      const at = log.read(currentRunId ?? "").map((event) => event.type);
      seen.push({ at, consumerSaw });
      return respond("看完了");
    });
    const { runtime } = harness([], toolBehaviors, { model, log });

    for await (const event of runtime.run(task)) {
      consumerSaw += 1;
      if (event.type === "run_started") currentRunId = event.runId;
    }

    // 顺序对：请求发起时日志里已经有 run_started 与 model_requested。
    // 另外，日志比消费者**跑在前面**（2 > 1）——事件先落日志、再交给消费者，
    // 所以即使消费者当场崩溃，这条记录也已经存在。
    expect(seen).toEqual([{ at: ["run_started", "model_requested"], consumerSaw: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// 二、工具：身份、配对、耗时
// ---------------------------------------------------------------------------

describe("工具调用在事件流里的样子", () => {
  it("tool_started 与 tool_completed 配对，两次调用的 id 不同且有序", async () => {
    const h = harness([callTool(readFile), callTool(grep), respond("好了")]);
    const events = await h.run();

    expect(only(events, "tool_started").map((event) => event.toolCallId)).toEqual([
      "t-tool-1",
      "t-tool-2",
    ]);
    expect(only(events, "tool_completed").map((event) => event.toolCallId)).toEqual([
      "t-tool-1",
      "t-tool-2",
    ]);
    expect(only(events, "tool_started").map((event) => event.toolName)).toEqual([
      "read_file",
      "grep",
    ]);

    // 三条流一一对应：每一次调用恰好开始一次、结束一次、产生一条观测。
    const counts = [
      only(events, "tool_started").length,
      only(events, "tool_completed").length,
      only(events, "observation_added").length,
    ];
    expect(counts).toEqual([2, 2, 2]);
  });

  it("成功的调用：status 为 success、result 是工具的原话、耗时大于零", async () => {
    const h = harness([callTool(readFile), respond("好了")]);
    const events = await h.run();
    const completed = must(only(events, "tool_completed")[0], "tool_completed");

    expect(completed.status).toBe("success");
    expect(completed.result).toBe("export function reduce() {}");
    expect(completed.error).toBeNull();
    expect(completed.durationMs).toBeGreaterThan(0);
  });

  it("observation_added 带的就是进状态的那一份（provenance 由 Runtime 补上）", async () => {
    const h = harness([callTool(readFile), respond("好了")]);
    const events = await h.run();
    const added = must(only(events, "observation_added")[0], "observation_added");

    expect(added.name).toBe("read_file");
    expect(added.observation).toEqual({
      tool: "read_file",
      value: "export function reduce() {}",
      error: null,
      // 工具只回报 { value, error }，这两个字段它填不了——组装点在这里留下了痕迹。
      truncated: false,
      provenance: { source: "read_file", at: 1_700_000_000_000 },
    });
  });

  it("工具自报失败只是一条观测：status 为 error，Run 继续走下去", async () => {
    const h = harness([callTool({ name: "rm_rf", args: {} }), respond("这条路走不通")]);
    const events = await h.run();
    const completed = must(only(events, "tool_completed")[0], "tool_completed");

    expect(completed.status).toBe("error");
    expect(completed.result).toBeNull();
    expect(completed.error?.code).toBe("invalid_tool");
    // 被拒绝的调用从未被执行，但事件流里它确实发生过。
    expect(h.tools.executed).toHaveLength(0);
    expect(typesOf(events).at(-1)).toBe("run_completed");
  });

  it("端口抛错是另一回事：它是 Runtime 的失败，落成 run_failed", async () => {
    const brokenPort: ToolPort = {
      names: ["read_file"],
      execute: async () => {
        throw new Error("工具端口违约了");
      },
    };
    const h = harness([callTool(readFile), respond("好了")], toolBehaviors, { tools: brokenPort });
    const events = await h.run();

    expect(typesOf(events)).toEqual([
      "run_started",
      "model_requested",
      "decision_made",
      "tool_started",
      "usage_reported",
      "run_failed",
    ]);
    expect(must(only(events, "run_failed")[0], "run_failed").error).toEqual({
      code: "runtime_error",
      message: "工具端口违约了",
    });
  });
});

// ---------------------------------------------------------------------------
// 三、怎么结束：三条路径，各收各的尾
// ---------------------------------------------------------------------------

describe("一次 Run 怎么结束", () => {
  it("respond → run_completed{complete}，report 就是模型给的那一份", async () => {
    const report = { summary: "证据链是 reduce 串起来的", claims: [] };
    const h = harness([{ kind: "respond", report }, respond("不会被问到")]);
    const events = await h.run();
    const completed = must(only(events, "run_completed")[0], "run_completed");

    expect(completed.status).toBe("complete");
    expect(completed.result).toEqual(report);
    // 本步 missingMaterial 只能是空的：填充语义在步 6（那里才有失败与截断的证据）。
    expect(completed.missingMaterial).toEqual([]);
    expect(typesOf(events).at(-1)).toBe("run_completed");
    // 收工之后不再问模型。
    expect((h.model as ReturnType<typeof scriptedModel>).calls).toBe(1);
  });

  it("collectMissingMaterial 非空 → partial，清单原样进事件，接缝拿到的是终态", async () => {
    const seenStates: AgentState[] = [];
    const collectMissingMaterial: CollectMissingMaterial = (state) => {
      seenStates.push(state);
      return ["src/adapter/pi/model-port.ts"];
    };
    const h = harness([callTool(readFile), respond("只找到一半")], toolBehaviors, {
      collectMissingMaterial,
    });
    const events = await h.run();
    const completed = must(only(events, "run_completed")[0], "run_completed");

    expect(completed.status).toBe("partial");
    expect(completed.missingMaterial).toEqual(["src/adapter/pi/model-port.ts"]);

    // 同一条规则决定 complete / partial，接缝看到的是 reduce 之后的终态：
    // 观测已经在里面（所以步 6 有能力从状态里算出缺了什么）。
    const finalState = must(seenStates[0], "接缝收到的状态");
    expect(finalState.iteration).toBe(2);
    expect(observationsOf(finalState)).toHaveLength(1);
  });

  it("ask_human → human_input_requested 收尾，且**没有**终态事件", async () => {
    const h = harness([askHuman("两条证据冲突时以哪一条为准？"), respond("不会被问到")]);
    const events = await h.run();

    expect(typesOf(events)).toEqual([
      "run_started",
      "model_requested",
      "decision_made",
      "usage_reported",
      "human_input_requested",
    ]);
    expect(must(only(events, "human_input_requested")[0], "human_input_requested").question).toBe(
      "两条证据冲突时以哪一条为准？",
    );
    // 问到人不是「结束」，是「挂起」：RunStatus 里 awaiting_human 不是终态，
    // 所以这条流没有终态事件。run_resumed / human_input_received 在步 5/7 接上。
    expect(events.filter((event) => TERMINAL_TYPES.includes(event.type))).toHaveLength(0);
    expect((h.model as ReturnType<typeof scriptedModel>).calls).toBe(1);
  });

  const paths: ReadonlyArray<{
    readonly name: string;
    readonly script: readonly Decision[];
    readonly model?: ModelPort;
    readonly last: AgentEvent["type"];
    readonly terminal: number;
  }> = [
    { name: "直接应答", script: [respond("好了")], last: "run_completed", terminal: 1 },
    {
      name: "一次工具后应答",
      script: [callTool(readFile), respond("好了")],
      last: "run_completed",
      terminal: 1,
    },
    { name: "问到人（挂起）", script: [askHuman("以哪一条为准？")], last: "human_input_requested", terminal: 0 },
    {
      name: "模型端口抛错",
      script: [respond("好了")],
      model: decidingModel(() => {
        throw new Error("provider 挂了");
      }),
      last: "run_failed",
      terminal: 1,
    },
  ];

  for (const path of paths) {
    it(`${path.name}：最后一个事件是 ${path.last}，终态事件 ${path.terminal} 个`, async () => {
      const h = harness(
        path.script,
        toolBehaviors,
        path.model === undefined ? {} : { model: path.model },
      );
      const events = await h.run();

      expect(typesOf(events).at(-1)).toBe(path.last);
      expect(events.filter((event) => TERMINAL_TYPES.includes(event.type))).toHaveLength(
        path.terminal,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 四、失败不是异常
// ---------------------------------------------------------------------------

describe("外部失败必须变成有类型、可见的事件", () => {
  it("端口抛错不会让流抛出去：调用方按事件判定生死", async () => {
    const h = harness([], toolBehaviors, {
      model: decidingModel(() => {
        throw new Error("provider 挂了");
      }),
    });

    // 关键的一句：不是 rejects，是 resolves。
    const events = await h.run();
    expect(typesOf(events).at(-1)).toBe("run_failed");
    expect(must(only(events, "run_failed")[0], "run_failed").error).toEqual({
      code: "runtime_error",
      message: "provider 挂了",
    });
  });

  it("带合法 code 的抛出物原样保留；不认识的一律落到 runtime_error", () => {
    expect(toRunError({ code: "rate_limited", message: "限流了" })).toEqual({
      code: "rate_limited",
      message: "限流了",
    });
    expect(toRunError({ code: "provider_exploded", message: "中转站自创的码" })).toEqual({
      code: "runtime_error",
      message: "中转站自创的码",
    });
  });

  it("抛出来的不是 Error 也能落成事件（不能被归类丢失）", async () => {
    const h = harness([], toolBehaviors, {
      model: decidingModel(() => {
        // eslint 风格的问题在这里不重要：真实 provider 什么都可能抛。
        throw "boom";
      }),
    });
    const events = await h.run();

    expect(toRunError("boom")).toEqual({ code: "runtime_error", message: "boom" });
    expect(typesOf(events).at(-1)).toBe("run_failed");
  });
});

// ---------------------------------------------------------------------------
// 五、日志：唯一真相、只追加、可整体断言
// ---------------------------------------------------------------------------

describe("事件日志", () => {
  it("消费完之后整条流仍可整体断言，read 返回的是快照", async () => {
    const h = harness([callTool(readFile), respond("好了")]);
    const events = await h.run();
    const runId = must(events[0], "首个事件").runId;

    // 「可回放」的充分性：流被消费完之后，事件一条不少、顺序不变地还在。
    expect(h.log.read(runId)).toEqual(events);
    // 而且是快照：拿它去排序、断言、交给回放，都影响不到日志本身。
    const first = h.log.read(runId);
    const second = h.log.read(runId);
    expect(first).not.toBe(second);
    expect(second).toEqual(first);
  });

  it("消费者半路 break：看到的是日志的一个前缀，日志不因它提前离场而缺事件", async () => {
    const h = harness([callTool(readFile), respond("好了")]);
    const seen: AgentEvent[] = [];

    for await (const event of h.runtime.run(task)) {
      seen.push(event);
      if (event.type === "tool_completed") break;
    }

    const all = h.log.read(must(seen[0], "首个事件").runId);
    // 前缀性质：消费者看到的永远是日志的前缀——一条不多、一条不少、顺序一致。
    expect(all.slice(0, seen.length)).toEqual(seen);
    // write-ahead：`observation_added` 已经落日志了，只是还没送到消费者手里。
    expect(typesOf(all).slice(0, 6)).toEqual([
      "run_started",
      "model_requested",
      "decision_made",
      "tool_started",
      "tool_completed",
      "observation_added",
    ]);
    // 日志的结尾不在这里断言。步 5 给了这个结局一个名字：离场之后工作当场停止，
    // 日志补一条 `run_cancelled`——证据在 test/runtime-budget.test.ts 的
    // 「消费者离场」一节，那里同时钉住了「挂起不算被遗弃」。这里只管前缀。
  });

  it("拒绝有洞或重复的写入（日志的定义是追加，不是调用方的自觉）", async () => {
    const log = memoryRunLog();
    await log.append({ runId: "r-1", sequence: 0, timestamp: 0, type: "run_started" });

    await expect(
      log.append({ runId: "r-1", sequence: 2, timestamp: 1, type: "run_cancelled" }),
    ).rejects.toThrow(/只接受追加/);
    await expect(
      log.append({ runId: "r-1", sequence: 0, timestamp: 1, type: "run_cancelled" }),
    ).rejects.toThrow(/只接受追加/);
    // 被拒绝的写入没有污染日志。
    expect(log.read("r-1")).toHaveLength(1);
  });

  it("日志坏了就把异常抛出去：不把一次失败的 Run 伪装成正常收场", async () => {
    const brokenLog: RunLog = {
      append: async () => {
        throw new Error("磁盘满了");
      },
      read: () => [],
    };
    const h = harness([respond("好了")], toolBehaviors, { log: brokenLog });

    // 连 run_failed 都写不下去的时候，异常必须逃出去。
    // 悄悄吞掉比崩溃更糟：那会让一次失败的 Run 看起来像一次正常结束的 Run。
    await expect(h.run()).rejects.toThrow("磁盘满了");
  });

  it("两个 Run 不共享事件、不共享身份，各自的 sequence 都从 0 起", async () => {
    const log = memoryRunLog();
    const h = harness([], toolBehaviors, {
      log,
      model: decidingModel(() => respond("好了")),
    });

    const first = await h.run();
    const second = await h.run();
    const firstId = must(first[0], "首个事件").runId;
    const secondId = must(second[0], "首个事件").runId;

    expect(firstId).toBe("t-run-1");
    expect(secondId).toBe("t-run-2");
    expect(secondId).not.toBe(firstId);
    // 两个 Run 的账本各自从 0 起（步 8：各 5 条事件——多出来的那条是各自独立报的账）。
    expect(log.read(firstId).map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(log.read(secondId).map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(log.read(firstId).every((event) => event.runId === firstId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 六、身份与信号：两条接缝
// ---------------------------------------------------------------------------

describe("身份是一个可替换的实现", () => {
  it("换成 cryptoIds，事件流的语义不变（只有 id 的字面值变了）", async () => {
    const script = [callTool(readFile), respond("好了")];
    const sequential = await harness(script).run();
    const random = await harness(script, toolBehaviors, { ids: cryptoIds() }).run();

    // 形状一样：断言的是语义，不是 id 的格式。
    expect(typesOf(random)).toEqual(typesOf(sequential));

    const randomRunId = must(random[0], "首个事件").runId;
    expect(randomRunId).toMatch(/^run_/);
    expect(new Set(random.map((event) => event.runId)).size).toBe(1);

    // 配对这件事与实现无关：两个事件说的是同一个 id，且它是非空字符串。
    const started = must(only(random, "tool_started")[0], "tool_started");
    const completed = must(only(random, "tool_completed")[0], "tool_completed");
    expect(started.toolCallId).toBe(completed.toolCallId);
    expect(started.toolCallId.length).toBeGreaterThan(0);

    // 两次运行的身份不同（随机的意义就在这里）。
    const again = await harness([], toolBehaviors, {
      ids: cryptoIds(),
      model: decidingModel(() => respond("好了")),
    }).run();
    expect(must(again[0], "首个事件").runId).not.toBe(randomRunId);
  });

  it("modelName 不知道就写 null，不发明一个名字", async () => {
    const h = harness([respond("好了")], toolBehaviors, { modelName: null });
    const events = await h.run();

    expect(must(only(events, "model_requested")[0], "model_requested").model).toBeNull();
  });
});

describe("信号：同一条被交到两端", () => {
  it("模型与工具两端收到的是同一条信号", async () => {
    const controller = new AbortController();
    const h = harness([callTool(readFile), respond("好了")]);
    await h.run(controller.signal);
    const model = h.model as ReturnType<typeof scriptedModel>;

    // 步 5 之后交出去的信号是**组合**出来的那条（外部取消 + 墙钟），不再是调用方那条
    // 本身——所以这里断言的不再是「它 === controller.signal」。但「两端拿到同一条」
    // 这条性质没有变，它才是取消能贯通到端口的前提；而「中止能真的打断在途调用」
    // 由 test/runtime-budget.test.ts 断言。
    const [first, second] = model.signals;
    expect(first).toBe(second);
    expect(must(h.tools.signals[0], "工具收到的信号")).toBe(first);
    expect(must(first, "模型收到的信号").aborted).toBe(false);
  });

  it("没传 signal 时，Runtime 自己给一条（而不是把 undefined 传下去）", async () => {
    const h = harness([callTool(readFile), respond("好了")]);
    await h.run();
    const model = h.model as ReturnType<typeof scriptedModel>;

    const signal = must(model.signals[0], "模型收到的信号");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(must(h.tools.signals[0], "工具收到的信号")).toBe(signal);
  });
});

// ---------------------------------------------------------------------------
// 用量：从端口记账 → 事件流
//
// 这一组补的是一个**真实的覆盖缺口**：步 8 之前假模型不实现 `beginRun`，
// 于是所有测试里 `usage_reported` 的用量永远是 `null`——"数字真的从模型端口
// 流进了事件流"这件事一条断言都没有，而它正是步 8 新接的链路。
// ---------------------------------------------------------------------------

describe("用量账目从端口流进事件流", () => {
  it("有一轮没报数时总和是「未知」，不是把报过的几轮加起来冒充总额", async () => {
    const script = [callTool(readFile), callTool(grep), respond("好了")];
    const h = harness(script, toolBehaviors, {
      model: scriptedModel(script, {
        // 第 0 轮不报数（模拟 deepseek 那条已知缺口），第 1、2 轮各报 100/20
        usage: (call) =>
          call === 0 ? { inputTokens: null, outputTokens: null } : { inputTokens: 100, outputTokens: 20 },
      }),
    });
    const events = await h.run();

    const usage = must(only(events, "usage_reported")[0], "usage_reported").usage;
    // "null 是传染源"这条规则在事件流上的样子：少一个数比多一个假数好。
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    // 与用量不同，工具调用次数是我们自己数的，它一直准
    expect(usage.toolCalls).toBe(2);
    expect(usage.model).toBe(MODEL_NAME);
  });

  it("每次都报数时，事件里的数是各轮之和", async () => {
    const script = [callTool(readFile), callTool(grep), respond("好了")];
    const h = harness(script, toolBehaviors, {
      model: scriptedModel(script, { usage: { inputTokens: 100, outputTokens: 20 } }),
    });
    const events = await h.run();

    // 三次 decide：两次工具调用 + 一次收工
    const usage = must(only(events, "usage_reported")[0], "usage_reported").usage;
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(60);
  });

  it("端口没有账本时（不实现 beginRun）用量是 null，而不是零", async () => {
    // 这是**唯一**一条覆盖 `usageOf(null)` 的断言：`beginRun` 在端口上可选，
    // 不实现它是一个合法形态，Runtime 既不能崩，也不能编一个 0 出来。
    const h = harness();
    const events = await h.run();

    const usage = must(only(events, "usage_reported")[0], "usage_reported").usage;
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
  });

  it("一次 Run 恰好一条 usage_reported——失败路径上也有，且只有一条", async () => {
    const failing: ModelPort = {
      async decide(): Promise<Decision> {
        throw new Error("端口炸了");
      },
    };
    const h = harness([respond("用不上")], toolBehaviors, { model: failing });
    const events = await h.run();

    // 一次失败的 Run 恰恰是最想知道"已经花掉多少"的那一次，所以账目照样要报；
    // 而报两次会让同一笔花费在 trace 里出现两遍。
    expect(only(events, "usage_reported")).toHaveLength(1);
    expect(typesOf(events).at(-1)).toBe("run_failed");
  });
});

// ---------------------------------------------------------------------------
// 七、起点
// ---------------------------------------------------------------------------

describe("emptyStateFor", () => {
  it("一次新 Run 的起点：空 transcript、0 轮、没有待答问题", () => {
    expect(emptyStateFor(task)).toEqual({
      task,
      transcript: [],
      iteration: 0,
      pendingQuestion: null,
    });
  });

  it("两次调用互不共享，上一次 Run 的痕迹带不到下一次", () => {
    const first = emptyStateFor(task);
    const second = emptyStateFor(task);

    expect(first.transcript).not.toBe(second.transcript);
    expect(first).not.toBe(second);
  });
});
