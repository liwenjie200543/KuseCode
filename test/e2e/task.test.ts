import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createKuse } from "../../src/bootstrap/index.js";
import { defaultConfig } from "../../src/config/loader.js";
import { replayAgentState, runStatusOf } from "../../src/runtime/replay.js";
import type { AgentEvent, Task } from "../../src/core/types.js";

/**
 * 任务级 e2e（SDD T16，Spec FR-6.1）——装配层的全链路验收。
 *
 * 它与 golden 的分工：golden 钉"语义不许悄悄变"（双路径逐字节），
 * 这里钉"装配全链路真的能干活"：真 fixture 仓库、真工具、真文件系统、
 * 真日志文件，唯一假的是模型（离线剧本）。判据是 KuseCode 自己的验收观：
 *
 * 1. 报告交付（终态 complete）；
 * 2. **每条论断通过证据核对**（auditRun：有依据、且依据真的被看到过）；
 * 3. 日志可回放（状态从事件重建）；
 * 4. trace 三问齐备：调用了什么、为什么停、花了多少。
 */

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kuse-e2e-"));
  // fixture：一个有真实事实结构的小仓库（TODO 在两处，其余是噪声）。
  await mkdir(join(root, "repo", "src"), { recursive: true });
  await writeFile(
    join(root, "repo", "README.md"),
    "# 演示仓库\n\nTODO: 把导出开关接上（见 src/app.ts）。\n",
  );
  await writeFile(
    join(root, "repo", "src", "app.ts"),
    "export function run(): void {\n  // TODO: 开关还没有接进来。\n}\n",
  );
  await writeFile(join(root, "repo", "src", "util.ts"), "export const version = \"1.0.0\";\n");
  await mkdir(join(root, "data"), { recursive: true });
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("任务级 e2e：真装配、真工具、真日志", () => {
  it("离线剧本驱动全链路：报告交付、论断全部有据、日志可回放、trace 三问齐备", async () => {
    const kuse = createKuse({
      repoRoot: join(root, "repo"),
      config: defaultConfig(),
      dataRoot: join(root, "data"),
    });

    const handle = await kuse.startRun({
      goal: "这个仓库里有哪些 TODO？",
      model: "offline",
    });
    const events: AgentEvent[] = [];
    for await (const event of handle.events) events.push(event);
    const finished = await handle.finished;

    // ① 报告交付：终态 complete，结论非空
    expect(finished.trace.stop.kind).toBe("completed");
    if (finished.trace.stop.kind !== "completed") return;
    expect(finished.trace.stop.status).toBe("complete");
    expect(finished.trace.report?.summary.length ?? 0).toBeGreaterThan(0);

    // ② 证据核对：有论断、每条论断有依据、每条依据都真的被看到过
    expect(finished.audit).not.toBeNull();
    expect(finished.audit?.total).toBeGreaterThan(0);
    expect(finished.audit?.supported).toBe(finished.audit?.total);
    expect(finished.audit?.unsupported).toEqual([]);
    expect(finished.audit?.conclusive).toBe(true);
    // 审计的"ok"还包括"没有两手空空的论断"——离线剧本不省略证据。
    expect(finished.audit?.unbacked).toEqual([]);

    // ③ 日志可回放：状态从事件重建，恢复语义之外的一切照旧
    const task: Task = {
      id: `task_${handle.sessionId}`,
      goal: "这个仓库里有哪些 TODO？",
      repoRoot: join(root, "repo"),
      checks: [],
    };
    const state = replayAgentState(events, task);
    expect(state.iteration).toBeGreaterThan(0);
    expect(state.pendingQuestion).toBeNull();
    expect(runStatusOf(events)).toBe("completed");

    // ④ trace 三问：干了什么（步骤）、为什么停（completed）、花了多少（有账目）
    expect(finished.trace.steps.length).toBeGreaterThan(0);
    expect(finished.trace.usage).not.toBeNull();
    expect(finished.trace.usage?.toolCalls).toBeGreaterThan(0);
  });
});
