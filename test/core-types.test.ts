import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 这个探针本身是断言：NodeNext 要求相对导入写 `.js` 后缀，
// 而磁盘上只有 `.ts`。如果测试运行器不能把 `.js` 映射回 `.ts`，
// 这个 import 会直接解析失败——所以它同时验证了工具链和源码约定一致。
import type {
  AgentEvent,
  Decision,
  Observation,
  RunErrorCode,
  ToolError,
  ToolOutcome,
} from "../src/core/types.js";
import "../src/core/types.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const coreDir = join(repoRoot, "src", "core");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 抽出源码里所有模块引用：静态、副作用、动态、require。 */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const specs: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec !== undefined) specs.push(spec);
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Core 的纯度。这是整个仓库的承重墙：Core 必须在没有进程、数据库、网络和
// UI 的情况下跑完，而这只有在 Core 什么都不依赖时才成立。
// 每一条外部集成都必须作为端口背后的适配器、并且由开发序列里的某一步证明其必要性。
// ---------------------------------------------------------------------------
describe("Core purity", () => {
  const coreFiles = listTsFiles(coreDir);
  const sdkSpecifiers = ["@earendil-works/", "@tintinweb/", "pi-coding-agent", "pi-ai"];

  it("has at least one Core file to check", () => {
    expect(coreFiles.length).toBeGreaterThan(0);
  });

  it("declares no imports at all in the domain vocabulary", () => {
    const vocabulary = join(coreDir, "types.ts");
    expect(importSpecifiers(readFileSync(vocabulary, "utf8"))).toEqual([]);
  });

  it("imports nothing from outside the Core", () => {
    for (const file of coreFiles) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        const relative = file.slice(repoRoot.length);
        expect(spec.startsWith("."), `${relative} 引用了 Core 之外的东西：${spec}`).toBe(true);
        expect(
          resolve(dirname(file), spec).startsWith(coreDir),
          `${relative} 越出了 src/core：${spec}`,
        ).toBe(true);
      }
    }
  });

  it("never imports the Pi Agent SDK", () => {
    for (const file of coreFiles) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        const relative = file.slice(repoRoot.length);
        expect(
          sdkSpecifiers.some((prefix) => spec.startsWith(prefix)),
          `${relative} 直接引用了 SDK：${spec}`,
        ).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Decision：三种可能必须穷尽。
// 下面这个 switch 是编译期证明——漏掉任何一个 kind，tsc 就会因为没有
// 落到 `never` 而报错。运行时那半只验证载荷确实被正确携带。
// ---------------------------------------------------------------------------
describe("Decision", () => {
  function assertNever(value: never, where: string): never {
    throw new Error(`unreachable Decision in ${where}: ${JSON.stringify(value)}`);
  }

  function label(decision: Decision): string {
    switch (decision.kind) {
      case "call_tool":
        return `tool:${decision.intent.name}`;
      case "respond":
        return `respond:${decision.report.summary}`;
      case "ask_human":
        return `human:${decision.question}`;
      default:
        return assertNever(decision, "label");
    }
  }

  it("carries each variant's own payload", () => {
    expect(label({ kind: "call_tool", intent: { name: "read_file", args: { path: "a.ts" } } })).toBe(
      "tool:read_file",
    );
    expect(label({ kind: "respond", report: { summary: "ok", claims: [] } })).toBe("respond:ok");
    expect(label({ kind: "ask_human", question: "哪个模块？" })).toBe("human:哪个模块？");
  });

  it("allows a claim with no evidence instead of hiding it", () => {
    const report = {
      summary: "看起来没问题",
      claims: [{ text: "没有测试覆盖 billing 模块", evidence: [] }],
    };
    expect(report.claims[0]?.evidence).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 工具结果与观测的分界。
// 工具输出是不可信输入：provenance 与 truncated 由 Runtime 组装，
// 工具无法覆盖，否则一个坏工具就能伪造"这条证据从哪来、什么时候取的"。
// 下面两行是编译期证明。
// ---------------------------------------------------------------------------
describe("Tool outcome versus observation", () => {
  const outcomeLeaksPolicyFields: [Extract<"provenance" | "truncated", keyof ToolOutcome>] extends [
    never,
  ]
    ? true
    : false = true;

  const observationCarriesProvenance: "provenance" extends keyof Observation ? true : false = true;

  it("ToolOutcome has no provenance or truncated field", () => {
    expect(outcomeLeaksPolicyFields).toBe(true);
  });

  it("Observation carries provenance, added by the Runtime", () => {
    expect(observationCarriesProvenance).toBe(true);
  });

  it("keeps a tool error typed instead of throwing", () => {
    const failed: ToolOutcome = {
      value: null,
      error: { code: "not_found", message: "src/nope.ts 不存在" },
    };
    const error: ToolError | null = failed.error;
    expect(error?.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// AgentEvent：Runtime 对外唯一的契约。
// 每个事件都必须能被排序、能被回放，且终态必须说话算数。
// ---------------------------------------------------------------------------
describe("AgentEvent", () => {
  const base = { runId: "run-1", sequence: 1, timestamp: 1_700_000_000_000 };

  const events: AgentEvent[] = [
    { ...base, type: "run_started" },
    { ...base, type: "model_requested", model: "relay-model" },
    { ...base, type: "decision_made", decision: { kind: "ask_human", question: "继续吗？" } },
    { ...base, type: "tool_started", toolCallId: "t1", toolName: "read_file" },
    {
      ...base,
      type: "tool_completed",
      toolCallId: "t1",
      toolName: "read_file",
      status: "success",
      result: "…",
      error: null,
      durationMs: 12,
    },
    {
      ...base,
      type: "observation_added",
      name: "read_file",
      observation: {
        tool: "read_file",
        value: "…",
        error: null,
        truncated: false,
        provenance: { source: "read_file", at: base.timestamp },
      },
    },
    { ...base, type: "human_input_requested", question: "继续吗？" },
    { ...base, type: "human_input_received", input: "继续" },
    { ...base, type: "run_resumed" },
    {
      ...base,
      type: "usage_reported",
      usage: { inputTokens: null, outputTokens: null, toolCalls: 1, durationMs: 30, model: null },
    },
    {
      ...base,
      type: "run_completed",
      status: "partial",
      result: { summary: "…", claims: [] },
      missingMaterial: ["grep"],
    },
    { ...base, type: "run_failed", error: { code: "invalid_tool", message: "未知工具：delete_all" } },
    { ...base, type: "run_cancelled" },
  ];

  it("carries ordering fields on every single variant", () => {
    for (const event of events) {
      expect(typeof event.runId, event.type).toBe("string");
      expect(Number.isInteger(event.sequence), event.type).toBe(true);
      expect(typeof event.timestamp, event.type).toBe("number");
    }
  });

  it("discriminates on type", () => {
    const completed = events.find((event) => event.type === "run_completed");
    expect(completed?.type).toBe("run_completed");
    if (completed?.type === "run_completed") {
      expect(completed.status).toBe("partial");
      expect(completed.missingMaterial).toEqual(["grep"]);
    }
  });

  it("only accepts codes from the typed failure taxonomy", () => {
    const codes: RunErrorCode[] = [
      "budget_iterations",
      "budget_tools",
      "budget_timeout",
      "no_progress",
      "rate_limited",
      "timeout",
      "auth",
      "invalid_tool",
      "provider_unavailable",
      "runtime_error",
    ];
    const failed = events.find((event) => event.type === "run_failed");
    expect(failed?.type).toBe("run_failed");
    if (failed?.type === "run_failed") {
      expect(codes).toContain(failed.error.code);
    }
  });
});
