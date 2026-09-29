/**
 * CLI —— 产品面。只做参数翻译与结果呈现，**零 Agent 逻辑**。
 *
 * 第一版只支持一次性模式（`kuse -p "任务"`）；交互循环与完整旗标在 Phase 12。
 * 事件日志写在 `<data>/sessions/<id>.jsonl`。
 */

import { resolve } from "node:path";
import process from "node:process";

import { traceOf } from "../runtime/trace.js";
import { bootstrapHarness } from "../agent/bootstrap.js";
import { configFromEnv, defaultConfig, mergeConfig } from "../config/schema.js";

const HELP = `kuse —— Minimal Coding Agent Harness

用法
  kuse -p "任务文本" [--model provider/model|mock] [--repo <dir>] [--data <dir>]
  kuse help

说明
  进度走 stderr，最终结论走 stdout。事件日志在 <data>/sessions/<id>.jsonl。
`;

/** 这个 CLI 允许碰的外部世界（测试注入点）。 */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly cwd: string;
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const args = argv.slice(1);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    io.out(HELP);
    return 0;
  }

  // 极简旗标：-p/--print 任务文本；--model；--repo；--data。
  let task: string | null = null;
  let model: string | null = null;
  let repo = io.cwd;
  let data: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token === "-p" || token === "--print") {
      task = args[i + 1] ?? null;
      i += 1;
    } else if (token === "--model") {
      model = args[i + 1] ?? null;
      i += 1;
    } else if (token === "--repo") {
      repo = resolve(io.cwd, args[i + 1] ?? ".");
      i += 1;
    } else if (token === "--data") {
      data = resolve(io.cwd, args[i + 1] ?? ".");
      i += 1;
    } else if (task === null && !token.startsWith("-")) {
      task = token;
    }
  }
  if (task === null || task.trim() === "") {
    io.err("kuse: 没有任务文本。用 -p \"任务\" 传入。");
    return 2;
  }

  const config = mergeConfig([
    model === null ? null : { model },
    configFromEnv(io.env),
    defaultConfig(),
  ]);

  const harness = await bootstrapHarness({
    projectRoot: resolve(repo),
    config,
    ...(data === null ? {} : { dataRoot: data }),
  });
  io.err(`kuse: 会话 ${harness.sessionId}（模型 ${config.model ?? "auto"}）`);
  let answer: string;
  try {
    answer = await harness.run(task);
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
  return main(process.argv, {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
    argv: process.argv,
    cwd: process.cwd(),
  });
}
