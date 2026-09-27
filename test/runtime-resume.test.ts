import { describe, expect, it } from "vitest";

import type { AgentEvent, Decision, Task } from "../src/core/types.js";
import { sequentialIds } from "../src/runtime/ids.js";
import { isRunOver, replayAgentState, runStatusOf } from "../src/runtime/replay.js";
import { ResumeError, createRuntime } from "../src/runtime/run-agent.js";
import { memoryRunLog } from "../src/runtime/run-log.js";
import type { RunLog } from "../src/runtime/run-log.js";
import { collectMissingMaterial, createToolRunner } from "../src/runtime/tool-runner.js";
import { scriptedModel } from "../src/testing/fake-model.js";
import { fakeClock, fakeTools } from "../src/testing/fake-tools.js";
import type { FakeToolBehavior } from "../src/testing/fake-tools.js";

// ---------------------------------------------------------------------------
// 夹具：一次会挂起的 Run，与一段会接着跑完的脚本
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-9",
  goal: "挂起的 Run 能不能从同一个日志上接着跑完？",
  repoRoot: "/repo",
  checks: ["恢复后的事件接在原日志尾部，sequence 连续"],
};

const callTool = (name: string, args: Record<string, unknown>): Decision => ({
  kind: "call_tool",
  intent: { name, args },
});
const respond = (summary: string): Decision => ({
  kind: "respond",
  report: { summary, claims: [] },
});
const askHuman = (question: string): Decision => ({ kind: "ask_human", question });

const READS: Readonly<Record<string, FakeToolBehavior>> = {
  read_file: { value: "export function reduce() {}", error: null },
};

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`缺少${what}`);
  return value;
}

interface Hung {
  readonly events: AgentEvent[];
  readonly runId: string;
  readonly log: RunLog;
  readonly runtime: ReturnType<typeof createRuntime>;
}

/** 跑到挂起为止：脚本只有一条 ask_human，恢复段消耗余下的脚本。 */
async function hungRun(script: readonly Decision[]): Promise<Hung> {
  const log = memoryRunLog();
  const runner = createToolRunner({ tools: fakeTools(READS), clock: fakeClock() });
  const runtime = createRuntime({
    model: scriptedModel(script),
    ...runner.toolDeps(),
    log,
    ids: sequentialIds("t"),
    clock: fakeClock(),
    modelName: "fake-model",
    collectMissingMaterial,
  });

  const events: AgentEvent[] = [];
  for await (const event of runtime.run(task)) events.push(event);
  return {
    events,
    runId: must(events[0], "第一条事件").runId,
    log,
    runtime,
  };
}

// ---------------------------------------------------------------------------
// 一、恢复的全链路：挂起 → 应答 → 恢复 → 完成
// ---------------------------------------------------------------------------

describe("resume：同一条日志上的新起点", () => {
  it("恢复后循环继续，终态 complete，事件全部接在原日志尾部", async () => {
    const hung = await hungRun([askHuman("要我看哪个文件？"), callTool("read_file", { path: "src/a.ts" }), respond("看完了")]);
    expect(hung.events.at(-1)?.type).toBe("human_input_requested");
    expect(runStatusOf(hung.events)).toBe("awaiting_human");

    const resumed: AgentEvent[] = [];
    for await (const event of must(hung.runtime.resume, "resume 入口")({
      runId: hung.runId,
      task,
      events: hung.events,
      answer: "看 src/a.ts",
    })) {
      resumed.push(event);
    }

    // 恢复段的第一、二条事件：回答与继续。
    expect(resumed[0]?.type).toBe("human_input_received");
    expect(resumed[0]?.type === "human_input_received" && resumed[0].input).toBe("看 src/a.ts");
    expect(resumed[1]?.type).toBe("run_resumed");
    // 终态 complete，退出前有账目（段内幂等闸门各报一次，最后一条是累计）。
    expect(resumed.at(-1)?.type).toBe("run_completed");

    // 全量日志（原前缀 + 恢复段）是一条连续前缀，回放重建出的状态没有待答问题。
    const full = [...hung.events, ...resumed];
    for (const [index, event] of full.entries()) {
      expect(event.sequence, `第 ${index} 条事件的 sequence`).toBe(index);
    }
    const state = replayAgentState(full, task);
    expect(state.pendingQuestion).toBeNull();
    expect(state.transcript.at(-1)?.role).toBe("assistant");
    expect(runStatusOf(full)).toBe("completed");
    expect(isRunOver(runStatusOf(full))).toBe(true);
  });

  it("挂起前的旧前缀一字不动：恢复段不追加任何 retroactive 修改", async () => {
    const hung = await hungRun([askHuman("继续吗？"), respond("继续了")]);
    const snapshot: string[] = hung.events.map((event) => JSON.stringify(event));

    const resumed: AgentEvent[] = [];
    for await (const event of must(hung.runtime.resume, "resume 入口")({
      runId: hung.runId,
      task,
      events: hung.events,
      answer: "继续",
    })) {
      resumed.push(event);
    }

    for (const [index, line] of snapshot.entries()) {
      expect(JSON.stringify(hung.events[index])).toBe(line);
    }
    expect(hung.events.length + resumed.length).toBeGreaterThan(snapshot.length);
  });

  it("恢复段的账目是累计的：toolCalls = 挂起前 + 恢复段", async () => {
    // 挂起前发生过一次工具调用（有账），恢复后再调一次。
    const hung = await hungRun([
      callTool("read_file", { path: "src/before.ts" }),
      askHuman("还读吗？"),
      callTool("read_file", { path: "src/after.ts" }),
      respond("读完了"),
    ]);
    const preUsage = hung.events.find((event) => event.type === "usage_reported");
    expect(preUsage?.type === "usage_reported" && preUsage.usage.toolCalls).toBe(1);

    const resumed: AgentEvent[] = [];
    for await (const event of must(hung.runtime.resume, "resume 入口")({
      runId: hung.runId,
      task,
      events: hung.events,
      answer: "再读一次",
    })) {
      resumed.push(event);
    }

    // 挂起段报过一次（toolCalls=1）；恢复段报累计（toolCalls=2）。trace 读最后一条。
    const lastUsage = [...resumed].reverse().find((event) => event.type === "usage_reported");
    expect(lastUsage?.type === "usage_reported" && lastUsage.usage.toolCalls).toBe(2);
    // 假模型不报 token：两段的输入输出都是"未知"，累计仍然是未知，不是 0。
    expect(lastUsage?.type === "usage_reported" && lastUsage.usage.inputTokens).toBeNull();
    // durationMs 从**原** run_started 起算（fakeClock 步进，累计墙钟）。
    const startedAt = hung.events[0]?.timestamp ?? 0;
    const finalEvent = resumed.at(-1);
    expect(finalEvent !== undefined && finalEvent.timestamp >= startedAt).toBe(true);
  });

  it("恢复段内挂起再一次（二次 ask_human）：账目再次累计，人可以继续接话", async () => {
    const hung = await hungRun([
      askHuman("第一个问题？"),
      askHuman("第二个问题？"),
      respond("都答完了"),
    ]);
    const first: AgentEvent[] = [];
    for await (const event of must(hung.runtime.resume, "resume 入口")({
      runId: hung.runId,
      task,
      events: hung.events,
      answer: "第一个回答",
    })) {
      first.push(event);
    }
    // 恢复段又挂起（第二个问题）。
    expect(first.at(-1)?.type).toBe("human_input_requested");

    const second: AgentEvent[] = [];
    for await (const event of must(hung.runtime.resume, "resume 入口")({
      runId: hung.runId,
      task,
      events: [...hung.events, ...first],
      answer: "第二个回答",
    })) {
      second.push(event);
    }
    expect(second.at(-1)?.type).toBe("run_completed");

    const full = [...hung.events, ...first, ...second];
    for (const [index, event] of full.entries()) {
      expect(event.sequence).toBe(index);
    }
  });

  it("恢复入口被取消：回答已入日志，Run 以 run_cancelled 收场（不是失败）", async () => {
    const hung = await hungRun([askHuman("继续吗？"), respond("继续了")]);
    const controller = new AbortController();
    controller.abort();

    const resumed: AgentEvent[] = [];
    for await (const event of must(hung.runtime.resume, "resume 入口")(
      { runId: hung.runId, task, events: hung.events, answer: "继续" },
      controller.signal,
    )) {
      resumed.push(event);
    }

    // 回答与继续已经写进日志（它们在取消检查之前就已经是事实），
    // 随后循环的第一次预算检查把它停下。emitStop 先报账（取消也要报账——
    // 钱是在取消之前花掉的），再落 run_cancelled。
    expect(resumed.map((event) => event.type)).toEqual([
      "human_input_received",
      "run_resumed",
      "usage_reported",
      "run_cancelled",
    ]);
    // 这次的账目是累计的（挂起段报过 0 次工具调用 + 恢复段 0 次 = 0）。
    const usage = resumed.find((event) => event.type === "usage_reported");
    expect(usage?.type === "usage_reported" && usage.usage.toolCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 二、校验矩阵：任何拒绝都发生在第一条新事件之前
// ---------------------------------------------------------------------------

describe("resume 的类型化拒绝（FR-2.6）", () => {
  it("空回答 → empty_answer", async () => {
    const hung = await hungRun([askHuman("继续吗？"), respond("继续了")]);
    const resume = must(hung.runtime.resume, "resume 入口");

    expect(() => resume({ runId: hung.runId, task, events: hung.events, answer: "   " })).toThrowError(
      ResumeError,
    );
    try {
      resume({ runId: hung.runId, task, events: hung.events, answer: " " });
    } catch (error) {
      expect((error as ResumeError).code).toBe("empty_answer");
    }
  });

  it("一条事件都没有 → run_not_found", async () => {
    const hung = await hungRun([askHuman("继续吗？"), respond("继续了")]);
    const resume = must(hung.runtime.resume, "resume 入口");

    try {
      resume({ runId: hung.runId, task, events: [], answer: "回答" });
      expect.fail("应该抛出 ResumeError");
    } catch (error) {
      expect((error as ResumeError).code).toBe("run_not_found");
    }
  });

  it("不是挂起态（已完成 / 取消过）→ not_awaiting_human", async () => {
    const finished = await hungRun([respond("直接收工")]); // 没有挂起：run_completed
    const resume = must(finished.runtime.resume, "resume 入口");
    try {
      resume({ runId: finished.runId, task, events: finished.events, answer: "回答" });
      expect.fail("应该抛出 ResumeError");
    } catch (error) {
      expect((error as ResumeError).code).toBe("not_awaiting_human");
    }

    const hung = await hungRun([askHuman("继续吗？"), respond("继续了")]);
    const cancelled: AgentEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    for await (const event of must(hung.runtime.resume, "resume 入口")(
      { runId: hung.runId, task, events: hung.events, answer: "回答" },
      controller.signal,
    )) {
      cancelled.push(event);
    }
    try {
      resume({ runId: hung.runId, task, events: [...hung.events, ...cancelled], answer: "再答一次" });
      expect.fail("应该抛出 ResumeError");
    } catch (error) {
      expect((error as ResumeError).code).toBe("not_awaiting_human");
    }
  });

  it("日志坏了（sequence 有洞 / runId 混入 / 不从 run_started 开始）→ log_corrupted", async () => {
    const hung = await hungRun([askHuman("继续吗？"), respond("继续了")]);
    const resume = must(hung.runtime.resume, "resume 入口");

    // 有洞。
    const holed = hung.events.filter((event) => event.sequence !== 1);
    try {
      resume({ runId: hung.runId, task, events: holed, answer: "回答" });
      expect.fail("应该抛出 ResumeError");
    } catch (error) {
      expect((error as ResumeError).code).toBe("log_corrupted");
    }

    // runId 混入。
    try {
      resume({
        runId: hung.runId,
        task,
        events: [
          ...hung.events,
          { ...hung.events[0], runId: "别的-run", sequence: hung.events.length } as AgentEvent,
        ],
        answer: "回答",
      });
      expect.fail("应该抛出 ResumeError");
    } catch (error) {
      expect((error as ResumeError).code).toBe("log_corrupted");
    }

    // 不从 run_started 开始。
    try {
      resume({ runId: hung.runId, task, events: hung.events.slice(1), answer: "回答" });
      expect.fail("应该抛出 ResumeError");
    } catch (error) {
      expect((error as ResumeError).code).toBe("log_corrupted");
    }
  });

  it("所有拒绝都不写日志：失败不留痕", async () => {
    const hung = await hungRun([askHuman("继续吗？"), respond("继续了")]);
    const resume = must(hung.runtime.resume, "resume 入口");
    const beforeCount = (await hung.log.read(hung.runId)).length;

    for (const bad of [
      () => resume({ runId: hung.runId, task, events: hung.events, answer: "" }),
      () => resume({ runId: hung.runId, task, events: [], answer: "回答" }),
      () => resume({ runId: hung.runId, task, events: hung.events.slice(1), answer: "回答" }),
    ]) {
      expect(bad).toThrowError(ResumeError);
    }

    expect((await hung.log.read(hung.runId)).length).toBe(beforeCount);
  });
});
