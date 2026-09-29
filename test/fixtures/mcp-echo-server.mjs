/** MCP 集成测试 fixture：一个最小 stdio MCP server（提供 echo 工具）。 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo-server", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "把输入原样返回",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "要回显的文本" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "echo") throw new Error(`未知工具：${request.params.name}`);
  const args = request.params.arguments ?? {};
  return {
    content: [{ type: "text", text: `echoed:${args.text ?? ""}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
