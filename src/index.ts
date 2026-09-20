// Public entry point. Filled in by the steps that follow:
//   step 2 -> Agent Core domain types   (done, type-only)
//   step 3 -> the minimal loop          (done: the package's first runtime code)
//   step 4 -> Agent Runtime             (done: one Task becomes an event stream)
//   step 5 -> budget & cancellation     (done: runs stop predictably)
//   step 6 -> tool execution layer      (done: untrusted output, isolated failures)
//   step 7 -> durability & replay       (done: the log is the truth, replay is idempotent)
//
// 词汇是 `export type`：类型在编译后被完全擦除。
// 步 3 之后这里开始导出真实运行时代码——先是 Core 的循环，再是驱动它的 Runtime、
// 让 Run 停得下来的那一层、把不可信的工具调用变成可信观测的执行层，
// 最后是从事件重建状态的回放、以及让事件活下来的存储。
// 仍然没有 SDK；Core / Runtime / 执行层 / 回放全都零 `node:` 引用（测试守着这条），
// 只有 `src/store` 碰磁盘，而它碰的是调用方注入的路径。

export type {
  // material and provenance
  Provenance,
  Evidence,
  // task
  Task,
  // tools
  ToolIntent,
  ToolError,
  ToolOutcome,
  Observation,
  // decision and result
  Claim,
  Report,
  Decision,
  // state
  Message,
  AgentState,
  Context,
  // termination
  RunErrorCode,
  RunOutcome,
  RunStatus,
  Run,
  Session,
  RunBudget,
  // ports
  ModelPort,
  ToolPort,
  // events
  AgentEvent,
  // core and runtime
  AgentCore,
  AgentRuntime,
} from "./core/types.js";

// 循环：一步、一次状态推进、几个谓词，以及驱动方能推的 generator。
export {
  hasProgress,
  isAwaitingHuman,
  isTerminal,
  observationsOf,
  reduce,
  renderContext,
  runCoreLoop,
  step,
} from "./core/loop.js";
export type {
  AssembleObservation,
  LoopDeps,
  LoopTurn,
  TerminalDecision,
} from "./core/loop.js";

// Runtime：把上面的循环翻译成一条有序事件流。
// 身份（runId / toolCallId）、事件日志的契约、终态事件的构造都在这一侧。
export { createRuntime, emptyStateFor, toRunError } from "./runtime/run-agent.js";
export type { CollectMissingMaterial, RunAgentOptions } from "./runtime/run-agent.js";
export { assertAppendOnly, memoryRunLog } from "./runtime/run-log.js";
export type { RunLog } from "./runtime/run-log.js";
export { cryptoIds, sequentialIds } from "./runtime/ids.js";
export type { IdFactory } from "./runtime/ids.js";

// 预算与终止：Core 一行都不知道它们，执法与归因都在这一侧。
// `DEFAULT_BUDGET` 是有界的那个默认值；`RunStoppedError` 是「这次 Run 必须停」
// 穿过端口包装层回到驱动方的形状。
export { DEFAULT_BUDGET, RunStoppedError, createBudgetGuard } from "./runtime/budget.js";
export type {
  BudgetGuard,
  BudgetGuardOptions,
  BudgetStopCode,
  ProgressPredicate,
  RunStop,
} from "./runtime/budget.js";
export { createRunSignal } from "./runtime/termination.js";
export type {
  RunSignal,
  RunSignalOptions,
  TerminationCause,
  TimeoutSignalFactory,
} from "./runtime/termination.js";

// 工具执行层：一次调用要过的八道关，以及 `ToolOutcome → Observation` 唯一发生的地方。
// `createToolRunner` 交出的 `toolDeps()` 是接线用的形状——三个字段一起摊进
// `createRuntime`，少一个都编译不过。
export {
  CALL_TIMEOUT_MS,
  OBSERVATION_CHAR_LIMIT,
  TOOL_ERROR_CODES,
  collectMissingMaterial,
  createToolRunner,
} from "./runtime/tool-runner.js";
export type {
  ToolErrorCode,
  ToolLayerDeps,
  ToolRunner,
  ToolRunnerOptions,
} from "./runtime/tool-runner.js";

// 回放：把一串事件折叠回状态。它没有一行 I/O——**从事件重建状态是语义，
// 事件的载体是存储**。所以它在 runtime 里，而磁盘在下面。
export { isRunOver, isTerminalEvent, replayAgentState, runStatusOf } from "./runtime/replay.js";

// 存储：事件的载体与会话索引。这是 `src/` 下面唯一允许碰 `node:` 的地方。
// `jsonlRunLog` 是 `RunLog` 的生产实现；`createSessionStore` 把「哪些 Run 属于哪个
// 会话、各自的 Task 是什么」记在磁盘上，其余一切都从日志派生。
export { eventsPathFor, jsonlRunLog } from "./store/run-log-jsonl.js";
export type { JsonlRunLogOptions } from "./store/run-log-jsonl.js";
export { createSessionStore } from "./store/session-store.js";
export type {
  RecoveredRun,
  SessionStore,
  SessionStoreOptions,
  StartedRun,
} from "./store/session-store.js";
