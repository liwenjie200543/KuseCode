/**
 * Agent Core 的全部词汇。
 *
 * 这个文件没有 import，而且是刻意的：没有 SDK、没有 Node 内置模块、没有任何 I/O。
 * `test/core-types.test.ts` 会强制这条约束，所以它是可执行的契约，不是口头约定。
 *
 * 这里每个类型只回答一个问题：**一次 Run 要成立，什么必须为真？**
 * 凡是回答"这次 Run 怎么发生、怎么活下来"的（身份、顺序、调度、持久化），
 * 都是 Runtime 的词汇，放在 `src/runtime/`。
 *
 * 约定：用 `| null` 而不是 `?` 表示"这个事实不存在"。
 * 因为 `exactOptionalPropertyTypes` 下二者语义不同——"字段没被设置"与
 * "字段被显式设为空"是两件事，而"这个文件没有行号"属于后者。
 */

// ---------------------------------------------------------------------------
// 材料与来源
// ---------------------------------------------------------------------------

/**
 * 一条材料的来源与时刻。
 *
 * 它存在的理由是一个已记录的真实缺口：工具链结果曾经不带 provenance，
 * 导致评测里 provenance_presence 为 0、结论无法核对。
 * 所以来源不是可选的装饰，它是证据能不能被采信的前提。
 */
export interface Provenance {
  /** 材料来自哪里：工具名、文件路径，或 "user"。 */
  readonly source: string;
  /** 得到它的时刻（epoch ms）。回放时必须沿用原值，不得重新取时间。 */
  readonly at: number;
}

/**
 * 一条可核对的证据：**论断的最小单位**。
 *
 * 它把"结论"约束成"指向某个文件某几行"。没有这个类型，
 * "每条论断必须能追溯到证据"就只是一句无法执行的愿望。
 */
export interface Evidence {
  /** 文件路径，相对于 repoRoot。 */
  readonly path: string;
  /** 行号区间 [起, 止]（含两端）；整文件级证据时为 null。 */
  readonly lines: readonly [number, number] | null;
  /** 被引用的原文片段。 */
  readonly excerpt: string;
  readonly provenance: Provenance;
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

/**
 * 用户真正想要的东西，加上它必须收到的材料。
 *
 * 这是推导链的起点：不是"一个 prompt 字符串"，而是
 * 「给定什么材料 → 想要什么决策 → Agent 有用的判据是什么」。
 */
export interface Task {
  readonly id: string;
  /** 用户想知道什么（自然语言）。 */
  readonly goal: string;
  /** 材料在哪：本地仓库根目录。 */
  readonly repoRoot: string;
  /** 必须覆盖的检查维度；Agent 要逐条给出结论或显式报告缺失。 */
  readonly checks: readonly string[];
}

// ---------------------------------------------------------------------------
// 工具：意图、结果、观测
// ---------------------------------------------------------------------------

/** 模型想调用的工具及其参数。参数是不可信输入，执行前必须校验。 */
export interface ToolIntent {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** 工具失败的类型化描述。 */
export interface ToolError {
  readonly code: string;
  readonly message: string;
}

/**
 * 工具返回给 Runtime 的**原始**结果。
 *
 * 注意它故意不包含 provenance、也不包含 truncated：
 * 工具输出是不可信输入，如果允许工具自己填这些字段，
 * 一个坏工具就能伪造"这条证据来自哪个文件、什么时候取的"。
 * provenance 与 truncated 由 Runtime 组装，工具无法覆盖。
 */
export interface ToolOutcome {
  readonly value: unknown;
  readonly error: ToolError | null;
}

/**
 * Runtime 组装后的观测：进入状态、进入事件日志的那一份。
 *
 * 与 `ToolOutcome` 的差别就是这个类型存在的全部意义——
 * 它是"策略字段只能由 Runtime 写"这条安全默认的落点。
 */
export interface Observation {
  /** 哪个工具产生的。 */
  readonly tool: string;
  readonly value: unknown;
  readonly error: ToolError | null;
  /** 结果是否因超长被截断。截断必须可见，否则会静默丢证据。 */
  readonly truncated: boolean;
  readonly provenance: Provenance;
}

// ---------------------------------------------------------------------------
// 决策与结论
// ---------------------------------------------------------------------------

/**
 * 一条论断。`evidence` 允许为空——**空数组就是"这条我说了但没找到依据"**，
 * 它必须是一个显式、可见的状态，而不是被悄悄省略掉的字段。
 */
export interface Claim {
  readonly text: string;
  readonly evidence: readonly Evidence[];
}

/** Agent 最终要交付的东西。 */
export interface Report {
  readonly summary: string;
  readonly claims: readonly Claim[];
}

/**
 * 循环每一步的产物：模型决定接下来干什么。
 *
 * 只有三种可能，这不是巧合——它正好穷尽了
 * 「自己接着干（调工具）」「干完了（应答）」「干不了，需要人（问人）」。
 */
export type Decision =
  | { readonly kind: "call_tool"; readonly intent: ToolIntent }
  | { readonly kind: "respond"; readonly report: Report }
  | { readonly kind: "ask_human"; readonly question: string };

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/**
 * 对话记录，用 **Core 自己的词汇**表达。
 *
 * 这里刻意不用 `unknown[]`：如果状态里装的是 provider 的消息对象，
 * 那么"模型能看到什么"这件事就由适配器决定了，SDK 的数据形状会顺着
 * 状态渗进 Core。适配器的职责是把这个 union 翻译成 provider 的消息格式，
 * 只是翻译，不是决定。
 */
export type Message =
  | { readonly role: "assistant"; readonly decision: Decision }
  | {
      readonly role: "tool";
      readonly intent: ToolIntent;
      readonly observation: Observation;
    }
  | { readonly role: "human"; readonly answer: string };

/**
 * 一次 Run 的全部状态。
 *
 * 只有一个有序数组 `transcript`——不额外保存一份 observations 投影。
 * 多存一份投影就多一个会在回放时分叉的真相，
 * 而"回放必须重建出完全相同的状态"正是要禁止这件事。
 * 需要观测列表时从 transcript 派生。
 */
export interface AgentState {
  readonly task: Task;
  readonly transcript: readonly Message[];
  /** 已经迭代了几轮，从 0 开始。 */
  readonly iteration: number;
  /** `ask_human` 之后待回答的问题；没有待答时为 null。 */
  readonly pendingQuestion: string | null;
}

/** 模型能看到的东西：状态的**有界投影**，不是状态本身。 */
export interface Context {
  readonly goal: string;
  readonly repoRoot: string;
  readonly checks: readonly string[];
  readonly observations: readonly Observation[];
  /** 当前允许调用的工具名（allowlist）。 */
  readonly availableTools: readonly string[];
  readonly iteration: number;
}

// ---------------------------------------------------------------------------
// 结束方式
// ---------------------------------------------------------------------------

/**
 * 失败的类型化分类。
 *
 * 存在的理由：进程外部的一次失败必须变成一个有类型、可见、可恢复的
 * Run 状态，而不是一个异常。前几个是"我们自己停的"，后四个是"外部让我们停的"。
 *
 * `budget_tokens` 是步 8 加的，而且**只能**在步 8 加：步 5 拒绝提前放了它，
 * 理由是「没有 usage 来源，也没有对应的失败码，硬塞成 budget_iterations 会让
 * trace 说错停止原因」。步 8 带来了真实的 token 账目，于是这个码连同它的执法
 * 一起到期——一次因为 token 花光而停的 Run，现在能说出真正的原因。
 */
export type RunErrorCode =
  | "budget_iterations"
  | "budget_tools"
  | "budget_timeout"
  | "budget_tokens"
  | "no_progress"
  | "rate_limited"
  | "timeout"
  | "auth"
  | "invalid_tool"
  | "provider_unavailable"
  | "runtime_error";

/**
 * 一次 Run 的结论。
 *
 * `partial` 不是失败，是**诚实的成功**：它必须带上 missingMaterial，
 * 说明哪些该拿到却没拿到。有了这个区分，"没找到"就不会被伪装成"没有风险"。
 */
export interface RunOutcome {
  readonly status: "complete" | "partial";
  readonly report: Report;
  readonly missingMaterial: readonly string[];
}

/** Run 的生命周期。终态是 completed / failed / cancelled 三者之一。 */
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface Run {
  readonly runId: string;
  readonly sessionId: string;
  readonly task: Task;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
}

/**
 * 会话。它存在的唯一理由是隔离：
 * 两个 Session 不得共享消息、状态或工具观测。
 */
export interface Session {
  readonly id: string;
  readonly createdAt: number;
  readonly runs: readonly Run[];
}

/** 预算。**Core 永不检查它**，检查发生在 Runtime 每次迭代之前。 */
export interface RunBudget {
  readonly maxIterations: number;
  readonly maxToolCalls: number;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
}

// ---------------------------------------------------------------------------
// 端口：SDK 不得越过的那条线
// ---------------------------------------------------------------------------

/**
 * 模型这一次**花了多少**——token 账目。
 *
 * 它是 provider 唯一知道而别处永远猜不出来的事实，所以它只能由适配器提供。
 * 每一项都允许是 `null`，这不是含糊，而是已记录的真实缺口：deepseek 路径下
 * provider 可能根本不报 usage，那时诚实的答案是"不知道"，不是 `0`
 * （`0` 会让成本报告变成一句谎话）。
 *
 * 注意它**不含** `toolCalls` / `durationMs`：那两样是 Runtime 自己数得出来的，
 * 让适配器去报告只会多出一个会分叉的真相。
 */
export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * 一次 Run 的用量账本。
 *
 * 为什么是"每 Run 领一个"而不是让适配器自己累加：适配器是**跨 Run 复用**的对象，
 * 若用量记在它身上，两个并发的 Run 就会共用一个账本——而"两个 Run 不共享任何账目"
 * 是步 5 定下的不变量。把账本做成一次 Run 的对象，这条不变量就由形状保证，
 * 而不是靠调用方自觉。
 */
export interface ModelUsageLedger {
  /** 累积到此刻的用量。没有任何一次调用报过账时，两项都是 `null`。 */
  usage(): ModelUsage;
}

/**
 * 模型端口。
 *
 * 这是整个架构里最容易被破坏的一条边界：一旦这里出现 SDK 的响应对象，
 * Core 的语义就绑死在某个 provider 上，"换 SDK 不改语义"就无法成立。
 */
export interface ModelPort {
  decide(state: AgentState, signal: AbortSignal): Promise<Decision>;
  /**
   * 开始一个 Run，领一个用量账本。**可选**：不报账的适配器（假模型）不实现它，
   * Runtime 于是记下"这次 Run 的 token 数未知"——而不是记下 `0`。
   *
   * 它拿这次 Run 的信号当身份，而不是自己再发明一个 id：信号本来就是"这一次 Run"
   * 的唯一标识，而且是**同一个对象**——Runtime 交给 `beginRun` 与交给 `decide` 的
   * 是它。于是"哪次调用的用量记在哪个账本上"由对象身份决定，
   * 适配器不需要一个会泄漏、也可能猜错的"当前 Run"状态。
   *
   * 它是步 8 为 `usage_reported` 与 token 预算开的接缝。为什么放在端口上而不是
   * 让调用方把用量回调传两处：账目与端口说的是同一个人（provider）的话，
   * 拆成两条线就会有两份可以不一致的真相。
   */
  beginRun?(signal: AbortSignal): ModelUsageLedger;
}

/**
 * 工具端口。
 *
 * `names` 是 allowlist：模型只能从这里面选，Runtime 也只接受这里面的名字。
 * 工具的完整 schema 与描述属于具体适配器（那是 SDK 形状），Core 只需要名字。
 */
export interface ToolPort {
  readonly names: readonly string[];
  execute(intent: ToolIntent, signal: AbortSignal): Promise<ToolOutcome>;
}

// ---------------------------------------------------------------------------
// 产品级事件：Runtime 对外唯一的契约
// ---------------------------------------------------------------------------

interface EventBase {
  readonly runId: string;
  /** 每个 Run 内单调递增，回放按它排序，必须幂等。 */
  readonly sequence: number;
  readonly timestamp: number;
}

export type AgentEvent =
  | (EventBase & { readonly type: "run_started" })
  | (EventBase & { readonly type: "model_requested"; readonly model: string | null })
  | (EventBase & { readonly type: "decision_made"; readonly decision: Decision })
  | (EventBase & {
      readonly type: "tool_started";
      readonly toolCallId: string;
      readonly toolName: string;
    })
  | (EventBase & {
      readonly type: "tool_completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "success" | "error";
      readonly result: unknown;
      readonly error: ToolError | null;
      readonly durationMs: number;
    })
  | (EventBase & {
      readonly type: "observation_added";
      readonly name: string;
      readonly observation: Observation;
    })
  | (EventBase & {
      readonly type: "human_input_requested";
      readonly question: string;
    })
  | (EventBase & { readonly type: "human_input_received"; readonly input: string })
  | (EventBase & { readonly type: "run_resumed" })
  | (EventBase & {
      readonly type: "usage_reported";
      readonly usage: {
        readonly inputTokens: number | null;
        readonly outputTokens: number | null;
        readonly toolCalls: number;
        readonly durationMs: number;
        readonly model: string | null;
      };
    })
  | (EventBase & {
      readonly type: "run_completed";
      readonly status: "complete" | "partial";
      readonly result: Report;
      readonly missingMaterial: readonly string[];
    })
  | (EventBase & {
      readonly type: "run_failed";
      readonly error: { readonly code: RunErrorCode; readonly message: string };
    })
  | (EventBase & { readonly type: "run_cancelled" });

// ---------------------------------------------------------------------------
// Core 与 Runtime 的对外形状
// ---------------------------------------------------------------------------

/** 一步：给定状态，产出一个决策。不负责循环、不负责预算、不负责持久化。 */
export interface AgentCore {
  step(state: AgentState, signal: AbortSignal): Promise<Decision>;
}

/**
 * 一次 Run 的驱动。
 *
 * 返回的是事件流而不是最终结果：一个 Run 不是一次应答，
 * 而是一串有序、可回放、可审计的事件。
 *
 * 注意这里没有任何 SDK 类型——事件流是产品级契约。
 */
export interface AgentRuntime {
  run(task: Task, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}
