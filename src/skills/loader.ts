/**
 * Skills —— 文件系统 + Markdown 的渐进披露（specs/skills.md）。
 *
 * 位置：`<projectRoot>/.kusecode/skills/<name>/SKILL.md`（发现与加载直接用
 * pi-agent-core 的 loadSkills，吃我们已有的 NodeExecutionEnv——零自研解析）。
 * 渐进披露：系统提示词只进 `name: description` 清单；模型判断需要时调
 * `load_skill(name)`，正文作为工具结果进入上下文——只为用到的技能花 token。
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { formatSkillInvocation, loadSkills, type Skill } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { AgentTool, AgentToolResult, ExecutionEnv } from "@earendil-works/pi-agent-core";

/** 发现：项目级 + 用户级两个目录。目录不存在由 loadSkills 跳过。 */
export async function discoverSkills(env: ExecutionEnv, projectRoot: string): Promise<Skill[]> {
  const dirs = [join(projectRoot, ".kusecode", "skills"), join(homedir(), ".kusecode", "skills")];
  const { skills } = await loadSkills(env, dirs);
  return skills;
}

/** 系统提示词的技能清单段：只有 name 与 description。 */
export function skillsPromptSection(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  return [
    "可用技能（用 load_skill 工具加载全文）：",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");
}

/** `load_skill` 工具：按名加载，返回技能全文。 */
export function createLoadSkillTool(skills: readonly Skill[]): AgentTool {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const names = skills.map((skill) => skill.name).join(", ");
  return {
    name: "load_skill",
    label: "LoadSkill",
    description: `按名称加载技能全文。可用：${names || "（无）"}`,
    parameters: Type.Object({
      name: Type.String({ description: "技能名" }),
    }),
    execute: async (_id, raw): Promise<AgentToolResult<undefined>> => {
      const args = raw as { name: string };
      const skill = byName.get(args.name);
      if (skill === undefined) {
        return {
          content: [{ type: "text", text: `没有名为 ${args.name} 的技能。可用：${names || "（无）"}` }],
          details: undefined,
        };
      }
      return { content: [{ type: "text", text: formatSkillInvocation(skill) }], details: undefined };
    },
  };
}
