import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpManager } from "../src/mcp/index.js";
import { ToolRegistry } from "../src/tools/registry.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo-server.mjs");

describe("McpManager（薄适配，SDD Phase 8）", () => {
  it("连接真 stdio server：工具适配进 registry、可调用、状态可见", { timeout: 30_000 }, async () => {
    const manager = new McpManager({ echo: { command: "node", args: [SERVER] } });
    await manager.startAll();
    expect(manager.statusesSnapshot()[0]?.ok).toBe(true);

    const registry = new ToolRegistry();
    await manager.registerTools((entry, namespace) => registry.registerMany([entry], namespace));
    expect(registry.names()).toContain("echo");

    const entry = registry.get("echo");
    expect(entry?.risk).toBe("confirm");
    const result = await entry?.tool.execute("t1", { text: "hi" } as never, undefined, undefined);
    expect(result?.content.map((part) => ("text" in part ? part.text : "")).join("")).toContain("echoed:hi");

    await manager.shutdown();
  });

  it("单点故障不致命：坏 server 记录状态，好 server 照常工作", { timeout: 30_000 }, async () => {
    const manager = new McpManager({
      broken: { command: "node", args: ["./no-such-server.mjs"], timeoutSeconds: 2 },
      echo: { command: "node", args: [SERVER] },
    });
    await manager.startAll();

    const statuses = manager.statusesSnapshot();
    if (statuses.find((status) => status.name === "echo")?.ok !== true) {
      console.error("echo status:", JSON.stringify(statuses));
    }
    expect(statuses.find((status) => status.name === "broken")?.ok).toBe(false);
    expect(statuses.find((status) => status.name === "echo")?.ok).toBe(true);

    const registry = new ToolRegistry();
    await manager.registerTools((entry, namespace) => registry.registerMany([entry], namespace));
    expect(registry.names()).toContain("echo");
    await manager.shutdown();
  });

  it("MCP 工具重名 → <server>_<tool>（registerMany 的命名空间）", () => {
    const registry = new ToolRegistry();
    const fake = { tool: { name: "echo", label: "Echo", description: "", parameters: {} as never, execute: async () => ({ content: [], details: undefined }) }, risk: "safe" as const };
    registry.register(fake);
    registry.registerMany([fake], "other");
    expect(registry.names()).toContain("echo");
    expect(registry.names()).toContain("other_echo");
  });
});
