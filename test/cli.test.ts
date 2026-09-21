/**
 * 产品面 —— 一个人怎么发起一次 Run，又怎么看懂它。
 *
 * 这个文件能存在，本身就是步 9 那条设计决定的证据：`main(argv, io)` 把
 * `process.argv` / `stdout` / `env` / `cwd` / SIGINT 都换成了参数，所以
 * **产品面也可以是可测的**——不需要起进程、不需要真终端，就能断言退出码、
 * stdout 的形状、以及凭据有没有流进日志。
 *
 * 三条主线：
 *
 * 1. **词汇**（`args.ts`）：「用户说了什么」可以逐条断言，与"我们做了什么"无关。
 * 2. **退出码**：它是「为什么停」的机器可读形式。10~13 是"Run 发生了但没走完"，
 *    2 是"Run 根本没发生"——把它们混成一个非零码，脚本就分不清"重试有用"
 *    与"重试之前得先改参数"。
 * 3. **脱敏的两个方向**（`src/core/redact.ts` 文件头那张表）：
 *    - 我们自己的凭据**不许**出现在输出里（终端与 CI 日志是另一个泄漏面）；
 *    - 被分析仓库里的秘密**必须**留在事件日志里（它是证据，改写它会让
 *      "这条论断指向这个文件的这一行"失效）。
 *
 * 最后一条是这个文件里最重要的一条，因为它同时断言了两件看起来矛盾的事，
 * 而只有把两句话放在一起看，才能说明它们不矛盾。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, HELP, flagOn, flagValue, main, parseArgs, unknownFlags } from "../src/cli/index.js";
import type { CliIo } from "../src/cli/index.js";
import { REDACTED } from "../src/core/redact.js";

// ---------------------------------------------------------------------------
// 夹具：一个真的临时仓库 + 一个把输出收起来的 IO
// ---------------------------------------------------------------------------

/** 仓库里写死的那个"秘密"。它是**材料**，所以它必须活着。它的形状像一把钥匙。 */
const REPO_KEY = "sk-repo-hardcoded-key-1234567890";
/**
 * 另一个仓库里的秘密，它**没有任何可辨认的形状**——于是只有"环境里恰好有这个值"
 * 那一路能把它认出来。用它来证明环境那一路真的接上了，而不是形状那一路在代劳。
 */
const PLAIN_SECRET = "plainpasswordvalue123";

let base = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "kusecode-cli-"));
  await mkdir(join(base, "repo", "src"), { recursive: true });
  // 两个"秘密"各占一行、且**都不含默认模式 `TODO`**：默认那次 Run 于是完全干净，
  // 而脱敏那两条用例可以拿同一份仓库、只换 `--pattern` 去撞它们。
  await writeFile(
    join(base, "repo", "src", "loop.ts"),
    `export function reduce() {} // TODO: 收窄类型\n// key: ${REPO_KEY}\nexport function step() {}\n`,
  );
  await writeFile(
    join(base, "repo", "src", "config.ts"),
    `// the password is ${PLAIN_SECRET}\nexport const port = 8080;\n`,
  );
  await writeFile(join(base, "repo", "README.md"), "# 说明\n这一行没有那个模式\n");

  // 第二个仓库：用来测"Run 读到自己的产物"那条路径（它的存储目录在它自己里面）。
  await mkdir(join(base, "repo-self", "src"), { recursive: true });
  await writeFile(
    join(base, "repo-self", "src", "loop.ts"),
    `export function reduce() {} // TODO: 收窄类型\nexport function step() {}\n`,
  );
});

afterAll(async () => {
  if (base !== "") await rm(base, { recursive: true, force: true });
});

interface Captured {
  readonly out: readonly string[];
  readonly err: readonly string[];
  outText(): string;
  errText(): string;
}

/**
 * 跑一次命令行，把退出码与两路输出一起交回来。它们必须一起看——
 * 退出码是结论，输出是那个结论的解释。
 *
 * `env` 默认给一个空的：真环境里有什么不该影响测试结果，而"凭据从环境解析"
 * 这件事需要它是一份**可指名**的输入，不是 `process.env` 的当前样子。
 */
async function cli(
  argv: readonly string[],
  overrides: Partial<CliIo> = {},
): Promise<{ code: number } & Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    env: {},
    cwd: base,
    ...overrides,
  };

  const code = await main(argv, io);
  return {
    code,
    out,
    err,
    outText: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// 一、词汇：参数怎么解析
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("`--name=value` 与 `--name value` 等价", () => {
    expect(flagValue(parseArgs(["--repo=src"]), "repo")).toBe("src");
    expect(flagValue(parseArgs(["--repo", "src"]), "repo")).toBe("src");
  });

  it("后面跟着另一个开关时是布尔开关，不会把下一个开关当成值", () => {
    const args = parseArgs(["--repo", "--json", "任务"]);

    expect(args.flags["repo"]).toBe(true);
    // 没声明词性时解析器只能按语法猜，而猜法是有代价的：`--json` 后面跟着一个
    // 普通词，它就被当成了取值选项。这正是 `valued` 存在的理由（下一条用例）。
    expect(args.flags["json"]).toBe("任务");
  });

  it("声明过词性之后，开关不再吃掉写在它后面的位置参数", () => {
    const without = parseArgs(["run", "--offline", "任务"]);
    // 猜错的后果：任务变成了 `--offline` 的值，于是 `--offline` 看起来没生效、
    // 而任务凭空消失——一次**不报错**的失败。
    expect(without.positionals).toEqual([]);
    expect(flagOn(without, "offline")).toBe(false);

    const with_ = parseArgs(["run", "--offline", "任务"], { valued: ["repo", "store"] });
    expect(flagOn(with_, "offline")).toBe(true);
    expect(with_.positionals).toEqual(["任务"]);
  });

  it("最后一个词是裸开关也当 `true`", () => {
    expect(flagOn(parseArgs(["--quiet"]), "quiet")).toBe(true);
  });

  it("第一个非选项词是子命令，其余是位置参数", () => {
    const args = parseArgs(["run", "这个仓库里", "有哪些 TODO"]);

    expect(args.command).toBe("run");
    expect(args.positionals).toEqual(["这个仓库里", "有哪些 TODO"]);
  });

  it("`--` 之后的一切都当位置参数（用来传以 `-` 开头的任务文本）", () => {
    const args = parseArgs(["run", "--", "--这是一个以横线开头的任务"]);

    expect(args.positionals).toEqual(["--这是一个以横线开头的任务"]);
    expect(args.flags).toEqual({});
  });

  it("空命令行：没有子命令也没有位置参数", () => {
    expect(parseArgs([])).toEqual({ command: null, positionals: [], flags: {} });
  });

  it("unknownFlags 点名拼错的那个选项", () => {
    const args = parseArgs(["run", "--sesion", "x", "--json"]);

    // 静默忽略拼错的选项会让用户以为 `--sesion` 生效了，而它被安静地丢掉。
    expect(unknownFlags(args, ["session", "json"])).toEqual(["sesion"]);
  });
});

// ---------------------------------------------------------------------------
// 二、帮助与用法错误：Run 根本没发生
// ---------------------------------------------------------------------------

describe("帮助与用法错误", () => {
  it("`kuse help` 印出用法并以 0 结束", async () => {
    const { code, outText } = await cli(["help"]);

    expect(code).toBe(EXIT.complete);
    expect(outText()).toBe(HELP);
  });

  it("什么都不给等价于 help（不是一次没有任务的 Run）", async () => {
    const { code, outText } = await cli([]);

    expect(code).toBe(EXIT.complete);
    expect(outText()).toBe(HELP);
  });

  it("`--help` 走到同一处", async () => {
    expect((await cli(["run", "--help"])).outText()).toBe(HELP);
  });

  it("不认识的子命令 → 2", async () => {
    const { code, errText } = await cli(["frobnicate"]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("不认识的子命令");
  });

  it("不认识的选项 → 2，而且点名到选项", async () => {
    const { code, errText } = await cli(["run", "任务", "--sesion", "x", "--offline"]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("--sesion");
  });

  it("没有任务文本 → 2（一个没有任务的 Run 只会产出一堆没人要的证据）", async () => {
    const { code, errText } = await cli(["run", "--offline"]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("没有任务文本");
  });

  it("没有模型 → 2，并把两条路都说清", async () => {
    const { code, errText } = await cli(["run", "任务"]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("--model faux");
    expect(errText()).toContain("KUSECODE_MODEL");
  });

  it("`--session` 指到一个不存在的会话 → 2（不顺手建一个）", async () => {
    const { code, errText } = await cli([
      "run",
      "任务",
      "--offline",
      "--session",
      "sess_nope",
      "--store",
      "store",
    ]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("不存在");
    // 而且没有顺手建一个：会话隔离不该在无人察觉的时候失效。
    expect((await cli(["sessions", "--store", "store"])).outText()).toContain("会话 0 个");
  });

  it("`--session` 给了一个不可能当 id 的名字 → 2，不是 3", async () => {
    // 这条守的是退出码那张表上的分界：一个手误（路径分隔符打进 id 里）是用法错误，
    // 脚本据此知道"改参数"，而不是"重试"。
    const { code, errText } = await cli([
      "run",
      "任务",
      "--offline",
      "--session",
      "a/b",
      "--store",
      "store",
    ]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("不存在");
  });

  it("要取值的选项被写成裸开关 → 2（不去猜「他想用默认值」）", async () => {
    const { code, errText } = await cli(["run", "任务", "--offline", "--store"]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("--store");
    expect(errText()).toContain("缺一个值");
  });

  it("开关不吃掉写在它后面的任务文本", async () => {
    // 只靠语法猜的话，`--offline` 会把 "这个仓库里有哪些 TODO？" 当成自己的值，
    // 于是任务凭空消失、`--offline` 看起来没生效——一次**不报错**的失败。
    // 位置很关键：那个开关**紧接着**就是任务文本（不是另一个开关）。
    const { code, outText } = await cli([
      "run",
      "--offline",
      "这个仓库里有哪些 TODO？",
      "--repo",
      "repo",
      "--store",
      "store-order",
      "--json",
    ]);

    expect(code).toBe(EXIT.complete);
    const { trace } = JSON.parse(outText()) as { trace: { steps: readonly { args: Record<string, unknown> }[] } };
    expect(trace.steps[1]?.args["pattern"]).toBe("TODO");
  });

  it("模型名不存在 → 2，而且 Run 没有开始（没有留下任何会话）", async () => {
    const { code, errText } = await cli([
      "run",
      "任务",
      "--model",
      "根本没有这个provider/模型",
      "--store",
      "store2",
    ]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("根本没有这个provider");
    // Run 没有发生 = 没有登记会话。用法错误不该在存储里留下痕迹。
    const listed = await cli(["sessions", "--store", "store2"]);
    expect(listed.outText()).toContain("会话 0 个");
  });
});

// ---------------------------------------------------------------------------
// 三、一次真的 Run：结论、trace、退出码
// ---------------------------------------------------------------------------

describe("kuse run（离线冒烟）", () => {
  const runOffline = (extra: readonly string[] = [], overrides: Partial<CliIo> = {}) =>
    cli(["run", "这个仓库里有哪些 TODO？", "--repo", "repo", "--store", "store", "--offline", ...extra], overrides);

  it("三件事都印出来：调用了什么、为什么停、花了多少", async () => {
    const { code, outText } = await runOffline();

    expect(code).toBe(EXIT.complete);
    const text = outText();
    expect(text).toContain("调用了什么");
    expect(text).toContain("为什么停");
    expect(text).toContain("结论");
    expect(text).toContain("证据核对");
    expect(text).toContain("花了多少");
    // 「为什么停」必须是码或状态名，不是一句含糊的"结束了"。
    expect(text).toContain("completed（有结论，材料齐）");
  });

  it("离线模式的身份被明说：它不是模型的结论", async () => {
    const { errText } = await runOffline();

    // 一次离线运行被误读成"Agent 的结论"是这个模式唯一的风险，所以它要说三遍：
    // stderr 一行、模型名里一个 `faux/` 前缀、报告第一句里再说一遍。
    expect(errText()).toContain("离线冒烟模式");
    expect(errText()).toContain("不是模型推理的结果");
  });

  it("退出码写进 stderr 的最后一行，脚本作者不必翻文档", async () => {
    const { errText } = await runOffline();

    expect(errText().trim().endsWith(`exit ${EXIT.complete}（complete）`)).toBe(true);
  });

  it("`--json`：stdout 恰好是一个 JSON 对象，别的一个字都没有", async () => {
    const { code, outText } = await runOffline(["--json"]);

    expect(code).toBe(EXIT.complete);
    const parsed = JSON.parse(outText()) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "audit",
      "eventsPath",
      "offline",
      "sessionId",
      "storeDir",
      "trace",
    ]);
    expect(parsed["offline"]).toBe(true);
  });

  it("`--json` 的形状：trace 回答三个问题，audit 说清证据对不对得上", async () => {
    const { outText } = await runOffline(["--json"]);
    const { trace, audit } = JSON.parse(outText()) as {
      trace: {
        status: string;
        steps: readonly { tool: string; status: string; args: Record<string, unknown> }[];
        stop: { kind: string; status: string };
        report: { claims: readonly unknown[] };
        usage: { toolCalls: number } | null;
        model: string | null;
      };
      audit: { supported: number; total: number; ok: boolean; conclusive: boolean };
    };

    expect(trace.status).toBe("completed");
    expect(trace.stop).toEqual({ kind: "completed", status: "complete", missingMaterial: [] });
    expect(trace.steps.map((step) => step.tool)).toEqual(["list_dir", "search_text", "read_file"]);
    expect(trace.steps[1]?.args).toEqual({ pattern: "TODO", maxMatches: 5 });
    expect(trace.report.claims).toHaveLength(2);
    expect(trace.usage?.toolCalls).toBe(3);
    expect(trace.model).toBe("faux/offline-script");

    // 离线流程引用的行都来自工具真的返回过的材料，所以核对必须通过——
    // 这条断言是"证据是真的"那句话在 CLI 这一层的落地。
    expect(audit.total).toBe(2);
    expect(audit.supported).toBe(2);
    expect(audit.ok).toBe(true);
    expect(audit.conclusive).toBe(true);
  });

  it("事件日志真的落盘了，而且与 trace 说的是同一次 Run", async () => {
    const { outText } = await runOffline(["--json"]);
    const { eventsPath, trace } = JSON.parse(outText()) as {
      eventsPath: string;
      trace: { runId: string; eventCount: number };
    };

    const lines = (await readFile(eventsPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(trace.eventCount);
    const first = JSON.parse(lines[0] ?? "{}") as { type: string; runId: string; sequence: number };
    expect(first.type).toBe("run_started");
    expect(first.runId).toBe(trace.runId);
    expect(first.sequence).toBe(0);
  });

  it("`--quiet` 不印进度，但结论照旧", async () => {
    const { outText, errText } = await runOffline(["--quiet"]);

    expect(outText()).toContain("为什么停");
    expect(errText()).not.toContain("问模型");
    // 退出码那一行仍然要给：它是被管道/脚本读的那一行。
    expect(errText()).toContain("exit ");
  });

  it("进度与结论分流：结论走 stdout，进度走 stderr", async () => {
    const { outText, errText } = await runOffline();

    expect(outText()).not.toContain("问模型");
    expect(errText()).toContain("问模型");
  });

  it("被取消 → 12，而且日志里留下的是 run_cancelled，不是一个消失的进程", async () => {
    const controller = new AbortController();
    controller.abort();
    const { code } = await runOffline([], { signal: controller.signal });

    expect(code).toBe(EXIT.cancelled);
  });
});

// ---------------------------------------------------------------------------
// 四、凭据死、证据活：脱敏的两个方向
// ---------------------------------------------------------------------------

describe("脱敏", () => {
  /**
   * 「凭据死、证据活」这条规矩的完整测法：**同一个字符串，两种命运。**
   *
   * 分开测两句话是没有说服力的（"秘密没出现在输出里"可以只是因为输出里本来
   * 就没有它）。所以每一条用例都拿同一个字符串，一边断言它被抹了、一边断言它还在。
   */
  async function bothDirections(
    pattern: string,
    secret: string,
    overrides: Partial<CliIo>,
  ): Promise<{ stdout: string }> {
    const { code, outText, errText } = await cli(
      ["run", `找一下 ${pattern}`, "--repo", "repo", "--store", `store-${pattern}`, "--offline", "--pattern", pattern],
      overrides,
    );
    expect(code).toBe(EXIT.complete);

    // 面 1：终端与 CI 日志是另一个泄漏面，所以给人看的那一路必须洗过。
    expect(outText(), "输出里的凭据必须被抹掉").not.toContain(secret);
    expect(outText(), "而且抹过的痕迹要看得出来").toContain(REDACTED);
    expect(errText()).toContain("已脱敏");

    // 面 2：同一句话，事件日志里它必须**原样**在。一次 `read_file` 拿回来的原文
    // 如果被我们改过，"这条论断指向这个文件的这一行"就不再可核对——而这个项目的
    // 全部价值都压在那上面。**日志是证据，不改写证据。**
    const { outText: jsonText } = await cli([
      "run",
      `再看一次 ${pattern}`,
      "--repo",
      "repo",
      "--store",
      `store-${pattern}`,
      "--offline",
      "--pattern",
      pattern,
      "--json",
    ], overrides);
    const { eventsPath } = JSON.parse(jsonText()) as { eventsPath: string };
    const log = await readFile(eventsPath, "utf8");
    expect(log, "事件日志里必须还是原文").toContain(secret);

    return { stdout: outText() };
  }

  it("形状那一路：仓库里的 key 一眼认得出，输出被洗、日志留着", async () => {
    await bothDirections("key", REPO_KEY, {});
  });

  it("环境那一路：值没有可辨认的形状，只有「环境里恰好有这个值」能认出它", async () => {
    // 这个值不像任何东西，所以形状那一路帮不上忙；它被认出来只能是因为
    // 我们自己的环境里有一个叫 `DEMO_TOKEN` 的变量装着它。
    await bothDirections("password", PLAIN_SECRET, { env: { DEMO_TOKEN: PLAIN_SECRET } });
  });

  it("环境里太短的值不当秘密：它会在文本里到处误伤", async () => {
    const { outText } = await cli(
      ["run", "这个仓库里有哪些 TODO？", "--repo", "repo", "--store", "store-s", "--offline"],
      { env: { DEMO_TOKEN: "abc" } },
    );

    expect(outText()).not.toContain(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// 五、只读的三个子命令：再看一遍不该再花一分钱
// ---------------------------------------------------------------------------

describe("kuse trace / runs / sessions", () => {
  let sessionId = "";
  let runId = "";

  beforeAll(async () => {
    const { outText } = await cli([
      "run",
      "这个仓库里有哪些 TODO？",
      "--repo",
      "repo",
      "--store",
      "store-read",
      "--offline",
      "--json",
    ]);
    ({ sessionId, eventsPath: runId } = JSON.parse(outText()) as {
      sessionId: string;
      eventsPath: string;
    });
    // `eventsPath` 是 `<store>/<runId>/events.jsonl`，倒数第二段就是 runId。
    runId = runId.split(/[\\/]/).slice(-2)[0] ?? "";
  });

  it("`sessions` 列出会话与它有几个 Run", async () => {
    const { code, outText } = await cli(["sessions", "--store", "store-read"]);

    expect(code).toBe(EXIT.complete);
    expect(outText()).toContain(sessionId);
    expect(outText()).toContain("1 个 Run");
  });

  it("`runs` 列出这个会话里的 Run，状态由日志派生", async () => {
    const { code, outText } = await cli(["runs", sessionId, "--store", "store-read"]);

    expect(code).toBe(EXIT.complete);
    expect(outText()).toContain(runId);
    expect(outText()).toContain("completed");
  });

  it("`trace` 不重跑、不调模型，只读日志", async () => {
    const { code, outText, errText } = await cli(["trace", sessionId, runId, "--store", "store-read"]);

    // 退出码与那次 Run 的结局一致：一个脚本重看历史时也该能拿到同一个结论。
    expect(code).toBe(EXIT.complete);
    expect(outText()).toContain("调用了什么");
    expect(outText()).toContain("completed（有结论，材料齐）");
    // 存储那一行是"这次 Run 是怎么被发起的"的一部分，它不在事件里，所以由调用方给。
    expect(outText()).toContain("由日志派生");
    // 只读模式没有仓库上下文，所以它没有核对——而"没有核对"必须看得出来：
    // 印一个空表会让人以为核对通过了。
    expect(outText()).toContain("没有核对");
    expect(errText()).toContain("exit 0（complete）");
  });

  it("`trace` 的 `--json` 把这件事也说清楚，而不是印一个空表让人以为核对通过了", async () => {
    const { outText } = await cli(["trace", sessionId, runId, "--store", "store-read", "--json"]);
    const parsed = JSON.parse(outText()) as { audit: unknown; auditSkipped: string };

    expect(parsed.audit).toBeNull();
    expect(parsed.auditSkipped).toContain("未做证据核对");
  });

  it("找不到那次 Run → 2（而不是一个空 trace）", async () => {
    const { code, errText } = await cli(["trace", sessionId, "run_不存在", "--store", "store-read"]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("找不到");
  });

  it("`trace` 少给参数 → 2，并印出用法", async () => {
    const { code, errText } = await cli(["trace", sessionId, "--store", "store-read"]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("kuse trace <sessionId> <runId>");
  });

  it("只读命令不许带只有 `run` 认识的选项", async () => {
    const { code, errText } = await cli(["runs", sessionId, "--repo", ".", "--store", "store-read"]);

    expect(code).toBe(EXIT.usage);
    expect(errText()).toContain("--repo");
  });
});

// ---------------------------------------------------------------------------
// 六、Run 不许读到自己的产物
//
// 这是一次实测撞出来的默认配置缺陷：`--repo` 默认当前目录、`--store` 默认 `./runs`，
// 于是存储落在被分析的仓库里面；而事件日志里写着任务文本（还有搜索的模式），
// 所以 `search_text` 会命中**这次 Run 自己的日志**——Run 把输出当成了输入，
// 而且下一次运行会看到上一次的日志。
//
// 修法：CLI 同时知道 `--repo` 与 `--store`，于是它能算出存储目录是不是在仓库里，
// 并把那条**相对路径**交给工具集去跳过（`createRepoTools({ ignore })`）。
// ---------------------------------------------------------------------------

describe("Run 不许读到自己的产物", () => {
  /**
   * 这个字串只出现在**任务文本**里，仓库的源码里一个字都没有。
   *
   * 于是它成了判定"日志有没有被读到"的探针：搜索能命中它，就只能是通过
   * 这次 Run 自己的事件日志命中的。
   */
  const MARKER = "kusecode-self-reference-probe";

  it("存储目录在仓库里时，事件日志不是材料", async () => {
    const { code, outText } = await cli([
      "run",
      `找一下 ${MARKER}`,
      "--repo",
      "repo-self",
      "--store",
      "repo-self/runs",
      "--offline",
      "--pattern",
      MARKER,
      "--json",
    ]);
    expect(code).toBe(EXIT.complete);

    const parsed = JSON.parse(outText()) as {
      trace: { report: { claims: readonly { evidence: readonly unknown[] }[] }; steps: readonly unknown[] };
      eventsPath: string;
    };

    // 探针：搜索一条也没命中，于是第一条论断**明说没有依据**（空数组），
    // 而不是引用了自己的日志里那一行。
    expect(parsed.trace.report.claims[0]?.evidence).toEqual([]);

    // 而这条"没命中"是有分量的——日志里**真的**写着那个字串：
    // 任务文本在会话索引里，搜索的模式在 `decision_made` 里。
    const log = await readFile(parsed.eventsPath, "utf8");
    expect(log, "日志里确实有那个字串，所以上面那条 0 命中不是碰巧").toContain(MARKER);
  });

  it("存储目录不在仓库里时，什么都不用跳过（规则不该影响别的仓库）", async () => {
    const { code, outText } = await cli([
      "run",
      "这个仓库里有哪些 TODO？",
      "--repo",
      "repo-self",
      // 存在仓库外面：这次 Run 的产物本来就不在材料里
      "--store",
      "store-outside",
      "--offline",
      "--json",
    ]);

    expect(code).toBe(EXIT.complete);
    const parsed = JSON.parse(outText()) as { trace: { steps: readonly { tool: string }[] } };
    // 默认模式在仓库里是有命中的（`src/loop.ts` 那一行），所以流程照常走到读文件。
    expect(parsed.trace.steps.map((step) => step.tool)).toEqual(["list_dir", "search_text", "read_file"]);
    // 而且没有把 `store-outside` 当成一个要跳过的路径记恨下来。
    expect(parsed.trace.steps.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 七、stdin：管道用
// ---------------------------------------------------------------------------

describe("任务文本可以从 stdin 来", () => {
  it("没有位置参数时读 stdin", async () => {
    const { code, outText } = await cli(
      ["run", "--repo", "repo", "--store", "store-in", "--offline", "--json"],
      { stdin: async () => "这个仓库里有哪些 TODO？\n" },
    );

    expect(code).toBe(EXIT.complete);
    const { trace } = JSON.parse(outText()) as {
      trace: { steps: readonly { tool: string; args: Record<string, unknown> }[] };
    };
    // 任务是"从哪一行开始找"，所以它体现在搜索的模式里；报告的第一句是固定的
    // 免责说明（那是刻意固定的），不该拿它来认任务文本。
    expect(trace.steps[1]?.tool).toBe("search_text");
    expect(trace.steps[1]?.args["pattern"]).toBe("TODO");
  });
});
