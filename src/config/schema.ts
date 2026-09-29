/**
 * KuseCode 配置的词汇与解析（四层：flag > env > 文件 > 默认）。
 *
 * 手写守卫，零依赖。未知键警告不失败（配置文件是要提交进仓库的），
 * 类型错启动即失败并指出键名。
 */

export interface KuseConfig {
  /** `"provider/model"` 或 `"mock"`（离线剧本）。null = 取第一个已配置凭据的模型。 */
  readonly model: string | null;
  /** `ask`（默认，confirm 操作询问）或 `auto`（测试/CI，全部放行）。 */
  readonly permissionMode: "ask" | "auto";
  /** 事件日志与会话根目录。null = `<projectRoot>/.kusecode/runs`。 */
  readonly dataRoot: string | null;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export class ConfigError extends Error {
  readonly key: string | null;

  constructor(key: string | null, message: string) {
    super(message);
    this.name = "ConfigError";
    this.key = key;
  }
}

export function defaultConfig(): KuseConfig {
  return { model: null, permissionMode: "ask", dataRoot: null };
}

export function configFromEnv(env: Readonly<Record<string, string | undefined>>): DeepPartial<KuseConfig> {
  const model = env["KUSECODE_MODEL"]?.trim();
  return model ? { model } : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(key, `配置键 ${key} 必须是非空字符串或 null，收到 ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}

export interface ParsedConfigFile {
  readonly config: DeepPartial<KuseConfig>;
  readonly warnings: readonly string[];
}

/** 配置文件文本 → 部分配置 + 警告。JSON 坏 / 顶层非对象 → ConfigError。 */
export function parseConfigFile(text: string): ParsedConfigFile {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      null,
      `配置文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(root)) {
    throw new ConfigError(null, `配置文件顶层必须是对象，收到 ${describe(root)}`);
  }

  const warnings: string[] = [];
  const config: Record<string, unknown> = {};
  const KNOWN = new Set(["model", "permissionMode", "dataRoot"]);
  const SECRET = /(secret|password|passwd|token|api[_-]?key|apikey)/i;

  for (const [key, value] of Object.entries(root)) {
    if (SECRET.test(key)) {
      warnings.push(`配置键 ${key} 长得像凭据——秘密只该住在环境变量里`);
    }
    if (!KNOWN.has(key)) {
      warnings.push(`未知的配置键 ${key}（已忽略。拼写错误会让配置悄悄失效）`);
      continue;
    }
    if (key === "permissionMode") {
      if (value !== "ask" && value !== "auto") {
        throw new ConfigError("permissionMode", `配置键 permissionMode 必须是 "ask" 或 "auto"，收到 ${describe(value)}`);
      }
      config[key] = value;
    } else {
      config[key] = key === "model" ? nullableString(value, "model") : nullableString(value, "dataRoot");
    }
  }
  return { config: config as DeepPartial<KuseConfig>, warnings };
}

/** `layers` 按优先级从高到低；前面的键赢。null/undefined 层跳过。 */
export function mergeConfig(
  layers: readonly (DeepPartial<KuseConfig> | null | undefined)[],
): KuseConfig {
  let model = defaultConfig().model;
  let permissionMode = defaultConfig().permissionMode;
  let dataRoot = defaultConfig().dataRoot;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer === null || layer === undefined) continue;
    if (layer["model"] !== undefined) model = layer["model"];
    if (layer["permissionMode"] !== undefined) permissionMode = layer["permissionMode"];
    if (layer["dataRoot"] !== undefined) dataRoot = layer["dataRoot"];
  }
  return { model, permissionMode, dataRoot };
}
