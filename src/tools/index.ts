/** 工具集组装：SDK 内建（read/write/edit/bash 经 env 适配）+ 自研搜索三件套。 */

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
} from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { ExecutionEnv } from "@earendil-works/pi-agent-core";

import { createFindTool, createGrepTool, createLsTool } from "./search.js";
import type { ToolEntry, ToolRisk } from "./registry.js";

/** AgentHarnessTool → AgentTool：把 env 作为上下文注入（唯一的适配点）。 */
function harness(env: ExecutionEnv, harnessTool: AgentHarnessTool<{ env: ExecutionEnv }>, risk: ToolRisk): ToolEntry {
  const tool: AgentTool = {
    ...harnessTool,
    execute: (id, params, signal, onUpdate) => harnessTool.execute(id, params, signal, onUpdate, { env }),
  };
  return { tool, risk };
}

/** 默认工具集。risk：读类 safe，写类 confirm（permissions/ 消费）。 */
export function createDefaultTools(env: ExecutionEnv): ToolEntry[] {
  return [
    harness(env, createReadTool(), "safe"),
    harness(env, createLsTool(env), "safe"),
    harness(env, createGrepTool(env), "safe"),
    harness(env, createFindTool(env), "safe"),
    harness(env, createWriteTool(), "confirm"),
    harness(env, createEditTool(), "confirm"),
    harness(env, createBashTool(), "confirm"),
  ];
}
