import type { RunService } from "./run-service.js";
import { handle } from "./ipc.js";

/**
 * Run 通道的注册：参数校验在 RunService 里（它不依赖 electron，可单测），
 * 这里只做「契约 → 服务方法」的粘合。`run:start` 立刻返回 runId，
 * 事件与终态走 `run:push` 推送——长时间任务不占用 invoke 的请求-响应语义。
 */
export function registerRunHandlers(service: RunService): void {
  handle("run:start", async (request) => {
    const { info, done } = await service.startRun(request);
    void done.catch(() => {
      // 失败已经以 run:push(kind: "failed") 推给渲染层；这里不让未处理的
      // rejection 冒到主进程的 unhandledRejection。
    });
    return info;
  });

  handle("run:cancel", (runId) => {
    if (typeof runId !== "string" || runId.length === 0) throw new Error("runId 不能为空");
    return service.cancel(runId);
  });

  handle("run:trace", async (runId) => {
    if (typeof runId !== "string" || runId.length === 0) throw new Error("runId 不能为空");
    return service.traceOf(runId);
  });
}
