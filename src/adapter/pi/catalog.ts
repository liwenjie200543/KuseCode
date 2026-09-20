/**
 * 工具目录：模型这次**能看见**哪些工具。
 *
 * 它把两个来源合成一份清单：
 *
 * - **真实工具**（`src/tools`）：有副作用，交给 `ToolPort` 执行；
 * - **协议工具**（`protocol.ts`）：没有副作用，由适配器自己消费。
 *
 * 合成在一处做，是为了让"名字只有一个来源"这条约束可以执行：**两边的名字不许撞**。
 * 撞了会怎样？模型调用 `submit_report` 时，适配器会把它当成"收工"，
 * 而注册它的工具作者以为那是一次真实的文件读取——一个静默的语义漂移，
 * 正是"两套真相"里最难查的那一类。所以撞名不是一个 bug，而是一次启动失败。
 *
 * 这个文件不认识 SDK：它产出的 schema 是纯 JSON Schema，转换由 `model.ts` 做。
 */

import type { JsonObjectSchema, Toolbox } from "../../tools/repo-tools.js";
import { TERMINAL_TOOLS, TERMINAL_TOOL_NAMES } from "./protocol.js";

/** 一个工具的声明：名字、说明、JSON Schema。没有实现——实现属于各自那一侧。 */
export interface CatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObjectSchema;
  /** 协议工具（适配器消费）还是真实工具（执行层消费）。 */
  readonly kind: "terminal" | "repo";
}

export interface ToolCatalog {
  readonly entries: readonly CatalogEntry[];
  /** 真实工具的名字，即交给 `ToolPort` 的那一份 allowlist。 */
  readonly repoNames: readonly string[];
  /** 所有名字，即这次请求里声明给模型的那一份。 */
  readonly allNames: readonly string[];
  entry(name: string): CatalogEntry | undefined;
}

/**
 * `TSchema` 是不透明的（TypeBox 的联合类型不暴露 `properties`），所以这里做一次
 * **运行时**提取而不是类型断言。协议工具的 schema 是我们自己写的常量，
 * 形状错了应该在启动时立刻响，而不是等到模型收到一个空 schema。
 */
function asJsonObjectSchema(schema: unknown, what: string): JsonObjectSchema {
  if (typeof schema !== "object" || schema === null) {
    throw new Error(`${what} 的 schema 必须是对象`);
  }
  const record = schema as Record<string, unknown>;
  if (record["type"] !== "object") {
    throw new Error(`${what} 的 schema 必须是 object`);
  }
  const properties = record["properties"];
  if (typeof properties !== "object" || properties === null) {
    throw new Error(`${what} 的 schema 缺少 properties`);
  }
  const required = record["required"];
  return {
    type: "object",
    properties: properties as Readonly<Record<string, unknown>>,
    required: Array.isArray(required) ? required.filter((k): k is string => typeof k === "string") : [],
    additionalProperties: false,
  };
}

/** 从真实工具集建目录，并自动附上两个协议工具。 */
export function catalogFromToolbox(box: Pick<Toolbox, "specs">): ToolCatalog {
  const repoEntries: CatalogEntry[] = box.specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    kind: "repo" as const,
  }));

  const terminalEntries: CatalogEntry[] = TERMINAL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: asJsonObjectSchema(tool.parameters, `协议工具 ${tool.name}`),
    kind: "terminal" as const,
  }));

  return catalogOf([...repoEntries, ...terminalEntries]);
}

/** 直接给一份条目建目录。撞名在这里当场失败。 */
export function catalogOf(entries: readonly CatalogEntry[]): ToolCatalog {
  const byName = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    if (byName.has(entry.name)) {
      throw new Error(`工具名重复：${entry.name}。真实工具不得与协议工具重名。`);
    }
    byName.set(entry.name, entry);
  }

  const repoNames = Object.freeze(
    entries.filter((entry) => entry.kind === "repo").map((entry) => entry.name),
  );
  const allNames = Object.freeze(entries.map((entry) => entry.name));

  return {
    entries: Object.freeze([...entries]),
    repoNames,
    allNames,
    entry: (name) => byName.get(name),
  };
}

/** 协议工具被真实工具占用了名字——启动时就该失败，而不是运行时才发现。 */
export function assertNoTerminalCollision(names: readonly string[]): void {
  for (const terminal of TERMINAL_TOOL_NAMES) {
    if (names.includes(terminal)) {
      throw new Error(`真实工具不得使用协议工具的名字：${terminal}`);
    }
  }
}
