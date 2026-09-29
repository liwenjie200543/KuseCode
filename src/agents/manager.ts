/**
 * Sub-Agent Manager —— 最简形状的多代理（specs/sub-agents.md）：
 *
 * Main → spawn → Sub → Result。子代理**复用**同一个 Agent 类、同一个工具面
 * （只读子集）、同一个模型注册表——不复制 Runtime。硬上限 3 并发，
 * worker 不持有子代理工具（防 swarm）。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Model, Models } from "@earendil-works/pi-ai";
import { Agent, type AgentToolResult } from "@earendil-works/pi-agent-core";

const MAX_CONCURRENT = 3;

export interface SubAgentManagerOptions {
  readonly models: Models;
  readonly model: Model<string>;
  readonly projectRoot: string;
  /** worker 可用的只读工具（由调用方从 registry 里挑）。 */
  readonly workerTools: readonly AgentTool[];
}

export interface WorkerReport {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly status: "running" | "done" | "error";
  readonly report: string;
}

interface MutableWorkerReport {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  status: "running" | "done" | "error";
  report: string;
}

interface Worker {
  readonly report: MutableWorkerReport;
  readonly promise: Promise<void>;
  readonly abort: AbortController;
}

const WORKER_SYSTEM_PROMPT =
  "你是一个只读研究子代理：用给定的只读工具调查任务，" +
  "然后输出一份简洁的事实性报告。你不能修改任何文件。";

export class SubAgentManager {
  private readonly workers = new Map<string, Worker>();
  private counter = 0;

  constructor(private readonly options: SubAgentManagerOptions) {}

  /** 派生一个只读 worker。并发超限/重名即抛。 */
  spawn(name: string, task: string): WorkerReport {
    if (this.runningCount() >= MAX_CONCURRENT) {
      throw new Error(`子代理并发已达上限 ${MAX_CONCURRENT}：先 wait_agent 或 close_agent 释放名额`);
    }
    if (this.workers.has(name)) {
      throw new Error(`已有名为 ${name} 的子代理`);
    }

    const abort = new AbortController();
    const workerAgent = new Agent({
      streamFn: this.options.models.streamSimple.bind(this.options.models),
      initialState: {
        systemPrompt: WORKER_SYSTEM_PROMPT,
        model: this.options.model,
        thinkingLevel: "minimal",
        tools: [...this.options.workerTools],
      },
    });

    const report: MutableWorkerReport = { id: `worker-${++this.counter}`, name, task, status: "running", report: "" };
    const promise = (async () => {
      try {
        await workerAgent.prompt(task);
        const messages = workerAgent.state.messages as { role: string; content?: unknown }[];
        report.report = lastAssistantText(messages);
        report.status = "done";
      } catch (error) {
        report.status = "error";
        report.report = error instanceof Error ? error.message : String(error);
      }
    })();

    this.workers.set(name, { report, promise, abort });
    return { ...report };
  }

  list(): readonly WorkerReport[] {
    return [...this.workers.values()].map((worker) => ({ ...worker.report }));
  }

  /** 等一个 worker 收工，返回它的报告。 */
  async wait(name: string): Promise<WorkerReport> {
    const worker = this.workers.get(name);
    if (worker === undefined) throw new Error(`没有名为 ${name} 的子代理`);
    await worker.promise;
    return { ...worker.report };
  }

  /** 中止一个 worker（返回它的最终状态）。 */
  async close(name: string): Promise<WorkerReport> {
    const worker = this.workers.get(name);
    if (worker === undefined) throw new Error(`没有名为 ${name} 的子代理`);
    worker.abort.abort();
    await worker.promise.catch(() => {});
    const report = { ...worker.report };
    this.workers.delete(name);
    return report;
  }

  runningCount(): number {
    return [...this.workers.values()].filter((worker) => worker.report.status === "running").length;
  }

  async shutdown(): Promise<void> {
    for (const worker of this.workers.values()) worker.abort.abort();
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.promise));
  }
}

/** 四个子代理工具（spawn/list/wait/close），进同一 registry。 */
export function createSubAgentTools(manager: SubAgentManager): AgentTool[] {
  const text = (content: string): AgentToolResult<undefined> => ({
    content: [{ type: "text", text: content }],
    details: undefined,
  });

  return [
    {
      name: "spawn_agent",
      label: "SpawnAgent",
      description: `派生一个只读子代理去调查任务（并发上限 ${MAX_CONCURRENT}）`,
      parameters: Type.Object({
        name: Type.String({ description: "子代理名（1-40 字符，字母数字破折号）" }),
        task: Type.String({ description: "要调查的任务" }),
      }),
      execute: async (_id, raw) => {
        const args = raw as { name: string; task: string };
        try {
          const report = manager.spawn(args.name, args.task);
          return text(`子代理 ${report.name}（${report.id}）已启动`);
        } catch (error) {
          return text(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "list_agents",
      label: "ListAgents",
      description: "列出全部子代理及其状态",
      parameters: Type.Object({}),
      execute: async () => {
        const list = manager.list();
        if (list.length === 0) return text("（没有子代理）");
        return text(list.map((report) => `${report.name} [${report.status}] ${report.task}`).join("\n"));
      },
    },
    {
      name: "wait_agent",
      label: "WaitAgent",
      description: "等待一个子代理收工并取回它的报告",
      parameters: Type.Object({ name: Type.String({ description: "子代理名" }) }),
      execute: async (_id, raw) => {
        const args = raw as { name: string };
        try {
          const report = await manager.wait(args.name);
          return text(`[${report.status}] ${report.report || "(空报告)"}`);
        } catch (error) {
          return text(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "close_agent",
      label: "CloseAgent",
      description: "中止一个子代理",
      parameters: Type.Object({ name: Type.String({ description: "子代理名" }) }),
      execute: async (_id, raw) => {
        const args = raw as { name: string };
        try {
          const report = await manager.close(args.name);
          return text(`子代理 ${report.name} 已关闭 [${report.status}]`);
        } catch (error) {
          return text(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

function lastAssistantText(messages: { role: string; content?: unknown }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
        .join("");
      if (text.length > 0) return text;
    }
  }
  return "";
}
