import { describe, expect, it } from "vitest";

import { createToolbox, ToolArgumentError } from "../src/toolbox.js";
import type { ToolSpec } from "../src/toolbox.js";

// ---------------------------------------------------------------------------
// 夹具：一个不碰文件系统的假工具（FR-4.2 的成本证明载体）
// ---------------------------------------------------------------------------

function echoSpec(name = "echo"): ToolSpec {
  return {
    name,
    description: "把参数原样返回。测试专用。",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
      additionalProperties: false,
    },
    parse(args) {
      if (typeof args["text"] !== "string") {
        throw new ToolArgumentError("echo 的 text 必须是字符串");
      }
      return { text: args["text"] };
    },
    async run(args) {
      return { echoed: args["text"] as string };
    },
    material(value) {
      const record = value as { readonly echoed?: unknown };
      return typeof record?.echoed === "string" ? [{ path: `echo://${record.echoed}`, lines: null }] : [];
    },
  };
}

const NOW = (): number => 1_000;

describe("createToolbox：装配契约（SDD T11）", () => {
  it("一次组装给出全套形状：gated 端口 / 裸端口 / 组装接缝 / 缺失清单 / materialReader", () => {
    const box = createToolbox([echoSpec()], { repoRoot: "/repo", clock: NOW });

    expect(box.names).toEqual(["echo"]);
    expect(box.port.names).toEqual(["echo"]);
    expect(box.rawPort.names).toEqual(["echo"]);
    expect(typeof box.assembleObservation).toBe("function");
    expect(typeof box.collectMissingMaterial).toBe("function");
    expect(typeof box.materialReader).toBe("function");
  });

  it("重名注册在装配时即抛，而不是等到第一次分派", () => {
    expect(() => createToolbox([echoSpec("a"), echoSpec("a")], { repoRoot: "/repo", clock: NOW })).toThrowError(
      /重复注册/,
    );
  });

  it("新工具只通过 spec 清单进入系统：gated 端口能执行它，无需改 adapter / catalog / 协议", async () => {
    const box = createToolbox([echoSpec()], { repoRoot: "/repo", clock: NOW });
    const outcome = await box.port.execute(
      { name: "echo", args: { text: "你好" } },
      new AbortController().signal,
    );

    expect(outcome.error).toBeNull();
    expect(outcome.value).toEqual({ echoed: "你好" });

    // gated 端口写的 provenance / truncated 只能来自执行层
    const observation = box.assembleObservation(
      { name: "echo", args: { text: "你好" } },
      outcome,
    );
    expect(observation.truncated).toBe(false);
    expect(observation.provenance).toEqual({ source: "echo", at: 1_000 });
  });

  it("allowlist 之外的调用被执行层拦下，且不进入裸端口", async () => {
    const box = createToolbox([echoSpec()], { repoRoot: "/repo", clock: NOW });

    const gated = await box.port.execute({ name: "nope", args: {} }, new AbortController().signal);
    expect(gated.error?.code).toBe("invalid_tool");

    const raw = await box.rawPort.execute({ name: "nope", args: {} }, new AbortController().signal);
    expect(raw.error?.code).toBe("invalid_tool");
  });

  it("materialReader 按工具名分派到 spec 自己的 material", () => {
    const box = createToolbox([echoSpec()], { repoRoot: "/repo", clock: NOW });

    expect(box.materialReader({ tool: "echo", value: { echoed: "x" } })).toEqual([
      { path: "echo://x", lines: null },
    ]);
    expect(box.materialReader({ tool: "谁也不是", value: {} })).toEqual([]);
  });

  it("裸端口与 gated 端口在正常路径上产出一致（差别只在停止与超时的归因）", async () => {
    const box = createToolbox([echoSpec()], { repoRoot: "/repo", clock: NOW });
    const signal = new AbortController().signal;
    const intent = { name: "echo", args: { text: "同" } };

    const raw = await box.rawPort.execute(intent, signal);
    const gated = await box.port.execute(intent, signal);

    expect(gated).toEqual(raw);
  });
});
