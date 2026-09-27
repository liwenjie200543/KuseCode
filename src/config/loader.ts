/**
 * 配置解析（SDD T3，docs/sdd/03-architecture.md §3.4 / §7）。
 *
 * 这个文件只回答一个问题：**四个来源怎么合成一份全量、已校验的配置？**
 * 它不回答「文件从磁盘哪里读」——那是调用方（CLI / 装配层）的事，
 * 这里只收**文本**。所以它是纯函数模块：零 node: import（T1 的禁线钉着）。
 *
 * 四层优先级：**flag > env > file > default**。`mergeConfig` 的输入数组
 * 按优先级从高到低排列，前面的键赢。
 *
 * 错误的两种命运，对应两类问题：
 * - **类型错 / 越界**：配置坏到了无法安全使用的程度 → `ConfigError`，
 *   启动即失败，消息指出键名与期望类型（FR-5.3）；
 * - **未知键 / 疑似凭据**：文件是要提交进仓库的，宽容未知键向前兼容，
 *   但必须**警告可见**——静默忽略一个拼错的键，等于让配置悄悄失效
 *   （那正是本项目最不能容忍的"安静的改变"）。
 */

import { DEFAULT_BUDGET } from "../runtime/budget.js";
import type { KuseConfig, DeepPartial } from "./schema.js";

/** 配置坏到了不可用的程度。`key` 指出是哪一个键（顶层键则为 null）。 */
export class ConfigError extends Error {
  readonly key: string | null;

  constructor(key: string | null, message: string) {
    super(message);
    this.name = "ConfigError";
    this.key = key;
  }
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

/**
 * 内置默认。
 *
 * `budget` 直接复用 Runtime 的 `DEFAULT_BUDGET`——预算默认值只有一份真相，
 * 复制一份就会在Runtime 调整时悄悄分叉。投影的四个数字是工程判断
 * （依据见 architecture §3.4 的表），与观测截断 8000 同一性质：可校准，不摊开。
 */
export function defaultConfig(): KuseConfig {
  return {
    model: null,
    budget: DEFAULT_BUDGET,
    projection: {
      keepRecentTurns: 8,
      projectionTokenBudget: 48_000,
      foldedObservationChars: 400,
      foldedDecisionChars: 200,
    },
    dataRoot: null,
  };
}

// ---------------------------------------------------------------------------
// 环境变量层
// ---------------------------------------------------------------------------

/** 环境变量 → 配置层。`KUSECODE_MODEL=provider/model`（或 `faux`）。 */
export function configFromEnv(env: Readonly<Record<string, string | undefined>>): DeepPartial<KuseConfig> {
  const model = env["KUSECODE_MODEL"]?.trim();
  return model ? { model } : {};
}

// ---------------------------------------------------------------------------
// 手写守卫
// ---------------------------------------------------------------------------

/** 疑似凭据的键名。配置文件是要提交进仓库的，它不该装秘密。 */
const SECRET_KEY = /(secret|password|passwd|token|api[_-]?key|apikey)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}

/** 正整数守卫（0 与负数对"预算/上限"这类键没有合理语义）。 */
function positiveInt(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(key, `配置键 ${key} 必须是正整数，收到 ${describe(value)}`);
  }
  return value;
}

/** 可空正整数（token 上限：null = 不设防是合法表达）。 */
function nullablePositiveInt(value: unknown, key: string): number | null {
  if (value === null) return null;
  return positiveInt(value, key);
}

/** 可空字符串。 */
function nullableString(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(key, `配置键 ${key} 必须是非空字符串或 null，收到 ${describe(value)}`);
  }
  return value;
}

function guardBudget(input: Record<string, unknown>): DeepPartial<KuseConfig>["budget"] {
  const out: Record<string, unknown> = {};
  const known: ReadonlyArray<[string, (value: unknown, key: string) => unknown]> = [
    ["maxIterations", positiveInt],
    ["maxToolCalls", positiveInt],
    ["maxRetries", positiveInt],
    ["timeoutMs", positiveInt],
    ["maxInputTokens", nullablePositiveInt],
    ["maxOutputTokens", nullablePositiveInt],
  ];
  for (const [name, guard] of known) {
    if (name in input) out[name] = guard(input[name], `budget.${name}`);
  }
  return out;
}

function guardProjection(input: Record<string, unknown>): DeepPartial<KuseConfig>["projection"] {
  const out: Record<string, unknown> = {};
  const known: ReadonlyArray<[string, (value: unknown, key: string) => unknown]> = [
    ["keepRecentTurns", (value, key) => {
      // 0 是合法的：窗口可以关小到零（一切皆可折），但负数没有意义。
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new ConfigError(key, `配置键 ${key} 必须是非负整数，收到 ${describe(value)}`);
      }
      return value;
    }],
    ["projectionTokenBudget", positiveInt],
    ["foldedObservationChars", positiveInt],
    ["foldedDecisionChars", positiveInt],
  ];
  for (const [name, guard] of known) {
    if (name in input) out[name] = guard(input[name], `projection.${name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文件解析
// ---------------------------------------------------------------------------

export interface ParsedConfigFile {
  readonly config: DeepPartial<KuseConfig>;
  /** 警告（未知键、疑似凭据）。配置仍被接受——警告不失败。 */
  readonly warnings: readonly string[];
}

/**
 * 配置文件文本 → 部分配置 + 警告。
 *
 * JSON 解析失败 / 根不是对象 → `ConfigError`（文件坏到了无从谈起）；
 * 键的类型错 → `ConfigError`，消息指出键名与期望类型。
 */
export function parseConfigFile(text: string): ParsedConfigFile {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(null, `配置文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(root)) {
    throw new ConfigError(null, `配置文件顶层必须是对象，收到 ${describe(root)}`);
  }

  const warnings: string[] = [];
  const config: Record<string, unknown> = {};

  const KNOWN_TOP = new Set(["model", "budget", "projection", "dataRoot"]);
  for (const [key, value] of Object.entries(root)) {
    if (SECRET_KEY.test(key)) {
      warnings.push(`配置键 ${key} 长得像凭据——配置文件是要提交进仓库的，秘密只该住在环境变量里`);
    }
    if (!KNOWN_TOP.has(key)) {
      warnings.push(`未知的配置键 ${key}（已忽略。拼写错误会让配置悄悄失效，请核对文档）`);
      continue;
    }
    switch (key) {
      case "model":
        config["model"] = nullableString(value, "model");
        break;
      case "dataRoot":
        config["dataRoot"] = nullableString(value, "dataRoot");
        break;
      case "budget":
        if (!isPlainObject(value)) {
          throw new ConfigError("budget", `配置键 budget 必须是对象，收到 ${describe(value)}`);
        }
        config["budget"] = guardBudget(value);
        break;
      case "projection":
        if (!isPlainObject(value)) {
          throw new ConfigError("projection", `配置键 projection 必须是对象，收到 ${describe(value)}`);
        }
        config["projection"] = guardProjection(value);
        break;
    }
  }

  return { config: config as DeepPartial<KuseConfig>, warnings };
}

// ---------------------------------------------------------------------------
// 四层合并
// ---------------------------------------------------------------------------

/**
 * `layers` 按优先级从高到低排列（[flag, env, file, default]），前面的键赢。
 *
 * 顶层逐键；`budget` / `projection` 逐**字段**——文件里设了
 * `budget.maxIterations`、flag 设了 `budget.timeoutMs`，两条都生效。
 * 数组输入里的 null / undefined 层被跳过（某层缺席不等于清空下层）。
 */
export function mergeConfig(
  layers: readonly (DeepPartial<KuseConfig> | null | undefined)[],
): KuseConfig {
  const base = defaultConfig();
  const out: Record<string, unknown> = { ...base };

  // 从最低优先级向上覆盖：前面的层赢。
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer === null || layer === undefined) continue;

    if ("model" in layer && layer["model"] !== undefined) out["model"] = layer["model"];
    if ("dataRoot" in layer && layer["dataRoot"] !== undefined) out["dataRoot"] = layer["dataRoot"];

    for (const objectKey of ["budget", "projection"] as const) {
      const partial = layer[objectKey];
      if (partial === undefined) continue;
      out[objectKey] = { ...(base[objectKey] as object), ...(out[objectKey] as object), ...partial };
    }
  }

  return out as KuseConfig;
}
