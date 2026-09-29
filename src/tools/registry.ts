/**
 * Tool Registry —— 统一的工具面：内建（SDK read/write/edit/bash 经 env 适配）+
 * 自研（grep/find/ls）+ 后续的 skills/MCP/sub-agent 工具，全部从这一个 Map 进出。
 * 重名注册即抛错；每个工具带 `risk`，permissions/ 消费它。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";

export type ToolRisk = "safe" | "confirm";

export interface ToolEntry {
  readonly tool: AgentTool;
  readonly risk: ToolRisk;
}

export class ToolRegistry {
  private readonly entries = new Map<string, ToolEntry>();

  register(entry: ToolEntry): void {
    if (this.entries.has(entry.tool.name)) {
      throw new Error(`工具重复注册：${entry.tool.name}`);
    }
    this.entries.set(entry.tool.name, entry);
  }

  get(name: string): ToolEntry | undefined {
    return this.entries.get(name);
  }

  /** Agent 需要的裸工具列表（注册序，稳定）。 */
  list(): AgentTool[] {
    return [...this.entries.values()].map((entry) => entry.tool);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  /** MCP/子代理批量合并用：重名 → `<namespace>_<name>`。 */
  registerMany(entries: readonly ToolEntry[], namespace?: string): void {
    for (const entry of entries) {
      const name = namespace === undefined ? entry.tool.name : `${namespace}_${entry.tool.name}`;
      this.register(namespace === undefined ? entry : { ...entry, tool: { ...entry.tool, name } });
    }
  }
}
