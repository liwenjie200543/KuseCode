// Public entry point. Filled in by the steps that follow:
//   step 2 -> Agent Core domain types   (done)
//   step 3 -> the minimal loop
//   step 4 -> Agent Runtime
//
// 全部是 `export type`：类型在编译后会完全擦除，所以在 Core 成型之前
// 这个包不产生任何运行时代码。这一点由 test/core-types.test.ts 守住。
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
