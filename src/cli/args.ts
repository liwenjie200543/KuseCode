/**
 * 命令行的**词汇**：参数怎么解析、退出码是什么意思、帮助写什么。
 *
 * 这个文件不碰文件系统、不建 Runtime、也不打印任何东西——它与 `main.ts` 分开，
 * 因为"用户说了什么"与"我们做了什么"是两件事，而前者可以逐条断言。
 *
 * ## 退出码就是「为什么停」的机器可读形式
 *
 * 一个 Run 的结局有六种（三个终态、一种挂起、以及"还没走完"与"我还没开始"),
 * 把它们压成"0 或 1"会让脚本永远答不出"这次是部分成功还是彻底失败"。
 * 所以：
 *
 * ```text
 *  0  complete        有结论，材料齐
 * 10  partial         有结论，但缺材料（`missingMaterial` 里有名字）
 * 11  failed          失败（码在 `run_failed` 事件里）
 * 12  cancelled       被取消
 * 13  awaiting_human  挂起等人（**不是失败**：它在等一个只有人能给的输入）
 *  2  用法错误        参数、模型、会话目录不对——**Run 没有开始**
 *  3  内部错误        日志坏了之类：连"发生了什么"都答不出来
 * ```
 *
 * 10~13 与 2/3 分开是有意的：前者"Run 发生了但没走完"，后者"Run 根本没发生"。
 * 把它们混成一个非零码，脚本就无法区分"重试有用"与"重试之前得先改参数"。
 */

/** 退出码。见文件头那张表。 */
export const EXIT = {
  complete: 0,
  partial: 10,
  failed: 11,
  cancelled: 12,
  awaitingHuman: 13,
  usage: 2,
  internal: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** 解析之后的命令行。 */
export interface ParsedArgs {
  /** 第一个非选项参数。空命令行时是 `null`。 */
  readonly command: string | null;
  readonly positionals: readonly string[];
  /** `--flag` → `true`；`--flag value` / `--flag=value` → 字符串。 */
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * 解析 argv。
 *
 * 它**不**校验任何东西：哪些选项合法是每个子命令自己的事（`--json` 对 `run`
 * 有意义，对 `help` 没有）。解析器只管一件事：把 `-` 开头的词与别的词分开。
 *
 * 三条约定：
 * - `--name=value` 与 `--name value` 等价；
 * - 声明过要取值的选项（`options.valued`）会吃掉后面那个词；其余都是开关。
 *   没声明时退化成一条纯语法的猜测：后面跟着另一个 `-` 开头的词、或者它是
 *   最后一个词 → 开关；
 * - `--` 之后的一切都当位置参数（用来传入以 `-` 开头的任务文本）。
 *
 * ## 为什么要有 `valued`
 *
 * 只靠语法猜会**静默吃掉位置参数**。`kuse run --json 这个仓库里有哪些 TODO？`
 * 里，`--json` 后面跟着一个不是 `-` 开头的词，于是那个任务文本被当成
 * `--json` 的值——`--json` 看起来没生效，而任务凭空少了一半。这类错误不报错、
 * 只是结果不对，是命令行工具最难查的一种失败。
 *
 * 所以"哪些选项要取值"必须由**认识这些选项的那一层**（子命令）说出来。
 * 这不是校验，是词性：解析器不需要知道 `--json` 是什么意思，只需要知道它是开关。
 */
export interface ParseOptions {
  /** 要吃掉后面那个词的选项名（不含前缀 `-`）。省略时按语法猜。 */
  readonly valued?: readonly string[];
}

export function parseArgs(argv: readonly string[], options: ParseOptions = {}): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | null = null;
  let literal = false;
  const valued = options.valued === undefined ? null : new Set(options.valued);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const body = token.replace(/^-+/, "");
      const equals = body.indexOf("=");
      if (equals > 0) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      const next = argv[index + 1];
      const takesValue =
        valued === null
          ? next !== undefined && (!next.startsWith("-") || next.length === 1)
          : valued.has(body) && next !== undefined;
      if (takesValue && next !== undefined) {
        flags[body] = next;
        index += 1;
        continue;
      }
      flags[body] = true;
      continue;
    }

    if (command === null && positionals.length === 0) {
      command = token;
      continue;
    }
    positionals.push(token);
  }

  return { command, positionals, flags };
}

/** 取一个字符串选项。它没被给出、或者被写成了裸开关时返回 `null`。 */
export function flagValue(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  return typeof value === "string" ? value : null;
}

/** 这个开关打开了吗。 */
export function flagOn(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

/**
 * 有没有不认识的选项。
 *
 * 静默忽略拼错的选项是命令行工具最讨厌的一种失败：用户以为 `--sesion` 生效了，
 * 而它被安静地丢掉。所以每个子命令都声明自己认识的选项，其余一律报错。
 */
export function unknownFlags(args: ParsedArgs, allowed: readonly string[]): readonly string[] {
  return Object.keys(args.flags).filter((name) => !allowed.includes(name));
}

/**
 * 哪些选项被写成了裸开关，而它其实要一个值。
 *
 * `--repo` 后面什么都没有时，解析器只能把它设成 `true`。**此时用默认值是不对的**：
 * 用户的意思显然不是"用 `runs` 那个默认目录"，而是"我刚才少打了点东西"。
 * 与拼错的选项一样，这条也要报错而不是猜。
 */
export function flagsMissingValue(args: ParsedArgs, valued: readonly string[]): readonly string[] {
  return valued.filter((name) => args.flags[name] === true);
}

/** 帮助文本。它是产品面的一部分：一个命令的用法不该只能从源码里读出来。 */
export const HELP = `kuse —— 一次 Run 说过什么、为什么停、花了多少

用法
  kuse run [任务...] [选项]          跑一次 Run，打印结论与 trace
  kuse trace <sessionId> <runId>     打印一次已有 Run 的 trace（不重跑）
  kuse runs <sessionId>              列出这个会话里的 Run
  kuse sessions                      列出这个存储目录里的会话
  kuse help                          显示这段文字

run 的选项
  --repo <dir>       材料所在的仓库根目录（默认当前目录）
  --store <dir>      事件日志与会话索引的根目录（默认 ./runs）
  --model <spec>     模型。faux 是离线冒烟模式；否则是 provider/model
                     也可以由环境变量 KUSECODE_MODEL 提供
  --session <id>     把这次 Run 登记进一个已有会话；省略则新建一个
  --offline          等价于 --model faux
  --pattern <regex>  离线模式的搜索模式（默认 TODO）
  --json             stdout 只输出一个 JSON 对象（进度走 stderr）
  --quiet            不打印进度
  -h, --help         显示帮助

任务文本
  位置参数拼起来就是任务；什么都不给则从 stdin 读（管道用）。
  想传一个以 - 开头的任务文本，用 -- 隔开。

退出码
  0  complete          有结论，材料齐
  10 partial           有结论，但缺材料
  11 failed            失败（码在 run_failed 事件里）
  12 cancelled         被取消
  13 awaiting_human    挂起等人
  2  用法错误          参数 / 模型 / 会话不对（Run 没有开始）
  3  内部错误          日志坏了，答不出发生了什么

约定
  进度与说明走 stderr，结论与数据走 stdout。
  所以 kuse run --json | jq . 永远拿到一个完整、干净的 JSON。
`;
