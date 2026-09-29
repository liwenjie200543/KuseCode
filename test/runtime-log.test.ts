import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { EventLog, eventLogFor } from "../src/runtime/log.js";
import { traceOf } from "../src/runtime/trace.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kuse-log-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("EventLog（Runtime Reliability 的落盘）", () => {
  it("追加后读回同一条事件；seq 自动接续", async () => {
    const log = eventLogFor(dir, "s1");
    await log.append({ type: "run_started", goal: "任务" });
    await log.append({ type: "tool_call", tool: "read" });

    const events = await log.read();
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[0]?.type).toBe("run_started");
    expect(events[1]?.type).toBe("tool_call");
  });

  it("torn write（没有换行符的残骸）被跳过并在下一次追加前清除", async () => {
    const file = join(dir, "sessions", "s2.jsonl");
    const log = new EventLog(file);
    await log.append({ type: "run_started" });
    // 模拟写一半崩溃：追加一行没有换行符的残骸
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, '{"seq":1,"type":"tool_ca');

    const events = await log.read();
    expect(events.map((e) => e.seq)).toEqual([0]); // 残骸不是历史

    await log.append({ type: "tool_call", tool: "read" }); // 先清残骸再追加
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain("tool_ca\n");
    expect((await log.read()).map((e) => e.seq)).toEqual([0, 1]);
  });

  it("不同会话的日志互不串扰", async () => {
    await eventLogFor(dir, "a").append({ type: "run_started" });
    const b = eventLogFor(dir, "b");
    expect((await b.read()).length).toBe(0);
    await b.append({ type: "run_started" });
    expect((await eventLogFor(dir, "a").read()).length).toBe(1);
  });
});

describe("traceOf（日志的纯投影）", () => {
  it("三问齐备：干了什么（steps）、错误、花了多少（usage）", async () => {
    const log = eventLogFor(dir, "s3");
    await log.append({ type: "run_started", goal: "任务" });
    await log.append({ type: "tool_call", tool: "read", args: { path: "a.ts" } });
    await log.append({ type: "error", message: "文件不存在" });
    await log.append({
      type: "message_end",
      role: "assistant",
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
    });

    const trace = traceOf(await log.read());
    expect(trace.steps).toEqual([{ tool: "read", args: { path: "a.ts" } }]);
    expect(trace.errors).toEqual(["文件不存在"]);
    expect(trace.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    expect(trace.eventCount).toBe(4);
  });

  it("空日志：usage 是 null（未知，不是零）", () => {
    const trace = traceOf([]);
    expect(trace.usage).toBeNull();
    expect(trace.eventCount).toBe(0);
  });
});
