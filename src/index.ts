/** KuseCode 公共出口。随各 Phase 落地逐步扩充。 */

// Agent Core
export { createKuseAgent } from "./agent/agent.js";
export type { AgentHooks, AgentEventStream, KuseAgent, KuseAgentOptions } from "./agent/agent.js";
export { bootstrapHarness, dataRootFor } from "./agent/bootstrap.js";
export type { Harness, HarnessOptions } from "./agent/bootstrap.js";
export { buildSystemPrompt } from "./agent/prompt.js";

// Runtime Reliability（事件日志 + trace）
export { EventLog, eventLogFor } from "./runtime/log.js";
export type { LogEvent } from "./runtime/log.js";
export { traceOf } from "./runtime/trace.js";
export type { Trace, TraceStep, TraceUsage } from "./runtime/trace.js";

// Model
export { createModelRegistry } from "./model/registry.js";
export type { ModelRegistry, ResolvedModel } from "./model/registry.js";

// Config
export {
  ConfigError,
  configFromEnv,
  defaultConfig,
  mergeConfig,
  parseConfigFile,
} from "./config/schema.js";
export type { DeepPartial, KuseConfig } from "./config/schema.js";

// 凭据脱敏
export { REDACTED, redactText, redactValue, redactor, secretsFromEnv } from "./tools/redact.js";
