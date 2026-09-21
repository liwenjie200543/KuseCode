# 步 10：golden transcripts —— 「SDK 升级不会悄悄改变语义」的可执行形式

> 提交：`test: golden transcripts`
> 新增：`test/golden/{corpus,harness,golden.test}.ts` + `test/golden/pinned/*.json`（24 份固定件）
> 顺带修了一个被语料逼出来的真问题：`search_text` 的遍历顺序依赖文件系统。

## 1. 这一步回答的问题

README 的原始定义：*record 5–10 golden runs as pinned event transcripts, replay through both
fake and real adapter encode/decode paths.* 翻译成可以失败的断言，就是两件：

1. **语义没有静默变化**：8 条语料的运行产物（事件日志、trace、最后一次请求）被逐字节
   写在 `test/golden/pinned/`。任何一层改了行为——Core 的循环、执行层的八道关、
   适配器的翻译——固定件比对立刻响。
2. **SDK 是可替换的**：同一份语料走两条互不相干的路——假模型端口（无 SDK）与真
   `pi-ai` 流 + 适配器（生产路径）——产出的事件日志必须逐字节相同。

## 2. 结构：语料是中性的，两条路各自解释

```
corpus.ts（纯数据：剧本 DSL，无一行 SDK、无一行 node:）
    │
    ├── driveCore：剧本 → Decision → 假模型端口 → Core 循环
    │
    └── driveSdk ：剧本 → AssistantMessage → 真 pi-ai 流 → 适配器 → Core 循环

两条路共用：同一批工具、同一个执行层（createToolRunner）、同一套预算、
固定时钟、固定身份（sequentialIds("golden")）、同一条内存日志。
于是两份日志的差异只可能来自适配器——这正是等价性有含义的原因。
```

**为什么剧本不直接写 `Decision`**：如果直接写，SDK 路就变成"把 Decision 编码成消息再
解码回来"，而编码器是测试自己写的——两个方向都由我们写，一致性就可能是巧合。
中性剧本让假模型自己造 `Decision`、适配器从流里造 `Decision`，两边独立，日志对账。

## 3. 语料的 8 条覆盖面

| # | 名字 | 钉什么 | 终局 |
|---|------|--------|------|
| 01 | complete-report | 最平常的一条：列目录→搜文本→读文件→交结论 | complete |
| 02 | partial-tool-failure | 工具失败被隔离：Run 继续、结论照交、缺失材料被点名 | partial |
| 03 | partial-truncation | 观测被截断：`truncated` 为真，材料只拿到一部分 | partial |
| 04 | provider-error-retried | 限流重试一次后成功：`model_requested` 出现两次 | complete |
| 05 | provider-error-permanent | 凭据错误不重试：一次请求就结束 | run_failed{auth} |
| 06 | budget-tool-calls | 工具预算到顶：第三次调用在 `tool_started` 之前被拦 | run_failed{budget_tools} |
| 07 | cancelled-external | 外部取消落在工具执行中间 | run_cancelled |
| 08 | awaiting-human | 挂起：`human_input_requested` 而没有终态事件 | 挂起（≠结束） |

覆盖面测试断言这五种收场每一种都恰好出现，且 `completed/partial` 至少两条
（工具失败与截断是两种不同的 partial，各自要有人看着）。

固定件与语料**一一对应**（没有孤儿、没有缺件）——删掉一条语料而忘了删固定件，
或者反过来，都会响。

## 4. 确定性：固定件能存在的前提

固定件是逐字节比对，所以任何不来自语料的随机性都会让测试变成掷骰子。
语料逼出了两处：

- **`search_text` 的遍历顺序**原本取决于文件系统（`readdir` 的返回顺序）。
  修复（`src/tools/repo-tools.ts`）：`byName` 在读目录项之后按名字排序，
  每条命中的来源文件因此唯一。这不是为了测试好看——CLI 的输出顺序本来就是
  产品行为，它只是第一次被钉住了。
- **时钟是常量**（`GOLDEN_NOW`）：`provenance.at` 由适配器写，假模型没有适配器；
  只有固定时钟能让两条路的 `at` 天然相等。事件顺序由 `sequence` 钉住，
  "时间戳随时间前进"由步 4/5 的计数时钟测试单独钉住——两件事分开钉，都钉得住。

每条语料还有一条**确定性自检**：同一条 SDK 路跑两遍，逐字节相同。

## 5. 归一化：什么不进比较，什么必须进

- **抹掉 provider 的 token 数**：真流里的 `usage` 是 provider 自己算的（faux 按文本
  长度给数），假模型根本没有账本（两项是 `null`）。这是"谁有能力知道"的差异，
  不是语义差异，等价性比较里换成 `"<provider>"`。但它们**真实的数字仍被固定件钉住**
  （`pinned/*.events.json` 是 SDK 路产出的）。`toolCalls` 与 `durationMs` 不抹——
  它们是 Runtime 自己数的，两条路必须一致，抹掉等于放弃一条断言。
- **抹掉夹具的绝对路径**：前缀式替换成 `<repo:demo>`，漏进来的其他绝对路径照样显形。
  泄漏检查带**正向对照**：占位符必须真的出现在 `request` 固定件里，否则
  "没有泄漏"可能只是因为那里本来就没有路径。它只出现在 request 里不是巧合：
  事件与 trace 里工具返回的都是仓库相对路径，`run_started` 不带任务面字段。
- **请求固定件只钉我们决定的三样**（`systemPrompt`/`messages`/`tools`）：
  不导出 SDK 的 `Context` 本身——SDK 升级顺手加一个可选字段不是语义变化，
  固定件应该对语义敏感、对无关的变化无所谓。

## 6. 记录语料时撞到的真差别：取消被谁先发现

把"外部取消"放进语料的第一次尝试失败了：**两条路停在不同的地方**。

- 真流的 `AbortSignal` 是"流"自己看着的：请求被取消时以 `stopReason: "aborted"`
  收尾，取消在 `decide` **里面**就被认出来——那一轮**没有** `decision_made`；
- 假模型端口没有人看信号，它照常返回决策，取消落在下一个检查点上——那一轮**有**。

终态在两条路上都是 `run_cancelled`，但事件条数差一条。这不是缺陷，是一个真实的
差别：**谁先发现取消，决定了那一轮有没有决策事件**。处理方式：

- 语料（07）把取消挪到**工具执行期间**（`cancelAtTool`）——取消由两条路**共用的**
  执行层发起，谁都没有"先发现"的优势，日志等价；
- "取消落在模型请求中间"由 `golden.test.ts` 里一条专门测试单独钉住：
  终态一致，但假模型路多交出一次决策（2 对 1）。

## 7. 步 9 的消费者也在语料上过了一遍

`auditRun`（证据核对）与 `collectMissingMaterial`（缺失清单）在语料上各有断言：

- 01：`total` 数的是**证据条数**（1），不是论断条数（2）；`evidence: []` 的那条
  落在 `unbacked`（1）——"没有依据"与"没看过的行"是两个不同的状态，所以
  `ok=false` 是对的：没有依据这件事必须可见；
- 02：工具失败不改终态的形状，但缺失清单点到了 `read_file` + `invalid_args`；
- 03：截断让 `conclusive=false`——那条断言"找不到"，但不能被说成"没看过"。

## 8. 录制是显式动作

```bash
KUSE_RECORD_GOLDEN=1 node node_modules/vitest/vitest.mjs run test/golden
```

录制模式只在这一个环境变量下生效；平常跑测试一律比对。固定件是**被审阅过的断言**，
不是随时可以刷新的缓存——失守时先读差异，再决定是"故意改的（重录）"还是
"不小心改的（改回去）"还是"SDK 改的（这正是要防的事）"。

## 9. 验证

- 408 passed / 16 files（golden 贡献 16 条：8 条语料 + 1 条取消差别 + 4 条覆盖面
  + 1 条泄漏 + 3 条核对/缺失 + 1 条录制自检）；
- `tsc --noEmit` 0 error；`tsc -p tsconfig.build.json` 通过；
- 破坏性验证（改完再还原，全部按预测失败）：
  - 删掉 `byName` 排序 → 03 之外某条语料的固定件比对失败（遍历顺序真的会变）；
  - `comparable` 不抹 token 数 → 全部等价性断言失败；
  - `maskRepo` 换成恒等 → 泄漏测试的 `kuse-golden-` 检查失败；
  - 语料 07 改回 `cancelAtCall` → 等价性失败（事件条数差一条）——正是第 6 节的差别。

## 10. 局限

1. **`excerpt` 内容不核对**：引用的行号区间读过没有可以判，区间里写的是不是那句话
   需要另一个模型——记在 `docs/09-cli-trace.md` 局限三，本步不覆盖；
2. **真 provider 不在固定件里**：faux 流是 SDK 自带的假"模型"，它的 `stopReason`
   行为与真 provider 的一致性由 SDK 自己保证——固定件钉的是**我们的**翻译层；
3. **重录全靠人**：没有"部分重录"机制，改一条语料就重录全套（8 条很快，够了）；
4. **挂起路径（08）在恢复侧没有语料**：`human_input_received`/`run_resumed` 仍然
   明确抛错（步 7 的决定），恢复语义等到有实现的那天再钉。
