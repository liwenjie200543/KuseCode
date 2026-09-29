import { describe, expect, it } from "vitest";

import {
  ConfigError,
  configFromEnv,
  defaultConfig,
  mergeConfig,
  parseConfigFile,
} from "../src/config/schema.js";
import type { DeepPartial, KuseConfig } from "../src/config/schema.js";

describe("defaultConfig", () => {
  it("缺省：model/dataRoot 为 null，permissionMode 为 ask", () => {
    expect(defaultConfig()).toEqual({ model: null, permissionMode: "ask", dataRoot: null });
  });

  it("观测/预算类的旧键不再属于配置词汇", () => {
    const { warnings } = parseConfigFile(JSON.stringify({ observationCharLimit: 1000, budget: {} }));
    expect(warnings.length).toBe(2);
  });
});

describe("parseConfigFile", () => {
  it("合法文件逐键解析；null 合法", () => {
    const { config, warnings } = parseConfigFile(
      JSON.stringify({ model: "anthropic/claude-haiku-4.5", dataRoot: null }),
    );
    expect(warnings).toEqual([]);
    expect(config).toEqual({ model: "anthropic/claude-haiku-4.5", dataRoot: null });
  });

  it("未知键警告并忽略；疑似凭据键警告", () => {
    const { config, warnings } = parseConfigFile(JSON.stringify({ modle: "typo", apiKey: "sk" }));
    expect(config).toEqual({});
    expect(warnings.some((w) => w.includes("modle"))).toBe(true);
    expect(warnings.some((w) => w.includes("长得像凭据"))).toBe(true);
  });

  it("类型错 → ConfigError 指出键名", () => {
    expect(() => parseConfigFile(JSON.stringify({ model: 42 }))).toThrowError(/model/);
    expect(() => parseConfigFile(JSON.stringify({ dataRoot: [] }))).toThrowError(/dataRoot/);
  });

  it("坏 JSON / 顶层非对象 → ConfigError", () => {
    expect(() => parseConfigFile("{broken")).toThrowError(ConfigError);
    expect(() => parseConfigFile("[1]")).toThrowError(/顶层必须是对象/);
  });
});

describe("configFromEnv", () => {
  it("KUSECODE_MODEL 映射到 model；空白与无关变量忽略", () => {
    expect(configFromEnv({ KUSECODE_MODEL: " openai/gpt " })).toEqual({ model: "openai/gpt" });
    expect(configFromEnv({ KUSECODE_MODEL: "  " })).toEqual({});
    expect(configFromEnv({ PATH: "/x" })).toEqual({});
  });
});

describe("mergeConfig", () => {
  const file: DeepPartial<KuseConfig> = { model: "from-file" };

  it("优先级：flag > env > file > default", () => {
    expect(mergeConfig([{ model: "flag" }, { model: "env" }, file, defaultConfig()]).model).toBe("flag");
    expect(mergeConfig([null, null, file, defaultConfig()]).model).toBe("from-file");
    expect(mergeConfig([null, null, null, defaultConfig()]).model).toBeNull();
  });

  it("显式 null 覆盖低层（关闭低层的模型）", () => {
    expect(mergeConfig([{ model: null }, file, defaultConfig()]).model).toBeNull();
  });
});
