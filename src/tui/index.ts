/**
 * TUI —— 全屏组件系统（specs/tui.md），基于 pi-tui：
 *
 *   TuiAltScreen（alt buffer + 差量渲染）
 *   └── VStack
 *       ├── ScrollView(transcript)   跟随末尾：Markdown 消息 + 工具行
 *       ├── statusText               状态行（model · tokens）
 *       ├── Loader                   "thinking…" 动画
 *       └── Editor                   多行输入（Enter 提交，历史导航）
 *
 * 零 Agent 逻辑：它只是 bootstrap Harness 事件流的消费者。
 * 权限询问用 overlay + SelectList（允许一次 / 总是允许 / 拒绝）。
 */

import { join } from "node:path";
import process from "node:process";

import {
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import { bootstrapHarness, type Harness } from "../agent/bootstrap.js";
import { SessionManager } from "../session/manager.js";
import { findUnfinished, listRecoveryInfo } from "../runtime/recovery.js";
import { traceOf } from "../runtime/trace.js";
import type { KuseConfig } from "../config/schema.js";
import { editorTheme, markdownTheme, selectListTheme, statusColors } from "./theme.js";

export interface TuiOptions {
  readonly projectRoot: string;
  readonly config: KuseConfig;
  readonly dataRoot?: string;
}

const HELP = [
  "命令：",
  "  /help      显示这段帮助",
  "  /new       开始新会话",
  "  /sessions  列出会话（含未完成标记）",
  "  /resume    恢复最近一个未完成的会话",
  "  /exit      退出（或空闲时 Ctrl+C）",
].join("\n");

export async function runTui(options: TuiOptions): Promise<void> {
  const dataRoot = options.dataRoot ?? join(options.projectRoot, ".kusecode", "runs");
  const sessionsRoot = join(dataRoot, "sessions");

  // ---------------------------------------------------------------------------
  // 组件组装
  // ---------------------------------------------------------------------------
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);

  const transcript = new VStack();
  const scrollView = new ScrollView(transcript, { follow: "end", primary: false });
  const status = new Text("", 1, 0);
  const loader = new Loader(tui, statusColors.cyan, statusColors.dim, "thinking…");
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });

  const root = new VStack();
  root.addChild(scrollView);
  root.addChild(status);
  root.addChild(editor);
  tui.addChild(root);
  tui.addChild(loader);
  tui.setFocus(editor);

  const requestRender = (): void => tui.requestRender();
  const addLine = (text: string): void => {
    transcript.addChild(new Text(text, 1, 0));
    requestRender();
  };
  const addMarkdown = (text: string): void => {
    transcript.addChild(new Markdown(text, 1, 0, markdownTheme));
    requestRender();
  };

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  let harness: Harness = await bootstrapHarness({ ...options, dataRoot });
  let busy = false;
  let exitRequested = false;
  let liveAssistant: Text | null = null;
  const toolLines = new Map<string, Text>();

  let permissionResolve: ((outcome: "once" | "always" | "deny") => void) | null = null;
  let permissionList: SelectList | null = null;

  const statusSet = (text: string): void => {
    status.setText(text);
    requestRender();
  };

  // ---------------------------------------------------------------------------
  // 权限对话框（overlay + SelectList）
  // ---------------------------------------------------------------------------
  const showPermissionDialog = (request: {
    toolName: string;
    title: string;
    reason: string;
  }): Promise<"once" | "always" | "deny"> => {
    return new Promise((resolve) => {
      const list = new SelectList(
        [
          { value: "once", label: "允许一次" },
          { value: "always", label: `总是允许 ${request.toolName}` },
          { value: "deny", label: "拒绝" },
        ],
        5,
        selectListTheme,
      );
      list.onSelect = (item) => {
        permissionResolve = null;
        permissionList = null;
        tui.hideOverlay();
        resolve(item.value as "once" | "always" | "deny");
      };
      list.onCancel = () => {
        permissionResolve = null;
        permissionList = null;
        tui.hideOverlay();
        resolve("deny");
      };
      permissionList = list;
      permissionResolve = resolve;
      addLine(`需要确认 [${request.toolName}] ${request.title}`);
      tui.showOverlay(list);
    });
  };

  // ---------------------------------------------------------------------------
  // Agent 事件 → 组件更新（纯渲染映射，零业务判断）
  // ---------------------------------------------------------------------------
  const messageText = (message: { role?: string; content?: unknown }): string => {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join("");
    }
    return "";
  };

  const onAgentEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case "message_update": {
        if (event.message.role !== "assistant") return;
        const text = messageText(event.message);
        if (text.length === 0) return;
        if (liveAssistant === null) {
          liveAssistant = new Text("", 1, 0);
          transcript.addChild(liveAssistant);
        }
        liveAssistant.setText(text);
        requestRender();
        return;
      }
      case "message_end": {
        if (event.message.role !== "assistant") return;
        const text = messageText(event.message);
        if (liveAssistant !== null) {
          transcript.removeChild(liveAssistant);
          liveAssistant = null;
        }
        if (text.length > 0) addMarkdown(text);
        return;
      }
      case "tool_execution_start": {
        const line = new Text(
          `${statusColors.cyan("●")} ${event.toolName} ${JSON.stringify(event.args).slice(0, 120)}`,
          1,
          0,
        );
        toolLines.set(event.toolCallId, line);
        transcript.addChild(line);
        requestRender();
        return;
      }
      case "tool_execution_end": {
        const line = toolLines.get(event.toolCallId);
        if (line !== undefined) {
          const failed = event.result?.isError === true;
          line.setText(`${failed ? statusColors.red("✗") : statusColors.green("✓")} ${event.toolName}`);
          toolLines.delete(event.toolCallId);
        }
        requestRender();
        return;
      }
      default:
        return;
    }
  };

  // ---------------------------------------------------------------------------
  // Harness 装配与重新装配（/new、/resume）
  // ---------------------------------------------------------------------------
  const wireHarness = (): void => {
    harness.onEvent(onAgentEvent);
    harness.setPermissionPrompt(async (request) => await showPermissionDialog(request));
  };
  wireHarness();

  const rebuild = async (resume?: { id: string; messages: readonly AgentMessage[] }): Promise<void> => {
    harness = await bootstrapHarness({
      projectRoot: options.projectRoot,
      config: options.config,
      dataRoot,
      ...(resume === undefined ? {} : { resume }),
    });
    wireHarness();
  };

  // ---------------------------------------------------------------------------
  // 提交与斜杠命令
  // ---------------------------------------------------------------------------
  const handleSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (busy) {
      addLine("（上一轮还在进行中……）");
      return;
    }
    if (trimmed.startsWith("/")) {
      await handleSlash(trimmed);
      return;
    }

    addMarkdown(`**❯** ${trimmed}`);
    busy = true;
    loader.start();
    statusSet("● 运行中 · Ctrl+C 中断");
    try {
      await harness.run(trimmed);
      const events = await harness.log.read();
      const usage = traceOf(events).usage;
      statusSet(
        `● ready · tokens ${usage?.inputTokens ?? "?"}in/${usage?.outputTokens ?? "?"}out` +
          (usage?.costUsd !== null && usage?.costUsd !== undefined
            ? ` · $${usage.costUsd.toFixed(4)}`
            : ""),
      );
    } catch (error) {
      statusSet(`✗ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      loader.stop();
      busy = false;
      requestRender();
    }
  };

  const handleSlash = async (text: string): Promise<void> => {
    const [command] = text.split(/\s+/);
    switch (command) {
      case "/help":
        addMarkdown(HELP);
        return;
      case "/new":
        await rebuild();
        addLine("新会话已开始");
        return;
      case "/sessions": {
        const infos = await listRecoveryInfo(sessionsRoot);
        if (infos.length === 0) addLine("（没有会话）");
        for (const info of infos.slice(0, 10)) {
          addLine(
            `${info.id.slice(0, 8)}  ${info.finished ? "已完成" : "未完成"}  ${info.title ?? "(无标题)"}`,
          );
        }
        return;
      }
      case "/resume": {
        const candidate = await findUnfinished(sessionsRoot);
        if (candidate === null) {
          addLine("没有未完成的会话");
          return;
        }
        const messages = await new SessionManager(sessionsRoot).resume(candidate.id);
        await rebuild({ id: candidate.id, messages });
        for (const message of messages) {
          const text = messageText(message as { role?: string; content?: unknown });
          if (text.length > 0) {
            addMarkdown(
              `${(message as { role: string }).role === "user" ? "**❯**" : ""} ${text}`.trim(),
            );
          }
        }
        addLine(`已恢复会话 ${candidate.id.slice(0, 8)}（${candidate.messageCount} 条消息）`);
        return;
      }
      case "/exit":
        exitRequested = true;
        tui.stop();
        process.exit(0);
        return;
      default:
        addLine(`未知命令 ${command}。/help 查看命令。`);
        return;
    }
  };

  editor.onSubmit = (text: string) => {
    void handleSubmit(text);
  };

  // ---------------------------------------------------------------------------
  // 键盘：Ctrl+C（busy → abort；空闲 → 退出）、Esc（abort）、权限对话框按键路由
  // ---------------------------------------------------------------------------
  tui.addInputListener((data: string): { consume?: boolean; data?: string } | undefined => {
    if (data === "\x03") {
      if (busy) {
        harness.abort();
        addLine("已中断本轮");
        requestRender();
        return { consume: true };
      }
      exitRequested = true;
      tui.stop();
      process.exit(0);
    }
    if (data === "\x1b" && busy) {
      harness.abort();
      return { consume: true };
    }
    if (permissionList !== null && permissionResolve !== null) {
      permissionList.handleInput(data);
      requestRender();
      return { consume: true };
    }
    return undefined;
  });

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  statusSet(`● ready · ${options.config.model ?? "auto"} · ${options.projectRoot}`);
  addLine("KuseCode TUI · /help 查看命令 · Ctrl+C 中断/退出");
  tui.start();
  requestRender();

  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (exitRequested) resolve();
      else setTimeout(check, 200);
    };
    check();
  });
}
