import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 步 7 的命题的另一半：**事件日志是唯一真相——它活得过进程。**
//
// 这个文件里的每一次「恢复」都换了一个全新的 `SessionStore` / `RunLog` 实例：
// 新实例没有上一个的任何内存，它是「另一个进程」在测试里能做到的最接近的替身。
// 一个用旧实例读回来的断言证明不了任何事——那读的是缓存，不是磁盘。
import type { AgentEvent, AgentState, Decision, Task, ToolIntent } from "../src/core/types.js";
import { sequentialIds } from "../src/runtime/ids.js";
import { runStatusOf } from "../src/runtime/replay.js";
import { createRuntime } from "../src/runtime/run-agent.js";
import { memoryRunLog } from "../src/runtime/run-log.js";
import { collectMissingMaterial, createToolRunner } from "../src/runtime/tool-runner.js";
import { createSessionStore } from "../src/store/session-store.js";
import { eventsPathFor, jsonlRunLog } from "../src/store/run-log-jsonl.js";
import { scriptedModel } from "../src/testing/fake-model.js";
import { fakeClock, fakeTools } from "../src/testing/fake-tools.js";
import type { FakeToolBehavior } from "../src/testing/fake-tools.js";

// ---------------------------------------------------------------------------
// 夹具：一个临时目录、一段脚本、一次真的 Run
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-7",
  goal: "把这次 Run 的日志写下来，再从另一个进程里读回去",
  repoRoot: "/repo",
  checks: ["换一个实例读回来的状态与实时状态一致"],
};

const readFile: ToolIntent = { name: "read_file", args: { path: "src/core/loop.ts" } };
const readOther: ToolIntent = { name: "read_file", args: { path: "src/store/session-store.ts" } };

const callTool = (intent: ToolIntent): Decision => ({ kind: "call_tool", intent });
const respond = (summary: string): Decision => ({ kind: "respond", report: { summary, claims: [] } });

const READS: Readonly<Record<string, FakeToolBehavior>> = {
  read_file: { value: "export function reduce() {}", error: null },
};

const TWO_STEPS: readonly Decision[] = [callTool(readFile), callTool(readOther), respond("两处都看了")];

/** 「这里一定有东西」：把 `T | null | undefined` 收窄成 `T`，缺了就当场说清缺什么。 */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`缺少 ${what}`);
  return value;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kuse-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 手工拼一条事件（「被外部改过」与「进程被杀掉」这两类输入的替身）
// ---------------------------------------------------------------------------

type PayloadOf<K extends AgentEvent["type"]> = Omit<
  Extract<AgentEvent, { type: K }>,
  "runId" | "sequence" | "timestamp" | "type"
>;

function ev<K extends AgentEvent["type"]>(
  runId: string,
  sequence: number,
  type: K,
  payload: PayloadOf<K>,
): AgentEvent {
  // 与 Runtime 的私有 `emit` 同一手法：基字段由这一层填，载荷由调用方给。
  return { ...payload, runId, sequence, timestamp: 1_700_000_000_000 + sequence, type } as AgentEvent;
}

// ---------------------------------------------------------------------------
// 两种跑法：写进内存（只为拿事件），与写进磁盘（本步的主角）
// ---------------------------------------------------------------------------

/** 只为了拿到一串真实事件的 Run，日志写在内存里。 */
async function eventsOf(
  script: readonly Decision[],
  behaviors: Readonly<Record<string, FakeToolBehavior>> = READS,
): Promise<readonly AgentEvent[]> {
  const log = memoryRunLog();
  const runner = createToolRunner({ tools: fakeTools(behaviors), clock: fakeClock() });
  const runtime = createRuntime({
    model: scriptedModel(script),
    ...runner.toolDeps(),
    log,
    ids: sequentialIds("t"),
    clock: fakeClock(),
    modelName: "fake-model",
  });

  const events: AgentEvent[] = [];
  for await (const event of runtime.run(task)) events.push(event);
  return events;
}

interface WrittenRun {
  readonly runId: string;
  readonly events: readonly AgentEvent[];
  /** Runtime 亲手交出来的终态状态。 */
  readonly state: AgentState;
}

/** 把一次 Run 真的跑进存储里：登记 → 跑 → 事件落在磁盘上。 */
async function runInto(
  store: ReturnType<typeof createSessionStore>,
  sessionId: string,
  script: readonly Decision[],
): Promise<WrittenRun> {
  const handle = await store.startRun(sessionId, task);
  const runner = createToolRunner({ tools: fakeTools(READS), clock: fakeClock() });
  const box: { state: AgentState | null } = { state: null };

  const runtime = createRuntime({
    model: scriptedModel(script),
    ...runner.toolDeps(),
    // 存储交出来的两样东西：日志落在哪、以及这次 Run 的身份。
    log: handle.log,
    ids: handle.ids,
    clock: fakeClock(),
    modelName: "fake-model",
    collectMissingMaterial: (state: AgentState) => {
      box.state = state;
      return collectMissingMaterial(state);
    },
  });

  const events: AgentEvent[] = [];
  for await (const event of runtime.run(task)) events.push(event);

  return { runId: handle.runId, events, state: must(box.state, "Runtime 交出的终态状态") };
}

// ---------------------------------------------------------------------------
// 一、日志活得过进程
// ---------------------------------------------------------------------------

describe("事件日志活得过进程", () => {
  it("写入之后换一个全新的日志实例，读回来的是同一串事件", async () => {
    const events = await eventsOf(TWO_STEPS);
    const writer = jsonlRunLog({ rootDir: dir });
    for (const event of events) await writer.append(event);

    // 换实例：没有上一个的任何内存。这读的是磁盘，不是缓存。
    const reader = jsonlRunLog({ rootDir: dir });
    expect(reader.read("t-run-1")).toEqual(events);
  });

  it("读回来的是快照：每次都是新数组，而且是冻结的", async () => {
    const events = await eventsOf([respond("看完了")]);
    const log = jsonlRunLog({ rootDir: dir });
    for (const event of events) await log.append(event);

    const first = log.read("t-run-1");
    const second = log.read("t-run-1");

    expect(first).toEqual(events);
    // 不是同一个数组：调用方拿去排序、断言、切片，都影响不到日志。
    expect(first).not.toBe(second);
    // 而且改不动它——「快照」在这里是硬的，不是靠自觉。
    expect(Object.isFrozen(first)).toBe(true);
    expect(jsonlRunLog({ rootDir: dir }).read("t-run-1")).toEqual(events);
  });

  it("还没写过任何事件的 Run 读到空数组（登记了但还没跑）", () => {
    expect(jsonlRunLog({ rootDir: dir }).read("t-run-1")).toEqual([]);
  });

  it("读永远走磁盘：别的写者刚写下的事件，这个实例也读得到", async () => {
    const events = await eventsOf(TWO_STEPS);
    const mine = jsonlRunLog({ rootDir: dir });
    for (const event of events.slice(0, 2)) await mine.append(event);

    // 另一个进程（在测试里就是另一个实例）接着往下写。
    const someoneElse = jsonlRunLog({ rootDir: dir });
    await someoneElse.append(must(events[2], "第 3 条事件"));

    // `read` 不是「这个进程写过的那些」，它是磁盘上的那一份。
    // 所以缓存里只有 2 条的这个实例，读得到 3 条。
    expect(mine.read("t-run-1")).toEqual(events.slice(0, 3));
    // 注意这条只关于读。**追加**不承诺这个：一个 Run 只有一个写者（见文件头第四条
    // 边界），所以在别人的写入之后用这个实例继续追加，不在契约里。
  });
});

// ---------------------------------------------------------------------------
// 二、写了一半的记录：丢掉它，而且之后还能接着写
// ---------------------------------------------------------------------------

describe("崩溃留下的残骸", () => {
  it("尾部写了一半的行被丢弃，不会产生半个状态；之后的追加仍然连续", async () => {
    const events = await eventsOf(TWO_STEPS);
    const file = eventsPathFor(dir, "t-run-1");

    const writer = jsonlRunLog({ rootDir: dir });
    for (const event of events.slice(0, 3)) await writer.append(event);

    // 断电发生在一次 append 的中途：内容写了一部分，换行符还没写下去。
    appendFileSync(file, '{"runId":"t-run-1","sequence":3,"tim');

    const reader = jsonlRunLog({ rootDir: dir });
    // 「记录」的边界是换行符——没有换行符的尾巴从来不是记录，所以它不产生状态。
    expect(reader.read("t-run-1")).toEqual(events.slice(0, 3));

    // 而且下一条仍然写得下去：残骸在追加之前被清掉，不会把两条事实粘成一行。
    await reader.append(must(events[3], "第 4 条事件"));
    expect(reader.read("t-run-1")).toEqual(events.slice(0, 4));

    const text = readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(4);
  });

  it("被换行符终止的行必须能解析：它坏了就是日志损坏，不是残骸", async () => {
    const events = await eventsOf([respond("看完了")]);
    const file = eventsPathFor(dir, "t-run-1");

    const writer = jsonlRunLog({ rootDir: dir });
    for (const event of events) await writer.append(event);
    // 这一行**被换行终止**了，而写下的每一行都是「内容在前、换行在后」——
    // 所以一个写全了的行必然能解析。它坏了，只可能是被外部改过。
    appendFileSync(file, "{这不是一条事件}\n");

    expect(() => jsonlRunLog({ rootDir: dir }).read("t-run-1")).toThrow(/不是合法的 JSON/);
  });

  it("有洞的写入被拒绝，而且不在磁盘上留下痕迹", async () => {
    const log = jsonlRunLog({ rootDir: dir });

    await expect(
      log.append(ev("t-run-9", 5, "run_started", {})),
    ).rejects.toThrow(/只接受追加/);
    expect(existsSync(eventsPathFor(dir, "t-run-9"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 三、日志的最后一道关：写下去的东西读回来必须是同一条
// ---------------------------------------------------------------------------

describe("装不进 JSON 的事件被拒绝", () => {
  it("往返之后变样的事件拒不写入（安静地改变一条证据，比拒绝它糟得多）", async () => {
    const log = jsonlRunLog({ rootDir: dir });
    const lossy = ev("t-run-1", 0, "decision_made", {
      // 函数在 JSON 里会**丢掉整个键**：读回来就成了一条没有 handler 的调用。
      decision: callTool({ name: "read_file", args: { handler: () => "悄悄没了" } }),
    });

    await expect(log.append(lossy)).rejects.toThrow(/过不了 JSON 往返/);
    // 被拒绝的写入不留痕迹：守卫在动任何文件之前就已经拦下了。
    expect(existsSync(eventsPathFor(dir, "t-run-1"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 四、runId 会变成目录名
// ---------------------------------------------------------------------------

describe("runId 会变成目录名，所以它不能带路径", () => {
  it("路径穿越的 id 被拒绝（读和写都拒绝）", async () => {
    const log = jsonlRunLog({ rootDir: dir });

    expect(() => log.read("../../etc/passwd")).toThrow(/当作文件名使用/);
    expect(() => log.read("..")).toThrow(/当作文件名使用/);
    expect(() => log.read("")).toThrow(/当作文件名使用/);
    await expect(log.append(ev("../逃出去", 0, "run_started", {}))).rejects.toThrow(
      /当作文件名使用/,
    );
    // 什么都没被写到根目录之外去。
    expect(readdirSync(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 五、两个会话不共享任何状态
// ---------------------------------------------------------------------------

describe("两个会话不共享任何状态", () => {
  it("各自的事件、状态与文件都分得开，而且跨会话取 Run 会被拒绝", async () => {
    const store = createSessionStore({ rootDir: dir, ids: sequentialIds("t"), clock: fakeClock() });
    const a = await store.createSession();
    const b = await store.createSession();

    // 两个会话里的 Run 用同一段脚本形状、不同的结论文本，好让状态能分辨。
    const runA = await runInto(store, a.id, [callTool(readFile), respond("A 的结论")]);
    const runB = await runInto(store, b.id, [callTool(readOther), respond("B 的结论")]);

    expect(a.id).not.toBe(b.id);
    expect(runA.runId).not.toBe(runB.runId);

    // 事件分得开：各自的文件里只有自己的事件。
    expect(jsonlRunLog({ rootDir: dir }).read(runA.runId)).toEqual(runA.events);
    expect(jsonlRunLog({ rootDir: dir }).read(runB.runId)).toEqual(runB.events);

    // 状态分得开：脚本不同，结论不同，谁都不含对方那一次调用。
    const recoveredA = must(await store.recover(a.id, runA.runId), "A 的恢复结果");
    const recoveredB = must(await store.recover(b.id, runB.runId), "B 的恢复结果");
    expect(recoveredA.state).toEqual(runA.state);
    expect(recoveredB.state).toEqual(runB.state);
    expect(JSON.stringify(recoveredA.state)).not.toContain("B 的结论");
    expect(JSON.stringify(recoveredB.state)).not.toContain("A 的结论");

    // 隔离在接口上也成立：拿着 A 的会话去取 B 的 Run，得到的是「没有」，
    // 而不是顺手把它交出去。
    expect(await store.recover(a.id, runB.runId)).toBeNull();

    // 会话视图同样只说自己的事。
    expect(must(await store.getSession(a.id), "会话 A").runs.map((run) => run.runId)).toEqual([
      runA.runId,
    ]);
    expect(must(await store.getSession(b.id), "会话 B").runs.map((run) => run.runId)).toEqual([
      runB.runId,
    ]);
  });

  it("换一个全新的 store 实例，会话索引照样在", async () => {
    const first = createSessionStore({ rootDir: dir, ids: sequentialIds("t"), clock: fakeClock() });
    const session = await first.createSession();
    const run = await runInto(first, session.id, [respond("A 的结论")]);

    const second = createSessionStore({ rootDir: dir, ids: sequentialIds("z"), clock: fakeClock() });
    const reloaded = must(await second.getSession(session.id), "重新读到的会话");

    expect(reloaded.createdAt).toBe(session.createdAt);
    expect(reloaded.runs.map((run) => run.runId)).toEqual([run.runId]);
    // 索引里还剩的临时文件？原子写应该已经把它改名掉了。
    expect(existsSync(join(dir, "sessions", `${session.id}.json.tmp`))).toBe(false);
  });

  it("往不存在的会话里登记 Run 被拒绝，而不是顺手造一个", async () => {
    const store = createSessionStore({ rootDir: dir, ids: sequentialIds("t"), clock: fakeClock() });

    await expect(store.startRun("t-sess-404", task)).rejects.toThrow(/不存在/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 六、恢复：崩溃之后从哪问起
// ---------------------------------------------------------------------------

describe("恢复", () => {
  it("端到端：登记 → 跑 → 换一个实例恢复出同一个状态", async () => {
    const writer = createSessionStore({ rootDir: dir, ids: sequentialIds("t"), clock: fakeClock() });
    const session = await writer.createSession();
    const run = await runInto(writer, session.id, TWO_STEPS);

    // 另一个连接同一份存储的进程会看到的全部东西。
    const reader = createSessionStore({ rootDir: dir, ids: sequentialIds("z"), clock: fakeClock() });
    const recovered = must(await reader.recover(session.id, run.runId), "恢复结果");

    expect(recovered.events).toEqual(run.events);
    expect(recovered.state).toEqual(run.state);
    expect(recovered.status).toBe("completed");
    expect(recovered.task).toEqual(task);

    // 走完的 Run 不再是「还没走完」的那个问题的一部分。
    expect(await reader.unfinished(session.id)).toEqual([]);
    // 而且它的 status 不是存下来的，是从日志算出来的。
    expect(runStatusOf(recovered.events)).toBe(must(await reader.getSession(session.id), "会话").runs[0]?.status);
  });

  it("登记了还没跑的 Run 是 queued，它就在「还没走完」里等着", async () => {
    const store = createSessionStore({ rootDir: dir, ids: sequentialIds("t"), clock: fakeClock() });
    const session = await store.createSession();
    const handle = await store.startRun(session.id, task);

    expect(await store.unfinished(session.id)).toEqual([handle.runId]);

    const recovered = must(await store.recover(session.id, handle.runId), "恢复结果");
    expect(recovered.status).toBe("queued");
    expect(recovered.events).toEqual([]);
    expect(recovered.state.transcript).toEqual([]);
  });

  it("进程被杀掉（日志停在没有终态的地方）：恢复得出它停在哪，并被算作还没走完", async () => {
    const store = createSessionStore({ rootDir: dir, ids: sequentialIds("t"), clock: fakeClock() });
    const session = await store.createSession();
    const handle = await store.startRun(session.id, task);

    // 真实的 Runtime 每一条路径都会写下终态事件（步 4/5），所以「日志停在没有终态
    // 的地方」只可能来自进程被杀掉。这里直接把那段日志写出来，模拟那一刻：
    // 刀切在一条观测落好之后——状态里因此有两条消息（一条决策、一条观测），
    // 而那条本来会写下的 run_completed 从来没有发生。
    const events = await eventsOf([callTool(readFile), respond("这一步没走到")]);
    const prefix = events.slice(0, 6); // run_started … observation_added
    for (const event of prefix) await handle.log.append({ ...event, runId: handle.runId });

    const reader = createSessionStore({ rootDir: dir, ids: sequentialIds("z"), clock: fakeClock() });
    const recovered = must(await reader.recover(session.id, handle.runId), "恢复结果");

    expect(recovered.status).toBe("running");
    expect(recovered.state.transcript).toHaveLength(2); // 一条决策 + 一条观测
    expect(await reader.unfinished(session.id)).toEqual([handle.runId]);
  });

  it("身份先于运行存在，但只交出去一次", async () => {
    const store = createSessionStore({ rootDir: dir, ids: sequentialIds("t"), clock: fakeClock() });
    const session = await store.createSession();
    const handle = await store.startRun(session.id, task);

    expect(handle.ids.runId()).toBe(handle.runId);
    // 再要一次 id 就说明有人想让两次 Run 共用一个 runId——那会把两份日志
    // 写进同一个文件（第二条的 sequence 从 0 重来）。这里当场拒绝。
    expect(() => handle.ids.runId()).toThrow(/为一次 Run 准备/);
    expect(handle.ids.toolCallId()).toMatch(/^t-tool-/);
  });
});
