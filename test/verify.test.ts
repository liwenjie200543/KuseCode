/**
 * 证据核对 —— 「每条论断都指向证据」这句话的可执行形式。
 *
 * 这个文件分三层，对应这条链的三个环节，也对应三个"责任在哪里"的问题：
 *
 * 1. `auditReport`：**判定**。给一份结论与一份"看到过的材料"，谁对得上、谁对不上。
 *    纯函数，手搭输入就够——要测的是判据本身（包含 vs 重叠、路径归一化、去重）。
 * 2. `materialReader`：**抽取**。哪个字段是行号是**工具自己**的知识，所以这一层
 *    必须对着真工具跑，不能用假工具——假工具会把这个知识替换成测试自己写的那份。
 * 3. `auditRun`：**接线**。从事件日志里读出材料，再拿终态结论去对。这一层跑一次
 *    真的 Run（真工具、真文件系统、真执行层），因为"观测里到底存了什么"只有跑一遍
 *    才知道——而这次跑出来的正是下面那条"截断会毁掉抽取"的教训。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent, Decision, Evidence, MaterialRef, Report, Task } from "../src/core/types.js";
import { sequentialIds } from "../src/runtime/ids.js";
import { createRuntime } from "../src/runtime/run-agent.js";
import { memoryRunLog } from "../src/runtime/run-log.js";
import { createToolRunner } from "../src/runtime/tool-runner.js";
import { auditReport, auditRun } from "../src/runtime/verify.js";
import { scriptedModel } from "../src/testing/fake-model.js";
import { fakeClock } from "../src/testing/fake-tools.js";
import { OBSERVATION_CHAR_LIMIT } from "../src/runtime/tool-runner.js";
import { createRepoTools, materialReader } from "../src/tools/repo-tools.js";

// ---------------------------------------------------------------------------
// 夹具：一个真的临时仓库（被 mock 的文件系统证明不了任何关于路径的事）
// ---------------------------------------------------------------------------

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kusecode-verify-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# 标题\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行\n");
  await writeFile(join(root, "src", "loop.ts"), "export function reduce() {}\nexport function step() {}\n");
  // 单行足够长，让整份结果超出一条观测的字符上限——那正是"截断"这条路径的载体。
  await writeFile(join(root, "huge.txt"), `${"x".repeat(200)}\n`.repeat(60));
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

function evidence(path: string, lines: readonly [number, number] | null = null): Evidence {
  return { path, lines, excerpt: "…", provenance: { source: "read_file", at: 1 } };
}

function reportOf(claims: readonly { text: string; evidence: readonly Evidence[] }[]): Report {
  return { summary: "一句话总结", claims };
}

const viewed = (...refs: readonly MaterialRef[]): readonly MaterialRef[] => refs;

// ---------------------------------------------------------------------------
// 一、判定：哪些引用被材料支撑
// ---------------------------------------------------------------------------

describe("auditReport 的判据", () => {
  it("引用的区间被读过的窗口包含 → 支撑", () => {
    const audit = auditReport(
      reportOf([{ text: "循环把观察交给 reduce", evidence: [evidence("src/loop.ts", [1, 2])] }]),
      viewed({ path: "src/loop.ts", lines: [1, 2] }),
    );

    expect(audit.total).toBe(1);
    expect(audit.supported).toBe(1);
    expect(audit.unsupported).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.conclusive).toBe(true);
  });

  it("判据是**包含**，不是重叠：读了 1-2 行不能支撑引用 1-40 行", () => {
    const audit = auditReport(
      reportOf([{ text: "整个文件都是这样", evidence: [evidence("src/loop.ts", [1, 40])] }]),
      viewed({ path: "src/loop.ts", lines: [1, 2] }),
    );

    // 用重叠会放过这条，而"我读了那两行，所以我可以说整段话"正是要防的那种夸大。
    expect(audit.supported).toBe(0);
    expect(audit.unsupported).toEqual(["src/loop.ts:1-40"]);
    expect(audit.ok).toBe(false);
  });

  it("读过的窗口比引用的大 → 支撑", () => {
    const audit = auditReport(
      reportOf([{ text: "第一行是 reduce", evidence: [evidence("src/loop.ts", [1, 1])] }]),
      viewed({ path: "src/loop.ts", lines: [1, 2] }),
    );

    expect(audit.supported).toBe(1);
  });

  it("整文件级引用（lines 为 null）：只要这个路径被看到过就算支撑", () => {
    const audit = auditReport(
      reportOf([{ text: "这个文件存在", evidence: [evidence("README.md", null)] }]),
      viewed({ path: "README.md", lines: null }),
    );

    expect(audit.supported).toBe(1);
  });

  it("只列了目录（lines 为 null）不能支撑一个指向具体行的引用", () => {
    const audit = auditReport(
      reportOf([{ text: "第七行写着什么", evidence: [evidence("README.md", [7, 7])] }]),
      // `list_dir` 只能说"这个路径存在"，没有看到它的任何一行。
      viewed({ path: "README.md", lines: null }),
    );

    expect(audit.supported).toBe(0);
    expect(audit.unsupported).toEqual(["README.md:7-7"]);
  });

  it("路径归一化：`./a` 与 `a` 是同一个东西，分隔符也无关", () => {
    const audit = auditReport(
      reportOf([{ text: "同一行", evidence: [evidence("./src/loop.ts", [1, 2])] }]),
      viewed({ path: "src\\loop.ts", lines: [1, 2] }),
    );

    expect(audit.supported).toBe(1);
  });

  it("没人看过的路径 → 不支撑，而且同一个引用出现两次只报一次", () => {
    const never = evidence("src/nowhere.ts", [1, 3]);
    const audit = auditReport(
      reportOf([
        { text: "第一处引用", evidence: [never] },
        { text: "第二处又引了同一段", evidence: [never] },
      ]),
      viewed({ path: "src/loop.ts", lines: [1, 2] }),
    );

    expect(audit.total).toBe(2);
    expect(audit.unsupported).toEqual(["src/nowhere.ts:1-3"]);
  });

  it("一条论断没给依据 → 记在 unbacked 里，它不是错误但必须可见", () => {
    const audit = auditReport(
      reportOf([
        { text: "有依据的那条", evidence: [evidence("src/loop.ts", [1, 2])] },
        { text: "凭空的那条", evidence: [] },
      ]),
      viewed({ path: "src/loop.ts", lines: [1, 2] }),
    );

    expect(audit.unbacked).toEqual(["凭空的那条"]);
    expect(audit.ok).toBe(false);
    expect(audit.conclusive).toBe(true); // 这条不确定性与"看不清材料"无关
  });

  it("一切正常时 ok 为真——核对结果永远有答案，不是只在出错时才有", () => {
    const audit = auditReport(reportOf([{ text: "空引用也可以", evidence: [] }]), viewed());

    expect(audit.total).toBe(0);
    expect(audit.unsupported).toEqual([]);
    expect(audit.unbacked).toEqual(["空引用也可以"]);
  });
});

// ---------------------------------------------------------------------------
// 二、看不清的材料必须把结论降级，而不是变成一句指控
// ---------------------------------------------------------------------------

describe("截断的观测让核对失去确定性", () => {
  it("有截断时 ok 与 conclusive 都为假", () => {
    const audit = auditReport(
      reportOf([{ text: "引了一段", evidence: [evidence("src/loop.ts", [1, 2])] }]),
      viewed(), // 一条材料都抽不出来
      1, // 因为有一条观测被截断了
    );

    expect(audit.unsupported).toEqual(["src/loop.ts:1-2"]);
    expect(audit.ok).toBe(false);
    // 关键：`unsupported` 里的条目仍然值得看，但它们的意思从"没看过"降级成
    // "在我能读到的材料里没找到"。两种说法对应两种行动（改模型 vs 缩小结果）。
    expect(audit.conclusive).toBe(false);
  });

  it("没有截断时，同一条结论的核对是确定的", () => {
    const audit = auditReport(
      reportOf([{ text: "引了一段", evidence: [evidence("src/loop.ts", [1, 2])] }]),
      viewed(),
    );

    expect(audit.conclusive).toBe(true);
  });

  it("即便引用全部对得上，只要有截断就不算 ok（这次核对不完整）", () => {
    const audit = auditReport(
      reportOf([{ text: "引了一段", evidence: [evidence("src/loop.ts", [1, 2])] }]),
      viewed({ path: "src/loop.ts", lines: [1, 2] }),
      2,
    );

    expect(audit.supported).toBe(1);
    expect(audit.unsupported).toEqual([]);
    expect(audit.ok).toBe(false);
    expect(audit.truncatedObservations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 三、抽取：哪个字段是行号，只有工具自己知道
// ---------------------------------------------------------------------------

describe("materialReader 按工具名分派", () => {
  async function read(tool: string, args: Record<string, unknown>): Promise<readonly MaterialRef[]> {
    const box = createRepoTools({ repoRoot: root });
    const outcome = await box.port.execute({ name: tool, args }, new AbortController().signal);
    expect(outcome.error).toBeNull();
    return materialReader(box)({ tool, value: outcome.value });
  }

  it("read_file：路径 + 真正返回的那个行窗口", async () => {
    const refs = await read("read_file", { path: "src/loop.ts" });

    expect(refs).toEqual([{ path: "src/loop.ts", lines: [1, 2] }]);
  });

  it("read_file：窗口是请求的那一段，不是整个文件", async () => {
    const refs = await read("read_file", { path: "README.md", startLine: 3, endLine: 4 });

    expect(refs).toEqual([{ path: "README.md", lines: [3, 4] }]);
  });

  it("search_text：每条命中各是一个 [行, 行]", async () => {
    const refs = await read("search_text", { pattern: "export function" });

    expect(refs).toEqual([
      { path: "src/loop.ts", lines: [1, 1] },
      { path: "src/loop.ts", lines: [2, 2] },
    ]);
  });

  it("list_dir：只说路径存在，行号是 null", async () => {
    const refs = await read("list_dir", { path: "src" });

    expect(refs).toEqual([{ path: "src/loop.ts", lines: null }]);
  });

  it("不认识的工具名 → 空数组（保守但诚实：这次调用没有提供可引用的材料）", async () => {
    const box = createRepoTools({ repoRoot: root });
    const refs = materialReader(box)({ tool: "谁也不是", value: { path: "a", lines: 1 } });

    expect(refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 四、接线：从事件日志里读出材料，再拿结论去对
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-9",
  goal: "这个仓库里的 reduce 在哪？",
  repoRoot: "",
  checks: [],
};

/** 真跑一次：真仓库工具、真执行层、真事件日志。 */
async function liveRun(script: readonly Decision[]): Promise<readonly AgentEvent[]> {
  const box = createRepoTools({ repoRoot: root });
  const runner = createToolRunner({ tools: box.port, clock: fakeClock() });
  const runtime = createRuntime({
    model: scriptedModel(script),
    ...runner.toolDeps(),
    log: memoryRunLog(),
    ids: sequentialIds("v"),
    clock: fakeClock(),
    modelName: "fake-model",
  });

  const events: AgentEvent[] = [];
  for await (const event of runtime.run({ ...task, repoRoot: root })) events.push(event);
  return events;
}

const readerFor = (): ReturnType<typeof materialReader> =>
  materialReader(createRepoTools({ repoRoot: root }));

describe("auditRun 端到端", () => {
  it("引用它真的读到过的行 → 对得上", async () => {
    const events = await liveRun([
      { kind: "call_tool", intent: { name: "read_file", args: { path: "src/loop.ts" } } },
      {
        kind: "respond",
        report: reportOf([{ text: "reduce 在第 1 行", evidence: [evidence("src/loop.ts", [1, 1])] }]),
      },
    ]);

    const audit = auditRun(events, readerFor());
    expect(audit).not.toBeNull();
    expect(audit?.supported).toBe(1);
    expect(audit?.unsupported).toEqual([]);
    expect(audit?.ok).toBe(true);
    // 这次没有超长结果，所以核对是确定的。
    expect(audit?.conclusive).toBe(true);
  });

  it("引用一个谁也没读过的路径 → 那正是要露出来的伪造依据", async () => {
    const events = await liveRun([
      { kind: "call_tool", intent: { name: "read_file", args: { path: "src/loop.ts" } } },
      {
        kind: "respond",
        report: reportOf([
          { text: "loop.ts 第 1 行是 reduce", evidence: [evidence("src/loop.ts", [1, 1])] },
          { text: "其实还有个文件写着别的", evidence: [evidence("src/ghost.ts", [5, 5])] },
        ]),
      },
    ]);

    const audit = auditRun(events, readerFor());
    expect(audit?.supported).toBe(1);
    expect(audit?.unsupported).toEqual(["src/ghost.ts:5-5"]);
    expect(audit?.ok).toBe(false);
  });

  it("模型引用了自己只列过目录（没读过内容）的文件 → 不支撑", async () => {
    const events = await liveRun([
      { kind: "call_tool", intent: { name: "list_dir", args: { path: "src" } } },
      {
        kind: "respond",
        report: reportOf([{ text: "loop.ts 第 2 行写着 step", evidence: [evidence("src/loop.ts", [2, 2])] }]),
      },
    ]);

    const audit = auditRun(events, readerFor());
    expect(audit?.supported).toBe(0);
    expect(audit?.unsupported).toEqual(["src/loop.ts:2-2"]);
  });

  it("没有交付结论时返回 null，而不是一个「核对通过」的空表", async () => {
    const events = await liveRun([
      { kind: "call_tool", intent: { name: "read_file", args: { path: "src/loop.ts" } } },
      { kind: "ask_human", question: "要我看哪个目录？" },
    ]);

    expect(auditRun(events, readerFor())).toBeNull();
  });

  it("截断的观测被数出来（在抽取**之前**数，因为截断之后结构就没了）", async () => {
    const filename = "huge.txt";
    const events = await liveRun([
      { kind: "call_tool", intent: { name: "read_file", args: { path: filename } } },
      {
        kind: "respond",
        report: reportOf([{ text: "里面全是 x", evidence: [evidence(filename, [1, 1])] }]),
      },
    ]);

    // 先确认这次运行真的撞上了截断，否则下面那条断言可能在测一个不存在的情形。
    const truncated = events.filter(
      (event) => event.type === "observation_added" && event.observation.truncated,
    );
    expect(truncated.length, `结果应当超过 ${OBSERVATION_CHAR_LIMIT} 字符而被截断`).toBe(1);

    const audit = auditRun(events, readerFor());
    expect(audit?.truncatedObservations).toBe(1);
    // 引用看上去对不上（材料没被抽出来），但结论必须降级成"这次核不了"：
    // 把"我看不见"说成"你没做"是一条不成立的指控。
    expect(audit?.conclusive).toBe(false);
    expect(audit?.ok).toBe(false);
  });

  it("第一次调用失败、第二次成功：材料仍从成功的那些观测里来", async () => {
    const events = await liveRun([
      { kind: "call_tool", intent: { name: "read_file", args: { path: "src/ghost.ts" } } },
      { kind: "call_tool", intent: { name: "read_file", args: { path: "src/loop.ts" } } },
      {
        kind: "respond",
        report: reportOf([{ text: "reduce 在第 1 行", evidence: [evidence("src/loop.ts", [1, 1])] }]),
      },
    ]);

    const audit = auditRun(events, readerFor());
    expect(audit?.supported).toBe(1);
    expect(audit?.ok).toBe(true);
  });
});
