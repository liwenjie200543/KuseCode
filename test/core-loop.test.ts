import { describe, expect, it } from "vitest";

// 这个测试只 import 三样东西：跑测试的 vitest、Core、以及假适配器。
// 没有 node: 内置模块，没有文件系统，没有进程，没有网络。
// 这不是风格问题——它正是本步要证明的命题：「循环可以在没有进程、数据库、
// 网络和 UI 的情况下跑完」。约束由 test/no-runtime-deps.test.ts 扫描固化。
import {
  hasProgress,
  isAwaitingHuman,
  isTerminal,
  observationsOf,
  reduce,
  renderContext,
  runCoreLoop,
  step,
} from "../src/core/loop.js";
import type { LoopDeps, LoopTurn } from "../src/core/loop.js";
import type { AgentState, Decision, Message, Observation, Task, ToolIntent } from "../src/core/types.js";
import { FakeScriptExhaustedError, decidingModel, scriptedModel } from "../src/testing/fake-model.js";
import type { FakeToolBehavior } from "../src/testing/fake-tools.js";
import { fakeClock, fakeObservationAssembler, fakeTools } from "../src/testing/fake-tools.js";

// ---------------------------------------------------------------------------
// 夹具：一个真实的 Task（不是占位字符串），一批脚本化的决策与工具
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-1",
  goal: "这个仓库的证据链是怎么串起来的？",
  repoRoot: "/repo",
  checks: ["每条论断都能指到文件与行号吗"],
};

const readFile: ToolIntent = { name: "read_file", args: { path: "src/core/loop.ts" } };

const callTool = (intent: ToolIntent): Decision => ({ kind: "call_tool", intent });
const respond = (summary: string): Decision => ({ kind: "respond", report: { summary, claims: [] } });

const observation: Observation = {
  tool: "read_file",
  value: "export function reduce() {}",
  error: null,
  truncated: false,
  provenance: { source: "read_file", at: 1_700_000_000_000 },
};

const defaultTools: Readonly<Record<string, FakeToolBehavior>> = {
  read_file: { value: observation.value, error: null },
  grep: { value: ["loop.ts:1"], error: null },
};

function emptyState(): AgentState {
  return { task, transcript: [], iteration: 0, pendingQuestion: null };
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`缺少 ${what}`);
  return value;
}

function harness(
  script: readonly Decision[],
  behaviors: Readonly<Record<string, FakeToolBehavior>> = defaultTools,
): { model: ReturnType<typeof scriptedModel>; tools: ReturnType<typeof fakeTools>; deps: LoopDeps } {
  const model = scriptedModel(script);
  const tools = fakeTools(behaviors);
  const deps: LoopDeps = {
    model,
    tools,
    assembleObservation: fakeObservationAssembler({ now: fakeClock() }),
  };
  return { model, tools, deps };
}

/** 驱动循环并把每轮产出收起来——驱动方（步 4 的 Runtime）将来做的就是这件事。 */
async function drive(
  deps: LoopDeps,
  state: AgentState = emptyState(),
  signal: AbortSignal = new AbortController().signal,
): Promise<{ turns: LoopTurn[]; finalState: AgentState }> {
  const turns: LoopTurn[] = [];
  const generator = runCoreLoop(state, deps, signal);

  let next = await generator.next();
  while (!next.done) {
    turns.push(next.value);
    next = await generator.next();
  }

  let finalState: AgentState = state;
  if (next.done) finalState = next.value;
  return { turns, finalState };
}

// ---------------------------------------------------------------------------
// 一轮的两次产出：意图先交出去，观测后交回来。
// 这个顺序不是实现细节——驱动方要靠它把 decision_made / tool_started 排在
// tool_completed 前面（步 4），事件流的时间戳才不是事后补的。
// ---------------------------------------------------------------------------
describe("循环的形状", () => {
  it("先交出意图，再交出观测，最后一次产出是终态", async () => {
    const { model, tools, deps } = harness([callTool(readFile), respond("证据齐了")]);
    const { turns, finalState } = await drive(deps);

    expect(turns).toHaveLength(3);

    // 第一次产出：决策已下，工具还没跑，状态还没推进
    expect(turns[0]?.decision.kind).toBe("call_tool");
    expect(turns[0]?.observation).toBeNull();
    expect(turns[0]?.state.iteration).toBe(0);

    // 第二次产出：工具跑完，观测回来，状态推进了一轮
    expect(turns[1]?.observation?.tool).toBe("read_file");
    expect(turns[1]?.state.iteration).toBe(1);

    // 第三次产出：终态，不再产生观测
    expect(turns[2]?.decision.kind).toBe("respond");
    expect(turns[2]?.observation).toBeNull();

    expect(finalState.iteration).toBe(2);
    expect(model.calls).toBe(2);
    expect(tools.calls).toHaveLength(1);
    expect(tools.executed).toHaveLength(1);
  });

  it("step 只问模型，不推进状态", async () => {
    const { model, deps } = harness([respond("ok")]);
    const state = emptyState();

    const decision = await step(state, deps, new AbortController().signal);

    expect(decision.kind).toBe("respond");
    expect(model.calls).toBe(1);
    expect(state.transcript).toEqual([]);
    expect(state.iteration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 观测回填：工具的结果必须成为下一轮的输入，而且必须以 Core 自己的词汇落在
// transcript 里（不是 provider 的消息对象）。
// 两条证据：最终状态里有它，**下一轮模型收到的输入里也有它**。
// ---------------------------------------------------------------------------
describe("观测回填进 transcript", () => {
  it("工具观测按 Core 的词汇落进状态，provenance 由组装点写", async () => {
    const { deps } = harness([callTool(readFile), respond("证据齐了")]);
    const { finalState } = await drive(deps);

    const observations = observationsOf(finalState);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(observation);

    expect(finalState.transcript).toEqual([
      { role: "assistant", decision: callTool(readFile) },
      { role: "tool", intent: readFile, observation: must(observations[0], "第一条观测") },
      { role: "assistant", decision: respond("证据齐了") },
    ] satisfies Message[]);
  });

  it("下一轮模型收到的输入里已经有这条观测", async () => {
    const { model, deps } = harness([callTool(readFile), respond("证据齐了")]);
    await drive(deps);

    const second = must(model.seenStates[1], "第二轮模型输入");
    expect(second.iteration).toBe(1);
    expect(observationsOf(second)).toHaveLength(1);
    expect(second.transcript).toHaveLength(2);
  });

  it("第二次决策能依赖第一次的观测——闭环真的闭上了", async () => {
    // 队列只能证明「循环按顺序吃了 N 条」；这条测试让第二次决策**看着观测**做。
    // 一旦观测没有回填，第二次决策就会变成又一次 call_tool，断言立刻失败。
    const model = decidingModel((state) =>
      observationsOf(state).length === 0 ? callTool(readFile) : respond("拿到证据了"),
    );
    const tools = fakeTools(defaultTools);
    const deps: LoopDeps = {
      model,
      tools,
      assembleObservation: fakeObservationAssembler({ now: fakeClock() }),
    };

    const { turns, finalState } = await drive(deps);

    expect(model.calls).toBe(2);
    expect(tools.executed).toHaveLength(1);
    expect(turns).toHaveLength(3);
    expect(finalState.transcript.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 终止判定：只有 respond 与 ask_human 让循环停下来。
// ---------------------------------------------------------------------------
describe("终止判定", () => {
  it("三种决策里只有两种是终态", () => {
    expect(isTerminal(respond("ok"))).toBe(true);
    expect(isTerminal({ kind: "ask_human", question: "哪个模块？" })).toBe(true);
    expect(isTerminal(callTool(readFile))).toBe(false);
  });

  it("问到应答就收工，脚本剩下的部分不会被碰", async () => {
    const { model, tools, deps } = harness([respond("ok"), callTool(readFile)]);
    const { turns, finalState } = await drive(deps);

    expect(turns).toHaveLength(1);
    expect(model.calls).toBe(1);
    expect(tools.calls).toHaveLength(0);
    expect(finalState.pendingQuestion).toBeNull();
  });

  it("ask_human 只到状态层：问题被记下，循环不再替人做决定", async () => {
    const { model, tools, deps } = harness([{ kind: "ask_human", question: "先看哪个模块？" }]);
    const { turns, finalState } = await drive(deps);

    expect(turns).toHaveLength(1);
    expect(finalState.pendingQuestion).toBe("先看哪个模块？");
    expect(isAwaitingHuman(finalState)).toBe(true);
    expect(model.calls).toBe(1);
    expect(tools.calls).toHaveLength(0);

    // 拿着同一个状态再驱动一次：循环停在人类那一侧，一次模型都不会再问。
    const resumed = await drive(deps, finalState);
    expect(resumed.turns).toHaveLength(0);
    expect(resumed.finalState).toBe(finalState);
    expect(model.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 有界迭代。上限来自**模型给不给终态**，不来自循环：Core 里没有 maxIterations。
// 所以这里的 21 条决策必须一条不少地跑完——任何内置上限（5、10、20）都会让它失败。
// ---------------------------------------------------------------------------
describe("有界迭代", () => {
  it("跑到模型给出终态为止，循环自己不设上限", async () => {
    const rounds = 20;
    const script: Decision[] = [
      ...Array.from({ length: rounds }, () => callTool(readFile)),
      respond("够了"),
    ];
    const { model, tools, deps } = harness(script);

    const { turns, finalState } = await drive(deps);

    expect(model.calls).toBe(rounds + 1);
    expect(tools.executed).toHaveLength(rounds);
    expect(finalState.iteration).toBe(rounds + 1);
    expect(turns).toHaveLength(rounds * 2 + 1);
  });

  it("循环多走一轮立刻可见：脚本用尽即报错", async () => {
    // 脚本只有一条非终态决策：循环必须在这一轮之后要么停下、要么再问一次。
    // 它再问了一次（这是对的——谁也没告诉它该停），于是脚本用尽这个事实被暴露出来。
    const { deps } = harness([callTool(readFile)]);

    const failure = await drive(deps).catch((error: unknown) => error);

    if (!(failure instanceof FakeScriptExhaustedError)) {
      throw new Error(`预期脚本用尽，实际得到：${String(failure)}`);
    }
    expect(failure.scriptLength).toBe(1);
    expect(failure.requestedCall).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// reduce 是唯一的状态推进函数（实时、回放、测试共用它）。
// 因此它必须纯：不改入参、不读时钟、同样的输入永远给同样的输出。
// ---------------------------------------------------------------------------
describe("reduce", () => {
  it("不改动入参，返回新的状态对象", () => {
    const frozen: AgentState = Object.freeze({
      task,
      transcript: Object.freeze([] as Message[]),
      iteration: 0,
      pendingQuestion: null,
    });

    // 严格模式下原地改写冻结对象会抛异常；没抛就说明它没有原地改。
    const next = reduce(frozen, callTool(readFile), observation);

    expect(next).not.toBe(frozen);
    expect(next.transcript).not.toBe(frozen.transcript);
    expect(frozen.transcript).toEqual([]);
    expect(frozen.iteration).toBe(0);
  });

  it("同样的输入永远给同样的输出", () => {
    expect(reduce(emptyState(), callTool(readFile), observation)).toEqual(
      reduce(emptyState(), callTool(readFile), observation),
    );
  });

  it("每减少一次 iteration 加一，意图与观测各留一条消息", () => {
    const first = reduce(emptyState(), callTool(readFile), observation);
    const second = reduce(first, respond("ok"));

    expect(first.iteration).toBe(1);
    expect(second.iteration).toBe(2);
    expect(first.transcript.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(second.transcript).toHaveLength(3);
  });

  it("观测没回来时只留意图，不伪造一条空观测", () => {
    const state = reduce(emptyState(), callTool(readFile));

    expect(state.transcript.map((message) => message.role)).toEqual(["assistant"]);
    expect(observationsOf(state)).toEqual([]);
  });

  it("非终态决策会越过待答问题（决策即推进）", () => {
    const waiting = reduce(emptyState(), { kind: "ask_human", question: "先看哪个模块？" });
    const moved = reduce(waiting, callTool(readFile), observation);

    expect(waiting.pendingQuestion).toBe("先看哪个模块？");
    expect(moved.pendingQuestion).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasProgress：什么叫「这一轮白转了」。
// 谓词在 Core，执法在 Runtime（步 5 的 no_progress）——停不停由驱动方说了算。
// ---------------------------------------------------------------------------
describe("hasProgress", () => {
  it("拿到新观测才算前进", () => {
    const before = emptyState();

    expect(hasProgress(before, reduce(before, callTool(readFile), observation))).toBe(true);
    expect(hasProgress(before, reduce(before, callTool(readFile)))).toBe(false);
    expect(hasProgress(before, reduce(before, respond("ok")))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 编译期证明：Core 不吃预算。
// 下面两行是断言，不是注释——谁把 maxIterations / budget 塞进 LoopDeps，
// 或者往依赖里多加一样东西，这里就编译不过。
// ---------------------------------------------------------------------------
describe("Core 的依赖面", () => {
  type BudgetVocabulary = "budget" | "maxIterations" | "maxToolCalls" | "maxRetries" | "timeoutMs";
  const coreTakesNoBudget: [Extract<BudgetVocabulary, keyof LoopDeps>] extends [never] ? true : false =
    true;
  const coreDepsAreExactlyTwoPortsAndOneSeam: [keyof LoopDeps] extends [
    "model" | "tools" | "assembleObservation",
  ]
    ? true
    : false = true;

  it("没有预算字段：循环的边界只由模型的终态决策决定", () => {
    expect(coreTakesNoBudget).toBe(true);
  });

  it("依赖面就是两个端口加一条组装接缝", () => {
    expect(coreDepsAreExactlyTwoPortsAndOneSeam).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 取消信号：这里只证明「信号贯通到了端口」。真正的执法在步 5。
// ---------------------------------------------------------------------------
describe("取消信号", () => {
  it("同一个 signal 转交给模型与工具两端", async () => {
    const controller = new AbortController();
    const { model, tools, deps } = harness([callTool(readFile), respond("ok")]);

    await drive(deps, emptyState(), controller.signal);

    expect(model.signals[0]).toBe(controller.signal);
    expect(tools.signals[0]).toBe(controller.signal);
  });

  it("不自己判中止：取消是驱动方的策略，Core 只负责把信号转交出去", async () => {
    // 信号已经中止，循环仍按脚本走完——因为「什么时候停」不在 Core 手里。
    // 步 5 决定是驱动方在每轮之间检查，还是由端口实现在途打断；
    // 若那时把检查移进循环，这条测试是第一个要改的地方。
    const controller = new AbortController();
    controller.abort();
    const { deps } = harness([callTool(readFile), respond("ok")]);

    const { turns, finalState } = await drive(deps, emptyState(), controller.signal);

    expect(turns).toHaveLength(3);
    expect(finalState.iteration).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// renderContext：模型能看到的是状态的**有界投影**，不是状态本身。
// 它的生产消费者是步 8 的适配器；现在由这条测试把它固定住，
// 免得适配器到时候自己发明第二套投影。
// ---------------------------------------------------------------------------
describe("renderContext", () => {
  it("只有六个字段，且不含任何策略字段", () => {
    const state = reduce(emptyState(), callTool(readFile), observation);

    const context = renderContext(state, ["read_file", "grep"]);

    expect(Object.keys(context).sort()).toEqual([
      "availableTools",
      "checks",
      "goal",
      "iteration",
      "observations",
      "repoRoot",
    ]);
    expect(context.observations).toEqual([observation]);
    expect(context.availableTools).toEqual(["read_file", "grep"]);
    expect(context.iteration).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 工具失败：Core 不做失败隔离（那是步 6 的 tool-runner 的活），
// 但它也不会因为工具失败而崩——失败是一条普通的观测。
// ---------------------------------------------------------------------------
describe("工具失败不是 Core 的失败", () => {
  it("未知工具被端口拒绝，循环记下错误观测后继续", async () => {
    const { tools, deps } = harness([callTool({ name: "delete_all", args: {} }), respond("算了")]);

    const { finalState } = await drive(deps);

    const observations = observationsOf(finalState);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.error?.code).toBe("invalid_tool");
    expect(tools.executed).toHaveLength(0);
    expect(finalState.transcript.at(-1)).toEqual({ role: "assistant", decision: respond("算了") });
    expect(hasProgress(emptyState(), finalState)).toBe(true);
  });

  it("工具自己报错也只是一条观测，不是异常", async () => {
    const failing: Record<string, FakeToolBehavior> = {
      read_file: { value: null, error: { code: "not_found", message: "src/nope.ts 不存在" } },
    };
    const { deps } = harness([callTool(readFile), respond("这条路走不通")], failing);

    const { finalState } = await drive(deps);

    const observations = observationsOf(finalState);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.error?.code).toBe("not_found");
    expect(observations[0]?.truncated).toBe(false);
    expect(finalState.iteration).toBe(2);
  });
});
