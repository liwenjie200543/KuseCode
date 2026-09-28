# Spec + Design + Tasks：Sub-Agents

## Spec

第一版只有最简单的形状：Main → spawn → Sub → Result。

- `spawn_agent / list_agents / wait_agent / close_agent` 四个工具进同一 registry；
- 子代理**复用** Agent Loop、工具系统、权限、上下文——不复制 Runtime；
- worker 固定 system prompt + **只读**工具子集（read/grep/find/ls）；
- 硬上限 3 并发；worker 不持有子代理工具（防 swarm）；
- `wait_agent` 收集 worker 最后一条 assistant 文本作为报告；`close_agent` = abort。

## Tasks

- [ ] `agents/manager.ts` + 4 个工具 + 并发上限/只读约束单测（Phase 9）
