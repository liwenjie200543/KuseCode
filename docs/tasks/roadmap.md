# Task Breakdown：15 个 Phase 的路线图

> 每个 Phase 完成即：Implement → Test → **Simplify** → Verify → commit → push。
> 本文件是唯一的进度账本（勾选即事实）。

## Phase 0 ✅ Repository Audit + Spec + Design + Tasks（本文件与 specs/）

## Phase 1 ✅ Minimal Architecture Spec（= architecture.md，与 Phase 0 合并产出）

## Phase 2 Remove Desktop
- [ ] 删除 `desktop/`、根 README/CI 中的 desktop 引用
- [ ] 全量测试绿 → commit → push

## Phase 3 ✅ Simplify Agent Core
- [x] 依赖：+ `@earendil-works/pi-agent-core`、`pi-tui`、`@earendil-works/pi-ai` 升至 0.84.3；- pi-coding-agent
- [x] 新建 `src/agent/`（agent.ts + prompt.ts + bootstrap.ts）；删除 `src/core/`、`src/adapter/`、
  旧 `src/runtime/`、`src/store/`、`src/testing/`、`toolbox.ts`、旧 `test/`（8,924 → 数百行）
- [x] 保留：`core/redact.ts` → `tools/redact.ts`；`config/` 修剪为 model/dataRoot
- [x] 新增单测：agent.test.ts（文本/工具/权限拒绝三路径）+ runtime-log.test.ts（seq 连续/torn write）
- [x] 验收：typecheck/test/build 全绿（34 例）；CLI 离线冒烟通过（mock 回声 + token 账目 +
  事件日志 seq 连续）；src 行数 9,633 → **1,878**
- 修正：run() 返回前 await 全部在途日志写入（调用方读到的日志完整）；mock 注册默认回声剧本

## Phase 4 ✅ Coding Tools
- [x] `tools/`：registry（risk 元数据 + 重名即抛）+ 7 工具 + 单测
- 实施决定：read/write/edit/bash **复用 pi-agent-core 内建工具**（经 NodeExecutionEnv
  适配，围栏住进 env 的 absolutePath/canonicalPath——一处实现管住全部 SDK 工具）；
  grep/find/ls 手写（~150 行）。对比全手写（~700 行）省一半，且 SDK 工具自带
  截断/diff/二进制探测。spec 的"全部手写"按 goals §三"复用 SDK 优先"修正。

## Phase 5 ✅ Permission
- [x] classifier（bash 分段分档：safe/confirm/destructive）+ manager（决策顺序：
  硬拒绝 → safe → remembered → auto → 询问回调 → 安全拒绝）+ 单测 9 例
- [x] 接线：config.permissionMode（ask/auto）+ bootstrap beforeToolCall 钩子 +
  setPermissionPrompt（TUI 对话框 Phase 11 注入；headless 默认拒绝）

## Phase 6 ✅ Context + Session
- [x] ContextManager：单结果截断（头尾保留+标记）+ 预算压缩（chars/4 估算复用 SDK
  estimateTokens；切点在 user 消息边界、最近 N 轮逐字、摘要经注入的 summarizer）
- [x] SessionManager/Storage：append-only JSONL（torn-write 安全）、create/resume/
  continue（cwd 匹配）；标题从首条 user 消息派生（重写 header 会覆盖历史的教训）
- [x] config.context 键 + bootstrap 接线（afterToolCall/transformContext/订阅落盘）
- [x] 单测 8 例（截断/压缩/保护窗口/切点/预算内不压缩/resume/continue/torn write）

## Phase 7 ✅ Skills
- [x] skills/loader.ts：discover 用 SDK `loadSkills`（直接吃 NodeExecutionEnv——零自研
  解析）+ skillsPromptSection（清单只有 name:description）+ `load_skill` 工具
- [x] bootstrap 接线：发现项目级+用户级技能 → 提示词段 + 注册 safe 工具
- [x] 单测 3 例 + CLI 冒烟（技能清单进系统提示词，token 计入）

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
