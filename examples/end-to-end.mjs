/**
 * KuseCode 端到端演示 —— 一次 Run 的完整证据链。
 *
 * 跑法（`dist` 是构建产物，已在 .gitignore 里，所以先构建）：
 *
 *   node node_modules/typescript/bin/tsc -p tsconfig.build.json
 *   node examples/end-to-end.mjs
 *
 * 它展示的是「一个 Task 进来、一串事件出去」这条链路的全部零件：
 *
 *   Task → Runtime（预算/取消/重试/记账）→ Core 循环 → 工具执行层（八道关）
 *        → 真文件系统 → 事件日志落盘 → 回放复算
 *
 * 三幕各换掉一个零件，用来证明其余零件没有被它绑住：
 *
 *   第 1 幕  假模型 + 真工具 + 真磁盘 —— 循环与执行层
 *   第 2 幕  换成**真适配器**（pi-ai 的真事件流）—— 第 1 幕的 Runtime 与工具一行不改
 *   第 3 幕  越界路径 / 文件不存在 / 取消 —— 失败被隔离、缺什么被点名、停在有名字的地方
 *
 * 这里的模型是脚本化的（faux provider），所以离线、确定、不需要凭据；
 * 但跑的是**生产代码路径**，不是替身。真机凭据路径见 docs/08-pi-adapter.md 的「未验证」一节。
 */

import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import process from "node:process";

import {
  createRepoTools,
  createRuntime,
  createSessionStore,
  createToolRunner,
  observationsOf,
  replayAgentState,
  runStatusOf,
  sequentialIds,
} from "../dist/index.js";
import { catalogFromToolbox, piModelAdapter } from "../dist/adapter/pi/index.js";
import { decidingModel } from "../dist/testing/fake-model.js";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const WIDTH = 78;

function rule(title) {
  const bar = "─".repeat(Math.max(0, WIDTH - title.length - 3));
  console.log(`\n── ${title} ${bar}`);
}

function say(...parts) {
  console.log(parts.join(" "));
}

function clip(text, max = 96) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 观测值的摘要：不打印整份材料，只说「拿到了什么形状的东西」。 */
function digest(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.length} 项]`;
  const keys = Object.keys(value);
  const bits = [];
  if (Array.isArray(value.matches)) bits.push(`matches×${value.matches.length}`);
  if (Array.isArray(value.lines)) bits.push(`lines[${value.startLine}..${value.endLine}]`);
  if (Array.isArray(value.entries)) bits.push(`entries×${value.entries.length}`);
  if (value.path !== undefined) bits.push(`path=${value.path}`);
  if (bits.length === 0) bits.push(keys.slice(0, 5).join(","));
  else bits.push(`${keys.length} 个字段`);
  return `{ ${bits.join("  ")} }`;
}

/** 一条事件 → 一行。事件是产品契约，所以这里不打内部对象。 */
function line(event) {
  const at = `#${String(event.sequence).padStart(2)}`;
  switch (event.type) {
    case "run_started":
      return `${at}  run_started`;
    case "model_requested":
      return `${at}  model_requested        model=${event.model ?? "null"}`;
    case "decision_made": {
      const d = event.decision;
      if (d.kind === "call_tool") return `${at}  decision_made          call_tool  ${d.intent.name} ${clip(JSON.stringify(d.intent.args), 60)}`;
      if (d.kind === "respond") return `${at}  decision_made          respond    「${clip(d.report.summary, 48)}」`;
      return `${at}  decision_made          ask_human  「${clip(d.question, 48)}」`;
    }
    case "tool_started":
      return `${at}  tool_started           ${event.toolName}  (${event.toolCallId})`;
    case "tool_completed": {
      const verdict = event.status === "success" ? "success" : `error/${event.error?.code}`;
      const note = event.status === "success" ? digest(event.result) : clip(event.error?.message ?? "", 44);
      return `${at}  tool_completed         ${event.toolName}  ${verdict}  ${event.durationMs}ms  ${note}`;
    }
    case "observation_added":
      return `${at}  observation_added      ${event.name} → ${event.observation.error === null ? digest(event.observation.value) : `error/${event.observation.error.code}`}${event.observation.truncated ? "  (truncated)" : ""}`;
    case "usage_reported": {
      const u = event.usage;
      return `${at}  usage_reported         in=${u.inputTokens ?? "null"} out=${u.outputTokens ?? "null"} tools=${u.toolCalls} ${u.durationMs}ms model=${u.model ?? "null"}`;
    }
    case "human_input_requested":
      return `${at}  human_input_requested  「${clip(event.question, 50)}」`;
    case "run_completed":
      return `${at}  run_completed          status=${event.status}  missingMaterial=${event.missingMaterial.length}`;
    case "run_failed":
      return `${at}  run_failed             ${event.error.code}: ${clip(event.error.message, 48)}`;
    case "run_cancelled":
      return `${at}  run_cancelled`;
    default:
      return `${at}  ${event.type}`;
  }
}

// ---------------------------------------------------------------------------
// 夹具：一个真仓库（真磁盘、真文件）
// ---------------------------------------------------------------------------

const FIXTURE = {
  "README.md": [
    "# 演示仓库",
    "",
    "给 KuseCode 的端到端演示用的最小仓库。",
    "",
    "## 待办",
    "",
    "- [x] 建骨架",
    "- [ ] TODO 适配器还没有真机验证",
    "",
  ].join("\n"),
  "src/parser.ts": [
    "// 一个极小的配置解析器。",
    "",
    "export function parseLine(line: string): [string, string] | null {",
    "  // TODO: 支持引号里的等号（`a=\"b=c\"`）",
    "  const index = line.indexOf(\"=\");",
    "  if (index < 0) return null;",
    "  return [line.slice(0, index), line.slice(index + 1)];",
    "}",
    "",
  ].join("\n"),
  "src/util.ts": ["// TODO 这个文件迟早要删，先把占位留着", "export const noop = (): void => {};", ""].join("\n"),
  // 下面两个是**噪声**：搜索必须跳过它们，否则模型会去读 node_modules
  ".git/config": "# TODO 这行在 .git 里，不该被搜到\n",
  "node_modules/demo/index.js": "// TODO 这行在 node_modules 里，不该被搜到\n",
};

async function makeFixture(root) {
  for (const [path, content] of Object.entries(FIXTURE)) {
    const full = join(root, ...path.split("/"));
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

// ---------------------------------------------------------------------------
// 一次 Run 的公共装配
//
// 注意装配里**没有**任何一处提到模型是什么：`model` 是参数。第 1 幕与第 2 幕
// 唯一的差别就是传进来的那个对象，下面这些代码一行不改。
// ---------------------------------------------------------------------------

/**
 * 时钟是注入的——整条链路只有这一个时间来源。
 * 生产里是 `Date.now`；测试与 golden 换成确定性时钟，于是输出可以逐字节比对。
 */
const now = () => Date.now();

async function runOnce({ store, sessionId, model, toolbox, modelName, task, signal }) {
  const started = await store.startRun(sessionId, task);
  const runner = createToolRunner({ tools: toolbox.port, clock: now });

  const runtime = createRuntime({
    model,
    // 执行层的三个出口**一起**摊进来：少一个都编译不过（步 6 的形状约定）
    ...runner.toolDeps(),
    log: started.log,
    ids: started.ids,
    clock: now,
    modelName,
  });

  const events = [];
  for await (const event of runtime.run(task, signal)) {
    events.push(event);
    say("   " + line(event));
  }
  return { runId: started.runId, events };
}

/** 磁盘上这次 Run 的日志。 */
async function logFileOf(runsRoot, runId) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && child.includes(runId) && child.endsWith(".jsonl")) found.push(child);
    }
  };
  await walk(runsRoot);
  return found[0] ?? null;
}

// ---------------------------------------------------------------------------
// 报告打印
// ---------------------------------------------------------------------------

/** 证据上的时间戳：打印成人看得懂的时刻，而不是一串 epoch。 */
function at(epochMs) {
  return new Date(epochMs).toISOString().slice(11, 23);
}

function printReport(report) {
  say(`   摘要: ${report.summary}`);
  report.claims.forEach((claim, index) => {
    say(`   ${index + 1}. ${claim.text}`);
    for (const evidence of claim.evidence) {
      const where = evidence.lines === null ? evidence.path : `${evidence.path}:${evidence.lines[0]}-${evidence.lines[1]}`;
      say(`        证据 ${where}  ← ${evidence.provenance.source} @ ${at(evidence.provenance.at)}`);
      if (evidence.excerpt.length > 0) say(`        | ${clip(evidence.excerpt, 62)}`);
    }
    if (claim.evidence.length === 0) say("        （这条论断没有依据——它被显式写出来，而不是被省略）");
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const work = await mkdtemp(join(tmpdir(), "kuse-demo-"));
const repoRoot = await makeFixture(join(work, "fixture"));
const runsRoot = join(work, "runs");
await mkdir(runsRoot, { recursive: true });

const TASK = {
  id: "task-todo-audit",
  goal: "找出演示仓库里所有的 TODO 标记，说明它们分别在哪一行、是关于什么的",
  repoRoot,
  checks: ["每个 TODO 都要有文件与行号", "说明它指向什么"],
};

const clock = now;
const store = createSessionStore({ rootDir: runsRoot, ids: sequentialIds("demo"), clock });
const session = await store.createSession();
const toolbox = createRepoTools({ repoRoot });

rule("场景");
say(`任务   ${TASK.goal}`);
say(`仓库   ${relative(work, repoRoot)}  （真磁盘：${Object.keys(FIXTURE).length} 个文件，含 2 个噪声文件）`);
say(`日志   ${relative(work, runsRoot)}/`);
say(`工具   ${toolbox.names.join(" / ")}  —— 纯 JSON Schema，零 SDK import`);

// ---------------------------------------------------------------------------
// 第 1 幕：假模型 + 真工具 + 真磁盘
// ---------------------------------------------------------------------------

rule("第 1 幕   假模型驱动，真工具真磁盘");

/**
 * 脚本化的"模型"：它**看得见状态**，所以第二个决策依赖第一个观测。
 * 这比按顺序背台词强：观测没回填进状态，第二个决策就变了，演示立刻现形。
 */
const earningModel = decidingModel(
  (state) => {
    const obs = observationsOf(state);
    if (obs.length === 0) return { kind: "call_tool", intent: { name: "search_text", args: { pattern: "TODO", maxMatches: 20 } } };

    if (obs.length === 1) {
      const first = obs[0].value.matches[0];
      // 从**观测里抄**路径与行号，而不是自己编一个
      return {
        kind: "call_tool",
        intent: { name: "read_file", args: { path: first.path, startLine: Math.max(1, first.line - 1), endLine: first.line + 1 } },
      };
    }

    const matches = obs[0].value.matches;
    const read = obs[1].value;
    const excerpt = read.lines.map((l) => l.text).join("\n");
    return {
      kind: "respond",
      report: {
        summary: `仓库里有 ${matches.length} 处 TODO，分布在 ${new Set(matches.map((m) => m.path)).size} 个文件里。`,
        claims: matches.map((match, index) => ({
          text: `${match.path}:${match.line} —— ${match.text}`,
          evidence:
            index === 0
              ? [{ path: read.path, lines: [read.startLine, read.endLine], excerpt, provenance: obs[1].provenance }]
              : [],
        })),
      },
    };
  },
  // 用量：每一轮报多少账。不报就是 `null`（"不知道"），绝不能写成 0
  { usage: (round) => ({ inputTokens: 820 + round * 265, outputTokens: 96 + round * 41 }) },
);

const act1 = await runOnce({
  store,
  sessionId: session.id,
  model: earningModel,
  toolbox,
  modelName: "scripted",
  task: TASK,
});

say("\n   —— 交付的结论 ——");
const terminal1 = act1.events.at(-1);
if (terminal1.type === "run_completed") printReport(terminal1.result);

rule("磁盘上的日志");

const logPath = await logFileOf(runsRoot, act1.runId);
const raw = await readFile(logPath, "utf8");
const onDisk = raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
say(`   ${relative(work, logPath)}`);
say(`   ${onDisk.length} 行 / ${Buffer.byteLength(raw, "utf8")} 字节（一行一条事件，只追加）`);
say("\n   前 3 行原样：");
for (const l of raw.split("\n").slice(0, 3)) say(`   ${clip(l, 150)}`);

rule("回放：从磁盘重建状态");

const sameAsLive = JSON.stringify(onDisk) === JSON.stringify(act1.events);
const rebuilt = replayAgentState(onDisk, TASK);
say(`   实时收到的事件 === 磁盘上的事件 ?   ${sameAsLive}`);
say(`   回放出的状态: transcript ${rebuilt.transcript.length} 条  iteration ${rebuilt.iteration}  pendingQuestion ${rebuilt.pendingQuestion}`);
say(`   回放出的终态: ${runStatusOf(onDisk)}`);
say(`   状态是从事件折叠出来的（与实时执行共用同一个 reduce），不是另存一份快照`);

// ---------------------------------------------------------------------------
// 第 2 幕：换成真适配器
// ---------------------------------------------------------------------------

rule("第 2 幕   换成真 Pi 适配器（pi-ai 的真事件流）");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

const seenContexts = [];
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("search_text", { pattern: "TODO", maxMatches: 20 })),
  // 这一轮的收场由**工厂**给出：它拿到 provider 真的收到的 Context，
  // 于是"我们到底发了什么"是可以被截下来看的，而不是靠我们自称
  (context) => {
    seenContexts.push(context);
    return fauxAssistantMessage(fauxToolCall("read_file", { path: "src/parser.ts", startLine: 3, endLine: 5 }));
  },
  fauxAssistantMessage(
    fauxToolCall("submit_report", {
      summary: "parser.ts 里有一处 TODO：解析器还不支持引号里的等号。",
      claims: [
        {
          text: "src/parser.ts:4 —— 解析器用 indexOf('=') 找分隔符，引号里的等号会切错",
          evidence: [{ path: "src/parser.ts", lines: [3, 5], excerpt: "// TODO: 支持引号里的等号（`a=\"b=c\"`）" }],
        },
        {
          // 模型说了但没给依据：Core 用空数组表示它，不会被悄悄省略
          text: "其他文件的 TODO 我这一轮没读完",
        },
      ],
    }),
  ),
]);

const realAdapter = piModelAdapter({
  models,
  model: faux.models[0],
  catalog: catalogFromToolbox(toolbox),
  clock,
});

// 主循环与第 1 幕**完全一样**，只有传进来的 model 变了
const act2 = await runOnce({
  store,
  sessionId: session.id,
  model: realAdapter,
  toolbox,
  modelName: "faux",
  task: TASK,
});

say("\n   —— 交付的结论 ——");
const terminal2 = act2.events.at(-1);
if (terminal2.type === "run_completed") printReport(terminal2.result);

const ctx = seenContexts[0];
say("\n   —— provider 真的收到了什么（第 2 轮）——");
say(`   systemPrompt          ${clip(ctx.systemPrompt ?? "(无)", 70)}`);
say(`   messages              ${ctx.messages.length} 条，角色：${ctx.messages.map((m) => m.role).join(" → ")}`);
say(`   tools                 ${ctx.tools.length} 个：${ctx.tools.map((t) => t.name).join(" / ")}`);
say(`   最后一条（上一轮的工具结果，被翻译进对话）`);
say(`   ${clip(JSON.stringify(ctx.messages.at(-1)), 150)}`);

rule("两幕对照");
const vocabulary = (events) => [...new Set(events.map((e) => e.type))];
const v1 = vocabulary(act1.events);
const v2 = vocabulary(act2.events);
say(`   第 1 幕事件词汇  ${v1.join(" ")}`);
say(`   第 2 幕事件词汇  ${v2.join(" ")}`);
say(`   词汇表相同 ?     ${JSON.stringify(v1) === JSON.stringify(v2)}`);
say(`   Runtime / 工具执行层 / 存储：两幕是同一份代码，只有传进去的 model 不同。`);
say(`   协议工具（submit_report / ask_human）不在 ToolPort 名单里（${toolbox.names.join("/")}）——`);
say(`   它们是适配器的词汇，由适配器消费，从不产生观测。`);

// ---------------------------------------------------------------------------
// 第 3 幕：故障与停止
// ---------------------------------------------------------------------------

rule("第 3 幕   故障与停止");

const hostileModel = decidingModel((state) => {
  const obs = observationsOf(state);
  if (obs.length === 0) {
    // 想读仓库外面的文件：执行层的路径围栏必须拦住它
    return { kind: "call_tool", intent: { name: "read_file", args: { path: "../../../../etc/passwd" } } };
  }
  if (obs.length === 1) {
    return { kind: "call_tool", intent: { name: "read_file", args: { path: "src/does-not-exist.ts" } } };
  }
  return {
    kind: "respond",
    report: {
      summary: "两个文件都没读到，所以这一轮没有可用材料。",
      claims: [{ text: "仓库里没有 TODO", evidence: [] }],
    },
  };
});

const act3 = await runOnce({
  store,
  sessionId: session.id,
  model: hostileModel,
  toolbox,
  modelName: "scripted",
  task: TASK,
});

const terminal3 = act3.events.at(-1);
if (terminal3.type === "run_completed") {
  say(`\n   status = ${terminal3.status}   ← 材料没拿到，终态就不许说 complete`);
  say(`   missingMaterial:`);
  for (const item of terminal3.missingMaterial) say(`     · ${item}`);
}
say(`   两次失败都被隔离成一条观测，Run 继续走完——工具坏掉不等于 Run 坏掉。`);

// (b) 外部取消：第 2 个决策之后拉闸
rule("外部取消");

const controller = new AbortController();
let asked = 0;
const cancelModel = decidingModel((state) => {
  if (observationsOf(state).length >= 1 && asked === 0) {
    asked += 1;
    controller.abort();
  }
  return { kind: "call_tool", intent: { name: "list_dir", args: { path: "." } } };
});

const act4 = await runOnce({
  store,
  sessionId: session.id,
  model: cancelModel,
  toolbox,
  modelName: "scripted",
  task: TASK,
  signal: controller.signal,
});
say(`   最后一条事件：${act4.events.at(-1).type}   ← 每条路径都停在一个有名字的地方`);
say(`   拉闸发生在第 2 个决策之后、工具真正执行之前：守卫在**动作之前**检查，`);
say(`   所以那个 list_dir 一次都没跑（日志里没有它的 tool_started）。`);
say(`   而收尾那一行是 Runtime 在 finally 里补的——消费者离场，日志也不会缺一个结尾。`);

// (c) 挂起：需要人，而人还没回答——挂起 ≠ 结束
rule("挂起：需要人");

const suspendingModel = decidingModel((state) => {
  if (observationsOf(state).length === 0) {
    return { kind: "call_tool", intent: { name: "search_text", args: { pattern: "TODO" } } };
  }
  return {
    kind: "ask_human",
    question: "README 里的「TODO 适配器还没有真机验证」是要我现在补验证，还是先记进待办？",
  };
});

const act5 = await runOnce({
  store,
  sessionId: session.id,
  model: suspendingModel,
  toolbox,
  modelName: "scripted",
  task: TASK,
});
say(`   最后一条事件：${act5.events.at(-1).type}   ← 没有终态事件。挂起不是结束，所以它不该有。`);

rule("崩溃恢复：谁还没走完");

const unfinished = await store.unfinished(session.id);
say(`   store.unfinished(sessionId) → ${unfinished.length} 条`);
for (const runId of unfinished) {
  const recovered = await store.recover(session.id, runId);
  say(`     · ${runId}   停在 ${recovered.status}   transcript ${recovered.state.transcript.length} 条   iteration ${recovered.state.iteration}`);
}
say(`   上一幕那条**被取消**的 Run 不在名单里：取消是终态，它已经走完了。`);
say(`   挂起（awaiting_human）与「登记了但一条事件都还没写」（queued）才是要接着处理的。`);
say(`   recover() 的状态是从磁盘日志折叠出来的——进程重启后接着跑的唯一依据，`);
say(`   而它不是另存的一份快照，所以不会与日志分叉。`);

rule("结束");
say(`临时目录（想亲自看就打开它）：${work}`);
say(`这个演示没有联网、没有凭据，全部跑在 SDK 自带的 faux provider 上。`);

