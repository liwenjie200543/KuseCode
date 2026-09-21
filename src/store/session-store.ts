/**
 * 会话存储 —— Run 怎么活下来，以及崩溃之后从哪问起。
 *
 * 这个文件只回答一个问题：**哪些 Run 属于哪个会话，以及它们各自停在哪儿？**
 * 它不回答「一个 Run 的状态是什么」——那是回放（`src/runtime/replay.ts`）；
 * 也不回答「事件一行一行长什么样」——那是 JSONL 日志（`./run-log-jsonl.ts`）。
 *
 * 布局：
 *
 * ```text
 * <rootDir>/sessions/<sessionId>.json     会话索引：这个会话有哪几次 Run
 * <rootDir>/<runId>/events.jsonl          事件日志本身（jsonlRunLog 写的）
 * ```
 *
 * ## 一条边界：只存日志答不出来的东西
 *
 * 会话索引里**只有两类事实**：哪些 Run 属于这个会话，以及每个 Run 是什么时候
 * 登记进来的（`createdAt`）与它的 `Task`（`run_started` 的载荷是空的，
 * 见 `docs/04-run-events.md` 局限二）。
 *
 * `Run.status` / `startedAt` / `updatedAt` **不存**——它们全部从日志派生。
 * 这不是省事，是这一步最重要的一条纪律：存一份「运行到哪了」就等于多一个真相，
 * 而它与日志分叉的那一天，没人会收到通知。派生出来的状态不可能与日志不一致，
 * 因为它就是从日志算出来的。
 *
 * 代价是 `getSession` 会读每个 Run 的日志（O(Run 数 × 事件数)）。会话视图不是热路径，
 * 而「先读日志、再回答」正是恢复该有的样子。
 *
 * ## 另一条边界：身份先于运行存在
 *
 * 要能从崩溃里恢复，Run 必须在**开始之前**就登记进会话——否则一次崩溃留下的
 * 是一个没有任何索引的记录。所以 `startRun` 先造 id、先落索引，再把这个 id
 * 交给 Runtime。做法是把身份钉住（`pinnedIdentity`）：Run 的身份本来就可注入
 * （步 4），于是存储能先定下它，而不必让 Runtime 知道存储的存在。
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentEvent, AgentState, Run, RunStatus, Session, Task } from "../core/types.js";
import { cryptoIds } from "../runtime/ids.js";
import type { IdFactory } from "../runtime/ids.js";
import { isRunOver, replayAgentState, runStatusOf } from "../runtime/replay.js";
import type { RunLog } from "../runtime/run-log.js";
import { assertSafePathSegment, jsonlRunLog } from "./run-log-jsonl.js";

// ---------------------------------------------------------------------------
// 索引里存什么
// ---------------------------------------------------------------------------

/**
 * 会话索引里的一条 Run。
 *
 * 三个字段都是**不可变的事实**，也是日志答不出来的那部分：日志回答「发生了什么」，
 * 索引回答「这属于谁、什么时候登记进来的、要干什么」。
 */
interface RunRecord {
  readonly runId: string;
  /** 登记的时刻（epoch ms）。它不是 `run_started` 的时刻——那时运行才真的开始。 */
  readonly createdAt: number;
  readonly task: Task;
}

interface SessionRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly runs: readonly RunRecord[];
}

// ---------------------------------------------------------------------------
// 对外形状
// ---------------------------------------------------------------------------

/** 一次刚登记好的 Run：身份、任务、它的事件落在哪里。 */
export interface StartedRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly task: Task;
  /** 这次 Run 的事件日志。直接摊进 `createRuntime` 的 `log`。 */
  readonly log: RunLog;
  /**
   * 身份工厂，已经把这个 `runId` 钉好。
   *
   * **只服务一次 Run**：`runId()` 被问第二次就抛错。它让「存储定身份、Runtime 用身份」
   * 成立，而不必给 Runtime 加一个「请用这个 id」的开关（那会是第二套身份来源）。
   */
  readonly ids: IdFactory;
}

/** 一次恢复的结果：日志、由日志重建的状态、以及这个 Run 停在哪儿。 */
export interface RecoveredRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly task: Task;
  readonly events: readonly AgentEvent[];
  readonly state: AgentState;
  readonly status: RunStatus;
}

export interface SessionStore {
  createSession(): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  /**
   * 这个存储里已有的会话 id，按字典序。
   *
   * 它在这里而不是在 CLI 里"自己去看 `sessions/` 目录"：目录布局是存储的实现细节，
   * 而步 9 的 `kuse sessions` 只需要"有哪些会话"。让产品层去 glob 一个内部目录，
   * 等于把布局冻结成公开契约——那种依赖会在某次重构之后安静地坏掉。
   */
  listSessions(): Promise<readonly string[]>;
  /**
   * 把一个 Run 登记进会话，并交出它的日志与身份。
   *
   * 会话不存在时抛错，而不是顺手建一个：往一个不存在的会话里塞 Run 是调用方
   * 的错误，悄悄造一个只会让「会话隔离」在无人察觉的时候失效。
   */
  startRun(sessionId: string, task: Task): Promise<StartedRun>;
  /** 恢复入口：读回日志、重建状态、得出它停在哪儿。没有这个 Run 时返回 null。 */
  recover(sessionId: string, runId: string): Promise<RecoveredRun | null>;
  /** 这个会话里**还没走完**的 Run：崩溃之后要接着处理的就是它们。 */
  unfinished(sessionId: string): Promise<readonly string[]>;
}

export interface SessionStoreOptions {
  /** 存储根目录。生产里通常是 `runs/`（已在 .gitignore 中被忽略）。 */
  readonly rootDir: string;
  /** 身份的生成方式。默认 `cryptoIds()`；测试用 `sequentialIds()`。 */
  readonly ids?: IdFactory;
  /** 时间来源。默认 `Date.now`。 */
  readonly clock?: () => number;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/**
 * 把身份钉在一个已经定下来的 id 上。
 *
 * 「只服务一次」不是洁癖：一个能反复给出同一个 `runId` 的工厂，会让两次 Run 的
 * 事件写进同一份日志（`sequence` 从 0 重来，第二次的第一条立刻被
 * `assertAppendOnly` 拒绝）。与其等日志报错，不如在问第二次的时候就直说。
 */
function pinnedIdentity(runId: string, base: IdFactory): IdFactory {
  let handedOut = false;
  return {
    sessionId: () => base.sessionId(),
    runId: () => {
      if (handedOut) {
        throw new Error(
          `这个身份工厂已经把 ${runId} 交出去过了：它是为一次 Run 准备的。` +
            `再要一个 id 请重新 startRun——两次 Run 共用一个 runId 会把两份日志写进同一个文件`,
        );
      }
      handedOut = true;
      return runId;
    },
    toolCallId: () => base.toolCallId(),
  };
}

function sessionPath(rootDir: string, sessionId: string): string {
  assertSafePathSegment(sessionId, "sessionId");
  return join(rootDir, "sessions", `${sessionId}.json`);
}

async function readSessionRecord(file: string): Promise<SessionRecord | null> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }

  // 会话索引坏了就直说。它不是事件日志（没有「写了一半的记录」这种中间态），
  // 所以这里没有宽容的余地：一个读不懂的索引意味着我们不知道有哪些 Run 存在。
  return JSON.parse(content) as SessionRecord;
}

/**
 * 原子地写一份索引：先写临时文件，再改名。
 *
 * 会话索引是**会被重写**的（每加一次 Run 就重写一遍），所以「写到一半崩了」
 * 是它真实的失败模式。改名是原子的，于是读者要么看到旧的完整版本，
 * 要么看到新的完整版本，不会看到半个 JSON。事件日志不需要这一手——它只追加。
 */
async function writeSessionRecord(file: string, record: SessionRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const rootDir = options.rootDir;
  const ids = options.ids ?? cryptoIds();
  const clock = options.clock ?? ((): number => Date.now());
const log = jsonlRunLog({ rootDir });

/**
 * 这个字符串能不能当会话 id 用（也就是能不能当文件名）。
 *
 * 判据与写入路径用的是**同一个** `assertSafePathSegment`：这里只是把它的"抛错"
 * 换成"是不是"。两处共用一份规则，所以"能写进去"与"能读出来"不可能分叉。
 */
function isUsableSessionId(value: string): boolean {
  try {
    assertSafePathSegment(value, "sessionId");
    return true;
  } catch {
    return false;
  }
}

/**
 * 读一份会话索引。
 *
 * 一个**不可能**是会话 id 的字符串（空、含分隔符、`..`）在这里的答案是 `null`——
 * 也就是"没有这个会话"。这不是对坏输入的宽容，而是两个方向的严格程度本来就不同：
 *
 * - **写**一个坏名字是调用方的错误，必须抛（那条路仍然经过 `assertSafePathSegment`）；
 * - **读**一个坏名字只是没找到。让它在只读路径上抛出去，会把用户的一次手误
 *   （`kuse runs 'sess:a b'`）报成"内部错误"，而脚本据此分不清
 *   "重试有用"与"参数得改"——正是退出码那张表要防的事。
 *
 * `startRun` 也走这里，于是"往一个坏名字里登记 Run"会得到
 * 「会话 X 不存在：先 createSession() 再往里登记 Run」，而不是一句关于文件名的报错。
 * 两句话都是真的，但前者对调用方更有用。
 */
const load = async (sessionId: string): Promise<SessionRecord | null> => {
  if (!isUsableSessionId(sessionId)) return null;
  return readSessionRecord(sessionPath(rootDir, sessionId));
};

  /**
   * 从日志派生一个 `Run`。
   *
   * 这是「不存状态」那条纪律的落点：`status` 由事件算、`startedAt` 取
   * `run_started` 的时刻、`updatedAt` 取最后一条事件的时刻。索引只贡献两样日志
   * 确实答不出来的东西：`createdAt`（登记的准确时刻，用于「排队中」的 Run）
   * 与 `task`。
   */
  const deriveRun = (record: RunRecord, sessionId: string): Run => {
    const events = log.read(record.runId);
    const first = events[0];
    const last = events[events.length - 1];
    const startedAt = first === undefined ? record.createdAt : first.timestamp;
    return {
      runId: record.runId,
      sessionId,
      task: record.task,
      status: runStatusOf(events),
      startedAt,
      updatedAt: last === undefined ? startedAt : last.timestamp,
    };
  };

  return {
    async createSession(): Promise<Session> {
      const id = ids.sessionId();
      const createdAt = clock();
      const record: SessionRecord = { id, createdAt, runs: [] };
      await writeSessionRecord(sessionPath(rootDir, id), record);
      return { id, createdAt, runs: [] };
    },

    async getSession(id: string): Promise<Session | null> {
      const record = await load(id);
      if (record === null) return null;
      return {
        id: record.id,
        createdAt: record.createdAt,
        runs: record.runs.map((run) => deriveRun(run, record.id)),
      };
    },

    async listSessions(): Promise<readonly string[]> {
      const dir = join(rootDir, "sessions");
      let files: readonly string[];
      try {
        files = await readdir(dir);
      } catch (error) {
        // 一个还没写过任何会话的存储目录不是一个错误：它是"空的"。
        // 别的错误（权限、路径被占）照常抛出——那些不是"没有会话"。
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "ENOENT"
        ) {
          return [];
        }
        throw error;
      }
      return files
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .sort();
    },

    async startRun(sessionId: string, task: Task): Promise<StartedRun> {
      const record = await load(sessionId);
      if (record === null) {
        throw new Error(
          `会话 ${sessionId} 不存在：先 createSession() 再往里登记 Run。` +
            `「往不存在的会话里塞一个 Run」被拒绝，而不是顺手建一个——` +
            `悄悄多出来的会话会让隔离在无人察觉的时候失效`,
        );
      }

      const runId = ids.runId();
      const next: SessionRecord = {
        id: record.id,
        createdAt: record.createdAt,
        runs: [...record.runs, { runId, createdAt: clock(), task }],
      };
      await writeSessionRecord(sessionPath(rootDir, sessionId), next);

      return { runId, sessionId, task, log, ids: pinnedIdentity(runId, ids) };
    },

    async recover(sessionId: string, runId: string): Promise<RecoveredRun | null> {
      const record = await load(sessionId);
      const run = record?.runs.find((candidate) => candidate.runId === runId);
      if (record === null || run === undefined) return null;

      const events = log.read(runId);
      return {
        runId,
        sessionId,
        task: run.task,
        events,
        state: replayAgentState(events, run.task),
        status: runStatusOf(events),
      };
    },

    async unfinished(sessionId: string): Promise<readonly string[]> {
      const record = await load(sessionId);
      if (record === null) return [];
      return record.runs
        .filter((run) => !isRunOver(deriveRun(run, sessionId).status))
        .map((run) => run.runId);
    },
  };
}
