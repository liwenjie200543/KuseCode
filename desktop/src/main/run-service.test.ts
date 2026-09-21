import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RunService, type RunFinishedInfo, type RunPushEvent } from "./run-service";

/** 仓库根：desktop/src/main → 上三层。 */
const REPO_ROOT = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

async function withService(
  fn: (service: RunService, pushes: RunPushEvent[]) => Promise<void>,
): Promise<void> {
  const storeRoot = await mkdtemp(join(tmpdir(), "kuse-desktop-"));
  const pushes: RunPushEvent[] = [];
  const service = new RunService({
    storeRoot,
    defaultRepoRoot: REPO_ROOT,
    emit: (push) => pushes.push(push),
  });
  try {
    await fn(service, pushes);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
}

describe("RunService（离线链路冒烟）", () => {
  it("发起一次离线 Run：事件推送、终态、日志可查", { timeout: 30_000 }, async () => {
    await withService(async (service, pushes) => {
      const { info, done } = await service.startRun({
        task: "阅读仓库根的 README，给出三句话摘要（离线冒烟）",
        mode: "offline",
      });
      expect(info.runId).toMatch(/^run_/);
      expect(info.sessionId).toMatch(/^sess_/);

      const finished: RunFinishedInfo = await done;
      // 终态从日志折叠出来；离线剧本正常收场是 completed。
      expect(finished.trace.stop.kind).toBe("completed");
      expect(finished.offline).toBe(true);
      expect(finished.modelName).toBe("faux/offline-script");

      // 推送里既有逐事件，也有终态。
      const eventKinds = pushes.filter((p) => p.kind === "event");
      expect(eventKinds.length).toBeGreaterThan(0);
      const donePush = pushes.find((p) => p.kind === "done");
      expect(donePush).toBeDefined();

      // traceOf 从日志再读一遍，结论一致（日志是真相，不是事件流的缓存）。
      const reread = await service.traceOf(info.runId);
      expect(reread.trace.stop.kind).toBe("completed");
    });
  });

  it("空任务与不存在的仓库会被拒绝", async () => {
    await withService(async (service) => {
      await expect(service.startRun({ task: "   ", mode: "offline" })).rejects.toThrow(
        /任务文本不能为空/,
      );
      await expect(
        service.startRun({ task: "随便", mode: "offline", repoRoot: "Z:/no/such/dir" }),
      ).rejects.toThrow(/仓库目录不存在/);
    });
  });

  it("取消一个不存在的 Run 返回 false", async () => {
    await withService(async (service) => {
      expect(service.cancel("run_none").cancelled).toBe(false);
    });
  });

  it("env 模式没有凭据时给出明确指引", async () => {
    await withService(async (service) => {
      const prev = process.env["KUSECODE_MODEL"];
      delete process.env["KUSECODE_MODEL"];
      try {
        await expect(
          service.startRun({ task: "任意", mode: "env" }),
        ).rejects.toThrow(/KUSECODE_MODEL/);
      } finally {
        if (prev !== undefined) process.env["KUSECODE_MODEL"] = prev;
      }
    });
  });
});
