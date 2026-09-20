# Step 2 — Agent Core 领域契约

> 这一步的声明（见 README 开发序列）：**「一次有效的 Run 意味着什么」被类型化了。**

本文不是 API 文档，它回答的是另一个问题：**为什么是这些类型，而不是别的。**
每加一个类型之前都要先回答它守住了哪条第一性原理；回答不出来的类型就是过早抽象。

## 一、每个类型守住什么

| 类型 | 守住的第一性原理 |
|---|---|
| `Provenance` | 一条材料只有知道来源和时刻才可被采信。这是对已记录缺口（`provenance_presence` 为 0）的修复。 |
| `Evidence` | 论断的最小单位是「文件路径 + 行号 + 原文」。它把「结论要能追溯」变成可执行约束。 |
| `Task` | 系统的起点不是一串 prompt，而是「给定什么材料 → 想要什么决策」。 |
| `ToolIntent` | 模型只能**表达意图**，不能直接产生副作用。参数是不可信输入，执行前必须校验。 |
| `ToolOutcome` | 工具只回报原始结果，**不能**携带来源与截断标记。 |
| `Observation` | 进入状态与事件日志的那一份，`provenance` / `truncated` 由 Runtime 写入。 |
| `Decision` | 循环每一步的产物只有三种可能，正好穷尽「自己接着干 / 干完了 / 干不了需要人」。 |
| `Message` | 对话用 **Core 自己的词汇**记录，适配器只做翻译。 |
| `AgentState` | 状态的唯一真相是一个有序数组；回放就是把它重新追加一遍。 |
| `Context` | 模型看到的是状态的**有界投影**，不是状态本身。 |
| `RunErrorCode` | 外部失败必须变成一个**有类型、可见、可恢复**的状态，而不是一个异常。 |
| `RunOutcome` | `partial` 不是失败而是诚实的成功，它必须点名缺失的材料。 |
| `Run` / `Session` / `RunStatus` | 一次 Run 有有序生命周期和唯一终态；会话存在的唯一理由是隔离。 |
| `RunBudget` | 预算是**驱动方**的关注点，所以它属于 Runtime 词汇。 |
| `ModelPort` / `ToolPort` | SDK 不得越过的那条线。 |
| `AgentEvent` | Runtime 对外**唯一**的契约：有序、可回放、可审计。 |
| `AgentCore` / `AgentRuntime` | 「一步」与「驱动一次 Run」的分界。 |

## 二、三个刻意做出的边界决定

### 1. 用 `| null`，不用 `?`

`exactOptionalPropertyTypes` 下「字段没被设置」和「字段被显式设为空」是两件事。
`Evidence.lines` 为 `null` 的意思是**「这是一条整文件级证据」**——那是一个确定的事实，
不是「这个字段忘了填」。所有可选语义都用 `| null` 表达。

### 2. `ToolOutcome` 与 `Observation` 必须分开

工具输出是不可信输入。如果让工具自己填 `provenance`，一个坏工具就能伪造
「这条证据来自哪个文件、什么时候取的」——而整条追溯链就建立在这个字段上。

所以分成两个类型：工具只能产出 `{ value, error }`，`provenance` 与 `truncated`
由 Runtime 组装。`test/core-types.test.ts` 里有两行编译期证明：

```ts
const outcomeLeaksPolicyFields: [Extract<"provenance" | "truncated", keyof ToolOutcome>] extends
  [never] ? true : false = true;
```

谁把策略字段加回 `ToolOutcome`，这一行就编译不过。

*（步 6 的追加：这条证明兑现的地方是 `src/runtime/tool-runner.ts`——`provenance` 与
`truncated` 确实只由那一层写。破坏性验证顺带发现拦住「工具伪造这两个字段」的是**两道**
独立的防线（`normalizeOutcome` 的重建、组装点的构造），拆掉任意一道另一道仍然成立。
见 `docs/06-tool-execution.md` 边界决定 7。）*

### 3. 状态里只存 `transcript`，不额外存 `observations`

多存一份投影，就多一个会在回放时分叉的真相。而「回放必须重建出完全相同的
`AgentState`」正是要禁止这件事。需要观测列表时从 transcript 派生，投影函数
（`renderContext` / `observationsOf`）放在 step 3 的 `src/core/loop.ts`。

同样的理由，`Message` 用的是 Core 自己的 union 而**不是** `unknown[]`：
如果状态里装的是 provider 的消息对象，「模型能看到什么」就变成由适配器决定的了，
SDK 的数据形状会顺着状态渗进 Core。

## 三、README 里没写、但顺带定下来的事

- 相对导入统一写 `.js` 后缀（NodeNext 要求）。磁盘上是 `.ts`，
  所以测试运行器必须能把 `.js` 映射回 `.ts`——`test/core-types.test.ts` 顶部那个
  副作用 import 就是这个探针。
- 这一步只产出类型，**零运行时代码**：`src/index.ts` 全是 `export type`，编译后被完全擦除。

## 四、刻意推迟的东西

| 推迟的 | 推迟到 | 理由 |
|---|---|---|
| `SessionStore` 接口 | **step 7（已落地）** | 它是「Run 怎么活下来」的契约，在真正实现持久化时一并定，避免凭想象设计。落地在 `src/store/session-store.ts`：它只存日志答不出来的东西（哪些 Run 属于哪个会话、各自的 `Task`），`status` 从日志派生（`docs/07-durability-replay.md` 边界决定 4）。 |
| `RunLog` 接口 | **step 4（已落地）** | 原计划与 `SessionStore` 一起推迟到 step 7，前提是「还没有驱动方」。step 4 有了驱动方，「事件落在哪里」就成了必须当场回答的问题，所以契约提前到 `src/runtime/run-log.ts`；持久化实现仍在 step 7（见 `docs/04-run-events.md`）。**步 7 已落地**：`jsonlRunLog` 在 `src/store/run-log-jsonl.ts`——契约一行都没改，这是「契约属于 Runtime，载体属于存储」第一次真的被兑现。 |
| 流式 `text_delta` / `thinking_delta` 事件 | 未定 | token 增量不是审计证据，决策与观测才是。把它们落进事件日志会撑大日志、稀释 trace。CLI 真的需要流式体验时再加，且**不落库**。 |
| `Context` 的渲染函数 | step 3 | 类型先定，实现跟着循环一起落地。 |

## 五、验证

```bash
npm run typecheck
npm test
```

`test/core-types.test.ts` 覆盖：

1. `src/core` 的文件**不引用 Core 之外任何东西**（含 Node 内置模块），且从不引用 SDK；
2. `types.ts` 零 import——Core 的词汇不依赖任何东西；
3. `Decision` 的 `switch` 穷尽性（编译期），以及三个分支的载荷正确性（运行时）；
4. `ToolOutcome` 不含策略字段、`Observation` 含 provenance（编译期）；
5. `AgentEvent` 全部 13 个变体都携带 `runId` / `sequence` / `timestamp`，且按 `type` 正确收窄；
6. `run_completed` 必须说明是 `complete` 还是 `partial` 并列出缺失材料；
7. `run_failed` 的 code 只能来自 `RunErrorCode` 分类。
