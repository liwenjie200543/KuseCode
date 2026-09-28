# Task Breakdown：15 个 Phase 的路线图

> 每个 Phase 完成即：Implement → Test → **Simplify** → Verify → commit → push。
> 本文件是唯一的进度账本（勾选即事实）。

## Phase 0 ✅ Repository Audit + Spec + Design + Tasks（本文件与 specs/）

## Phase 1 ✅ Minimal Architecture Spec（= architecture.md，与 Phase 0 合并产出）

## Phase 2 Remove Desktop
- [ ] 删除 `desktop/`、根 README/CI 中的 desktop 引用
- [ ] 全量测试绿 → commit → push

## Phase 3 Simplify Agent Core
- [ ] 依赖：+ `@earendil-works/pi-agent-core`、`pi-tui`（TUI 用，提前一并加）
- [ ] 新建 `src/agent/`（Agent + 钩子 + bootstrap）；删除 `src/core/`、`src/adapter/`、
  `src/runtime/` 旧形态、`src/store/`、`src/testing/`、`toolbox.ts`、旧 `test/`
- [ ] 保留：`core/redact.ts` → `tools/redact.ts`；`config/` 修剪
- [ ] 新增最小单测（agent 冒烟：mock provider 走通 loop + 工具）
- [ ] 验收：typecheck/test/build 绿；src 行数显著下降并记录

## Phase 4 Coding Tools
- [ ] `tools/`：registry + paths + diff + 7 工具 + 单测（每工具 ≥2 例）

## Phase 5 Permission
- [ ] classifier + rules + manager + 单测（硬拒绝不被 auto 覆盖）

## Phase 6 Context + Session
- [ ] ContextManager（截断+压缩）+ SessionManager/Storage + 事件日志 + 单测

## Phase 7 Skills
- [ ] loader + `load_skill` 工具 + 单测

## Phase 8 MCP
- [ ] mcp/index + fixture server + 单测

## Phase 9 Sub-Agent
- [ ] agents/manager + 4 工具 + 上限/只读单测

## Phase 10 Reliable Runtime（收敛）
- [ ] replay/recovery/trace 最终形态确定；删除该 Phase 发现的多余抽象
- [ ] 验收：崩溃安全（torn line）+ unfinished 恢复路径有测试

## Phase 11 TUI
- [ ] tui/ 组合 + 斜杠命令 + pty 冒烟

## Phase 12 CLI
- [ ] cli/：一次性模式（headless 默认拒绝 ASK）+ 交互模式 + 退出码

## Phase 13 E2E Harness
- [ ] mock provider 驱动真 Agent 修 fixture（bash→read→edit→bash→完成）
- [ ] 断言：fixture 测试通过 + 会话文件完整 + 权限路径被走过

## Phase 14 Final Simplification
- [ ] 全库扫：unused export/dead code/duplicate；能删则删
- [ ] 实测 src 行数 ≤ 4,000 并写入 architecture.md

## Phase 15 README / Documentation
- [ ] README 重写（新定位/快速上手/架构图）；旧 docs 归档
