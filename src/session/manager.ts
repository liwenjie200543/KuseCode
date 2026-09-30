/**
 * Session 持久化 —— 一个文件一个会话的 append-only JSONL（specs/session.md）。
 *
 * 首行 header（type:"session"），其后一行一条**终态消息**。换行符是记录边界：
 * torn write（写一半崩溃）的残骸在加载时跳过、追加前清除——崩溃不毁历史。
 * resume 是严格只读的：加载历史进 transcript 后继续向同一文件追加。
 */

import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SessionHeader {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: string;
  readonly title?: string;
}

interface SessionLine {
  readonly type: "session" | "message";
  readonly message?: AgentMessage;
  readonly [key: string]: unknown;
}

/** 尾部没有换行符的残骸在追加前清除：它不是历史，不清掉才真的丢历史。 */
async function truncateTornTail(file: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return;
  }
  if (text === "" || text.endsWith("\n")) return;
  const lastNewline = text.lastIndexOf("\n");
  await writeFile(file, lastNewline === -1 ? "" : text.slice(0, lastNewline + 1), "utf8");
}

export class SessionStorage {
  constructor(private readonly rootDir: string) {}

  private fileFor(id: string): string {
    return join(this.rootDir, `${id}.jsonl`);
  }

  async create(header: SessionHeader): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await this.writeHeader(header);
  }

  /** title 延迟写：首个真实 prompt 到来时重写尚无价值的 header 行。 */
  async writeHeader(header: SessionHeader): Promise<void> {
    const file = this.fileFor(header.id);
    await truncateTornTail(file);
    const line: SessionLine = { type: "session", ...header };
    await writeFile(file, `${JSON.stringify(line)}\n`, "utf8");
  }

  async appendMessage(id: string, message: AgentMessage): Promise<void> {
    const file = this.fileFor(id);
    await mkdir(dirname(file), { recursive: true });
    await truncateTornTail(file);
    const line: SessionLine = { type: "message", message };
    await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
  }

  /** 加载：header + 全部终态消息。torn line 跳过；文件不存在返回 null。 */
  async load(id: string): Promise<{ header: SessionHeader; messages: AgentMessage[] } | null> {
    let text: string;
    try {
      text = await readFile(this.fileFor(id), "utf8");
    } catch {
      return null;
    }
    let header: SessionHeader | null = null;
    const messages: AgentMessage[] = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let parsed: SessionLine;
      try {
        parsed = JSON.parse(line) as SessionLine;
      } catch {
        break; // torn write：残骸及其后不属于历史
      }
      if (parsed.type === "session") header = parsed as unknown as SessionHeader;
      else if (parsed.type === "message" && parsed.message !== undefined) messages.push(parsed.message);
    }
    if (header === null) return null;
    return { header, messages };
  }

  /** 全部会话的摘要（按 mtime 新→旧）。header 损坏的文件跳过。 */
  async list(): Promise<readonly (SessionHeader & { readonly file: string })[]> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch {
      return [];
    }
    const out: (SessionHeader & { readonly file: string })[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith(".jsonl")).sort().reverse()) {
      const loaded = await this.load(name.replace(/\.jsonl$/, ""));
      if (loaded === null) continue;
      out.push({ ...loaded.header, file: name });
    }
    return out;
  }
}

export class SessionManager {
  private storage: SessionStorage;
  /** 写入串行链：append-only 文件要求落盘顺序 = 事件顺序。 */
  private chain: Promise<unknown> = Promise.resolve();
  private currentId: string | null = null;
  private meta: { cwd: string; model: string } | null = null;

  constructor(rootDir: string) {
    this.storage = new SessionStorage(rootDir);
  }

  get id(): string | null {
    return this.currentId;
  }

  /** 新会话：从第一条消息起落盘。 */
  async start(cwd: string, model: string): Promise<string> {
    this.currentId = uuidv7();
    this.meta = { cwd, model };
    await this.storage.create({ id: this.currentId, cwd, model, createdAt: new Date().toISOString() });
    return this.currentId;
  }

  /** 恢复：只读加载，历史进 transcript，之后继续向同一文件追加。 */
  async resume(id: string): Promise<AgentMessage[]> {
    const loaded = await this.storage.load(id);
    if (loaded === null) throw new Error(`会话不存在：${id}`);
    this.currentId = id;
    this.meta = { cwd: loaded.header.cwd, model: loaded.header.model };
    return loaded.messages;
  }

  /** `continue`：同 cwd 的最近会话；没有匹配返回 null。 */
  async continueId(cwd: string): Promise<string | null> {
    const sessions = await this.storage.list();
    const match = sessions.find((header) => header.cwd === cwd);
    return match?.id ?? null;
  }

  /** 记录一条终态消息。持久化失败不致命（永不中断活会话）。并发写入串行化。 */
  record(message: AgentMessage): Promise<void> {
    if (this.currentId === null || this.meta === null) return Promise.resolve();
    this.chain = this.chain.then(() =>
      this.storage.appendMessage(this.currentId as string, message).catch(() => {
        // 持久化永不中断活会话
      }),
    );
    return this.chain as Promise<void>;
  }


}

