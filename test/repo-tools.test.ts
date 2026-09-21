/**
 * 真实仓库工具：schema 校验、路径围栏、失败即观测。
 *
 * 这个文件的重点是**那三件只在真实文件系统上才成立的事**：
 *
 * 1. **围栏拦的是解析结果，不是写法。** `..` 这个子串可以出现在完全合法的文件名里
 *    （`a..b.md`），而 `x/../../etc/passwd` 里没有一个字符是"非法"的。所以断言
 *    必须同时覆盖"看起来像攻击的写法"和"看起来像攻击的合法名字"——只测前者，
 *    实现就会退化成字符串检查。
 * 2. **失败是一条观测，不是一次抛错。** 文件不存在、路径越界、参数不对，
 *    都必须从 `execute` 里**返回**（`{ value: null, error }`），而不是抛出去——
 *    抛出去会被 Runtime 当成"这次 Run 失败了"，而它其实只是"这次没拿到材料"。
 * 3. **声明与校验不许分叉。** 给模型看的 schema 与执行前的 `parse` 是两份实现，
 *    它们对"哪些键合法"的答案必须一致，否则模型会照着一份写、被另一份拒。
 *
 * 夹具是真的临时目录（`os.tmpdir()` 下一个自建的目录），不是 mock 的文件系统：
 * 被 mock 的 `stat` 证明不了任何关于路径的事。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolIntent, ToolOutcome } from "../src/core/types.js";
import {
  ToolArgumentError,
  createRepoTools,
  declaredKeysOf,
  resolveInsideRepo,
} from "../src/tools/repo-tools.js";

let root = "";

/** 写在"这次 Run 自己的产物"里的字串。见文末那个 describe。 */
const OWN_ARTIFACT = "run-own-artifact-marker";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kusecode-repo-tools-"));
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });

  await writeFile(join(root, "README.md"), "# 标题\n第二行\n第三行\n");
  await writeFile(join(root, "a..b.md"), "名字里有两点，但它是合法文件\n");
  await writeFile(join(root, "src", "loop.ts"), "export function reduce() {}\nexport function step() {}\n");
  await writeFile(join(root, "src", "deep", "notes.txt"), "Reduce 与 Step 都在这里\n");
  // 501 行：用来验证单次读取的上限
  await writeFile(
    join(root, "long.txt"),
    Array.from({ length: 501 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "reduce()\n");
  await writeFile(join(root, ".git", "config"), "reduce\n");
  // 含 NUL 的文件：二进制，搜索应当跳过它而不是崩掉
  await writeFile(join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0x52, 0x65, 0x64]));
  // 一个"这次 Run 自己的产物"目录：它的内容不该被当成材料（见文末那个 describe）
  await mkdir(join(root, "vendor", "runs"), { recursive: true });
  await writeFile(join(root, "vendor", "runs", "artifact.txt"), `${OWN_ARTIFACT}\n`);
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

function toolbox() {
  return createRepoTools({ repoRoot: root });
}

/** 跑一次工具，顺便把"绝不抛异常"这件事变成每条用例的默认前提。 */
async function exec(intent: ToolIntent, signal: AbortSignal = new AbortController().signal): Promise<ToolOutcome> {
  const outcome = await toolbox().port.execute(intent, signal);
  expect(outcome).toHaveProperty("value");
  expect(outcome).toHaveProperty("error");
  return outcome;
}

/** 断言这次调用成功了，并把 `value` 收窄出来。 */
async function ok(intent: ToolIntent): Promise<Record<string, unknown>> {
  const outcome = await exec(intent);
  expect(outcome.error, `预期成功，实际失败：${outcome.error?.message ?? ""}`).toBeNull();
  return outcome.value as Record<string, unknown>;
}

/** 断言这次调用失败了，并把错误码收窄出来。 */
async function fails(intent: ToolIntent): Promise<{ code: string; message: string }> {
  const outcome = await exec(intent);
  if (outcome.error === null) throw new Error(`预期失败，实际成功：${JSON.stringify(outcome.value)}`);
  return outcome.error;
}

// ---------------------------------------------------------------------------
// 一、路径围栏
// ---------------------------------------------------------------------------

describe("路径围栏：拦解析结果，不拦写法", () => {
  it("仓库内的相对路径被解析成绝对路径", () => {
    expect(resolveInsideRepo(root, "src/loop.ts")).toBe(resolve(root, "src", "loop.ts"));
  });

  it("仓库内的绝对路径也接受（它是同一个目标的另一种写法）", () => {
    expect(resolveInsideRepo(root, resolve(root, "src", "loop.ts"))).toBe(resolve(root, "src", "loop.ts"));
  });

  it("`.` 就是仓库根，不算越界", () => {
    expect(resolveInsideRepo(root, ".")).toBe(resolve(root));
  });

  it("拦的是解析结果：`a/../../x` 里没有一个非法字符，但它越界了", () => {
    expect(() => resolveInsideRepo(root, "src/../../outside.txt")).toThrow(ToolArgumentError);
  });

  it("绝对路径指向仓库外时也拦（换个写法而已）", () => {
    expect(() => resolveInsideRepo(root, resolve(tmpdir(), "outside.txt"))).toThrow(ToolArgumentError);
  });

  it("文件名里的 `..` 是合法字符，不该被误伤", () => {
    // 这正是"检查子串"与"检查解析结果"的区别所在：
    // `a..b.md` 里含 `..`，却又完全在仓库里。只查子串的实现会错杀它。
    expect(resolveInsideRepo(root, "a..b.md")).toBe(resolve(root, "a..b.md"));
  });

  it("`..` 恰好到仓库根为止是允许的，再多一层就不行", () => {
    expect(resolveInsideRepo(root, "src/..")).toBe(resolve(root));
    expect(() => resolveInsideRepo(root, "src/../..")).toThrow(ToolArgumentError);
  });
});

// ---------------------------------------------------------------------------
// 二、read_file
// ---------------------------------------------------------------------------

describe("read_file", () => {
  it("按行返回，带 1 起的行号与总行数", async () => {
    const value = await ok({ name: "read_file", args: { path: "README.md" } });
    expect(value["path"]).toBe("README.md");
    // 末尾那个换行切出的空串不算一行：3 行就是 3 行
    expect(value["totalLines"]).toBe(3);
    expect(value["lines"]).toEqual([
      { n: 1, text: "# 标题" },
      { n: 2, text: "第二行" },
      { n: 3, text: "第三行" },
    ]);
  });

  it("startLine/endLine 取窗口，行号是**原文的**行号而不是窗口内的序号", async () => {
    const value = await ok({ name: "read_file", args: { path: "README.md", startLine: 2, endLine: 3 } });
    expect(value["startLine"]).toBe(2);
    expect(value["endLine"]).toBe(3);
    // 证据里的行号要能直接在文件里对上，所以窗口不能把行号重编
    expect(value["lines"]).toEqual([
      { n: 2, text: "第二行" },
      { n: 3, text: "第三行" },
    ]);
  });

  it("只给 startLine 时读到文件末尾", async () => {
    const value = await ok({ name: "read_file", args: { path: "README.md", startLine: 3 } });
    expect(value["lines"]).toEqual([{ n: 3, text: "第三行" }]);
  });

  it("单次读取有上限：501 行的文件一次拿不全，但「拿不全」是可见的", async () => {
    const value = await ok({ name: "read_file", args: { path: "long.txt" } });
    const lines = value["lines"] as readonly { n: number }[];
    expect(lines).toHaveLength(400);
    // 总行数照实报：模型看到 400 行 + totalLines=501，就知道还有没读到的
    expect(value["totalLines"]).toBe(501);
    expect(value["endLine"]).toBe(400);
  });

  it("startLine 超过文件长度时返回空窗口，而不是报错", async () => {
    const value = await ok({ name: "read_file", args: { path: "README.md", startLine: 99 } });
    expect(value["lines"]).toEqual([]);
    // 空窗口的 endLine 落在 startLine - 1：它说的是"一行都没取到"，不是"取到了第 99 行"
    expect(value["endLine"]).toBe(98);
  });

  it("路径越界是一条**可返回的**失败，不是抛出去的异常", async () => {
    const error = await fails({ name: "read_file", args: { path: "../outside.txt" } });
    // 越界算"参数不合法"：模型给的东西没法用，重试同一个参数也没用
    expect(error.code).toBe("invalid_args");
    expect(error.message).toContain("越出");
  });

  it("文件不存在是 tool_failed：它只是「这次没拿到材料」", async () => {
    const error = await fails({ name: "read_file", args: { path: "nope.txt" } });
    expect(error.code).toBe("tool_failed");
  });

  it("给了目录不是崩溃，而是一句说明", async () => {
    const value = await ok({ name: "read_file", args: { path: "src" } });
    expect(value["error"]).toBe("不是一个普通文件");
  });

  it("返回的 value 里没有 provenance / truncated：那两个字段只能由 Runtime 写", async () => {
    const value = await ok({ name: "read_file", args: { path: "README.md" } });
    // 工具自己写 provenance 等于让它决定"这条材料是什么时候拿到的"，
    // 而回放要沿用的是 Runtime 写的那个值——两处真相，必然分叉。
    expect(value).not.toHaveProperty("provenance");
    expect(value).not.toHaveProperty("truncated");
  });
});

// ---------------------------------------------------------------------------
// 三、list_dir
// ---------------------------------------------------------------------------

describe("list_dir", () => {
  it("省略 path 就是仓库根", async () => {
    const value = await ok({ name: "list_dir", args: {} });
    expect(value["path"]).toBe(".");
    const names = (value["entries"] as readonly { name: string }[]).map((e) => e.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
  });

  it("不递归：只列这一层的条目", async () => {
    const value = await ok({ name: "list_dir", args: { path: "src" } });
    const entries = value["entries"] as readonly { name: string; type: string }[];
    expect(entries.map((e) => e.name)).toEqual(["deep", "loop.ts"]);
    // `deep` 里面的东西不该出现在这一层
    expect(entries.map((e) => e.name)).not.toContain("notes.txt");
  });

  it("条目带类型，且按名字排序（顺序稳定，回放才对得上）", async () => {
    const value = await ok({ name: "list_dir", args: { path: "." } });
    const entries = value["entries"] as readonly { name: string; type: string }[];
    const names = entries.map((e) => e.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    expect(entries.find((e) => e.name === "src")?.type).toBe("dir");
    expect(entries.find((e) => e.name === "README.md")?.type).toBe("file");
  });

  it("噪声目录看不见：它们是体积，不是材料", async () => {
    const value = await ok({ name: "list_dir", args: { path: "." } });
    const names = (value["entries"] as readonly { name: string }[]).map((e) => e.name);
    for (const noise of [".git", "node_modules"]) {
      expect(names, `${noise} 不该出现在列表里`).not.toContain(noise);
    }
  });

  it("被省略的条目数是可见的：模型不该以为「列全了」", async () => {
    const value = await ok({ name: "list_dir", args: { path: "." } });
    expect(value["omitted"]).toBe(0);
    expect(value["total"]).toBe((value["entries"] as readonly unknown[]).length);
  });

  it("给了文件不是崩溃，而是一句说明", async () => {
    const value = await ok({ name: "list_dir", args: { path: "README.md" } });
    expect(value["error"]).toBe("不是一个目录");
  });

  it("目录不存在是 tool_failed", async () => {
    const error = await fails({ name: "list_dir", args: { path: "nope/" } });
    expect(error.code).toBe("tool_failed");
  });
});

// ---------------------------------------------------------------------------
// 四、search_text
// ---------------------------------------------------------------------------

describe("search_text", () => {
  it("命中带文件路径与行号，且路径是仓库相对的（用 `/` 分隔）", async () => {
    const value = await ok({ name: "search_text", args: { pattern: "export function reduce" } });
    const matches = value["matches"] as readonly { path: string; line: number; text: string }[];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe("src/loop.ts");
    expect(matches[0]?.line).toBe(1);
    expect(matches[0]?.text).toBe("export function reduce() {}");
  });

  it("不区分大小写", async () => {
    const value = await ok({ name: "search_text", args: { pattern: "REDUCE" } });
    const matches = value["matches"] as readonly { path: string }[];
    expect(matches.map((m) => m.path)).toContain("src/loop.ts");
  });

  it("递归到子目录，但跳过噪声目录", async () => {
    const value = await ok({ name: "search_text", args: { pattern: "reduce" } });
    const paths = (value["matches"] as readonly { path: string }[]).map((m) => m.path);
    expect(paths).toContain("src/deep/notes.txt");
    // node_modules 与 .git 里的 reduce 是噪声：搜到它们等于把仓库淹没
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
  });

  it("二进制文件跳过，不让整次搜索失败", async () => {
    const value = await ok({ name: "search_text", args: { pattern: "Red" } });
    const paths = (value["matches"] as readonly { path: string }[]).map((m) => m.path);
    expect(paths).not.toContain("binary.bin");
    // 而这次搜索本身是成功的
    expect(value["pattern"]).toBe("Red");
  });

  it("maxMatches 生效，并且「提前停下」是可见的", async () => {
    const value = await ok({ name: "search_text", args: { pattern: "line", maxMatches: 5 } });
    expect((value["matches"] as readonly unknown[]).length).toBe(5);
    expect(value["stoppedEarly"]).toBe(true);
  });

  it("非法正则是一条参数失败，不是一次崩溃", async () => {
    const error = await fails({ name: "search_text", args: { pattern: "([unclosed" } });
    expect(error.code).toBe("invalid_args");
    expect(error.message).toContain("正则");
  });
});

// ---------------------------------------------------------------------------
// 五、schema 校验与 allowlist
// ---------------------------------------------------------------------------

describe("schema 校验：声明给模型看的那一份，与执行前校验的那一份", () => {
  it("缺必填参数时指名失败", async () => {
    expect((await fails({ name: "read_file", args: {} })).message).toContain("path");
    expect((await fails({ name: "search_text", args: {} })).message).toContain("pattern");
    expect((await fails({ name: "list_dir", args: { path: 42 } })).message).toContain("path");
  });

  it("类型不对的整数被拒（模型很爱把行号写成字符串）", async () => {
    expect((await fails({ name: "read_file", args: { path: "README.md", startLine: "2" } })).code).toBe(
      "invalid_args",
    );
    expect((await fails({ name: "read_file", args: { path: "README.md", startLine: 1.5 } })).code).toBe(
      "invalid_args",
    );
  });

  it("语义上不可能的参数被拒：endLine < startLine、startLine < 1", async () => {
    expect((await fails({ name: "read_file", args: { path: "README.md", startLine: 3, endLine: 2 } })).code).toBe(
      "invalid_args",
    );
    expect((await fails({ name: "read_file", args: { path: "README.md", startLine: 0 } })).code).toBe(
      "invalid_args",
    );
  });

  it("未知工具名 → invalid_tool（allowlist 在执行层，只有这一份）", async () => {
    const error = await fails({ name: "rm_rf", args: {} });
    expect(error.code).toBe("invalid_tool");
    expect(error.message).toContain("rm_rf");
  });

  it("每个工具声明的键就是它校验时认的键，没有第三份清单", async () => {
    const box = toolbox();
    const probes: Record<string, Readonly<Record<string, unknown>>> = {
      read_file: { path: "README.md" },
      list_dir: { path: "." },
      search_text: { pattern: "reduce" },
    };
    for (const spec of box.specs) {
      const probe = probes[spec.name];
      expect(probe, `${spec.name} 缺探针`).toBeDefined();
      if (probe === undefined) continue;
      const declared = declaredKeysOf(spec);
      for (const key of Object.keys(spec.parse(probe))) {
        expect(declared, `${spec.name}.${key} 收敛出来了却没声明`).toContain(key);
      }
      // 反过来：声明的每个键都必须是"可选或有默认值"或"必填"之一，
      // 而必填的键在 probe 里都在（否则这一轮的 probe 早就抛了）
      for (const required of spec.parameters.required) {
        expect(declared, `${spec.name} 的必填键 ${required} 没在 properties 里`).toContain(required);
      }
    }
  });

  it("port.names 与 specs 的顺序一致（工具目录从它来）", () => {
    const box = toolbox();
    expect(box.names).toEqual(["read_file", "list_dir", "search_text"]);
    expect(box.specs.map((s) => s.name)).toEqual([...box.names]);
  });
});

// ---------------------------------------------------------------------------
// 六、取消
// ---------------------------------------------------------------------------

describe("取消", () => {
  it("信号已经中止时工具不动手，返回一条 tool_failed", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await exec({ name: "read_file", args: { path: "README.md" } }, controller.signal);
    expect(result.value).toBeNull();
    expect(result.error?.code).toBe("tool_failed");
    expect(result.error?.message).toContain("取消");
  });

  it("中止之后的失败不是「参数不合法」：重试同一个参数没有意义", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await exec({ name: "search_text", args: { pattern: "x" } }, controller.signal);
    // 这一条区分很要紧：`invalid_args` 会被模型改参数后重试，而取消不是它的错
    expect(result.error?.code).not.toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// 这次 Run 自己的产物不是材料
//
// 这条规则是**实测撞出来的**，而且它撞在默认配置上：`--repo` 默认当前目录、
// `--store` 默认 `./runs`，于是存储就在被分析的仓库里面。事件日志里写着任务文本，
// 所以一次 `search_text` 会命中**这次 Run 自己的日志**——Run 把输出当成了输入，
// 而且下一次运行会看到上一次的日志，越滚越多。
//
// 修法的形状值得记下来：跳过的是**仓库相对路径**，不是目录名。用名字会让一个
// 真正叫 `runs` 的素材目录被静默漏掉，而"静默漏掉材料"看起来就像那个仓库里
// 没有那些文件——这个项目最不愿发生的一类错误。
// ---------------------------------------------------------------------------

describe("被点名的目录按路径跳过", () => {
  it("只跳过被点名的那一个位置，同名的别处照常搜到", async () => {
    // 同一个目录名出现在两个位置：只跳过被点名的那个。
    await mkdir(join(root, "src", "runs"), { recursive: true });
    await writeFile(join(root, "src", "runs", "keep.txt"), `${OWN_ARTIFACT}\n`);

    const scoped = createRepoTools({ repoRoot: root, ignore: ["vendor/runs"] });
    const outcome = await scoped.port.execute(
      { name: "search_text", args: { pattern: OWN_ARTIFACT } },
      new AbortController().signal,
    );
    expect(outcome.error).toBeNull();
    const paths = ((outcome.value as { matches: readonly { path: string }[] }).matches).map((m) => m.path);

    expect(paths).toContain("src/runs/keep.txt");
    expect(paths.some((path) => path.startsWith("vendor/runs/"))).toBe(false);
  });

  it("不点名的时候它照常是材料（这条规则是配置，不是内置的假设）", async () => {
    const plain = createRepoTools({ repoRoot: root });
    const outcome = await plain.port.execute(
      { name: "search_text", args: { pattern: OWN_ARTIFACT } },
      new AbortController().signal,
    );
    const paths = ((outcome.value as { matches: readonly { path: string }[] }).matches).map((m) => m.path);

    expect(paths).toContain("vendor/runs/artifact.txt");
  });

  it("list_dir 里也看不见它", async () => {
    const scoped = createRepoTools({ repoRoot: root, ignore: ["vendor/runs"] });
    const outcome = await scoped.port.execute(
      { name: "list_dir", args: { path: "vendor" } },
      new AbortController().signal,
    );

    const entries = (outcome.value as { entries: readonly { name: string }[] }).entries;
    expect(entries.map((entry) => entry.name)).toEqual([]);
  });

  it("反斜杠与末尾斜杠都归一化：规则是给人写的，不该因为平台而变", async () => {
    // 用 `join` 拼出真的反斜杠，而不是写在字面量里：写在字面量里会被转义层
    // 吃掉一层，读的人分不清它到底是几个，而这条用例要测的恰恰就是那一个字符。
    const windowsStyle = `${["vendor", "runs"].join("\\")}\\`;
    const scoped = createRepoTools({ repoRoot: root, ignore: [windowsStyle] });
    const outcome = await scoped.port.execute(
      { name: "list_dir", args: { path: "vendor" } },
      new AbortController().signal,
    );

    const entries = (outcome.value as { entries: readonly { name: string }[] }).entries;
    expect(entries.map((entry) => entry.name)).toEqual([]);
  });
});
