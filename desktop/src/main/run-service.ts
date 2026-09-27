import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  createKuse,
  jsonlRunLog,
  traceOf,
  defaultConfig,
  type AgentEvent,
  type EvidenceAudit,
  type Kuse,
  type RunHandle,
  type RunTrace,
} from "../../../src/index";

// ---------------------------------------------------------------------------
// 契约形状：与渲染层共享（类型-only，编译后擦除）
// ---------------------------------------------------------------------------

export interface RunStartRequest {
  /** 任务文本（非空）。 */
  readonly task: string;
  /** `offline` = faux 离线冒烟；`env` = 从环境解析真实 provider/model（KUSECODE_MODEL）。 */
  readonly mode: "offline" | "env";
  /** 离线模式的剧本名。缺省用 offlineProvider 的默认剧本。 */
  readonly pattern?: string;
  /** 仓库根目录。缺省用产品默认仓库（KuseCode 自身）。 */
  readonly repoRoot?: string;
}

export interface RunStartedInfo {
  readonly runId: string;
  readonly sessionId: string;
}

export interface RunFinishedInfo {
  readonly runId: string;
  readonly sessionId: string;
  readonly offline: boolean;
  readonly modelName: string;
  readonly trace: RunTrace;
  readonly audit: EvidenceAudit | null;
}

/** 主进程 → 渲染层的推送。一种通道，三种载荷，靠 `kind` 区分。 */
export type RunPushEvent =
  | { readonly kind: "event"; readonly runId: string; readonly event: AgentEvent }
  | { readonly kind: "done"; readonly result: RunFinishedInfo }
  | { readonly kind: "failed"; readonly runId: string; readonly code: string; readonly message: string };

export interface RunServiceOptions {
  /** 事件日志根目录（生产里是 userData/runs）。 */
  readonly storeRoot: string;
  /** 默认仓库：UI 不填仓库时用它。 */
  readonly defaultRepoRoot: string;
  /** 每个推送事件都从这里出去（主进程把它接到 webContents.send）。 */
  readonly emit: (push: RunPushEvent) => void;
}

// ---------------------------------------------------------------------------
// RunService
// ---------------------------------------------------------------------------

/**
 * Runtime 的宿主。它不 import electron——这样根 vitest 可以把它当普通 TS 测，
 * 而「事件怎么送到窗口」只是构造时注入的一个回调。
 *
 * SDD T15：接线全部来自**共享装配层**（`createKuse`）——本类只剩三件产品的事：
 * 校验请求形状、把事件流推给窗口、维护取消用的 AbortController。
 * trace 从日志读，不从事件流里攒。
 */
export class RunService {
  private readonly controllers = new Map<string, AbortController>();
  /** 每个进行中/已完成 Run 的产品上下文（traceOf 的 audit 需要 repoRoot）。 */
  private readonly runs = new Map<string, { readonly sessionId: string; readonly repoRoot: string; readonly offline: boolean }>();
  private readonly kuse: Kuse;

  constructor(private readonly options: RunServiceOptions) {
    this.kuse = createKuse({
      repoRoot: options.defaultRepoRoot,
      config: defaultConfig(),
      dataRoot: options.storeRoot,
    });
  }

  /** 发起一次 Run。日志登记完成即返回；事件经 `emit` 推送，终态在 `done` 里。 */
  async startRun(
    request: RunStartRequest,
  ): Promise<{ info: RunStartedInfo; done: Promise<RunFinishedInfo> }> {
    const taskText = request.task.trim();
    if (taskText.length === 0) throw new Error("任务文本不能为空");

    const repoRoot = resolve(request.repoRoot ?? this.options.defaultRepoRoot);
    const repoStat = await stat(repoRoot).catch(() => null);
    if (repoStat === null || !repoStat.isDirectory()) {
      throw new Error(`仓库目录不存在：${repoRoot}`);
    }

    let model: "offline" | { readonly spec: string };
    if (request.mode === "offline") {
      model = "offline";
    } else {
      const spec = process.env["KUSECODE_MODEL"];
      if (spec === undefined || spec.length === 0) {
        throw new Error("没有模型。设 KUSECODE_MODEL=provider/model，或改用离线冒烟模式。");
      }
      model = { spec };
    }

    const controller = new AbortController();
    const handle = await this.kuse.startRun(
      {
        goal: taskText,
        model,
        ...(request.pattern === undefined ? {} : { pattern: request.pattern }),
      },
      controller.signal,
    );
    const runId = handle.runId;
    this.controllers.set(runId, controller);
    this.runs.set(runId, {
      sessionId: handle.sessionId,
      repoRoot,
      offline: request.mode === "offline",
    });

    const done = this.drive(handle, runId);
    return { info: { runId, sessionId: handle.sessionId }, done };
  }

  /** 取消一次进行中的 Run。Run 已经终态时返回 false。 */
  cancel(runId: string): { cancelled: boolean } {
    const controller = this.controllers.get(runId);
    if (controller === undefined) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  /** 一次 Run 的 trace 与证据核对，从日志读（日志是全部真相）。 */
  async traceOf(runId: string): Promise<{ trace: RunTrace; audit: EvidenceAudit | null }> {
    const events = jsonlRunLog({ rootDir: this.options.storeRoot }).read(runId);
    const ctx = this.runs.get(runId);
    // audit 需要仓库上下文（工具的 materialReader）；上下文丢失时诚实地说"没做"。
    const audit =
      ctx === undefined ? null : await this.kuse.audit(ctx.sessionId, runId);
    return { trace: traceOf(events), audit };
  }

  // -------------------------------------------------------------------------

  private async drive(handle: RunHandle, runId: string): Promise<RunFinishedInfo> {
    const ctx = this.runs.get(runId);
    try {
      for await (const event of handle.events) {
        this.options.emit({ kind: "event", runId, event });
      }
      // trace 从日志读，不从事件流里攒（事件流可能被提前离场的消费者截短）。
      // finished 由装配层在事件流结束时从日志结算——这里只做转发。
      const finished = await handle.finished;
      const result: RunFinishedInfo = {
        runId,
        sessionId: handle.sessionId,
        offline: ctx?.offline ?? false,
        modelName: finished.trace.model ?? "unknown",
        trace: finished.trace,
        audit: finished.audit,
      };
      this.options.emit({ kind: "done", result });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown } | null)?.code;
      this.options.emit({
        kind: "failed",
        runId,
        code: typeof code === "string" ? code : "runtime_error",
        message,
      });
      throw error;
    } finally {
      this.controllers.delete(runId);
      this.runs.delete(runId);
    }
  }
}

export function storeRootFor(userDataDir: string): string {
  return join(userDataDir, "runs");
}
