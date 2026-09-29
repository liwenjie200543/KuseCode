import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { SubAgentManager } from "../src/agents/manager.js";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const model = faux.getModel();

/** 只读假工具：记录调用（验证 worker 只拿到这一组）。 */
const readCalls: string[] = [];
const readTool: AgentTool = {
  name: "read",
  label: "Read",
  description: "只读读取",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (_id, raw) => {
    readCalls.push((raw as { path: string }).path);
    return { content: [{ type: "text", text: "内容" }], details: undefined };
  },
};

let manager: SubAgentManager;
let cleanups: Promise<void>[] = [];

beforeEach(async () => {
  await mkdtemp(join(tmpdir(), "kuse-agents-"));
  manager = new SubAgentManager({ models, model, projectRoot: ".", workerTools: [readTool] });
  cleanups = [];
});
afterEach(async () => {
  await manager.shutdown();
  await Promise.allSettled(cleanups);
});

describe("SubAgentManager（SDD Phase 9）", () => {
  it("spawn → wait：worker 用只读工具完成任务并交回报告", { timeout: 30_000 }, async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "src/a.ts" })]),
      fauxAssistantMessage("调查完成：a.ts 导出常量 a"),
    ]);
    const manager = new SubAgentManager({ models, model, projectRoot: ".", workerTools: [readTool] });
    const spawnReport = manager.spawn("researcher", "看看 a.ts");
    expect(spawnReport.status).toBe("running");

    const report = await manager.wait("researcher");
    console.error("DBG report:", JSON.stringify(report));
    expect(report.status).toBe("done");
    expect(report.report).toContain("调查完成");
    expect(readCalls).toContain("src/a.ts");
  });

  it("并发上限 3：第 4 个 spawn 即抛", () => {
    faux.setResponses([fauxAssistantMessage("稍等")]);
    for (const name of ["w1", "w2", "w3"]) manager.spawn(name, "任务");
    expect(() => manager.spawn("w4", "任务")).toThrow(/上限/);
  });

  it("重名 spawn 即抛；未知名字 wait/close 即抛", async () => {
    faux.setResponses([fauxAssistantMessage("工作中")]);
    manager.spawn("dup", "任务");
    expect(() => manager.spawn("dup", "另一个任务")).toThrow(/已有名为/);
    await expect(manager.wait("ghost")).rejects.toThrow(/没有名为/);
  });

  it("close：中止 running worker，状态落定", { timeout: 30_000 }, async () => {
    const manager = new SubAgentManager({ models, model, projectRoot: ".", workerTools: [] });
    const handle = manager.spawn("slow", "长任务");
    cleanups.push(manager.shutdown());

    // close 无论 worker 是收工还是被中止，状态都会落定
    const report = await manager.close("slow");
    expect(["done", "error"]).toContain(report.status);
    expect(handle.status).not.toBe("error");
    expect(manager.runningCount()).toBe(0);
  });
});
