/**
 * JSONL 事件日志 —— 活下来的那一份。
 *
 * 这个文件只回答一个问题：**真相落在磁盘上的哪里、以什么形状？**
 * 它不回答「事件说的是哪个状态」——那是 `src/runtime/replay.ts`。
 * 契约（`RunLog`）与不变量（`assertAppendOnly`）从 Runtime 导入，不在这里重写：
 * **契约属于 Runtime，载体属于存储。** 换载体（文件、数据库、远端）不改契约，
 * 也就不改驱动它的代码。
 *
 * 布局：
 *
 * ```text
 * <rootDir>/<runId>/events.jsonl     一行一条事件，换行终止，只追加
 * ```
 *
 * 四条边界在这里落地：
 *
 * 1. **「记录」的边界是换行符。** 一行写完才写换行（内容与换行在同一次
 *    `appendFile` 调用里，内容在前），所以：**有换行符的行一定写全了。** 反过来，
 *    没有换行符的尾巴从来不是一条记录——它是一次写了一半的崩溃残骸（torn write）。
 *    读的时候丢掉它；下一次追加之前先把它截掉。它不是历史，所以清理它不违反
 *    「只追加」——恰恰相反，不清理才会真的丢东西：下一条记录会和残骸粘成一行，
 *    一次损坏就变成两条事实同时消失。
 * 2. **`read` 从磁盘读，用的是同步 API。** 契约里的 `read` 是同步签名（步 4 定形时
 *    的理由是「按真实实现的需要定形」），而恢复恰恰发生在一个**从没 append 过的
 *    进程**里——所以读盘不能用「本进程写过的内存副本」。同步 API 在这里不是偷懒，
 *    它就是让「事件活下来」成立的那一步：恢复是一次启动时的动作，没有并发要等。
 * 3. **写下去的东西，读回来必须是同一条。** 这是日志的最终目的地（步 6 的关卡 6/8
 *    就是为它准备的），所以最后一道关设在这里：序列化之后再比一次，不相等就拒绝
 *    写入。`JSON` 会**安静地**改变一些值（`undefined` 丢键、`NaN` 变 `null`、
 *    `Map` 变 `{}`），而安静地改变一条证据比拒绝它糟得多。
 * 4. **一个 Run 只有一个写者。** 追加路径记着「这个进程最后一次读到的序列」，
 *    才能在 O(1) 内判断新事件接得上（每次重读整个文件是 O(n²)）。这条捷径默认
 *    没人 concurrently 写同一份日志——Runtime 的 `emit` 是串行的，所以这个默认
 *    成立；并发写同一个 Run 不在契约里，也不假装在。
 */

// `readFileSync` 来自 `node:fs`（`node:fs/promises` 里没有同步 API），
// 其余来自 promises 版本。这个混用是本文件第二条边界的直接后果：`read` 的契约
// 是同步的，而恢复发生在一个从没写过东西的进程里，所以它必须同步读盘。
import { readFileSync } from "node:fs";
import { appendFile, mkdir, truncate } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { AgentEvent } from "../core/types.js";
import { assertAppendOnly } from "../runtime/run-log.js";
import type { RunLog } from "../runtime/run-log.js";

// ---------------------------------------------------------------------------
// 位置
// ---------------------------------------------------------------------------

/**
 * 一个 Run 的事件文件在哪。
 *
 * `runId` 会直接变成目录名，所以它必须先过一道形状校验：`../../etc/passwd`
 * 这样的 id 会让日志写到根目录外面去。id 由我们自己的 `IdFactory` 生成
 * （`run_<uuid>` / `<prefix>-run-1`），所以这条校验拦的不是正常输入，
 * 而是「将来某个调用方把用户输入当 id 用」这类错误——那时它必须是响的。
 * 会话索引的 `sessionId` 也走同一道校验（同一个函数，不写第二份）。
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function assertSafePathSegment(value: string, what: string): void {
  const safe = SEGMENT_PATTERN.test(value) && value !== "." && value !== "..";
  if (!safe) {
    throw new Error(
      `${what} 会被当作文件名使用，所以它只能是字母、数字、点、下划线与短横线，` +
        `且不能是 "." 或 ".."：收到 ${JSON.stringify(value)}`,
    );
  }
}

/** 一个 Run 的事件文件路径。导出它是为了让调用方能检查、备份或修一份日志。 */
export function eventsPathFor(rootDir: string, runId: string): string {
  assertSafePathSegment(runId, "runId");
  return join(rootDir, runId, "events.jsonl");
}

// ---------------------------------------------------------------------------
// 「一份文件」→「一串事件」：读与写共用的那一份判断
// ---------------------------------------------------------------------------

interface Loaded {
  /** 解析出来的事件，按 sequence 升序。 */
  readonly events: AgentEvent[];
  /**
   * 文件尾部如果有写了一半的残骸，这里是**它前面那一段的字节长度**
   * （也就是该截到哪里）；没有残骸时为 null。
   */
  tornBytes: number | null;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * 把一份日志文本切成记录、再解析成事件。
 *
 * 顺序就是全部要点：**先切行，再决定哪一段是记录，最后才逐条解析。**
 * 最后一段是残骸还是记录，由「文件是不是以换行结尾」决定，不由内容决定——
 * 内容看着像不像 JSON 是另一件事（那是损坏，不是残骸）。
 */
function parseLogText(content: string, file: string): Loaded {
  if (content === "") return { events: [], tornBytes: null };

  // `"a\nb\n".split("\n")` → ["a", "b", ""]：末尾那个空串不是记录，切掉。
  // `"a\nb"`  → ["a", "b"]：末尾那段没有换行符终止，它是残骸，同样切掉。
  // 于是两种情况都是 slice(0, -1)，区别只在于要不要记住残骸的长度。
  const records = content.split("\n").slice(0, -1);

  let tornBytes: number | null = null;
  if (!content.endsWith("\n")) {
    const lastNewline = content.lastIndexOf("\n");
    // 一条换行都没有 → 整份文件都是残骸 → 截到 0。
    tornBytes = Buffer.byteLength(lastNewline === -1 ? "" : content.slice(0, lastNewline + 1), "utf8");
  }

  const events: AgentEvent[] = [];
  for (const [index, record] of records.entries()) {
    if (record === "") continue; // 空行只能来自外部编辑；缺失的事件会被下面的连续性检查抓住
    let parsed: unknown;
    try {
      parsed = JSON.parse(record);
    } catch {
      throw new Error(
        `${file} 第 ${index + 1} 行不是合法的 JSON。这一行是被换行符终止的，` +
          `而写下的每一行都是「内容在前、换行在后」——所以一个写全了的行必然能解析。` +
          `它坏了，只可能是日志被外部改过，或者磁盘出了问题`,
      );
    }
    // 同一个不变量（Runtime 的那一份实现）：sequence 必须严格接在已有事件之后。
    // 有洞、有重复、或者根本不是一条事件（`undefined`），都在这里当场报出来。
    assertAppendOnly(events, parsed as AgentEvent);
    events.push(parsed as AgentEvent);
  }

  return { events, tornBytes };
}

// ---------------------------------------------------------------------------
// 写盘
// ---------------------------------------------------------------------------

/**
 * 序列化之后再读一次，确认是同一条事件。
 *
 * 它不是步 6 那道关的重复：步 6 守的是「工具的返回值能不能进状态」，
 * 这一道守的是「一条事件能不能进文件」——`decision_made` 里带着模型给的
 * `ToolIntent.args`，它在工具开跑之前就已经落日志了，那时步 6 的关卡还没经过。
 * 两个对象、两个时机，判据是同一条：JSON 装不下的东西，不能进日志。
 */
function serializeRoundTripped(event: AgentEvent): string {
  let line: string;
  try {
    line = JSON.stringify(event);
  } catch (error) {
    throw new Error(
      `这条 ${event.type} 事件序列化不了` +
        `（${error instanceof Error ? error.message : String(error)}）：日志是 JSONL，装不下的东西不能进日志`,
    );
  }

  // JSON.parse 不会抛：line 刚刚由 JSON.stringify 产出。所以这里比的是**值**，
  // 不是「能不能解析」——要抓的正是 JSON 那些安静的变化。
  if (!isDeepStrictEqual(JSON.parse(line), event)) {
    throw new Error(
      `这条 ${event.type} 事件过不了 JSON 往返：序列化之后再读回来已经不是同一条了` +
        `（undefined 丢键、NaN 变 null、Map 变 {} 都属于这一类）。` +
        `安静地改变一条证据，比拒绝写下它糟得多`,
    );
  }

  return line;
}

export interface JsonlRunLogOptions {
  /** 所有 Run 的日志根目录；每个 Run 一个子目录。生产里通常是 `runs/`。 */
  readonly rootDir: string;
}

/**
 * 建一个 JSONL 日志。
 *
 * 它**不**在内存里留一份权威副本：`read` 每次都读盘。缓存只是「这个进程最后
 * 一次读盘的结果」，用来让追加不必承担 O(n²) 的读。
 */
export function jsonlRunLog(options: JsonlRunLogOptions): RunLog {
  const rootDir = options.rootDir;
  const cache = new Map<string, Loaded>();

  return {
    async append(event: AgentEvent): Promise<void> {
      const file = eventsPathFor(rootDir, event.runId);

      // 先过一遍「这条事件写不写得下」，再动任何文件：被拒绝的写入
      // 不该在磁盘上留下半个动作。
      const line = serializeRoundTripped(event);

      const cached = cache.get(event.runId);
      const state = cached ?? parseLogText(await readText(file), file);
      assertAppendOnly(state.events, event);

      await mkdir(join(rootDir, event.runId), { recursive: true });

      if (state.tornBytes !== null) {
        // 残骸不是记录，截掉它不删除任何历史——这是让「只追加」重新成立的唯一办法。
        await truncate(file, state.tornBytes);
        state.tornBytes = null;
      }

      // 一条记录写在一次调用里：内容在前、换行在后。所以「有换行 = 写全了」成立。
      await appendFile(file, `${line}\n`);
      state.events.push(event);
      cache.set(event.runId, state);
    },

    read(runId: string): readonly AgentEvent[] {
      const file = eventsPathFor(rootDir, runId);
      const state = parseLogText(readText(file), file);
      // 顺手把缓存刷新成刚读到的这一份：读盘的结果永远比缓存新。
      cache.set(runId, state);
      return Object.freeze([...state.events]);
    },
  };
}

/** 读一份日志文本；文件不存在与空文件是同一件事：还没有事件。 */
function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return "";
    throw error;
  }
}
