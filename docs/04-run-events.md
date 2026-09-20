# Step 4 — 一次 Run 是一个有序可回放事件流

> 这一步的声明（见 README 开发序列）：**一个 Task 就是一条有序、可回放的事件流。**

本文回答的是「为什么驱动方长这样」，不是「怎么调用 `run()`」。每加一条约束之前，
先回答它守住了哪条第一性原理；回答不出来的约束就是过早抽象。

## 一、一个 Run 是什么

返回值不是 `Report`，是 `AsyncIterable<AgentEvent>`。这不是「先给流、之后汇总」的脚手架——
**终态结论本身也只是流里的一个事件**（`run_completed` / `run_failed`），
它没有比别人更高的地位。于是「这次 Run 干了什么、为什么停」的答案只有一处：
那条有序的事件流。

三种结束方式对应的事件流（序号就是 `sequence`）：

```text
respond（一趟收工）
  0 run_started
  1 model_requested
  2 decision_made        respond
  3 run_completed        complete | partial

一次工具调用之后应答
  0 run_started
  1 model_requested
  2 decision_made        call_tool
  3 tool_started         toolCallId + toolName
  4 tool_completed       success | error + result + durationMs
  5 observation_added
  6 model_requested
  7 decision_made        respond
  8 run_completed

问到人（挂起，不是结束）
  0 run_started
  1 model_requested
  2 decision_made        ask_human
  3 human_input_requested
  —— 没有终态事件
```

## 二、13 种事件，本步发射 9 种

步 2 定下了 13 种事件的词汇，本步不新增也不修改它们。**但不是 13 种都会在这里出现**：
只有载荷里每个字段现在就真的知道的，才会被发射。

| 事件 | 本步 | 说明 |
|---|---|---|
| `run_started` | 发射 | sequence 0 |
| `model_requested` | 发射 | 包一层 `ModelPort` 发射，见边界决定 3 |
| `decision_made` | 发射 | 每一次决策一条，终态决策也算 |
| `tool_started` | 发射 | 时间戳在工具真正开跑之前 |
| `tool_completed` | 发射 | `durationMs` 来自 Runtime 的时钟 |
| `observation_added` | 发射 | 带的就是进状态的那一份 |
| `human_input_requested` | 发射 | 走完 `ask_human` 之后 |
| `run_completed` | 发射 | `complete` / `partial` |
| `run_failed` | 发射 | 见边界决定 4 |
| `human_input_received` / `run_resumed` | 不发射 | 挂起的 Run 怎么被叫醒的语义仍未落地（步 7 落地的是持久化与回放，而回放会拒绝这两条事件——见第五节推迟表）。 |
| `run_cancelled` | 不发射 | 取消的执法在步 5 |
| `usage_reported` | 不发射 | 它的载荷一半来自适配器（token 数）。步 8 之前发射等于伪造数据。**步 8 已发射**，而且守住了这条：provider 没报数时写 `null`、不写 `0`（`docs/08` 决定 6） |

## 三、六个刻意做出的边界决定

### 1. `sequence` 的所有权收在一个私有的 `emit` 里

调用方拿不到「造一条 `AgentEvent`」的能力：`runId` / `sequence` / `timestamp` 由驱动方一手填，
事件类型与载荷的形状由类型系统收窄（少一个字段或多一个字段都编译不过）。
于是「每个 Run 内 `sequence` 从 0 起严格 +1」不是一条需要遵守的纪律，而是一个**结构事实**——
没有代码路径能绕过它。

### 2. 事件先落日志，再交给消费者

`emit` 的顺序是 `log.append(event)` 然后入队；消费者看到的每一条，都已经在日志里。
这条 write-ahead 序有代价也有收益，两者都值得写下来：

- 收益：消费者当场崩溃，这条记录仍然存在。**「日志是唯一真相」要求真相不依赖观察者的存活。**
- 代价：消费者半路 `break` 时，日志可能比它多几条（多记，不是丢失），
  且那次 Run 在日志里没有终态事件——它不是「结束」，也不是「取消」（后者是步 5 的执法）。
  测试里钉住了这一条：`all.slice(0, seen.length) === seen`，且 `all.length === seen.length + 1`。

### 3. `model_requested` 由 Runtime 包一层端口发射（而这一步需要一个队列）

步 3 的文档预言了前半句：`model_requested` 不该由循环在决策之后补记，
包一层 `ModelPort` 就能在**真正发起请求的那一刻**发射它。实现之后发现还差一件东西。

事件产生在**端口内部**，而 `yield` 只能发生在驱动方的函数体里——两者不在一个调用帧。
于是「产生」与「送出」必须拆开：产生时立刻落日志、进队列；
控制权回到驱动方时（`for await` 的每次迭代边界）按序送出。拆开之后有一条不变量：

> **已送出的前缀 + 队列 = 日志**

所以消费者看到的永远是日志的一个前缀：不可能看到一条不在日志里的事件，也不可能看到乱序。
`model_requested` 只是这条不变量最显眼的受益者——任何「在未来某个端口的内部产生事件」
（步 5 的预算记账、步 9 的 usage 都打算这么干）都会落到同一个机制上。

顺带记一笔被实现修正的预测：步 3 说「generator 的返回值就是终态，要读它得用 `next()` 手动驱动」。
实际上不需要——终态从最后一个 `turn.state` 里就读得出来，于是这里用了更短的 `for await`。
终态由**状态**决定（`pendingQuestion` 是不是空、最后一次决策是不是 `respond`），
而不是由「循环返回了什么」决定：状态是唯一真相，驱动方也不破这个例。

### 4. 异常不是结局

任何一步失败都落成 `run_failed` 事件，而不是抛给调用方——步 2 的那条
「进程外部的一次失败必须变成一个**有类型、可见、可恢复**的 Run 状态」在这里落地。
测试里最关键的一句断言是 `await h.run()` **不是** `rejects`。

归一化规则只有一条：**带合法 `code` 的抛出物原样保留，其余一律 `runtime_error`。**
Runtime 不认识 provider，但它认识那十个码，所以它不猜、不映射、不从消息文本里认字符串；
provider 特有的错误怎么变成这十个码，是**适配器**的事（**步 8 已落地**：`src/adapter/pi/errors.ts`——先看状态码、再看文本，认不出来就诚实地落到 `runtime_error`）。

`RunErrorCode` 与这张表由一行 `satisfies Record<RunErrorCode, true>` 绑死：
谁往分类里加一个码，`src/runtime/run-agent.ts` 立刻编译不过——
「Runtime 接不接得住它」被迫当场回答（破坏性验证过：加 `provider_quota_exceeded` → `TS1360`）。

还有一处刻意的**不**吞异常：如果连 `run_failed` 都写不下去（日志自身坏了，`append` 再抛），
异常从生成器里逃出去。悄悄吞掉比崩溃更糟——那会让一次失败的 Run 看起来像一次正常结束的 Run。

### 5. `complete` / `partial` 的规则在这里，证据在步 6

`missingMaterial` 的**字段契约**本步定死：它是材料名字的列表，非空即 `partial`。
但它的**填充语义**不在这里——判断一条材料缺失要看执行层的失败与截断，而执行层是步 6。
所以本步它只会是空数组，`status` 恒为 `complete`。这不是还没做完，
是本步**不该**有那份证据。

为什么不直接把 `missingMaterial: []` 写死：那样 `status` 的两条分支就没有任何东西驱动，
它退化成一个常量，步 6 还得回来改 Runtime 的代码。留一条接缝
（`collectMissingMaterial(state)`，默认 `() => []`）之后，步 6 只加一个实现。
这与步 3 把 `assembleObservation` 留成接缝是同一手法：
**位置属于 Runtime，策略属于后一步。**

测试用两个断言把同一条规则的两支都跑通了：默认接缝 → `complete` + 空清单；
注入一个返回非空清单的接缝 → `partial` + 清单原样进事件。顺带证明了接缝拿到的是
`reduce` 之后的终态（观测已经在里面，所以步 6 有能力从状态里算出缺了什么）。

### 6. 身份是一个可替换的实现，而 `ask_human` 路径没有终态事件

`runId` 与 `toolCallId` 由 Runtime 生成，且**可注入**：生产用 `cryptoIds()`（随机），
测试与将来的 golden transcripts 用 `sequentialIds()`（确定、可逐字节比对）。
可注入的理由和端口一样——形状是契约，生成方式是实现。测试里有一条专门证明这一点：
换成 `cryptoIds()` 之后，事件流的**类型序列完全一致**，变的只有 id 的字面值。

关于 `ask_human`：这条路径的最后一个事件是 `human_input_requested`，
而它**不是终态事件**。这次 Run 没有结束，它挂起了（`RunStatus.awaiting_human` 本来就不是终态）。
说「每条路径都以终态事件收尾」是不准确的，准确的说法是：
**respnd / 失败两条路径各以恰好一个终态事件收尾；问到人的那条没有终态事件，
因为那次 Run 还活着。** 步 5/7 会用 `run_resumed` / `human_input_received` 把它接下去。
*（步 7 的追加：**没有接下去。** 步 5 落的是取消执法，步 7 落的是持久化与回放——
而回放会拒绝这两条事件，因为「把人的回答写进 `transcript`」的那一步状态推进仍然不存在。
一次挂起的 Run 现在能持久化、能被回放重建到挂起那一刻（`status: awaiting_human`），
但没有办法把它叫醒。见 `docs/07-durability-replay.md` 边界决定 6。上面这段不修改——
它是这一步当时的事实。）*

## 四、验证

```bash
npm run typecheck
npm test
```

`test/runtime-events.test.ts`（30 条）覆盖：

1. **形状**——`run_started` 是第一条、`sequence` 从 0 起严格 +1、`runId` 全程一致；
   一次工具调用的完整类型序列；时间戳单调且来自注入的时钟；
   `decision_made` 的条数等于模型被问的次数；
2. **因果**——模型在被问的那一刻去看日志，见到 `["run_started", "model_requested"]`
   且消费者当时只看到 1 条。这一条是**唯一**能抓住「事后补记」的断言：
   破坏性验证时故意把 `model_requested` 挪到请求之后，
   *类型序列仍然完全正确*（队列保证了送出顺序），只有这条因果断言失败了；
3. **工具**——`tool_started` / `tool_completed` 的 id 配对且两次调用不同、三条流数量一致、
   成功与失败两种 `status`、`observation_added` 带的就是进状态的那一份（含工具填不了的
   `provenance` / `truncated`）、端口抛错与工具自报错误的区别；
4. **结束方式**——四条路径（直接应答 / 工具后应答 / 问到人 / 端口抛错）逐个断言
   最后一个事件与终态事件个数；`complete` 与 `partial` 两支；
   `report` 原样透传；收工后不再问模型；
5. **失败不是异常**——流不 `rejects`；合法 `code` 保留、非法 `code` 落到 `runtime_error`；
   不是 `Error` 的抛出物也能落成事件；
6. **日志**——消费完之后整条流仍可整体断言、`read` 返回快照不共享；
   消费者半路 break 时看到的是前缀且日志不多不少不丢；有洞或重复的写入被拒绝；
   日志自身坏掉时异常逃出去（不把失败的 Run 伪装成正常收场）；
   两个 Run 不共享事件与身份、各自 `sequence` 从 0 起；
7. **身份**——换 `cryptoIds()` 语义不变、配对与唯一性照旧；`modelName` 不知道就写 `null`。

`test/no-runtime-deps.test.ts` 未改（本步不动 Core 与假适配器），仍是 6 条。
全量：`72 passed / 4 files`，`typecheck` 0 error。

## 五、刻意推迟的东西

| 推迟的 | 推迟到 | 理由 |
|---|---|---|
| 预算与取消的执法（`run_cancelled`、「中止后不再发起任何调用」） | step 5 | 本步只证明同一条 `signal` 被原样转交给模型与工具两端（有测试）；检查 `aborted` 的时机是下一脚的决定。**步 5 已落地**：交出去的信号变成「外部取消 + 墙钟」组合出来的那条，理由与证据在 `docs/05-budget-cancellation.md`。 |
| `human_input_received` / `run_resumed` | 仍未发射 | 挂起怎么被叫醒要有「谁交回答案、怎么重新进入循环」的语义，本步没有恢复入口。**步 5/7 都没能落地它**：持久化与回放到了（步 7），但回放会**明确拒绝**这两条事件，因为把人的回答写进 `transcript`（`role: "human"`）的那一步状态推进还不存在——`reduce` 只接受决策（`docs/07-durability-replay.md` 边界决定 6）。 |
| `usage_reported` | **step 8 已落地**，呈现留给 trace（步 9） | 载荷里的 token 数在步 8 之前不存在。Runtime 知道的 `toolCalls` / `durationMs` 会随 trace（步 9）呈现。**步 8 的补充**：它恰好发射一条（失败、取消路径上也有，因为一次失败的 Run 恰恰最想知道花了多少），且排在终态事件**之前**。 |
| 事件的持久化（一行一事件的 JSONL） | **step 7（已落地）** | 契约与内存实现在 `src/runtime/run-log.ts`，载体在 `src/store/run-log-jsonl.ts`。契约属于 Runtime，载体属于存储——而且**契约一行都没改**（`docs/07-durability-replay.md`）。 |
| `sessionId` | **step 7（已落地）** | 事件基础字段里**仍然没有它**，这是刻意的（见下面第 3 条的追加）：它落在会话索引 `sessions/<sessionId>.json` 里，因为「这个 Run 属于哪个会话」是存储的问题，不是事件的问题。 |
| `missingMaterial` 的填充 | step 6 | 见边界决定 5。**步 6 已落地**：`collectMissingMaterial(state)` 读三种缺失（观测带 error / 观测截断 / 有 `call_tool` 意图而无观测），与执行层的错误码住在同一个文件里——写侧与读侧必须是同一套判断（`docs/06-tool-execution.md` 边界决定 8）。 |

## 六、局限（如实记录）

1. **只有假通道。** 与本步的事件流对照的是脚本化的决策与工具桩，
   真实 provider 的方差、协议差异、凭据问题一概还没遇到。**步 8 之后仍然如此**：适配器已经接在真的 `pi-ai` 流上（真注册、真 auth 解析、真 `AssistantMessageEventStream`），但「模型」是 SDK 自带的 faux provider——真凭据那条路径（`envModelIdentity()`）写好了、一次都没跑过（`docs/08` 局限一）。
2. **`run_started` 不带 `task`。** 步 2 定的词汇如此，所以单看事件流还看不出这次 Run
   在做什么——那个问题的答案在 `Task` 的持久化（步 7）与 trace（步 9），
   本步不擅自往事件里塞字段。
   *（步 7 的追加：答案落在会话索引里——`sessions/<sessionId>.json` 存着每个 Run 的
   `Task`。需要它的地方正是回放：`replayAgentState(events, task)` 的第一个动作就是
   用这个 `Task` 构造初始状态。存储因此只存「日志答不出来的东西」。）*
3. **日志只在内存里。** 进程结束就没，事件流的「可回放」在本步是「可整体断言」，
   真正的回放（用事件重建 state 并与实时状态深对比）在步 7。
   *（步 7 的追加：这条已经过去了。日志落在 `runs/<runId>/events.jsonl`，回放由
   `replayAgentState(events, task)` 做，而它折叠事件用的是**步 3 的同一个 `reduce`**——
   于是「回放重建出完全相同的状态」在结构上成立，而不是靠测试碰运气。
   上面这段不修改——它是这一步当时的事实。见 `docs/07-durability-replay.md`。）*
4. **消费者半路 break 是一个没有名称的结局。** 日志停在半路、没有终态事件；
   本步能保证的是「日志不被消费者破坏、它看到的是前缀」。把它变成显式的
   `run_cancelled`（或者别的什么）是步 5 的事。
   *（步 5 的追加：它确实叫 `run_cancelled`，见 `docs/05-budget-cancellation.md` 第一节。
   上面这段不修改——它是这一步当时的事实。）*
5. **`durationMs` 是 `clock()` 的两次调用之差**，测试里来自计数器时钟（恒定步长），
   所以它证不了「真实耗时的精度」——只证明了它确实来自注入的时钟、且大于零。
6. **`toRunError` 不认识 provider 的词汇。** 一个带 `code: "rate_limited"` 的错误
   只有在适配器主动这么抛的时候才会被保留；映射表本身在 `src/adapter/pi/errors.ts`（**步 8 已落地**）。
