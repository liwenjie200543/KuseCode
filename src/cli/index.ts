/**
 * CLI 的出口。
 *
 * 它导出两类东西，而这两类东西的用途完全不同：
 *
 * - **`main` + `CliIo`**：一个把「参数 + IO」变成退出码的函数。测试用它，
 *   嵌入方也可以用它（比如把 CLI 挂到别的入口后面）。
 * - **`runCli`**：真入口，唯一碰 `process` 的地方。`bin/kuse.mjs` 调它。
 */

export { EXIT, HELP, flagOn, flagValue, parseArgs, unknownFlags } from "./args.js";
export type { ExitCode, ParsedArgs } from "./args.js";
export { main, runCli } from "./main.js";
export type { CliIo } from "./main.js";
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
} from "./render.js";
