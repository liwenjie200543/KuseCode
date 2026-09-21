import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  auditRun,
  catalogFromToolbox,
  createRepoTools,
  createRuntime,
  createSessionStore,
  createToolRunner,
  materialReader,
  offlineProvider,
  piModelAdapter,
  resolveProviderModel,
  traceOf,
  jsonlRunLog,
  type AgentEvent,
  type AgentRuntime,
  type EvidenceAudit,
  type RunTrace,
  type Task,
  type Toolbox,
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
 * 接线与 CLI 的 `commandRun` 一比一：toolbox → model（两条路）→ store.startRun
 * → createRuntime → 事件流。trace 从日志读，不从事件流里攒。
 */
export class RunService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly toolboxCache = new Map<string, Toolbox>();
  private readonly repoRoots = new Map<string, string>();

  constructor(private readonly options: RunServiceOptions) {}

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

    const toolbox = this.toolboxFor(repoRoot);
    const store = createSessionStore({ rootDir: this.options.storeRoot });
    const session = await store.createSession();
    const sessionId = session.id;

    const taskObject = {
      id: `task_${sessionId}`,
      goal: taskText,
      repoRoot,
      checks: [],
    } as const;

    const started = await store.startRun(sessionId, taskObject);
    const runId = started.runId;

    // 模型两条路，接线完全一样（同 CLI 的 buildModel）。
    let model: Parameters<typeof createRuntime>[0]["model"];
    let modelName: string;
    let offline: boolean;
    if (request.mode === "offline") {
      const faux = offlineProvider(
        request.pattern === undefined ? {} : { pattern: request.pattern },
      );
      model = piModelAdapter({
        models: faux.models,
        model: faux.model,
        catalog: catalogFromToolbox(toolbox),
      });
      modelName = `faux/${faux.model.id}`;
      offline = true;
    } else {
      const spec = process.env["KUSECODE_MODEL"];
      if (spec === undefined || spec.length === 0) {
        throw new Error("没有模型。设 KUSECODE_MODEL=provider/model，或改用离线冒烟模式。");
      }
      const resolution = await resolveProviderModel(spec);
      if (!resolution.ok) throw new Error(resolution.reason);
      const resolved = resolution.resolved;
      model = piModelAdapter({
        models: resolved.models,
        model: resolved.model,
        catalog: catalogFromToolbox(toolbox),
      });
      modelName = `${resolved.provider}/${resolved.modelId}`;
      offline = false;
    }

    const runner = createToolRunner({ tools: toolbox.port, clock: () => Date.now() });
    const runtime = createRuntime({
      ...runner.toolDeps(),
      log: started.log,
      ids: started.ids,
      model,
      modelName,
    });

    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.repoRoots.set(runId, repoRoot);

    const done = this.drive(runtime, taskObject, {
      runId,
      sessionId,
      modelName,
      offline,
      signal: controller.signal,
      toolbox,
      readEvents: () => jsonlRunLog({ rootDir: this.options.storeRoot }).read(runId),
    });

    return { info: { runId, sessionId }, done };
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
    const repoRoot = this.repoRoots.get(runId) ?? this.options.defaultRepoRoot;
    const toolbox = this.toolboxFor(repoRoot);
    return { trace: traceOf(events), audit: auditRun(events, materialReader(toolbox)) };
  }

  // -------------------------------------------------------------------------

  private toolboxFor(repoRoot: string): Toolbox {
    const cached = this.toolboxCache.get(repoRoot);
    if (cached !== undefined) return cached;
    // 存储目录若在仓库里就不算材料——与 CLI 的 storeInsideRepo 同一条规矩。
    const inside = this.options.storeRoot.startsWith(repoRoot)
      ? [this.options.storeRoot]
      : [];
    const toolbox = createRepoTools({ repoRoot, ignore: inside });
    this.toolboxCache.set(repoRoot, toolbox);
    return toolbox;
  }

  private async drive(
    runtime: AgentRuntime,
    taskObject: Task,
    ctx: {
      runId: string;
      sessionId: string;
      modelName: string;
      offline: boolean;
      signal: AbortSignal;
      toolbox: Toolbox;
      readEvents: () => readonly AgentEvent[];
    },
  ): Promise<RunFinishedInfo> {
    const { runId, sessionId } = ctx;
    try {
      for await (const event of runtime.run(taskObject, ctx.signal)) {
        this.options.emit({ kind: "event", runId, event });
      }
      // trace 从日志读，不从事件流里攒（事件流可能被提前离场的消费者截短）。
      const events = ctx.readEvents();
      const trace = traceOf(events);
      const audit = auditRun(events, materialReader(ctx.toolbox));
      const result: RunFinishedInfo = {
        runId,
        sessionId,
        offline: ctx.offline,
        modelName: ctx.modelName,
        trace,
        audit,
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
    }
  }
}

export function storeRootFor(userDataDir: string): string {
  return join(userDataDir, "runs");
}
