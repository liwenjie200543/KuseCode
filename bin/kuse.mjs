#!/usr/bin/env node
/**
 * `kuse` 可真跑的那个入口。
 *
 * 它只有三行，是刻意的：真正的判断在 `src/cli/main.ts` 里，而那里是可以被测试的
 * （它接收注入的 IO）。这一层只负责把真实的进程接到那条通道上，再把退出码交给
 * 操作系统——**它是唯一一处可以把 `process.exit` 写对，也可以把它写错的地方。**
 *
 * 用 `.mjs` 而不是让 `package.json` 的 `bin` 直接指向 `dist/cli/main.js`，理由只有一个：
 * `dist/` 是构建产物（已 gitignore），而 `bin/` 是仓库里一个**稳定的、可审查的**
 * 入口——它告诉你"这个包装出来之后命令长什么样"，即使你还没构建过。
 * 它 import 的是 `dist/`，所以构建仍然是前提（README 的命令一节写了）。
 */

import { runCli } from "../dist/cli/main.js";

process.exitCode = await runCli();
