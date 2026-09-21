/**
 * 渲染 —— trace 的**文字形式**。
 *
 * 它刻意与 `src/runtime/trace.ts` 分开：那边是**结构**（哪些字段、什么含义），
 * 这边是**呈现**（缩进、括号、怎么把一个 `null` 说清楚）。分开的收益是可以
 * 分别断言——"停止原因是 `cancelled`" 与 "那一行印成了 `cancelled（被取消）`"
 * 是两件需要各自被钉住的事，混在一个函数里就只能测字符串。
 *
 * ## 三条呈现上的规矩
 *
 * 1. **不知道就说不知道。** `inputTokens === null` 印成"provider 未报告"，
 *    不印 `0`。这与整个项目对"没测到 ≠ 没花钱"的态度是同一条。
 * 2. **失败的原因要能被复制粘贴。** 失败的行印出码与原文，而不是一个概括——
 *    概括是分析，而这一层不做分析。
 * 3. **核对结果永远印出来**，哪怕它是"全部通过"。一个只在出错时才出现的检查框
 *    会让人以为没看到就是没检查（`EvidenceAudit` 的三条正是为此）。
 */

import { REDACTED } from "../core/redact.js";
import type { AgentEvent, Report } from "../core/types.js";
import { digestIntent } from "../runtime/tool-runner.js";
import type { RunTrace, TraceStep } from "../runtime/trace.js";
import type { EvidenceAudit } from "../runtime/verify.js";
import { EXIT } from "./args.js";

const WIDTH = 78;

/** 一行分隔线。标题为空时就是一条横线。 */
export function rule(title = ""): string {
  const tail = title.length === 0 ? WIDTH : Math.max(0, WIDTH - title.length - 4);
  const bar = "─".repeat(tail);
  return title.length === 0 ? bar : `── ${title} ${bar}`;
}

/** 一行文本压成一行、截断。报告里的摘要是模型给的，长度不可控。 */
export function clip(text: string, limit = 96): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** 毫秒。小于 1ms 的时候不要印成 `0ms`——那看起来像"没花时间"。 */
function ms(value: number): string {
  if (value < 1) return "<1ms";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function tokens(value: number | null): string {
  return value === null ? "provider 未报告" : String(value);
}

/** 一个 JSON 值 → 一段紧凑的、长度有界的表示。 */
function inline(value: unknown, limit = 60): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return clip(text, limit);
}

// ---------------------------------------------------------------------------
// 进度：一次 Run 正在发生
// ---------------------------------------------------------------------------

/**
 * 一条事件 → 一行进度（返回 `null` 表示这条事件不值得单独一行）。
 *
 * **它是给正在等的人看的，不是证据。** 证据是日志；这里是"现在到哪一步了"。
 * 两者不该混：进度行可以少印，日志不能少写（所以这份渲染永远不会被用来
 * 决定任何事，也永远不会写进日志）。
 */
export function progressLine(event: AgentEvent): string | null {
  switch (event.type) {
    case "run_started":
      return `run ${event.runId} 开始`;
    case "model_requested":
      return `  · 问模型（${event.model ?? "未指名"}）`;
    case "decision_made":
      if (event.decision.kind === "call_tool") {
        return `  → ${digestIntent(event.decision.intent)}`;
      }
      if (event.decision.kind === "ask_human") {
        return `  ? 需要人来回答`;
      }
      return `  ✓ 交付结论`;
    case "tool_completed":
      return `  ← ${event.toolName} ${event.status === "success" ? "成功" : `失败（${event.error?.code ?? "?"}）`} ${ms(event.durationMs)}`;
    case "human_input_requested":
      return `  ! 挂起等人：${clip(event.question, 70)}`;
    case "usage_reported":
      return `  $ 输入 ${tokens(event.usage.inputTokens)} / 输出 ${tokens(event.usage.outputTokens)} token，工具 ${event.usage.toolCalls} 次`;
    case "run_failed":
      return `  ✗ 失败 ${event.error.code}：${clip(event.error.message, 70)}`;
    case "run_cancelled":
      return `  ✗ 被取消`;
    case "run_completed":
      return `  ✓ 收工（${event.status}）`;
    // 这些在进度条上是噪声：观测的内容会出现在结论里，而 tool_started 紧跟决策。
    case "tool_started":
    case "observation_added":
    case "human_input_received":
    case "run_resumed":
      return null;
    default: {
      const unhandled: never = event;
      throw new Error(`进度渲染没有处理这种事件：${JSON.stringify(unhandled)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// trace：已经发生完的一次 Run
// ---------------------------------------------------------------------------

/** 「为什么停」那一行。每个分支都要印出**码或状态名**，然后是白话。 */
export function stopLine(trace: RunTrace): string {
  const stop = trace.stop;
  switch (stop.kind) {
    case "completed":
      return stop.status === "complete"
        ? "completed（有结论，材料齐）"
        : `completed / partial（有结论，但缺 ${stop.missingMaterial.length} 项材料）`;
    case "failed":
      return `failed（${stop.code}）—— ${clip(stop.message, 90)}`;
    case "cancelled":
      return "cancelled（被取消：不会再做任何事）";
    case "awaiting_human":
      return `awaiting_human（挂起，等一个只有人能给的输入）—— ${clip(stop.question, 70)}`;
    case "unfinished":
      return `unfinished（日志到此为止，位置是 ${stop.status}）`;
    default: {
      const unhandled: never = stop;
      throw new Error(`停止原因渲染没有处理这种收场：${JSON.stringify(unhandled)}`);
    }
  }
}

function evidenceLine(path: string, lines: readonly [number, number] | null, excerpt: string): string[] {
  const where = lines === null ? path : `${path}:${lines[0]}-${lines[1]}`;
  const out = [`        证据 ${where}`];
  if (excerpt.length > 0) out.push(`        │ ${clip(excerpt, 68)}`);
  return out;
}

/** 结论。每条论断都印出来，包括**没有依据**的那些。 */
export function reportLines(report: Report): string[] {
  const out = [`  ${clip(report.summary, 200)}`];
  if (report.claims.length === 0) {
    out.push("  （这份结论一条论断都没有——它只是一段话）");
    return out;
  }
  report.claims.forEach((claim, index) => {
    out.push(`  ${index + 1}. ${clip(claim.text, 160)}`);
    if (claim.evidence.length === 0) {
      out.push("        （这条论断**没有给依据**——它被显式写出来，而不是被省略）");
      return;
    }
    for (const evidence of claim.evidence) {
      out.push(...evidenceLine(evidence.path, evidence.lines, evidence.excerpt));
    }
  });
  return out;
}

/**
 * 核对结果。三条都要印，包括通过。
 *
 * `null` 有**两种**来源，而它们的白话完全不同：
 *
 * - 这次 Run **没有交付结论**（失败、取消、挂起）——那时确实没有东西需要核对；
 * - 这次 Run 有结论，但**我们没有核对**——`kuse trace` 是只读的，它没有仓库上下文，
 *   所以它不做核对（见 `main.ts` 的 `auditSkipped`）。
 *
 * 把它们合成一句"这次 Run 没有交付结论"是一句假话：它会让读的人以为那次 Run
 * 根本没产出结论，而上面几行正印着那份结论。所以"有没有结论"必须由调用方告诉这里，
 * 不能由这一层猜——这也是它多一个参数的唯一理由。
 */
export function auditLines(audit: EvidenceAudit | null, hasReport: boolean): string[] {
  if (audit === null) {
    return [
      hasReport
        ? "  （这份结论**没有核对**：只读模式没有仓库上下文。想核对请重跑 `kuse run`）"
        : "  （这次 Run 没有交付结论，所以没有东西需要核对）",
    ];
  }
  const out = [
    `  证据 ${audit.supported}/${audit.total} 条对得上材料` +
      (audit.total === 0 ? "（这条结论引用零条证据）" : ""),
    `  论断 ${audit.unbacked.length} 条明说没有依据`,
  ];
  if (!audit.conclusive) {
    // 说不确定就要说清为什么，否则这条降级和"没核对"看起来会一样。
    out.push(
      `  ? 有 ${audit.truncatedObservations} 条观测超长被截断，结构已丢：` +
        `上面的条目只能读作"在能读到的材料里没找到"，不是"没看过"`,
    );
  }
  for (const label of audit.unsupported) {
    // 措辞随确定性一起降级。截断过的时候，"没有任何一次调用看到过这几行"是
    // 一句**我们不成立的指控**——我们只是看不见那部分材料。
    out.push(
      audit.conclusive
        ? `  ✗ ${label} —— 没有任何一次调用看到过这几行`
        : `  ? ${label} —— 在能读到的材料里没找到（有材料被截断，看不见）`,
    );
  }
  for (const text of audit.unbacked) {
    out.push(`  · 无依据：${clip(text, 70)}`);
  }
  return out;
}

/**
 * 完整的人类可读 trace。三段正好对应必须回答的三个问题。
 *
 * `header` 是调用方给的几行上下文（仓库、会话、日志路径），因为那几件事
 * 不在事件里——它们属于"这次 Run 是怎么被发起的"。
 */
export function traceLines(
  trace: RunTrace,
  audit: EvidenceAudit | null,
  header: readonly string[],
): string[] {
  const out: string[] = [];

  if (header.length > 0) {
    out.push(rule(), ...header);
  }

  out.push("", rule("调用了什么"));
  if (trace.steps.length === 0) {
    out.push("  （一次工具都没有调用）");
  } else {
    for (const step of trace.steps) {
      out.push(`  ${String(step.index).padStart(2)}  ${stepLine(step)}`);
    }
  }

  out.push("", rule("为什么停"), `  ${stopLine(trace)}`);
  const stop = trace.stop;
  if (stop.kind === "completed" && stop.missingMaterial.length > 0) {
    for (const item of stop.missingMaterial) out.push(`    · ${item}`);
  }

  out.push("", rule("结论"));
  out.push(...(trace.report === null ? ["  （没有结论）"] : reportLines(trace.report)));

  out.push("", rule("证据核对"), ...auditLines(audit, trace.report !== null));

  out.push(
    "",
    rule("花了多少"),
    `  输入 token   ${tokens(trace.usage?.inputTokens ?? null)}`,
    `  输出 token   ${tokens(trace.usage?.outputTokens ?? null)}`,
    `  工具调用     ${trace.usage === null ? "没有账目事件" : trace.usage.toolCalls}`,
    `  耗时         ${trace.usage === null ? "没有账目事件" : ms(trace.usage.durationMs)}`,
    `  模型         ${trace.model ?? "未指名"}`,
    `  事件         ${trace.eventCount} 条（${span(trace)}）`,
  );

  return out;
}

function span(trace: RunTrace): string {
  if (trace.startedAt === null || trace.endedAt === null) return "日志是空的";
  return `跨度 ${ms(Math.max(0, trace.endedAt - trace.startedAt))}`;
}

function stepLine(step: TraceStep): string {
  const args = inline(step.args);
  const status =
    step.status === "success"
      ? "ok"
      : step.status === "error"
        ? `失败 ${step.errorCode ?? "?"}`
        : "没有返回";
  const flags = step.truncated ? " 截断" : "";
  return `${step.tool}(${args})  ${status}  ${ms(step.durationMs)}${flags}`;
}

/** 退出码 → 一行说明。用在结尾，让脚本作者不必翻文档。 */
export function exitLine(code: number): string {
  const named = Object.entries(EXIT).find(([, value]) => value === code);
  return named === undefined ? `exit ${code}` : `exit ${code}（${named[0]}）`;
}

/**
 * 输出里出现过脱敏标记时要打的一句提醒。
 *
 * 抹掉与"原文就长这样"必须能被区分开——否则看到 `[已脱敏]` 的人会以为工具结果里
 * 真的写着这五个字。同时说清事件日志里保存的是原文，因为那是证据。
 */
export const REDACTION_NOTICE = `注意：输出里出现过 ${REDACTED} —— 有凭据形状的文本被抹掉了，这不是原文。事件日志里保存的仍是原文（它是证据，我们不改写它）。`;
