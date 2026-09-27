import { describe, expect, it } from "vitest";

import { DEFAULT_BUDGET } from "../src/runtime/budget.js";
import {
  ConfigError,
  configFromEnv,
  defaultConfig,
  mergeConfig,
  parseConfigFile,
} from "../src/config/loader.js";
import type { KuseConfig } from "../src/config/schema.js";

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

describe("defaultConfig", () => {
  it("字段齐全；budget 与 Runtime 的 DEFAULT_BUDGET 是同一份真相", () => {
    const config = defaultConfig();

    expect(config.model).toBeNull();
    expect(config.dataRoot).toBeNull();
    expect(config.budget).toEqual(DEFAULT_BUDGET);
    expect(config.projection).toEqual({
      keepRecentTurns: 8,
      projectionTokenBudget: 48_000,
      foldedObservationChars: 400,
      foldedDecisionChars: 200,
    });
  });

  it("观测截断 8000 不在配置词汇里（docs/06 的既有决定）", () => {
    const text = JSON.stringify({ observationCharLimit: 1000 });
    const { warnings } = parseConfigFile(text);
    expect(warnings.join("\n")).toContain("未知的配置键 observationCharLimit");
  });
});

// ---------------------------------------------------------------------------
// 文件解析
// ---------------------------------------------------------------------------

describe("parseConfigFile", () => {
  it("完整文件逐键解析；类型全部通过", () => {
    const { config, warnings } = parseConfigFile(
      JSON.stringify({
        model: "deepseek/deepseek-chat",
        dataRoot: "/tmp/kuse-data",
        budget: { maxIterations: 8, maxInputTokens: null },
        projection: { keepRecentTurns: 4 },
      }),
    );

    expect(warnings).toEqual([]);
    expect(config.model).toBe("deepseek/deepseek-chat");
    expect(config.dataRoot).toBe("/tmp/kuse-data");
    expect(config.budget).toEqual({ maxIterations: 8, maxInputTokens: null });
    expect(config.projection).toEqual({ keepRecentTurns: 4 });
  });

  it("null 是合法值（model / dataRoot / token 上限）", () => {
    const { config, warnings } = parseConfigFile(
      JSON.stringify({ model: null, dataRoot: null, budget: { maxInputTokens: null } }),
    );
    expect(warnings).toEqual([]);
    expect(config).toEqual({ model: null, dataRoot: null, budget: { maxInputTokens: null } });
  });

  it("未知键：警告并忽略，不失败", () => {
    const { config, warnings } = parseConfigFile(JSON.stringify({ model: "faux", modle: "typo" }));
    expect(config.model).toBe("faux");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("modle");
  });

  it("疑似凭据的键名触发警告", () => {
    const { warnings } = parseConfigFile(JSON.stringify({ apiKey: "sk-123", model: "faux" }));
    expect(warnings.join("\n")).toContain("长得像凭据");
  });

  it("类型错 → ConfigError 指出键名与期望类型", () => {
    expect(() => parseConfigFile(JSON.stringify({ model: 42 }))).toThrowError(/model/);
    expect(() => parseConfigFile(JSON.stringify({ budget: { maxIterations: "many" } }))).toThrowError(
      /budget\.maxIterations/,
    );
    expect(() => parseConfigFile(JSON.stringify({ budget: { maxToolCalls: 0 } }))).toThrowError(
      /budget\.maxToolCalls/,
    );
    expect(() => parseConfigFile(JSON.stringify({ projection: { keepRecentTurns: -1 } }))).toThrowError(
      /projection\.keepRecentTurns/,
    );
    expect(() => parseConfigFile(JSON.stringify({ projection: "tight" }))).toThrowError(/projection/);
  });

  it("不是 JSON、顶层不是对象 → ConfigError", () => {
    expect(() => parseConfigFile("{broken")).toThrowError(ConfigError);
    expect(() => parseConfigFile(JSON.stringify([1, 2]))).toThrowError(/顶层必须是对象/);
  });
});

// ---------------------------------------------------------------------------
// 环境变量层
// ---------------------------------------------------------------------------

describe("configFromEnv", () => {
  it("KUSECODE_MODEL 映射到 model；无关变量与空白被忽略", () => {
    expect(configFromEnv({ KUSECODE_MODEL: " openai/gpt " })).toEqual({ model: "openai/gpt" });
    expect(configFromEnv({ KUSECODE_MODEL: "  " })).toEqual({});
    expect(configFromEnv({ PATH: "/usr/bin" })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 四层合并
// ---------------------------------------------------------------------------

describe("mergeConfig", () => {
  const file: Partial<KuseConfig> = {
    model: "from-file",
    budget: { maxIterations: 8 },
  };

  it("优先级：flag > env > file > default", () => {
    const merged = mergeConfig([
      { model: "from-flag" },
      { model: "from-env" },
      file,
      defaultConfig(),
    ]);

    expect(merged.model).toBe("from-flag");
  });

  it("高层缺席的键落回低层，最终落回默认", () => {
    const merged = mergeConfig([{ budget: { maxToolCalls: 5 } }, file, defaultConfig()]);

    expect(merged.model).toBe("from-file"); // flag/env 没给 model → file 层的赢
    expect(merged.budget.maxIterations).toBe(8); // file 层设置的
    expect(merged.budget.maxToolCalls).toBe(5); // 更高层的覆盖
    expect(merged.budget.timeoutMs).toBe(DEFAULT_BUDGET.timeoutMs); // 谁都没给 → 默认
  });

  it("对象逐字段合并：file 的 maxIterations 与 flag 的 timeoutMs 都生效", () => {
    const merged = mergeConfig([
      { budget: { timeoutMs: 1_000 } },
      { budget: { maxIterations: 8 } },
      defaultConfig(),
    ]);

    expect(merged.budget.maxIterations).toBe(8);
    expect(merged.budget.timeoutMs).toBe(1_000);
    expect(merged.budget.maxToolCalls).toBe(DEFAULT_BUDGET.maxToolCalls);
  });

  it("null/undefined 层被跳过；model 显式为 null 是合法的覆盖（关闭低层的模型）", () => {
    const merged = mergeConfig([{ model: null }, { model: "from-file" }, defaultConfig()]);
    expect(merged.model).toBeNull();
  });

  it("空层数组 = 纯默认", () => {
    expect(mergeConfig([null, undefined])).toEqual(defaultConfig());
  });
});
