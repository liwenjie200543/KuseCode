/**
 * CLI —— 产品面。只做参数翻译与结果呈现，**零 Agent 逻辑**。
 *
 * 三种模式：
 *   kuse                     交互 TUI（src/tui）
 *   kuse -p "任务"           一次性执行（headless：confirm 默认拒绝）
 *   kuse continue -p "任务"  恢复同 cwd 最近未完成的会话再执行
 *   kuse sessions            列出会话与状态
 * 事件日志在 `<data>/sessions/<id>.jsonl`。
 */

import { join, resolve } from "node:path";
import process from "node:process";

import { traceOf } from "../runtime/trace.js";
import { listRecoveryInfo } from "../runtime/recovery.js";
import { bootstrapHarness } from "../agent/bootstrap.js";
import { runTui } from "../tui/index.js";
import { configFromEnv, defaultConfig, mergeConfig } from "../config/schema.js";

const HELP = `kuse —— Minimal Coding Agent Harness

用法
  kuse                       交互模式（会话、流式输出）
  kuse -p "任务文本"         一次性执行后退出
  kuse continue -p "任务"    恢复同目录最近未完成的会话再执行
  kuse sessions              列出会话与状态
  kuse help                  显示本帮助

选项
  --model <provider/model|mock>   模型（也可用环境变量 KUSECODE_MODEL）
  --repo <dir>                    项目根目录（默认当前目录）
  --data <dir>                    会话与日志根目录（默认 <repo>/.kusecode/runs）
  --permission-mode <ask|auto>    confirm 操作的处置（headless 建议显式 auto）
  -h, --help                      帮助

说明
  一次性模式是 headless：confirm 类操作（write/edit/bash）默认拒绝，
  除非 --permission-mode auto。事件日志在 <data>/sessions/<id>.jsonl。
`;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly cwd: string;
}

interface CliArgs {
  interactive: boolean;
  print: string | null;
  continueLast: boolean;
  sessionsOnly: boolean;
  model: string | null;
  repo: string;
  data: string | null;
  permissionMode: "ask" | "auto" | null;
  help: boolean;
}

function parseArgs(argv: readonly string[], env: CliIo["env"]): CliArgs {
  const args: CliArgs = {
    interactive: false,
    print: null,
    continueLast: false,
    sessionsOnly: false,
    model: null,
    repo: "",
    data: null,
    permissionMode: null,
    help: false,
  };
  const tokens = argv;
  const next = (index: number): string | null => tokens[index + 1] ?? null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    switch (token) {
      case "-p":
      case "--print":
        args.print = next(index);
        index += 1;
        break;
      case "--model":
        args.model = next(index);
        index += 1;
        break;
      case "--repo":
        args.repo = next(index) ?? "";
        index += 1;
        break;
      case "--data":
        args.data = next(index);
        index += 1;
        break;
      case "--permission-mode":
        args.permissionMode = next(index) === "auto" ? "auto" : "ask";
        index += 1;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "continue":
        args.continueLast = true;
        break;
      case "sessions":
        args.sessionsOnly = true;
        break;
      default:
        if (!token.startsWith("-") && args.print === null) args.print = token;
        break;
    }
  }
  if (args.model === null) {
    const envModel = env["KUSECODE_MODEL"]?.trim();
    if (envModel !== undefined && envModel !== "") args.model = envModel;
  }
  if (args.continueLast && args.print === null && !args.sessionsOnly && !args.help) {
    args.interactive = true;
  }
  return args;
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv, io.env);
  if (args.help) {
    io.out(HELP);
    return 0;
  }

  const repo = resolve(io.cwd, args.repo || ".");
  const config = mergeConfig([
    args.model === null ? null : { model: args.model },
    configFromEnv(io.env),
    defaultConfig(),
  ]);
  const configWithMode = {
    ...config,
    ...(args.permissionMode === null ? {} : { permissionMode: args.permissionMode }),
  };
  const data = args.data === null ? null : resolve(io.cwd, args.data);
  const sessionsRoot = data ?? join(repo, ".kusecode", "runs");

  if (args.sessionsOnly) {
    const infos = await listRecoveryInfo(join(sessionsRoot, "sessions"));
    io.out(`${infos.length} 个会话`);
    for (const info of infos) {
      io.out(
        `  ${info.id.slice(0, 8)}  ${info.finished ? "已完成" : "未完成"}  ${info.cwd ?? "?"}  ${info.title ?? "(无标题)"}`,
      );
    }
    return 0;
  }

  if (args.print === null || args.interactive) {
    await runTui({ projectRoot: repo, config: configWithMode, ...(data === null ? {} : { dataRoot: data }) });
    return 0;
  }

  // 一次性模式（headless：confirm 默认拒绝，除非 --permission-mode auto）
  const harness = await bootstrapHarness({
    projectRoot: repo,
    config: configWithMode,
    ...(data === null ? {} : { dataRoot: data }),
  });
  io.err(`kuse: 会话 ${harness.sessionId.slice(0, 8)}`);

  let answer: string;
  try {
    answer = await harness.run(args.print);
  } catch (error) {
    io.err(`kuse: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  io.out(answer);

  const events = await harness.log.read();
  const trace = traceOf(events);
  for (const step of trace.steps) {
    io.err(`kuse: ● ${step.tool} ${JSON.stringify(step.args).slice(0, 120)}`);
  }
  for (const message of trace.errors) io.err(`kuse: ✗ ${message}`);
  if (trace.usage !== null) {
    io.err(
      `kuse: tokens ${trace.usage.inputTokens ?? "?"}in/${trace.usage.outputTokens ?? "?"}out` +
        (trace.usage.costUsd !== null ? ` · $${trace.usage.costUsd.toFixed(4)}` : ""),
    );
  }
  return 0;
}

/** 进程入口：唯一的 process 触点。 */
export async function runCli(): Promise<number> {
  return main(process.argv.slice(2), {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
    argv: process.argv,
    cwd: process.cwd(),
  });
}
