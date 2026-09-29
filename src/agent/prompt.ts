/** 系统提示词：harness 的自我说明 + 项目记忆（`AGENTS.md`/`CLAUDE.md` 兼容）。 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platform, arch, version } from "node:os";

export function buildSystemPrompt(projectRoot: string, toolNames: readonly string[]): string {
  const memory = readProjectMemory(projectRoot);
  return [
    `你在 KuseCode——一个运行在 ${platform()} ${arch()} · node ${version()} 的编码 Agent 里工作。`,
    `项目根目录：${projectRoot}`,
    toolNames.length > 0 ? `可用工具：${toolNames.join(", ")}。` : "当前没有可用工具。",
    "修改文件前先读它；bash 命令在项目根目录执行。",
    "结论要基于工具的真实输出，不要臆造文件内容。",
    memory === null ? "" : `\n# 项目记忆\n\n${memory}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 项目记忆：AGENTS.md 是标准，CLAUDE.md 是兼容项。 */
function readProjectMemory(projectRoot: string): string | null {
  const parts: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = readFileSync(join(projectRoot, name), "utf8").trim();
      if (text.length > 0) parts.push(text);
    } catch {
      // 文件不存在：跳过
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
