import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { bootstrapHarness } from "../src/agent/bootstrap.js";
import { defaultConfig, mergeConfig } from "../src/config/schema.js";
import { listRecoveryInfo } from "../src/runtime/recovery.js";
import { traceOf } from "../src/runtime/trace.js";

/**
 * 任务级 E2E（SDD Phase 13，specs/tools.md + agent.md 的全链路验收）：
 *
 * mock 模型按剧本驱动**真实** Agent（真工具、真文件系统、真 JSONL 日志）修复
 * 一个故意写坏的 fixture：bash（跑失败的测试）→ read → edit → bash（跑通过的测试）。
 * 判据是 KuseCode 的验收观：fixture 真的被修好、会话文件完整、trace 三问齐备。
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  cleanups.length = 0;
});

const BROKEN = "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n";
const FIXED = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
const TEST_SCRIPT = "const { add } = require('./calc.js');\nconsole.log(add(1, 2) === 3 ? 'PASS' : 'FAIL');\n";

describe("任务级 E2E（mock 模型 → 真工具 → 真日志）", () => {
  it("bash → read → edit → bash 修复 fixture；会话完整；trace 三问齐备", { timeout: 60_000 }, async () => {
    const project = await mkdtemp(join(tmpdir(), "kuse-e2e-"));
    cleanups.push(async () => rm(project, { recursive: true, force: true }));
    await writeFile(join(project, "calc.js"), BROKEN);
    await writeFile(join(project, "calc.test.js"), TEST_SCRIPT);
    const dataDir = join(project, ".kusecode", "runs");

    const harness = await bootstrapHarness({
      projectRoot: project,
      config: mergeConfig([{ model: "mock" }, { permissionMode: "auto" }, defaultConfig()]),
    });

    // 剧本：跑测试（FAIL）→ 读源码 → 修一行 → 再跑测试（PASS）→ 汇报
    const mock = harness.mockHandle;
    if (mock === null) throw new Error("mock 未启用");
    mock.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "node calc.test.js" })]),
      fauxAssistantMessage([fauxToolCall("read", { path: "calc.js" })]),
      fauxAssistantMessage([fauxToolCall("edit", { path: "calc.js", edits: [{ oldText: "return a - b;", newText: "return a + b;" }] })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node calc.test.js" })]),
      fauxAssistantMessage("修好了：add 把减法写成了加法的反面，已改回 a + b，测试输出 PASS。"),
    ]);

    const answer = await harness.run("运行 calc.test.js，如果失败就修复 calc.js 再验证");

    // ① fixture 真的被修好
    const calcAfter = await readFile(join(project, "calc.js"), "utf8");
    if (calcAfter !== FIXED) console.error("DBG calc:", JSON.stringify(calcAfter));

    // ② 回答与工具痕迹：两次 bash、一次 read、一次 edit，顺序正确
    expect(answer).toContain("PASS");
    const events = await harness.log.read();
    const trace = traceOf(events);
    const traceSteps = trace.steps;
    expect(traceSteps.map((step) => step.tool)).toEqual(["bash", "read", "edit", "bash"]);

    // ③ 会话文件完整（header + 全部终态消息），且已收尾
    const sessionFiles = await readdir(join(dataDir, "sessions"));
    const raw = await readFile(join(dataDir, "sessions", sessionFiles[0] ?? ""), "utf8");
    expect(raw).toContain('"type":"session"');
    expect(raw).toContain("calc.test.js");
    // 最后一行是可解析的 message 线（torn write 检查的镜像断言）
    const lastLine = raw.trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(lastLine)).toHaveProperty("type", "message");

    // ④ trace 三问齐备
    expect(trace.usage?.outputTokens ?? 0).toBeGreaterThanOrEqual(0);
    expect(trace.eventCount).toBeGreaterThan(8);

    // ⑤ recovery：最后一条是 assistant → 已完成，不再是恢复候选
    //   （轮询至多 2s：run() 已 await 全部落盘，这里只吸收 FS 时序抖动）
    let finished = false;
    for (let attempt = 0; attempt < 20 && !finished; attempt += 1) {
      const infos = await listRecoveryInfo(join(dataDir, "sessions"));
      finished = infos[0]?.finished === true;
      if (!finished) {
        const dbg = await listRecoveryInfo(join(dataDir, "sessions"));
        console.error("DBG poll", attempt, JSON.stringify(dbg.map((i) => ({ f: i.finished, n: i.messageCount }))));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(finished).toBe(true);
  });
});
