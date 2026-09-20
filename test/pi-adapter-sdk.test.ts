/**
 * 真通道：适配器接在**真的 `pi-ai` 流**上跑，而不是接在假对象上。
 *
 * `test/pi-adapter.test.ts` 测的是纯映射（把一个 `AssistantMessage` 翻成 `Decision`）。
 * 那个文件证明不了的事有三件，这个文件专门补上：
 *
 * 1. **流的形状。** provider 出错时流**不 reject**，而是以 `{type:"error"}` 收尾——
 *    这条协议事实只能靠真流验证。只写 try/catch 的实现在假对象上照样全绿。
 * 2. **请求真的出去了。** `Context` 里的 systemPrompt、消息序列与工具声明，
 *    要在 provider 收到的那一刻截下来看，而不是看我们**打算**发什么。
 * 3. **记账接的是 provider 的数字。** 用量来自 `AssistantMessage.usage`，
 *    是 provider 算的，不是我们自己估的。
 *
 * 驱动方式是 SDK 自带的 `fauxProvider()`：它是真 provider，走真的 provider 注册、
 * 真的 auth 解析、真的 `AssistantMessageEventStream`，只是"模型"由脚本给。
 * 所以这些测试**离线、确定、不需要凭据**，但它们跑的是生产代码路径，不是替身。
 *
 * 这里**不**碰网络：需要凭据的真机路径见 `docs/08-pi-adapter.md` 的"未验证"一节。
 */

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AssistantMessageEvent, AssistantMessage, Context, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ToolCatalog } from "../src/adapter/pi/catalog.js";
import { catalogFromToolbox } from "../src/adapter/pi/catalog.js";
import { AdapterError } from "../src/adapter/pi/errors.js";
import { piModelAdapter } from "../src/adapter/pi/model.js";
import { ASK_HUMAN_TOOL, SUBMIT_REPORT_TOOL } from "../src/adapter/pi/protocol.js";
import type { AgentState } from "../src/core/types.js";
import { createRepoTools } from "../src/tools/repo-tools.js";

// ---------------------------------------------------------------------------
// 编译期证明：重试的所有权在 Runtime，调用方改不了
//
// 这条断言不是运行时的，它由 `tsc` 执行：如果适配器的 `options` 类型哪天放开了
// `maxRetries`，下面那个 `@ts-expect-error` 会变成"多余的指令"而**编译失败**。
// 换句话说，"两处都重试"这个 bug 在这一步是编译不过的，不是靠人记得。
// ---------------------------------------------------------------------------

function retryOwnershipIsCompileTimeOnly(
  models: Models,
  model: Model<string>,
  catalog: ToolCatalog,
): void {
  // @ts-expect-error maxRetries 由适配器写死为 0（两处都重试就有一个没人数得清的账）
  piModelAdapter({ models, model, catalog, options: { maxRetries: 3 } });
}

void retryOwnershipIsCompileTimeOnly;

// ---------------------------------------------------------------------------
// 搭一条真通道
// ---------------------------------------------------------------------------

const TASK = {
  id: "t-sdk",
  goal: "适配器接在真流上还成立吗？",
  repoRoot: process.cwd(),
  checks: ["错误分类", "用量记账"],
};

function initialState(): AgentState {
  return { task: TASK, transcript: [], iteration: 0, pendingQuestion: null };
}

/** 在 provider 收到请求的那一刻，把请求截下来。 */
interface Seen {
  context: Context | null;
  options: SimpleStreamOptions | undefined;
}

function harness() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const toolbox = createRepoTools({ repoRoot: process.cwd() });
  const catalog = catalogFromToolbox(toolbox);

  const seen: Seen = { context: null, options: undefined };
  const events: AssistantMessageEvent[] = [];

  const port = piModelAdapter({
    models,
    model: faux.models[0],
    catalog,
    clock: () => 1_700_000_000_000,
    onEvent: (event) => events.push(event),
  });

  /**
   * 给下一轮脚本一个收场，顺便记下 provider 收到的请求。
   *
   * 用**工厂形式**而不是常量形式，是因为常量形式拿不到 `context`——
   * 而"我们到底发了什么"正是这个文件要证明的一半。
   */
  const script = (step: AssistantMessage): void => {
    faux.setResponses([
      (context, options) => {
        seen.context = context;
        seen.options = options;
        return step;
      },
    ]);
  };

  return { faux, catalog, seen, events, port, script };
}

type Harness = ReturnType<typeof harness>;

/** 跑一轮，返回决策；出错时把抛出物也带出来（有的用例要检查它）。 */
async function decide(
  h: Harness,
  state: AgentState = initialState(),
  signal: AbortSignal = new AbortController().signal,
): Promise<{ ok: true; decision: Awaited<ReturnType<Harness["port"]["decide"]>> } | { ok: false; error: unknown }> {
  try {
    return { ok: true, decision: await h.port.decide(state, signal) };
  } catch (error) {
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// 收场的三种说法，都在真流上验证一遍
// ---------------------------------------------------------------------------

describe("真流上的三种收场", () => {
  it("文本 → respond，claims 是空数组（Core 里「说了但没找到依据」的表示）", async () => {
    const h = harness();
    h.script(fauxAssistantMessage("循环的推进只有一个入口：reduce。"));

    const result = await decide(h);
    expect(result.ok).toBe(true);
    if (!result.ok || result.decision.kind !== "respond") throw new Error("应当是一个 respond 决策");
    expect(result.decision.report.summary).toContain("reduce");
    expect(result.decision.report.claims).toEqual([]);
  });

  it("工具调用 → call_tool，名字与参数逐字过河", async () => {
    const h = harness();
    h.script(fauxAssistantMessage(fauxToolCall("read_file", { path: "package.json", startLine: 1 })));

    const result = await decide(h);
    expect(result.ok).toBe(true);
    if (!result.ok || result.decision.kind !== "call_tool") throw new Error("应当是一个 call_tool 决策");
    expect(result.decision.intent.name).toBe("read_file");
    // 适配器不"顺手修一下"参数：形状校验是执行层的事（step 6），
    // 这里多一次宽容就会让"谁负责校验"多一个答案。
    expect(result.decision.intent.args).toEqual({ path: "package.json", startLine: 1 });
  });

  it("submit_report → respond，报告落到 Core 的 Report 形状上", async () => {
    const h = harness();
    h.script(
      fauxAssistantMessage(
        fauxToolCall(SUBMIT_REPORT_TOOL, {
          summary: "推进只有一个入口。",
          claims: [
            {
              text: "reduce 是唯一的状态推进函数",
              evidence: [{ path: "src/core/loop.ts", lines: [100, 140], excerpt: "export function reduce" }],
            },
            { text: "这条没有依据" },
          ],
        }),
      ),
    );

    const result = await decide(h);
    expect(result.ok).toBe(true);
    if (!result.ok || result.decision.kind !== "respond") throw new Error("应当是一个 respond 决策");
    const { report } = result.decision;
    expect(report.summary).toBe("推进只有一个入口。");
    expect(report.claims).toHaveLength(2);
    const [first, second] = report.claims;
    expect(first?.evidence[0]?.path).toBe("src/core/loop.ts");
    expect(first?.evidence[0]?.lines).toEqual([100, 140]);
    // 省略 evidence 的那条 claim 收敛成 `[]`，而不是被丢掉或被编造
    expect(second?.evidence).toEqual([]);
    // provenance 由我们写入（模型不知道"什么时候"），来源是 model 而不是某个工具
    expect(first?.evidence[0]?.provenance).toEqual({ source: "model", at: 1_700_000_000_000 });
  });

  it("ask_human → ask_human", async () => {
    const h = harness();
    h.script(fauxAssistantMessage(fauxToolCall(ASK_HUMAN_TOOL, { question: "这个仓库的验收标准是什么？" })));

    const result = await decide(h);
    expect(result.ok).toBe(true);
    if (!result.ok || result.decision.kind !== "ask_human") throw new Error("应当是一个 ask_human 决策");
    expect(result.decision.question).toContain("验收标准");
  });
});

// ---------------------------------------------------------------------------
// 失败与取消：都在真流的路径上
// ---------------------------------------------------------------------------

describe("真流上的失败与取消", () => {
  it("provider 报错时流不 reject，适配器照样抛出带归一化码的错误", async () => {
    const h = harness();
    // 故意不带 HTTP 状态码，只留一句文本：走的是 BY_TEXT 那张表
    h.script(fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests: rate limit reached" }));

    const result = await decide(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AdapterError);
    // 这一条是整个文件里最值得留的一条：如果实现只写 try/catch，
    // 这里会拿到一个 `ok: true` 的 respond（空文本），而不是失败。
    expect((result.error as AdapterError).code).toBe("rate_limited");
  });

  it("provider 的报错文本**不会**被当成结论交付（这是漏掉判据的真正后果）", async () => {
    const h = harness();
    // 真实 provider 常在错误消息里带上内容块。判据一旦只看 try/catch，
    // 这条消息就会顺着"纯文本兜底"变成一份 respond——**用户收到的是
    // provider 的报错原文，而它看起来像一份结论**。这比一次可见的失败糟得多。
    h.script(
      fauxAssistantMessage(fauxText("429 Too Many Requests: rate limit reached"), {
        stopReason: "error",
        errorMessage: "429 Too Many Requests: rate limit reached",
      }),
    );

    const result = await decide(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as AdapterError).code).toBe("rate_limited");
  });

  it("余额耗尽的消息认成 provider_unavailable，而不是 rate_limited", async () => {
    const h = harness();
    h.script(
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "402 Insufficient Balance: rate limit reached for your plan",
      }),
    );

    const result = await decide(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 两条线索同时出现时额度优先：认成限流会让 Runtime 去重试一个
    // 重试一千次也没用的请求，而真正的修法是去充值。
    expect((result.error as AdapterError).code).toBe("provider_unavailable");
  });

  it("我们喊停：错误**不带**码，归因权交回 Runtime", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();

    h.script(fauxAssistantMessage("", { stopReason: "aborted" }));
    const result = await decide(h, initialState(), controller.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AdapterError);
    // 不带码，是因为"用户取消"与"墙钟到点"只有 Runtime 分得清
    // （它手上有 `cause()`），适配器给它一个码只会答得比它差。
    expect(result.error as AdapterError).not.toHaveProperty("code");
  });
});

// ---------------------------------------------------------------------------
// 记账：数字来自 provider
// ---------------------------------------------------------------------------

describe("用量记账接在真流的数字上", () => {
  it("调用前账本是「未知」，调用后变成 provider 给的数字", async () => {
    const h = harness();
    const controller = new AbortController();
    const ledger = h.port.beginRun?.(controller.signal);
    expect(ledger).toBeDefined();

    // 未知必须是 `null` 而不是 `0`：`0` 的含义是"没花钱"，
    // 而这里的含义是"provider 没说"。两者不能写成一个数。
    expect(ledger?.usage()).toEqual({ inputTokens: null, outputTokens: null });

    h.script(fauxAssistantMessage("一句话。"));
    await decide(h, initialState(), controller.signal);

    const usage = ledger?.usage();
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });

  it("同一轮里多次请求累加；数字与 provider 自己报的逐项相等", async () => {
    const h = harness();
    const controller = new AbortController();
    const ledger = h.port.beginRun?.(controller.signal);

    h.script(fauxAssistantMessage("第一句。"));
    await decide(h, initialState(), controller.signal);
    const firstDone = h.events.find((e) => e.type === "done");
    if (firstDone?.type !== "done") throw new Error("应当收到一个 done 事件");

    h.script(fauxAssistantMessage("第二句。"));
    await decide(h, initialState(), controller.signal);
    const doneEvents = h.events.filter((e) => e.type === "done");
    if (doneEvents[1]?.type !== "done") throw new Error("应当收到第二个 done 事件");

    const usage = ledger?.usage();
    expect(usage?.inputTokens).toBe(firstDone.message.usage.input + doneEvents[1].message.usage.input);
    expect(usage?.outputTokens).toBe(firstDone.message.usage.output + doneEvents[1].message.usage.output);
  });

  it("两个 Run 的账本互不串（键是信号的对象身份）", async () => {
    const h = harness();
    const a = new AbortController();
    const b = new AbortController();
    const ledgerA = h.port.beginRun?.(a.signal);
    const ledgerB = h.port.beginRun?.(b.signal);

    h.script(fauxAssistantMessage("给 A 的一句话。"));
    await decide(h, initialState(), a.signal);

    expect(ledgerA?.usage().outputTokens).toBeGreaterThan(0);
    // B 一次都没跑，它的账本必须还是"未知"——否则两个 Run 会互相污染
    expect(ledgerB?.usage()).toEqual({ inputTokens: null, outputTokens: null });
  });
});

// ---------------------------------------------------------------------------
// 请求的形状：在 provider 收到的那一刻看
// ---------------------------------------------------------------------------

describe("请求真的发出去了什么", () => {
  it("systemPrompt、任务消息与全部工具声明都在请求里", async () => {
    const h = harness();
    h.script(fauxAssistantMessage("好。"));
    await decide(h);

    const context = h.seen.context;
    expect(context).not.toBeNull();
    if (context === null) return;
    expect(context.systemPrompt).toContain("submit_report");
    expect(context.messages[0]?.role).toBe("user");
    expect(context.messages[0]?.role === "user" ? context.messages[0].content : "").toContain(TASK.goal);
    // 工具声明包含真实工具与两个协议工具
    const names = (context.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "list_dir", "search_text"]));
    expect(names).toEqual(expect.arrayContaining([SUBMIT_REPORT_TOOL, ASK_HUMAN_TOOL]));
  });

  it("重试权只在 Runtime：请求里的 maxRetries 恒为 0", async () => {
    const h = harness();
    h.script(fauxAssistantMessage("好。"));
    await decide(h);

    // SDK 自己有客户端重试，但重试策略属于 Runtime（要按归一化的码决定、
    // 要计入预算、要写进事件流）。两处都重试就有一个没人数得清的账。
    expect(h.seen.options?.maxRetries).toBe(0);
    expect(h.seen.options?.signal).toBeDefined();
  });

  it("第二轮请求带着第一轮的工具结果，且结果挂在它对应的调用上", async () => {
    const h = harness();
    h.script(fauxAssistantMessage(fauxToolCall("read_file", { path: "package.json" })));
    const first = await decide(h);
    if (!first.ok || first.decision.kind !== "call_tool") throw new Error("第一轮应当是一次工具调用");

    // 按 Core 的方式推进：一次调用在 transcript 里是两条消息
    const state: AgentState = {
      task: TASK,
      transcript: [
        { role: "assistant", decision: { kind: "call_tool", intent: first.decision.intent } },
        {
          role: "tool",
          intent: first.decision.intent,
          observation: {
            tool: "read_file",
            value: { path: "package.json", lines: [{ n: 1, text: "{}" }] },
            error: null,
            truncated: false,
            provenance: { source: "read_file", at: 1_700_000_000_000 },
          },
        },
      ],
      iteration: 1,
      pendingQuestion: null,
    };

    h.script(fauxAssistantMessage("读到了。"));
    await decide(h, state);

    const context = h.seen.context;
    if (context === null) throw new Error("应当截到一次请求");
    const assistant = context.messages.find((m) => m.role === "assistant");
    const results = context.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    // 结果必须挂回那次调用，否则 provider 会收到一个悬空的 tool call
    expect(results[0]?.role === "toolResult" ? results[0].toolCallId : "").toBe(
      assistant?.role === "assistant" ? assistant.content[0]?.type === "toolCall" ? assistant.content[0].id : "" : "",
    );
    expect(results[0]?.role === "toolResult" ? results[0].toolName : "").toBe("read_file");
  });
});

// ---------------------------------------------------------------------------
// 边界：协议工具的身份
// ---------------------------------------------------------------------------

describe("协议工具的身份", () => {
  it("它们不在 ToolPort 的名单里：模型能决定收工，但收工不是一次工具执行", () => {
    const h = harness();
    expect(h.catalog.repoNames).toEqual(["read_file", "list_dir", "search_text"]);
    expect(h.catalog.allNames).toEqual(expect.arrayContaining([SUBMIT_REPORT_TOOL, ASK_HUMAN_TOOL]));
    expect(h.catalog.repoNames).not.toContain(SUBMIT_REPORT_TOOL);
    expect(h.catalog.repoNames).not.toContain(ASK_HUMAN_TOOL);
    // 两个协议工具的 kind 都是 terminal：适配器消费，执行层看不见
    expect(h.catalog.entry(SUBMIT_REPORT_TOOL)?.kind).toBe("terminal");
    expect(h.catalog.entry(ASK_HUMAN_TOOL)?.kind).toBe("terminal");
    expect(h.catalog.entry("read_file")?.kind).toBe("repo");
  });
});
