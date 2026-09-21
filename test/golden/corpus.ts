/**
 * golden 语料 —— 一组**定的**运行，用来回答一个问题：
 * **一次 SDK 升级有没有悄悄改变语义？**
 *
 * 这个文件只有数据，没有一行 SDK、没有一行 `node:`。它用一套最小的中性剧本 DSL
 * 描述"模型每一轮做了什么"，然后由两个驱动方各自解释它：
 *
 * - `driveCore`：假模型端口 → Core 的循环（不经 SDK）；
 * - `driveSdk`：真 `pi-ai` 流 + 适配器（生产路径）。
 *
 * 两个驱动方必须产出**同一条事件日志**。于是这条语料同时钉住两件事：
 *
 * 1. **Core 的语义**：日志被写成固定件（`pinned/*.events.json`），跑出来不一样就失败；
 * 2. **适配器的翻译**：`pi-ai` 的消息形状、`stopReason`、工具调用参数、用量字段——
 *    任何一处语义变了，要么这里编译不过，要么日志对不上。
 *
 * ## 为什么剧本是中性的，而不是直接写 `Decision`
 *
 * 如果剧本直接写 `Decision`，那"SDK 路径"就变成"把 Decision 编码成消息再解码回来"，
 * 而编码器是**测试自己写的**：两个方向都由我们写，一致性就有可能是巧合。
 * 中性剧本则让两条路各自从同一份声明出发——假模型自己造 `Decision`，
 * 适配器从流里造 `Decision`，两边独立，日志再对账。
 *
 * ## 三条被这个语料逼出来的取舍
 *
 * - **时钟是常量**（`GOLDEN_NOW`）。`provenance.at` 由适配器写，而假模型没有适配器；
 *   只有固定时钟能让两条路的 `at` 天然相等。事件顺序由 `sequence` 钉住，
 *   而"时间戳随时间前进"由步 4/5 的测试用计数时钟单独钉住——两件事分开钉，都钉得住。
 * - **每条命中只有一个来源文件**（`TODO` 只出现在两处，且遍历顺序确定）。
 *   这是记录语料时发现的一个真问题：`search_text` 的遍历顺序原本取决于文件系统
 *   （见 `src/tools/repo-tools.ts` 的 `byName`）。
 * - **失败只声明两样东西**：provider 的原话与这句话该被认成哪个码。
 *   两者都有用——码是语义，原话是证据，而"这句话对应这个码"正是适配器那张表要背的。
 */

import type { RunBudget } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// 常量：golden 世界的时空
// ---------------------------------------------------------------------------

/** 固定时刻。适配器与假模型都用它写 `provenance.at`，所以两条路的证据同源。 */
export const GOLDEN_NOW = 1_700_000_000_000;

/** 固定模型名。它出现在 `model_requested.model` 与 `usage_reported.usage.model`。 */
export const GOLDEN_MODEL = "golden-model";

/** 夹具的目录名。它是相对路径的根，所以它会出现在请求里（固定件里被替换成 `<repo>`）。 */
export const FIXTURE_DIR = "demo";

// ---------------------------------------------------------------------------
// 剧本 DSL
// ---------------------------------------------------------------------------

/** 一条断言：`lines` 省略即"整文件级"（Core 的 `null`），`excerpt` 省略即空串。 */
export interface GoldenEvidence {
  readonly path: string;
  readonly lines?: readonly [number, number];
  readonly excerpt?: string;
}

export interface GoldenClaim {
  readonly text: string;
  readonly evidence?: readonly GoldenEvidence[];
}

/**
 * 一轮：模型做了什么。
 *
 * 只有五种，正好穷尽模型说得出的东西：读材料、列目录、搜文本、交结论、要人。
 * `fail` 是第六种，它不是模型的选择而是 provider 的收场——它也必须有个位置，
 * 否则"provider 报错"就只能靠真机才能记录。
 */
export type ScriptStep =
  | { readonly do: "list_dir"; readonly path: string }
  | { readonly do: "search_text"; readonly pattern: string; readonly maxMatches: number }
  | {
      readonly do: "read_file";
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
    }
  | { readonly do: "report"; readonly summary: string; readonly claims: readonly GoldenClaim[] }
  | { readonly do: "ask"; readonly question: string }
  | {
      readonly do: "fail";
      /** provider 的原话。它会原样进 `run_failed.error.message`。 */
      readonly message: string;
      /** 这句话**应该**被认成哪个码。适配器那张表必须同意这一点。 */
      readonly code: string;
    };

export interface GoldenCase {
  /** 用例名。它就是固定件的文件名，所以它必须是稳定的标识符。 */
  readonly name: string;
  /** 这个用例专门钉什么。 */
  readonly pins: string;
  readonly goal: string;
  readonly checks: readonly string[];
  /** 夹具仓库的内容（路径 → 文本）。仓库由测试写进临时目录。 */
  readonly files: Readonly<Record<string, string>>;
  readonly steps: readonly ScriptStep[];
  /** 覆盖默认预算的字段。省略即 `DEFAULT_BUDGET`。 */
  readonly budget?: Partial<RunBudget>;
  /**
   * 第几次工具调用（从 1 起）**期间**触发外部取消。
   *
   * 为什么放在工具执行期间，而不是放在模型请求期间：这里记录语料时撞到的一个真实
   * 差别——**取消是被谁先发现的，两条路不一样**。
   * 真流的 `AbortSignal` 是"流"自己看着的，请求被取消时它会以
   * `stopReason: "aborted"` 收尾，于是取消在 `decide` **里面**就被认出来了
   * （那一轮因此没有 `decision_made`）；而假模型端口没有人看信号，它照常返回决策，
   * 取消落在下一个检查点上（那一轮**有** `decision_made`）。
   * 终态在两条路上都是 `run_cancelled`，但事件条数差一条。
   *
   * 工具执行期间是唯一两条路都落在同一处的地方：取消由**共享的**执行层发起，
   * 谁都没有"先发现"的优势。于是这条语料钉的是"取消落在工具执行中间"，
   * 而"取消落在模型请求中间"的那一点差别由 `golden.test.ts` 里一条专门的
   * 测试单独说明——它不该被这条例行语料顺手抹平。
   */
  readonly cancelAtTool?: number;
  /**
   * 第几次模型调用（从 0 起）**内部**触发外部取消。
   *
   * 只有一条测试用它：证明上面那段注释里说的差别真的存在，且终态仍然一致。
   * 语料本身不用它——它会让两条路的日志不等价。
   */
  readonly cancelAtCall?: number;
}

// ---------------------------------------------------------------------------
// 夹具：一个小仓库
// ---------------------------------------------------------------------------

const README = [
  "# 演示仓库",
  "",
  "这个夹具是 golden 语料的材料，不是这个项目的一部分。",
  "",
  "TODO: 把归档开关接上（见 src/app.ts）。",
  "",
].join("\n");

const APP_TS = [
  "// 演示用的入口文件。",
  'import { archive } from "./util.js";',
  "",
  "export function run(): void {",
  "  // TODO: 归档开关还没有接进来。",
  '  archive("demo");',
  "}",
  "",
].join("\n");

const UTIL_TS = [
  "export function archive(name: string): string {",
  "  return `archived:${name}`;",
  "}",
  "",
].join("\n");

const SPEC_MD = ["# 规格", "", "- 归档必须可关闭。", ""].join("\n");

/**
 * 一个 60 行的大文件。它的读窗口 JSON 会超过 `OBSERVATION_CHAR_LIMIT`（8000），
 * 于是观测被替换成一段预览、`truncated` 为真——而 `truncated` 的那 8000 个字符
 * 本身就是"截断真的发生过"的证据，所以它出现在固定件里是对的。
 */
const BIG_TS = `${Array.from(
  { length: 60 },
  (_, index) => `export const value${index} = "${"x".repeat(150)}";`,
).join("\n")}\n`;

/** 标准夹具：四个文件，`TODO` 只出现在两处，遍历顺序唯一。 */
const DEMO_FILES: Readonly<Record<string, string>> = Object.freeze({
  "README.md": README,
  "notes/spec.md": SPEC_MD,
  "src/app.ts": APP_TS,
  "src/util.ts": UTIL_TS,
});

const COMPLETE_STEPS: readonly ScriptStep[] = Object.freeze([
  { do: "list_dir", path: "." },
  { do: "search_text", pattern: "TODO", maxMatches: 5 },
  { do: "read_file", path: "README.md", startLine: 1, endLine: 5 },
  {
    do: "report",
    summary: "仓库里还有两处 TODO，其中一处是归档开关。",
    claims: [
      {
        text: "README 的第 5 行记着归档开关还没接上。",
        evidence: [
          {
            path: "README.md",
            lines: [5, 5],
            excerpt: "TODO: 把归档开关接上（见 src/app.ts）。",
          },
        ],
      },
      {
        // 这一条**故意**没有依据。它不改变终态（终态由**材料**决定，不是由结论的
        // 自省程度决定：`collectMissingMaterial` 只看观测），但它把
        // "说了但没找到依据"这个 Core 明确表示的取值放进了语料——
        // 于是"`evidence: []` 会不会在某一层被悄悄换成 undefined"有人看着。
        text: "归档功能上线后没有回滚方案。",
        evidence: [],
      },
    ],
  },
]);

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

export const GOLDEN_CASES: readonly GoldenCase[] = Object.freeze([
  {
    name: "01-complete-report",
    pins: "最平常的一条：列目录 → 搜文本 → 读文件 → 交结论；终态 complete。",
    goal: "这个仓库里还有哪些没做完的事？",
    checks: ["TODO 的位置", "归档开关的状态"],
    files: DEMO_FILES,
    steps: COMPLETE_STEPS,
  },

  {
    name: "02-partial-tool-failure",
    pins: "一次工具失败被隔离：Run 继续、结论照交，而缺失的材料被点名 → partial。",
    goal: "仓库外面那个文件说了什么？",
    checks: ["跨仓库读取"],
    files: DEMO_FILES,
    steps: [
      // 路径越界：它是 `invalid_args`，而且报错文本里**不含绝对路径**——
      // 这是选它而不是"文件不存在"的原因（后者会把临时目录带进固定件）。
      { do: "read_file", path: "../outside.txt", startLine: 1, endLine: 5 },
      {
        do: "report",
        summary: "没能读到仓库外的那个文件。",
        claims: [{ text: "仓库外的内容不可得。", evidence: [] }],
      },
    ],
  },

  {
    name: "03-partial-truncation",
    pins: "一次观测被截断：材料只拿到一部分，`truncated` 为真 → partial。",
    goal: "那个大文件的第 30 行写着什么？",
    checks: ["大文件读取"],
    files: { ...DEMO_FILES, "src/big.ts": BIG_TS },
    steps: [
      { do: "read_file", path: "src/big.ts", startLine: 1, endLine: 60 },
      {
        do: "report",
        summary: "读到了那个文件，但只拿到一段预览。",
        claims: [
          {
            text: "第 30 行是一个导出的常量。",
            evidence: [{ path: "src/big.ts", lines: [30, 30] }],
          },
        ],
      },
    ],
  },

  {
    name: "04-provider-error-retried",
    pins: "限流被重试一次然后成功：`model_requested` 出现两次，终态仍是 complete。",
    goal: "重试之后还能不能拿到结论？",
    checks: ["重试记录"],
    files: DEMO_FILES,
    budget: { maxRetries: 1 },
    steps: [
      { do: "fail", message: "429 Too Many Requests: slow down", code: "rate_limited" },
      { do: "list_dir", path: "." },
      {
        do: "report",
        summary: "重试之后列了目录。",
        claims: [{ text: "仓库根目录有 README.md。", evidence: [{ path: "README.md" }] }],
      },
    ],
  },

  {
    name: "05-provider-error-permanent",
    pins: "凭据错误不重试：一次请求就结束，终态 run_failed{auth}。",
    goal: "凭据不对时会怎样？",
    checks: ["失败分类"],
    files: DEMO_FILES,
    // 只写一步不是偷懒：`auth` 在重试分类里是"重发不会改变结果"的那一类
    // （`src/runtime/retry.ts` 的 `RETRYABLE`），所以这里就该只被问一次。
    // 要是哪天它变成可重试的，脚本会在第二次调用时用尽并**当场报错**——
    // 这正是"脚本用尽即失败"这条规矩的价值：行为变了，语料会响。
    budget: { maxRetries: 2 },
    steps: [{ do: "fail", message: "401 Unauthorized: invalid api key", code: "auth" }],
  },

  {
    name: "06-budget-tool-calls",
    pins: "工具预算到顶：第三次调用在 `tool_started` **之前**被拦下，终态 budget_tools。",
    goal: "一直列目录会怎样？",
    checks: ["预算执法"],
    files: DEMO_FILES,
    budget: { maxToolCalls: 2 },
    steps: [
      { do: "list_dir", path: "." },
      { do: "list_dir", path: "src" },
      { do: "list_dir", path: "notes" },
    ],
  },

  {
    name: "07-cancelled-external",
    pins: "外部取消落在工具执行中间：意图已下、这次调用没有回来，终态 run_cancelled（不是失败）。",
    goal: "取消发生在工具执行中间会怎样？",
    checks: ["取消执法"],
    files: DEMO_FILES,
    cancelAtTool: 2,
    steps: [
      { do: "list_dir", path: "." },
      { do: "read_file", path: "README.md", startLine: 1, endLine: 5 },
      {
        do: "report",
        summary: "这一条不该被交付：Run 在它之前就停了。",
        claims: [],
      },
    ],
  },

  {
    name: "08-awaiting-human",
    pins: "挂起：`human_input_requested` 而没有终态事件——挂起不等于结束。",
    goal: "这个仓库的验收标准是什么？",
    checks: ["需要人回答的问题"],
    files: DEMO_FILES,
    steps: [
      { do: "list_dir", path: "." },
      { do: "ask", question: "这个仓库的验收标准是什么？" },
    ],
  },
]);

/** 按名字取一个用例。名字写错时抛错，而不是安静地找不到。 */
export function caseNamed(name: string): GoldenCase {
  const found = GOLDEN_CASES.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`语料里没有名为 ${name} 的用例（现有：${GOLDEN_CASES.map((c) => c.name).join(", ")}）`);
  }
  return found;
}
