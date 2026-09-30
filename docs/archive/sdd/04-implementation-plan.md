# SDD · Phase 3 — Implementation Plan

> 依据：`02-spec.md`（需求）、`03-architecture.md`（技术方案）。
> 本文把重构拆成 **17 个任务**：每个任务足够小、可独立验证、可独立提交；
> 顺序即执行顺序（依赖关系标注在每项）。
>
> 执行规则（每个任务完成后必须走完这九步，全部通过才允许 commit）：
> 1. 修改代码（只碰"修改范围"列出的文件）；
> 2. 编写或更新测试；
> 3. 运行相关测试（`npx vitest run <相关文件>`）；
> 4. `npm run typecheck` +（触及构建面时）`npm run build`；
> 5. 对照 Specification 检查是否违反（特别是 NFR-1 事件溯源不变量、NFR-5 零新增依赖）；
> 6. `git diff` 检查无无关修改；
> 7. 更新 `docs/sdd/00-progress.md` 与受影响文档；
> 8. 提交独立 commit（Conventional Commits，scope 沿用仓库约定）；
> 9. 任何测试失败：修复当前任务，不进入下一个。
>
> 行为变化的唯一预期来源：T6（token 预算默认设防，spec §4.11 已声明）与
> T7–T10（恢复语义激活，spec §4.11"激活而非新增"）。其余任务必须是
> **行为等价**的——既有测试与 golden 固定件一字不动地全绿就是证明。

---

## 任务总览

```text
T1 守卫 ──→ T2 测试基建 ─┬─→ T3 配置层 ─────────┐
                        └─→ T4 投影词汇 ─→ T5 投影接入 ─→ T6 预算设防 ─┐
T7 reduceHumanInput ─→ T8 回放激活 ─→ T9 resume ─→ T10 golden 恢复      │
T11 Toolbox 升格（独立）───────────────────────────────────────────────┤
                                                                      ↓
                              T12 装配层 ←（T3 T5 T6 T9 T11 全部就绪）
                                ↓
                    T13 CLI 换装配 → T14 answer 命令 → T15 桌面换装配
                                ↓
                          T16 任务级 e2e → T17 工程整理收尾
```

规模参考：T1/T2/T6/T10 ≈ 半小时内的小任务；T4/T9/T12 是核心任务（最大）；
其余中等。

---

## T1 · 契约测试扩展：把新模块纳入禁线扫描

| 项 | 内容 |
|---|---|
| **目标** | 在写任何新代码之前，把 `toolbox.ts`、`config/`、`bootstrap/` 纳入 no-SDK 禁线扫描与 core 零依赖扫描（守卫先行，后续任务在守卫下工作） |
| **修改范围** | `test/no-runtime-deps.test.ts`；`test/core-types.test.ts`（若其目录扫描需要覆盖 `core/project.ts`） |
| **依赖** | 无 |
| **实现方式** | 既有扫描逻辑是目录清单驱动；把三个新路径加进清单（模块此刻尚不存在，扫描逻辑对不存在的路径跳过或以"登记即承诺"的清单形式存在——按既有测试的结构选择最小改法） |
| **验收标准** | 既有测试全绿；新清单生效（对临时创建的含 SDK import 的文件能红） |
| **测试方式** | `npx vitest run test/no-runtime-deps.test.ts test/core-types.test.ts` + 一次性破坏性验证（验证后还原） |
| **对应 Spec** | NFR-2 |

## T2 · CLI 测试去 dist 化

| 项 | 内容 |
|---|---|
| **目标** | `test/cli.test.ts` 不再依赖 `npm run build` 先行（fresh clone 上 `npm ci && npm test` 全绿） |
| **修改范围** | `test/cli.test.ts`（必要时 `bin/kuse.mjs` 只读调整） |
| **依赖** | 无 |
| **实现方式** | 先调查 2 个超时用例的加载路径（spawn `bin/kuse.mjs` 还是进程内 `main()`）；方案 A：全部改为进程内 `main(argv, io)`（vitest 原生跑 TS 源码）；方案 B：测试 setup 里固化 build 前置。优先 A（更快、更符合"产品面可测"的既有立场） |
| **验收标准** | 干净环境（无 dist/，`rm -rf dist` 后）`npx vitest run test/cli.test.ts` 全绿 |
| **测试方式** | `rm -rf dist && npx vitest run test/cli.test.ts`；随后全量 `npx vitest run` |
| **对应 Spec** | FR-6.3 |

## T3 · 配置层

| 项 | 内容 |
|---|---|
| **目标** | 四层配置（flag > env > file > default）与手写守卫 |
| **修改范围** | 新增 `src/config/loader.ts`、`src/config/schema.ts`、`test/config.test.ts`；`src/index.ts` 导出 |
| **依赖** | T1 |
| **实现方式** | 按 architecture §3.4：`defaultConfig` / `parseConfigFile`（未知键与疑似秘密 → 警告数组）/ `mergeConfig`（DeepPartial 逐字段）；默认值表按 architecture §3.4；**不引入任何依赖** |
| **验收标准** | 四层优先级正确；类型错误报可操作信息；未知键警告不失败；秘密字段警告；零依赖 |
| **测试方式** | 新增 `test/config.test.ts`（覆盖上述全部路径）；`no-runtime-deps` 自动覆盖 |
| **对应 Spec** | FR-5、NFR-3、NFR-5 |

## T4 · 对话投影词汇（Core）

| 项 | 内容 |
|---|---|
| **目标** | 确定性对话投影：`projectConversation` / `estimateTokens` / `ProjectionPolicy` / `ProjectedTurn` |
| **修改范围** | 新增 `src/core/project.ts`、`test/project.test.ts`；`src/index.ts` 导出 |
| **依赖** | T1 |
| **实现方式** | 按 architecture §3.1：轮定义（decision+观测+human 消息）、切点只在轮边界、折叠摘要携带证据结构、`[已折叠]` 可见标记；**核心不变量：无折叠发生时产物与现状全量翻译逐字节等价**（这是 T5 接入后 golden 不破的前提，此处在单测里直接断言） |
| **验收标准** | 确定性（同输入同输出）、有界性（超预算时估算入界）、保护窗口（最近 K 轮永远 verbatim）、全函数（任意合法状态不抛错）、无折叠时与全量等价 |
| **测试方式** | `test/project.test.ts`：等价性/确定性/有界性/证据保全/折叠标记/human 消息与 call_tool 意图不被拆散 |
| **对应 Spec** | FR-1.1、FR-1.2、FR-1.3、NFR-3 |

## T5 · 投影接入适配器（行为等价）

| 项 | 内容 |
|---|---|
| **目标** | `adapter/pi/history.buildRequest` 改为消费 `projectConversation`；投影位置在受守卫端口内侧、真实端口外侧 |
| **修改范围** | `src/adapter/pi/history.ts`、`src/adapter/pi/model.ts`（decide 前投影一步）、`src/runtime/run-agent.ts`（`RunAgentOptions` 增加 `projection?: ProjectionPolicy`，缺省 = 全 verbatim 的保守策略）、`test/pi-adapter.test.ts` 增补 |
| **依赖** | T4 |
| **实现方式** | verbatim turn 走既有翻译路径（代码复用，不复制）；folded turn 渲染为一条带可见标记的 user 消息；`RunAgentOptions.projection` 缺省值必须使既有调用方行为逐字节不变 |
| **验收标准** | **全部既有测试与 golden 固定件一字不动全绿**（短任务全部 verbatim → 请求与现状逐字节相同）；投影超预算场景的新测试中请求体积有界 |
| **测试方式** | 全量 `npx vitest run`（golden 双路径逐字节对比是本任务的验收核心）+ 新增长任务投影集成测试 |
| **对应 Spec** | FR-1.1、FR-1.4（联动部分）、NFR-1 |

## T6 · token 预算默认设防（唯一默认行为变化）

| 项 | 内容 |
|---|---|
| **目标** | `DEFAULT_BUDGET.maxInputTokens` 从 `null` → `200_000` |
| **修改范围** | `src/runtime/budget.ts`；受影响的既有测试断言（若有）；`docs/05-budget-cancellation.md` 追加一节 |
| **依赖** | T5（投影使请求有界，设防才安全） |
| **实现方式** | 改常量；跑全量测试找出依赖 `null` 默认的断言并按新语义更新 |
| **验收标准** | 全绿；超限行为有测试（`budget_tokens` 归因不变）；变更在 commit message 与 docs 中说明原因 |
| **测试方式** | `npx vitest run test/runtime-budget.test.ts test/golden/` + 全量 |
| **对应 Spec** | FR-1.4、§4.11（已声明的默认行为变化） |

## T7 · `reduceHumanInput`（Core 恢复推进）

| 项 | 内容 |
|---|---|
| **目标** | 人的回答进入 transcript 的合法路径：第三个推进函数 |
| **修改范围** | `src/core/loop.ts`、`src/core/types.ts`（如需注释）、`test/core-loop.test.ts` 增补 |
| **依赖** | 无（可与 T3–T6 并行；顺序执行时放在 T4 之后） |
| **实现方式** | 按 architecture §3.2：transcript += human 消息、清 pendingQuestion、iteration 不变、纯函数 |
| **验收标准** | 纯函数语义三条全有测试；`core` 零 import 扫描仍绿 |
| **测试方式** | `npx vitest run test/core-loop.test.ts test/core-types.test.ts` |
| **对应 Spec** | FR-2.1 |

## T8 · 回放激活恢复事件

| 项 | 内容 |
|---|---|
| **目标** | `replayAgentState` 处理 `human_input_received` / `run_resumed`；删除 `unsupported` 抛错 |
| **修改范围** | `src/runtime/replay.ts`、`test/replay-idempotence.test.ts` 增补 |
| **依赖** | T7 |
| **实现方式** | 按 architecture §6.1：`human_input_received` 要求 `pendingQuestion ≠ null` 否则抛"日志矛盾"；`reduceHumanInput` 推进；`run_resumed` 仅记录；穷尽 switch 保持（编译期强制） |
| **验收标准** | 恢复日志可重建状态；矛盾日志（未挂起先收到回答）被拒；既有回放测试不动全绿 |
| **测试方式** | `npx vitest run test/replay-idempotence.test.ts` + 全量 |
| **对应 Spec** | FR-2.4、NFR-1 |

## T9 · `Runtime.resume`

| 项 | 内容 |
|---|---|
| **目标** | 恢复入口：校验 → 追加事件 → 回放重建 → 继续循环 |
| **修改范围** | `src/runtime/run-agent.ts`（`resume` / `ResumeInput` / `ResumeError`）、`src/store/session-store.ts`（如需按 runId 取 Task 的查询，优先复用既有接口）、`test/runtime-resume.test.ts` 新增 |
| **依赖** | T8 |
| **实现方式** | 按 architecture §4.2 时序：校验先于写入（五类 ResumeError）；sequence 从既有日志长度接续；`usage_reported` 整 Run 恰好一条（挂起前已报账则恢复路径不再报，账目从旧事件读回）；循环驱动体与 `run()` 共用（提取共用驱动函数，不复制） |
| **验收标准** | 恢复全流程事件序列正确（received → resumed → 循环 → 终态）；五类拒绝全部类型化且**未写任何事件**；混合日志（旧前缀+新事件）回放通过；`run()` 既有测试一字不动全绿 |
| **测试方式** | 新增 `test/runtime-resume.test.ts`（含 fake 剧本"挂起→恢复→完成"）+ 全量 |
| **对应 Spec** | FR-2.2、FR-2.3、FR-2.6、NFR-1 |

## T10 · golden 挂起-恢复固定件

| 项 | 内容 |
|---|---|
| **目标** | "挂起 → 应答 → 恢复 → 完成"的语义被 golden 钉死 |
| **修改范围** | `test/golden/corpus.ts`（新场景）、`test/golden/harness.ts`（如需 resume 驱动）、`test/golden/pinned/09-*.json` 新增 |
| **依赖** | T9 |
| **实现方式** | fake 剧本扩展（ask_human → resume → 后续决策）；双路径（fake / SDK）逐字节一致的要求不变；录制走既有 `KUSE_RECORD_GOLDEN=1` 流程，固定件经人工审阅后提交 |
| **验收标准** | 新固定件双路径逐字节一致；既有 8 组固定件一字未动 |
| **测试方式** | `npx vitest run test/golden/` + 全量 |
| **对应 Spec** | FR-2.7、NFR-1 |

## T11 · Toolbox 升格为通用组装点

| 项 | 内容 |
|---|---|
| **目标** | `Toolbox` 补齐执行层三形状；组装收拢到 `createToolbox`；repo-tools 变薄 |
| **修改范围** | 新增 `src/toolbox.ts`；`src/tools/repo-tools.ts`（导出 `createRepoToolSpecs`，保留兼容导出）；`src/cli/main.ts` 与 `desktop/src/main/run-service.ts` 接线点改引；`src/adapter/pi/{catalog,tools}.ts` type-only import 改指向；`test/tool-runner.test.ts`、`test/repo-tools.test.ts` 增补 |
| **依赖** | 无（独立于 T3–T10） |
| **实现方式** | 按 architecture §3.3：`createToolbox(specs, options)` 内部复用 `createToolRunner`；旧 `createRepoTools` 保留为薄别名一个版本期（调用方迁移后由 T17 收尾删除，或本任务内直接迁移——实现时以"diff 最小"为准） |
| **验收标准** | 既有测试全绿（行为等价）；用注册一个测试假工具证明"加工具只碰一处"（FR-4.2 的成本声明） |
| **测试方式** | `npx vitest run test/tool-runner.test.ts test/repo-tools.test.ts test/cli.test.ts` + 全量 |
| **对应 Spec** | FR-4.1、FR-4.2、FR-4.3 |

## T12 · 装配层 `createKuse`

| 项 | 内容 |
|---|---|
| **目标** | 共享装配：配置 → toolbox → 两路模型 → store → runtime → 门面（startRun/answer/trace/sessions/audit） |
| **修改范围** | 新增 `src/bootstrap/`（含测试）、`src/index.ts` 导出 |
| **依赖** | T3、T5、T6、T9、T11 |
| **实现方式** | 按 architecture §3.5：`createKuse(options): Promise<Kuse>`；SDK 动态加载只在这里；`answer` 内部调 `runtime.resume` 并处理 store 的 Task 索引；零 electron、零 process（IO 注入） |
| **验收标准** | 装配单测（离线路径、模型解析失败类型化、门面形状）；禁线扫描通过 |
| **测试方式** | 新增 `test/bootstrap.test.ts`；`npx vitest run test/no-runtime-deps.test.ts` |
| **对应 Spec** | FR-3.1、FR-3.2、FR-3.3 |

## T13 · CLI 消费装配层（行为不变）

| 项 | 内容 |
|---|---|
| **目标** | `commandRun` 改用 `createKuse`，删除手工接线；`kuse run` 行为与退出码逐字节兼容 |
| **修改范围** | `src/cli/main.ts`、`test/cli.test.ts`（断言不变，只允许随内部结构微调 stub 点） |
| **依赖** | T12 |
| **实现方式** | `commandRun` 只剩：参数 → config（T3 的 mergeConfig 接入 flag/env 层）→ `createKuse` → 渲染事件流 → 退出码；`--offline` / `--model` 映射到 `StartRunInput.model` |
| **验收标准** | `test/cli.test.ts` 全部既有断言不改语义全绿（含凭据脱敏、退出码矩阵）；golden 不动 |
| **测试方式** | `npx vitest run test/cli.test.ts` + 全量 |
| **对应 Spec** | FR-3.2、FR-5.1、S1/S4 兼容性 |

## T14 · `kuse answer` 子命令

| 项 | 内容 |
|---|---|
| **目标** | 挂起-应答-恢复的产品面闭环 |
| **修改范围** | `src/cli/args.ts`（新子命令与帮助文本）、`src/cli/main.ts`、`src/cli/render.ts`、`test/cli.test.ts` 增补 |
| **依赖** | T12（走 `Kuse.answer` 门面） |
| **实现方式** | `kuse answer <sessionId> <runId> <answer>` → `Kuse.answer` → 渲染后续事件流 → 按终态退出码收场；五类 `ResumeError` 映射为可操作 stderr + 非零退出码 |
| **验收标准** | 全链路 CLI 测试（run 挂起 → answer 恢复 → 终态退出码）；错误路径逐类有断言；既有命令零变化 |
| **测试方式** | `npx vitest run test/cli.test.ts` + 全量 |
| **对应 Spec** | FR-2.5、FR-2.6 |

## T15 · 桌面 RunService 换用装配层

| 项 | 内容 |
|---|---|
| **目标** | 删除 RunService 里"一比一复刻"的接线，改消费 `createKuse` |
| **修改范围** | `desktop/src/main/run-service.ts`、`desktop/src/main/run-service.test.ts`（断言语义不变）、`docs/11-desktop-shell.md`（接线一节更新说明） |
| **依赖** | T12 |
| **实现方式** | RunService 持有 `Kuse` 实例；`startRun/answer` 映射到门面；渲染层与 IPC 契约不动 |
| **验收标准** | run-service 测试全绿；`grep` 确认 run-service 不再直接拼 toolbox/model/store |
| **测试方式** | `npx vitest run desktop/src/main/run-service.test.ts` + 全量 |
| **对应 Spec** | FR-3.2、S5 |

## T16 · 任务级 e2e

| 项 | 内容 |
|---|---|
| **目标** | fake 剧本驱动真装配、真工具、真文件系统的全链路测试，判据是 KuseCode 自己的验收观 |
| **修改范围** | `test/e2e/task.test.ts` 新增、`test/fixtures/`（小型 fixture 仓库，含一个可提问的事实结构） |
| **依赖** | T13 |
| **实现方式** | fixture 仓库 + fake 剧本（list_dir → search_text → read_file → submit_report）走 `createKuse.startRun`；断言：报告交付、**每条论断通过 `auditRun`**（supported=total）、日志可回放、trace 三问齐备（what/why/cost） |
| **验收标准** | e2e 全绿；全程零网络零凭据 |
| **测试方式** | `npx vitest run test/e2e/` + 全量 |
| **对应 Spec** | FR-6.1 |

## T17 · 工程整理与收尾

| 项 | 内容 |
|---|---|
| **目标** | 包名/描述对齐、文档收尾、进度索引闭合 |
| **修改范围** | `package.json`（name → `kusecode`，description 微调；bin 不变）、`README.md`（追加"重构序列"小节，引用 sdd 文档）、`docs/sdd/00-progress.md`（全部 ✅）、清理 T11 遗留的兼容别名（若保留过） |
| **依赖** | T16 |
| **实现方式** | 纯整理；不改任何运行时行为 |
| **验收标准** | 全量 typecheck/test/build 绿；`npm pack --dry-run` 无异常；README 与实际行为一致 |
| **测试方式** | 全量 `npm run typecheck && npx vitest run && npm run build` |
| **对应 Spec** | FR-7.1、FR-7.2、G7 |

---

## 里程碑划分（供进度汇报）

| 里程碑 | 任务 | 完成判据 |
|---|---|---|
| M1 守卫与基建 | T1 T2 | 禁线扫描覆盖新模块；fresh clone 测试全绿 |
| M2 上下文工程 | T3 T4 T5 T6 | 长任务请求有界；golden 全绿；预算设防 |
| M3 人机回路 | T7 T8 T9 T10 | 挂起-恢复全链路 + golden 钉死 |
| M4 装配与产品面 | T11 T12 T13 T14 T15 | 三处消费者共享一份装配；answer 可用 |
| M5 收尾 | T16 T17 | 任务级 e2e + 文档/包名闭合 |

## 风险与回退

| 风险 | 触发信号 | 回退方式 |
|---|---|---|
| T5 破坏 golden | 双路径逐字节对比失败 | 投影缺省策略回到全 verbatim（等价开关在 `RunAgentOptions.projection`） |
| T9 resume 与既有 run 机制冲突 | 既有 runtime 测试红 | 提取共用驱动体时保持 `run()` 分支逐行不变，resume 独立成函数 |
| T13 CLI 行为漂移 | cli.test 既有断言语义变化 | 回退该任务，装配层保留待查（CLI 直连在过渡期可接受，spec 记录） |
| Windows 路径差异 | 本地绿 CI 红（或反之） | 投影/配置已纯函数化；路径问题集中在 store/fixtures，修在任务内不过夜 |

---

*本计划批准后进入 Phase 4：按 T1 起逐任务执行，每任务一个 commit，进度记录在 `00-progress.md`。*
