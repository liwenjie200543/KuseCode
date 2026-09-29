#!/usr/bin/env node
/** `kuse` 可执行入口：唯一的 process 触点在 src/cli/main.ts 的 runCli 里。 */
import { runCli } from "../dist/cli/main.js";

process.exitCode = await runCli();
