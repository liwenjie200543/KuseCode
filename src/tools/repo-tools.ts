/**
 * 真实工具：读仓库。
 *
 * 这是本项目第一个**真的会碰外部世界**的 ToolPort。它存在的理由就是那个真实任务：
 * 「给定一个本地代码仓库，回答关于它的问题，且每条论断都指向文件与行号」——
 * 没有这三个工具，Agent 就没有材料可读。
 *
 * 四条约定，每一条都对应一个已经发生过的教训：
 *
 * 1. **每个工具声明自己的 schema，并在执行前校验参数。** 步 6 只做**形状**校验
 *    （参数能不能 JSON 表示），因为它不认识任何具体工具；「`read_file` 需要一个
 *    字符串 `path`」这种检查只能由认识这个工具的代码来做——也就是这里。
 *    形状校验 ≠ schema 校验，两件事都在，谁也不替谁。
 * 2. **路径必须落在 repoRoot 里。** `path.resolve` 之后比对前缀，而不是去禁止
 *    `..` 这个字符串：`a/../../etc/passwd` 与绝对路径都是同一件事的不同写法，
 *    拦住写法会漏掉写法，拦住**解析结果**才不会。
 * 3. **返回值是纯数据，不含 `provenance` / `truncated`。** 那两个字段只能由 Runtime
 *    写在观测上（步 2 的安全默认）。文件身份（`path`、行号）属于**数据**，
 *    它归 `value`，不归 provenance——这也是步 6 留下"provenance 只到工具名"
 *    那个缺口的正式答案：材料的身份由工具返回的结果携带，证据由 `Evidence` 承担。
 * 4. **schema 用纯 JSON Schema 写，不用任何库。** 于是 `src/tools` 一行 SDK import
 *    都没有，适配器负责把它转成 provider 要的形状。工具的词汇不该由 SDK 决定。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MaterialRef } from "../core/types.js";
import { ToolArgumentError } from "../toolbox.js";
import type { IgnoreRules, ToolSpec } from "../toolbox.js";

// ---------------------------------------------------------------------------
// 词汇的归属（SDD T11）
// ---------------------------------------------------------------------------
//
// `JsonObjectSchema` / `ToolArgumentError` / `ToolSpec` / `ToolContext` /
// `IgnoreRules` / `Toolbox` / 组装与 materialReader 已经升格到 `src/toolbox.ts`：
// 它们是**任何**工具集都要用的组装词汇，不是"读仓库"这三个工具的私产。
// 本文件从那以后只回答一个问题：**读仓库的三个工具各自长什么样**——
// 加一个新工具的成本因此收敛为"写一个 spec + 在清单里加一行"。
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 参数与取值助手：所有 spec 共用的那一小套（`asRecord` 抛 ToolArgumentError，
// `asValue`/`stringAt`/`numberAt` 只做"安全的读"，不抛）。
// ---------------------------------------------------------------------------

function asRecord(args: unknown, what: string): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ToolArgumentError(`${what} 的参数必须是一个对象`);
  }
  return args as Record<string, unknown>;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  what: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolArgumentError(`${what} 的 ${key} 必须是字符串`);
  return value;
}

function requiredString(args: Record<string, unknown>, key: string, what: string): string {
  const value = optionalString(args, key, what);
  if (value === undefined || value.length === 0) {
    throw new ToolArgumentError(`${what} 必须提供非空的 ${key}`);
  }
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  what: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolArgumentError(`${what} 的 ${key} 必须是整数`);
  }
  return value;
}

/** 声明的 schema 里出现了校验函数不认识的键——用一次测试钉住，不靠人眼。 */

function toRepoPath(repoRoot: string, absolute: string): string {
  const rel = relative(resolve(repoRoot), absolute);
  return rel.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// 材料抽取：从**返回值**里读出"这次看到了什么"
//
// 这些函数只认自己那个工具的返回形状。它们宽松（字段缺失就少一条），因为它们的
// 职责是"如实抽出看到的东西"，不是"校验返回值得对不对"——返回值是我们自己造的，
// 校验它等于不信任自己；而少抽一条的后果只是核对时保守一点。
// ---------------------------------------------------------------------------

function asValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringAt(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function numberAt(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 路径拼接：`.` 是根目录，不能拼成 `./name`。 */
function joinRepoPath(base: string | null, name: string): string {
  if (base === null || base === "" || base === ".") return name;
  return `${base.replace(/\/$/, "")}/${name}`;
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const MAX_LINES_PER_READ = 400;

const readFileSpec: ToolSpec = {
  name: "read_file",
  description:
    "读取仓库里一个文本文件的内容，按行返回并带行号。用行号引用证据。大文件请用 startLine/endLine 取窗口。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径，相对于仓库根目录" },
      startLine: { type: "integer", description: "起始行号（从 1 开始，含）" },
      endLine: { type: "integer", description: "结束行号（含）" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  parse(args) {
    const record = asRecord(args, "read_file");
    const path = requiredString(record, "path", "read_file");
    const startLine = optionalInteger(record, "startLine", "read_file") ?? 1;
    const endLine = optionalInteger(record, "endLine", "read_file");
    if (startLine < 1) throw new ToolArgumentError("read_file 的 startLine 从 1 开始");
    if (endLine !== undefined && endLine < startLine) {
      throw new ToolArgumentError("read_file 的 endLine 小于 startLine");
    }
    return { path, startLine, ...(endLine === undefined ? {} : { endLine }) };
  },
  async run(args, context) {
    const path = args["path"] as string;
    const startLine = args["startLine"] as number;
    const requestedEnd = args["endLine"] as number | undefined;
    const absolute = resolveInsideRepo(context.repoRoot, path);

    const info = await stat(absolute);
    if (!info.isFile()) return { path, error: "不是一个普通文件" };

    const raw = await readFile(absolute, "utf8");
    const all = raw.split("\n");
    // 末尾换行会切出一个空行，它不是文件的一行
    if (all.length > 1 && all[all.length - 1] === "") all.pop();
    const totalLines = all.length;

    const windowEnd = Math.min(requestedEnd ?? totalLines, startLine - 1 + MAX_LINES_PER_READ, totalLines);
    const lines: { n: number; text: string }[] = [];
    for (let n = startLine; n <= windowEnd; n += 1) {
      lines.push({ n, text: all[n - 1] ?? "" });
    }
    return {
      path: toRepoPath(context.repoRoot, absolute),
      startLine,
      endLine: lines.length === 0 ? startLine - 1 : windowEnd,
      totalLines,
      // 行号与结束行一起返回，读的人不必自己推算"拿到的是哪个窗口"
      lines,
    };
  },
  material(value) {
    const record = asValue(value);
    const path = stringAt(record, "path");
    if (path === null) return [];
    const start = numberAt(record, "startLine");
    const end = numberAt(record, "endLine");
    // 空窗口（`endLine < startLine`）不是一个"看到了"的行区间，记成 null。
    const lines = start !== null && end !== null && end >= start ? ([start, end] as const) : null;
    return [{ path, lines }];
  },
};

/**
 * 路径围栏：解析后的目标必须落在仓库根目录里。
 * 拦住**解析结果**而不是写法——`a/../../etc/passwd` 与绝对路径是同一件事的不同写法。
 */
export function resolveInsideRepo(repoRoot: string, requested: string): string {
  const root = resolve(repoRoot);
  const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const rel = relative(root, target);
  if (rel === "") return root;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ToolArgumentError(`路径越出了仓库根目录：${requested}`);
  }
  return target;
}

/** 这个目录该不该跳过。两条规则见 `IgnoreRules`（默认名单住在组装点）。 */
function isIgnored(relativePath: string, name: string, ignore: IgnoreRules): boolean {
  return ignore.names.has(name) || ignore.paths.has(relativePath);
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 500;

const listDirSpec: ToolSpec = {
  name: "list_dir",
  description: "列出仓库里一个目录的条目（名字与类型）。不递归。默认列出仓库根目录。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，相对于仓库根目录；省略即根目录" },
    },
    required: [],
    additionalProperties: false,
  },
  parse(args) {
    const record = asRecord(args, "list_dir");
    const path = optionalString(record, "path", "list_dir") ?? ".";
    return { path };
  },
  async run(args, context) {
    const path = args["path"] as string;
    const absolute = resolveInsideRepo(context.repoRoot, path);
    const info = await stat(absolute);
    if (!info.isDirectory()) return { path, error: "不是一个目录" };

    const raw = await readdir(absolute, { withFileTypes: true });
    const visible = raw
      .filter((entry) => !isIgnored(joinRepoPath(path, entry.name), entry.name, context.ignore))
      .sort((a, b) => a.name.localeCompare(b.name));
    const shown = visible.slice(0, MAX_ENTRIES);
    return {
      path: toRepoPath(context.repoRoot, absolute) || ".",
      entries: shown.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
      })),
      total: visible.length,
      // 被省略的数量是可见的：模型不该以为"列全了"
      omitted: visible.length - shown.length,
    };
  },
  material(value) {
    const record = asValue(value);
    const base = stringAt(record, "path");
    const entries = record?.["entries"];
    if (!Array.isArray(entries)) return [];
    const refs: MaterialRef[] = [];
    for (const entry of entries) {
      const name = stringAt(asValue(entry), "name");
      // 列目录只说明"这个路径存在"，没有看到它的任何一行，所以 lines 是 null。
      if (name !== null) refs.push({ path: joinRepoPath(base, name), lines: null });
    }
    return refs;
  },
};

// ---------------------------------------------------------------------------
// search_text
// ---------------------------------------------------------------------------

const MAX_MATCHES = 100;
const MAX_SCANNED_FILES = 2000;
const MAX_PATTERN_LENGTH = 200;

/**
 * 遍历目录时的名字比较。
 *
 * **它必须与语言环境无关**，所以这里特意不用 `list_dir` 那个 `localeCompare`：
 * 遍历顺序决定的不只是"命中按什么顺序排"，还有**哪几条命中会被 `maxMatches` 截掉**
 * （见下面的 `stoppedEarly`）——一份材料的取舍取决于机器的 ICU 数据，
 * 是"同一份输入产出同一份证据"这条约束承受不起的。
 *
 * 它是记录 golden 语料时暴露出来的：`readdir` 的顺序由文件系统决定，
 * 于是同一份语料在两台机器上可能搜出不同的前 5 条。`list_dir` 的顺序只给人看，
 * 宽松一点没有代价；这一条要进证据，必须钉死。
 */
function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

const searchTextSpec: ToolSpec = {
  name: "search_text",
  description:
    "在仓库的文本文件里按正则搜索，返回命中行（带文件路径与行号）。用来定位材料，而不是代替阅读。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript 正则表达式（不区分大小写）" },
      maxMatches: { type: "integer", description: "最多返回多少条命中，默认 100" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  parse(args) {
    const record = asRecord(args, "search_text");
    const pattern = requiredString(record, "pattern", "search_text");
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new ToolArgumentError(`search_text 的 pattern 过长（上限 ${MAX_PATTERN_LENGTH}）`);
    }
    const maxMatches = optionalInteger(record, "maxMatches", "search_text") ?? MAX_MATCHES;
    if (maxMatches < 1) throw new ToolArgumentError("search_text 的 maxMatches 至少为 1");
    return { pattern, maxMatches: Math.min(maxMatches, MAX_MATCHES) };
  },
  async run(args, context) {
    const pattern = args["pattern"] as string;
    const maxMatches = args["maxMatches"] as number;

    let expression: RegExp;
    try {
      expression = new RegExp(pattern, "i");
    } catch (error) {
      throw new ToolArgumentError(
        `search_text 的 pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const matches: { path: string; line: number; text: string }[] = [];
    let scanned = 0;
    let stopped = false;

    const walk = async (directory: string): Promise<void> => {
      if (stopped) return;
      const entries = (await readdir(directory, { withFileTypes: true })).sort(byName);
      for (const entry of entries) {
        if (stopped) return;
        const child = join(directory, entry.name);
        // 相对路径在**跳过之前**就要算出来：按路径生效的那条规则要看它。
        if (isIgnored(toRepoPath(context.repoRoot, child), entry.name, context.ignore)) continue;
        if (entry.isDirectory()) {
          await walk(child);
          continue;
        }
        if (scanned >= MAX_SCANNED_FILES) {
          stopped = true;
          return;
        }
        scanned += 1;
        let text: string;
        try {
          text = await readFile(child, "utf8");
        } catch {
          // 二进制或读不动：跳过。它不是"没有命中"，但也不该让整次搜索失败
          continue;
        }
        if (text.includes("\u0000")) continue;
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (expression.test(line)) {
            matches.push({ path: toRepoPath(context.repoRoot, child), line: index + 1, text: line.trim().slice(0, 300) });
            if (matches.length >= maxMatches) {
              stopped = true;
              return;
            }
          }
        }
      }
    };

    await walk(resolve(context.repoRoot));
    return { pattern, matches, scannedFiles: scanned, stoppedEarly: stopped };
  },
  material(value) {
    const record = asValue(value);
    const matches = record?.["matches"];
    if (!Array.isArray(matches)) return [];
    const refs: MaterialRef[] = [];
    for (const match of matches) {
      const entry = asValue(match);
      const path = stringAt(entry, "path");
      const line = numberAt(entry, "line");
      // 一条命中就是"看到了这一行"：区间退化成 [line, line]。
      if (path !== null && line !== null) refs.push({ path, lines: [line, line] });
    }
    return refs;
  },
};

// ---------------------------------------------------------------------------
// 工具集清单
// ---------------------------------------------------------------------------

/**
 * 「读仓库」的三个工具，作为一份 spec 清单。
 *
 * 组装交给 `createToolbox`（`src/toolbox.ts`）：这里**只声明**有哪些工具，
 * 不再负责端口、执行层包装与 materialReader——那三样是任何工具集共用的
 * 组装事务。`ignorePaths`（比如这次 Run 自己的产物目录）也由组装方给出，
 * 因为"产物在哪"是发起 Run 的那一层才知道的事（见 `docs/09` 的自指问题）。
 */
export function createRepoToolSpecs(): readonly ToolSpec[] {
  return Object.freeze([readFileSpec, listDirSpec, searchTextSpec]);
}
