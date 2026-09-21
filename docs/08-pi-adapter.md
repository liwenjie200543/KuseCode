# Step 8 — SDK 是可替换的，而且换掉它不改变语义

> 这一步的声明（见 README 开发序列）：**SDK 是可替换的，而且换掉它不改变语义。**

这句话有个可执行的含义，它是本文所有决定的总纲：

> **把整个 `src/adapter` 目录删掉，Core 与 Runtime 仍然编译、仍然跑得完假模型。**

如果这句话成立，那么"SDK 不是架构"就不是一张图，而是一个事实。所以这一步既要**接上真的 SDK**（不然"能接"只是一句承诺），又要**让这句话可被检查**（不然它会慢慢失效）。

## 一、SDK 里有两层，选哪一层是这道题的全部

Pi Agent SDK 提供两个层次，它们回答的是不同的问题：

| 层次 | 它拥有的东西 | 与本项目的关系 |
|---|---|---|
| `@earendil-works/pi-coding-agent`（coding agent 层） | **整个循环**：它自己问模型、自己执行工具、自己把结果喂回去、自己决定停不停 | 它拥有的东西**正是步 3 已经归 Core 的东西** |
| `@earendil-works/pi-ai`（AI 层） | **一次模型请求**：`messages + tools → 一轮 assistant 消息` | 它正好是 `ModelPort.decide` 要的东西 |

用 coding agent 层实现 `decide`，等于让 SDK 拥有循环：工具由它执行、步 6 的八道关被绕开、事件顺序由它决定。那不是"把 SDK 挡在端口后面"，那是把端口拆了。所以：

- **`ModelPort` 建在 `pi-ai` 上**（`src/adapter/pi/model.ts`）；
- **coding agent 层的 `defineTool` 只用来证明反方向**（`src/adapter/pi/tools.ts`）：同一个 `ToolPort` 也能驱动 SDK 自己的循环。**双向都能走通，才叫可替换**——只证明"SDK 能被我们的循环调用"，证明的只是它是个库。

版本基线**钉死在 `0.84.2`**（`package.json` 写精确版本，不带范围）。理由不是保守：SDK 的类型就是本文那张映射表的另一半，`latest` 会让映射表在某个早上悄悄失效，而失效的形态是编译错误——那还算好的，更坏的是语义漂移而不报错。`test/no-runtime-deps.test.ts` 有一条断言把"版本必须是 `x.y.z` 精确形状"钉住。

## 二、映射表

这是这一步要求写下来的一张表。左列是 Core/Runtime 的词汇，右列是它在 SDK 里的落点。

| Core / Runtime | SDK | 落点 |
|---|---|---|
| `ModelPort.decide(state, signal)` | `models.streamSimple(model, context, options)` | `model.ts` |
| `ModelPort.beginRun?(signal)` | 一次流结束时 `AssistantMessage.usage` 的累加器 | `model.ts` + `core/usage.ts` |
| `state` → 一次请求的 `Context` | `Context { systemPrompt, messages, tools }` | `history.ts` |
| `Task` 的目标/仓库/检查维度 | `renderContext(state, tools)` 的投影，逐字段搬 | `history.ts` |
| `Message.role === "tool"` → 工具结果 | `ToolResultMessage`（带 `toolCallId` / `isError`） | `history.ts` |
| `Decision.call_tool` ← 一轮里的工具调用 | `AssistantMessage.content` 里的 `ToolCall` | `decision.ts` |
| `Decision.respond` ← `submit_report` | 一个**协议工具**的参数（TypeBox schema） | `protocol.ts` |
| `Decision.ask_human` ← `ask_human` | 同上 | `protocol.ts` |
| `ToolPort` → SDK 自己的循环 | `defineTool({ …, execute })` | `tools.ts` |
| tool schema（纯 JSON Schema） | `Tool.parameters`（`Type.Unsafe` 原样过河） | `model.ts` |
| provider 失败的说法 → `RunErrorCode` | `stopReason` / HTTP 状态码 / 错误文本 | `errors.ts` |
| `signal` 透传 | `SimpleStreamOptions.signal` | `model.ts` |
| `usage_reported` 的两个数 | `AssistantMessage.usage.input / .output` | `usage.ts` |
| 流式增量（供 trace / 呈现） | `AssistantMessageEvent`（`onEvent` 观察者） | `model.ts` |

## 三、十四个刻意做出的边界决定

### 1. 终止也是一个工具调用

`Decision` 有三种，但模型只输出两种东西：文本和工具调用。`call_tool` 天然对应后者，那 `respond` 与 `ask_human` 呢？

答案是把它们也做成工具调用：两个**协议工具**（`submit_report` / `ask_human`）。理由第三条是决定性的：**协议工具从不交给 `ToolPort`**——它们不产生观测、不碰外部世界、没有副作用，`ToolPort.names` 里也没有它们。否则"模型能决定自己去读文件"和"模型能决定自己收工"会走同一条路径，而后者不是一次工具执行。

从散文里解析 `Report`（"请以 JSON 回答"）是最脆弱的一种接口：模型会加前后缀、会用 markdown 包裹、会漏一个括号。协议工具的参数是 provider 原生的结构化输出，模型被**约束在 schema 里**。而且 `summary` 与 `claims` 在同一个参数对象里，不存在"摘要到了、证据还在下一个 token 流里"这种中间态。

参数是**不可信输入**，校验规则只有一条：

> **Core 有对应表示的，收敛到那个表示；Core 没有对应表示的，当场失败。**

于是 `evidence` 缺失 → `[]`（Core 说"空数组就是我说了但没找到依据"，这正是"模型没给证据"的正确读法）、`lines` 缺失 → `null`（Core 说整文件级证据为 `null`）、`excerpt` 缺失 → `""`（"引用了但没摘录"是一个可见的取值）。而 `summary` / `question` / `claim.text` / `evidence.path` 缺失时**没有诚实的替代品**——编一个就是伪造，所以抛 `invalid_tool` 并指名是哪个字段。

### 2. 流在 provider 出错时**不 reject**

这是本步最容易写错、也最容易骗过测试的一条协议事实：

> `AssistantMessageEventStream` 在 provider 失败时以 `{type: "error", error: AssistantMessage}` 收尾，
> 那个 `AssistantMessage` 的 `stopReason` 是 `"error"`。**它不 reject。**

所以「只看 try/catch」会漏掉**全部** provider 错误——而且漏得很安静：`final` 会被赋成那个 error message，实现继续往下走。判据是 `stopReason`，不是异常。

`test/pi-adapter-sdk.test.ts` 有两条断言守它，而它们的失败方式不同、都值得看（破坏性验证里两条都真的响了）：

- **有文本内容的报错**（真实 provider 常在错误消息里带上内容块）→ 那条消息会顺着"纯文本兜底"变成一份 `respond`：**用户收到的是 provider 的报错原文，而它看起来像一份结论**。这是这个 bug 最糟的形态。
- **空文本的报错** → 兜底也失败，于是拿到 `runtime_error`，而那本该是 `rate_limited`——错误分类丢失，Runtime 因此不会去重试一个值得重试的限流。

### 3. 重试只有一个所有者

SDK 自己有客户端重试（`ProviderRequestOptions.maxRetries`），而重试策略属于 Runtime：要按**归一化之后**的码决定值不值得重试、要计入预算、要写进事件流。

**两处都重试就会有一个没人数得清的账**（SDK 重试 2 次 × Runtime 重试 2 次 = 9 次请求，而事件流只记了 3 次）。所以适配器把 `maxRetries` 写死为 `0`，而且类型上调用方**改不了**它：

```ts
readonly options?: Omit<SimpleStreamOptions, "signal" | "maxRetries">;
```

这不是约定，是一个编译期事实。分类表在 `src/runtime/retry.ts`，判据只有一句：**重发能不能改变结果**。`rate_limited` / `timeout` / `provider_unavailable` 重试；`auth` / `invalid_tool` / `runtime_error` / `budget_*` / `no_progress` 不重试。最后一条最容易被写错——把 `budget_iterations` 拿去重试，等于一边说"预算用完了"一边继续花钱。

而 `null`（没有码）**永远不重试**：`isRetryable(null) === false`。这一行让"取消之后还在偷偷重试"在结构上不可能发生。

`maxRetries` 是**额外**次数（`2` 表示最多三次尝试），与 SDK 同名选项的约定一致——否则两个"重试 2 次"合起来变成四次而没人发现。

### 4. 错误分类：先状态码，后文本；认不出来就是 `runtime_error`

步 4 定了一条边界：`toRunError` 只接受**已经是合法 `RunErrorCode`** 的输入，它不猜、不从消息文本里认字符串——Runtime 不认识 provider。于是"认识 provider"这件事必须发生在别处，而且**只能发生一次**：`src/adapter/pi/errors.ts`。

三条实现约定：

1. **纯函数，不 import 任何 SDK 类型。** 输入是"一个 `stopReason` 加一句话"或"一个抛出物"，都是普通数据。于是 provider 错误分类里最容易错的部分，恰好是唯一**不需要真机就能逐条验证**的部分。
2. **先状态码，再文本。** 状态码是结构化的、不会撒谎的（`\b[45]\d{2}\b` 保证 `1402` 不会被当成 `402`）；文本是兜底。
3. **认不出来就是 `runtime_error`。** 不做"大概是限流吧"的猜测——猜错会让 Runtime 去重试一个不该重试的请求，而 `runtime_error` 至少是诚实的。

文本表的**顺序即优先级**，这不是随手排的：`insufficient|balance|quota|credit|billing` 必须排在 `rate_limit` 前面。有些 provider 的额度耗尽消息里同时出现 "rate limit reached for your plan"（2026-08-22 真机记录：deepseek `402 Insufficient Balance`），把它认成 `rate_limited` 会让 Runtime 重试三次，而真正的修法是去充值。所以 `402` 单独列在状态码表里，`insufficient` 单独排在文本表的第一行。

### 5. 取消不给码：归因权交回 Runtime

`signal.aborted` 时适配器抛出的错误**不带 `code` 字段**。给它一个码就等于替 Runtime 回答了一个它已经知道答案的问题，而且答得比它差——Runtime 手上有 `cause()`，能分清"用户取消"与"墙钟到点"，适配器分不清。

这条约定要靠一个**语言层面的细节**才成立：`target: ES2022` 下 `useDefineForClassFields` 默认为真，一个普通的 `readonly code: RunErrorCode | undefined` 声明会在**每个**实例上定义 `code` 属性（值为 `undefined`），于是 `"code" in error` 恒为真——"不带码"就成了一句空话。所以 `AdapterError` 用 `declare readonly code` 声明：**声明存在，字段不落地**。下游正是靠 `in` 判断该不该自己归因的。

### 6. `null` 不是 `0`，而且账本的"空"不是"未知"

deepseek 路径下 assistant message 不带 `usage`（已知缺口）。于是这里的核心判断不是"怎么换算 token 数"（那是 provider 的事），而是 **"不知道的时候要回答 `null`，而不是 `0`"**。`0` 会顺着 `usage_reported` 一路流进成本报告，把"没测到"说成"没花钱"。

**这一步在这里犯过一次错，值得完整记下来**，因为它是本步唯一一个"骗过了当时所有测试"的 bug：

第一个版本把一次 Run 的账本初始化成 `unknownUsage()`，也就是 `{ inputTokens: null, outputTokens: null }`。而 `addUsage` 是**严格**的——它把 `null` 读作"这一次没测到"，于是：

```text
null + 120 = null     ← 第一次累加就变成了"未知"
```

账本**永远是未知**，用量一个数字都记不下来。而它骗过了当时所有的测试，因为那些测试只看"没有报错"——`usage_reported` 照常发射，只是里面的两个数永远是 `null`。

修正不是把 `addUsage` 改宽松（那会让一个不完全的观测冒充总额），而是承认**"空账本"是与"零"和"未知"都不同的第三种状态**：它有它的取值，但它不会出现在答案里。规则因此只有一份，落在 `src/core/usage.ts` 的 `UsageAccumulator`：首次报账是**替换**，之后才相加。

顺带一个更大的收获：`ModelUsage` 是 Core 的类型，所以**它的运算法则也属于 Core**。原先这份算术同时写在适配器和假模型里——一个规则两份实现，这正是 bug 的藏身处。搬进 `src/core/usage.ts` 之后，"`null` 是传染源"这条规则只有一个定义点。

代价是它**丢信息**：一轮报数、一轮没报时，总和答 `null`，而我们确实看到过一个数。丢掉的是"下界"，错报出来的是"总额"——**少一个数比多一个假数好**，与 `run_completed` 不许把 `partial` 说成 `complete` 是同一条规矩。

### 7. 账本以**信号的对象身份**为键

`ModelPort.beginRun?(signal)` 是这一步新开的接缝：Run 开始时拿一个账本，每次 `decide` 往里记账。键是 **`AbortSignal` 对象本身**（`WeakMap`），因为 Runtime 把**同一条**信号同时交给 `beginRun` 与 `decide`（步 5 已经保证"同一条信号被交到两端"）。

于是"两个 Run 共享一个账本"在结构上不可能发生——不是靠调用方记得别传错 id，而是因为两条信号是两个不同的对象。`test/pi-adapter-sdk.test.ts` 有一条断言：A 跑了一轮、B 一次没跑，B 的账本必须还是"未知"。

`WeakMap` 还让条目在 Run 结束、信号被回收之后自己消失，不必有清理代码。

### 8. 一个决策只能表达一个意图 → 多个工具调用当场失败

`Decision.call_tool` 只有一个 `intent`（`reduce` 也只追一条观测），而一轮 assistant 消息里**可以有多个**工具调用。适配器**不挑一个**——多余的那个会被丢掉，而"悄悄丢掉一个模型主动发起的动作"是本项目最不能容忍的一类损失。

所以它当场抛错（`runtime_error`），消息里点名是哪几个工具、并且指出修法在 Core：**给 `Decision` 一个批量意图，而不是在适配器里挑一个。** 协议工具混在其中时也照抛不误。

`length`（输出被 `maxTokens` 截断）同理：把它当成一个 `respond` 交付出去，等于把半截话伪装成结论。`deferred` 也一样——这条通道只处理同步的一轮。

### 9. 对话从 `transcript` 翻译，但任务面**全部**来自 `renderContext`

步 3 定下：适配器构建请求时必须用 `renderContext`，而不是自己挑字段。本步遵守它的方式是**任务面的每一个字段都从投影里拿**（`goal` / `repoRoot` / `checks` / `availableTools` / `iteration`），一个都没有自己发明。

但**对话**不是从 `Context.observations` 拼的，而是从 `state.transcript` 翻译的。理由是后者严格多于前者，多出来的正是真实 provider 需要的东西：`Observation` 只说得清"哪个工具产出了这条材料"，说不清"当初读的是哪个文件"——那在 `Message.role === "tool"` 的 `intent` 里。只给结果不给请求，模型会反复读同一个文件；而 provider 的 tool-call 协议本身也要求**结果跟在对应的调用之后**。

这个取舍不会让两份真相分叉，因为 `Context.observations` 就是 `observationsOf(state.transcript)`——它是 transcript 的一个**有损投影**，不是另一个来源。`test/pi-adapter.test.ts` 里有一条断言把这件事钉住：同一份状态下，投影里的观测序列与翻译出的对话里的工具结果逐条相等。

两个细节：`toolCallId` 由**位置**推导（`call_<assistant 下标>`）而不是随机数——同一份状态每次必须翻译出同一串 id，否则回放、缓存与"同样的输入得到同样的请求"都不成立；末尾一个"有意图、没结果"的调用会补一条诚实的工具结果（"Run 在它执行期间结束了"），而不是留一个悬空调用让 provider 拒绝整次请求。

### 10. 工具声明**不在**适配器里（这一步**修正了**步 6 的预测）

`docs/06-tool-execution.md` 的推迟表里写着：每个工具自己的参数 schema 校验「推迟到 step 8」，理由是"schema 是适配器的词汇（工具描述住在那里）"。

**这个预测是错的，而错得有价值。** 实现时发现：schema 一旦住在适配器里，`src/tools` 就说不清"我能接受什么"——它的 `parse` 是对的，但没人看得见；而适配器要为每个工具写一份对外描述，于是**同一个工具的知识被劈成两半，隔着一个目录**。

结论是把 schema 交回工具自己（`src/tools/repo-tools.ts` 用**纯 JSON Schema** 写，一行 SDK import 都没有），适配器只做**一次无损失的转换**：

```ts
parameters: Type.Unsafe(entry.parameters as TSchema)
```

`Type.Unsafe` 让我们的 JSON Schema 原封不动地过河——**转换不该改变语义**。这条修正的方向与整步的主旨一致：工具的词汇不该由 SDK 决定，正如架构不该由 SDK 决定。

于是"声明"与"校验"成了两份实现（给模型看的 schema / 执行前的 `parse`），它们**不许分叉**，而这条不许靠测试守：`test/pi-adapter.test.ts` 与 `test/repo-tools.test.ts` 各有一条断言，把"声明的键 ≡ 校验收敛出的键"钉住。

### 11. 材料的身份在 `value` 里，不在 provenance 里（步 6 没想到的第三种答案）

步 6 留下的缺口是：`provenance.source` 只到工具名，说不清 `read_file` 读的是哪个文件。它当时给了两条出路——由适配器在 `ToolOutcome` 之外补，或由 `Evidence` 承担。

实现给出了**第三种**：工具把文件身份（`path` / 行号 / `totalLines`）作为**数据**放进 `value`。理由是一句话：**材料是什么，是数据；材料是什么时候、由哪次调用拿到的，是出处。** 前者模型要引用（写进 `evidence.path`），后者 Runtime 要沿用（`provenance.at` 回放时必须一致）。

所以 `read_file` 返回 `{ path, startLine, endLine, totalLines, lines: [{ n, text }] }`。行号是**原文的行号**而不是窗口内的序号——证据里的行号要能直接在文件里对上。

工具因此仍然**不许**自填 `provenance` / `truncated`（步 2 的禁令没动），`test/repo-tools.test.ts` 有一条断言检查返回的 `value` 里没有这两个键。

至于"模型抄错了路径怎么办"——那需要把 claims 里的 evidence 拿回来与观测核对。**步 9 已落地**（`src/runtime/verify.ts` 的 `auditRun`），而且它落在**工具自己**的 `material`（边界决定 11 承诺的那条）：核对器不认识任何一个工具的名字。

### 12. 每次失败都是一条**可返回的**观测，而且分类要准

三个工具的所有失败（文件不存在、路径越界、参数不对、非法正则）都从 `execute` 里**返回**，没有一条抛出去。抛出去会被 Runtime 当成"这次 Run 失败了"，而它其实只是"这次没拿到材料"——**一次读不到文件不该让整次 Run 死掉**。

分类与"返回"同样重要，两者对模型说的是不同的话：

| 码 | 含义 | 模型该做什么 |
|---|---|---|
| `invalid_args` | 你给的东西没法用 | 换个参数再来 |
| `tool_failed` | 这次没拿到材料 | 换参数也一样 |

把越界说成 `tool_failed`，模型会以为是自己运气不好而反复重试同一个越界路径。这个错**真的发生过**：路径围栏要 `repoRoot`，所以它抛在 `run` 里，而 `run` 的 catch 当时一律记 `tool_failed`。修正的办法是把判据收到**一处**（`failureOf`）——两个 catch 走同一个函数，而不是各判一次。

路径围栏本身也值得记一笔：它拦的是**解析结果**，不是写法。`a/../../x` 里没有一个字符非法，而 `a..b.md` 里含 `..` 却完全合法——查子串的实现两头都会错。判据是 `path.relative(root, target)` 的结果：不以 `..` 开头、也不是绝对路径，才说明目标真的在仓库里。

### 13. `usage_reported` 的接线被**补**上了（一个真实的覆盖缺口）

写完适配器之后发现：假模型**不实现** `beginRun`，于是所有运行时测试里 `usage_reported` 的两个数永远是 `null`——"用量数字真的从模型端口流进了事件流"这件事**一条断言都没有**，而它正是这一步新接的链路。

所以假模型加了三种用量形态（不给 / 报未知 / 报数），它们对应三种真实存在的情况，其中"不给"专门覆盖 `usageOf(null)` 那条分支。`test/runtime-events.test.ts` 新增四条断言，包括"一次 Run 恰好一条 `usage_reported`——失败路径上也有，且只有一条"。

**这个缺口不是疏忽，它的形状才是重点**：一条新链路只要"不报错"，就很容易被误认为"被测过了"。它在测试里活了一整天，直到有人去问"这个数字到底是不是真的"。

### 14. SDK 只住在 `src/adapter`（把它变成可执行约束）

`test/no-runtime-deps.test.ts` 在这一步改了，而改法本身就是一句结论：**"零依赖"变成了"恰好两个依赖，而且它们被关在一个目录里"。**

原来那条断言（`dependencies` 必须是 `undefined`）在步 8 之后会**说谎**——我们确实依赖 Pi Agent SDK 了。但它真正要守的东西没变：依赖必须少、必须被指名、必须钉死版本、必须只出现在适配器目录里。所以断言换成了四条更具体的：

1. 运行时依赖**恰好**是 `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent`；
2. 版本是精确的（`/^\d+\.\d+\.\d+$/`）；
3. `src/core` 与 `src/runtime` 不 import **任何**裸包名——不只是 SDK，一个 `import { z } from "zod"` 同样会把第三方形状带进 Core 的语义里；
4. `src/` 下面**没有**任何一个 SDK import 落在 `src/adapter` 之外。

同一条边界还从另一侧收紧了：`node:` 引用的白名单这一步从 `src/store` 放宽到 `src/store` + `src/tools`。这不是妥协，而是这条边界本来就该有的形状——"I/O 只准住在存储层"说的其实是**语义层不许有 I/O**；真实工具去读文件系统是它的职责本身，而 Runtime 仍然是零 I/O 的。所以放宽的是"谁的职责就是碰世界"，收紧的是核心语义——方向恰好相反的两件事。

**步 9 的补充（两条，方向相反）**：

- 白名单又加了一格 `src/cli`——产品面就是进程本身，它读 `argv`、写 `stdout`、接 `SIGINT`。理由是同一句：**放宽的是"谁的职责就是碰世界"**，而 Client 是那一层。
- 同一句话在**加载时间**上也成立：`src/cli` 通过 `await import("../adapter/pi/index.js")` 拿适配器，而 `kuse trace` / `runs` / `sessions` / `help` 一行 SDK 都不加载（实测 1.50s → 0.11s）。注意它 import 的是**相对路径**，不是包名——所以第 4 条断言（"SDK import 不许落在 `src/adapter` 之外"）没有被削弱：SDK 的**包名**依然只出现在 `src/adapter` 里。
- 反向又加了一条守卫：**`src/cli` 是最上面那一层，下面六层谁都不许 import 它**。它与"SDK 只准住在 `src/adapter`"是一对——一条管外来的东西不能进去，一条管上面的东西不能被拉下去。两句话都写成文件扫描（`test/no-runtime-deps.test.ts` 的两个 describe），因为写在分层图里的边界会在第一次图方便的时候失效。

## 四、验证

```bash
npm run typecheck
npm test
```

**全量：`285 passed / 11 files`（步 7 是 161），`typecheck` 0 error。**

新增与改动的测试：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/pi-adapter.test.ts`（新） | 63 | 纯映射层：错误归一（状态码 / 文本 / 中止 / `402` 优先于 `429` / 不认识就 `runtime_error`）、`decideFromMessage` 的全部收场（文本 / 单调用 / `submit_report` / `ask_human` / 多调用 / `length` / `deferred` / 空文本）、协议参数校验（缺哪个字段收敛成什么、缺哪个字段当场失败）、用量三态与算术（含"`null` 不是加法单位元"那一组）、对话翻译（投影字段、观测↔工具结果逐条相等、id 由位置推导、悬空意图补结果、失败与截断可见）、工具目录（撞名当场失败、schema 与 parse 不分叉）、纯度 |
| `test/pi-adapter-sdk.test.ts`（新） | 15 | **真通道**：接在 `pi-ai` 的 `fauxProvider()` 上——它是真 provider，走真的注册、真的 auth 解析、真的 `AssistantMessageEventStream`，只是"模型"由脚本给。覆盖三种收场的真流解码、`stopReason: "error"` 不 reject 的那条协议事实（两条，见边界决定 2）、`402` 优先于 `429`、我们喊停时错误不带码、账本三态与两 Run 隔离、请求形状（systemPrompt / 任务消息 / 工具声明 / `maxRetries === 0` / 第二轮带着第一轮的工具结果并挂回对应调用）、协议工具不在 `ToolPort` 名单里；外加一条**编译期证明**（`maxRetries` 调用方写不进去） |
| `test/repo-tools.test.ts`（新） | 37 | 真文件系统（临时目录夹具）：围栏的七种写法（含 `a..b.md` 这种"含 `..` 的合法名字"、`src/..` 恰好在根内）、`read_file` 的行号/窗口/上限/空窗口、`list_dir` 的不递归/排序/噪声目录/`omitted`、`search_text` 的命中/大小写/跳过噪声与二进制/`maxMatches`/非法正则、schema 校验与 allowlist、取消 |
| `test/runtime-events.test.ts` | 35（+4） | 用量从端口流进事件流：有一轮没报 → 总和未知、每轮都报 → 各轮之和、没有账本 → `null` 不是 `0`、失败路径上也恰好一条 `usage_reported` |
| `test/no-runtime-deps.test.ts` | 14（6→14） | 依赖形态四条 + `src/core`/`src/runtime` 零裸包名 + SDK 只在 `src/adapter` + `node:` 白名单 |
| `test/pi-adapter.test.ts` 的夹具 | — | `stateWith` 从"只造 `tool` 消息"改成**成对的** `assistant(call_tool)` → `tool(obs)`。夹具比真实形状宽松，测出来的就不是真实行为——这条断言正是用错误的方式写的时候才发现实现是对的 |

### 破坏性验证（改动已还原，每条都有断言当场失败）

| 破坏 | 响了什么（实测） |
|---|---|
| 把账本初始化回 `unknownUsage()`（那个真犯过的错） | **4 条**：`expected null to be 300` / `expected null to be 1200`——`pi-adapter-sdk` 的三条用量断言全变成 `null`，`runtime-events` 的"各轮之和"也塌了 |
| 让 `AdapterError` 用普通字段声明 `code` | **1 条**：「我们喊停时错误不带码」——`expected AdapterError: This operation was aborted { code: undefined } to not have property "code"`。`"code" in error` 恒为真 |
| 只写 try/catch、不看 `stopReason` | **6 条**。而失败方式正是预测的两种，各出现一次：① 有文本内容的报错 → `expected true to be false`，也就是**一次 `ok: true` 的交付**，用户拿到的是 provider 的报错原文；② 空文本的报错 → `expected 'runtime_error' to be 'rate_limited'`，分类丢失 |
| 让 `run` 的 catch 一律记 `tool_failed` | **4 条**：`expected 'tool_failed' to be 'invalid_args'`——这就是修 `failureOf` 之前**真实存在**的状态 |
| 适配器放开 `maxRetries` | 编译失败：`test/pi-adapter-sdk.test.ts(51,3): error TS2578: Unused '@ts-expect-error' directive.`——所有权一放开，那条编译期证明立刻报"多余" |
| 把 SDK 的 import 放进 `src/runtime`（加一个探针文件） | **2 条**：`src\runtime\__probe.ts 引用了包：@earendil-works/pi-ai`、`只有 src/adapter 可以 import SDK`。两条守卫各挡一次 |

### 编译期验证

- **`maxRetries` 的所有权**：`Omit<SimpleStreamOptions, "signal" | "maxRetries">` 让"适配器不许放开重试"成为类型事实，不用断言。
- **`AdapterError.code` 的存在性**：`declare` 与普通字段声明的差别在编译后是一行 `Object.defineProperty` 的有无，所以它只能靠运行时断言（上表第二行）——**这正是"语义要求写成声明"会失效的那一类地方**。
- **API 表面**：`pi-ai` 的 `streamSimple` / `Tool` / `TSchema` / `AssistantMessageEvent` 任一改名都会让适配器编译失败，而 Core 与 Runtime 一行都不动——这本身就是"删除 `src/adapter` 后仍然编译"的反面证明。

## 五、刻意推迟的东西

| 推迟的 | 推迟到 | 理由 |
|---|---|---|
| 真机验证（真 provider、真凭据、真网络） | 有凭据的那一步 | `envModelIdentity()` 已经写好（从 `KUSECODE_MODEL` 读 `provider/model`），但**没有凭据就没有真机会话**。所以这一步证明的是"通道能接、映射成立"，不是"接上某个具体 provider 也对"。见局限一 |
| `cacheRead` / `cacheWrite` / `reasoning` / `cost` | 有价格表的那一步 | `usage_reported` 的字段是步 2 定下的，成本换算需要价格表——那是产品面的事。代价见局限三 |
| claims 里的 `evidence.path` 与观测的核对 | **step 9 已落地** | 材料的身份已经在 `value` 里（边界决定 11），核对所需的东西齐了——预测成立。落点：`auditRun(事件, materialReader(toolbox))`，判据是**包含**（读了 1-2 行不能支撑引用 1-40 行），而且它核对的是"这些行我们真的看到过吗"，不是"这条论断对不对"（`docs/09-cli-trace.md` 三、决定 9） |
| 批量意图（`Decision` 表达多个工具调用） | 有并行工具调用需求时 | 适配器选择**当场失败**而不是丢（边界决定 8）。修法在 Core，不在适配器 |
| trace 呈现 `onEvent` 收到的流式增量 | 仍然推迟 | 适配器已经把事件交出去了（`onEvent` 观察者），而 **step 9 的 `progressLine` 读的是产品级事件**（`AgentEvent`），不是适配器的流式增量——那一层粒度更细，今天没有消费者 |
| `vision` / 图像输入、`thinking` 块的语义 | 有需求时 | `fauxThinking` 与多模态内容类型在 SDK 里存在，但本项目的 Task 是"读代码"，没有消费者 |

## 六、局限（如实记录）

1. **没有一次真机验证。** 全部测试跑在 `fauxProvider()` 上——它是**真 provider**（真注册、真 auth 解析、真事件流），但"模型"是脚本。所以"provider 的方差"这一档完全没覆盖：真 provider 的流式分块节奏、`usage` 的字段差异（deepseek 那条缺口就是真机记录）、协议实现上的小偏差，都要等一次带凭据的运行。`envModelIdentity()` 是那条路径的落点，**它今天没有被执行过**。
2. **`submit_report` 的 schema 依赖 provider 的 schema 支持。** `Type.Unsafe` 原样过河，但**不是每个 provider 都完整支持 JSON Schema**（尤其是 `Type.Tuple` 那样的联合）。真机上 `lines: [起, 止]` 有可能被某些 provider 简化成 `array`，那时模型的输出会更依赖 `lines` 的运行时校验（它已经在了）——这一点没有验证过。
3. **成本算不出来。** token 数有两项（`input` / `output`），价格不在里面，`cacheRead` / `cacheWrite` 被丢掉。所以 `usage_reported` 能回答"花了多少 token"，不能回答"花了多少钱"。这是刻意的（价格表属于产品面），但它意味着**成本报告今天只能做到 token 级**。
4. **`null` 会吃掉"下界"。** 只要有一轮没报数，整个 Run 的用量就是未知（边界决定 6）。更诚实但也更复杂的分层（"至少 N，其中有 k 轮未报"）没有做——今天只有两个数的位置，它们的选择是"宁可少一个数"。
5. **`src/tools` 的三个工具是**同步阻塞的**。** `readFile` / `readdir` 走 `node:fs/promises`，但取消只在**调用前**检查：文件系统调用本身不可中断（`docs/06` 边界决定 3 的同一个事实）。一个超大文件的读取会让取消等它读完。
6. **`search_text` 的上限是"防呆"而不是"精确"。** `MAX_SCANNED_FILES = 2000` / `MAX_MATCHES = 100` 会在遍历中途停下，`stoppedEarly` 是可见的，但"跳过了多少"不可见——大仓库上模型的搜索会得到偏斜的结果。
7. **`read_file` 的 400 行上限与 `endLine` 是调用方的责任。** 工具会照实报 `totalLines`，但一个只看 `lines` 的模型不会意识到自己拿到的是窗口。今天靠 system prompt 的提醒，没有结构性保证。
8. **假模型与真适配器的账本实现是两处接线。** 规则只有一份（`core/usage.ts`），但"什么时候记一笔"（`decide` 返回之后 vs 流结束之后）在两侧各写了一次。真适配器在流结束、解码之前记；假模型在决策返回之后记——对同步脚本等价，对"解码抛错的轮次"不等价（真适配器**照记**，因为钱确实花了）。这条差异没有被测试覆盖。
9. **`pi-coding-agent` 那一层的替换性只证到 `defineTool`。** `tools.ts` 证明了同一个 `ToolPort` 能驱动 SDK 自己的循环，但**没有跑过一次完整的 SDK 会话**（那需要真凭据）。所以"双层都可替换"这句话，一层是完整的，另一层是结构性的。
10. **两个 SDK 包都进了 `dependencies`，而 `pi-coding-agent` 今天只被 `tools.ts` 用到。** 它的体量不小，且 `--ignore-scripts` 安装（沙箱里 npm 的 postinstall 被拦）。真要用它跑 SDK 自己的循环时，这条安装方式需要重新确认。
