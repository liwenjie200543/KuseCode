import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { NodeExecutionEnv } from "../src/agent/env.js";
import { createDefaultTools } from "../src/tools/index.js";
import type { ToolEntry } from "../src/tools/registry.js";

let root = "";
let env: NodeExecutionEnv;
let tools: Map<string, ToolEntry>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kuse-tools-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# demo\n\nTODO: something\n");
  await writeFile(join(root, "src", "app.ts"), "export const a = 1;\nexport const b = 2;\n");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "note.md"), "note\n");
  env = new NodeExecutionEnv(root);
  tools = new Map(createDefaultTools(env).map((entry) => [entry.tool.name, entry]));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(name: string, args: unknown): Promise<string> {
  const entry = tools.get(name);
  if (entry === undefined) throw new Error(`没有工具 ${name}`);
  const result = await entry.tool.execute(`call-${name}`, args as never, undefined, undefined);
  return result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
}

describe("coding tools（Phase 4）", () => {
  it("默认工具集：7 个工具，risk 声明正确", () => {
    expect(tools.size).toBe(7);
    for (const name of ["read", "ls", "grep", "find"]) {
      expect(tools.get(name)?.risk).toBe("safe");
    }
    for (const name of ["write", "edit", "bash"]) {
      expect(tools.get(name)?.risk).toBe("confirm");
    }
  });

  it("read：带行号窗口", async () => {
    const out = await run("read", { path: "src/app.ts" });
    expect(out).toContain("1");
    expect(out).toContain("export const a = 1;");
  });

  it("write：创建父目录并写入", async () => {
    await run("write", { path: "lib/deep/new.ts", content: "export const c = 3;\n" });
    expect(await readFile(join(root, "lib", "deep", "new.ts"), "utf8")).toContain("c = 3");
  });

  it("edit：精确替换并返回 diff（details）；0 命中失败", async () => {
    const entry = tools.get("edit");
    if (entry === undefined) throw new Error("没有 edit");
    const result = await entry.tool.execute("call-edit", {
      path: "src/app.ts",
      edits: [{ oldText: "export const a = 1;", newText: "export const a = 42;" }],
    } as never, undefined, undefined);
    const details = result.details as { diff: string };
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toContain("a = 42");
    expect(details.diff).toContain("-");
    expect(details.diff).toContain("+");

    await expect(
      run("edit", { path: "src/app.ts", edits: [{ oldText: "不存在", newText: "x" }] }),
    ).rejects.toThrow();
  });

  it("bash：执行命令并返回退出码", async () => {
    const out = await run("bash", { command: "echo hello-kuse" });
    expect(out).toContain("hello-kuse");
  }, 30_000);

  it("grep：正则命中带 文件:行号", async () => {
    const out = await run("grep", { pattern: "TODO", include: "*.md" });
    expect(out).toContain("README.md:3");
  });

  it("find：glob 命中排序输出", async () => {
    const out = await run("find", { glob: "*.ts" });
    expect(out).toContain("src/app.ts");
  });

  it("ls：目录内容带类型标记", async () => {
    const out = await run("ls", { path: "src" });
    expect(out).toContain("app.ts");
  });

  it("路径围栏：越出项目根的路径被拒绝", async () => {
    await expect(run("read", { path: "../outside.txt" })).rejects.toThrow(/outside project directory/);
    await expect(run("write", { path: "../evil.txt", content: "x" })).rejects.toThrow();
  });
});
