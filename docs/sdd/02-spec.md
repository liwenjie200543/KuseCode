# SDD · Phase 1 — KuseCode 重构 Specification

> 依据：`docs/sdd/01-analysis.md`（Phase 0）。
> 本文档定义重构的**目标态**：要什么、不要什么、每个模块的边界与需求。
> 具体技术方案（接口/类型/时序图）在 Phase 2（`03-architecture.md`），
> 任务拆解在 Phase 3（`04-implementation-plan.md`）。
>
> **决策记录**：Phase 0 末尾列出 4 个决策点（分析文档 §4），本轮按"分析文档中
> 标注为推荐且符合既有约束的选项"默认采纳——见 §1.3。任何一条都可以复议，
> 复议时更新本文档并重走受影响的下游阶段。

---

## 1. 项目目标

### 1.1 一句话目标

**保持 KuseCode 的事件溯源底座与只读证据定位不变，补齐它作为"底座"缺的产品层：
让长任务可行（上下文工程）、人机回路闭环（挂起-恢复）、多产品面共享一份装配
（bootstrap）、工具系统单一注册点、并补上小而完整的配置层与测试层。**

### 1.2 可检验的目标（对应 Phase 0 问题清单）

| # | 目标 | 解决的问题（01-analysis §1.8） |
|---|---|---|
| G1 | 长任务可行：大量工具调用的 Run 不再全量重放 transcript，请求体积有界且可预算 | P0-1 上下文工程缺失 |
| G2 | 人机回路闭环：`ask_human` 挂起后可应答、可恢复、可继续循环，且全程可回放可审计 | P0-2 + P1-5 |
| G3 | 单一装配层：CLI 与桌面壳消费同一个 bootstrap，接线代码只存在一份 | P1-3 装配重复 |
| G4 | 工具系统单一注册点：新增一个工具 = 写一个 spec 文件 + 注册一行 | P1-4 词汇分散 |
| G5 | 配置层：flag > env > 配置文件 > 默认值，四层齐备、手写校验、体量极小 | P2-7 |
| G6 | 测试补强：任务级 e2e（fake 模型驱动真装配真工具）、恢复路径回归、CLI 测试摆脱 dist 依赖 | P2-6 + 缺 e2e |
| G7 | 工程整理：包名/描述与仓库身份对齐（不改变任何对外行为） | P2-9 |

### 1.3 已采纳的架构决策（Phase 0 §4 决策点的默认答案）

| 决策点 | 采纳 | 一句话理由 |
|---|---|---|
| D1 定位边界 | **保持只读**；不引入 write/edit/bash 与权限体系；工具注册表按"加工具不动架构"设计 | 符合"不修改项目定位"与"不过度设计"约束 |
| D2 压缩落点 | **请求级投影**：transcript 与事件日志永远完整，压缩只发生在"构建发给模型的请求"这一步 | 事件溯源（回放幂等、审计、golden）是不容破坏的前提；tinycode 的状态层压缩与之冲突，必须翻译 |
| D3 ask_human | **纳入本次重构**：补全 reduce 的合法路径、Runtime 的 resume、CLI 的 answer 命令、回放与 golden 的同步演进 | 它是文档明确记录的半成品（replay.ts 显式抛错），属于"补齐"而非"改定位" |
| D4 流式 | **不纳入**：text_delta/thinking_delta 仍推迟 | 体验优化而非架构缺口；与步 2"不落库"的既定立场一致 |

### 1.4 非目标（明确不做）

- ❌ 不引入修改型工具（write/edit/bash）、权限审批体系、沙箱——定位仍是只读证据问答
- ❌ 不引入终端 TUI、MCP、子代理、技能系统——当前定位用不上（约束：不过度设计）
- ❌ 不引入 LLM 摘要式压缩——压缩是**确定性**的（见 §7，理由在彼处展开），
  LLM 摘要留作未来扩展，不在本期
- ❌ 不引入流式事件
- ❌ 不新增任何生产依赖（配置校验手写、投影确定性、无 zod/TypeBox）
- ❌ 不更换技术栈、不重写 UI、不改 CLI 既有命令与退出码语义
- ❌ 不推翻既有 docs/02–11 的历史记录——重构文档只引用与追加

### 1.5 核心用户场景（重构必须让这些场景变好或保持）

| # | 场景 | 现状 | 目标态 |
|---|---|---|---|
| S1 | `kuse run "这个仓库里有哪些 TODO？" --repo . --offline` | 可用 | 不变（行为与退出码逐字节兼容） |
| S2 | 大仓库、64 次工具调用的长任务 | 请求体积随观测线性膨胀，触顶即 `budget_tokens` 停 | 请求体积有界（投影预算）；预算归因准确；trace 仍能回答 what/why/cost |
| S3 | Run 挂起等人（`ask_human`） | 打印问题后以 `awaiting_human` 退出，永远无法继续 | `kuse answer <session> <run> "答案"` 恢复同一 Run，事件接在原日志后，循环继续 |
| S4 | 重看一次 Run（`kuse trace/runs`） | 可用且不加载 SDK | 不变；恢复后的 Run 同样可回放可 trace |
| S5 | 桌面壳发起 Run | 与 CLI 各自接线 | 共享同一装配层；行为一致 |
| S6 | 开发者新增一个工具 | 动 3 处、懂 catalog 协议 | 写一个 ToolSpec + 注册一行 |
| S7 | SDK 升级 | golden 拦截语义漂移 | 不变（golden 同步覆盖新增语义） |

---

## 2. 功能需求（FR）

> 编号供 Phase 3 的 implementation plan 逐条引用。每条注明验收判据的所在。

### FR-1 上下文工程：请求级投影管线（→ G1）

- **FR-1.1 对话投影**：提供确定性纯函数，把 `AgentState` 投影为"发给模型的对话"
  （Core 词汇，适配器再做 provider 翻译）。投影策略：
  - 任务面（goal/repoRoot/checks/availableTools）永远完整（沿用 `renderContext`）；
  - **最近 K 轮逐字保留**（K 为策略参数，默认覆盖最近一次工具结果全文）；
  - 更早轮次的**观测折叠**为紧凑形式：`工具(参数摘要) → 结果摘要`（首行 + 长度
    上限），assistant 决策文本同样截断；**Evidence 可引用的结构（path+行号+摘要）
    不因折叠丢失**；
  - 折叠必须有**可见标记**（沿用"截断必须可见"的既有规矩）。
- **FR-1.2 token 估算与投影预算**：确定性估算（chars/4，与 tinycode 同款、离线）；
  估算超过预算时从最旧的一轮开始加大折叠力度，直到估算入界或只剩保护窗口。
- **FR-1.3 确定性**：同一 `AgentState` + 同一 policy 参数 → 投影结果逐字节相同。
  投影**不落事件日志、不读时钟、不调模型**；任何时候可从日志回放出的状态重建
  同一份投影。
- **FR-1.4 预算联动**：`RunBudget.maxInputTokens` 的语义不变（超了就停）；
  投影预算是它的前置缓解。默认预算调整：`maxInputTokens` 从 `null` 改为
  有界默认值（具体数值 Phase 2 定，依据：投影后请求体积已有界，默认设防不再危险）。
- **FR-1.5 观测单条截断**：沿用 `OBSERVATION_CHAR_LIMIT = 8000` 且**保持不可配置**
  （尊重 `docs/06` 的既有决定）。
- **FR-1.6 假模型路径一致性**：fake 端口不消费投影（它不花 token），但投影模块
  有独立单测与 golden 固定件钉住语义。

验收判据：投影单测（确定性、有界性、保护窗口、折叠标记）；golden 新增"长任务
投影"固定件；`replay-idempotence` 在新路径下继续全绿。

### FR-2 人机回路：挂起-恢复（→ G2）

- **FR-2.1 状态推进的合法路径**：人的回答进入 transcript 必须经由**唯一的推进
  函数家族**（与实时执行/回放/测试三路共用——不出现第二份等价实现）。
- **FR-2.2 事件词汇扩展**：`human_input_received` 与 `run_resumed` 从"回放拒绝"
  变为合法事件；**只增不改**——13 种既有事件的载荷与顺序语义零变化。
- **FR-2.3 Runtime resume**：Runtime 新增恢复入口，语义：
  1. 校验目标 Run 存在、状态为 `awaiting_human`（从日志派生，不信调用方）；
  2. 把答案作为 `human_input_received` 事件**追加**进既有日志（append-only 不破）；
  3. 补 `run_resumed`；
  4. 以"回放重建出的状态 + 清空 pendingQuestion"为起点继续循环。
- **FR-2.4 回放支持**：`replayAgentState` 处理上述两种事件后，恢复过的 Run 可从
  日志完整重建状态；`runStatusOf` 增加 `run_resumed → running` 的既有映射之外，
  不需要新状态值。
- **FR-2.5 CLI**：新增 `kuse answer <sessionId> <runId> <answer>`；`kuse run` 在
  挂起收场时保持既有退出码并清晰打印问题与应答指引。既有命令与退出码零变化。
- **FR-2.6 错误类型化**：答案为空、会话/Run 不存在、Run 不在挂起态、日志不连续——
  全部是类型化错误，不静默、不抛裸异常。
- **FR-2.7 golden**：新增"挂起 → 应答 → 恢复 → 完成"固定件组，双路径
  （fake / SDK）逐字节一致的要求不变。

验收判据：resume 单元测试（含全部 FR-2.6 错误路径）；replay 对恢复日志的重建
测试；golden 新固定件；`kuse answer` 的 CLI 测试。

### FR-3 单一装配层（→ G3）

- **FR-3.1** 新增装配模块：一个工厂函数接收（配置 + IO 边界），产出运行所需的
  全部零件（toolbox、模型端口两路、store、runtime、trace/audit 入口）。
- **FR-3.2** CLI `commandRun` 与桌面 `RunService` 改为消费装配层；两处现有的
  手工接线删除。装配层**零 electron import、零 process 直接访问**（IO 注入，
  沿用 CLI 的可测性规矩）。
- **FR-3.3** 装配产物的对外词汇是 Core/Runtime 词汇（端口、工厂、事件流），
  不暴露可变内部状态。

验收判据：装配层单测（两路模型解析、离线模式、配置缺省）；CLI 与桌面测试
全绿且接线代码不重复（人工评审 + 文件行数对照）。

### FR-4 工具系统：单一注册点（→ G4）

- **FR-4.1 Toolbox 组装**：提供 `Toolbox` 组装函数，输入 `ToolSpec[]`，一次产出
  执行层所需的全部形状：带八道关卡的 `ToolPort`、组装接缝、material 读取器、
  allowlist、provider 目录翻译所需的清单。
- **FR-4.2 新增工具的成本**：写一个 `ToolSpec`（name/description/schema/parse/
  run/material）+ 在组装处的注册列表加一行；**不需要**改 adapter、catalog、协议层。
- **FR-4.3 边界不动**：Core 仍然只认识工具**名字**（allowlist）；schema 与
  provider 形状翻译仍属工具侧与适配器；`adapter/pi` 仍是唯一 SDK 触点。

验收判据：toolbox 单测；用"注册一个测试专用假工具"证明 FR-4.2 的成本声明。

### FR-5 配置层（→ G5）

- **FR-5.1 四层优先级**：CLI flag > 环境变量 > 配置文件（`<repoRoot>/.kuse/config.json`，
  可选）> 内置默认。同键冲突时高层覆盖低层，**覆盖必须可见**（verbose 时打印来源）。
- **FR-5.2 配置项白名单**（第一期全部）：模型选择、`RunBudget` 各项、投影策略
  参数（保护窗口 K、投影 token 预算）、数据目录（runs/sessions 存放根）。
  观测截断 8000 **不在**白名单。
- **FR-5.3 手写校验**：schema 用手写守卫函数校验（沿用 repo-tools 的
  `parse` 风格），错误信息可操作（指出键名与期望类型）；未知键**警告不失败**
  （配置文件是要提交进仓库的，宽容未知键向前兼容）。
- **FR-5.4 秘密红线**：配置文件中出现疑似凭据字段时启动警告（借鉴 tinycode
  同款实践）；配置内容**永不**进入事件日志。

验收判据：配置解析单测（四层覆盖、类型错误、未知键、秘密警告）；
`no-runtime-deps` 继续通过（校验零依赖）。

### FR-6 测试补强（→ G6）

- **FR-6.1 任务级 e2e**：fixture 仓库 + fake 模型剧本驱动**真装配**（bootstrap →
  真工具 → 真文件系统 → 真事件日志），断言：报告交付、每条论断通过 `auditRun`
  证据核对、事件日志可回放、trace 的 what/why/cost 齐备。（借鉴 tinycode
  harness e2e 的"真 loop 修真 bug"，判据换成 KuseCode 的证据审计。）
- **FR-6.2 恢复路径回归**：见 FR-2.7。
- **FR-6.3 CLI 测试摆脱 dist**：CLI 测试直接从 `src` 运行（vitest loader），
  或在测试脚本中固化 build 前置——两者选一，Phase 3 定；判据是"fresh clone +
  npm ci + npm test"全绿，无需手动 build。
- **FR-6.4 投影 golden**：见 FR-1.6。

### FR-7 工程整理（→ G7）

- **FR-7.1** `package.json` 的 name/description 与仓库身份对齐（`kusecode`）；
  bin 名 `kuse` 不变；不改任何运行时行为。
- **FR-7.2** `docs/sdd/00-progress.md` 建立进度索引（每完成一个 Phase/task 追加一行）。

---

## 3. 非功能需求（NFR）

| # | 需求 | 判据 |
|---|---|---|
| NFR-1 | **事件溯源不变量零破坏**：append-only、write-ahead、sequence 连续、回放幂等、终态唯一 | 既有测试 + 新增恢复路径测试全部通过；golden 旧固定件逐字节不变 |
| NFR-2 | **SDK 边界零越界**：core/runtime 无 SDK import；新增模块同样受限 | `test/core-types.test.ts`、`test/no-runtime-deps.test.ts` 扩展覆盖新模块后全绿 |
| NFR-3 | **确定性**：投影、回放、trace、审计、配置解析全部确定性（无时钟、无随机、无网络） | 单测断言同输入同输出 |
| NFR-4 | **全离线测试**：不依赖任何凭据与网络 | fresh clone 上 `npm ci && npm test` 全绿 |
| NFR-5 | **零新增生产依赖** | `package.json` dependencies 不变（FR-7.1 的改名除外） |
| NFR-6 | **性能不回退**：投影为 O(transcript) 纯函数，每轮至多执行一次；不引入逐轮 O(n²) | 单测计时断言不设；代码评审 + 结构保证（投影结果不跨轮缓存即可接受） |
| NFR-7 | **文档同步**：每个 Phase/task 落地时更新 sdd 文档；行为变化必须在 commit message 说明 | 评审 |
| NFR-8 | **Windows 兼容**：路径处理、测试在 Windows 与 CI 上同样通过 | 本地 Windows 全绿 + 既有 CI |

---

## 4. 总体架构

### 4.1 目标态分层（新增层加粗）

```text
产品面 (CLI / Desktop)                薄壳：参数翻译 + 输出渲染，零业务判断
      ↓
Product Assembly (src/bootstrap)     ★新增：配置解析 + Toolbox 组装 + Runtime 实例化
      ↓                               + resume 入口 + trace/audit 门面
Agent Runtime                        一次 Run 怎么发生、怎么活下来、怎么恢复
      ↓                               （既有机制不变；resume 为新增能力）
Agent Core                           一次有效 Run 意味着什么
      ↓                               （reduce 家族扩展"人的回答"这一合法路径；
Ports/Adapters (adapter/pi, tools)     对话投影词汇在此定义，策略参数注入）
```

### 4.2 模块边界（允许依赖方向，含新增模块）

```text
core          依赖：无（零 import 不变）
runtime       依赖：core
context 投影  位置：core（词汇/纯函数）+ 装配层（默认策略参数）——见 §7.1
tools         依赖：core（ToolSpec 实现者）
toolbox       依赖：core、tools、runtime(执行层工厂)     ★新增组装点
adapter/pi    依赖：core、SDK（不变；history.ts 消费投影）
store         依赖：runtime(契约)
config        依赖：无（手写校验，纯函数）               ★新增
bootstrap     依赖：core、runtime、toolbox、adapter/pi、store、config  ★新增
cli/desktop   依赖：bootstrap（不再各自接线）
testing       依赖：core、runtime（假件）
```

禁线（由可执行测试钉住）：core ← 任何东西；runtime/adapter 之外 ← SDK；
bootstrap ← electron / process（IO 注入）。

### 4.3 核心数据流（目标态）

**数据流 A：新 Run（与现状的差异仅一步）**

```text
Task + 配置
  → bootstrap 装配（toolbox / model / store / runtime）
  → runtime.run(task)
      每轮：budget 检查 → [新增：对话投影（请求级）] → model.decide
            → 工具执行八道关卡 → assembleObservation → reduce
  → 事件 write-ahead 落 JSONL → 消费者
  → 终态 complete|partial|failed|cancelled|awaiting_human
```

**数据流 B：挂起-恢复（全新）**

```text
run: … → ask_human → human_input_requested → awaiting_human（退出码 6）
answer: 校验（存在且挂起）→ 追加 human_input_received → run_resumed
        → 回放重建状态（清 pendingQuestion）→ 循环继续 → 新终态
事后：同一份日志可完整回放/trace/审计（恢复不是旁路，是日志的一部分）
```

**数据流 C：重看（不变）**：日志 → replay / runStatusOf / traceOf / auditRun，
零 SDK 加载。

### 4.4 Agent Loop（目标态语义）

循环语义与现状完全一致（Task → Context → 决策 → 工具 → 观测 → reduce），
唯一扩展：**`ask_human` 之后收到人的回答**是循环的第四种合法续法：

```text
reduce(state, decision)                    决策推进（不变）
reduce(state, decision, observation)       观测推进（不变）
reduceHumanInput(state, answer)            人的回答推进（新增，同一函数家族）
```

循环本体的停与续判据相应扩展：`pendingQuestion` 非空时停（不变）；
`resume` 以"回答已入 transcript、pendingQuestion 清空"的状态重新进入循环（新增）。

### 4.5 Runtime（目标态能力）

既有能力全部保留：事件 write-ahead、预算执法、取消归因、重试、终态完备性。
新增能力：

| 能力 | 说明 |
|---|---|
| `resume` 入口 | 见 FR-2.3；与 `run` 共享同一事件发射/预算/取消机制——恢复不是第二条代码路径，是同一条路径的新起点 |
| 请求级投影接线 | 投影在受守卫的模型端口内侧、真实端口外侧发生；守卫看到的是**真实状态**（预算/空转判据不受投影影响） |

### 4.6 Tool 系统（目标态）

```text
ToolSpec（name/description/schema/parse/run/material）     工具自包含，与现状同形
   ↓ 注册（一行）
Toolbox 组装 → { ToolPort(八道关卡), materialReader, allowlist, 目录清单 }
   ↓
Runtime 消费 ToolPort（不变）
```

八道关卡、失败即观测、provenance 只由执行层写——全部不变。
变化仅在**组装方式**：三处分散词汇收拢为一个注册点（FR-4）。

### 4.7 Context / State 管理（目标态）

- **State（真相）**：`AgentState.transcript` 仍是唯一状态，只经 reduce 家族推进；
  恢复路径同样如此（FR-2.1）。
- **Context（模型看到什么）**：两层投影——
  1. 任务面：`renderContext`（不变，六字段有界投影）；
  2. 对话面：**请求级对话投影**（新增，FR-1；确定性、可从状态重建、不落库）。
- **真相与投影的关系**写在代码结构里：投影是纯函数，输入只有状态与策略参数；
  事件日志永远不知道投影的存在。

### 4.8 配置管理

见 FR-5。原则：配置是**驱动方的关注点**（与预算同理），永远到不了 Core；
投影策略参数由装配层从配置得出后注入，Core 的投影函数只认参数不认配置。

### 4.9 错误处理

既有原则不变（失败是数据不是结局、错误码两个词汇表、停止归因顺序）。
新增：

| 场景 | 处理 |
|---|---|
| resume 目标不存在 / 未挂起 / 日志不连续 | 类型化错误（FR-2.6），CLI 退出码非零、信息可操作 |
| 配置非法 | 启动即失败，指出键名与期望类型（FR-5.3）；未知键警告 |
| 投影遇到超出预期的形状 | 投影是全函数：任何合法 `AgentState` 都有定义良好的投影（宽松渲染 + 可见标记），不抛错 |

### 4.10 日志与可观测性

- 事件日志：唯一真相，不变；恢复产生的事件接在原日志尾部（FR-2.3）。
- trace/runs/audit：不变；恢复过的 Run 的 trace 能看到完整的
  挂起→应答→恢复→终态链。
- 投影：不落库、不进事件；**但可观测**——同一投影可从日志重建（FR-1.3），
  调试时可用一条独立命令（Phase 3 决定是否暴露为 CLI 子命令，默认仅测试钩子）。

### 4.11 向后兼容策略

| 面 | 策略 |
|---|---|
| 事件词汇 | 只增不改：13 种既有事件载荷/顺序零变化；恢复语义用既有 `human_input_received`/`run_resumed` 变体（它们已存在于词汇表但从未被生产——现在是"激活"而非"新增"，见 §6 的说明） |
| 旧日志可读性 | 旧日志（无恢复事件）回放/trace/审计行为逐字节不变 |
| 混合日志 | 旧 Run 的日志 + 新追加的恢复事件 = 合法连续前缀，回放必须处理（这是 FR-2.4 的测试项） |
| CLI | 既有命令/flag/退出码零变化；`answer` 为新增子命令 |
| 公共 API（src/index.ts） | 只增不减；`AgentRuntime` 接口新增入口用可选方法（沿用 `beginRun?` 先例），既有实现者（testing 假件）不破 |
| 默认值 | `DEFAULT_BUDGET.maxInputTokens` 从 `null` 改为有界值是**唯一**的默认行为变化，原因与影响记录在 Phase 2/commit（投影使其安全化） |
| golden | 旧固定件不许动；新语义 → 新固定件 |

### 4.12 测试策略

金字塔（全部离线）：

```text
        任务级 e2e（FR-6.1：真装配+真工具+证据审计判据）
      集成：resume 全链路 / CLI answer / 配置四层 / 桌面 RunService
    单元：投影（确定性/有界/保护窗口） / reduce 家族 / toolbox / config
  契约：core 零依赖 / no-runtime-deps / Decision 穷尽性（既有，扩展覆盖新模块）
金线：golden transcripts（既有 8 组不动 + 挂起恢复组 + 长任务投影组，双路径逐字节）
```

### 4.13 目录结构（目标态）

```text
src/
├── core/            # 不变 + project.ts（对话投影词汇，纯函数）
├── runtime/         # run-agent 增加 resume；其余不变
├── adapter/pi/      # history.ts 改为消费投影；其余不变
├── store/           # 不变
├── tools/           # repo-tools 不变（ToolSpec 实现者）
├── toolbox.ts       # ★ 组装点（FR-4）
├── config/          # ★ 配置解析（FR-5）
├── bootstrap/       # ★ 装配层（FR-3）
├── testing/         # 不变 + resume 假件扩展
├── cli/             # 变薄：消费 bootstrap；+ answer
└── index.ts         # 导出只增
test/                # 既有全保留 + 投影 / resume / bootstrap-e2e / config
desktop/             # RunService 改为消费 bootstrap（渲染层不动）
docs/sdd/            # 本流程文档
```

### 4.14 技术选型及原因（重申与固化）

| 选型 | 原因 |
|---|---|
| TypeScript + NodeNext ESM 不变 | 既有底座、类型即契约（编译期证明是本项目的方法论） |
| vitest 不变 | 既有资产（golden 双路径、413 例）都在其上 |
| **不引入** zod / TypeBox / 任何 schema 库 | FR-5.3 手写守卫足够（先例：repo-tools 的 parse）；依赖哲学是"生产依赖只有 Pi 且全关在 adapter" |
| **不引入** LLM 摘要压缩 | 确定性折叠可回放、可 golden、零额外模型调用与账目问题；质量差距用"保护窗口 + 证据结构保全"弥补（§7.2 详述） |
| 桌面壳保持 Electron/React 不变 | 步 11 的既有决定；本期只改其宿主接线 |

---

## 5. 从 tinycode 借鉴了什么（逐项：做法 → 为何采用 → 做了什么调整）

> 约束 #3 要求每项借鉴写清三点。未列出的 tinycode 设计 = 决定不借鉴（§6）。

### 5.1 上下文分层工程（→ FR-1）

- **tinycode 的做法**：两层——单条工具结果头尾截断 + 全文归档 artifact；
  token 估算（chars/4）超阈值后把旧回合替换为 LLM 摘要，最近 N 条逐字保护，
  切点落在 user 消息边界。
- **KuseCode 为什么采用**：Phase 0 P0-1——长任务请求体积无界、超预算只会停；
  tinycode 是这块唯一的参考实现。
- **KuseCode 的调整**：
  1. 压缩从**状态层**移到**请求级投影**（D2）——transcript/日志不动，
     同一状态永远可重放出同一投影；
  2. 摘要从 **LLM 生成**改为**确定性结构折叠**——tinycode 的历史是对话文本，
     摘要收益大；KuseCode 的历史是结构化证据链（工具+参数+值），
     确定性折叠损失小且可回放可 golden，还免去"摘要调用算不算一次账"
     的账目难题；
  3. 保护窗口对应改为"最近 K 轮 + 任务面永远完整"；
  4. artifact 归档**暂不做**（观测本就有 8k 截断且截断可见；全文归档留给
     未来有真实需求时再加，避免过度设计）。

### 5.2 共享装配层（→ FR-3）

- **tinycode 的做法**：`bootstrap.ts` 一个函数把模型/权限/上下文/会话/工具/
  MCP/子代理装配成一个 `Harness`，TUI 与 headless 共用。
- **KuseCode 为什么采用**：P1-3——CLI 与桌面已经重复接线，docs/11 自己承认
  "一比一复刻"。
- **KuseCode 的调整**：装配产物暴露 Runtime 词汇（端口/工厂/事件流/恢复入口），
  **不暴露可变状态**（tinycode 的 `Harness.runtime.agent.state` 是可变数组，
  与事件溯源冲突）；IO 全注入以保持进程内可测。

### 5.3 统一工具注册表（→ FR-4）

- **tinycode 的做法**：`ToolRegistry` 单一命名空间，内置 + MCP + 子代理同表注册，
  重名即抛。
- **KuseCode 为什么采用**：P1-4——工具词汇分散三处，加工具成本高。
- **KuseCode 的调整**：注册发生在**组装函数**而非可变注册表实例（toolbox 是
  一次性的、不可运行时增删——Run 中途的工具面变化不在需求内）；Core 仍只认
  名字 allowlist（"core 不知道 schema"的边界不动）；命名冲突检查保留。

### 5.4 配置体系（→ FR-5）

- **tinycode 的做法**：`.tinycode/config.json`（zod 校验）+ env + flag 分层；
  数据目录可重定向；秘密字段启动警告。
- **KuseCode 为什么采用**：P2-7——只有 flag/env，预算与投影参数无处安放。
- **KuseCode 的调整**：校验**手写守卫**（不加 zod，NFR-5）；白名单极小
  （§FR-5.2）；观测截断明确排除在配置外（尊重既有决定）。

### 5.5 会话恢复的安全细节（→ FR-2）

- **tinycode 的做法**：attach 严格只读、torn line 跳过、崩溃不毁历史。
- **KuseCode 为什么采用**：恢复（FR-2.3）要向**既有**日志追加事件，安全追加的
  细节 tinycode 已踩过坑。
- **KuseCode 的调整**：KuseCode 的 store 已有 torn-write 处理与 append-only
  校验，恢复直接复用；新增的是"目标 Run 存在且挂起"的派生校验（从日志派生，
  不信调用方——tinycode 没有 Run 级状态概念，此项无处借鉴，是 KuseCode 自己的）。

### 5.6 任务级 e2e 测试（→ FR-6.1）

- **tinycode 的做法**：fixture 里故意写错的 `add()`；脚本化 mock 模型驱动真
  loop 修到测试变绿；断言 fixture 测试通过 + 会话文件完整。
- **KuseCode 为什么采用**：golden 钉"语义不变"，缺一条"装配全链路真的能干活"
  的功能级测试；tinycode 的 e2e 是最佳样板。
- **KuseCode 的调整**：判据换成 KuseCode 自己的验收观——报告交付 + **每条论断
  通过 `auditRun` 证据核对** + 日志可回放 + trace 三问齐备。"修 bug"改为
  "回答一个关于 fixture 仓库的问题"（只读定位）。

### 5.7 错误即反馈的措辞纪律（吸收为规约，不产生新代码）

- tinycode："模型看到一句可读的话，永远不是堆栈"。KuseCode 的 tool-runner
  已有同款纪律（错误码 + 可操作中文理由）——吸收为**新工具/新错误路径的
  写作规约**写入本文档，无独立实现项。

---

## 6. 决定不借鉴的 tinycode 设计（及原因）

| tinycode 设计 | 不借鉴的原因 |
|---|---|
| 可变 `agent.state.messages` 活状态 | 与事件溯源正面冲突（NFR-1） |
| LLM 摘要压缩 | 见 §5.1 调整 2：确定性折叠更符合本项目方法论 |
| pi-tui 交互 TUI | 产品面是 CLI+桌面；TUI = 换产品形态，越界 |
| MCP / 子代理 / 技能系统 | 只读问答定位用不上；工具注册表已为其留缝（未来加"工具来源"即可） |
| zod / TypeBox | NFR-5 零新增生产依赖；手写守卫足够 |
| 三层权限闸门 | 只读定位下 repoRoot 围栏 + allowlist 已覆盖；将来引入写工具时按需引入（本文档留档） |
| 每会话一文件的布局 | runs/<runId>/events.jsonl + session 索引已承担同职责且有契约 |

---

## 7. 两个关键设计的展开论证

### 7.1 为什么投影词汇放 Core、策略参数放装配层

"模型能看到什么"是**一次有效 Run 的定义的一部分**（Core 的问题），
"折叠到多狠、保护几轮"是**驱动方的政策**（Runtime/装配的问题）。
这与既有结构同构：`renderContext`（词汇）在 Core，`availableTools`
（策略输入）由调用方给；`RunBudget`（政策）在 Runtime，Core 永不检查。
把投影词汇放进 Core 还有一个可执行的好处：`test/core-types.test.ts` 的
零依赖扫描自动覆盖它，投影永远不会长出 I/O。

### 7.2 为什么确定性折叠而不是 LLM 摘要

1. **可回放**：投影必须能从日志回放出的状态重建（FR-1.3）。LLM 摘要的输出
   不可从日志重建——除非把摘要落进事件日志，而摘要是投影的产物，落库等于
   让"日志是唯一真相"多出一个不可复核的第二真相。
2. **可 golden**：确定性投影可以钉固定件；LLM 摘要每次不同，golden 失效。
3. **账目干净**：摘要调用本身花 token，"这次请求花了多少"会多出一个
   既非决策也非观测的灰色调用，`usage_reported` 的语义要重新论证。
4. **质量损失可控**：KuseCode 的历史以结构化观测为主（不是自由对话），
   "工具(参数) → 结果摘要 + 证据结构保全"保住了证据链；任务面永远完整，
   最近 K 轮逐字——模型丢的只是"较早轮次里结果的尾部细节"，而那正是
   8k 截断本来就在丢的东西，只是现在丢得**有预算、可见、确定性**。
5. **代价诚实**：折叠质量不如好摘要。这是**记录在案**的取舍；若未来实测
   证明不够，升级路径是"摘要作为一次性、显式、落库的决策类事件"——
   那是一次新的语义设计，不属于本期。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 投影改变模型行为（同样任务、不同结果） | golden 新固定件钉住投影语义；投影参数默认保守（K 足够大时投影≈现状） |
| 恢复语义破坏旧日志兼容 | 旧固定件逐字节不许动 + 混合日志（旧前缀+新事件）专项测试 |
| bootstrap 抽取碰坏 CLI/桌面行为 | 先抽装配、后换消费者，每步独立 commit；CLI 测试 42 例 + 桌面 4 例是安全网 |
| 事件词汇"激活"被误读为破坏兼容 | `human_input_received`/`run_resumed` 已在词汇表中（步 2 定、步 7 回放拒绝）——是补语义不是改词汇；commit message 明确说明 |
| Windows 路径/测试环境差异 | NFR-8；投影与配置纯函数化后平台面进一步缩小 |

---

*Phase 1 完成后进入 Phase 2（`03-architecture.md`）：模块依赖图、核心接口与
类型、四个生命周期、错误传播、事件机制、配置加载、测试架构、Mermaid 图。*
