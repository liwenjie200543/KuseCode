/**
 * Pi Agent SDK 适配器。
 *
 * 这个目录是**唯一**允许 import SDK 的地方。`src/core` 与 `src/runtime` 一行
 * SDK 也不许有——那不只是风格，它是"SDK 可替换"这句话的唯一可执行证据：
 * `test/no-runtime-deps.test.ts` 会扫描这两个目录的 import。
 *
 * 边界一句话说清：**Core 与 Runtime 定义语义，这个目录翻译说法。**
 * 它自己没有任何业务判断——决定权在 Core（什么是合法决策）、Runtime（怎么发生、
 * 什么时候停）。这里只做两件事：把我们的状态翻成 provider 的请求，
 * 把 provider 的回复翻成我们的决策与账目。
 *
 * 六个出口，分别对应 `docs/08-pi-adapter.md` 里那张映射表的六行。
 */

export { piModelAdapter, envModelIdentity } from "./model.js";
export type { PiModelAdapterOptions } from "./model.js";

export { piToolDefinitions } from "./tools.js";
export type { PiToolBridgeOptions } from "./tools.js";

export { catalogFromToolbox, catalogOf, assertNoTerminalCollision } from "./catalog.js";
export type { CatalogEntry, ToolCatalog } from "./catalog.js";

export {
  ASK_HUMAN_TOOL,
  SUBMIT_REPORT_TOOL,
  TERMINAL_TOOLS,
  TERMINAL_TOOL_NAMES,
  askHumanSchema,
  isTerminalTool,
  readQuestion,
  readReport,
  submitReportSchema,
} from "./protocol.js";

export {
  AdapterError,
  adapterError,
  providerFailureFromStopReason,
  providerFailureFromThrow,
} from "./errors.js";
export type { ProviderFailure } from "./errors.js";

export { decideFromMessage, textOf, toolCallsOf } from "./decision.js";
export type { DecodeOptions } from "./decision.js";

export { buildRequest, buildSystemPrompt, renderObservationText, taskFacingContext } from "./history.js";
export type { BuildRequestOptions, ProviderIdentity, ProviderRequest } from "./history.js";

export { addUsage, unknownUsage, usageFromMessage } from "./usage.js";
