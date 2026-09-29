/**
 * MCP —— 薄适配（specs/mcp.md）：协议全部交给官方 SDK，这里只做三件事：
 * 连接（并行 + 超时，单点故障不致命）、把 MCP 工具适配进 KuseCode 工具面、
 * 干净关闭。不重新实现 MCP Protocol 的任何部分。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { ToolEntry } from "../tools/registry.js";

export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** initialize 等待上限（秒），默认 10。 */
  readonly timeoutSeconds?: number;
}

export interface McpStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly toolCount: number;
  readonly error?: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

interface ConnectedServer {
  readonly name: string;
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

async function connect(name: string, config: McpServerConfig): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: config.command,
    ...(config.args === undefined ? {} : { args: [...config.args] }),
    ...(config.env === undefined ? {} : { env: { ...process.env, ...config.env } as Record<string, string> }),
  });
  const client = new Client({ name: "kusecode", version: "0.1.0" });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`initialize 超时（${config.timeoutSeconds ?? 10}s）`)), config.timeoutSeconds === undefined ? CONNECT_TIMEOUT_MS : config.timeoutSeconds * 1000);
  });
  await Promise.race([client.connect(transport), timeout]);
  return { name, client, transport };
}

/** 把一个 MCP 工具适配成 KuseCode 工具（AgentTool 形状 + JSON Schema 透传）。 */
function adaptTool(server: ConnectedServer, name: string, schema: unknown, description: string): ToolEntry {
  const tool: AgentTool = {
    name,
    label: name,
    description: description.length > 0 ? description : `MCP 工具 ${name}（来自 ${server.name}）`,
    // JSON Schema 原样透传（typebox 的 Type.Unsafe 让任意 schema 过河）。
    parameters: Type.Unsafe(schema ?? {}),
    execute: async (_id, params): Promise<AgentToolResult<undefined>> => {
      const callTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`MCP 工具 ${name} 调用超时（60s）`)), CALL_TIMEOUT_MS);
      });
      const result = (await Promise.race([
        server.client.callTool({ name, arguments: params as Record<string, unknown> }),
        callTimeout,
      ])) as { content?: { type: string; text?: string }[]; isError?: boolean };
      const text = (result.content ?? [])
        .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
        .join("\n");
      return { content: [{ type: "text", text: text.length > 0 ? text : "(空结果)" }], details: undefined };
    },
  };
  return { tool, risk: "confirm" };
}

export class McpManager {
  private readonly servers: ConnectedServer[] = [];
  private readonly statuses: McpStatus[] = [];

  constructor(private readonly configs: Readonly<Record<string, McpServerConfig>>) {}

  /** 并行连接全部 server；失败的只记录状态，不抛错（单点故障不致命）。 */
  async startAll(): Promise<void> {
    await Promise.all(
      Object.entries(this.configs).map(async ([name, config]) => {
        try {
          const server = await connect(name, config);
          this.servers.push(server);
          const { tools } = await server.client.listTools();
          this.statuses.push({ name, ok: true, toolCount: tools.length });
        } catch (error) {
          this.statuses.push({
            name,
            ok: false,
            toolCount: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  /** 把全部已连接 server 的工具适配进注册表；重名 → `<server>_<tool>`。await 完成即全部就位。 */
  async registerTools(register: (entry: ToolEntry, namespace?: string) => void): Promise<void> {
    for (const server of this.servers) {
      const { tools } = await server.client.listTools();
      for (const tool of tools) {
        register(adaptTool(server, tool.name, tool.inputSchema, tool.description ?? ""), server.name);
      }
    }
  }

  statusesSnapshot(): readonly McpStatus[] {
    return this.statuses;
  }

  /** 干净关闭：每个 transport 单独 best-effort 关闭，不互相拖垮。 */
  async shutdown(): Promise<void> {
    await Promise.all(
      this.servers.map(async (server) => {
        try {
          await server.transport.close();
        } catch {
          // 关闭失败不抛：进程退出时 best-effort
        }
      }),
    );
  }
}
