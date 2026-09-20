// Public entry point. Filled in by the steps that follow:
//   step 2 -> Agent Core domain types   (done, type-only)
//   step 3 -> the minimal loop          (done: the package's first runtime code)
//   step 4 -> Agent Runtime
//
// 词汇是 `export type`：类型在编译后被完全擦除。
// 步 3 之后这里开始导出真实运行时代码——只有 Core 的循环，没有任何 SDK、
// 进程、网络或存储。所谓「Core 是纯的」，指的就是这一点。

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
