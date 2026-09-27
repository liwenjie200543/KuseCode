# SDD 进度索引

> 每完成一个 Phase / 实施任务，在这里追加一行。commit hash 为该步的提交。

## 文档阶段（Phase 0–3）

| 阶段 | 产出 | Commit | 状态 |
|---|---|---|---|
| Phase 0 现状分析 | `docs/sdd/01-analysis.md` | `82ae405` | ✅ |
| Phase 1 Specification | `docs/sdd/02-spec.md` | `0a87f04` | ✅ |
| Phase 2 Architecture | `docs/sdd/03-architecture.md` | `926a998` | ✅ |
| Phase 3 Implementation Plan | `docs/sdd/04-implementation-plan.md` + 本文件 | （本次提交） | ✅ |

## 实施阶段（Phase 4）

| 任务 | 名称 | Commit | 状态 |
|---|---|---|---|
| T1 | 契约测试扩展（no-runtime-deps 覆盖新模块） | 见 T1 commit | ✅ |
| T2 | CLI 测试去 dist 化 | 见 T2 commit | ✅（实证：本就不依赖 dist；修正 01-analysis P2-6 归因 + 30s 超时余量） |
| T3 | 配置层 `src/config/` | 见 T3 commit | ✅（执行顺序在 T4 之后：类型依赖 ProjectionPolicy） |
| T4 | 对话投影词汇 `src/core/project.ts` | `1129586` | ✅ |
| T5 | 投影接入适配器（行为等价） | 见 T5 commit | ✅（落点修正：PiModelAdapterOptions，非 RunAgentOptions） |
| T6 | token 预算默认设防 | — | ⬜ |
| T7 | `reduceHumanInput`（Core 恢复推进） | — | ⬜ |
| T8 | 回放激活恢复事件 | — | ⬜ |
| T9 | `Runtime.resume` | — | ⬜ |
| T10 | golden 挂起-恢复固定件 | — | ⬜ |
| T11 | Toolbox 升格为通用组装点 | — | ⬜ |
| T12 | 装配层 `src/bootstrap/`（createKuse） | — | ⬜ |
| T13 | CLI 消费装配层（行为不变） | — | ⬜ |
| T14 | `kuse answer` 子命令 | — | ⬜ |
| T15 | 桌面 RunService 换用装配层 | — | ⬜ |
| T16 | 任务级 e2e | — | ⬜ |
| T17 | 工程整理（包名/文档收尾） | — | ⬜ |

> 状态图例：⬜ 未开始 · 🔄 进行中 · ✅ 完成（含 commit hash）· ⏸ 暂停（原因）
