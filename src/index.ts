// Public entry point. Filled in by the steps that follow:
//   step 2 -> Agent Core domain types   (done, type-only)
//   step 3 -> the minimal loop          (done: the package's first runtime code)
//   step 4 -> Agent Runtime             (done: one Task becomes an event stream)
//   step 5 -> budget & cancellation     (done: runs stop predictably)
//   step 6 -> tool execution layer      (done: untrusted output, isolated failures)
//   step 7 -> durability & replay       (done: the log is the truth, replay is idempotent)
//   step 8 -> Pi Agent SDK adapter      (done: the SDK lives behind the ports)
//
// 词汇是 `export type`：类型在编译后被完全擦除。
// 步 3 之后这里开始导出真实运行时代码——先是 Core 的循环，再是驱动它的 Runtime、
// 让 Run 停得下来的那一层、把不可信的工具调用变成可信观测的执行层、
// 从事件重建状态的回放、让事件活下来的存储，最后是**唯一**碰 SDK 的那一层。
//
// 步 8 的分界线在这里看得很清楚：上面每一条都是零依赖的（Core / Runtime / 执行层 /
// 回放 / 存储，测试守着这条），而 `src/adapter` 是 SDK 的唯一住所。所以下面这一段
// 可以整段删掉，包仍然编译、仍然跑得完假模型——这正是"SDK 可替换"的可执行含义。
//
// 工具写在 `src/tools`，而且**不属于适配器**：它只有纯 JSON Schema 与 `ToolPort`
// 实现，一行 SDK import 都没有（步 8 修正了步 6 的一条预测，见 docs/08 决定 10）。

export type {
  // material and provenance
  Provenance,
  Evidence,
  MaterialRef,
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
  // usage
  ModelUsage,
  ModelUsageLedger,
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

// 用量账目的算术。它在 Core 里，因为 `ModelUsage` 是 Core 的类型——
// 而"`null` 不是加法单位元"这条规则只该有**一份**（步 8 在适配器与假模型里
// 各写一次，于是账本永远是未知；见 `docs/08` 决定 6）。
export { UsageAccumulator, addUsage, unknownUsage } from "./core/usage.js";

// 脱敏：一条"我们自己的凭据不进证据"的规矩。纯函数，规则只有一份——
// 适配器用它洗掉 provider 回显的报错原文，CLI 用它洗掉每一行输出。
export { REDACTED, redactText, redactValue, redactor, secretsFromEnv } from "./core/redact.js";

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
export { assertContiguousPrefix } from "./runtime/replay.js";

// trace：同一份日志的第三种看法（前两种是状态与位置）。它回答
// "调用了什么 / 为什么停 / 花了多少"，而这三个答案**全部来自事件本身**——
// token 数不重算、工具次数不重数，免得变成第二份会分叉的真相。
export { traceOf } from "./runtime/trace.js";
export type { RunTrace, TraceStep, TraceStop, TraceUsage } from "./runtime/trace.js";

// 证据核对：把"每条论断都指向证据"从一句要求变成一件**可检查**的事。
// 它只判断"这些行我们真的看到过吗"（可确定），不判断"结论对不对"（需要另一个模型）。
export { auditReport, auditRun } from "./runtime/verify.js";
export type { EvidenceAudit, MaterialReader } from "./runtime/verify.js";

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

// 重试政策：只认**已经归一过**的 `RunErrorCode`，一行 provider 词汇都没有。
// 它属于 Runtime，因为"这个错误值不值得重发"是政策，而"这个错误是什么意思"
// 是适配器的事——两个所有者，两张表，各自由 `satisfies` 钉住。
export { DEFAULT_RETRY, isRetryable, retryDelayMs, retryPolicyFrom, shouldRetry } from "./runtime/retry.js";
export type { RetryPolicy } from "./runtime/retry.js";

// 真实工具：读仓库。**不是**适配器的一部分——它们只认 `ToolPort` 与纯 JSON Schema，
// 所以"工具的知识"与"SDK 的词汇"在这里是分开的两件事。
export {
  ToolArgumentError,
  createRepoTools,
  declaredKeysOf,
  materialReader,
  resolveInsideRepo,
} from "./tools/repo-tools.js";
export type { JsonObjectSchema, ToolSpec, Toolbox } from "./tools/repo-tools.js";

// ---------------------------------------------------------------------------
// 产品面：一个人怎么发起一次 Run、又怎么看懂它。
//
// 它是唯一允许碰 `node:process` 的一层，而且**碰得很少**——`main(argv, io)`
// 自己是一个纯函数（输入参数与 IO，输出退出码），`runCli()` 才是真入口。
// 这是"Core 能没有进程地跑完"这条不变量在产品层最后一次被遵守。
// ---------------------------------------------------------------------------

export { EXIT, HELP, main, runCli } from "./cli/index.js";
export type { CliIo, ExitCode } from "./cli/index.js";
export { flagOn, flagValue, flagsMissingValue, parseArgs, unknownFlags } from "./cli/args.js";
export type { ParseOptions, ParsedArgs } from "./cli/args.js";
export {
  REDACTION_NOTICE,
  auditLines,
  clip,
  exitLine,
  progressLine,
  reportLines,
  rule,
  stopLine,
  traceLines,
} from "./cli/render.js";

// ---------------------------------------------------------------------------
// 下面这一段是 SDK 的唯一住所。删掉整个 `src/adapter`，包仍然编译、仍然跑得完假模型
// （`test/no-runtime-deps.test.ts` 守着这条）。
//
// 纯映射层（错误归一 / 终止协议 / 决策解码 / 对话翻译 / 工具目录）与两个端口的
// 生产实现都在这一侧，外加"模型从哪来"的两条路：真实 provider 目录的解析，
// 以及一个**离线 provider**——它让整条真通道可以在没有凭据的机器上被跑一遍。
// `usageFromMessage` 是这里唯一没有再导出的用量函数（算术在 Core，见上）。
// ---------------------------------------------------------------------------

export {
  ASK_HUMAN_TOOL,
  SUBMIT_REPORT_TOOL,
  TERMINAL_TOOL_NAMES,
  AdapterError,
  adapterError,
  assertNoTerminalCollision,
  buildRequest,
  buildSystemPrompt,
  catalogFromToolbox,
  catalogOf,
  createEnvModels,
  decideFromMessage,
  envModelIdentity,
  isTerminalTool,
  offlineProvider,
  parseModelSpec,
  piModelAdapter,
  piToolDefinitions,
  providerFailureFromStopReason,
  providerFailureFromThrow,
  readQuestion,
  readReport,
  renderObservationText,
  resolveProviderModel,
  taskFacingContext,
  textOf,
  toolCallsOf,
  usageFromMessage,
} from "./adapter/pi/index.js";
export type {
  BuildRequestOptions,
  CatalogEntry,
  ModelResolution,
  ModelSpec,
  OfflineProvider,
  OfflineProviderOptions,
  PiModelAdapterOptions,
  PiToolBridgeOptions,
  ProviderFailure,
  ProviderIdentity,
  ProviderRequest,
  ResolvedModel,
  ToolCatalog,
} from "./adapter/pi/index.js";
