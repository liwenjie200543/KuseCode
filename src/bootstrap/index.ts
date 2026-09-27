/**
 * 装配层（SDD T12，docs/sdd/03-architecture.md §3.5）。
 *
 * 这个文件只回答一个问题：**驱动一次 Run 需要的零件，从哪里来、怎么接到一起？**
 * 它不回答「零件内部怎么工作」（Runtime / toolbox / store / config 各自的事），
 * 也不回答「结果怎么呈现」（产品面的事）。
 *
 * 在它出现之前，CLI 的 `commandRun` 与桌面的 `RunService` 各自手接一遍
 * toolbox → 模型 → store → runtime 的线（`docs/11` 自己承认是"一比一复刻"）。
 * 第三个产品面出现之前，这条线必须只有一份（Spec FR-3）。
 *
 * 三条边界：
 * 1. **零 electron、零 process**：数据目录、时钟、身份都由调用方注入——
 *    它在进程内可测，与"Core 能在无进程情况下跑完"是同一条规矩的产品层版本；
 * 2. **SDK 只在 adapter 里，经这里动态加载**：`trace / sessions / audit` 三个
 *    只读门面不触发加载（重看一次 Run 不该等 provider 目录建起来）；
 * 3. **对外词汇是 Core/Runtime 的词汇**：事件流、trace、audit——不暴露可变的
 *    内部状态（tinycode 的 `Harness.runtime.agent.state` 那种形状与事件溯源冲突）。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AgentEvent, ModelPort, ResumeInput, Task } from "../core/types.js";
import { ResumeError, createRuntime } from "../runtime/run-agent.js";
import { traceOf } from "../runtime/trace.js";
import type { RunTrace } from "../runtime/trace.js";
import { auditRun } from "../runtime/verify.js";
import type { EvidenceAudit } from "../runtime/verify.js";
import type { IdFactory } from "../runtime/ids.js";
import type { RunLog } from "../runtime/run-log.js";
import type { SessionStore } from "../store/session-store.js";
import { createSessionStore } from "../store/session-store.js";
import { jsonlRunLog } from "../store/run-log-jsonl.js";
import { createRepoToolSpecs } from "../tools/repo-tools.js";
import type { Toolbox } from "../toolbox.js";
import { createToolbox } from "../toolbox.js";
import type { KuseConfig } from "../config/schema.js";

/** 适配器的形状（动态 import 的结果）。SDK 的类型只在 bootstrap 出现一次。 */
type AdapterModule = typeof import("../adapter/pi/index.js");

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

export interface KuseOptions {
  /** 被分析的仓库根目录。工具围栏与 ignore 计算的基准。 */
  readonly repoRoot: string;
  /** 已合并的配置（`config/loader.ts` 的产物）。 */
  readonly config: KuseConfig;
  /** runs/sessions 数据根（`config.dataRoot ?? <repoRoot>/runs` 由调用方解析好）。 */
  readonly dataRoot: string;
  /** 测试注入；缺省 = 真实时间与 crypto id。 */
  readonly clock?: () => number;
  readonly ids?: IdFactory;
}

export interface StartRunInput {
  /** 任务文本（非空）。 */
  readonly goal: string;
  /** 必须覆盖的检查维度。缺省空数组。 */
  readonly checks?: readonly string[];
  /** `"offline"` = faux 离线剧本；`{ spec }` = provider/model（或 `"faux"`）。 */
  readonly model: "offline" | { readonly spec: string };
  /** 离线模式的剧本名。缺省用 offlineProvider 的默认剧本。 */
  readonly pattern?: string;
  /** 继续往一个**已存在**的会话里追加 Run；缺省新建会话。 */
  readonly sessionId?: string;
}

export interface RunFinished {
  readonly trace: RunTrace;
  readonly audit: EvidenceAudit | null;
}

/** 一次 Run 的句柄：消费事件流；结束时从**日志**读 trace/audit（trace 从日志读）。 */
export interface RunHandle {
  readonly sessionId: string;
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly finished: Promise<RunFinished>;
}

export interface Kuse {
  readonly config: KuseConfig;
  startRun(input: StartRunInput, signal?: AbortSignal): Promise<RunHandle>;
  /** 挂起-应答-恢复（Spec FR-2.5）。校验失败以 `ResumeError` 类型化拒绝。 */
  answer(sessionId: string, runId: string, answer: string, signal?: AbortSignal): Promise<RunHandle>;
  /** 重看一次 Run 停在哪儿、干了什么、花了多少。零 SDK 加载。 */
  trace(sessionId: string, runId: string): Promise<RunTrace>;
  /** 证据核对。Run 没有交付结论时是 `null`。零 SDK 加载。 */
  audit(sessionId: string, runId: string): Promise<EvidenceAudit | null>;
  /** 这个数据目录里已有的会话 id，按字典序。零 SDK 加载。 */
  sessions(): Promise<readonly string[]>;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/**
 * 存储目录落在被分析仓库里面时的**仓库相对路径**；不在里面就是 `null`。
 *
 * 这件事必须算出来，因为默认配置就会撞上：事件日志里写着任务文本，一次
 * `search_text` 会命中**这次 Run 自己的日志**——Run 把自己的输出当成了输入
 * （`docs/09` 实测撞到过）。交给工具集的是**路径**而不是目录名：用名字去跳过
 * 会让一个真正叫 `runs` 的素材目录被静默漏掉。
 */
export function storeInsideRepo(repo: string, store: string): string | null {
  const path = relative(repo, store);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) return null;
  return path.split(sep).join("/");
}

export function createKuse(options: KuseOptions): Kuse {
  const store: SessionStore = createSessionStore({
    rootDir: options.dataRoot,
    ...(options.ids === undefined ? {} : { ids: options.ids }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  /** 只读门面用的日志读取器（每次 read 都看盘上最新——重看必须看到恢复后的全量）。 */
  const readLog: RunLog = jsonlRunLog({ rootDir: options.dataRoot });
  const toolboxes = new Map<string, Toolbox>();
  let adapterModule: AdapterModule | null = null;

  const repoRoot = (): string => resolve(options.repoRoot);

  const ignorePaths = (): readonly string[] => {
    const inside = storeInsideRepo(repoRoot(), resolve(options.dataRoot));
    return inside === null ? [] : [inside];
  };

  function toolboxFor(root: string): Toolbox {
    const key = resolve(root);
    let box = toolboxes.get(key);
    if (box === undefined) {
      box = createToolbox(createRepoToolSpecs(), {
        repoRoot: key,
        clock: options.clock ?? ((): number => Date.now()),
        ignorePaths: ignorePaths(),
      });
      toolboxes.set(key, box);
    }
    return box;
  }

  /** SDK 只在这里被拉进来，而且只在真正要跑模型的时候。 */
  async function adapter(): Promise<AdapterModule> {
    if (adapterModule === null) {
      adapterModule = await import("../adapter/pi/index.js");
    }
    return adapterModule;
  }

  interface BuiltModel {
    readonly model: ModelPort;
    readonly modelName: string;
    /** 离线冒烟模式。产品面会明确印出来，因为它不产生"模型的结论"。 */
    readonly offline: boolean;
  }

  /** 模型两路：离线（faux）与真实 provider。投影策略在这里进入适配器。 */
  async function buildModel(spec: string, pattern: string, toolbox: Toolbox): Promise<BuiltModel> {
    const mod = await adapter();
    const catalog = mod.catalogFromToolbox(toolbox);

    if (spec === "faux") {
      const offline = mod.offlineProvider({ pattern });
      return {
        model: mod.piModelAdapter({
          models: offline.models,
          model: offline.model,
          catalog,
          projection: options.config.projection,
        }),
        modelName: `faux/${offline.model.id}`,
        offline: true,
      };
    }

    const resolution = await mod.resolveProviderModel(spec);
    if (!resolution.ok) {
      throw new Error(resolution.reason);
    }
    const { models, model, provider, modelId } = resolution.resolved;
    return {
      model: mod.piModelAdapter({
        models,
        model,
        catalog,
        projection: options.config.projection,
      }),
      modelName: `${provider}/${modelId}`,
      offline: false,
    };
  }

  /** 从日志读"这一次花了多少、证据核对结论"（终态后随时可读，消费者离场也不丢）。 */
  function readFinished(task: Task, runId: string): RunFinished {
    const events = readLog.read(runId);
    return {
      trace: traceOf(events),
      audit: auditRun(events, toolboxFor(task.repoRoot).materialReader),
    };
  }

  function handleFrom(
    sessionId: string,
    runId: string,
    task: Task,
    stream: AsyncIterable<AgentEvent>,
  ): RunHandle {
    let settle: ((value: RunFinished) => void) | null = null;
    const finished = new Promise<RunFinished>((resolvePromise) => {
      settle = resolvePromise;
    });

    async function* tracked(): AsyncGenerator<AgentEvent, void, void> {
      try {
        for await (const event of stream) yield event;
      } finally {
        // 消费者提前 break 也会走到这里（generator 被 return）。
        // trace 从**日志**读，不从事件流攒——事件流可能被截短，日志不会。
        settle?.(readFinished(task, runId));
      }
    }

    return { sessionId, runId, events: tracked(), finished };
  }

  return {
    config: options.config,

    async startRun(input: StartRunInput, signal?: AbortSignal): Promise<RunHandle> {
      if (input.goal.trim().length === 0) {
        throw new Error("任务文本为空：一次没有任务的 Run 没有意义");
      }

      // 会话先查后建：往一个不存在的会话里塞 Run 是调用方的错误（store 同款立场）。
      const sessionId =
        input.sessionId ?? (await store.createSession()).id;
      if ((await store.getSession(sessionId)) === null) {
        throw new Error(`会话 ${sessionId} 不存在（在 ${options.dataRoot} 里找不到）`);
      }

      const toolbox = toolboxFor(repoRoot());
      const spec = input.model === "offline" ? "faux" : input.model.spec;
      const built = await buildModel(spec, input.pattern ?? "TODO", toolbox);

      const task: Task = {
        id: `task_${sessionId}`,
        goal: input.goal,
        repoRoot: repoRoot(),
        checks: input.checks ?? [],
      };
      const started = await store.startRun(sessionId, task);

      const runtime = createRuntime({
        tools: toolbox.port,
        assembleObservation: toolbox.assembleObservation,
        collectMissingMaterial: toolbox.collectMissingMaterial,
        log: started.log,
        ids: started.ids,
        model: built.model,
        modelName: built.modelName,
        budget: options.config.budget,
      });

      return handleFrom(sessionId, started.runId, task, runtime.run(task, signal));
    },

    async answer(
      sessionId: string,
      runId: string,
      answer: string,
      signal?: AbortSignal,
    ): Promise<RunHandle> {
      const recovered = await store.recover(sessionId, runId);
      if (recovered === null) {
        throw new ResumeError("run_not_found", `会话 ${sessionId} 里没有 Run ${runId}`);
      }

      const toolbox = toolboxFor(recovered.task.repoRoot);
      // 恢复必须用**同一条模型路径**：离线语义由恢复段的剧本名延续不了
      // （剧本是一次性的），所以恢复段的模型用配置解析——测试用假模型注入。
      const spec = options.config.model ?? "faux";
      const built = await buildModel(spec === "faux" ? "faux" : spec, "TODO", toolbox);

      const runtime = createRuntime({
        tools: toolbox.port,
        assembleObservation: toolbox.assembleObservation,
        collectMissingMaterial: toolbox.collectMissingMaterial,
        log: readLog,
        model: built.model,
        modelName: built.modelName,
        budget: options.config.budget,
      });

      const resumeFn = runtime.resume;
      if (resumeFn === undefined) {
        throw new Error("这个 Runtime 没有实现 resume：无法恢复挂起的 Run");
      }
      const input: ResumeInput = {
        runId: recovered.runId,
        task: recovered.task,
        events: recovered.events,
        answer,
      };
      return handleFrom(sessionId, recovered.runId, recovered.task, resumeFn(input, signal));
    },

    async trace(sessionId: string, runId: string): Promise<RunTrace> {
      const recovered = await store.recover(sessionId, runId);
      if (recovered === null) {
        throw new Error(`会话 ${sessionId} 里没有 Run ${runId}`);
      }
      return traceOf(recovered.events);
    },

    async audit(sessionId: string, runId: string): Promise<EvidenceAudit | null> {
      const recovered = await store.recover(sessionId, runId);
      if (recovered === null) {
        throw new Error(`会话 ${sessionId} 里没有 Run ${runId}`);
      }
      return auditRun(recovered.events, toolboxFor(recovered.task.repoRoot).materialReader);
    },

    async sessions(): Promise<readonly string[]> {
      return store.listSessions();
    },
  };
}
