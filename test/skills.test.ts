import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { NodeExecutionEnv } from "../src/agent/env.js";
import { createLoadSkillTool, discoverSkills, skillsPromptSection } from "../src/skills/loader.js";

let root = "";
let env: NodeExecutionEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kuse-skills-"));
  env = new NodeExecutionEnv(root);
  await mkdir(join(root, ".kusecode", "skills", "git"), { recursive: true });
  await writeFile(
    join(root, ".kusecode", "skills", "git", "SKILL.md"),
    "---\nname: git\ndescription: 提交代码的规范\n---\n\n先跑测试，再写规范 commit message。\n",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Skills（渐进披露，SDD Phase 7）", () => {
  it("discover：从 .kusecode/skills 加载 name/description/content", async () => {
    const skills = await discoverSkills(env, root);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("git");
    expect(skills[0]?.description).toBe("提交代码的规范");
    expect(skills[0]?.content).toContain("先跑测试");
  });

  it("提示词清单只有 name: description（渐进披露：正文不进提示词）", async () => {
    const skills = await discoverSkills(env, root);
    const section = skillsPromptSection(skills);
    expect(section).toContain("git: 提交代码的规范");
    expect(section).not.toContain("先跑测试");
    expect(skillsPromptSection([])).toBe("");
  });

  it("load_skill：按名加载全文；未知名字返回可读提示", async () => {
    const skills = await discoverSkills(env, root);
    const tool = createLoadSkillTool(skills);

    const hit = await tool.execute("t1", { name: "git" } as never, undefined, undefined);
    expect(hit.content.map((part) => ("text" in part ? part.text : "")).join("")).toContain("先跑测试");

    const miss = await tool.execute("t2", { name: "nope" } as never, undefined, undefined);
    expect(miss.content.map((part) => ("text" in part ? part.text : "")).join("")).toContain("没有名为 nope");
  });
});
