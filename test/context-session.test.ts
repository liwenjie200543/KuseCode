import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { ContextManager } from "../src/context/manager.js";
import { SessionManager } from "../src/session/manager.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kuse-ctx-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}
function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

describe("ContextManager（截断）", () => {
  it("超长文本结果头尾保留 + 截断标记；未超长返回 undefined", async () => {
    const manager = new ContextManager({ maxToolResultChars: 100, summarize: async () => "" });
    const result = {
      content: [{ type: "text" as const, text: "x".repeat(300) }],
      details: { size: 300 },
      isError: false,
    };
    const processed = manager.handleAfterToolCall!({
      toolCall: { type: "toolCall", id: "t1", name: "read" },
      args: { path: "a.ts" },
      result,
      isError: false,
    } as unknown as Parameters<typeof manager.handleAfterToolCall>[0]);

    expect(processed).toBeDefined();
    expect(processed?.content?.[0]).toHaveProperty("text");
    const text = (processed?.content?.[0] as { text: string }).text;
    expect(text).toContain("截断");
    expect(text.length).toBeLessThan(300);
    expect(processed?.details).toEqual({ size: 300 });

    const small = manager.handleAfterToolCall({
      toolCall: { type: "toolCall", id: "t2", name: "read" },
      args: { path: "a.ts" },
      result: { content: [{ type: "text" as const, text: "短" }], details: undefined, isError: false },
    } as unknown as Parameters<typeof manager.handleAfterToolCall>[0]);
    expect(small).toBeUndefined();
  });
});

describe("ContextManager（压缩）", () => {
  function buildMessages(turns: number): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let index = 0; index < turns; index += 1) {
      messages.push(userMessage(`任务第 ${index} 轮：请阅读文件 file-${index}.ts`));
      messages.push(assistantMessage("已读 file-" + index + ".ts，内容：" + "x".repeat(200)));
    }
    return messages;
  }

  it("超预算：旧回合替换为摘要，最近 2 个 user 轮逐字保留", async () => {
    const manager = new ContextManager({
      compactAboveTokens: 300,
      keepRecentMessages: 2,
      summarize: async (transcript) => "摘要：" + transcript.slice(0, 60),
    });
    const messages = buildMessages(10);
    const compacted = await manager.compact(messages);

    // 摘要在开头，包 <conversation-summary> 标记
    const first = compacted[0] as { content: string };
    expect(first.content).toContain("<conversation-summary>");
    expect(first.content).toContain("摘要：");
    // 保留的最近消息原样在尾
    expect(compacted.at(-1)).toEqual(messages.at(-1));
    // 压缩后体积显著缩小
    expect(manager.estimate(compacted)).toBeLessThan(manager.estimate(messages));
  });

  it("切点落在 user 消息边界：assistant 与它的工具结果不被拆开", async () => {
    const manager = new ContextManager({
      compactAboveTokens: 10,
      keepRecentMessages: 2,
      summarize: async () => "s",
    });
    const messages = buildMessages(5);
    const compacted = await manager.compact(messages);
    // 压缩后的第一条保留消息必须是 user（切点边界）
    const kept = compacted.slice(1) as { role: string }[];
    expect(kept[0]?.role).toBe("user");
  });

  it("预算内不压缩（原样返回）", async () => {
    const manager = new ContextManager({
      compactAboveTokens: 100_000,
      keepRecentMessages: 2,
      summarize: async () => "s",
    });
    const messages = buildMessages(3);
    expect(await manager.compact(messages)).toEqual(messages);
  });
});

describe("SessionManager（JSONL 持久化）", () => {
  it("create → record → resume：消息原样读回", async () => {
    const sessions = new SessionManager(dir);
    const id = await sessions.start(join(dir, "project"), "mock");
    await sessions.record(userMessage("第一问"));
    await sessions.record(assistantMessage("第一答"));

    const fresh = new SessionManager(dir);
    const messages = await fresh.resume(id);
    expect(messages).toHaveLength(2);
    expect((messages[0] as { content: string }).content).toBe("第一问");
    expect(JSON.stringify((messages[1] as { content: unknown }).content)).toContain("第一答");
  });

  it("resume 后继续追加到同一文件（append-only，不截断历史）", async () => {
    const sessions = new SessionManager(dir);
    const id = await sessions.start(join(dir, "project"), "mock");
    await sessions.record(userMessage("第一问"));

    const fresh = new SessionManager(dir);
    await fresh.resume(id);
    await fresh.record(userMessage("第二问"));

    const raw = await readFile(join(dir, `${id}.jsonl`), "utf8");
    expect(raw).toContain("第一问");
    expect(raw).toContain("第二问");
  });

  it("continue：同 cwd 的最近会话；其他 cwd 不匹配", async () => {
    const sessions = new SessionManager(dir);
    const id = await sessions.start(join(dir, "project-a"), "mock");
    await sessions.record(userMessage("项目 A 的问题"));

    const fresh = new SessionManager(dir);
    expect(await fresh.continueId(join(dir, "project-a"))).toBe(id);
    expect(await fresh.continueId(join(dir, "project-b"))).toBeNull();
  });

  it("torn write：写一半的残骸被跳过，历史不丢", async () => {
    const sessions = new SessionManager(dir);
    const id = await sessions.start(join(dir, "project"), "mock");
    await sessions.record(userMessage("完整的一问"));

    // 模拟写一半崩溃
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, `${id}.jsonl`), '{"type":"message","message":{"role":"use');

    const fresh = new SessionManager(dir);
    const messages = await fresh.resume(id);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { content: string }).content).toBe("完整的一问");
  });
});
