/**
 * Permission Manager —— Human-in-the-Loop 的统一闸门。
 *
 * 决策顺序（固定，specs/permissions.md）：
 *   destructive 硬拒绝（任何模式都覆盖不了）
 *   → safe / 命令分类 safe → 放行
 *   → 已记住的 "always allow" 模式 → 放行
 *   → mode === "auto"（测试/CI）→ 放行
 *   → 询问回调（TUI 对话框；headless 无回调 → 安全拒绝）
 *
 * 没有 RBAC、没有规则语言。目标是：用尽可能少的代码解决 Human-in-the-Loop。
 */

import { classifyCommand } from "./classifier.js";

type PromptOutcome = "once" | "always" | "deny";

interface PermissionRequest {
  readonly toolName: string;
  /** 一行摘要（shell 命令或目标路径）。 */
  readonly title: string;
  readonly reason: string;
}

export type PromptFn = (request: PermissionRequest) => Promise<PromptOutcome>;

export type Decision =
  | { readonly action: "allow"; readonly reason: string }
  | { readonly action: "deny"; readonly reason: string };

export interface PermissionManagerOptions {
  /** `ask`（默认）：confirm 类走询问回调；`auto`：除硬拒绝外全部放行（测试/CI）。 */
  readonly mode?: "ask" | "auto";
  /** risk 的来源（tools/registry 的声明）。 */
  readonly riskFor: (toolName: string) => "safe" | "confirm" | undefined;
}

interface AllowPattern {
  readonly toolName: string;
  /** 前缀匹配（bash 取命令前两个词，其他工具取工具名本身）。 */
  readonly titlePrefix: string;
}

export class PermissionManager {
  private mode: "ask" | "auto";
  private prompt: PromptFn | null = null;
  private readonly patterns: AllowPattern[] = [];

  constructor(private readonly options: PermissionManagerOptions) {
    this.mode = options.mode ?? "ask";
  }

  setMode(mode: "ask" | "auto"): void {
    this.mode = mode;
  }

  setPrompt(prompt: PromptFn | null): void {
    this.prompt = prompt;
  }

  /** 检查一次工具调用。拒绝时返回带理由的 deny（理由会回给模型）。 */
  async check(toolName: string, args: Record<string, unknown>): Promise<Decision> {
    const risk = this.options.riskFor(toolName);
    if (risk === undefined) {
      return { action: "deny", reason: `没有名为 ${toolName} 的工具` };
    }

    const title = renderTitle(toolName, args);
    if (toolName === "bash") {
      const command = String(args["command"] ?? "");
      const severity = classifyCommand(command);
      if (severity === "destructive") {
        return { action: "deny", reason: `命令被判定为破坏性操作，已拒绝：${command.slice(0, 120)}` };
      }
      if (severity === "safe") {
        return { action: "allow", reason: "只读命令" };
      }
    } else if (risk === "safe") {
      return { action: "allow", reason: "只读工具" };
    }

    // confirm 类：已记住的模式 → auto → 询问 → 安全拒绝
    if (this.matchesRemembered(toolName, title)) {
      return { action: "allow", reason: "allowed by remembered pattern" };
    }
    if (this.mode === "auto") {
      return { action: "allow", reason: "auto-approved" };
    }
    const prompt = this.prompt;
    if (prompt === null) {
      return { action: "deny", reason: `没有可用的询问通道（headless 下 confirm 操作默认拒绝）：${title}` };
    }
    let outcome: PromptOutcome;
    try {
      outcome = await prompt({ toolName, title, reason: `工具 ${toolName} 需要确认` });
    } catch (error) {
      return { action: "deny", reason: `权限询问失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (outcome === "always") {
      this.patterns.push({ toolName, titlePrefix: patternPrefix(toolName, title) });
      return { action: "allow", reason: "allowed always (remembered)" };
    }
    if (outcome === "once") return { action: "allow", reason: "allowed once" };
    return { action: "deny", reason: "denied by user" };
  }

  private matchesRemembered(toolName: string, title: string): boolean {
    return this.patterns.some(
      (pattern) =>
        pattern.toolName === toolName &&
        (title === pattern.titlePrefix || title.startsWith(`${pattern.titlePrefix} `)),
    );
  }
}

function renderTitle(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return String(args["command"] ?? "");
  if (typeof args["path"] === "string") return `${toolName} ${args["path"]}`;
  return toolName;
}

/** bash 记住命令家族（前两个词），其他工具记住工具名。 */
function patternPrefix(toolName: string, title: string): string {
  if (toolName !== "bash") return toolName;
  return title.trim().split(/\s+/).slice(0, 2).join(" ");
}
