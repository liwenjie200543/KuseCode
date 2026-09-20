/**
 * 终止协议：模型怎么**说出**「我干完了」和「我需要人」。
 *
 * 这个文件回答一个架构问题：`Decision` 有三种，但模型只输出两种东西——文本和工具调用。
 * `call_tool` 天然对应工具调用，那 `respond` 和 `ask_human` 呢？
 *
 * 答案是把它们也做成工具调用：两个**协议工具**。理由有三条，第三条是决定性的。
 *
 * 1. **类型化。** 从散文里解析 `Report`（"请以 JSON 回答"）是最脆弱的一种接口：
 *    模型会加前后缀、会用 markdown 包裹、会漏一个括号。协议工具的参数是 provider
 *    原生的结构化输出，模型被约束在 schema 里。
 * 2. **一次说完。** `summary` 与 `claims` 在同一个参数对象里，不存在"摘要到了、
 *    证据还在下一个 token 流里"这种中间态。
 * 3. **它们是适配器的词汇，不是执行层的词汇。** 协议工具**从不**交给 `ToolPort`：
 *    它们不产生观测、不碰外部世界、没有副作用。`ToolPort.names` 里也没有它们。
 *    这条边界很重要——否则"模型能决定自己去读文件"和"模型能决定自己收工"
 *    会走同一条路径，而后者不是一次工具执行。
 *
 * 参数是**不可信输入**：模型可能给出任何形状。校验规则只有一条，而且它同时
 * 解释了"为什么有的字段可以宽容、有的必须当场失败"：
 *
 * > **Core 有对应表示的，收敛到那个表示；Core 没有对应表示的，当场失败。**
 *
 * 于是 `evidence` 缺失 → `[]`（Core 说"空数组就是我说了但没找到依据"，这正是
 * "模型没给证据"的正确读法）、`lines` 缺失 → `null`（Core 说整文件级证据为 null）、
 * `excerpt` 缺失 → `""`（"引用了但没摘录"，是一个可见的取值）。
 * 而 `text` / `summary` / `question` 缺失时没有诚实的替代品——编一个就是伪造，
 * 所以抛 `invalid_tool` 并指名是哪个字段。
 */

import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import type { Claim, Evidence, Provenance, Report } from "../../core/types.js";
import { AdapterError } from "./errors.js";

/** 模型用来交付最终结论的协议工具名。 */
export const SUBMIT_REPORT_TOOL = "submit_report";
/** 模型用来声明"我需要人"的协议工具名。 */
export const ASK_HUMAN_TOOL = "ask_human";

/**
 * 协议工具的名字。
 *
 * 真实工具（`ToolPort.names`）**不得**占用这些名字，否则模型说要读文件时
 * 适配器会把它当成"收工"。这条约束由 `createToolCatalog` 在注册时强制。
 */
export const TERMINAL_TOOL_NAMES: readonly string[] = Object.freeze([
  SUBMIT_REPORT_TOOL,
  ASK_HUMAN_TOOL,
]);

/** 这个工具名是不是协议工具（即：它由适配器消费，不交给执行层）。 */
export function isTerminalTool(name: string): boolean {
  return name === SUBMIT_REPORT_TOOL || name === ASK_HUMAN_TOOL;
}

// ---------------------------------------------------------------------------
// 模型看到的 schema
// ---------------------------------------------------------------------------

const evidenceSchema = Type.Object({
  path: Type.String({ description: "文件路径，相对仓库根目录" }),
  lines: Type.Optional(
    Type.Union([Type.Tuple([Type.Number(), Type.Number()]), Type.Null()], {
      description: "行号区间 [起, 止]（含两端）；整文件级证据写 null",
    }),
  ),
  excerpt: Type.Optional(Type.String({ description: "被引用的原文片段" })),
});

const claimSchema = Type.Object({
  text: Type.String({ description: "一条论断" }),
  evidence: Type.Optional(
    Type.Array(evidenceSchema, { description: "支撑这条论断的证据；没有就写空数组" }),
  ),
});

/** `submit_report` 的 schema：模型交付结论的形状。 */
export const submitReportSchema: TSchema = Type.Object({
  summary: Type.String({ description: "回答的摘要" }),
  claims: Type.Optional(Type.Array(claimSchema, { description: "逐条结论，每条都指向证据" })),
});

/** `ask_human` 的 schema。 */
export const askHumanSchema: TSchema = Type.Object({
  question: Type.String({ description: "只有人才能回答的问题" }),
});

/** 两个协议工具的完整描述，直接进 `Context.tools`。 */
export const TERMINAL_TOOLS: readonly { readonly name: string; readonly description: string; readonly parameters: TSchema }[] =
  Object.freeze([
    {
      name: SUBMIT_REPORT_TOOL,
      description:
        "交付最终结论。summary 是摘要；每条结论都写进 claims，并在 evidence 里给出文件路径与行号。" +
        "没有找到依据的结论也要写出来，把 evidence 留空数组——不要为了好看而省略它。",
      parameters: submitReportSchema,
    },
    {
      name: ASK_HUMAN_TOOL,
      description:
        "当且仅当你无法通过读取仓库得出结论、且只有人才能回答时使用。附上你需要的具体信息。",
      parameters: askHumanSchema,
    },
  ]);

// ---------------------------------------------------------------------------
// 校验：形状检查，带指名的失败
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 字段缺失/类型不对时的统一失败。`where` 是给 trace 看的定位。 */
function bad(where: string, expected: string): never {
  throw new AdapterError({
    code: "invalid_tool",
    message: `${SUBMIT_REPORT_TOOL} 的参数不合法：${where} ${expected}`,
  });
}

function readLines(value: unknown, where: string): readonly [number, number] | null {
  // 缺失与显式 null 都是"整文件级证据"（Core 的表示）
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) bad(where, "必须是 [起, 止] 两个数字，或 null");
  const [start, end] = value as unknown[];
  if (typeof start !== "number" || typeof end !== "number") bad(where, "的两个元素都必须是数字");
  if (!Number.isInteger(start) || !Number.isInteger(end)) bad(where, "的两个元素都必须是整数");
  if (end < start) bad(where, "的止行号小于起行号");
  return [start, end];
}

function readEvidence(value: unknown, where: string, provenance: Provenance): Evidence {
  if (!isRecord(value)) bad(where, "必须是一个对象 { path, lines?, excerpt? }");
  const path = value["path"];
  if (typeof path !== "string" || path.length === 0) bad(`${where}.path`, "必须是一个非空字符串");
  const excerpt = value["excerpt"];
  if (excerpt !== undefined && typeof excerpt !== "string") bad(`${where}.excerpt`, "必须是字符串");
  return {
    path,
    lines: readLines(value["lines"], `${where}.lines`),
    // 没给摘录 → 空串：一个可见的取值，而不是编造一段原文
    excerpt: typeof excerpt === "string" ? excerpt : "",
    provenance,
  };
}

function readClaim(value: unknown, index: number, provenance: Provenance): Claim {
  const where = `claims[${index}]`;
  if (!isRecord(value)) bad(where, "必须是一个对象 { text, evidence? }");
  const text = value["text"];
  if (typeof text !== "string" || text.length === 0) bad(`${where}.text`, "必须是一个非空字符串");
  const raw = value["evidence"];
  if (raw !== undefined && !Array.isArray(raw)) bad(`${where}.evidence`, "必须是数组或省略");
  const evidence = Array.isArray(raw)
    ? raw.map((item, i) => readEvidence(item, `${where}.evidence[${i}]`, provenance))
    : [];
  return { text, evidence };
}

/**
 * `submit_report` 的参数 → `Report`。
 *
 * `provenance` 由**我们**写入，不是模型给的：模型不知道"什么时候"，而
 * `Provenance.at` 是回放时必须沿用的值。这里给的 `source: "model"` 说的是
 * 一句实话——这条论断是模型综合出来的，不是某次工具调用的直接产物。
 * （工具调用的 provenance 由 Runtime 写在观测上，两者名字相同、来路不同。）
 */
export function readReport(args: unknown, provenance: Provenance): Report {
  if (!isRecord(args)) bad("参数", "必须是一个对象 { summary, claims? }");
  const summary = args["summary"];
  if (typeof summary !== "string") bad("summary", "必须是字符串");
  const raw = args["claims"];
  if (raw !== undefined && !Array.isArray(raw)) bad("claims", "必须是数组或省略");
  const claims = Array.isArray(raw) ? raw.map((item, i) => readClaim(item, i, provenance)) : [];
  return { summary, claims };
}

/** `ask_human` 的参数 → 问题文本。 */
export function readQuestion(args: unknown): string {
  if (!isRecord(args)) {
    throw new AdapterError({
      code: "invalid_tool",
      message: `${ASK_HUMAN_TOOL} 的参数不合法：参数必须是一个对象 { question }`,
    });
  }
  const question = args["question"];
  if (typeof question !== "string" || question.length === 0) {
    throw new AdapterError({
      code: "invalid_tool",
      message: `${ASK_HUMAN_TOOL} 的参数不合法：question 必须是一个非空字符串`,
    });
  }
  return question;
}
