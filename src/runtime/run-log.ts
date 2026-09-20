/**
 * 事件日志 —— 一次 Run 的**唯一真相**。
 *
 * 这里只有契约和一份内存实现；真正活下来的那份（一行一事件的 JSONL）在步 7，
 * 它的位置（`src/store/run-log-jsonl.ts`）与本文件分开是刻意的：
 * **契约属于 Runtime，载体属于存储。** 换载体（文件、数据库、远端）不该改契约，
 * 也不该改驱动它的代码。
 *
 * 步 2 的文档把这条接口推迟到步 7，前提是「等真正实现持久化时一并定」——
 * 那时还没有驱动方。步 4 有了驱动方，也就有了「事件落在哪里」这个必须现在回答的问题：
 * 一次 Run 的产物是一串有序事件，而「有序」必须有地方成立。所以接口在这里落地。
 *
 * ## 为什么 `append` 是异步的
 *
 * 内存实现可以同步，但生产实现（文件 I/O）不行。接口按**真实实现**的需要定形，
 * 而不是按假实现——否则步 7 换实现时要改签名，那正是「接口被假实现带偏」的症状。
 * 代价是内存实现里多一个 `async`，这笔账很便宜。
 */

import type { AgentEvent } from "../core/types.js";

/**
 * 追加式事件日志。
 *
 * 两条不变量，由所有实现共同守住（`assertAppendOnly` 是它们唯一的实现）：
 *
 * 1. **只追加**：已经写下的事件不会被改写、不会被重排、不会被删除；
 * 2. **每个 Run 内 sequence 连续**：第 n 条事件的 sequence 必须是 n，
 *    从 0 开始。一个洞、一次重复，都是日志被破坏的证据，必须在写入那一刻就报错，
 *    而不是等回放（步 7）重建出错误的 state 时才发现。
 *
 * 第 2 条同时解释了为什么日志不接受「补写历史」：`read` 的产物是回放的输入，
 * 而回放要求「同一个日志重建出同一个状态」——允许洞就等于允许不可解释的输入。
 */
export interface RunLog {
  /** 追加一条事件。违反不变量时抛错（拒绝写入，而不是写进去再说）。 */
  append(event: AgentEvent): Promise<void>;
  /**
   * 读回一个 Run 的**全部**事件，按 sequence 升序。
   *
   * 返回的数组是快照：调用方拿它排序、断言、交给回放，都不会影响日志本身。
   * 消费完之后这条流仍然完整——「事件流可回放」的充分性就建立在这一条上。
   */
  read(runId: string): readonly AgentEvent[];
}

/**
 * 追加不变量本身。所有实现共用它，而不是各自记得检查。
 *
 * 它接收已有的序列与待写入的事件：`existing.length` 就是「下一条应该是几号」，
 * 所以判断不需要遍历，也不需要信任调用方传进来的东西。
 */
export function assertAppendOnly(existing: readonly AgentEvent[], event: AgentEvent): void {
  if (event.sequence !== existing.length) {
    throw new Error(
      `事件日志只接受追加：Run ${event.runId} 已有 ${existing.length} 条事件，` +
        `下一条的 sequence 必须是 ${existing.length}，但收到 ${event.sequence}`,
    );
  }
}

/**
 * 内存实现：进程里活着的日志。
 *
 * 它是不持久的——进程结束就没了，这一点不掩饰。它的用处有两个：
 * 测试里作为可断言的现场；以及作为「日志是什么」的最小参照物，
 * 让 JSONL 实现（步 7）有一个可以逐条对照的行为定义。
 */
export function memoryRunLog(): RunLog {
  const byRun = new Map<string, AgentEvent[]>();

  return {
    async append(event: AgentEvent): Promise<void> {
      const events = byRun.get(event.runId);
      if (events === undefined) {
        assertAppendOnly([], event);
        byRun.set(event.runId, [event]);
        return;
      }
      assertAppendOnly(events, event);
      events.push(event);
    },

    read(runId: string): readonly AgentEvent[] {
      return Object.freeze([...(byRun.get(runId) ?? [])]);
    },
  };
}
