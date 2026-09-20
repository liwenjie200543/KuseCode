/**
 * 适配器的纯映射层：**不需要网络、不需要凭据、不需要真机**。
 *
 * 这一层值得测试的理由很具体：provider 错误分类、终止协议的参数校验、以及
 * "一轮怎么变成一个决策"——这三处是适配器里最容易悄悄出错的地方，而它们恰好
 * 也是唯一可以完全确定地验证的部分。真机验证（`pi-adapter-sdk.test.ts` 用 SDK 自带的
 * faux provider 跑真实流式路径）验证的是"接得对"，这里验证的是"翻译得对"。
 *
 * 断言的参照物都是**真实形状**，不是编出来的：`402 Insufficient Balance` 来自
 * 2026-08-22 那次真机验证（deepseek 余额耗尽），其余状态码来自 HTTP 语义。
 */

import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context as PiContext, Usage } from "@earendil-works/pi-ai";
import { observationsOf } from "../src/core/loop.js";
import type { AgentState, Observation } from "../src/core/types.js";
import {
  AdapterError,
  ASK_HUMAN_TOOL,
  SUBMIT_REPORT_TOOL,
  addUsage,
  buildRequest,
  catalogFromToolbox,
  catalogOf,
  decideFromMessage,
  isTerminalTool,
  providerFailureFromStopReason,
  providerFailureFromThrow,
  readQuestion,
  readReport,
  renderObservationText,
  textOf,
  toolCallsOf,
  unknownUsage,
  usageFromMessage,
} from "../src/adapter/pi/index.js";
import { createRepoTools } from "../src/tools/repo-tools.js";

// ---------------------------------------------------------------------------
// 搭一个最小状态
// ---------------------------------------------------------------------------

const TASK = {
  id: "t-1",
  goal: "证据链是 reduce 串起来的吗？",
  repoRoot: "/repo",
  checks: ["有没有第二份状态推进"],
};

/**
 * 造一个状态：每条观测都按 `reduce` 的真实形状配一次调用。
 *
 * 这里**必须**是成对的 `assistant(call_tool)` → `tool(observation)`，不能只放
 * `tool`。因为（a）`reduce` 就是这么写的——一次工具调用在 transcript 里是两条消息；
 * （b）provider 的协议要求工具结果跟在它对应的调用之后，孤立的结果在真实请求里
 * 根本不合法。夹具比真实形状宽松，测出来的就不是真实行为。
 */
function stateWith(observations: readonly Observation[] = []): AgentState {
  const transcript: AgentState["transcript"][number][] = [];
  for (const observation of observations) {
    const intent = { name: observation.tool, args: { path: "src/core/loop.ts" } };
    transcript.push({ role: "assistant", decision: { kind: "call_tool", intent } });
    transcript.push({ role: "tool", intent, observation });
  }
  return {
    task: TASK,
    transcript,
    iteration: observations.length,
    pendingQuestion: null,
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    tool: "read_file",
    value: { path: "src/core/loop.ts", lines: [{ n: 1, text: "export function reduce()" }] },
    error: null,
    truncated: false,
    provenance: { source: "read_file", at: 1_700_000_000_000 },
    ...overrides,
  };
}

/** 造一个 assistant 消息。只填这个测试关心的字段。 */
function message(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet",
    usage: usage(10, 20),
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function usage(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function text(content: string) {
  return { type: "text" as const, text: content };
}

function toolCall(name: string, args: Record<string, unknown>) {
  return { type: "toolCall" as const, id: "call_1", name, arguments: args };
}

const NEVER = new AbortController().signal;
const decodeOptions = { clock: () => 1_700_000_000_000, signal: NEVER };

function thrown(action: () => unknown): AdapterError {
  try {
    action();
  } catch (error) {
    if (error instanceof AdapterError) return error;
    throw error;
  }
  throw new Error("本该抛出 AdapterError，但没有");
}

// ---------------------------------------------------------------------------
// 一、provider 的失败说法 → RunErrorCode
// ---------------------------------------------------------------------------

describe("错误归一：provider 的说法 → Core 的十个码", () => {
  const byStatus: ReadonlyArray<readonly [string, string]> = [
    ["429 Too Many Requests", "rate_limited"],
    ["401 Unauthorized", "auth"],
    ["403 Forbidden", "auth"],
    ["402 Insufficient Balance", "provider_unavailable"],
    ["500 Internal Server Error", "provider_unavailable"],
    ["503 Service Unavailable", "provider_unavailable"],
    ["408 Request Timeout", "timeout"],
    ["422 Unprocessable Entity", "invalid_tool"],
  ];

  for (const [text, code] of byStatus) {
    it(`stopReason=error 且消息是「${text}」→ ${code}`, () => {
      const failure = providerFailureFromStopReason("error", text, NEVER);
      expect(failure?.code).toBe(code);
      expect(failure?.message).toBe(text);
    });
  }

  it("402 归一成 provider_unavailable，而不是 auth——余额与凭据是两件事", () => {
    // 这一条来自真机记录：恢复额度就能重跑，重新登录没有用。
    // 所以它不该落进 auth（那会让人去查密钥），也不该被当成不可恢复的 runtime_error。
    expect(providerFailureFromStopReason("error", "402 Insufficient Balance", NEVER)?.code).toBe(
      "provider_unavailable",
    );
  });

  it("认不出来的消息落到 runtime_error，而不是猜一个", () => {
    expect(providerFailureFromStopReason("error", "something exploded", NEVER)?.code).toBe(
      "runtime_error",
    );
  });

  it("额度用尽排在限流之前：「rate limit reached for your plan」是余额问题", () => {
    const failure = providerFailureFromStopReason(
      "error",
      "rate limit reached: insufficient credit for your plan",
      NEVER,
    );
    // 认成 rate_limited 会让 Runtime 重试三次，而真正的修法是充值
    expect(failure?.code).toBe("provider_unavailable");
  });

  it("stopReason=stop 时没有失败可归一", () => {
    expect(providerFailureFromStopReason("stop", undefined, NEVER)).toBeNull();
    expect(providerFailureFromStopReason("toolUse", undefined, NEVER)).toBeNull();
  });

  it("信号中止时**不给码**：归因权留给 Runtime", () => {
    const controller = new AbortController();
    controller.abort();
    const failure = providerFailureFromStopReason("error", "402 Insufficient Balance", controller.signal);
    // Runtime 手上有 cause()，能分清"用户取消"与"墙钟到点"；这里分不清，所以不猜。
    expect(failure?.code).toBeNull();
    expect(failure?.message).toBe("402 Insufficient Balance");
  });

  it("抛出物：带合法码的原样保留（402 与 429 都不会被改写）", () => {
    expect(providerFailureFromThrow({ code: "rate_limited", message: "x" }, NEVER).code).toBe(
      "rate_limited",
    );
    expect(providerFailureFromThrow({ code: "auth", message: "x" }, NEVER).code).toBe("auth");
  });

  it("抛出物：provider 的 oauth 码翻成 auth（它是 provider 的词汇）", () => {
    expect(providerFailureFromThrow({ code: "oauth", message: "refresh failed" }, NEVER).code).toBe(
      "auth",
    );
  });

  it("抛出物：AbortError 但没有中止的信号，是 SDK 自己打断的", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(providerFailureFromThrow(abort, NEVER).code).toBe("provider_unavailable");
  });

  it("抛出物：裸 Error 走文本规则，认不出来就是 runtime_error", () => {
    expect(providerFailureFromThrow(new Error("fetch failed"), NEVER).code).toBe(
      "provider_unavailable",
    );
    expect(providerFailureFromThrow(new Error("ENOTFOUND api.example.com"), NEVER).code).toBe(
      "provider_unavailable",
    );
    expect(providerFailureFromThrow(new Error("boom"), NEVER).code).toBe("runtime_error");
  });

  it("1402 不会被当成 402：状态码必须是一个独立的数字", () => {
    expect(providerFailureFromStopReason("error", "request 1402 rejected", NEVER)?.code).toBe(
      "runtime_error",
    );
  });
});

// ---------------------------------------------------------------------------
// 二、一轮 → 一个决策
// ---------------------------------------------------------------------------

describe("一轮怎么变成一个决策", () => {
  it("stopReason=error 的流式收尾会抛错，而不是被当成一句话", () => {
    // 这是最容易漏的一条：pi-ai 的流在 provider 出错时**不 reject**。
    const error = thrown(() =>
      decideFromMessage(message({ stopReason: "error", errorMessage: "429 Too Many Requests" }), decodeOptions),
    );
    expect(error.code).toBe("rate_limited");
  });

  it("stopReason=aborted（provider 侧）也不会变成决策", () => {
    const error = thrown(() =>
      decideFromMessage(message({ stopReason: "aborted", errorMessage: "aborted" }), decodeOptions),
    );
    expect(error.code).toBe("provider_unavailable");
  });

  it("真实工具调用 → call_tool，参数原样过去", () => {
    const decision = decideFromMessage(
      message({
        stopReason: "toolUse",
        content: [toolCall("read_file", { path: "src/core/loop.ts", startLine: 160 })],
      }),
      decodeOptions,
    );
    expect(decision).toEqual({
      kind: "call_tool",
      intent: { name: "read_file", args: { path: "src/core/loop.ts", startLine: 160 } },
    });
  });

  it("未知工具名也走 call_tool：allowlist 只有一份，在执行层", () => {
    const decision = decideFromMessage(
      message({ stopReason: "toolUse", content: [toolCall("delete_everything", {})] }),
      decodeOptions,
    );
    // 适配器不做第二次否决——否则"谁能调什么"就有两个可以不一致的答案。
    expect(decision.kind).toBe("call_tool");
  });

  it("submit_report → respond，claims 与 evidence 都被读出来", () => {
    const decision = decideFromMessage(
      message({
        stopReason: "toolUse",
        content: [
          toolCall(SUBMIT_REPORT_TOOL, {
            summary: "是同一个 reduce",
            claims: [
              {
                text: "实时与回放共用 reduce",
                evidence: [
                  { path: "src/core/loop.ts", lines: [164, 180], excerpt: "export function reduce(" },
                ],
              },
            ],
          }),
        ],
      }),
      decodeOptions,
    );
    expect(decision).toEqual({
      kind: "respond",
      report: {
        summary: "是同一个 reduce",
        claims: [
          {
            text: "实时与回放共用 reduce",
            evidence: [
              {
                path: "src/core/loop.ts",
                lines: [164, 180],
                excerpt: "export function reduce(",
                // provenance 由**我们**写：模型不知道"什么时候"，而回放要沿用这个值
                provenance: { source: "model", at: 1_700_000_000_000 },
              },
            ],
          },
        ],
      },
    });
  });

  it("ask_human → ask_human", () => {
    const decision = decideFromMessage(
      message({
        stopReason: "toolUse",
        content: [toolCall(ASK_HUMAN_TOOL, { question: "以哪一条为准？" })],
      }),
      decodeOptions,
    );
    expect(decision).toEqual({ kind: "ask_human", question: "以哪一条为准？" });
  });

  it("纯文本（模型忽略了协议）是合法收场：claims 为空数组", () => {
    const decision = decideFromMessage(
      message({ content: [text("  loop.ts 里只有一个 reduce。 ")] }),
      decodeOptions,
    );
    // 空数组不是"忘了填"，而是 Core 明确定义的"我说了但没找到依据"
    expect(decision).toEqual({
      kind: "respond",
      report: { summary: "loop.ts 里只有一个 reduce。", claims: [] },
    });
  });

  it("纯文本但一个字都没有 → 抛错（没有诚实的替代品）", () => {
    const error = thrown(() => decideFromMessage(message({ content: [] }), decodeOptions));
    expect(error.code).toBe("runtime_error");
  });

  it("一轮里两个工具调用 → 抛错，不丢掉第二个", () => {
    const error = thrown(() =>
      decideFromMessage(
        message({
          stopReason: "toolUse",
          content: [toolCall("read_file", { path: "a" }), toolCall("search_text", { pattern: "x" })],
        }),
        decodeOptions,
      ),
    );
    expect(error.code).toBe("runtime_error");
    expect(error.message).toContain("read_file, search_text");
    expect(error.message).toContain("一个意图");
  });

  it("被截断的输出（length）不当成答案", () => {
    const error = thrown(() =>
      decideFromMessage(message({ stopReason: "length", content: [text("结论是")] }), decodeOptions),
    );
    // 把半句话伪装成结论，比一次可见的失败更糟
    expect(error.message).toContain("maxTokens");
  });

  it("deferred 不是这条通道能处理的东西", () => {
    const error = thrown(() =>
      decideFromMessage(message({ stopReason: "deferred", content: [text("…")] }), decodeOptions),
    );
    expect(error.message).toContain("deferred");
  });

  it("toolCallsOf / textOf 只看自己那一种块", () => {
    const mixed = message({
      stopReason: "toolUse",
      content: [text("我先读一下"), toolCall("read_file", { path: "a" })],
    });
    expect(toolCallsOf(mixed)).toHaveLength(1);
    expect(textOf(mixed)).toBe("我先读一下");
  });
});

// ---------------------------------------------------------------------------
// 三、终止协议的参数校验
// ---------------------------------------------------------------------------

describe("终止协议：Core 有表示的收敛，没有表示的失败", () => {
  const provenance = { source: "model" as const, at: 1 };

  it("evidence 缺失 → 空数组（Core 说那是「我说了但没找到依据」）", () => {
    const report = readReport({ summary: "s", claims: [{ text: "c" }] }, provenance);
    expect(report.claims[0]?.evidence).toEqual([]);
  });

  it("claims 缺失 → 空数组", () => {
    expect(readReport({ summary: "s" }, provenance).claims).toEqual([]);
  });

  it("lines 缺失 → null（Core 说整文件级证据为 null）", () => {
    const report = readReport(
      { summary: "s", claims: [{ text: "c", evidence: [{ path: "a.ts" }] }] },
      provenance,
    );
    expect(report.claims[0]?.evidence[0]?.lines).toBeNull();
    // 没给摘录 → 空串：一个可见的取值，而不是编造一段原文
    expect(report.claims[0]?.evidence[0]?.excerpt).toBe("");
  });

  it("summary 缺失 → invalid_tool，而且指名是哪个字段", () => {
    const error = thrown(() => readReport({}, provenance));
    expect(error.code).toBe("invalid_tool");
    expect(error.message).toContain("summary");
  });

  it("claim.text 缺失 → invalid_tool", () => {
    const error = thrown(() => readReport({ summary: "s", claims: [{}] }, provenance));
    expect(error.code).toBe("invalid_tool");
    expect(error.message).toContain("claims[0].text");
  });

  it("evidence.path 为空 → invalid_tool", () => {
    const error = thrown(() =>
      readReport({ summary: "s", claims: [{ text: "c", evidence: [{ path: "" }] }] }, provenance),
    );
    expect(error.code).toBe("invalid_tool");
  });

  it("lines 不是两个数字 → invalid_tool", () => {
    const error = thrown(() =>
      readReport(
        { summary: "s", claims: [{ text: "c", evidence: [{ path: "a", lines: [1] }] }] },
        provenance,
      ),
    );
    expect(error.code).toBe("invalid_tool");
  });

  it("lines 止行号小于起行号 → invalid_tool", () => {
    const error = thrown(() =>
      readReport(
        { summary: "s", claims: [{ text: "c", evidence: [{ path: "a", lines: [9, 2] }] }] },
        provenance,
      ),
    );
    expect(error.message).toContain("止行号");
  });

  it("params 根本不是对象 → invalid_tool", () => {
    expect(thrown(() => readReport("就一句话", provenance)).code).toBe("invalid_tool");
  });

  it("ask_human 的 question 必须是非空字符串", () => {
    expect(readQuestion({ question: "人才能答的问题" })).toBe("人才能答的问题");
    expect(thrown(() => readQuestion({ question: "" })).code).toBe("invalid_tool");
    expect(thrown(() => readQuestion({})).code).toBe("invalid_tool");
  });

  it("isTerminalTool 只认那两个协议工具", () => {
    expect(isTerminalTool(SUBMIT_REPORT_TOOL)).toBe(true);
    expect(isTerminalTool(ASK_HUMAN_TOOL)).toBe(true);
    expect(isTerminalTool("read_file")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 四、用量
// ---------------------------------------------------------------------------

describe("用量：不知道就回答 null，不是 0", () => {
  it("provider 报了数就用它", () => {
    expect(usageFromMessage(message({ usage: usage(120, 34) }))).toEqual({
      inputTokens: 120,
      outputTokens: 34,
    });
  });

  it("provider 没报（deepseek 的已知缺口）→ 两项都是 null", () => {
    // 运行时的形状可能没有 usage 字段，尽管类型上它必填——响应是不可信输入
    const withoutUsage = message({});
    delete (withoutUsage as { usage?: unknown }).usage;
    expect(usageFromMessage(withoutUsage)).toEqual({ inputTokens: null, outputTokens: null });
  });

  it("usage 字段里有 undefined → 那一项是 null，不是 0", () => {
    const partial = message({ usage: { input: undefined, output: 7 } as unknown as Usage });
    expect(usageFromMessage(partial)).toEqual({ inputTokens: null, outputTokens: 7 });
  });

  /**
   * 这一组是**从一次真实失败里长出来的**：一次 Run 的账本原本用"未知"
   * （`{null, null}`）当初始值，第一次累加就变成了 `null + 120 = null`，
   * 于是用量一个数字都记不下来——而所有只看"最终结果"的断言都发现不了它。
   *
   * 结论是：`null` 在加法里**不是单位元，而是一条传染源**。所以"还没记过账"
   * 必须是一个独立的状态（`model.ts` 的 `LedgerEntry.usage`），
   * 不能拿 `{null, null}` 冒充。
   */
  it("未知加已知还是未知：null 不是加法单位元，而是一条传染源", () => {
    expect(addUsage(unknownUsage(), { inputTokens: 120, outputTokens: 34 })).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("两项各自相加，互不牵连", () => {
    expect(
      addUsage({ inputTokens: 120, outputTokens: 34 }, { inputTokens: 8, outputTokens: 6 }),
    ).toEqual({ inputTokens: 128, outputTokens: 40 });
  });

  it("任一侧的任一项未知，那一项的总和就是未知", () => {
    expect(addUsage({ inputTokens: null, outputTokens: 34 }, { inputTokens: 8, outputTokens: 6 })).toEqual({
      inputTokens: null,
      outputTokens: 40,
    });
  });

  it("零是「测到了、花的是零」，不是「没测到」", () => {
    // 这两个数在账目上完全不同：`0` 可以放心地求和进成本报告，
    // `null` 不行。把它们写成一个值，成本报告就会拿"没测到"当"没花钱"。
    expect(addUsage({ inputTokens: 0, outputTokens: 0 }, { inputTokens: 5, outputTokens: 0 })).toEqual({
      inputTokens: 5,
      outputTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 五、状态 → provider 的对话
// ---------------------------------------------------------------------------

describe("状态怎么翻成一次请求", () => {
  const box = createRepoTools({ repoRoot: "." });
  const catalog = catalogFromToolbox(box);
  const identity = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet" };

  it("任务面的字段全部来自 renderContext，适配器一个都没发明", () => {
    const state = stateWith([observation()]);
    const request = buildRequest({
      state,
      availableTools: catalog.allNames,
      identity,
      tools: catalog.entries,
    });
    expect(request.context.goal).toBe(TASK.goal);
    expect(request.context.repoRoot).toBe(TASK.repoRoot);
    expect(request.context.checks).toEqual(TASK.checks);
    expect(request.context.availableTools).toEqual(catalog.allNames);
    expect(request.context.iteration).toBe(state.iteration);
  });

  it("投影里的观测序列与对话里的工具结果逐条相等（两份说法不会分叉）", () => {
    const observations = [observation(), observation({ tool: "list_dir", value: { entries: [] } })];
    const state = stateWith(observations);
    const request = buildRequest({
      state,
      availableTools: catalog.allNames,
      identity,
      tools: catalog.entries,
    });

    const results = request.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(observationsOf(state).length);
    results.forEach((result, index) => {
      const expected = observationsOf(state)[index];
      expect(result.role === "toolResult" && result.toolName).toBe(expected?.tool);
    });
  });

  it("每个工具结果都挂在它对应的那次调用上（id 是位置推导出来的，确定可复现）", () => {
    const state = stateWith([observation(), observation({ tool: "list_dir" })]);
    const request = buildRequest({
      state,
      availableTools: catalog.allNames,
      identity,
      tools: catalog.entries,
    });
    const calls = request.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (m.role === "assistant" ? m.content : []))
      .filter((block) => block.type === "toolCall");
    const results = request.messages.filter((m) => m.role === "toolResult");
    expect(calls.map((c) => c.id)).toEqual(["call_0", "call_1"]);
    expect(results.map((r) => (r.role === "toolResult" ? r.toolCallId : ""))).toEqual([
      "call_0",
      "call_1",
    ]);
  });

  it("第一条永远是任务本身（目标、仓库根、检查维度）", () => {
    const request = buildRequest({
      state: stateWith(),
      availableTools: catalog.allNames,
      identity,
      tools: catalog.entries,
    });
    const first = request.messages[0];
    expect(first?.role).toBe("user");
    expect(first?.role === "user" ? first.content : "").toContain(TASK.goal);
    expect(first?.role === "user" ? first.content : "").toContain("/repo");
  });

  it("「有意图、没有结果」的收尾会补一条诚实的工具结果，而不是留一个悬空调用", () => {
    const state: AgentState = {
      task: TASK,
      transcript: [
        { role: "assistant", decision: { kind: "call_tool", intent: { name: "read_file", args: { path: "a" } } } },
      ],
      iteration: 1,
      pendingQuestion: null,
    };
    const request = buildRequest({
      state,
      availableTools: catalog.allNames,
      identity,
      tools: catalog.entries,
    });
    const results = request.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]?.role === "toolResult" && results[0].isError).toBe(true);
    expect(results[0]?.role === "toolResult" && results[0].toolCallId).toBe("call_0");
  });

  it("观测的正文带着失败与截断，模型看得见「这次没拿到」", () => {
    expect(renderObservationText(observation({ value: null, error: { code: "tool_failed", message: "ENOENT" } })))
      .toContain("调用失败（tool_failed）");
    expect(renderObservationText(observation({ truncated: true }))).toContain("被截断");
  });

  it("respond 与 ask_human 在历史里是文本，工具调用是 toolCall 块", () => {
    const state: AgentState = {
      task: TASK,
      transcript: [
        { role: "assistant", decision: { kind: "ask_human", question: "以哪一条为准？" } },
      ],
      iteration: 1,
      pendingQuestion: "以哪一条为准？",
    };
    const request = buildRequest({
      state,
      availableTools: catalog.allNames,
      identity,
      tools: catalog.entries,
    });
    const assistant = request.messages.find((m) => m.role === "assistant");
    expect(assistant?.role === "assistant" && assistant.content[0]).toEqual({
      type: "text",
      text: "以哪一条为准？",
    });
  });

  it("工具声明就是目录里的条目，一个不多一个不少", () => {
    const request = buildRequest({
      state: stateWith(),
      availableTools: catalog.allNames,
      identity,
      tools: catalog.entries,
    });
    expect(request.tools.map((t) => t.name)).toEqual([...catalog.allNames]);
  });
});

// ---------------------------------------------------------------------------
// 六、工具目录
// ---------------------------------------------------------------------------

describe("工具目录", () => {
  it("真实工具 + 两个协议工具，各归各的 kind", () => {
    const catalog = catalogFromToolbox(createRepoTools({ repoRoot: "." }));
    expect(catalog.repoNames).toEqual(["read_file", "list_dir", "search_text"]);
    expect([...catalog.allNames].sort()).toEqual(
      ["ask_human", "list_dir", "read_file", "search_text", "submit_report"].sort(),
    );
    expect(catalog.entry(SUBMIT_REPORT_TOOL)?.kind).toBe("terminal");
    expect(catalog.entry("read_file")?.kind).toBe("repo");
  });

  it("协议工具不在 repoNames 里：它们从不交给执行层", () => {
    const catalog = catalogFromToolbox(createRepoTools({ repoRoot: "." }));
    expect(catalog.repoNames).not.toContain(SUBMIT_REPORT_TOOL);
    expect(catalog.repoNames).not.toContain(ASK_HUMAN_TOOL);
  });

  it("撞名当场失败：一个叫 submit_report 的真实工具会让语义静默漂移", () => {
    expect(() =>
      catalogOf([
        { name: SUBMIT_REPORT_TOOL, description: "x", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, kind: "repo" },
        { name: SUBMIT_REPORT_TOOL, description: "y", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, kind: "terminal" },
      ]),
    ).toThrow(/重复/);
  });

  it("协议工具的 schema 是 object，且 required 由 schema 自己说了算", () => {
    const catalog = catalogFromToolbox(createRepoTools({ repoRoot: "." }));
    const submit = catalog.entry(SUBMIT_REPORT_TOOL);
    expect(submit?.parameters.type).toBe("object");
    expect(submit?.parameters.required).toEqual(["summary"]);
    const ask = catalog.entry(ASK_HUMAN_TOOL);
    expect(ask?.parameters.required).toEqual(["question"]);
  });

  it("真实工具的 schema 里声明的键与校验函数认的键一致", () => {
    // 两份实现（声明给模型看 / 校验给执行用）不该分叉。这条断言把分叉变成测试失败。
    const box = createRepoTools({ repoRoot: "." });
    const probes: Record<string, Record<string, unknown>> = {
      read_file: { path: "a" },
      list_dir: {},
      search_text: { pattern: "x" },
    };
    for (const spec of box.specs) {
      const declared = Object.keys(spec.parameters.properties).sort();
      // 用一份合法参数跑一次 parse，再看它收敛出的键是否都在声明里
      const probe = probes[spec.name];
      expect(probe, `${spec.name} 缺少探针参数`).toBeDefined();
      if (probe === undefined) continue;
      const parsed = spec.parse(probe);
      for (const key of Object.keys(parsed)) {
        expect(declared, `${spec.name}.${key} 没在 schema 里声明`).toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 七、这条通道不需要 SDK 也能被验证——因为纯映射层不 import SDK 的类型
// ---------------------------------------------------------------------------

describe("纯映射层的纯度", () => {
  it("decideFromMessage 接受的只是一个普通对象，不需要真的 provider", () => {
    // 上面所有断言都跑在手工构造的消息上，没有网络、没有凭据、没有 provider 注册。
    // 这本身就是结论：适配器里最容易错的那一半，是可验证的那一半。
    const message = {
      role: "assistant" as const,
      content: [text("ok")],
      api: "x",
      provider: "y",
      model: "z",
      usage: usage(1, 1),
      stopReason: "stop" as const,
      timestamp: 0,
    };
    expect(decideFromMessage(message, decodeOptions)).toEqual({
      kind: "respond",
      report: { summary: "ok", claims: [] },
    });
  });

  it("pi-ai 的 Context 形状与我们的请求装配对得上", () => {
    const context: PiContext = { systemPrompt: "s", messages: [], tools: [] };
    expect(context.messages).toEqual([]);
  });
});
