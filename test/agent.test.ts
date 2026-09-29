import { describe, expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";

import { createKuseAgent } from "../src/agent/agent.js";
import { createModelRegistry } from "../src/model/registry.js";

// ---------------------------------------------------------------------------
// Agent Core（SDD Phase 3）：循环来自 pi-agent-core，这里只验我们的钩子与事件流。
// ---------------------------------------------------------------------------

const echoSchema = Type.Object({ text: Type.String() });

describe("createKuseAgent", () => {
  it("文本路径：prompt → 事件流到 agent_end 收尾，最终文本可得", async () => {
    const registry = createModelRegistry();
    const mock = registry.enableMock();
    mock.setResponses([fauxAssistantMessage("你好，世界")]);

    const agent = createKuseAgent({
      models: registry.models,
      model: mock.getModel(),
      systemPrompt: "测试",
      tools: [],
    });

    const types: string[] = [];
    const consume = (async () => {
      for await (const event of agent.events) types.push(event.type);
    })();
    await agent.prompt("打个招呼");
    await consume;

    expect(types[0]).toBe("agent_start");
    expect(types.at(-1)).toBe("agent_end");
    const last = agent.messages().at(-1) as { role: string; content: unknown };
    expect(last?.role).toBe("assistant");
    expect(JSON.stringify(last?.content)).toContain("你好，世界");
  });

  it("工具路径：beforeToolCall 钩子被调用；工具结果进 transcript；循环继续到终态", async () => {
    const registry = createModelRegistry();
    const mock = registry.enableMock();
    let calls = 0;
    mock.setResponses([
      () => {
        calls += 1;
        return calls === 1
          ? fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })])
          : fauxAssistantMessage("完成");
      },
    ]);

    const seen: string[] = [];
    const agent = createKuseAgent({
      models: registry.models,
      model: mock.getModel(),
      systemPrompt: "测试",
      tools: [
        {
          name: "echo",
          label: "Echo",
          description: "回显",
          parameters: echoSchema,
          execute: async (_id, raw) => {
            const params = raw as { text: string };
            return {
              content: [{ type: "text" as const, text: `echoed:${params.text}` }],
              details: undefined,
            };
          },
        },
      ],
      hooks: {
        beforeToolCall: async (name) => {
          seen.push(name);
          return null;
        },
      },
    });

    await agent.prompt("运行");

    expect(seen).toEqual(["echo"]);
    const roles = agent.messages().map((m) => (m as { role: string }).role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("权限拒绝：beforeToolCall 返回理由 → 工具不执行，模型看到拒绝", async () => {
    const registry = createModelRegistry();
    const mock = registry.enableMock();
    let executed = 0;
    let calls = 0;
    mock.setResponses([
      () => {
        calls += 1;
        return calls === 1
          ? fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })])
          : fauxAssistantMessage("知道了");
      },
    ]);

    const agent = createKuseAgent({
      models: registry.models,
      model: mock.getModel(),
      systemPrompt: "测试",
      tools: [
        {
          name: "echo",
          label: "Echo",
          description: "回显",
          parameters: echoSchema,
          execute: async () => {
            executed += 1;
            return { content: [{ type: "text" as const, text: "不应到达" }], details: undefined };
          },
        },
      ],
      hooks: {
        beforeToolCall: async () => "权限拒绝：演示用",
      },
    });

    await agent.prompt("试一下");

    expect(executed).toBe(0);
    const toolResult = agent.messages().find((m) => (m as { role: string }).role === "toolResult") as {
      content: { text?: string }[];
    };
    expect(JSON.stringify(toolResult.content)).toContain("权限拒绝");
  });
});
