<div align="center">

# KuseCode

**极简 Coding Agent Harness —— 不到 3,000 行 TypeScript，在终端里跑一个能读代码、改代码、也管得住自己的编码代理。**

[![ci](https://github.com/liwenjie200543/KuseCode/actions/workflows/ci.yml/badge.svg)](https://github.com/liwenjie200543/KuseCode/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![Vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)
![src](https://img.shields.io/badge/src-~2.9k%20lines-informational)
![License](https://img.shields.io/badge/license-MIT-yellow.svg)

基于 [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) · 日志是唯一真相 · 策略钩子架构

</div>

---

## 目录

- [它是什么](#它是什么)
- [功能全景](#功能全景)
- [架构](#架构)
- [快速开始](#快速开始)
- [配置](#配置)
- [权限模型](#权限模型)
- [目录结构](#目录结构)
- [测试与 CI](#测试与-ci)
- [文档地图](#文档地图)
- [演进：从第一性原理到极简](#演进从第一性原理到极简)
- [提交约定](#提交约定)
- [License](#license)

## 它是什么

KuseCode 是一个 **minimal coding agent harness**：把一个大模型变成能在仓库里干活的编码代理所需的全部"外壳"——工具、权限、上下文、会话、恢复、TUI——用尽量少的自研代码实现。

它有三个鲜明的工程立场：

1. **循环交给 SDK，差异收敛为四个策略钩子。** Agent Loop（循环、流式、工具分派、schema 校验、中断）直接用 `pi-agent-core`；KuseCode 自研的只是钩进去的策略：`beforeToolCall` → 权限、`afterToolCall` → 截断、`transformContext` → 压缩、`subscribe` → 会话与事件日志。
2. **日志是唯一真相。** 每个会话是一份 append-only JSONL（torn-write 安全）。回放、崩溃恢复、trace（干了什么 / 为什么停 / 花了多少）全部从日志派生，不依赖内存状态。
3. **极简是纪律，不是风格。** 每个模块先问"SDK 是不是已经有了"。config 校验手写零 zod，TUI 用 readline 而非组件库——最终 `src/` 合计约 2.9k 行，装下了下表的全部能力。

> 状态：v0.x，积极开发中。能力矩阵已全部落地（[roadmap](docs/tasks/roadmap.md) Phase 0–12 ✅），E2E harness 与最终瘦身（Phase 13–14）进行中。

## 功能全景

| 能力 | 说明 | 代码落点 |
|---|---|---|
| Agent Loop | `pi-agent-core` 直接装配；循环 / 流式 / 工具分派 / schema 校验 / abort 全部交给 SDK | `src/agent/` |
| 编码工具 ×7 | read / write / edit / bash 复用 SDK 内建工具（`NodeExecutionEnv` 统一路径围栏），grep / find / ls 手写 | `src/tools/` |
| 权限系统 | bash 命令分段分档（safe / confirm / destructive），决策链见[权限模型](#权限模型) | `src/permissions/` |
| 上下文工程 | 单结果截断（头尾保留）+ token 预算压缩：切点在 user 消息边界、最近 N 轮逐字、更早的走摘要 | `src/context/` |
| 会话持久化 | append-only JSONL，torn-write 安全；create / resume / continue | `src/session/` |
| 事件日志与 trace | 每会话一份事件流；trace 回答三问——干了什么、为什么停、花了多少 | `src/runtime/` |
| 崩溃恢复 | unfinished 会话检测（cwd 匹配）→ 事件回放重建 → continue | `src/runtime/recovery.ts` |
| Skills | 项目级 + 用户级技能发现，清单进系统提示词，`load_skill` 工具按需装载 | `src/skills/` |
| MCP | 多 server 并行连接（超时控制）、JSON Schema 透传、撞名才加 `<server>_<tool>` 前缀、单点故障不致命 | `src/mcp/` |
| 子代理 | spawn / list / wait / close 四工具；worker 复用同一 Agent 类 + 只读工具子集 + 独立 transcript；并发上限 3 | `src/agents/` |
| TUI | readline 交互会话：流式输出、工具活动实时打印、内联 confirm、`/help` `/new` `/sessions` `/resume` `/exit` | `src/tui/` |
| CLI | 交互 / 一次性（`-p`）/ continue / sessions 四种模式，零 Agent 逻辑 | `src/cli/` |
| 模型接入 | `provider/model` 解析（凭据来自环境变量，由 pi-ai provider 体系读取）+ 离线 `mock` 剧本 | `src/model/` |

## 架构

```text
                Agent (pi-agent-core)
                 │  policy hooks: 权限 / 截断 / 压缩 / 订阅
     ┌───────────┼───────────┬───────────┐
     ▼           ▼           ▼           ▼
  tools/    permissions/  context/    session/ + runtime/ (event log)
     ▲                                        │
  skills/  mcp/  agents/              replay / recovery / trace
     └────────────── model/ (provider resolve + mock)
                         │
                 Agent Event Stream
                   ┌────┴────┐
                   ▼         ▼
                 CLI        TUI
```

- **Agent**：`pi-agent-core` 的 `Agent` 类是唯一的循环所有者；策略以钩子注入而非继承，产品面与策略可独立替换。
- **`beforeToolCall` → `permissions/`**：每次工具调用前先过权限决策链。
- **`afterToolCall` → `context/`**：工具输出视为不可信，先截断再进 transcript。
- **`transformContext` → `context/`**：token 超预算时在 user 消息边界压缩。
- **`subscribe` → `session/` + `runtime/`**：消息与事件分离落盘，日志是唯一真相。
- **`skills/`、`mcp/`、`agents/`**：向 `tools/` 注入可扩展能力，对 Agent 透明。
- **CLI / TUI**：两个产品面，只做参数翻译与结果呈现，**零 Agent 逻辑**；装配只有 `src/agent/bootstrap.ts` 一个所有者。

## 快速开始

要求 **Node ≥ 22**。

```bash
git clone https://github.com/liwenjie200543/KuseCode.git
cd KuseCode
npm ci
npm run build          # CLI（bin/kuse.mjs）加载 dist/，先构建
```

零凭据冒烟——`mock` 是脚本化的离线模型，不需要任何 API key 即可跑通完整链路：

```bash
node bin/kuse.mjs -p "介绍一下这个仓库" --model mock
```

四种运行方式：

```bash
node bin/kuse.mjs                                # ① 交互模式：会话、流式输出、/ 命令
node bin/kuse.mjs -p "解释 src/runtime/log.ts"   # ② 一次性执行后退出
node bin/kuse.mjs continue -p "继续，补上测试"    # ③ 恢复同目录最近未完成的会话再执行
node bin/kuse.mjs sessions                       # ④ 列出会话与状态
```

接入真实模型（凭据来自环境变量）：

```bash
node bin/kuse.mjs -p "修复失败的测试" \
  --model <provider/model> \
  --permission-mode auto
```

> 注意：一次性模式（`-p`）是 headless 的，confirm 类操作（write / edit / bash）**默认拒绝**——要么 `--permission-mode auto`，要么用交互模式内联确认。

常用选项：`--model <provider/model|mock>`、`--repo <dir>`、`--data <dir>`（默认 `<repo>/.kusecode/runs`）、`--permission-mode <ask|auto>`。完整说明 `node bin/kuse.mjs help`。

## 配置

四层优先级：**flag > env > file > 默认**。

| 层 | 来源 | 示例 |
|---|---|---|
| 1 | CLI flag | `--model mock`、`--permission-mode auto` |
| 2 | 环境变量 | `KUSECODE_MODEL` |
| 3 | 配置文件 | `<repo>/.kuse/config.json`（可提交进仓库） |
| 4 | 内置默认 | `permissionMode: "ask"`；model 取第一个已配置凭据的 provider |

`.kuse/config.json` 示例（`context` 三键全部可选，值为示意）：

```json
{
  "model": "provider/model",
  "permissionMode": "ask",
  "context": {
    "maxToolResultChars": 20000,
    "compactAboveTokens": 120000,
    "keepRecentMessages": 20
  }
}
```

配置校验是手写的，零依赖：未知键**警告但不失败**（文件要进仓库，容错拼写）；类型错误**启动即失败并指出键名**。

## 权限模型

bash 命令按分段分档：`safe`（只读，直接放行）/ `confirm`（写操作与多数 bash）/ `destructive`（硬拒绝）。每次 confirm 档调用走这条决策链：

```text
硬拒绝 → safe? → 本会话记忆? → auto 模式? → 询问回调 → 安全拒绝
```

- **交互模式**：内联询问，`a` 允许一次 / `A` 本会话总是允许 / `d` 拒绝。
- **headless（`-p`）**：无人在场，默认安全拒绝；CI 与测试场景显式 `--permission-mode auto`。

## 目录结构

```text
src/
├── agent/        723 行   Agent 装配、系统提示词、bootstrap（唯一接线点）
├── tools/        414 行   工具注册表（risk 元数据）+ grep/find/ls + 输出脱敏
├── runtime/      221 行   事件日志 / trace 三问投影 / 崩溃恢复检测
├── agents/       209 行   子代理管理（并发上限 3）
├── cli/          203 行   参数翻译与结果呈现，零 Agent 逻辑
├── permissions/  195 行   风险分类器 + 决策管理器
├── tui/          169 行   readline 交互会话与 / 命令
├── session/      161 行   会话 JSONL：create / resume / continue
├── config/       138 行   四层配置合并（手写校验，零 zod）
├── mcp/          131 行   MCP 连接与工具薄适配
├── context/      125 行   截断与预算压缩
├── model/        118 行   provider/model 解析 + mock
└── skills/        57 行   技能发现与注入
```

合计约 2.9k 行；测试另有 11 个文件、73 个用例。

## 测试与 CI

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc -p tsconfig.build.json
```

测试覆盖的重点不是行数，是**不变量**：权限决策链的每个分支、上下文截断与压缩的切点、事件日志 torn-write 后仍可安全回放、MCP 用真 stdio echo server 做 fixture、子代理并发上限与重名拒绝。GitHub Actions 在每次 push / PR 上跑 `npm ci + typecheck + test`（Node 22）。

## 文档地图

| 文档 | 内容 |
|---|---|
| [`docs/specs/architecture.md`](docs/specs/architecture.md) | 架构主文档：现状审计、目标架构、迁移映射、行数预算 |
| [`docs/specs/*.md`](docs/specs)（10 篇） | 逐能力 Spec + Design + Task 合一：agent / tools / permissions / context / session / skills / mcp / sub-agents / tui |
| [`docs/tasks/roadmap.md`](docs/tasks/roadmap.md) | 15 个 Phase 的进度账本（勾选即事实） |
| [`docs/archive/sdd/`](docs/archive/sdd) | 上一轮 SDD 重构的完整记录（分析 / 规格 / 架构 / 实施计划 / 进度） |
| [`docs/archive/`](docs/archive) | 更早开发序列的逐步推理（历史归档） |

## 演进：从第一性原理到极简

这个仓库的价值不止在最终代码，更在三轮演进都留下了完整记录：

1. **v0 · 第一性原理推导。** 从"仓库问答 Agent"的真实任务出发推导分层：十一步提交序列，每步证明一条断言——无进程、无网络、无数据库也能跑完的纯 Core；append-only 事件日志可幂等回放；预算与取消在每次动作**之前**检查；golden transcripts 双路径字节级对拍，SDK 升级无法悄悄改变语义。
2. **v1 · SDD 规格驱动重构。** 补上底座缺的层：请求级上下文投影、人机回路（挂起 / 应答 / 恢复）、共享装配、工具注册清单化。
3. **v2 · 极简收敛（当前形态）。** 审计发现 9,633 行里大部分在重复实现 SDK 已有的循环与分派。删除自研 Runtime / 适配器 / 端口层，Agent Loop 交给 `pi-agent-core`，自研收敛为四个策略钩子；"日志是唯一真相"作为差异化资产以约 230 行保留。

每一轮"为什么这么改、为什么敢删"的取舍都写在 [`docs/`](docs) 里。

## 提交约定

```text
type(scope):一句话说明这次改动

type    feat | fix | refactor | test | docs | chore | perf
scope   core | runtime | adapter | product | repo | test | docs | ci
```

例：

```text
feat(core):Task 与 Decision 类型落地，Observation 强制携带 provenance
fix(runtime):事件回放时 human_input_received 重复注入导致 state 漂移
```

标题行之后空一行，正文写**这次改动落实了哪条第一性原理决策**；再空一段写
`验证：` 与 `局限：`。标题行不要写"修了个 bug"，要写清楚改了什么语义。

## License

MIT
