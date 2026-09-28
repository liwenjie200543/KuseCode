# Spec + Design + Tasks：MCP

## Spec

薄适配，不实现协议：

```text
.kusecode/config.json → mcpServers: { name: { command, args?, env?, cwd? } }   （仅 stdio）
        ↓ @modelcontextprotocol/sdk 的 StdioClientTransport（并行连接 + initialize 超时）
        ↓ 每个工具 → KuseCode Tool（name 冲突 → <server>_<tool>；JSON Schema 原样透传）
```

- 单点故障只记录状态，不拖垮启动；`/mcp`（TUI）与 `mcp.status` 列出状态/工具数/错误。
- shutdown 干净关闭 transport，无子进程泄漏。

## Tasks

- [ ] `mcp/index.ts`：startAll/registerTools/shutdown + 单测（起真 stdio server fixture）（Phase 8）
