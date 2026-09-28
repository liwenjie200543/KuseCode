# Spec + Design + Tasks：Skills / MCP / Sub-Agents

## Skills（`skills/loader.ts`，~90 行）

- 位置：`<repo>/.kusecode/skills/<name>/SKILL.md`（+ 用户级 `~/.kusecode/skills`）。
- frontmatter：`name` / `description`。**渐进披露**：系统提示词只进 `name: description`
  清单；模型判断需要时调 `load_skill(name)`，正文作为工具结果进入上下文。
- 只有 discover + load 两个函数 + 一个 `load_skill` 工具。无 Registry。

## MCP（`mcp/index.ts`，~90 行）

- 配置：`.kusecode/config.json` 的 `mcpServers: { name: { command, args?, env?, cwd? } }`（stdio）。
- 直接用 `@modelcontextprotocol/sdk` 的 `StdioClientTransport`：启动并行连接、
  initialize 超时、**单点故障只记录不致命**；工具经薄适配进 registry
  （重名 → `<server>_<tool>`）；shutdown 干净关闭。

## Sub-Agents（`agents/manager.ts`，~160 行）

- `spawn_agent / list_agents / wait_agent / close_agent` 四个工具进同一 registry。
- 子代理 = **复用** Agent Loop + 只读工具子集（read/grep/find/ls）+ 独立 transcript
  + 独立 AbortController + 固定 worker system prompt。不复制 Runtime。
- 上限 3 并发；worker 不再持有子代理工具（防 swarm）。
- `wait_agent` 收集 worker 最后一条 assistant 文本作为结构化报告。

## Tasks

- [ ] skills loader + `load_skill` 工具 + 单测（Phase 7）
- [ ] mcp client/adapter + 单测（起真 stdio server fixture）（Phase 8）
- [ ] agents manager + 4 工具 + 并发上限单测（Phase 9）
