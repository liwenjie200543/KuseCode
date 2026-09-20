// Public entry point. Filled in by the steps that follow:
//   step 2 -> Agent Core domain types   (done, type-only)
//   step 3 -> the minimal loop          (done: the package's first runtime code)
//   step 4 -> Agent Runtime             (done: one Task becomes an event stream)
//   step 5 -> budget & cancellation     (done: runs stop predictably)
//   step 6 -> tool execution layer      (done: untrusted output, isolated failures)
//
// 词汇是 `export type`：类型在编译后被完全擦除。
// 步 3 之后这里开始导出真实运行时代码——先是 Core 的循环，再是驱动它的 Runtime、
// 让 Run 停得下来的那一层，最后是把不可信的工具调用变成可信观测的执行层。
// 仍然没有任何 SDK、进程、网络或存储：Runtime 的事件落在注入的 `RunLog` 上，
// 内存实现由调用方自己建（`memoryRunLog()`）。

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
