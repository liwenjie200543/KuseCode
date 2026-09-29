/**
 * TUI —— 交互式会话（specs/tui.md）。
 *
 * v1 基于 node 内置 readline（成熟、零依赖、无主题 API 负担）：
 * 工具活动与流式状态实时打印，assistant 全文在回合结束时输出；
 * 权限询问复用同一 readline（once/always/deny）；/new /resume /sessions /exit。
 * 零 Agent 逻辑——它只是 bootstrap Harness 事件流的消费者。
 */

import readline from "node:readline";
import { join } from "node:path";

import { bootstrapHarness, type Harness } from "../agent/bootstrap.js";
import { SessionManager } from "../session/manager.js";
import { traceOf } from "../runtime/trace.js";
import { findUnfinished, listRecoveryInfo } from "../runtime/recovery.js";
import { join as pathJoin } from "node:path";
import type { KuseConfig } from "../config/schema.js";

export interface TuiOptions {
  readonly projectRoot: string;
  readonly config: KuseConfig;
  readonly dataRoot?: string;
  /** 测试注入。缺省 process.stdin/stdout。 */
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

const HELP = [
  "命令：",
  "  /help      显示这段帮助",
  "  /new       开始新会话",
  "  /sessions  列出会话（含未完成标记）",
  "  /resume    恢复最近一个未完成的会话",
  "  /exit      退出",
].join("\n");

export async function runTui(options: TuiOptions): Promise<void> {
  const dataRoot = options.dataRoot ?? join(options.projectRoot, ".kusecode", "runs");
  const output = options.output ?? process.stdout;
  const write = (text: string): void => {
    output.write(`${text}
`);
  };

  let harness: Harness = await bootstrapHarness({ ...options, dataRoot });
  let session = new SessionManager(join(dataRoot, "sessions"));
  let sessionId = harness.sessionId;
  write(`KuseCode TUI · 会话 ${sessionId.slice(0, 8)} · /help 查看命令`);

  const pendingPermission = { resolve: null as ((outcome: "once" | "always" | "deny") => void) | null };
  harness.setPermissionPrompt(async (request) => {
    write(`\n需要确认 [${request.toolName}] ${request.title}`);
    return await new Promise<"once" | "always" | "deny">((resolve) => {
      pendingPermission.resolve = (outcome) => {
        write(outcome === "deny" ? "已拒绝" : `已${outcome === "once" ? "允许一次" : "总是允许"}`);
        resolve(outcome);
      };
      write("a = 允许一次 · A = 总是允许 · d = 拒绝");
    });
  });

  const rl = readline.createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    prompt: "❯ ",
    terminal: options.output === undefined ? true : undefined,
  });


  const startNewSession = async (): Promise<void> => {
    harness = await bootstrapHarness({ ...options, dataRoot });
    session = new SessionManager(join(dataRoot, "sessions"));
    sessionId = harness.sessionId;
    write(`新会话 ${sessionId.slice(0, 8)}`);
  };

  const handleLine = async (line: string): Promise<void> => {
    const text = line.trim();
    if (pendingPermission.resolve !== null) {
      const outcome = text === "a" ? "once" : text === "A" ? "always" : text === "d" ? "deny" : null;
      if (outcome !== null) pendingPermission.resolve(outcome);
      else write("a / A / d 之一");
      return;
    }
    if (text === "") return;
    if (text.startsWith("/")) {
      const [command] = text.split(/\s+/);
      switch (command) {
        case "/help":
          write(HELP);
          return;
        case "/new":
          await startNewSession();
          return;
        case "/sessions": {
          const infos = await listRecoveryInfo(pathJoin(dataRoot, "sessions"));
          for (const info of infos.slice(0, 10)) {
            write(
              `${info.id.slice(0, 8)}  ${info.finished ? "已完成" : "未完成"}  ${info.title ?? "(无标题)"}`,
            );
          }
          return;
        }
        case "/resume": {
          const candidate = await findUnfinished(pathJoin(dataRoot, "sessions"));
          if (candidate === null) {
            write("没有未完成的会话");
            return;
          }
          harness = await bootstrapHarness({ ...options, dataRoot });
          session = new SessionManager(join(dataRoot, "sessions"));
          await session.resume(candidate.id);
          sessionId = candidate.id;
          write(`已恢复会话 ${candidate.id.slice(0, 8)}（${candidate.messageCount} 条消息）`);
          return;
        }
        case "/exit":
          rl.close();
          process.exit(0);
          return;
        default:
          write(`未知命令 ${command}。/help 查看命令。`);
          return;
      }
    }

    // 一次性事件观察者：本轮的工具活动实时可见
    const answer = await harness.run(text);
    const events = await harness.log.read();
    const trace = traceOf(events);
    if (trace.usage !== null) {
      write(
        answer +
          `\n— tokens ${trace.usage.inputTokens ?? "?"}in/${trace.usage.outputTokens ?? "?"}out` +
          (trace.usage.costUsd !== null ? ` · $${trace.usage.costUsd.toFixed(4)}` : ""),
      );
    } else {
      write(answer);
    }
  };

  const queue: string[] = [];
  let processing = false;
  const drain = (): void => {
    if (processing) return;
    const next = queue.shift();
    if (next === undefined) {
      rl.prompt();
      return;
    }
    processing = true;
    void handleLine(next)
      .catch((error) => write(`错误：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        processing = false;
        drain();
      });
  };
  rl.on("line", (line) => {
    queue.push(line);
    drain();
  });
  rl.on("close", () => {
    write("再见");
  });
  rl.prompt();

}
