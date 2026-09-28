# Spec + Design + Tasks：Session

> 会话 = 唯一真相的落盘。Runtime Reliability（replay/recovery）全部建立在它上面。

## Spec

一个文件一个会话：`<dataRoot>/sessions/<uuidv7>.jsonl`。首行 header
（id/cwd/model/createdAt/title），其后一行一条**终态消息**（user/assistant/toolResult）。

- append-only、同步追加、永不截断（title 只在首个真实 prompt 时重写尚无价值的 header 行）；
- torn line（无换行尾行）加载时跳过——崩溃不毁历史；
- `create` / `resume <id>`（只读加载后继续追加）/ `continue`（最近一个 **cwd 匹配**的会话）；
- `unfinished` 检测：最后一条不是 assistant 终态 = 中断，recovery 入口；
- 事件日志（`runtime/log.ts`）用**同一格式**记录 5 种事件（message/tool_call/tool_result/
  error/status），replay 与 trace 都从它派生——不维护第二份真相。

## Design

`session/manager.ts`（生命周期 + cwd 匹配）+ `session/storage.ts`（append/load/list），
合计 ~150 行；吸收旧 `store/run-log-jsonl.ts` 的 torn-write 处理经验。

## Tasks

- [ ] storage/manager + 单测（torn line、cwd 匹配、unfinished、resume 幂等）（Phase 6）
- [ ] `runtime/log.ts` + trace 派生 + 单测（Phase 6/10）
