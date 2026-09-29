/**
 * Recovery —— "哪些会话还没走完"（specs/session.md）。
 *
 * 判据：会话文件里最后一条**终态消息**不是 assistant 回答，就是中断——
 * 崩溃、进程被杀、abort 都落在这里。它与 replay 的分工：replay 重建
 * transcript（resume 用），recovery 只回答"要不要接续"。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { SessionStorage } from "../session/manager.js";

export interface SessionRecoveryInfo {
  readonly id: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly finished: boolean;
  readonly messageCount: number;
}

function lastRole(messages: readonly AgentMessage[]): string | null {
  const last = messages.at(-1) as { role?: string } | undefined;
  return last?.role ?? null;
}

export function listRecoveryInfo(rootDir: string): Promise<readonly SessionRecoveryInfo[]> {
  const storage = new SessionStorage(rootDir);
  return storage.list().then(async (headers) =>
    Promise.all(
      headers.map(async (header) => {
        const loaded = await storage.load(header.id);
        const messages = loaded?.messages ?? [];
        return {
          id: header.id,
          title: header.title ?? null,
          cwd: header.cwd ?? null,
          finished: lastRole(messages) === "assistant",
          messageCount: messages.length,
        };
      }),
    ),
  );
}

/** 最近一个未完成、且 cwd 匹配的会话（`kuse continue` 的候选）。 */
export async function findUnfinished(
  rootDir: string,
  cwd?: string,
): Promise<SessionRecoveryInfo | null> {
  const infos = await listRecoveryInfo(rootDir);
  return (
    infos.find(
      (info) => !info.finished && (cwd === undefined || info.cwd === null || info.cwd === cwd),
    ) ?? null
  );
}
