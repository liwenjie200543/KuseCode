import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { SessionManager } from "../src/session/manager.js";
import { findUnfinished, listRecoveryInfo } from "../src/runtime/recovery.js";

let dir = "";
let projectA = "";
let projectB = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kuse-recovery-"));
  projectA = join(dir, "project-a");
  projectB = join(dir, "project-b");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("recovery（哪些会话还没走完，SDD Phase 10）", () => {
  it("完整会话 finished=true；中断会话 finished=false", async () => {
    const done = new SessionManager(dir);
    const doneId = await done.start(projectA, "mock");
    await done.record({ role: "user", content: "问题", timestamp: 0 } as never);
    await done.record({ role: "assistant", content: "回答", timestamp: 0 } as never);

    const unfinished = new SessionManager(dir);
    const unfinishedId = await unfinished.start(projectA, "mock");
    await unfinished.record({ role: "user", content: "中途死掉的问题", timestamp: 0 } as never);

    const infos = await listRecoveryInfo(dir);
    const doneInfo = infos.find((info) => info.id === doneId);
    const unfinishedInfo = infos.find((info) => info.id === unfinishedId);
    expect(doneInfo?.finished).toBe(true);
    expect(unfinishedInfo?.finished).toBe(false);
    expect(unfinishedInfo?.messageCount).toBe(1);
  });

  it("findUnfinished：cwd 匹配的未完成会话；没有则 null", async () => {
    const unfinished = new SessionManager(dir);
    const id = await unfinished.start(projectA, "mock");
    await unfinished.record({ role: "user", content: "崩在中途", timestamp: 0 } as never);

    expect((await findUnfinished(dir, projectA))?.id).toBe(id);
    expect(await findUnfinished(dir, projectB)).toBeNull();
  });

  it("continue 语义：恢复未完成会话后补上回答即 finished", async () => {
    const unfinished = new SessionManager(dir);
    const id = await unfinished.start(projectA, "mock");
    await unfinished.record({ role: "user", content: "崩在中途", timestamp: 0 } as never);

    const fresh = new SessionManager(dir);
    const messages = await fresh.resume(id);
    await fresh.record({ role: "assistant", content: "补上的回答", timestamp: 0 } as never);

    expect(messages).toHaveLength(1);
    const after = await listRecoveryInfo(dir);
    // resume + record 后最后一条是 assistant → finished，不再是恢复候选
    expect(after.find((info) => info.id === id)?.finished).toBe(true);
    expect(await findUnfinished(dir, projectA)).toBeNull();
  });
});
