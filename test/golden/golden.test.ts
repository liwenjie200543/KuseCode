/**
 * golden transcripts —— 「一次 SDK 升级不会悄悄改变语义」的可执行形式。
 *
 * 这个文件把 `corpus.ts` 的 8 条语料跑三遍，然后对两种东西下断言：
 *
 * 1. **固定件**（`pinned/*.json`）：SDK 路产出的日志、trace、请求被写在磁盘上。
 *    再跑一次，只要有任何一处不一样就失败。它钉的是"语义没有静默变化"。
 * 2. **两条路的等价**：同一份语料，一次走假模型端口、一次走真 `pi-ai` 流，
 *    事件日志必须一致（唯二被抹掉的是 provider 才知道的 token 数，
 *    理由见 `harness.ts` 的文件头）。它钉的是"SDK 是可替换的"。
 *
 * ## 固定件失守时怎么办
 *
 * **先读差异，再决定。** 固定件变了有可能是三种事，而它们要三种不同的反应：
 *
 * - 我们**故意**改了语义 → 读一遍差异，确认它是想要的，然后重新录制；
 * - 我们**不小心**改了语义 → 这就是这个文件存在的意义，改回去；
 * - SDK 升级改了语义 → 也一样要看清楚，而它正是 README 第 10 行那句话要防的事。
 *
 * 重新录制是显式动作，不是顺手的事：
 *
 * ```bash
 * KUSE_RECORD_GOLDEN=1 node node_modules/vitest/vitest.mjs run test/golden
 * ```
 *
 * ## 为什么记录的是 SDK 路，而不是假模型路
 *
 * 因为 SDK 路是**生产路径**。记录它，固定件就同时盖住了 Core 的语义与适配器的翻译；
 * 而假模型路的价值在另一边——它是一个独立实现，用来证明"同一份语义换一个驱动方
 * 也成立"。两条都记会让"哪一份是标准答案"变成一个问题，那是多余的问题。
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { auditRun } from "../../src/runtime/verify.js";
import { materialReader, createRepoTools } from "../../src/tools/repo-tools.js";
import type { AgentEvent } from "../../src/core/types.js";
import { GOLDEN_CASES, caseNamed } from "./corpus.js";
import type { GoldenCase } from "./corpus.js";
import {
  comparable,
  decisionsOf,
  driveCore,
  driveSdk,
  lastRequest,
  maskRepo,
  stableJson,
  withFixture,
} from "./harness.js";

const PINNED = join(dirname(fileURLToPath(import.meta.url)), "pinned");

/** 录制模式。它是显式的，因为固定件是**被审阅过的**断言，不是随时可以刷新的缓存。 */
const RECORD = process.env["KUSE_RECORD_GOLDEN"] === "1";

type PinnedKind = "events" | "trace" | "request";

const KINDS: readonly PinnedKind[] = ["events", "trace", "request"];

function pinnedPath(name: string, kind: PinnedKind): string {
  return join(PINNED, `${name}.${kind}.json`);
}

/**
 * 第一处不同的行。
 *
 * 逐字节比对会给出一份几千行的红色输出，而人要看的是**第一处**——
 * 后面的一大片通常都是它引起的。所以这个函数存在，而不是直接 `toBe`。
 */
function firstDifference(actual: string, expected: string): string | null {
  const left = actual.split("\n");
  const right = expected.split("\n");
  const total = Math.max(left.length, right.length);
  for (let index = 0; index < total; index += 1) {
    if (left[index] !== right[index]) {
      return (
        `第 ${index + 1} 行起不同：\n` +
        `      跑出来：${left[index] ?? "<没有这一行>"}\n` +
        `      固定件：${right[index] ?? "<没有这一行>"}`
      );
    }
  }
  return null;
}

/** 把一件产物写成固定件（录制模式），或者与固定件比对（平常模式）。 */
async function checkPinned(
  c: GoldenCase,
  kind: PinnedKind,
  value: unknown,
  repoRoot: string,
): Promise<void> {
  const text = stableJson(maskRepo(value, repoRoot));
  const file = pinnedPath(c.name, kind);
  if (RECORD) {
    await mkdir(PINNED, { recursive: true });
    await writeFile(file, text, "utf8");
    return;
  }
  const expected = await readFile(file, "utf8");
  const diff = firstDifference(text, expected);
  expect(diff === null ? null : `${c.name}.${kind}.json 与跑出来的不一样：\n${diff}`).toBeNull();
}

/** 事件类型序列。等价性失败时，它比"两份 JSON 不一样"有用得多。 */
function typeSequence(events: readonly unknown[]): readonly unknown[] {
  return events.map((event) => (event as { readonly type?: unknown }).type);
}

/** 一次核对的结果必须存在：`auditRun` 用 `null` 表示"这次 Run 没有交付结论"。 */
function auditOf(audit: ReturnType<typeof auditRun>): NonNullable<ReturnType<typeof auditRun>> {
  if (audit === null) throw new Error("这条语料应当交付结论，所以核对必须有结果");
  return audit;
}

// ---------------------------------------------------------------------------
// 每一条语料：SDK 路 → 固定件；假模型路 → 同一条日志
// ---------------------------------------------------------------------------

describe("golden：每一条语料", () => {
  for (const c of GOLDEN_CASES) {
    it(`${c.name}：${c.pins}`, async () => {
      await withFixture(c.files, async (repoRoot) => {
        const sdk = await driveSdk(c, repoRoot);

        // ① 固定件：这是"语义有没有静默变化"的判据。
        await checkPinned(c, "events", sdk.events, repoRoot);
        await checkPinned(c, "trace", sdk.trace, repoRoot);
        await checkPinned(c, "request", lastRequest(sdk), repoRoot);

        // ② 确定性：同一条路跑两遍必须逐字节相同。它防的是隐藏的不确定性
        //    （遍历顺序、`Date.now` 泄漏、Map 迭代顺序）——那些东西会让上面两条
        //    断言变成掷骰子，而"偶尔失败"的测试等于没有测试。
        const again = await driveSdk(c, repoRoot);
        expect(
          stableJson(maskRepo(again.events, repoRoot)) === stableJson(maskRepo(sdk.events, repoRoot))
            ? null
            : "同一条路上跑两遍得到了不同的日志（有不来自语料的随机性）",
        ).toBeNull();

        // ③ 等价：换一个驱动方（假模型端口，没有 SDK），日志必须一样。
        const core = await driveCore(c, repoRoot);
        const coreEvents = comparable(maskRepo(core.events, repoRoot));
        const sdkEvents = comparable(maskRepo(sdk.events, repoRoot));

        // 先用**事件类型序列**比一次：它比"两份巨型 JSON 不一样"读得懂。
        // 比较用逐行字符串，是为了让失败信息把两条序列都打出来。
        expect(
          typeSequence(coreEvents)
            .map((type, index) => `${index} ${String(type)}`)
            .join("\n"),
        ).toBe(
          typeSequence(sdkEvents)
            .map((type, index) => `${index} ${String(type)}`)
            .join("\n"),
        );
        expect(decisionsOf(core.events)).toEqual(decisionsOf(sdk.events));
        expect(stableJson(coreEvents)).toBe(stableJson(sdkEvents));
      });
    });
  }

  it("取消落在模型请求中间：终态一致，但谁先发现取消决定了那一轮有没有 decision_made", async () => {
    // 这条测试不进语料、不写固定件——它在**语料的注释里被点名**（`corpus.ts` 的
    // `cancelAtCall`），钉的是一个真实的差别而不是一个缺陷：
    // 真流的 AbortSignal 是"流"自己看着的，请求被取消时以 `stopReason: "aborted"`
    // 收尾，取消在 `decide` 里面就被认出来（那一轮没有 decision_made）；
    // 假模型端口没有人看信号，它照常返回决策，取消落在下一个检查点上（有）。
    // 终态在两条路上都是 run_cancelled——差别只差那一条事件，必须有人看着它。
    const base = caseNamed("07-cancelled-external");
    // `exactOptionalPropertyTypes` 不许显式写 `undefined`，所以剥掉而不是覆盖。
    const { cancelAtTool: _notUsed, ...withoutCancelAtTool } = base;
    void _notUsed;
    const c: GoldenCase = { ...withoutCancelAtTool, cancelAtCall: 1 };
    await withFixture(c.files, async (repoRoot) => {
      const core = await driveCore(c, repoRoot);
      const sdk = await driveSdk(c, repoRoot);

      const terminalOf = (events: readonly AgentEvent[]): string => {
        const terminal = events.filter((event) =>
          ["run_completed", "run_failed", "run_cancelled", "human_input_requested"].includes(
            event.type,
          ),
        );
        expect(terminal, "终态事件恰好一条").toHaveLength(1);
        return (terminal[0] as { readonly type: string }).type;
      };
      expect(terminalOf(core.events)).toBe("run_cancelled");
      expect(terminalOf(sdk.events)).toBe("run_cancelled");

      // 差别就在这里：假模型路多交出了一次决策（它没能看见信号已经响了）。
      expect(decisionsOf(core.events)).toHaveLength(2);
      expect(decisionsOf(sdk.events)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 语料自己也要被看着：覆盖了哪些终局、有没有孤儿固定件
// ---------------------------------------------------------------------------

describe("golden：语料的覆盖面", () => {
  it("五种收场每一种都有语料：complete / partial / failed / cancelled / 挂起", async () => {
    const endings = new Map<string, string[]>();
    for (const c of GOLDEN_CASES) {
      const events = JSON.parse(await readFile(pinnedPath(c.name, "events"), "utf8")) as {
        readonly type: string;
        readonly status?: string;
      }[];
      const terminal = events.filter((event) =>
        ["run_completed", "run_failed", "run_cancelled", "human_input_requested"].includes(event.type),
      );
      // 一次 Run 恰好一个收场。零个说明日志停在没有结尾的地方，两个说明它自相矛盾。
      expect(terminal.map((event) => event.type), `${c.name} 的收场`).toHaveLength(1);
      const event = terminal[0];
      if (event === undefined) continue;
      const key = event.type === "run_completed" ? `completed/${event.status}` : event.type;
      endings.set(key, [...(endings.get(key) ?? []), c.name]);
    }

    // 少一种收场就意味着"那一种收场怎么写进日志"没有任何东西在看着。
    expect([...endings.keys()].sort()).toEqual([
      "completed/complete",
      "completed/partial",
      "human_input_requested",
      "run_cancelled",
      "run_failed",
    ]);
    expect(endings.get("completed/partial")?.length).toBeGreaterThanOrEqual(2);
  });

  it("固定件与语料一一对应：既没有孤儿，也没有缺件", async () => {
    const expected = GOLDEN_CASES.flatMap((c) => KINDS.map((kind) => `${c.name}.${kind}.json`)).sort();
    const actual = (await readdir(PINNED)).filter((name) => name.endsWith(".json")).sort();
    // 删掉一条语料而忘了删固定件，或者反过来，都会让"覆盖了哪些情况"变成一句空话。
    expect(actual).toEqual(expected);
  });

  it("固定件里不出现夹具的绝对路径", async () => {
    // 路径每次运行都不同。它一旦漏进固定件，比对就会以一种
    // "看起来像语义变化"的方式失败——而真正的问题是泄漏，不是语义。
    const temp = process.env["TEMP"] ?? process.env["TMPDIR"];
    for (const c of GOLDEN_CASES) {
      for (const kind of KINDS) {
        const text = await readFile(pinnedPath(c.name, kind), "utf8");
        expect(text.includes("kuse-golden-"), `${c.name}.${kind} 泄漏了夹具路径`).toBe(false);
        if (temp !== undefined && temp.length > 0) {
          expect(text.includes(temp), `${c.name}.${kind} 泄漏了临时目录`).toBe(false);
        }
      }
    }
    // 正向对照：泄漏检查必须真的有机会响。`request` 固定件里出现占位符，
    // 说明替换真的发生了——否则"没有泄漏"只是因为那里本来就没有路径。
    // 而它**只**出现在 request 里不是巧合：事件与 trace 里工具返回的都是
    // 仓库相对路径，`run_started` 也不带任务面字段——绝对路径只活在请求里。
    expect(await readFile(pinnedPath("01-complete-report", "request"), "utf8")).toContain("<repo:demo>");
    expect(await readFile(pinnedPath("01-complete-report", "events"), "utf8")).not.toContain("<repo:demo>");
    expect(await readFile(pinnedPath("01-complete-report", "trace"), "utf8")).not.toContain("<repo:demo>");
  });
});

// ---------------------------------------------------------------------------
// 步 9 的两个消费者（核对与缺失清单）也在语料上过一遍
//
// 它们不写固定件：核对的结果是**语义**，用三条写清楚的断言比一份两行的 JSON 更好读。
// ---------------------------------------------------------------------------

describe("golden：核对与缺失清单", () => {
  it("01：一条被支撑、一条没有依据，而「核对器不同意」的是零", async () => {
    const c = GOLDEN_CASES[0];
    if (c === undefined) throw new Error("语料的第一条不见了");
    await withFixture(c.files, async (repoRoot) => {
      const run = await driveCore(c, repoRoot);
      const audit = auditOf(auditRun(run.events, materialReader(createRepoTools({ repoRoot }))));
      // `total` 数的是**证据条数**，不是论断条数：一条没有依据的论断贡献的是
      // `unbacked` 一项，不贡献 `total`。这两个数字回答问题的方式不同。
      expect(audit.total).toBe(1);
      expect(audit.supported).toBe(1);
      expect(audit.unsupported).toHaveLength(0);
      // `evidence: []` 的那条**不是**"没看过的行"，而是"没有依据"——两个不同的状态。
      expect(audit.unbacked).toHaveLength(1);
      expect(audit.truncatedObservations).toBe(0);
      expect(audit.conclusive).toBe(true);
      // `ok` 的定义是"每条论断都给了依据、每条依据都对得上"（`verify.ts`）。
      // 这条语料**故意**让一条论断两手空空——所以 `ok` 必须是假。
      // 它在这儿是假，不是核对器错了：没有依据这件事必须可见，不可见才是错。
      expect(audit.ok).toBe(false);
    });
  });

  it("02：工具失败不改终态的形状，但它被点进了缺失清单", async () => {
    const c = GOLDEN_CASES[1];
    if (c === undefined) throw new Error("语料的第二条不见了");
    await withFixture(c.files, async (repoRoot) => {
      const run = await driveCore(c, repoRoot);
      expect(run.trace.stop.kind).toBe("completed");
      if (run.trace.stop.kind !== "completed") return;
      expect(run.trace.stop.status).toBe("partial");
      expect(run.trace.stop.missingMaterial).toHaveLength(1);
      expect(run.trace.stop.missingMaterial[0]).toContain("read_file");
      expect(run.trace.stop.missingMaterial[0]).toContain("invalid_args");
    });
  });

  it("03：截断让核对不敢下结论——「没看到」与「读到的东西里没有」是两回事", async () => {
    const c = GOLDEN_CASES[2];
    if (c === undefined) throw new Error("语料的第三条不见了");
    await withFixture(c.files, async (repoRoot) => {
      const run = await driveCore(c, repoRoot);
      const audit = auditOf(auditRun(run.events, materialReader(createRepoTools({ repoRoot }))));
      expect(audit.truncatedObservations).toBe(1);
      // 被截断的观测里结构已经没了，材料读不出来，所以那条断言"找不到"——
      // 但它不能被说成"没看过"：那是一次假指控。
      expect(audit.unsupported).toHaveLength(1);
      expect(audit.conclusive).toBe(false);
      expect(audit.ok).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 录制
// ---------------------------------------------------------------------------

describe("golden：录制", () => {
  it.skipIf(!RECORD)("录制模式写出的正好是完整的一套", async () => {
    const expected = GOLDEN_CASES.flatMap((c) => KINDS.map((kind) => `${c.name}.${kind}.json`)).sort();
    const actual = (await readdir(PINNED)).filter((name) => name.endsWith(".json")).sort();
    expect(actual).toEqual(expected);
  });
});
