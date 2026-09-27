import { describe, expect, it } from "vitest";

import {
  estimateTokens,
  projectConversation,
  type ProjectionPolicy,
  type ProjectedTurn,
} from "../src/core/project.js";
import type { AgentState, Message, Observation, Task } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// 夹具：一条真实的观测长什么样
// ---------------------------------------------------------------------------

const task: Task = {
  id: "task-1",
  goal: "这个仓库里有哪些 TODO？",
  repoRoot: "/repo",
  checks: ["列出 TODO 位置"],
};

const POLICY: ProjectionPolicy = {
  keepRecentTurns: 2,
  projectionTokenBudget: 1_000_000, // 足够大 → 永不折叠
  foldedObservationChars: 200,
  foldedDecisionChars: 120,
};

function observationOf(value: unknown, overrides: Partial<Observation> = {}): Observation {
  return {
    tool: "read_file",
    value,
    error: null,
    truncated: false,
    provenance: { source: "read_file", at: 1_000 },
    ...overrides,
  };
}

function stateWith(transcript: readonly Message[]): AgentState {
  return { task, transcript, iteration: transcript.length, pendingQuestion: null };
}

function callTool(name: string, args: Record<string, unknown>): Message {
  return { role: "assistant", decision: { kind: "call_tool", intent: { name, args } } };
}

function toolMessage(
  intent: { name: string; args: Record<string, unknown> },
  observation: Observation,
): Message {
  return { role: "tool", intent, observation };
}

function verbatimMessages(turns: readonly ProjectedTurn[]): readonly Message[] {
  return turns.flatMap((turn) => (turn.kind === "verbatim" ? turn.messages : []));
}

/** 造 N 轮"读文件"的 transcript，每条观测 value 长 `valueChars` 个字符。 */
function longTranscript(turns: number, valueChars: number): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < turns; index += 1) {
    const intent = { name: "read_file", args: { path: `src/file-${index}.ts` } };
    messages.push(callTool(intent.name, intent.args));
    messages.push(
      toolMessage(intent, observationOf(`export const value${index} = "${"x".repeat(valueChars)}";`)),
    );
  }
  return messages;
}

// ---------------------------------------------------------------------------
// 一、完整性与保序性：无折叠时投影与全量等价（T5 接入不破 golden 的前提）
// ---------------------------------------------------------------------------

describe("投影：完整性与保序性", () => {
  it("预算足够大时全部 verbatim，且逐字覆盖 transcript 的全部消息、顺序不变", () => {
    const transcript = longTranscript(6, 50);
    const projection = projectConversation(stateWith(transcript), POLICY);

    expect(projection.foldedTurns).toBe(0);
    expect(projection.turns.every((turn) => turn.kind === "verbatim")).toBe(true);
    expect(verbatimMessages(projection.turns)).toEqual(transcript);
  });

  it("空 transcript 投影为空（全函数：任何合法状态都有定义良好的结果）", () => {
    const projection = projectConversation(stateWith([]), POLICY);

    expect(projection.turns).toEqual([]);
    expect(projection.estimatedTokens).toBe(0);
    expect(projection.foldedTurns).toBe(0);
  });

  it("决定性：同一 (state, policy) 两次投影逐字节相同", () => {
    const state = stateWith(longTranscript(5, 800));
    const a = JSON.stringify(projectConversation(state, POLICY));
    const b = JSON.stringify(projectConversation(state, POLICY));

    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 二、有界性与保护窗口
// ---------------------------------------------------------------------------

describe("投影：预算与保护窗口", () => {
  it("超预算时从最旧的轮开始折叠，估算入界（预算可达时）", () => {
    const transcript = longTranscript(40, 600); // 每轮逐字成本 ≈ 200 token
    // 折叠摘要足够短（60 字符上限），预算可达：38 轮折叠后估算 ≈ 1.7k token。
    const policy: ProjectionPolicy = {
      keepRecentTurns: 2,
      projectionTokenBudget: 2_000,
      foldedObservationChars: 60,
      foldedDecisionChars: 120,
    };
    const projection = projectConversation(stateWith(transcript), policy);

    expect(projection.foldedTurns).toBeGreaterThan(0);
    expect(projection.estimatedTokens).toBeLessThanOrEqual(2_000);
    // 折叠的是最旧的轮：verbatims 必须是 transcript 的**尾部**切片，
    // 且至少保住保护窗口的 2 轮（4 条消息）。
    const verbatims = verbatimMessages(projection.turns);
    expect(verbatims.length).toBeGreaterThanOrEqual(4);
    expect(verbatims).toEqual(transcript.slice(transcript.length - verbatims.length));
  });

  it("预算不可达时折叠停在保护窗口边界（预算是软目标，窗口是硬约束）", () => {
    const transcript = longTranscript(20, 600);
    const policy: ProjectionPolicy = { ...POLICY, projectionTokenBudget: 800 };
    const projection = projectConversation(stateWith(transcript), policy);

    // 18 轮全部折完仍然超预算——不再折保护窗口，诚实地超着。
    expect(projection.foldedTurns).toBe(18);
    expect(projection.estimatedTokens).toBeGreaterThan(800);
  });

  it("保护窗口优先于预算：K 轮永远逐字保留，哪怕估算超预算", () => {
    const transcript = longTranscript(10, 2000); // 远超任何合理预算
    const policy: ProjectionPolicy = { ...POLICY, keepRecentTurns: 10, projectionTokenBudget: 10 };
    const projection = projectConversation(stateWith(transcript), policy);

    expect(projection.foldedTurns).toBe(0);
    expect(verbatimMessages(projection.turns)).toEqual(transcript);
    expect(projection.estimatedTokens).toBeGreaterThan(10); // 预算是软目标，窗口是硬约束
  });

  it("保护窗口恰好 K 轮：折叠不会越进窗口", () => {
    const transcript = longTranscript(6, 1000);
    const policy: ProjectionPolicy = { ...POLICY, keepRecentTurns: 2, projectionTokenBudget: 1 };
    const projection = projectConversation(stateWith(transcript), policy);

    const verbatims = verbatimMessages(projection.turns);
    expect(verbatims.length).toBeGreaterThan(0);
    // 最后 2 轮（4 条消息）必须原样活着。
    expect(verbatims).toEqual(transcript.slice(transcript.length - 4));
    expect(projection.foldedTurns).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 三、折叠的质量：可见标记、证据结构、不拆散意图与观测
// ---------------------------------------------------------------------------

describe("投影：折叠摘要", () => {
  it("每条摘要以 [已折叠] 开头，并携带工具名与参数（证据结构不因折叠丢失）", () => {
    const transcript = longTranscript(4, 3000);
    const projection = projectConversation(stateWith(transcript), {
      ...POLICY,
      keepRecentTurns: 1,
      projectionTokenBudget: 1,
    });

    const folded = projection.turns.find((turn): turn is Extract<ProjectedTurn, { kind: "folded" }> => turn.kind === "folded");
    expect(folded).toBeDefined();
    expect(folded?.digest.length).toBeGreaterThan(0);
    for (const line of folded?.digest ?? []) {
      expect(line.startsWith("[已折叠]")).toBe(true);
    }
    expect(folded?.digest.join("\n")).toContain("read_file");
    expect(folded?.digest.join("\n")).toContain("src/file-0.ts");
  });

  it("失败观测折叠时保留错误码与消息", () => {
    const intent = { name: "read_file", args: { path: "src/missing.ts" } };
    const transcript: Message[] = [
      callTool(intent.name, intent.args),
      toolMessage(
        intent,
        observationOf(null, {
          error: { code: "tool_failed", message: "文件不存在：src/missing.ts" },
        }),
      ),
    ];
    const projection = projectConversation(stateWith(transcript), {
      ...POLICY,
      keepRecentTurns: 0,
      projectionTokenBudget: 1,
    });

    const folded = projection.turns.filter((turn): turn is Extract<ProjectedTurn, { kind: "folded" }> => turn.kind === "folded");
    expect(folded.flatMap((turn) => turn.digest).join("\n")).toContain("tool_failed");
  });

  it("折叠边界不拆散 call_tool 的意图与观测：verbatims 的首条永远是 assistant", () => {
    const transcript = longTranscript(8, 700);
    const projection = projectConversation(stateWith(transcript), {
      ...POLICY,
      keepRecentTurns: 3,
      projectionTokenBudget: 1,
    });

    const verbatims = verbatimMessages(projection.turns);
    expect(verbatims.length).toBeGreaterThan(0);
    expect(verbatims[0]?.role).toBe("assistant");
    // 每条 tool 消息的前一条必须是 assistant 的 call_tool（同轮才可能同侧）。
    for (const [index, message] of verbatims.entries()) {
      if (message.role !== "tool") continue;
      const previous = verbatims[index - 1];
      expect(previous?.role).toBe("assistant");
    }
  });

  it("ask_human 与人的回答同轮折叠，两者都留在摘要里", () => {
    const transcript: Message[] = [
      { role: "assistant", decision: { kind: "ask_human", question: "要分析哪个目录？" } },
      { role: "human", answer: "分析 src 目录" },
    ];
    const projection = projectConversation(stateWith(transcript), {
      ...POLICY,
      keepRecentTurns: 0,
      projectionTokenBudget: 1,
    });

    const digest = projection.turns
      .filter((turn): turn is Extract<ProjectedTurn, { kind: "folded" }> => turn.kind === "folded")
      .flatMap((turn) => turn.digest)
      .join("\n");
    expect(digest).toContain("向人提问");
    expect(digest).toContain("人的回答");
    expect(digest).toContain("分析 src 目录");
  });
});

// ---------------------------------------------------------------------------
// 四、估算货币
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("≈ chars/4，向上取整（确定性、离线）", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});
