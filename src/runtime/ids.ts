/**
 * 身份 —— Runtime 第一次拥有它。
 *
 * Core 里没有任何 id：`AgentState` 不知道自己是哪次运行的，`ToolIntent` 只有名字和
 * 参数。这不是疏漏，是分工——「这个状态属于哪一次 Run」回答的是「这次运行如何被追踪」，
 * 而不是「一步之后发生什么」。
 *
 * 于是 `runId`、`toolCallId`（以及步 7 的 `sessionId`）在 Runtime 生成，
 * 并且**是可注入的**。
 * 可注入的理由和端口一样：身份的**形状**是契约，生成方式是实现。
 * 生产用 `cryptoIds()`（随机、不可预测），测试与将来的 golden transcripts
 * 用 `sequentialIds()`（确定、可逐字节比对）。换实现时事件流的语义不变——
 * 这正是本仓库对待每一处外部能力的同一条原则，身份也不例外。
 */

/**
 * 身份的生成方式。
 *
 * 三个方法而不是一个 `id(kind)`：调用点写成 `ids.sessionId()` / `ids.runId()` /
 * `ids.toolCallId()`，读代码的人不需要知道有哪些 kind，也不可能拼错字符串。
 *
 * `sessionId` 是步 7 才加进来的，理由不是「忘了」：会话隔离要有 `SessionStore`
 * 才有意义，而会话 id 在没有地方存放它之前只是一个无人使用的字串。
 * 它一落地就在这里生成，因为身份**只有一处**——免得存储自己另造一套 id。
 */
export interface IdFactory {
  /** 一次会话的 id。会话是隔离的单位（两个会话不共享任何状态）。 */
  sessionId(): string;
  /** 一次 Run 的 id。在 `run_started` 之前生成，此后不变。 */
  runId(): string;
  /** 一次工具调用的 id。意图（`ToolIntent`）本身不带 id，配对发生在事件流里。 */
  toolCallId(): string;
}

/**
 * 生产实现：随机 id，取自 WebCrypto（Node ≥ 19 的全局 `crypto`，无需 import）。
 *
 * 前缀（`sess_` / `run_` / `tool_`）不是装饰：事件日志与目录名都是给人看的审计
 * 材料，一个裸 uuid 在 grep 出来的上下文里分不出自己是会话、运行还是工具调用。
 *
 * 注意它**不承诺顺序**，也不承诺可读的递增——那是 `sequentialIds` 的事。
 * 谁要是拿它当排序依据，那是用错了东西：排序依据是 `sequence` 字段。
 */
export function cryptoIds(): IdFactory {
  const uuid = (): string => globalThis.crypto.randomUUID();
  return {
    sessionId: () => `sess_${uuid()}`,
    runId: () => `run_${uuid()}`,
    toolCallId: () => `tool_${uuid()}`,
  };
}

/**
 * 确定性实现：`<prefix>-sess-1`、`<prefix>-run-1`、`<prefix>-tool-1`……
 *
 * 它存在的理由是**断言**：随机 id 让「事件流长什么样」无法逐字节比对，
 * 而 golden transcripts（步 10）与回放（步 7）都需要这件事是可复现的。
 * 它不产生碰撞，因为三个计数器在同一个工厂实例里各自单调递增；
 * 两个工厂实例会撞——所以它不是全局命名空间，是**一个会话/一次 Run 的**命名空间。
 */
export function sequentialIds(prefix = "seq"): IdFactory {
  let sessions = 0;
  let runs = 0;
  let toolCalls = 0;
  return {
    sessionId: () => {
      sessions += 1;
      return `${prefix}-sess-${sessions}`;
    },
    runId: () => {
      runs += 1;
      return `${prefix}-run-${runs}`;
    },
    toolCallId: () => {
      toolCalls += 1;
      return `${prefix}-tool-${toolCalls}`;
    },
  };
}
