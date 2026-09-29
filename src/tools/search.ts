/**
 * 搜索类工具：grep / find / ls（SDK 没有的三个，手写；全部 safe）。
 * 路径围栏由 env 承担；跳过 node_modules/.git 等共识目录。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { ExecutionEnv } from "@earendil-works/pi-agent-core";

const IGNORED = new Set(["node_modules", ".git", "dist", "coverage", ".kusecode"]);

function text(content: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: content }], details: undefined };
}

function isTextBuffer(buffer: Buffer): boolean {
  return !buffer.subarray(0, 1000).includes(0);
}

async function walkFiles(root: string, dir: string, limit: number, out: string[]): Promise<boolean> {
  if (out.length >= limit) return false;
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= limit) return false;
    if (IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(await walkFiles(root, full, limit, out))) return false;
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const grepSchema = Type.Object({
  pattern: Type.String({ description: "JS 正则（不区分大小写）" }),
  path: Type.Optional(Type.String({ description: "起始目录，相对项目根；省略即根目录" })),
  include: Type.Optional(Type.String({ description: "文件名 glob 过滤，如 *.ts" })),
  maxMatches: Type.Optional(Type.Number({ description: "最大命中数，默认 50" })),
});

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function createGrepTool(env: ExecutionEnv): AgentTool<typeof grepSchema> {
  return {
    name: "grep",
    label: "Grep",
    description: "在项目文件里按正则搜索文本行，返回 文件:行号:内容",
    parameters: grepSchema,
    execute: async (_id, raw) => {
      const args = raw as { pattern: string; path?: string; include?: string; maxMatches?: number };
      const maxMatches = args.maxMatches ?? 50;
      let expression: RegExp;
      try {
        expression = new RegExp(args.pattern, "i");
      } catch (error) {
        return text(`grep 的 pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}`);
      }
      const base = await env.absolutePath(args.path ?? ".");
      if (!base.ok) return text(`grep 路径无效：${base.error.message}`);
      const include = args.include === undefined ? null : globToRegExp(args.include);

      const files: string[] = [];
      await walkFiles(env.cwd, base.value, 2000, files);
      const matches: string[] = [];
      for (const file of files) {
        if (matches.length >= maxMatches) break;
        if (include !== null && !include.test(file.split(/[\\/]/).pop() ?? "")) continue;
        const buffer = await readFile(file).catch(() => null);
        if (buffer === null || !isTextBuffer(buffer)) continue;
        const lines = buffer.toString("utf8").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!expression.test(line)) continue;
          matches.push(`${file.slice(env.cwd.length + 1).replace(/\\/g, "/")}:${index + 1}: ${line.trim().slice(0, 300)}`);
          if (matches.length >= maxMatches) break;
        }
      }
      if (matches.length === 0) return text(`没有命中：${args.pattern}`);
      return text([...matches, matches.length >= maxMatches ? `（达到上限 ${maxMatches}，提前停止）` : ""].filter(Boolean).join("\n"));
    },
  };
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

const findSchema = Type.Object({
  glob: Type.String({ description: "文件名 glob，如 *.ts 或 **/*.md" }),
  path: Type.Optional(Type.String({ description: "起始目录；省略即根目录" })),
});

export function createFindTool(env: ExecutionEnv): AgentTool<typeof findSchema> {
  return {
    name: "find",
    label: "Find",
    description: "按文件名 glob 查找文件，返回相对路径（排序）",
    parameters: findSchema,
    execute: async (_id, raw) => {
      const args = raw as { glob: string; path?: string };
      const base = await env.absolutePath(args.path ?? ".");
      if (!base.ok) return text(`find 路径无效：${base.error.message}`);
      const include = globToRegExp(args.glob.includes("/") ? args.glob.split(/[\\/]/).pop() ?? args.glob : args.glob);

      const files: string[] = [];
      await walkFiles(env.cwd, base.value, 1000, files);
      const hits = files
        .filter((file) => include.test(file.split(/[\\/]/).pop() ?? ""))
        .map((file) => file.slice(env.cwd.length + 1).replace(/\\/g, "/"))
        .sort();
      if (hits.length === 0) return text(`没有匹配：${args.glob}`);
      return text(hits.join("\n"));
    },
  };
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "目录，相对项目根；省略即根目录" })),
});

export function createLsTool(env: ExecutionEnv): AgentTool<typeof lsSchema> {
  return {
    name: "ls",
    label: "Ls",
    description: "列出目录内容（目录优先，带类型标记与大小）",
    parameters: lsSchema,
    execute: async (_id, raw) => {
      const args = raw as { path?: string };
      const target = await env.absolutePath(args.path ?? ".");
      if (!target.ok) return text(`ls 路径无效：${target.error.message}`);
      const info = await stat(target.value).catch(() => null);
      if (info === null) return text(`目录不存在：${args.path ?? "."}`);
      if (!info.isDirectory()) return text(`${args.path ?? "."} 不是一个目录`);

      const names = (await readdir(target.value)).sort((a, b) => a.localeCompare(b));
      const rows: string[] = [];
      for (const name of names) {
        if (IGNORED.has(name)) continue;
        const child = await stat(join(target.value, name)).catch(() => null);
        if (child === null) continue;
        const marker = child.isDirectory() ? "/" : "";
        rows.push(`${name}${marker}  ${child.isFile() ? `${child.size}B` : ""}`);
      }
      return text(rows.length === 0 ? "（空目录）" : rows.join("\n"));
    },
  };
}
