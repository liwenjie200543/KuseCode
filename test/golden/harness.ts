/**
 * golden 的驱动方 —— 同一份语料，两条路。
 *
 * 这个文件只回答一个问题：**怎么把一份中性的剧本，在两条互不相干的路上跑出来？**
 *
 * - `driveCore`：剧本 → `Decision` → 假模型端口 → Core 的循环。这条路上没有 SDK。
 * - `driveSdk`：剧本 → `AssistantMessage` → 真 `pi-ai` 流 → 适配器 → Core 的循环。
 *
 * 两条路唯一的差别就是"谁在 `decide` 里干活"，其余（工具、执行层、预算、时钟、身份、
 * 事件日志）完全是同一批对象。于是两份日志的差异只可能来自适配器——这正是
 * 「SDK 是可替换的」那句话可被检验的形式。
 *
 * ## 两处**不是**等价性的一部分，所以显式抹掉
 *
 * 1. **provider 报的 token 数。** 真流里的 `usage` 是 provider 自己算的
 *    （`fauxAssistantMessage` 按文本长度给数），而假模型端口根本没有账本，
 *    两项是 `null`。这不是语义差异，是"谁有能力知道"的差异：
 *    所以等价性比较里这两项被换成 `"<provider>"`，**固定件里同样如此**——
 *    faux 的数字按文本长度算，而请求文本带着夹具的绝对路径，Windows 与 Linux
 *    的路径长度不同，同一个语义会算出不同的数（CI 实测撞到）。「报了账」
 *    由 golden.test.ts 的形状断言看着：`usage_reported` 必须存在且是真实数字。
 * 2. **夹具的绝对路径。** 夹具写在临时目录里，路径每次不同。固定件里它被换成
 *    `<repo>`，替换是**前缀式**的——别的绝对路径要是漏进来，照样看得见。
 *
 * 除这两处之外，两条路的事件流必须**逐字节相同**，包括 `sequence`、`timestamp`、
 * 每个 `Decision`、每条观测、每个工具结果、终态事件。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context as PiContext } from "@earendil-works/pi-ai";

import { piModelAdapter } from "../../src/adapter/pi/model.js";
import { catalogFromToolbox } from "../../src/adapter/pi/catalog.js";
import { ASK_HUMAN_TOOL, SUBMIT_REPORT_TOOL } from "../../src/adapter/pi/protocol.js";
import type {
  AgentEvent,
  Decision,
  Evidence,
  Report,
  RunBudget,
  Task,
  ToolIntent,
  ToolOutcome,
  ToolPort,
} from "../../src/core/types.js";
import { DEFAULT_BUDGET } from "../../src/runtime/budget.js";
import { sequentialIds } from "../../src/runtime/ids.js";
import { memoryRunLog } from "../../src/runtime/run-log.js";
import { createRuntime } from "../../src/runtime/run-agent.js";
import { traceOf } from "../../src/runtime/trace.js";
import type { RunTrace } from "../../src/runtime/trace.js";
import { createToolRunner } from "../../src/runtime/tool-runner.js";
import { createRepoTools } from "../../src/tools/repo-tools.js";
import type { Toolbox } from "../../src/tools/repo-tools.js";
import { decidingModel } from "../../src/testing/fake-model.js";

import { FIXTURE_DIR, GOLDEN_MODEL, GOLDEN_NOW } from "./corpus.js";
import type { GoldenCase, GoldenClaim, GoldenEvidence, ScriptStep } from "./corpus.js";

/** 固定时钟。两条路都用它，否则 `provenance.at` 没法相等。 */
const now = (): number => GOLDEN_NOW;

/** 退避不真的等：等多久由 `retry.ts` 的政策决定，而它在自己的测试里被钉住。 */
const noSleep = async (): Promise<void> => {};

// ---------------------------------------------------------------------------
// 夹具：一份内容 → 一个真实目录
// ---------------------------------------------------------------------------

async function writeFixture(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = resolve(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
}

/**
 * 在一个临时目录里跑一段代码，跑完删掉。
 *
 * 传进去的是**已经 `resolve` 过**的根：`maskRepo` 靠它做前缀替换，
 * 而 `createRepoTools` 内部也 `resolve` 一次——两份字符串必须一模一样，
 * 否则固定件里会残留半条路径。
 */
export async function withFixture<T>(
  files: Readonly<Record<string, string>>,
  body: (repoRoot: string) => Promise<T>,
): Promise<T> {
  const root = resolve(await mkdtemp(join(tmpdir(), "kuse-golden-")));
  try {
    await writeFixture(root, files);
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 夹具在固定件里的名字。它出现在请求里，所以要被替换掉。 */
export function fixtureLabel(): string {
  return `<repo:${FIXTURE_DIR}>`;
}

// ---------------------------------------------------------------------------
// 剧本 → 两个方向的产物
// ---------------------------------------------------------------------------

/** 一次调用的意图。**两侧共用**，所以它只有一份写法。 */
function intentOf(step: ScriptStep): { readonly name: string; readonly args: Record<string, unknown> } {
  switch (step.do) {
    case "list_dir":
      return { name: "list_dir", args: { path: step.path } };
    case "search_text":
      return { name: "search_text", args: { pattern: step.pattern, maxMatches: step.maxMatches } };
    case "read_file":
      return {
        name: "read_file",
        args: { path: step.path, startLine: step.startLine, endLine: step.endLine },
      };
    default:
      throw new Error(`这个剧本步骤不是一次工具调用：${step.do}`);
  }
}

/**
 * 剧本里的证据 → Core 的证据。
 *
 * 省略即收敛：`lines` 省略是"整文件级"（`null`），`excerpt` 省略是空串。
 * 这两条收敛规则与适配器的 `readReport` 完全一致——不是巧合，
 * 因为"Core 有表示就收敛"是两条路都必须遵守的同一条规则。
 */
function evidenceOf(evidence: GoldenEvidence, report: Evidence[]): void {
  report.push({
    path: evidence.path,
    lines: evidence.lines === undefined ? null : evidence.lines,
    excerpt: evidence.excerpt ?? "",
    provenance: { source: "model", at: GOLDEN_NOW },
  });
}

function reportOf(claims: readonly GoldenClaim[], summary: string): Report {
  return {
    summary,
    claims: claims.map((claim) => {
      const evidence: Evidence[] = [];
      for (const item of claim.evidence ?? []) evidenceOf(item, evidence);
      return { text: claim.text, evidence };
    }),
  };
}

/** 剧本里的一条断言 → `submit_report` 的参数。省略的字段**真的省略**。 */
function reportArgsOf(claims: readonly GoldenClaim[], summary: string): Record<string, unknown> {
  return {
    summary,
    claims: claims.map((claim) => ({
      text: claim.text,
      evidence: (claim.evidence ?? []).map((item) => ({
        path: item.path,
        ...(item.lines === undefined ? {} : { lines: item.lines }),
        ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
      })),
    })),
  };
}

/** 剧本的一步 → 一个 `Decision`（假模型那一侧）。 */
function decisionOf(step: ScriptStep): Decision {
  switch (step.do) {
    case "list_dir":
    case "search_text":
    case "read_file":
      return { kind: "call_tool", intent: intentOf(step) };
    case "report":
      return { kind: "respond", report: reportOf(step.claims, step.summary) };
    case "ask":
      return { kind: "ask_human", question: step.question };
    case "fail":
      // provider 的失败不是一次决策：它是端口**抛出来**的东西。
      // 形状与适配器抛的 `AdapterError` 一样（带一个合法的 `code`），
      // 而 Runtime 只认这个形状——`toRunError` 不关心它是不是一个 `Error`。
      throw { code: step.code, message: step.message };
  }
}

/** 剧本的一步 → 一条 `AssistantMessage`（SDK 那一侧）。 */
function messageOf(step: ScriptStep): AssistantMessage {
  switch (step.do) {
    case "list_dir":
    case "search_text":
    case "read_file": {
      const intent = intentOf(step);
      return fauxAssistantMessage(fauxToolCall(intent.name, intent.args));
    }
    case "report":
      return fauxAssistantMessage(
        fauxToolCall(SUBMIT_REPORT_TOOL, reportArgsOf(step.claims, step.summary)),
      );
    case "ask":
      return fauxAssistantMessage(fauxToolCall(ASK_HUMAN_TOOL, { question: step.question }));
    case "fail":
      // 真 provider 出错时流**不 reject**：它以一条 `stopReason: "error"` 的消息收尾。
      // 这条消息的形状就是本文件里最值得留着的一行——它就是"流式路径唯一的失败入口"。
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.message });
  }
}

// ---------------------------------------------------------------------------
// 一次 golden 运行
// ---------------------------------------------------------------------------

export interface GoldenRequest {
  /** SDK 的 `Context` 里它是可选的；我们从来不省略，所以它是 `null` 也是一条断言。 */
  readonly systemPrompt: string | null;
  readonly messages: readonly unknown[];
  readonly tools: readonly unknown[];
}

export interface GoldenRun {
  readonly events: readonly AgentEvent[];
  readonly trace: RunTrace;
  /** provider 实际收到的请求，按序。假模型那一侧是空数组（它没有"请求"）。 */
  readonly requests: readonly GoldenRequest[];
}

function taskOf(c: GoldenCase, repoRoot: string): Task {
  return { id: `golden-${c.name}`, goal: c.goal, repoRoot, checks: c.checks };
}

function budgetOf(c: GoldenCase): RunBudget {
  return { ...DEFAULT_BUDGET, ...(c.budget ?? {}) };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<readonly AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function stepAt(c: GoldenCase, index: number): ScriptStep {
  const step = c.steps[index];
  if (step === undefined) {
    throw new Error(
      `语料 ${c.name} 只声明了 ${c.steps.length} 步，而循环问到了第 ${index + 1} 次——` +
        `比脚本多走了一轮。它要么是一次多余的重试，要么是多出来的一轮：两种都必须可见。`,
    );
  }
  return step;
}

/** 两条路共用的脚手架：同一批工具、同一套身份与时钟、同一条内存日志。 */
function scaffold(c: GoldenCase, repoRoot: string) {
  const box: Toolbox = createRepoTools({ repoRoot });
  const controller = new AbortController();
  let calls = 0;

  /**
   * 取消的触发点在执行层里，而执行层是**两条路共用的**——于是"取消发生在
   * 这一次工具调用的中间"这件事在两侧落在同一处，不会变成一次驱动的差别。
   *
   * 它在 `createToolRunner` **之内**（也就是 runner 眼里的内层端口），所以
   * `tool_started` 已经写下、而这次调用还没跑完：正是"意图已下、调用没有回来"
   * 那个形状。此时内层端口自己会发现信号已经响了并如实回报失败，
   * 于是这次调用落成一条 error 观测，而 Run 停在下一个检查点上。
   */
  const cancelling: ToolPort = {
    names: box.port.names,
    async execute(intent: ToolIntent, signal: AbortSignal): Promise<ToolOutcome> {
      calls += 1;
      if (c.cancelAtTool === calls) controller.abort();
      return box.port.execute(intent, signal);
    },
  };

  const runner = createToolRunner({ tools: cancelling, clock: now });
  return { box, runner, log: memoryRunLog(), task: taskOf(c, repoRoot), controller };
}

/** 假模型端口那一路。Core 的循环、执行层、预算、终止——**没有 SDK**。 */
export async function driveCore(c: GoldenCase, repoRoot: string): Promise<GoldenRun> {
  const { runner, log, task, controller } = scaffold(c, repoRoot);
  let call = 0;

  const model = decidingModel(() => {
    const index = call;
    call += 1;
    // 只在那条专门测"取消落在模型请求中间"的用例里才用它；语料不用它。
    if (c.cancelAtCall === index) controller.abort();
    return decisionOf(stepAt(c, index));
  });

  const runtime = createRuntime({
    model,
    ...runner.toolDeps(),
    log,
    ids: sequentialIds("golden"),
    clock: now,
    modelName: GOLDEN_MODEL,
    budget: budgetOf(c),
    sleep: noSleep,
  });

  const events = await collect(runtime.run(task, controller.signal));
  return { events, trace: traceOf(events), requests: [] };
}

/** 真 `pi-ai` 流 + 适配器那一路。provider 是 SDK 自带的 `fauxProvider`：真流、假"模型"。 */
export async function driveSdk(c: GoldenCase, repoRoot: string): Promise<GoldenRun> {
  const { box, runner, log, task, controller } = scaffold(c, repoRoot);

  const handle = fauxProvider({
    provider: "golden",
    api: "golden",
    models: [{ id: GOLDEN_MODEL, name: `golden/${GOLDEN_MODEL}` }],
  });
  const models = createModels();
  models.setProvider(handle.provider);
  const model = handle.getModel(GOLDEN_MODEL);
  if (model === undefined) throw new Error(`faux provider 没有注册出模型 ${GOLDEN_MODEL}`);

  const requests: GoldenRequest[] = [];
  let call = 0;
  /**
   * 每一次请求都把自己重新排进队列。
   *
   * faux 的脚本是**按次取用**的（取完就报"没有更多响应"），而一条 Run 要问几次
   * 取决于预算与重试，事先算不出来。所以工厂在给出这一步的同时把"下一次"再排一条——
   * 于是队列里永远有一条，而"下一步是什么"由 `call` 决定。
   * 这里不读 `handle.state.callCount`：自己数，才不会依赖于 SDK 什么时候加一。
   */
  const respond = (context: PiContext): AssistantMessage => {
    const index = call;
    call += 1;
    requests.push(requestOf(context));
    if (c.cancelAtCall === index) controller.abort();
    handle.appendResponses([respond]);
    return messageOf(stepAt(c, index));
  };
  handle.setResponses([respond]);

  const adapter = piModelAdapter({ models, model, catalog: catalogFromToolbox(box), clock: now });

  const runtime = createRuntime({
    model: adapter,
    ...runner.toolDeps(),
    log,
    ids: sequentialIds("golden"),
    clock: now,
    modelName: GOLDEN_MODEL,
    budget: budgetOf(c),
    sleep: noSleep,
  });

  const events = await collect(runtime.run(task, controller.signal));
  return { events, trace: traceOf(events), requests };
}

/**
 * 请求里**我们决定的那三样**。
 *
 * 不导出 SDK 的 `Context` 本身：那会把 SDK 自己的字段也钉进来，
 * 而一个 SDK 版本升级顺手加一个可选字段不是语义变化——固定件应该对语义敏感，
 * 对无关的变化无所谓。而 `history.ts` 发出去的东西正好就是这三样
 * （`systemPrompt` 是我们写的说明、`messages` 是状态的翻译、`tools` 是工具声明），
 * 于是这个形状本身就是一条断言：**我们只发这三样。**
 */
function requestOf(context: PiContext): GoldenRequest {
  return {
    systemPrompt: context.systemPrompt ?? null,
    messages: context.messages,
    tools: context.tools ?? [],
  };
}

/** 第一次请求（空 transcript）——它钉的是"任务面信息长什么样"。 */
export function firstRequest(run: GoldenRun): GoldenRequest | null {
  return run.requests[0] ?? null;
}

/** 最后一次请求——它带着最多历史，整条 encode 路径都被它过了一遍。 */
export function lastRequest(run: GoldenRun): GoldenRequest | null {
  return run.requests[run.requests.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// 归一化：能进固定件的东西
// ---------------------------------------------------------------------------

/** 深拷贝并把夹具的绝对路径换成 `<repo:…>`。前缀式的，所以漏进来的路径照样显形。 */
export function maskRepo<T>(value: T, repoRoot: string): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return node.split(repoRoot).join(fixtureLabel());
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(node)) out[key] = walk(inner);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/** 固定件的文本形态：两空格缩进、末尾一个换行。它是逐字节比对的目标。 */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 等价性比较用的形态：抹掉"谁有能力知道"的那两处。
 *
 * 抹的对象只有 token 数，理由见文件头。`toolCalls` 与 `durationMs` **不抹**——
 * 它们是 Runtime 自己数的，两条路必须一致，抹掉就等于放弃一条断言。
 */
export function comparable(events: readonly AgentEvent[]): readonly unknown[] {
  return events.map((event) => {
    if (event.type !== "usage_reported") return event;
    return {
      ...event,
      usage: { ...event.usage, inputTokens: "<provider>", outputTokens: "<provider>" },
    };
  });
}

/**
 * 固定件用的形态：把 token 数换成占位符（深度遍历，事件与 trace 通吃）。
 *
 * 固定件原本钉着 provider 报的**真实**数字——这在单一平台上成立，CI 撞破了它：
 * faux 的用量按文本长度算，而请求文本里带着夹具的绝对路径，Windows 的
 * `C:\Users\...` 与 Linux 的 `/tmp/...` 长度不同，于是同一个语义在两个平台上
 * 算出不同的 token 数。结论：token 数混着平台差异，不是纯语义，固定件里
 * 只能钉「报了账」（形状断言在 golden.test.ts 里），钉不了这个数。
 */
export function maskProviderTokens<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(node as Record<string, unknown>)) {
        if ((key === "inputTokens" || key === "outputTokens") && typeof inner === "number") {
          out[key] = "<provider>";
        } else {
          out[key] = walk(inner);
        }
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/** 日志里的工具调用顺序，压成一行行 `工具名(参数)`。给人读，也给"少了哪一步"用。 */
export function digestOf(events: readonly AgentEvent[]): readonly string[] {
  return events.flatMap((event) =>
    event.type === "decision_made" && event.decision.kind === "call_tool"
      ? [`${event.decision.intent.name}(${JSON.stringify(event.decision.intent.args)})`]
      : [],
  );
}

/** 从日志里取出每一个决策。等价性失败时，它是"到底哪一步不一样"的第一现场。 */
export function decisionsOf(events: readonly AgentEvent[]): readonly Decision[] {
  return events.flatMap((event) => (event.type === "decision_made" ? [event.decision] : []));
}
