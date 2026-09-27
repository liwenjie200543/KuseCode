import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultConfig } from "../src/config/loader.js";
import { createKuse, storeInsideRepo } from "../src/bootstrap/index.js";
import type { AgentEvent, Decision, Task } from "../src/core/types.js";
import { sequentialIds } from "../src/runtime/ids.js";
import { ResumeError, createRuntime } from "../src/runtime/run-agent.js";
import { collectMissingMaterial, createToolRunner } from "../src/runtime/tool-runner.js";
import { createSessionStore } from "../src/store/session-store.js";
import { scriptedModel } from "../src/testing/fake-model.js";
import { fakeClock, fakeTools } from "../src/testing/fake-tools.js";
import type { FakeToolBehavior } from "../src/testing/fake-tools.js";

// ---------------------------------------------------------------------------
// 夹具：一个小仓库 + 一份数据目录
// ---------------------------------------------------------------------------

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kuse-bootstrap-"));
  await mkdir(join(root, "repo", "notes"), { recursive: true });
  await writeFile(join(root, "repo", "notes", "spec.md"), "# 规格\n\n- 归档必须可关闭。\n");
  await writeFile(join(root, "repo", "README.md"), "TODO: 示例。\n");
  await mkdir(join(root, "data"), { recursive: true });
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

const REPO = (): string => join(root, "repo");
const DATA = (): string => join(root, "data");

const READS: Readonly<Record<string, FakeToolBehavior>> = {
  read_file: { value: "export function reduce() {}", error: null },
};

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// ---------------------------------------------------------------------------
// 装配契约
// ---------------------------------------------------------------------------

describe("createKuse：装配契约（SDD T12）", () => {
  it("startRun（离线）跑完整链路：事件流、finished 从日志结算、audit 有结果", async () => {
    const kuse = createKuse({
      repoRoot: REPO(),
      config: defaultConfig(),
      dataRoot: DATA(),
      ids: sequentialIds("t"),
      clock: fakeClock(),
    });

    const handle = await kuse.startRun({
      goal: "这个仓库里有哪些 TODO？",
      model: "offline",
    });
    const events = await collect(handle.events);
    const finished = await handle.finished;

    expect(events[0]?.type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_completed");
    expect(finished.trace.stop.kind).toBe("completed");
    if (finished.trace.stop.kind === "completed") {
      expect(finished.trace.stop.status).toBe("complete");
    }
    // audit 从日志读：离线剧本交付的结论带证据
    expect(finished.audit).not.toBeNull();
    expect(finished.audit?.total).toBeGreaterThan(0);

    // 只读门面：同一份日志的另一只眼
    const trace = await kuse.trace(handle.sessionId, handle.runId);
    expect(trace.stop.kind).toBe("completed");
    const audit = await kuse.audit(handle.sessionId, handle.runId);
    expect(audit?.total).toBe(finished.audit?.total);
    expect(await kuse.sessions()).toContain(handle.sessionId);
  });

  it("startRun 往一个不存在的会话里塞 Run → 拒绝（不悄悄造一个）", async () => {
    const kuse = createKuse({
      repoRoot: REPO(),
      config: defaultConfig(),
      dataRoot: DATA(),
      ids: sequentialIds("t"),
      clock: fakeClock(),
    });

    await expect(
      kuse.startRun({ goal: "任务", model: "offline", sessionId: "no-such-session" }),
    ).rejects.toThrow(/不存在/);
  });

  it("空任务文本 → 拒绝", async () => {
    const kuse = createKuse({
      repoRoot: REPO(),
      config: defaultConfig(),
      dataRoot: DATA(),
      ids: sequentialIds("t"),
      clock: fakeClock(),
    });

    await expect(kuse.startRun({ goal: "   ", model: "offline" })).rejects.toThrow(/任务文本为空/);
  });

  it("storeInsideRepo：仓库内的数据目录按相对路径返回，仓库外是 null", () => {
    expect(storeInsideRepo(join(root, "repo"), join(root, "repo", "runs"))).toBe("runs");
    expect(storeInsideRepo(join(root, "repo"), join(root, "data"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 挂起-恢复全链路（装配层的 answer 门面）
// ---------------------------------------------------------------------------

describe("createKuse.answer：挂起 → 应答 → 恢复", () => {
  /** 每个测试一份独立的数据目录：runId 是顺序 id，共享目录会让两份日志撞车。 */
  async function freshData(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "kuse-bootstrap-data-"));
    process.on("exit", () => void rm(dir, { recursive: true, force: true }));
    return dir;
  }

  /** 用脚本化模型把一次 Run 挂在"等人"侧（挂在 store 的日志里）。 */
  async function hangRun(dataDir: string): Promise<{
    sessionId: string;
    runId: string;
  }> {
    const askHuman: Decision = { kind: "ask_human", question: "验收标准是什么？" };
    const store = createSessionStore({
      rootDir: dataDir,
      ids: sequentialIds("t"),
      clock: fakeClock(),
    });
    const session = await store.createSession();
    const task: Task = {
      id: `task_${session.id}`,
      goal: "这个仓库的验收标准是什么？",
      repoRoot: REPO(),
      checks: [],
    };
    const started = await store.startRun(session.id, task);
    const runner = createToolRunner({ tools: fakeTools(READS), clock: fakeClock() });
    const runtime = createRuntime({
      model: scriptedModel([askHuman]),
      ...runner.toolDeps(),
      log: started.log,
      ids: started.ids,
      clock: fakeClock(),
      modelName: "fake-model",
      collectMissingMaterial,
    });
    const events = await collect(runtime.run(task));
    expect(events.at(-1)?.type).toBe("human_input_requested");
    return { sessionId: session.id, runId: started.runId };
  }

  it("answer 恢复挂起的 Run：恢复段走离线剧本，终态 complete，日志连续", async () => {
    const dataDir = await freshData();
    const kuse = createKuse({
      repoRoot: REPO(),
      config: defaultConfig(),
      dataRoot: dataDir,
      ids: sequentialIds("t"),
      clock: fakeClock(),
    });
    const hung = await hangRun(dataDir);

    const handle = await kuse.answer(hung.sessionId, hung.runId, "写在 notes/spec.md");
    const events = await collect(handle.events);
    const finished = await handle.finished;

    // 恢复段的第一、二条事件
    expect(events[0]?.type).toBe("human_input_received");
    expect(events[1]?.type).toBe("run_resumed");
    expect(events.at(-1)?.type).toBe("run_completed");
    expect(finished.trace.stop.kind).toBe("completed");

    // 全量日志（挂起段 + 恢复段）可被只读门面重放
    const trace = await kuse.trace(hung.sessionId, hung.runId);
    expect(trace.question).toBe("验收标准是什么？");
  });

  it("answer 指向不存在的 Run → ResumeError{run_not_found}", async () => {
    const kuse = createKuse({
      repoRoot: REPO(),
      config: defaultConfig(),
      dataRoot: await freshData(),
      ids: sequentialIds("t"),
      clock: fakeClock(),
    });

    await expect(kuse.answer("no-session", "no-run", "回答")).rejects.toThrowError(ResumeError);
  });
});
