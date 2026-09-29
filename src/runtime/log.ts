/**
 * 事件日志 —— Runtime Reliability 的落盘形态（append-only JSONL）。
 *
 * 一行一条事件，换行符是记录边界：有换行的行一定写全了，没有换行的尾巴
 * 是写了一半的崩溃残骸，读取时跳过、追加前截掉（不是历史，清掉它才不丢真历史）。
 * 回放（rebuild transcript）、恢复（unfinished 检测）、trace（what/why/cost）
 * 都从这一份日志派生——不维护第二份真相。
 */

import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface LogEvent {
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return JSON.stringify({ type: "unserializable" });
  }
}

export class EventLog {
  private cached: LogEvent[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** 读取全部事件（坏尾行被跳过，不抛错）。 */
  async read(): Promise<LogEvent[]> {
    if (this.cached !== null) return this.cached;
    let text = "";
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return (this.cached = []);
    }
    const events: LogEvent[] = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        events.push(JSON.parse(line) as LogEvent);
      } catch {
        break; // torn write：最后一个不完整记录之后的都不属于历史
      }
    }
    return (this.cached = events);
  }

  /** 追加一条事件（seq 自动接续）。写入前先清掉崩溃残骸。并发调用串行化。 */
  append(event: Omit<LogEvent, "seq" | "ts"> & { readonly ts?: number }): Promise<LogEvent> {
    this.chain = this.chain.then(() => this.appendLocked(event));
    return this.chain as Promise<LogEvent>;
  }

  private async appendLocked(event: Omit<LogEvent, "seq" | "ts"> & { readonly ts?: number }): Promise<LogEvent> {
    const existing = await this.read();
    const full: LogEvent = {
      seq: existing.length,
      ts: event.ts ?? Date.now(),
      type: event.type,
      ...event,
    } as LogEvent;
    const line = safeJson(full);
    // 序列化之后读回来比一次：JSON 会安静地改变一些值（undefined 丢键、NaN 变 null），
    // 而安静地改变一条证据比拒绝它糟得多。
    if ((JSON.parse(line) as LogEvent).type !== full.type) {
      throw new Error("事件日志拒绝写入：序列化不一致");
    }
    await mkdir(dirname(this.file), { recursive: true });
    await this.truncateTornTail();
    await appendFile(this.file, `${line}\n`, "utf8");
    existing.push(full);
    return full;
  }

  /** 尾部没有换行符 = 写了一半的残骸；把它截掉，下一次追加才不会粘成一行。 */
  private async truncateTornTail(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return;
    }
    if (text === "" || text.endsWith("\n")) return;
    const lastNewline = text.lastIndexOf("\n");
    const kept = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
    await writeFile(this.file, kept, "utf8");
  }
}

/** 会话的事件日志文件路径：`<root>/sessions/<id>.jsonl`。 */
export function eventLogFor(root: string, sessionId: string): EventLog {
  return new EventLog(join(root, "sessions", `${sessionId}.jsonl`));
}

export function ensureDirFor(file: string): string {
  return dirname(file);
}
