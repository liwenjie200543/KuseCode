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
import type { ToolIntent, ToolOutcome, ToolPort } from "../core/types.js";

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 一个工具参数的 JSON Schema 子集。够用就好，不是通用实现。 */
export interface JsonObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/** 参数不合法。`code` 直接用步 6 的词汇，Runtime 那一层不必再翻译。 */
export class ToolArgumentError extends Error {
  readonly code = "invalid_args";

  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

/**
 * 一个抛出物 → 一条**可返回的**失败。
 *
 * `ToolArgumentError` 与别的错误的区分不是分类癖：它们对模型说的是不同的话。
 * `invalid_args` 的含义是"你给的东西没法用，换个参数再来"，而 `tool_failed` 的
 * 含义是"这次没拿到材料，换参数也一样"。把前者说成后者，模型会以为是自己运气
 * 不好而反复重试同一个越界路径；反过来把文件不存在说成 `invalid_args`，
 * 模型会去改一个本来就没错的参数。
 *
 * 判据放在**一处**：越界与非法正则都是 `ToolArgumentError`，但它们抛在 `run` 里
 * （路径围栏要用到 `repoRoot`），所以两个 catch 都必须走这里，不能各判一次。
 */
function failureOf(error: unknown): { code: "invalid_args" | "tool_failed"; message: string } {
  return {
    code: error instanceof ToolArgumentError ? "invalid_args" : "tool_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** 工具自己知道自己能干什么。 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObjectSchema;
  /** 校验并收敛参数。不合法就抛 `ToolArgumentError`。 */
  readonly parse: (args: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  /** 干活。参数已经过 `parse`。返回的必须是可 JSON 表示的值。 */
  readonly run: (
    args: Record<string, unknown>,
    context: { readonly repoRoot: string; readonly signal: AbortSignal },
  ) => Promise<unknown>;
}

/** 一个工具集：既能当 `ToolPort` 用，也能把自己的 schema 交出去。 */
export interface Toolbox {
  readonly names: readonly string[];
  readonly specs: readonly ToolSpec[];
  readonly port: ToolPort;
}

// ---------------------------------------------------------------------------
// 参数校验的小工具
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
export function declaredKeysOf(spec: ToolSpec): readonly string[] {
  return Object.keys(spec.parameters.properties);
}

// ---------------------------------------------------------------------------
// 路径围栏：拦解析结果，不拦写法
// ---------------------------------------------------------------------------

/**
 * 把模型给的相对路径收敛成 repoRoot 之内的绝对路径。
 *
 * 判据是 `path.relative` 的结果：它不以 `..` 开头、也不是绝对路径，才说明目标
 * 真的在仓库里。这比检查字符串里有没有 `..` 严格——`a/../../x` 会被解析出来，
 * `..` 这个子串却可能出现在一个完全合法的文件名里。
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

/** 交给模型的路径一律是仓库相对路径，且用 `/` 分隔（跨平台一致）。 */
function toRepoPath(repoRoot: string, absolute: string): string {
  const rel = relative(resolve(repoRoot), absolute);
  return rel.split(sep).join("/");
}

/** 用不着读的东西：它们不是"材料"，是噪声，而且体积可能极大。 */
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".workbuddy"]);

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
};

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
      .filter((entry) => !IGNORED_DIRECTORIES.has(entry.name))
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
};

// ---------------------------------------------------------------------------
// search_text
// ---------------------------------------------------------------------------

const MAX_MATCHES = 100;
const MAX_SCANNED_FILES = 2000;
const MAX_PATTERN_LENGTH = 200;

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
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (stopped) return;
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        const child = join(directory, entry.name);
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
};

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/**
 * 建一个真实工具集。
 *
 * 三个工具都在 `value` 里带自己的文件身份（`path` / 行号），所以模型引用证据时
 * 抄的是它**看到过**的东西，而不是自己编的路径。至于"模型抄错了怎么办"——
 * 那需要把 claims 里的 evidence 拿回来与观测核对，属于步 9/10，不在这里假装解决。
 */
export function createRepoTools(options: { readonly repoRoot: string }): Toolbox {
  const repoRoot = resolve(options.repoRoot);
  const specs: readonly ToolSpec[] = Object.freeze([readFileSpec, listDirSpec, searchTextSpec]);
  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  const port: ToolPort = {
    names: Object.freeze(specs.map((spec) => spec.name)),
    async execute(intent: ToolIntent, signal: AbortSignal): Promise<ToolOutcome> {
      const spec = byName.get(intent.name);
      if (spec === undefined) {
        // allowlist 的判断本来就在执行层，这里是它的第一次落地
        return { value: null, error: { code: "invalid_tool", message: `未知工具：${intent.name}` } };
      }
      // 已经中止就不再动手：文件系统调用本身不可中断，所以闸门只能放在它前面。
      // 这一条对两个驱动方都成立——我们的 Runtime（步 6 也有一道）与 SDK 的循环
      // （`piToolDefinitions` 把它交给我们时的那个 signal）。
      if (signal.aborted) {
        return {
          value: null,
          error: { code: "tool_failed", message: "调用已被取消，工具没有执行" },
        };
      }
      let args: Record<string, unknown>;
      try {
        args = spec.parse(intent.args);
      } catch (error) {
        return { value: null, error: failureOf(error) };
      }
      try {
        const value = await spec.run(args, { repoRoot, signal });
        return { value, error: null };
      } catch (error) {
        // 文件不存在、权限、编码——都是"这次没拿到材料"，不是 Run 的失败。
        // 而越界、非法正则虽然抛在同一处，判据仍是 `invalid_args`（见 `failureOf`）。
        return { value: null, error: failureOf(error) };
      }
    },
  };

  return { names: port.names, specs, port };
}
