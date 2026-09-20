# Step 3 — 最小循环：用假适配器跑通

> 这一步的声明（见 README 开发序列）：**循环在没有进程、网络、数据库和 UI 的情况下跑完。**

本文回答的是「为什么循环长这样」，不是「API 怎么调」。每加一条约束之前，先回答它守住了
哪条第一性原理；回答不出来的约束就是过早抽象。

## 一、循环的形状

```text
Task → Context → 模型决策 ─┬→ call_tool → 工具执行 → ToolOutcome → Observation → 状态推进 → 下一轮
                           ├→ respond   → 状态推进 → 收工
                           └→ ask_human → 状态推进 → 停在人类那一侧
```

对应到代码只有四样东西：

| 名称 | 是什么 | 不是什么 |
|---|---|---|
| `step(state, deps, signal)` | 一次「问模型」，产出 `Decision` | 不推进状态、不执行工具 |
| `reduce(state, decision, observation?)` | **唯一**的状态推进函数，纯的 | 不读时钟、不写 I/O、不看全局 |
| `isTerminal` / `isAwaitingHuman` / `hasProgress` | 三个谓词：什么时候停、停在哪一侧、这一轮算不算白转 | 都不执法——执法在 Runtime |
| `runCoreLoop(initial, deps, signal)` | 每轮产出 `{decision, observation, state}` 的 generator | 不设上限、不记账、不持久化 |

`observationsOf` / `renderContext` 是两个投影：状态是唯一真相，观测列表与「模型能看到什么」
都从它派生，不另存副本。

## 二、四个刻意做出的边界决定

### 1. Core 不设迭代上限

循环的边界**只由模型给出的终态决策决定**：`respond` 或 `ask_human`。Core 里没有
`maxIterations`、没有墙钟、没有重试。理由是分工：循环回答「一步之后发生什么」，
Runtime 回答「这次 Run 允许走多远」——把上限写进 Core，等于把「预算」这种产品策略
焊死在语义里。

`test/core-loop.test.ts` 里的两行编译期证明是这条决定的可执行版本：

```ts
const coreTakesNoBudget: [Extract<BudgetVocabulary, keyof LoopDeps>] extends [never] ? true : false = true;
const coreDepsAreExactlyTwoPortsAndOneSeam: [keyof LoopDeps] extends ["model" | "tools" | "assembleObservation"] ? true : false = true;
```

谁给 `LoopDeps` 加上 `budget` / `maxIterations` / `timeoutMs`，或者往依赖里多加一样东西，
这里就编译不过。

「有界迭代」因此在测试里的含义是：**上限来自脚本，而不是来自循环**——
21 条决策必须一条不少地跑完（任何内置上限都会让它失败），而循环多走一轮时，
脚本用尽会立刻炸出 `FakeScriptExhaustedError`。

### 2. 组装观测的接缝在 Core，组装策略在 Runtime

`ToolOutcome`（工具能说什么）与 `Observation`（进状态的那一份）是分开的，步 2 已经用
`provenance` / `truncated` 把这个分界钉死。本步要回答的是：**谁来组装？**

答案是 `LoopDeps.assembleObservation`——一条**接缝**，不是一段实现。Core 拥有的是
「组装这件事必然发生在工具与状态之间」这个位置，实现属于 Runtime（步 6 的 tool-runner）。
于是：

- 假适配器在步 3 就能把 `provenance` 补上，因为**工具没法自己填**（它只有 `{value, error}`）；
- 步 6 把校验、超时、截断接进来时，Core 不需要改一行；
- Core 里没有一行代码知道截断阈值——因为它不认识截断。

### 3. 一轮产出两次：意图先于执行

工具调用那一轮的产出顺序是：

```text
{ decision: call_tool, observation: null, state: 进入这一轮的状态 }   ← 意图已下，工具还没跑
{ decision: call_tool, observation: <观测>, state: reduce 之后的状态 }  ← 执行结束，观测已回
```

为什么不让执行发生在第一次产出之前？因为**驱动方必须能在工具开跑之前拿到决策**。
否则 `decision_made` 只能排在 `tool_completed` 后面——事件流的顺序与真实因果相反，
`tool_started` 的时间戳也成了事后补的。一条可审计的日志不接受这两件事；
「工具跑到一半被取消」这种状态，也只有在这个顺序下才表达得出来（有意图、无观测）。

代价是驱动方要按 `observation === null` 区分这两次产出——这是显式契约，不是巧合。
另有一个便利：`model_requested` 不必由循环产出，驱动方把 `ModelPort` 包一层即可在
**真正发起请求的那一刻**发射它，顺序与时间戳都自然成立。

### 4. `reduce` 是唯一的状态推进函数

实时执行（步 4）、事件回放（步 7）、单元测试（本步）全都走 `reduce`。这不是「共享代码」，
是**结构上的证明条件**：只要存在第二份「等价实现」，「回放重建出完全相同的 `AgentState`」
就只能靠测试碰运气，而不能由结构保证。

因此它是纯的：不改入参（测试用 `Object.freeze` 固化这一点）、不读时钟、同样的输入永远
给同样的输出。一个副产物是 `iteration` 的语义被定死：**它数「已经走过几轮」，不是
「还剩几轮」**——所以它不能当预算用，也就不会偷偷变成预算。

## 三、验证

```bash
npm run typecheck
npm test
```

`test/core-loop.test.ts`（23 条）覆盖：

1. **循环的形状**——一轮两次产出，且顺序是「意图先、观测后」；`step` 自身不推进状态；
2. **观测回填**——观测以 Core 的词汇落进 transcript（`role: "tool"` 携带 `intent` 与
   `observation`），并且**下一轮模型收到的输入里已经有它**；再加一条行为证明：让第二次
   决策依赖第一次的观测，观测没回填就必然失败；
3. **终止判定**——三个 `kind` 的终态性；问到应答即收工（脚本剩下的部分不会被碰）；
   `ask_human` 落在状态层后，拿着同一个状态再驱动一次，一次模型都不会再问；
4. **有界迭代**——21 条决策跑完（无内置上限）；脚本用尽即报错，且报错位置精确到
   「第 2 次 decide」，让「多走一轮」可见；
5. **`reduce` 的纯度**——冻结入参不被改写、两次调用深相等、每轮 `iteration` +1、
   观测缺失时只留意图不伪造空观测、非终态决策越过待答问题；
6. **`hasProgress`**——拿到新观测才算前进，只推进 `iteration` 不算；
7. **依赖面**——两行编译期证明（无预算字段、依赖面恰好是两端口一接缝）；
8. **取消信号**——同一个 `signal` 转交给模型与工具两端；Core 不自己判中止（见下文局限）；
9. **`renderContext`**——模型可见字段恰好六个，不含任何策略字段；
10. **工具失败**——未知工具被端口拒绝且从未被执行、工具自报错误，两种都只是观测，
    循环继续，Core 不崩。

`test/no-runtime-deps.test.ts`（6 条）守住本步的命题本身：

- `src/core` 与 `src/testing` 的文件**不引用任何包**、不引用 `node:` 内置模块、不越出 `src/`；
- `test/core-loop.test.ts` **只 import vitest / core / testing**，也不 import `node:` 内置模块。

第二条是这台扫描仪存在的理由：`test/core-loop.test.ts` 是「Core 能在没有进程、网络、
数据库的情况下跑完」的证据，而它的证明力取决于它自己引用了什么——它一旦 import 了
`node:fs` 或某个 SDK 客户端，它证明的就成了「测试环境里什么都有」。

## 四、驱动方怎么消费这个 generator（给步 4 的接口说明）

```text
gen.next()                     → run_started 之后的第一轮
  yield { decision, null, s0 } → decision_made + tool_started        （意图）
  yield { decision, obs,  s1 } → tool_completed + observation_added  （结果）
  yield { decision, null, s2 } → decision_made                        （终态：respond）
  done, return s2              → run_completed / human_input_requested
```

三条约定：终态判断用 `isTerminal(turn.decision)`；`observation === null` 的 `call_tool`
产出**不需要**推进状态（`turn.state` 仍是进入这一轮的状态）；generator 的返回值就是终态，
`for await` 拿不到它，要读它就用 `next()` 手动驱动。

## 五、刻意推迟的东西

| 推迟的 | 推迟到 | 理由 |
|---|---|---|
| 人工回答如何进入 transcript（resume 的 `reduce` 形状） | step 4/5 | 本步只把问题记进 `pendingQuestion`：`ask_human` 之后循环停住、一次模型都不再问。「谁把回答交回来」是挂起/恢复的语义，在没有驱动方之前设计它只是猜。 |
| 截断、参数校验、单次调用超时 | step 6 | 它们是执行层的执法，本步的假组装点只组装。 |
| 预算、取消执法、`no_progress` 的判定 | step 5 | 谓词已在这里（`hasProgress`），执法在驱动方。 |
| `Context` 的生产消费者 | step 8 | 本步由测试固定住投影的形状，免得适配器自己发明第二套。 |
| `ToolOutcome` 的耗时、`toolCallId` | step 4/6 | 时间是 Runtime 的词汇，Core 不认识它。 |

## 六、局限（如实记录）

1. **只有假通道。** 本步没有任何真实模型与真实工具；「循环能跑完」是在脚本化的决策与
   工具桩上证明的。真实 provider 的方差、协议差异、凭据问题一概还没遇到。
2. **`ask_human` 只到状态层。** 问题被记下、循环停住；真实的挂起与恢复（谁交回答案、
   怎么重新进入循环、事件流如何记录）在步 4/5。
3. **`provenance.at` 在测试里来自确定性时钟**（`fakeClock`），不是真实时间。
   真实时钟在 Runtime 那一侧；测试刻意不读 `Date.now()`，否则「回放幂等」无从断言。
4. **假组装点恒为 `truncated: false`。** 它不假装截断发生过——步 6 才做截断。
5. **Core 不自己检查 `signal.aborted`。** 循环拿到一个已中止的信号也会按脚本走完；
   取消的执法（在每轮之间检查，或由端口实现在途打断）是步 5 的决定。
   若那时把检查移进循环，`test/core-loop.test.ts` 里那条测试是第一个要改的地方。
6. **`hasProgress` 只看观测数量。** 「模型原地打转、每次都拿到一模一样的观测」这种空转
   它抓不到。等真实运行给出证据再决定要不要加内容比对——现在加属于凭想象设计。
