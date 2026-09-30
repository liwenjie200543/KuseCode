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

## Phase 8 ✅ MCP
- [x] 依赖 + `@modelcontextprotocol/sdk`；mcp/index.ts：并行连接（超时）→ listTools →
  薄适配进 registry（JSON Schema 透传、撞名才加 `<server>_<tool>` 前缀）→ 状态记录 →
  干净关闭；单点故障只记录不致命
- [x] fixture：真 stdio echo server + 单测 3 例（连接调用/单点故障/命名规则）

## Phase 9 ✅ Sub-Agent
- [x] agents/manager.ts：worker 复用同一个 Agent 类 + 只读工具子集 + 独立
  transcript/abort；spawn 返回快照（内部状态可变、对调用方只读）
- [x] spawn_agent/list_agents/wait_agent/close_agent 四工具 + 并发上限 3 +
  重名/未知名拒绝 + 单测 4 例

## Phase 10 ✅ Reliable Runtime（收敛）
- [x] 最终形态：runtime/log.ts（事件日志）+ runtime/trace.ts（三问投影）+
  runtime/recovery.ts（unfinished 检测，cwd 匹配）+ session/resume（replay）
  ——四个能力合计 ~230 行，无多余抽象
- [x] 单测 3 例（finished/unfinished 判定、cwd 匹配、continue 后 finished）
- 实施决定：replay 直接由会话 JSONL 承担（resume 只读加载），不另设 replay 模块

## Phase 11 ✅ TUI
- [x] tui/index.ts：readline 交互会话——工具活动实时打印、confirm 询问
  （a/A/d 内联回答）、/help /new /sessions /resume /exit、持久化失败不中断
- 实施决定：v1 用 node 内置 readline 而非 pi-tui 组件系统——Editor 强制
  完整主题对象，为这个 v1 引入整套主题实现不成比例（goals §三）。
  "零 Agent 逻辑"与全部六项职责保持不变；pi-tui 依赖移除。

## Phase 12 ✅ CLI
- [x] cli/main.ts：交互（无参数）/一次性（-p）/continue/sessions 四种模式 +
  --model/--repo/--data/--permission-mode；headless 默认拒绝 confirm；
  事件与消息分离落盘（events/<id>.jsonl 与 sessions/<id>.jsonl）

## Phase 13 ✅ E2E Harness
- [x] test/e2e-harness.test.ts：mock 剧本（bash→read→edit→bash）驱动真实
  bootstrap+工具+日志，修复故意写坏的 calc.js
- [x] 断言五条：fixture 修复、回答含 PASS、工具顺序正确、会话文件完整
  （末行可解析）、recovery finished=true（带 FS 时序轮询）

## Phase 14 Final Simplification
- [ ] 全库扫：unused export/dead code/duplicate；能删则删
- [ ] 实测 src 行数 ≤ 4,000 并写入 architecture.md

## Phase 15 README / Documentation
- [ ] README 重写（新定位/快速上手/架构图）；旧 docs 归档
