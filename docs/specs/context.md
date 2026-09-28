# Spec + Design + Tasks：Context（压缩）+ Session

## Context

两层策略，一个类（`context/manager.ts`，~120 行）：

1. **单结果截断**（`afterToolCall` 钩子）：超 `maxToolResultChars`（默认 20k）→
   头尾保留 + 显式截断标记；全文不另存（第一版不做 artifact 归档）。
2. **预算压缩**（`transformContext` 钩子）：token 估算 ≈ chars/4（确定性、离线）；
   超 `compactAboveTokens` → 旧回合替换为 LLM 摘要（`<conversation-summary>`），
   最近 `keepRecentMessages`（默认 12）逐字保留，切点落在 user 消息边界。
   `/compact` 手动触发同一路径。

不建 Context Framework；不做投影/证据结构（旧机制退休）。

## Session

一个文件一个会话：`<dataRoot>/sessions/<uuidv7>.jsonl`，首行 header
（id/cwd/model/createdAt/title），其后一行一条**终态消息**（user/assistant/toolResult）。

- append-only + 同步追加；torn line（无换行符的尾行）加载时跳过；
- `resume` 只读加载历史进 transcript，继续向同一文件追加（崩溃安全）；
- `continue` = 最近一个 **cwd 匹配**的会话；`--session <id>` 精确指定；
- `unfinished` 检测：最后一条不是 assistant 终态即视为中断（recovery 入口）。

实现 `session/manager.ts` + `session/storage.ts`（合计 ~150 行，吸收旧 store 的
torn-write 处理经验）。

## Tasks

- [ ] ContextManager + 单测（截断/压缩/保护窗口/切点）（Phase 6）
- [ ] SessionManager/Storage + 单测（torn line/cwd 匹配/unfinished）（Phase 6）
- [ ] 事件日志：`runtime/log.ts`（同 JSONL 格式记录 5 种事件，供 trace/replay）（Phase 6）
