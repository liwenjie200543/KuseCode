# Spec + Design + Tasks：Agent Core

> Agent Loop 是唯一"必须懂"的模块，但它不自研循环——循环来自 `pi-agent-core` 的
> `Agent`，我们只装策略钩子。

## Spec

- 一次交互 = 一条 user 消息进入循环，直到模型给出无工具调用的回复或被 abort。
- 工具调用路径：schema 校验（SDK）→ **permission 检查**（可拒绝并把理由回给模型）
  → 执行 → 结果进 transcript → 继续。
- 每条终态消息推给订阅者：会话落盘、事件日志追加、UI 事件流。
- abort：Ctrl+C / Esc → `agent.abort()`；中止的工具调用以错误结果收场，循环退出。
- 错误哲学：工具异常 → `isError` 工具结果给模型（不抛出）；provider 失败 → 上层提示。

## Design

```ts
// src/agent/agent.ts（示意，~120 行）
export interface AgentDeps { projectRoot: string; config: KuseConfig; tools: ToolRegistry;
  permissions: PermissionManager; context: ContextManager; session?: SessionManager; }
export function createAgent(deps): { agent: Agent; events: AsyncIterable<AgentEvent>; abort(): void }
// hooks: streamFn（model/） · beforeToolCall（permissions/） · afterToolCall（context/ 截断）
//        transformContext（context/ 压缩） · subscribe（session/ 落盘 + runtime/ 事件日志）
```

事件词汇（`runtime/` 消费）：`message`（role+content）、`tool_call`、`tool_result`、
`error`、`status`。**只有这 5 种**，不为 UI 定制事件。

## Tasks

- [ ] `agent/agent.ts`：装配 + 钩子（Phase 3）
- [ ] `agent/bootstrap.ts`：从 config 组装全套（Phase 3，吸收旧 bootstrap）
- [ ] 事件流对接 session + 事件日志（Phase 3/6）
