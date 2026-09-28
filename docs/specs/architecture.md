# Minimal Coding Agent Harness — 架构规格（Phase 0 审计 + 目标架构）

> 状态：已批准（Phase 0 产出）。本文件是这次重构的主文档：现状审计、目标架构、
> 迁移映射、代码量预算。各能力的细节见同目录其余 spec（Spec+Design+Task 合一）。

## 1. 现状审计（2026-09-28，main@959d819）

| 模块 | 行数 | 判定 |
|---|---|---|
| `src/runtime/` | 2,768 | **大部分删除**。run-agent(614)/budget(280)/tool-runner(518)/retry/termination/ids 是自研事件溯源 Runtime；保留的能力（事件日志/回放/恢复/trace）以极简实现并入 `src/runtime/` 新形态 |
| `src/adapter/pi/` | 1,909 | **删除**。它把 Pi SDK 翻译成自研 ModelPort/ToolPort——端口只有一个实现、无可扩展需求，正是"删除 abstraction 直接合并"的对象。改用 `@earendil-works/pi-agent-core` 的 `Agent` 直接装配 |
| `src/core/` | 1,246 | **删除**。loop/reduce/事件词汇/投影随 Runtime 一起退役；`redact.ts`（~160 行）保留并入 tools |
| `src/store/` | 597 | **简化重写**。会话 JSONL（create/resume/continue）+ 事件日志合并为 `src/session/`（~150 行） |
| `src/cli/` | 1,181 | **简化重写**（~180 行）。一次性模式 + 交互循环，零 Agent 逻辑 |
| `src/config/` | 280 | **保留修剪**（~120 行）：四层合并 + 手写守卫，无依赖 |
| `src/bootstrap/` | 334 | **合并**进 `src/agent/`（装配只有 agent 一个所有者） |
| `src/tools/` + `toolbox.ts` | 663 | **重写扩展**：3 个只读工具 → 7 个 coding 工具（read/write/edit/bash/grep/find/ls），统一 `Tool` 接口 |
| `src/testing/` | 377 | **删除**（假模型端口随端口一起退役）；新测试用脚本化 provider（pi-ai 自带 faux） |
| `desktop/` | 777 | **Phase 2 删除**（独立包 + 依赖链） |
| `test/` | 8,924 | **重写**（~2,500 行）。golden transcripts 钉住的是被退役的旧语义，随语义退休；测试重心转向 harness e2e（TinyCode 样板 + 离线 mock） |
| 合计 src | 9,633 | 目标 **≤ 4,000** |

能力对照（目标=完整 harness）：Agent Loop ✅（SDK）· 7 Coding Tools ➕ · Permission ➕ ·
Context 压缩 ➕ · Session ➕ · Skills ➕ · MCP ➕ · Sub-Agent ➕ · Runtime（日志/回放/恢复/trace）✅保留 ·
TUI ➕ · CLI ✅重写 · Testing ➕重写。Desktop ➖删除。

## 2. 核心决策（为什么敢删）

1. **Agent Loop 交给 SDK**。`pi-agent-core` 的 `Agent` 类提供循环、流式、工具分派、
   schema 校验、abort——这正是当前自研 Runtime 用 ~4,000 行重复实现的东西。
   我们自研的部分收敛为**策略钩子**（TinyCode 模式）：`beforeToolCall`→权限、
   `afterToolCall`→截断、`transformContext`→压缩、`subscribe`→会话/事件日志。
2. **Runtime Reliability 用最少代码保留**。KuseCode 真正的差异化资产是
   "日志是唯一真相"：每个会话一个 append-only JSONL（事件+消息），崩溃安全
   （torn-line 跳过），由此派生 replay（重建 transcript）、recovery（unfinished 检测 + continue）、
   trace（干了什么/为什么停/花了多少）。四者合计目标 ≤ 250 行。
3. **Evidence/verify 与 golden 退休**。证据审计绑定旧的"只读问答"定位；新定位是
   能改代码的 harness。golden 钉住的旧事件语义随 Runtime 退役。这是**有意的行为变化**，
   不是回归——测试体系以新验收观重建（见 tasks/roadmap Phase 13）。
4. **依赖政策**：新增仅 3 个——`pi-agent-core`（loop）、`pi-tui`（TUI）、
   `@modelcontextprotocol/sdk`（MCP）。config 校验继续手写（零 zod）。

## 3. 目标架构

```text
                Agent (pi-agent-core)
                 │  hooks: 权限 / 截断 / 压缩 / 订阅
     ┌───────────┼───────────┬───────────┐
     ▼           ▼           ▼           ▼
  tools/    permissions/  context/    session/ + runtime/(事件日志)
     ▲                                        │
  skills/ mcp/ agents/(子代理)          replay / recovery / trace
     └────────────── model/（provider 解析 + mock）
                          │
                  Agent Event Stream
                    ┌────┴────┐
                    ▼         ▼
                  CLI        TUI (pi-tui)
```

目录与行数预算（合计 ≈ 3,400 + 余量，硬上限 4,000）：

```text
src/
├── agent/        ~260  Agent 装配 + 策略钩子 + 事件记录（含 bootstrap 职责）
├── runtime/      ~250  事件日志 append/read + replay + trace + recovery
├── tools/        ~700  Tool 接口 + registry + read/write/edit/bash/grep/find/ls
├── permissions/  ~230  safe/confirm 风险声明 + allow/ask/deny 决策 + 人工询问
├── context/      ~140  结果截断 + token 估算 + compaction（保护窗口）
├── session/      ~150  JSONL 会话：create/resume/continue（append-only、torn-line 安全）
├── skills/       ~90   .kusecode/skills/*/SKILL.md 发现 + load（渐进披露）
├── mcp/          ~90   stdio server 配置 + MCP SDK 薄适配进 Tool
├── agents/       ~160  只读子代理：spawn/wait，复用 Agent/工具/权限
├── model/        ~110  provider 目录解析（env auth）+ mock 注入
├── config/       ~120  四层合并 + 手写守卫（保留修剪）
├── cli/          ~180  一次性模式 + 交互循环（零 Agent 逻辑）
└── tui/          ~450  pi-tui 组合：transcript/editor/status/permission 对话框
```

## 4. 迁移映射（旧 → 新）

| 旧 | 去向 |
|---|---|
| `adapter/pi`（端口翻译） | 删；`agent/` 直接用 pi-agent-core + pi-ai |
| `core/loop` + `runtime/run-agent` | 删；循环 = SDK `Agent` |
| `runtime/budget` / `retry` / `termination` | 删；SDK 提供 abort；预算由 context 压缩承担（第一版不设独立预算状态机） |
| `runtime/tool-runner`（八道关卡） | 删；参数校验由 SDK schema 承担；路径围栏进 tools/paths |
| `runtime/replay` / `trace` / `store` | 简化并入 `runtime/` + `session/` |
| `tools/repo-tools`（3 只读） | 重写为 7 个 coding 工具；read_file 的证据 material 退休 |
| `toolbox.ts` | 合并为 `tools/registry.ts`（一个 Map，重名即抛） |
| `config/` | 保留修剪；新增 `skills`/`mcpServers`/`permissionMode` 键 |
| `bootstrap/` | 合并为 `agent/bootstrap` |
| `cli/` | 重写；`answer` 语义由"会话 continue"承担 |
| `desktop/` | Phase 2 删除 |
| `core/redact` | 保留 → `tools/redact.ts`（凭据不进输出） |

## 5. Definition of Done（全项目）

- [ ] 能力完整：loop/tools/permission/context/session/skills/mcp/sub-agent/runtime/tui/cli/test（Phase 13 验收）
- [ ] `npm run typecheck && npm test && npm run build` 全绿（Node 22，离线）
- [ ] src ≤ 4,000 行（Phase 14 实测并记录）
- [ ] CLI 与 TUI 均不含 Agent 逻辑（事件流消费）
- [ ] 无 desktop、无未使用抽象、无重复状态
