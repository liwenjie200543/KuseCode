/**
 * 反方向的桥：把自己的 `ToolPort` 交给 **SDK 自己的循环**。
 *
 * 上一个文件解释了为什么本项目的 Runtime 用 pi-ai 而不用 coding agent 层。
 * 那自然会引出一个问题：**那 coding agent 层对我们还有用吗？**
 *
 * 有，而且它有用恰恰是因为它回答的是另一个问题。这里把同一批工具定义成 SDK 的
 * `defineTool`，由 SDK 去执行——于是同一份 `ToolPort` 有两个消费者：
 *
 * ```text
 *                     ┌─ 我们的 Runtime：Core 拥有循环（步 3～7）
 * ToolPort ───────────┤
 *                     └─ Pi 的 AgentSession：SDK 拥有循环（本文件）
 * ```
 *
 * 这条桥证明的正是本步要证明的那句话：**换掉谁，语义都不变。** 如果只有一边能走通，
 * 那"可替换"就只是一句关于架构图的话。
 *
 * 三件事在转换时被显式处理：
 *
 * 1. **schema 双通道。** `parameters` 是模型看的 TypeBox 面；`prepareArguments`
 *    在执行时再校验一次。两条道都通向我们自己的 `spec.parse`——**同一份校验**，
 *    不是"照抄一遍"：畸形参数不会因为换了驱动方就溜过去。
 * 2. **provenance 缺口。** SDK 的工具结果本身不带来源（这是记录过的真实事故：
 *    provenance_presence 曾为 0）。所以 `details` 里显式附上来源与时刻。
 * 3. **取消透传。** SDK 给的 `signal` 原样交给 `ToolPort`，不吞、不替换。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ToolIntent, ToolOutcome, ToolPort } from "../../core/types.js";
import type { Toolbox } from "../../tools/repo-tools.js";

type PiToolDefinition = ToolDefinition<TSchema>;

export interface PiToolBridgeOptions {
  /** 工具集：`specs` 提供 schema 与校验，`port` 提供执行。 */
  readonly toolbox: Pick<Toolbox, "specs" | "port">;
  /** 时钟，给 provenance 用。默认 `Date.now`。 */
  readonly clock?: () => number;
}

/**
 * 把 `ToolOutcome` 摊成 SDK 要的 `{content, details}`。
 *
 * 失败也走 `content`（而不是抛）：SDK 的 `isError` 由它自己判定，而我们的
 * 语义是"工具失败是一条材料，不是一次中断"（步 6）。把它抛出去会让 SDK 的循环
 * 收到一个异常，那与"Run 继续、终态 partial"的语义正好相反。
 */
function toToolResult(outcome: ToolOutcome, provenance: { source: string; at: number }): {
  content: { readonly type: "text"; readonly text: string }[];
  details: unknown;
} {
  const text =
    outcome.error === null
      ? typeof outcome.value === "string"
        ? outcome.value
        : JSON.stringify(outcome.value ?? null, null, 2)
      : `调用失败（${outcome.error.code}）：${outcome.error.message}`;
  return {
    content: [{ type: "text", text }],
    // 来源与时刻显式附上：这正是那次 provenance 事故的修法
    details: { value: outcome.value, error: outcome.error, provenance },
  };
}

/**
 * 真实工具 → SDK 工具定义。
 *
 * 协议工具**不在**这里：它们没有副作用、不碰外部世界，由适配器自己消费。
 * 把它们也注册成 SDK 工具，会让"模型能收工"和"模型能读文件"走同一条路——
 * 而前者根本不是一次工具执行。
 */
export function piToolDefinitions(options: PiToolBridgeOptions): PiToolDefinition[] {
  const clock = options.clock ?? ((): number => Date.now());

  return options.toolbox.specs.map((spec) => {
    const port: ToolPort = options.toolbox.port;
    return defineTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      // 模型看到的那一面：我们的 JSON Schema 原样过河
      parameters: Type.Unsafe(spec.parameters) as TSchema,
      // 执行时再校验一次，用的是**同一个** `spec.parse`
      prepareArguments: (args: unknown): Record<string, unknown> =>
        spec.parse((args ?? {}) as Readonly<Record<string, unknown>>),
      execute: async (toolCallId, params, signal) => {
        const intent: ToolIntent = {
          name: spec.name,
          args: (params ?? {}) as Readonly<Record<string, unknown>>,
        };
        // SDK 允许不传 signal（`signal?: AbortSignal`）。不传时给一条永不中止的信号：
        // 「没有取消」与「取消」是两件事，用 `undefined` 混过去会让工具侧的判断多一种情况。
        const outcome = await port.execute(intent, signal ?? new AbortController().signal);
        // toolCallId 属于 SDK 的账，不进我们的语义（Core 不认识 provider 的关联 id）
        void toolCallId;
        return toToolResult(outcome, { source: spec.name, at: clock() });
      },
    });
  });
}
