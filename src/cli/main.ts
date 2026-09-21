/**
 * CLI —— 产品面。回答的唯一问题是：**一个人怎么发起一次 Run，又怎么看懂它。**
 *
 * ## 它为什么是一个函数，而不是一个脚本
 *
 * `main(argv, io)` 的输入是「参数 + 一个 IO 对象」，输出是一个退出码。所有
 * 与进程有关的东西（`process.argv`、`process.stdout`、`process.env`、`process.cwd()`、
 * SIGINT）都只在文件末尾那个 `runCli()` 里出现一次。
 *
 * 这不是为了好看：本项目的第一个不变量是「Core 能在没有进程、网络、数据库的情况下
 * 跑完」，而一个 CLI 恰好是最容易把这句话作废的地方——它在 `main` 的第一行读
 * `process.cwd()`，之后所有东西就都绑死在进程上了。把 IO 注入进来，`test/cli.test.ts`
 * 就能在一个进程里跑完整的 `kuse run`，断言退出码、stdout 的形状、以及凭据有没有
 * 流进日志。**产品面同样可以是可测的。**
 *
 * ## 它自己不做任何判断
 *
 * 这里没有一条"什么算成功"的规则：退出码由 `trace.stop` 决定（那是事件日志的事实），
 * 结论由 Runtime 的终态事件给出，核对由 `auditRun` 给出。CLI 只做三件事：
 * 把参数翻译成对象、把零件接起来、把结果印出来。它是**接线的集合，不是逻辑的集合**。
 *
 * ## SDK 是动态加载的
 *
 * `kuse trace` / `kuse runs` / `kuse sessions` / `kuse help` 一行 SDK 代码都不加载：
 * 想重看一次 Run 的人不该为了这个等 SDK 的 provider 目录建起来（实测约 1 秒）。
 * 这是"SDK 只在适配器后面"这条边界在**加载时间**上的体现，而不只是目录结构上的。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";

import { redactor, secretsFromEnv } from "../core/redact.js";
import type { ModelPort, Task } from "../core/types.js";
import { createRuntime } from "../runtime/run-agent.js";
import { createToolRunner } from "../runtime/tool-runner.js";
import { traceOf } from "../runtime/trace.js";
import type { RunTrace } from "../runtime/trace.js";
import { auditRun } from "../runtime/verify.js";
import { createSessionStore } from "../store/session-store.js";
import type { SessionStore } from "../store/session-store.js";
import { createRepoTools, materialReader } from "../tools/repo-tools.js";
import type { Toolbox } from "../tools/repo-tools.js";
import { EXIT, HELP, flagOn, flagValue, flagsMissingValue, parseArgs, unknownFlags } from "./args.js";
import type { ParsedArgs } from "./args.js";
import { REDACTION_NOTICE, exitLine, progressLine, traceLines } from "./render.js";

/** 适配器的形状（动态 import 的结果）。SDK 的类型只在这里出现一次。 */
type AdapterModule = typeof import("../adapter/pi/index.js");

// ---------------------------------------------------------------------------
// 与进程的边界
// ---------------------------------------------------------------------------

/** 这个 CLI 允许自己碰的全部外部世界。 */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** 外部取消（Ctrl-C）。省略时是一次永不中止的 Run。 */
  readonly signal?: AbortSignal;
  /** stdin 的内容（没给任务文本时用它）。默认空。 */
  readonly stdin?: () => Promise<string>;
}

interface RunOptions {
  readonly repo: string;
  readonly store: string;
  readonly model: string | null;
  readonly session: string | null;
  readonly pattern: string;
  readonly json: boolean;
  readonly quiet: boolean;
}

const RUN_FLAGS = ["repo", "store", "model", "session", "pattern", "json", "quiet", "offline", "help", "h"];
const READ_FLAGS = ["store", "json", "help", "h"];

/**
 * 哪些选项要吃掉后面那个词。
 *
 * 这份名单是**解析期的词性**，不是某个子命令的校验规则：`--store` 对三个子命令
 * 都要取值，而 `--json` 对谁都是开关。没有第二个名字既是开关又取值的选项，
 * 所以三个子命令可以共用一份——见 `args.ts` 的 `ParseOptions`。
 */
const VALUED_FLAGS = ["repo", "store", "model", "session", "pattern"];

/** 用法错误：打一条消息 + 一行提示，然后以退出码 2 结束。 */
function usage(io: CliIo, message: string): number {
  io.err(`kuse: ${message}`);
  io.err("跑 `kuse help` 看用法。");
  return EXIT.usage;
}

function rejectUnknown(args: ParsedArgs, io: CliIo, allowed: readonly string[]): boolean {
  const unknown = unknownFlags(args, allowed);
  if (unknown.length === 0) return false;
  io.err(`kuse: 不认识的选项：${unknown.map((name) => `--${name}`).join(", ")}`);
  io.err("跑 `kuse help` 看用法。");
  return true;
}

/**
 * 只读子命令共用的入场检查：不认识的选项 → 报错。
 *
 * 这三个子命令**一行校验都不能少**：`kuse runs <会话> --repo .` 里的 `--repo`
 * 是 `run` 才认识的选项，它在只读路径上被安静地丢掉，用户会以为"它按这个仓库
 * 过滤了"。与 `parseRun` 用的是同一份 `unknownFlags`，所以两边不可能分叉。
 */
function rejectReadFlags(args: ParsedArgs, io: CliIo): boolean {
  return rejectUnknown(args, io, READ_FLAGS);
}

/** 要取值的选项被写成了裸开关。 */
function rejectMissingValue(args: ParsedArgs, io: CliIo): boolean {
  const missing = flagsMissingValue(args, VALUED_FLAGS);
  if (missing.length === 0) return false;
  io.err(`kuse: 选项缺一个值：${missing.map((name) => `--${name}`).join(", ")}`);
  io.err("跑 `kuse help` 看用法。");
  return true;
}

function parseRun(args: ParsedArgs, io: CliIo): RunOptions | null {
  if (rejectUnknown(args, io, RUN_FLAGS)) return null;
  if (rejectMissingValue(args, io)) return null;
  const offline = flagOn(args, "offline");
  return {
    repo: resolve(io.cwd, flagValue(args, "repo") ?? "."),
    store: resolve(io.cwd, flagValue(args, "store") ?? "runs"),
    // `--offline` 是 `--model faux` 的拼写变体：两种写法都要能读，但只有一个含义。
    model: offline
      ? "faux"
      : (flagValue(args, "model") ?? io.env["KUSECODE_MODEL"]?.trim() ?? null),
    session: flagValue(args, "session"),
    pattern: flagValue(args, "pattern") ?? "TODO",
    json: flagOn(args, "json"),
    quiet: flagOn(args, "quiet"),
  };
}

/**
 * 存储目录落在被分析仓库里面时的**仓库相对路径**；不在里面就是 `null`。
 *
 * 这件事必须算出来，因为默认配置就会撞上：`--repo` 默认当前目录、`--store` 默认
 * `./runs`，于是存储就在仓库里。而事件日志里写着任务文本，所以一次
 * `search_text` 会命中**这次 Run 自己的日志**——Run 把自己的输出当成了输入。
 * 实测撞到过一次，那时报告的第一条证据是它自己的 `events.jsonl`。
 *
 * 交给工具集的是**路径**而不是目录名（`runs`）：用名字去跳过会让一个真正叫
 * `runs` 的素材目录被静默漏掉，而"静默漏掉材料"看起来就像那个仓库里没有那些文件。
 */
function storeInsideRepo(repo: string, store: string): string | null {
  const path = relative(repo, store);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) return null;
  return path.split(sep).join("/");
}

/**
 * 任务的文本：位置参数、或 stdin。
 *
 * 两处都空就报错——一次没有任务的 Run 没有意义，而"用一个默认问题跑一次"
 * 会安静地产生一堆没人要的证据。
 */
async function readTask(args: ParsedArgs, io: CliIo): Promise<string> {
  const inline = args.positionals.join(" ").trim();
  if (inline.length > 0) return inline;
  return io.stdin === undefined ? "" : (await io.stdin()).trim();
}

// ---------------------------------------------------------------------------
// 模型：两条路径，接线完全一样
// ---------------------------------------------------------------------------

interface BuiltModel {
  readonly model: ModelPort;
  readonly modelName: string;
  /** 离线冒烟模式。它会被明确地印出来，因为它不产生"模型的结论"。 */
  readonly offline: boolean;
}

/**
 * `--model faux` 之外的写法交给真实 provider 目录去解析。
 *
 * 顺序是刻意的：离线模式不联网、不要凭据、瞬时完成；真实路径要建 SDK 的 provider
 * 目录（实测约 1 秒）并且可能因为没配凭据而失败，所以只在真要发请求时才走它。
 */
async function buildModel(
  spec: string,
  pattern: string,
  toolbox: Toolbox,
  adapter: AdapterModule,
): Promise<{ readonly ok: true; readonly built: BuiltModel } | { readonly ok: false; readonly message: string }> {
  const catalog = adapter.catalogFromToolbox(toolbox);

  if (spec === "faux") {
    const offline = adapter.offlineProvider({ pattern });
    return {
      ok: true,
      built: {
        model: adapter.piModelAdapter({ models: offline.models, model: offline.model, catalog }),
        modelName: `faux/${offline.model.id}`,
        offline: true,
      },
    };
  }

  const resolution = await adapter.resolveProviderModel(spec);
  if (!resolution.ok) return { ok: false, message: resolution.reason };
  const { models, model, provider, modelId } = resolution.resolved;
  return {
    ok: true,
    built: {
      model: adapter.piModelAdapter({ models, model, catalog }),
      modelName: `${provider}/${modelId}`,
      offline: false,
    },
  };
}

// ---------------------------------------------------------------------------
// 「为什么停」→ 退出码。唯一的映射点。
// ---------------------------------------------------------------------------

/**
 * `unfinished` 落到 `internal`：一次 `run()` 返回之后日志里必须有个结尾，
 * 没有就说明我们没把这次 Run 走完——那是我们自己的问题，不是用户的 Run 失败。
 */
function exitCodeFor(trace: RunTrace): number {
  switch (trace.stop.kind) {
    case "completed":
      return trace.stop.status === "complete" ? EXIT.complete : EXIT.partial;
    case "failed":
      return EXIT.failed;
    case "cancelled":
      return EXIT.cancelled;
    case "awaiting_human":
      return EXIT.awaitingHuman;
    case "unfinished":
      return EXIT.internal;
    default: {
      const unhandled: never = trace.stop;
      throw new Error(`没有为这种收场定义退出码：${JSON.stringify(unhandled)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// kuse run
// ---------------------------------------------------------------------------

async function commandRun(args: ParsedArgs, io: CliIo): Promise<number> {
  const options = parseRun(args, io);
  if (options === null) return EXIT.usage;

  const task = await readTask(args, io);
  if (task.length === 0) {
    return usage(io, "没有任务文本。写在命令后面，或者用管道喂给 stdin。");
  }
  if (options.model === null) {
    return usage(
      io,
      "没有模型。用 --model faux 跑离线冒烟，或者设 KUSECODE_MODEL=provider/model。" +
        "（凭据从环境解析，绝不写进这个仓库。）",
    );
  }

  // 存储目录若落在仓库里面，它就不算材料——见 `storeInsideRepo`。
  const ownArtifacts = storeInsideRepo(options.repo, options.store);
  const toolbox = createRepoTools({
    repoRoot: options.repo,
    ignore: ownArtifacts === null ? [] : [ownArtifacts],
  });
  const store = createSessionStore({ rootDir: options.store });

  // 会话：**给出来的**那一个先查（只读、便宜，不需要模型）；没给的话，新建它的时机
  // 在后面——模型解析失败的 Run 不该在存储里留下一个空的会话。
  if (options.session !== null && (await store.getSession(options.session)) === null) {
    return usage(io, `会话 ${options.session} 不存在（在 ${options.store} 里找不到）。`);
  }

  // SDK 在**校验全部通过之后**才被拉进来。
  //
  // 它是这个 CLI 里唯一的重活——建 provider 目录实测约 1 秒——而一次用法错误
  // （选项拼错、没给任务、会话不存在）根本用不到模型。把导入放在这里而不是
  // `dispatch` 的 `case "run"` 里，是不让"打错一个字"变成"等一秒钟"。
  const adapter: AdapterModule = await import("../adapter/pi/index.js");
  const built = await buildModel(options.model, options.pattern, toolbox, adapter);
  if (!built.ok) return usage(io, built.message);

  const sessionId = options.session ?? (await store.createSession()).id;

  // 任务的身份由它所属的会话决定：一次 CLI 调用一个会话，所以这个 id 稳定可读。
  const taskObject: Task = {
    id: `task_${sessionId}`,
    goal: task,
    repoRoot: options.repo,
    checks: [],
  };

  const started = await store.startRun(sessionId, taskObject);
  const runner = createToolRunner({ tools: toolbox.port, clock: () => Date.now() });
  const runtime = createRuntime({
    ...runner.toolDeps(),
    log: started.log,
    ids: started.ids,
    model: built.built.model,
    modelName: built.built.modelName,
  });

  if (!options.quiet) {
    if (built.built.offline) {
      io.err(
        "kuse: 离线冒烟模式（--model faux）。结论由固定流程从真实材料里抄出来，" +
          "不是模型推理的结果；这里验证的是链路，不是答案。",
      );
    }
    io.err(`kuse: 仓库 ${options.repo}`);
    io.err(`kuse: 会话 ${sessionId}，Run ${started.runId}，日志 ${options.store}/${started.runId}/events.jsonl`);
  }

  for await (const event of runtime.run(taskObject, io.signal)) {
    if (options.quiet || options.json) continue;
    const line = progressLine(event);
    if (line !== null) io.err(line);
  }

  // trace 从**日志**读，不从事件流里攒：事件流是"已送出的前缀"，日志才是全部真相。
  // 消费者提前离场时流会短一截，而"花了多少"不该因此变成另一个数。
  const events = started.log.read(started.runId);
  const trace = traceOf(events);
  const audit = auditRun(events, materialReader(toolbox));
  const code = exitCodeFor(trace);

  if (options.json) {
    io.out(
      JSON.stringify(
        {
          sessionId,
          storeDir: options.store,
          eventsPath: `${options.store}/${started.runId}/events.jsonl`,
          offline: built.built.offline,
          trace,
          audit,
        },
        null,
        2,
      ),
    );
  } else {
    const body = traceLines(trace, audit, [
      `仓库   ${options.repo}`,
      `会话   ${sessionId}`,
      `Run    ${started.runId}`,
      `模型   ${built.built.modelName}${built.built.offline ? "（离线冒烟）" : ""}`,
      `日志   ${options.store}/${started.runId}/events.jsonl`,
    ]).join("\n");
    io.out(body);
  }
  io.err(exitLine(code));

  return code;
}

// ---------------------------------------------------------------------------
// kuse trace / runs / sessions
// ---------------------------------------------------------------------------

/**
 * 这三个子命令是**只读**的：不重跑、不调模型、不写任何文件。
 *
 * 一旦有了一次 Run 的完整证据，"再看一遍"就不该再花一分钱，也不该有机会改变
 * 任何东西。它们全部建立在同一件事上——日志是唯一真相。
 */
function readStore(args: ParsedArgs, io: CliIo): { readonly store: SessionStore; readonly dir: string } {
  const dir = resolve(io.cwd, flagValue(args, "store") ?? "runs");
  return { store: createSessionStore({ rootDir: dir }), dir };
}

async function commandTrace(args: ParsedArgs, io: CliIo): Promise<number> {
  if (rejectReadFlags(args, io)) return EXIT.usage;
  if (rejectMissingValue(args, io)) return EXIT.usage;

  const [sessionId, runId] = args.positionals;
  if (sessionId === undefined || runId === undefined) {
    return usage(io, "用法：kuse trace <sessionId> <runId>");
  }

  const { store, dir } = readStore(args, io);
  const recovered = await store.recover(sessionId, runId);
  if (recovered === null) {
    return usage(io, `在 ${dir} 里找不到会话 ${sessionId} 的 Run ${runId}。`);
  }

  const trace = traceOf(recovered.events);
  if (flagOn(args, "json")) {
    io.out(
      JSON.stringify(
        {
          trace,
          audit: null,
          // 不猜：只读模式没有仓库上下文，所以核对**没做过**。
          // 印一个空表会让人以为"核对通过了"。
          auditSkipped: "只读模式没有仓库上下文，未做证据核对；想核对请重跑 kuse run",
        },
        null,
        2,
      ),
    );
  } else {
    io.out(
      traceLines(trace, null, [
        `会话   ${sessionId}`,
        `Run    ${runId}`,
        `存储   ${dir}`,
        `状态   ${recovered.status}（由日志派生）`,
      ]).join("\n"),
    );
  }
  const code = exitCodeFor(trace);
  io.err(exitLine(code));
  return code;
}

async function commandRuns(args: ParsedArgs, io: CliIo): Promise<number> {
  if (rejectReadFlags(args, io)) return EXIT.usage;
  if (rejectMissingValue(args, io)) return EXIT.usage;

  const [sessionId] = args.positionals;
  if (sessionId === undefined) return usage(io, "用法：kuse runs <sessionId>");

  const { store } = readStore(args, io);
  const session = await store.getSession(sessionId);
  if (session === null) return usage(io, `找不到会话 ${sessionId}。`);

  if (flagOn(args, "json")) {
    io.out(JSON.stringify({ session }, null, 2));
    return EXIT.complete;
  }
  io.out(`会话 ${sessionId}：${session.runs.length} 个 Run`);
  for (const run of session.runs) {
    io.out(`  ${run.runId}  ${run.status.padEnd(14)} ${run.task.goal}`);
  }
  return EXIT.complete;
}

async function commandSessions(args: ParsedArgs, io: CliIo): Promise<number> {
  if (rejectReadFlags(args, io)) return EXIT.usage;
  if (rejectMissingValue(args, io)) return EXIT.usage;

  const { store } = readStore(args, io);
  const ids = await store.listSessions();
  if (flagOn(args, "json")) {
    io.out(JSON.stringify({ sessions: ids }, null, 2));
    return EXIT.complete;
  }
  io.out(`会话 ${ids.length} 个`);
  for (const id of ids) {
    const session = await store.getSession(id);
    io.out(`  ${id}  ${session?.runs.length ?? 0} 个 Run`);
  }
  return EXIT.complete;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 跑一次命令行。
 *
 * 它做两件事，然后原样转交：
 *
 * 1. **每一行输出都过一遍脱敏。** 这是"终端与 CI 日志是另一个泄漏面"的落点：
 *    被分析的仓库里如果恰好有一个 key，我们不该把它抄进构建日志。在这里做
 *    （而不是在每个打印点）有一个好处：**没有一处输出能忘掉它**。
 * 2. 抹过东西就提醒一次。提醒本身也走 `io`，所以它不会绕开同一个通道。
 *
 * 注意脱敏的**方向**：它只动给人看的输出，不动事件日志（`src/core/redact.ts`
 * 的表里写清了为什么——日志是证据，改写证据会让"这条论断指向这一行"失效）。
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const redact = redactor(secretsFromEnv(io.env));
  let redactedSomething = false;

  const safe: CliIo = {
    ...io,
    out: (text: string): void => {
      const clean = redact(text);
      if (clean !== text) redactedSomething = true;
      io.out(clean);
    },
    err: (text: string): void => {
      const clean = redact(text);
      if (clean !== text) redactedSomething = true;
      io.err(clean);
    },
  };

  try {
    return await dispatch(argv, safe);
  } finally {
    if (redactedSomething) io.err(REDACTION_NOTICE);
  }
}

async function dispatch(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv, { valued: VALUED_FLAGS });
  const command = args.command ?? "help";

  if (flagOn(args, "help") || flagOn(args, "h") || command === "help") {
    io.out(HELP);
    return EXIT.complete;
  }

  try {
    switch (command) {
      case "run":
        // `commandRun` 内部在**校验全部通过之后**才去拉 SDK（见那里的注释）：
        // 一次用法错误不该为建 provider 目录那一秒付钱。
        return await commandRun(args, io);
      case "trace":
        return await commandTrace(args, io);
      case "runs":
        return await commandRuns(args, io);
      case "sessions":
        return await commandSessions(args, io);
      default:
        return usage(io, `不认识的子命令 ${JSON.stringify(command)}。`);
    }
  } catch (error) {
    // 落到这里的是"连发生了什么都答不出来"的情况（日志坏了、回放拒绝、
    // 路径不可用）。它们不是 Run 的结局，所以用 internal 而不是 failed：
    // 脚本必须能区分"这次 Run 失败了"与"我没能读到这次 Run"。
    io.err(`kuse: 内部错误：${error instanceof Error ? error.message : String(error)}`);
    return EXIT.internal;
  }
}

/**
 * 真入口：第一个也是唯一一个碰 `process` 的地方。
 *
 * SIGINT/SIGTERM 接成一次**外部取消**，于是 Ctrl-C 走的正是步 5 那条路：
 * 守卫在动作之前拦下、日志里落一条 `run_cancelled`、退出码是 12。
 * 一次被取消的 Run 必须留下证据，而不是只留下一个消失的进程。
 */
export async function runCli(): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    return await main(process.argv.slice(2), {
      out: (text: string) => process.stdout.write(`${text}\n`),
      err: (text: string) => process.stderr.write(`${text}\n`),
      env: process.env,
      cwd: process.cwd(),
      signal: controller.signal,
      // 管道用：没有位置参数时读 stdin。只在不是 TTY 时堵着读，否则交互式调用会挂住。
      stdin: async (): Promise<string> => {
        if (process.stdin.isTTY === true) return "";
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf8");
      },
    });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
