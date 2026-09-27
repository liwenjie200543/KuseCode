# SDD · Phase 0 — 现状分析：KuseCode vs tinycode

> 本文档是 SDD（Specification-Driven Development）重构流程的第 0 步产出。
> 它只做阅读与分析，不包含任何代码修改建议的最终决定——那些属于 Phase 1 的
> Specification（`02-spec.md`）。
>
> 分析基准：
> - KuseCode `main` @ `849b64c`（17 个 commit，步 1–11 全部落地，工作树干净）
> - tinycode `main` @ 克隆时最新（v1.0.0，115 tests）
> - 验证环境：Windows 11 / Git Bash / Node 22 / TypeScript 5.7

---

## 0. 执行摘要

**KuseCode 不是"一个没写完的 coding agent"，而是一个已经自洽的 Agent 底座**：
它的核心资产是一套可以证明性质的事件溯源 Runtime（append-only 事件日志是唯一真相、
回放幂等、预算与取消执法、工具输出八道关卡、golden transcripts 钉住语义），
产品定位是"证据优先的仓库问答 Agent"（只读，每条论断指向文件 + 行号）。

**tinycode 不是"另一个 Runtime"，而是一个站在 Pi runtime 之上的完整产品 Harness**：
循环、工具调度、流式事件都来自 `@earendil-works/pi-agent-core`，tinycode 自己写的
是策略（权限、上下文工程、会话、技能、MCP、子代理）和交互面（TUI）。

两者的根本差异是**真相模型**（事件溯源 vs 可变转写）与**产品形态**
（可审计的只读问答 vs 可写的对话式通用 harness）。因此本次重构的正确姿势不是
"把 KuseCode 改成 tinycode"，而是：**保留 KuseCode 的事件溯源底座与定位，
从 tinycode 提取它在产品完整度上的工程答案**——上下文分层工程、统一装配层、
统一工具注册表、配置体系——并把它们翻译成与事件溯源兼容的设计。

分析得出 KuseCode 当前最重的三个缺口（详见 §1.8）：

1. **上下文工程缺失**：每轮全量重放 transcript，没有任何压缩/预算保护，
   长任务要么撑爆上下文、要么被 `budget_tokens` 直接停掉（"停"不是"压缩"）。
2. **人机回路半成品**：`ask_human` 有事件、有挂起，但 `human_input_received` /
   `run_resumed` 无法回放（`replay.ts` 显式拒绝），恢复语义不存在。
3. **装配层重复**：CLI `commandRun` 与桌面 `RunService` 各自手接一遍
   toolbox → model → store → runtime 的线（docs/11 自己承认"一比一复刻"），
   没有共享的 bootstrap。

---

## 1. KuseCode 现状分析

### 1.1 项目定位

README 的自我定义非常明确，而且是**推导出来的定位**：

> 给定一个本地代码仓库（材料），用户想要关于它的一个答案（决策/行动）。
> Agent 有用的判据是：答案里每条论断都指向证据——文件路径 + 行号；
> 找不到证据时，明说缺了什么材料，而不是编一个结论。

由此推出：

| 维度 | 现状 |
|---|---|
| 产品形态 | 只读、证据优先的**仓库问答 Agent**（不是代码修改 Agent） |
| 核心资产 | TypeScript Agent Core + Runtime 底座（npm 包名 `ts-agent-runtime`，bin 名 `kuse`） |
| SDK 地位 | Pi Agent SDK（`@earendil-works/pi-coding-agent` / `pi-ai` 0.84.2）**只是端口后面的适配器**，`test/no-runtime-deps.test.ts` 扫描保证 core/runtime 零 SDK import |
| 产品面 | CLI（`kuse run / trace / runs / sessions`，退出码机器可读）+ 桌面壳（Electron 36 + React 18，步 11） |
| 开发方式 | 11 个"步"，每步一个 commit 证明一条第一性原理命题；docs/02–11 每步一篇权威记录 |

### 1.2 技术栈

- TypeScript 5.7（NodeNext ESM，相对导入强制 `.js` 后缀），`exactOptionalPropertyTypes` 等严格项
- Node >= 22，零构建依赖：生产依赖只有 `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent`（0.84.2）
- 测试：vitest 2.1.9；无 lint 脚本（`package.json` 只有 typecheck / test / build）
- 桌面壳：独立包 `desktop/`（electron-vite、Electron 36、React 18），类型-only 共享核心

### 1.3 目录结构

```text
KuseCode/
├── src/
│   ├── core/            # 领域词汇 + 循环语义。零 import（types.ts 一个 import 都没有）
│   │   ├── types.ts     # 438 行：Task/Evidence/Decision/AgentState/AgentEvent/端口/…
│   │   ├── loop.ts      # 268 行：reduce（唯一状态推进函数）、runCoreLoop（generator）
│   │   ├── redact.ts    # 163 行：脱敏（我们自己的凭据），纯函数
│   │   └── usage.ts     # 78 行：用量账目词汇
│   ├── runtime/         # 驱动层：一次 Run 怎么发生、怎么活下来（~2,600 行）
│   │   ├── run-agent.ts     # 614 行：createRuntime，事件 write-ahead 发射
│   │   ├── tool-runner.ts   # 518 行：八道关卡 + collectMissingMaterial（读侧）
│   │   ├── budget.ts        # 280 行：预算守卫（动作前检查点）
│   │   ├── replay.ts        # 263 行：事件 → 状态（回放幂等）
│   │   ├── trace.ts         # 302 行：日志第三投影（what/why/cost）
│   │   ├── verify.ts        # 178 行：证据核对（auditRun）
│   │   ├── retry.ts / termination.ts / ids.ts / run-log.ts
│   ├── adapter/pi/      # 唯一允许 import SDK 的目录（11 文件，~1,620 行）
│   ├── store/           # run-log-jsonl.ts(243) + session-store.ts(354)：契约的持久化载体
│   ├── tools/           # repo-tools.ts(598)：read_file / list_dir / search_text
│   ├── testing/         # fake-model / fake-tools / fake-signals（端口的假件）
│   ├── cli/             # args / main(573) / render：产品面接线
│   └── index.ts         # 纯类型 + 少量值导出
├── test/                # 17 个测试文件 + golden/pinned（8 组 × 3 份固定件）
├── desktop/             # Electron 壳（独立包，RunService 零 electron import）
├── docs/                # 02–11 每步权威记录 + sdd/（本目录）
├── bin/kuse.mjs         # CLI 入口（加载 dist/）
└── examples/end-to-end.mjs
```

规模：`src` 7,385 行 / `test` 9,022 行（含 golden 固定件）/ desktop 494 行。

### 1.4 核心模块与职责

分层（README 定义，代码严格遵守）：

```text
产品面 (CLI / Desktop)
      ↓
Agent Runtime   一次 Run 怎么发生、怎么活下来（身份/顺序/预算/取消/重试/存储/回放/trace）
      ↓
Agent Core      一次有效 Run 意味着什么（纯，零依赖，唯一状态机 reduce）
      ↓
Ports           ModelPort / ToolPort —— SDK 不得越过的线
      ↓
Adapters        Pi Agent SDK / Faux(离线剧本) / Fake(测试)
```

关键模块的事实清单：

| 模块 | 职责 | 值得记录的机制 |
|---|---|---|
| `core/loop.ts` | 循环语义 | `reduce` 是唯一状态推进函数（实时/回放/测试三路共用）；`runCoreLoop` 是 generator，一轮**产出两次**（意图 / 结果），让 `tool_started` 的时间戳是真的；Core 不认识预算 |
| `runtime/run-agent.ts` | 驱动 | 13 种 `AgentEvent`；**write-ahead**：先 `log.append` 再入队送消费者（"日志是唯一真相，事件流是它的投影"）；`emitStop` 的归因顺序：信号 → 守卫 → 任意抛出物；`finally` 给被遗弃的 Run 补终态 |
| `runtime/budget.ts` | 预算执法 | `DEFAULT_BUDGET = {32 轮, 64 次工具, 重试 2, 墙钟 10min, token 上限 null}`；检查点全部在**动作之前**；`no_progress` 判据 = "没有新增观测" |
| `runtime/tool-runner.ts` | 执行层 | 八道关卡（allowlist → 参数 JSON 无损 → 取消 → 超时 60s → 返回值形状 → 返回值无损 → 截断 8k → provenance 写入）；工具失败=数据（Run 继续），只有停止信号原样上抛 |
| `runtime/replay.ts` | 回放 | 穷尽 13 种事件的 switch（新增事件类型会编译失败）；拒绝非连续前缀、双终态、无意图的观测；**显式拒绝** `human_input_received` / `run_resumed`（见 §1.8-P0-2） |
| `runtime/trace.ts` + `verify.ts` | 读侧 | trace 回答 what/why/cost 且不重算任何 Runtime 数过的数；`auditRun` 核对"论断引用的行真的被看到过吗" |
| `adapter/pi/` | 翻译 | 终态决策用两个"终止工具"表达（`submit_report` / `ask_human`，`protocol.ts`），`decision.ts` 把工具调用翻译回 `Decision`；错误映射表在 `errors.ts`；`history.ts` 从 transcript 全量翻译对话（见 §1.8-P0-1） |
| `store/` | 持久化 | `runs/<runId>/events.jsonl` 只追加；换行符 = 记录边界（torn write 处理）；session-store 只存日志答不出来的东西（Task 索引），status 从日志派生 |
| `cli/` | 产品面 | IO 注入（`main(argv, io)` → 退出码），trace/runs/sessions 不加载 SDK（动态 import）；凭据双向脱敏 |
| `desktop/` | 第二产品面 | RunService 复刻 `commandRun` 接线、零 electron import；事件用单通道 + 判别联合推送 |

### 1.5 核心流程

一次 Run 的完整数据流：

```text
Task(goal, repoRoot, checks)
  → emptyStateFor（Runtime 构造初始状态）
  → runCoreLoop(state, {model, tools, assembleObservation}, signal)   [Core generator]
       每轮：
         model.decide(state)                    ← guardedModel 包着：预算检查 →
                                                  emit(model_requested) → 重试循环
         ├─ 终态（respond/ask_human）→ reduce → 返回
         └─ call_tool → yield 意图 → tools.execute（八道关卡）
                        → assembleObservation（截断+provenance 只能这里写）
                        → reduce(state, decision, observation) → yield 结果
  → Runtime 把每个动作翻译成 AgentEvent（先 append 进 JSONL，再送消费者）
  → 终态：run_completed(complete|partial + missingMaterial) / run_failed(code) / run_cancelled
  → 事后（任何时刻、无 SDK）：replay → 状态；runStatusOf → 停在哪；traceOf → what/why/cost；
                             auditRun → 证据核对
```

LLM 请求的构建（`adapter/pi/history.ts`）：

- 任务面（goal/repoRoot/checks/availableTools/iteration）**必须**来自 `renderContext`（Core 的有界投影）；
- 对话面从 `state.transcript` **全量翻译**成 provider 消息（每轮重建，无缓存、无压缩、无 prompt caching 感知）；
- 悬空的 tool call（有意图无结果）补一条诚实的失败工具结果，避免 provider 拒绝请求。

### 1.6 模块依赖关系

```text
core (零依赖)
 ↑        ↑
runtime ──┘            （runtime → core；core 不认识 runtime）
 ↑    ↑    ↑
adapter/pi  tools  testing        （三者都实现 core 的端口；只有 adapter/pi import SDK）
 ↑    ↑
store（实现 runtime 的 RunLog / SessionStore 契约）
 ↑    ↑
cli  desktop（消费 runtime + store + tools + adapter；desktop 经 src/index 引用）
```

- 依赖方向单一向上，无环；`test/core-types.test.ts`、`test/no-runtime-deps.test.ts` 用**可执行断言**钉住"core 零 import"与"runtime 无 SDK"两条边界。
- 契约与载体分离：`RunLog`/`SessionStore` 契约在 runtime，JSONL 实现在 store——换载体不改契约（已被步 7 验证）。

### 1.7 测试现状

实测（本机，2026-09-28）：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 通过 |
| `npm run build` | ✅ 通过 |
| `npx vitest run`（**先 build**） | ✅ **413 个测试全部通过**（1 个跳过项是 `KUSE_RECORD_GOLDEN=1` 才启用的录制测试） |
| `npx vitest run`（**未 build**） | ❌ `test/cli.test.ts` 中 2 个用例 5s 超时失败——CLI 测试经由 `bin/kuse.mjs` 隐式依赖 `dist/` 产物（见 §1.8-P2-1） |

测试资产分层（17 个文件）：

- **单元/契约**：core-types（含编译期证明）、core-loop、redact、budget、tool-runner、trace、verify、repo-tools、runtime-events、replay-idempotence
- **适配器**：pi-adapter（63 例，纯函数映射表逐条验证）、pi-adapter-sdk（17 例，真实 SDK 流 + 脱敏）
- **产品**：cli（42 例，进程内跑完整 `kuse run`）、durable-store
- **Golden transcripts（步 10，最大特色）**：8 组固定件覆盖所有终态（complete / 两种 partial / 失败 / 取消 / 等人）；每组经**两条独立路径**（假模型端口 vs 真 pi-ai 流）驱动，事件日志必须逐字节一致；SDK 路径产物钉在 `test/golden/pinned/`，SDK 升级悄悄改变语义会直接红。录制需显式 `KUSE_RECORD_GOLDEN=1`（"golden 是经审阅的断言，不是缓存"）。

### 1.8 当前存在的问题（按严重度分级）

> 这些是重构需求的主要来源。每条都给出证据位置。

**P0 — 影响核心可用性**

1. **上下文工程缺失，长任务必然触顶**。
   `renderContext` 只约束"任务面字段"，对话面从 `transcript` **全量重放**
   （`adapter/pi/history.ts` 头注释明确记录了这个取舍）。单条观测有 8k 字符截断
   （`tool-runner.ts:58`），但 64 次工具调用 × 8k ≈ 50 万字符 ≈ 12 万+ token；
   没有历史压缩、没有头尾保留、没有 artifact 归档、没有 token 估算。
   token 预算（`budget.ts`）的答案是**停**（`budget_tokens`）而不是**把材料变少**——
   `DEFAULT_BUDGET.maxInputTokens` 默认还是 `null`（不设防）。
   tinycode 的对应答案是完整的分层工程（见 §2.6），这是本次重构最大的缺口。

2. **人机回路只有一半**。
   `ask_human` 决策 → `pendingQuestion` → `human_input_requested` 事件 →
   CLI 以 `awaiting_human` 退出码收场——到这里都是完整的。但
   `human_input_received` / `run_resumed` 两种事件**回放不了**：
   `runtime/replay.ts:88` 的 `unsupported()` 显式抛错，理由是"人的回答怎么进
   transcript 的状态推进还不存在"（`Message` 有 `role:"human"` 变体，
   `reduce` 却没有任何路径能产生它）。挂起后的恢复、交互式应答、
   恢复后继续循环，全部缺席。

**P1 — 影响可维护性与扩展性**

3. **装配层重复**。`cli/main.ts:commandRun` 与 `desktop/run-service.ts` 各自
   手接一遍 toolbox → model 两路 → store.startRun → createRuntime → 事件流；
   docs/11 原话是 RunService "一比一复刻 commandRun 接线"。没有共享的
   bootstrap/装配工厂，第三个产品面（未来任何入口）还得抄第三遍。
   tinycode 的 `bootstrap.ts` 正是这块的答案（§2.4）。

4. **工具词汇分散在三处**。工具本体在 `tools/repo-tools.ts`（`ToolSpec` 含
   schema/parse/run/material），provider 形状翻译在 `adapter/pi/tools.ts` +
   `catalog.ts`，终止工具协议在 `adapter/pi/protocol.ts`。新增一个工具要动
   多处并在 adapter 目录里登记 catalog；core 层只有名字 allowlist，
   没有一个"把工具组装成 toolbox"的统一注册点。

5. **`Message` 的 human 变体与决策协议之间的缝**。`Message.role:"human"` 存在
   但 `reduce` 不产生它——这是 P0-2 的类型层根源；重构恢复语义时必须一并处理。

**P2 — 影响工程质量与体验**

6. **测试对构建产物的隐式依赖**：cli.test.ts 走 `bin/kuse.mjs` → `dist/`，
   没先 build 就超时（本次实测复现）。应在测试脚本/CI 里固化 build 前置，
   或让 CLI 测试直接跑 src。
   > **T2 实施时的修正（2026-09-28）**：实测推翻了这条归因——`test/cli.test.ts`
   > 全部 42 例在进程内直接调 `main(argv, io)`，**完全不经过** `bin/kuse.mjs`
   > 与 `dist/`（`rm -rf dist` 后全绿）。首次全量运行时的 2 例超时真实原因是
   > npm ci 之后冷缓存机器上的资源争用（该次运行的 collect 阶段共 143s）。
   > 处置：给该文件加 30s 用例超时余量（有界），分析结论以本修正为准。
7. **配置体系缺失**：全部配置靠 CLI flag + 环境变量（`KUSECODE_MODEL` 等），
   无配置文件、无 schema 校验；预算默认值硬编码在 `budget.ts`。
   （注：观测截断 8k "故意不做成配置项" 是有文档理由的决定，不应翻案。）
8. **无流式**：`text_delta`/`thinking_delta` 被步 2 有意推迟（"不落库"的立场
   正确），导致 CLI/桌面都没有 token 级实时反馈。是否补、以"不落库的旁路事件"
   补，是 Phase 1 的议题。
9. **包名错位**：npm 包名 `ts-agent-runtime`、bin 名 `kuse`、仓库名 KuseCode
   三者并存。属于改名级整理，不影响架构。
10. **Windows 本地体验**：未 build 时 CLI 测试超时（见 6）；全量测试 ~58s，
    其中 cli.test.ts 占 55s（进程 spawn 慢）。测试分层/超时预算可优化。

### 1.9 当前可以复用的代码（重构中的资产）

**结论：底座全部保留。这次重构是"补层与接线"，不是推翻重写。**

| 资产 | 复用方式 |
|---|---|
| `src/core/**`（类型、reduce、循环、脱敏、用量） | 原样保留；必要时**只增不改**（如恢复语义给 reduce 增加合法路径） |
| `src/runtime/**`（run-agent/budget/retry/termination/replay/trace/verify） | 原样保留；上下文压缩等新策略以"接缝 + 实现"方式加入，不动已有不变量 |
| `src/store/**` | 原样保留（契约-载体分离已验证） |
| `src/tools/repo-tools.ts` | 保留工具实现；`ToolSpec` 形状可能上移为通用注册表词汇（Phase 1 决定） |
| `src/testing/**` | 原样保留，新模块的测试直接复用假件 |
| `src/adapter/pi/**` | 保留；catalog/protocol 的归属可能调整（P1-4） |
| golden transcripts | 语义回归的保险网；任何行为变化都必须先过它 |
| docs/02–11 | 历史决策记录，重构文档引用而不改写 |

### 1.10 需要重构 / 调整 / 删除的内容

- **重构**：上下文构建管线（P0-1）——在"事件溯源不被破坏"的前提下引入
  有界的请求级投影（候选方案：压缩发生在**适配器构建请求时**，transcript 与
  事件日志保持完整真相；细节留给 Phase 1/2）。
- **重构**：装配层（P1-3）——提取共享 bootstrap，CLI 与桌面变成薄壳。
- **重构**：工具注册（P1-4）——统一 toolbox 组装点，core 保持只认名字的边界。
- **补全**：ask_human 恢复语义（P0-2 + P1-5）——事件词汇表与 reduce 需要扩展，
  golden/回放同步演进。
- **补全**：配置层（P2-7）、（可选）流式旁路事件（P2-8）。
- **删除**：目前没有发现需要删除的代码；唯一候选是 CLI/桌面之间重复的
  接线代码（被共享 bootstrap 取代）。

---

## 2. tinycode 分析

### 2.1 项目定位

**教学向的完整 Coding Agent Harness**——"一个下午能读完的编码智能体骨架"，
约 6k 行源码 + 每个子系统一篇 wiki（docs/wiki，27 篇）。它刻意不在功能上与
生产级 agent 竞争，而是让每个子系统都可读：权限、会话、上下文工程、技能、
MCP、子代理、TUI，全部真实可用、全部离线可测。

与 KuseCode 的定位差异一句话说清：**KuseCode 在证明"一次 Run 的性质"，
tinycode 在展示"一个 Agent 的全部零件"**。

### 2.2 技术栈

- TypeScript 5.8（ESM）、Node >= 22.19
- 运行时依赖：`@earendil-works/pi-agent-core` + `pi-ai` + `pi-tui`（^0.84.3，**直接依赖 Pi runtime，不是适配器**）、`@modelcontextprotocol/sdk`、`zod`
- 测试：vitest 3；质量门：eslint 9 + typescript-eslint；`tsx` 开发热载
- CI：Node 22 与 24 双版本

### 2.3 目录结构

```text
tinycode/
├── src/
│   ├── agent/        # runtime.ts(102)：TinyCodeRuntime——Pi Agent + 五个策略钩子
│   │                 # prompt.ts：系统提示词 + TINY.md 项目记忆
│   ├── agents/       # 子代理：manager(149)/worker(65)/tools(95)——只读工人，上限 3
│   ├── bootstrap.ts  # 242 行：把全部子系统装成一个 Harness（TUI 与 -p 共用）
│   ├── cli/          # index(170)/args/commands/sessions：入口与一次性模式
│   ├── config/       # schema(38, zod)/loader(108)：.tinycode/config.json
│   ├── context/      # manager(105)/compact(91)/tool-results：截断+压缩两层
│   ├── mcp/          # client(131)/manager(70)/adapter(58)：stdio MCP 并行接入
│   ├── model/        # registry(133)：provider 目录、auth 解析、mock 注入
│   ├── permissions/  # classifier(113)/rules(110)/manager(161)：三层闸门
│   ├── session/      # manager(105)/storage(93)：JSONL 会话持久化与恢复
│   ├── skills/       # registry(75)/loader(64)：SKILL.md 渐进披露
│   ├── tools/        # 7 个内置工具 + registry + paths（realpath 双侧围栏）+ diff/walk
│   └── tui/          # app(396)/transcript/slash/permission-dialog/…：pi-tui 组合
├── tests/            # 15 个文件，115 测试，全离线
├── fixtures/         # broken-project（e2e 修 bug 对象）、sample-project、mock-mcp
└── docs/             # ARCHITECTURE.md + wiki 27 篇
```

### 2.4 核心模块与装配

`bootstrap.ts` 是理解 tinycode 的钥匙：**一个函数把所有子系统装配成一个
`Harness` 对象**，TUI 与一次性 CLI 都消费它。装配顺序：

```text
ModelRegistry（provider 解析 / mock）→ PermissionManager → ContextManager
→ SkillRegistry.discover → SessionManager → ToolRegistry（7 内置 + load_skill + 4 子代理工具）
→ McpManager.startAll + registerMcpTools → 系统提示词（TINY.md + skills 摘要）
→ TinyCodeRuntime（Pi Agent + 钩子）→ （attach 时）把会话历史灌回 agent.state
```

`agent/runtime.ts`（102 行）本身极薄——它只是给 Pi `Agent` 装上五个策略钩子：

| 钩子 | 装的策略 |
|---|---|
| `streamFn` | 模型注册表的鉴权流式函数 |
| `beforeToolCall` | 权限闸门（可 block 并把理由回给模型） |
| `afterToolCall` | 工具结果截断（上下文卫生） |
| `transformContext` | 每次请求前的自动压缩 |
| `subscribe` | 终态消息逐条落会话文件 |

**循环本身属于 Pi**：流式一个 assistant 回合 → 有工具调用就按 TypeBox schema
校验参数 → 跑钩子 → 执行工具 → 追加结果 → 重复，直到没有工具调用或被中止。
tinycode 的立场写在 ARCHITECTURE.md：*"TinyCode 加进循环的是策略，不是控制流"*。

### 2.5 Agent Loop / Runtime / Tool 的核心设计

- **Loop**：Pi 的 `agentLoop` 拥有停止条件与解析；tinycode 零重推。
  `length` 截断（token 上限切断）会让未完成的工具调用失败而不是拿着截断参数执行。
- **Tool**：统一形状 `AgentTool { name, description, label, parameters(TypeBox), execute }`；
  `execute(toolCallId, params, signal, onUpdate)` 返回 `{ content(给模型), details(给 UI) }`。
  `ToolRegistry` 是唯一命名空间：内置 + MCP + 子代理工具同表注册，重名即抛错。
  七个内置工具都有明确的"行为契约"（wiki 10–13 篇逐个记录）：read 窗口化带行号、
  edit 精确匹配替换带 diff 预览（0 命中/多命中都失败）、bash 超时 + SIGKILL +
  头尾保留 100KB 捕获、路径类工具统一过 `resolveWorkspacePath`（**双侧 realpath
  规范化**，symlink 逃逸被拒）。
- **权限**：三层——`classifier`（shell 按 `&&`/`;`/`|` 分段判 safe/write/destructive，
  未知的动词按 write 处理）→ `rules`（per-tool 默认：项目内读放行、写与项目外读
  必问、bash 走分类器）→ `manager`（评估顺序：硬拒绝规则 → ALLOW → 记住的
  "always"模式 → auto 模式 → 对话框 → 无对话框则安全拒绝）。headless `-p`
  没有对话框，所以 ASK 默认拒绝，自动化必须显式 `--permission-mode auto`。

### 2.6 上下文管理（tinycode 最值得读的部分）

两层策略，全在 `ContextManager`：

1. **每结果截断**（`afterToolCall`）：单条工具结果超过 `maxToolResultChars`
   （默认 30k）→ 头尾保留 + 显式 `[… N characters truncated …]` 标记，
   **全文另存为 artifact 文件**，并在截断文本后附上 artifact 路径——
   "上下文里是摘要，磁盘上有全文"。
2. **预算与压缩**（`transformContext`）：token 估算 ≈ chars/4（确定性、离线）；
   超过 `compactAboveTokens`（默认窗口的 80% 或 100k）就把旧回合替换成一次
   LLM 摘要（包在 `<conversation-summary>` 标签里），最近的 `keepRecentMessages`
   （默认 12）**逐字保留**；切点落在 user 消息边界上，assistant 回合永远不会
   失去自己的工具结果。`/compact` 手动触发同一条路径。

### 2.7 工具调用流程

```text
模型发出 toolCall(id, name, args)
  → pi-ai 按 TypeBox schema 校验参数
  → Agent.beforeToolCall → PermissionManager.check
        allow → 继续；ask → 记住的模式/auto/对话框/安全拒绝；deny → block+理由
  → tool.execute(...)（可中止）
  → Agent.afterToolCall → ContextManager 截断 + artifact 归档
  → ToolResultMessage 进 transcript（同时进会话文件与 UI 事件）
```

错误哲学：`execute` 里抛出的异常变成 `isError` 的工具结果，模型看到的是
一句可读的话（"oldText not found … copy exactly"），永远不是堆栈；
bash 非零退出**不算错误**（stdout/stderr 才是模型要的载荷）。

### 2.8 状态管理

- **活状态**是 Pi `Agent.state`：`messages` 可变数组 + `model` / `tools` /
  `systemPrompt`，`Agent.reset()` 换会话时保留外围配置只清消息。
- **持久状态**是会话 JSONL：`~/.tinycode/sessions/<uuidv7>.jsonl`，首行 header
  （id/cwd/model/createdAt/title），之后一行一条消息；同步追加、从不截断
  （只有 title 会在首个真实 prompt 时重写尚无价值的 header 行）。
- **恢复**：`attach()` 严格只读——把文件里的消息灌回活 transcript 后继续向
  同一文件追加，进程在恢复中途崩溃也不会毁历史；最后一行撕裂（写一半崩溃）
  在加载时跳过。`--continue` 只匹配**同 cwd** 的最近会话。

### 2.9 错误处理

一致的立场是**错误是给模型的反馈，不是进程的结局**：

- 工具异常 → `isError` 工具结果（模型可读、可自我纠正）；
- 权限拒绝 → block + 理由文本回给模型；无对话框时安全拒绝而不是崩溃；
- 持久化失败 → 吞掉但不中断活会话（"persistence must never crash the live session"）;
- MCP 单点故障 → 连接失败只记录状态，不拖垮启动；shutdown 干净关闭无子进程泄漏；
- 压缩摘要失败 → 返回 `(summary failed: …)` 文本，会话继续；
- 缺凭据 → 启动进 MOCK 模式并给出可操作的设置指引，而不是抛错退出。

### 2.10 测试方式

115 个测试，**全部离线**（脚本化 mock 模型，零 API key）：

- **旗舰 e2e**（`tests/harness.e2e.test.ts`）：fixture 项目里有一个故意写错的
  `add()`；mock 模型按剧本驱动**真实** loop 走 `bash → read → edit → bash → 结束`，
  断言 fixture 的测试真的变绿、会话文件完整。这是"装配层全链路"测试。
- 权限加固、工作区边界（symlink 逃逸）、会话生命周期、子代理并发上限、
  skills、config、MCP（起真的 stdio 子进程）、TUI（node-pty 真终端）与 CLI 冒烟。
- 质量门：vitest + `tsc --noEmit` + eslint，CI 在 Node 22/24 跑同一套。

### 2.11 代码组织方式

- 单包单层 `src/<域>/`，没有 core/runtime 的强分层——因为分层职责已经
  交给 Pi（loop）与 tinycode（策略）的分工承担；
- 每个模块一个类/工厂函数，构造参数即依赖注入，没有任何全局单例
  （数据目录经 `TINYCODE_HOME` 可重定向，测试靠它隔离）；
- "新代码超过 ~300 行就该下沉到下一层"是 CONTRIBUTING 立场；
- 文档密度极高：ARCHITECTURE 一张图说清"什么来自 Pi、什么来自 tinycode"。

---

## 3. 架构差异分析（KuseCode vs tinycode）

### 3.1 总览对照表

| 维度 | KuseCode | tinycode |
|---|---|---|
| 定位 | 可证明性质的 Agent **底座**（库 + 两个薄产品面） | 完整可读的 Agent **产品**（Harness） |
| 真相模型 | **append-only 事件日志是唯一真相**；状态 = 回放产物；write-ahead | Pi `Agent.state.messages` 可变数组是活真相；JSONL 是持久化投影 |
| Loop 归属 | **自研** `runCoreLoop`（generator + 唯一 `reduce`，纯函数语义） | Pi `agentLoop`；tinycode 只注入策略钩子 |
| SDK 关系 | Pi SDK = 端口后的**可替换适配器**（有可执行证明） | Pi runtime = **直接依赖**的地基 |
| 事件 | 13 种产品级 `AgentEvent`，先落日志后送消费者（可审计） | Pi `AgentEvent`，UI 导向（message_update/end…），订阅式 |
| 工具 | 3 个只读工具；独立执行层八道关卡；失败=观测，Run 继续 | 7 个可写工具 + skill + MCP + 子代理；注册表统一；失败=isError 结果 |
| 工具 schema | 纯 JSON Schema（工具自带），适配器翻译 | TypeBox（pi-ai 校验） |
| 上下文 | 有界投影（任务面固定六字段）但**对话全量重放，无压缩** | 截断 + artifact 归档 + token 估算 + LLM 摘要压缩 + 保护窗口 |
| 预算 | 迭代/工具次数/重试/墙钟/token，**动作前执法**，超了就停（可审计） | 无运行预算概念；靠上下文策略保持可行 |
| 人机回路 | `ask_human` 是一等事件，但恢复语义缺失 | 持续对话本身即人机回路；权限审批对话框 |
| 权限/安全 | repoRoot 解析围栏 + allowlist + 凭据双向脱敏 | 三层权限 + realpath 双侧围栏 + 硬拒绝规则 |
| 配置 | CLI flag + env，无配置文件 | `.tinycode/config.json`（zod 校验）+ env 分层 |
| 产品面 | CLI（机器可读退出码/trace/runs）+ Electron 桌面 | 交互 TUI + headless `-p` |
| 会话 | Session = Run 的隔离容器；runs/<id>/events.jsonl | 每会话一个 JSONL；--continue/--session//resume |
| 测试 | golden transcripts：双路径逐字节对齐 + 8 终态固定件 | 脚本 mock 驱动真 loop 修真 bug 的 e2e + pty/MCP 集成 |
| 规模 | src 7.4k 行 + test 9.0k 行 | src 4.6k 行 + test 2.4k 行 |
| 依赖哲学 | 生产依赖 2 个（都是 Pi，都关在 adapter 里） | 生产依赖 5 个（3 个 Pi 直接用 + MCP SDK + zod） |

### 3.2 五个根本差异（展开）

**差异 1：真相模型——这是所有其他差异的根源。**
KuseCode 把"一次 Run"定义为一串有序事件，状态只是回放；于是它免费得到
审计（trace）、恢复（status from log）、语义钉死（golden）。代价是：任何
"悄悄改历史"的便利（原地压缩、可变消息）都与它冲突——这直接决定了
tinycode 的上下文压缩**不能照搬**，必须翻译成"请求级投影"（见 §3.4）。
tinycode 把活状态交给 Pi 的可变数组，代价是：运行历史不可重建、不可审计，
但它本来就不背"证明性质"的包袱。

**差异 2：控制流的所有权。**
KuseCode 自持循环，预算/取消/事件顺序都是自己语义的一部分；tinycode 把
控制流外包给 Pi，自己只做策略。前者换 SDK 自由但每个机制都要自己造并证明；
后者开发效率高但语义受制于库的形状。**KuseCode 没有理由放弃这一点**——
它是项目的立身之本（"删掉 adapter 包仍然跑得完"是步 8 的命题）。

**差异 3：产品完整度的代差。**
tinycode 有装配工厂、配置层、上下文工程、权限、会话恢复、TUI；
KuseCode 有可审计的底座但产品层薄。KuseCode 的 README 说得诚实：
"当前阶段在构建它的底座"。本次重构的实质就是**把底座上面缺的几层补上**，
而 tinycode 恰好是这几层的最佳参考实现。

**差异 4：上下文策略。**
KuseCode 唯一的手段是"单条截断 8k + 超预算就停"；tinycode 是四层
（截断 → 归档 → 估算 → 摘要压缩 + 保护窗口）。在事件溯源前提下，
KuseCode 的正确吸收方式是**把压缩放在请求构建投影层**而不是状态层。

**差异 5：测试哲学——互补而非优劣。**
golden transcripts 钉的是"语义不许悄悄变"（供应商升级防护），
tinycode 的 harness e2e 钉的是"装配层全链路真的能干活"。
KuseCode 有前者缺后者（cli.test 是接线测试但不是"修真 bug"的任务级 e2e）。

### 3.3 tinycode 值得借鉴的设计（候选清单，取舍在 Phase 1 落定）

每条按"tinycode 的做法 → KuseCode 为什么需要 → 预期的调整"记录：

1. **上下文分层工程**（截断+artifact+估算+压缩+保护窗口）
   → KuseCode 长任务必然触顶（§1.8-P0-1），这是本次重构第一优先级。
   → 调整：压缩必须是**请求级投影**（不碰 transcript/事件日志），"保护窗口"
   对应"保护最近 N 条消息 + 全部 human 消息"；token 估算保持离线确定性；
   artifact 归档与 store 的目录布局要对齐（runs 目录的 ignore 规则要涵盖它）。
2. **共享 bootstrap / Harness 装配**（`bootstrap.ts`）
   → KuseCode 的 CLI 与桌面重复接线（§1.8-P1-1），第三产品面会出现。
   → 调整：装配产物暴露的是 Runtime 词汇（端口/工厂），不是 tinycode 那种
   直接暴露 `agent.state` 的可变对象；装配层放在与 core/runtime 平级的新模块。
3. **统一工具注册表 + 工具自包含**（`ToolRegistry` + `AgentTool` 形状）
   → KuseCode 工具词汇分散三处（§1.8-P1-4）。
   → 调整：core 仍只认名字（不破坏"core 不知道 schema"的边界），注册表住在
   工具侧（tools/ 或新的 toolbox 模块），把 spec/schema/material/catalog 的
   组装收拢到一个点；adapter 只做 provider 形状翻译。
4. **配置体系**（config.json + zod 分层 + env 覆盖 + 数据目录可重定向）
   → KuseCode 只有 flag/env（§1.8-P2-7）。
   → 调整：体量保持极小（tinycode 的 config 层只有 ~150 行）；是否引入 zod
   或手写校验由 Phase 1 按依赖哲学决定（KuseCode 目前生产依赖只有 Pi）。
5. **会话恢复的安全细节**（attach 只读、torn line 跳过、title 延迟写）
   → KuseCode 的 store 已有 torn-write 处理，但没有"恢复一个挂起 Run"的
   消费路径——这正好与 §1.8-P0-2（ask_human 恢复）是同一块工作。
6. **任务级 e2e 测试风格**（mock 驱动真 loop 修真 bug）
   → KuseCode 缺一条"装配层全链路 + 任务完成判据"的测试；
   golden 钉语义，e2e 钉功能，两者互补。
7. **错误即反馈的措辞纪律**（模型可读的一句话，不吐堆栈）
   → KuseCode 的 tool-runner 已有同款纪律（错误码 + 中文理由），
   借鉴点主要在未来新工具上保持一致。

### 3.4 tinycode 不适合照搬的部分（及原因）

| tinycode 做法 | 不照搬的原因 |
|---|---|
| 可变 `agent.state.messages` 作为活真相 | 与事件溯源哲学正面冲突；KuseCode 的回放/审计/trace 全建立在不可变历史上 |
| Pi `pi-tui` 交互 TUI | KuseCode 的产品面是 CLI + 桌面壳；引入 TUI 是换产品形态，超出"架构重构"范围 |
| MCP / 子代理 / 技能系统 | KuseCode 当前定位用不上（约束：不过度设计）；但工具注册表的设计会为将来留缝 |
| zod / TypeBox 等新依赖 | KuseCode 的依赖哲学是"生产依赖只有 Pi，且全关在 adapter"；schema 校验已有手写方案（纯 JSON Schema + 形状关卡） |
| 权限三层闸门 | KuseCode 当前只读（repoRoot 围栏已覆盖安全需求）；若未来引入写工具再按需引入，设计文档先记账 |
| 每会话一文件的布局 | KuseCode 的 runs/<runId>/events.jsonl + session 索引已经承担同样职责且有契约 |

### 3.5 重构的主要机会点（输入给 Phase 1）

按依赖顺序排列（后一个常依赖前一个的形状）：

1. **共享装配层（bootstrap）**——先行，因为它决定"配置从哪来、工具从哪来、
   模型从哪来"的形状，后面所有改动都在它的下游。
2. **上下文工程管线**——P0-1；需要在"请求级投影"与事件溯源不变量之间
   做出 Phase 1 的核心设计决定，并补 token 估算与预算联动。
3. **工具注册表收拢**——P1-4；与装配层同期或紧随。
4. **ask_human 恢复语义**——P0-2；会动事件词汇表与 reduce，是唯一需要
   "改语义"的项，必须同步 golden/回放/文档。
5. **配置层**——P2-7；小体量。
6. **测试补强**——装配层 e2e（任务级）、（若做 4）恢复路径回归。
7. **整理项**——测试对 dist 的依赖（P2-6）、包名/命名统一（P2-9）。

---

## 4. 需要在 Phase 1 之前确认的架构决策点

以下决策影响整体架构，按用户要求在进入 Specification 前列出：

1. **定位边界：是否引入修改型工具（write/edit/bash）？**
   - 现状定位是"只读、证据优先的仓库问答"。tinycode 的核心产品能力（改代码）
     建立在写工具 + 权限体系上。
   - 建议：**不引入**（约束 #6"不修改项目定位"），但把工具注册表设计成
     加工具不动架构，为将来留缝。
2. **上下文压缩的落点：请求级投影 vs 状态层压缩？**
   - 建议：**请求级投影**——transcript 与事件日志永远完整，压缩只发生在
     适配器构建请求时（可从日志确定性重放出任何一次真实请求需要保持的性质，
     具体方案在 Phase 2 定）。
3. **ask_human 恢复语义的兼容性**：扩展事件词汇表（新增/修改事件变体）会
     触发 golden 与回放的同步演进。建议按"先记录行为变化原因 → 更新 spec →
     更新测试 → commit 说明"的既定约束执行，不回避。
4. **范围确认**：流式旁路事件（不落库）是否纳入本次重构？
     建议：作为可选项排在最后，不阻塞主线。

---

*Phase 0 完。下一步：Phase 1——基于本文档产出 `docs/sdd/02-spec.md`。*
