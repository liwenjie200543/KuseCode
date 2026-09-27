/**
 * Toolbox —— 工具系统的**唯一组装点**（SDD T11，docs/sdd/03-architecture.md §3.3）。
 *
 * 这个文件只回答一个问题：**一堆 ToolSpec 怎么变成 Runtime 与适配器需要的全部形状？**
 * 它不回答「每个工具具体干什么」——那是各个 spec 的事（`src/tools/repo-tools.ts`）。
 *
 * 在它出现之前，组装的词汇散在三处：`ToolSpec` 与裸端口住在 repo-tools、
 * 执行层包装（八道关卡）由每个消费者自己接 `createToolRunner`、materialReader
 * 是一个独立函数。T11 把三处收拢：**给一份 spec 清单，一次拿到全套**——
 * 于是"新增一个工具"的成本收敛为：写一个 spec 文件 + 在清单里加一行（FR-4.2）。
 *
 * 三条边界（与重构前一致，只是现在有了可执行的位置）：
 * 1. **Core 仍然只认识工具名字**（`ToolPort.names` 是 allowlist）：schema 与
 *    provider 形状翻译不进 Core；
 * 2. **八道关卡只在这一侧**：`Toolbox.port` 是已经包过关卡的端口，直接交给
 *    `createRuntime`；`provenance` 与 `truncated` 仍然只能由执行层写；
 * 3. **零 SDK**：本文件一行包引用都没有（T1 的禁线钉着）。
 */

import type { AssembleObservation } from "./core/loop.js";
import type { MaterialRef, ToolError, ToolIntent, ToolOutcome, ToolPort } from "./core/types.js";
import {
  collectMissingMaterial,
  createToolRunner,
} from "./runtime/tool-runner.js";
import type { TimeoutSignalFactory } from "./runtime/termination.js";

// ---------------------------------------------------------------------------
// 词汇（自 repo-tools 升格：形状不变，归属变了）
// ---------------------------------------------------------------------------

/** 一个工具参数的 JSON Schema 子集。够用就好，不是通用实现。 */
export interface JsonObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/** 参数不合法。`code` 直接用执行层的词汇，Runtime 那一层不必再翻译。 */
export class ToolArgumentError extends Error {
  readonly code = "invalid_args";

  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

/**
 * 一个抛出物 → 一条**可返回的**失败。
 *
 * `ToolArgumentError` 与别的错误的区分不是分类癖：它们对模型说的是不同的话。
 * `invalid_args` 的含义是"你给的东西没法用，换个参数再来"，而 `tool_failed` 的
 * 含义是"这次没拿到材料，换参数也一样"。判据放在**一处**，两个 catch 都走这里。
 */
export function failureOf(error: unknown): { code: "invalid_args" | "tool_failed"; message: string } {
  return {
    code: error instanceof ToolArgumentError ? "invalid_args" : "tool_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * 「哪些目录不是材料」的两条规则。
 *
 * 它们必须分开，因为"跑到哪一层都该跳过"与"只有那一个位置该跳过"是两件事：
 * - `names`：目录名，任意深度生效。`node_modules` 这种共识属于这里。
 * - `paths`：**仓库相对路径**，只在那一个位置生效。这次 Run 自己的产物属于这里。
 *   （为什么产物那条不能用名字：一个叫 `runs` 的素材目录会被静默漏掉——
 *   见 `docs/09` 的「Run 不许读到自己的产物」。）
 */
export interface IgnoreRules {
  readonly names: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
}

/** 工具干活时能看到的那一小片世界（`spec.run` 的第二参数）。 */
export interface ToolContext {
  readonly repoRoot: string;
  readonly signal: AbortSignal;
  readonly ignore: IgnoreRules;
}

/** 工具自包含的全部声明与实现（SDD T11 的公共词汇）。 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObjectSchema;
  /** 校验并收敛参数。不合法就抛 `ToolArgumentError`。 */
  readonly parse: (args: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  /** 干活。参数已经过 `parse`。返回的必须是可 JSON 表示的值。 */
  readonly run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
  /**
   * 这次结果让我们**看到了**哪些材料。省略它的工具 = 它的结果不构成可引用的材料。
   * 证据核对（`src/runtime/verify.ts`）靠它把"看到过什么"抽出来——核对器因此
   * 不需要认识任何工具的名字。
   */
  readonly material?: (value: unknown) => readonly MaterialRef[];
}

/** 声明的 schema 里出现了校验函数不认识的键——用一次测试钉住，不靠人眼。 */
export function declaredKeysOf(spec: ToolSpec): readonly string[] {
  return Object.keys(spec.parameters.properties);
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface ToolboxOptions {
  /** 仓库根目录。路径围栏与工具 I/O 的基准点（内部会 `resolve` 一次）。 */
  readonly repoRoot: string;
  /** `provenance.at` 的来源。真实时间是 `Date.now`；测试与 golden 用确定性时钟。 */
  readonly clock: () => number;
  /** 单次调用超时的来源。默认 `AbortSignal.timeout`。 */
  readonly timeoutSignal?: TimeoutSignalFactory;
  /**
   * 还要跳过哪些目录，写成**仓库相对路径**（`runs`、`out/runs`）。
   * 由调用方给，因为"这次 Run 的产物在哪"只有发起它的那一层知道。
   * 注意它只作用于**发现**（list_dir / search_text 的语义是 spec 自己的）。
   */
  readonly ignorePaths?: readonly string[];
  /** 按名字跳过的目录。缺省用 `DEFAULT_IGNORED_DIRECTORY_NAMES`。 */
  readonly ignoreNames?: readonly string[];
}

/**
 * 「哪些目录不是材料」的行业共识。它住在组装点而不是某个 spec 里：
 * 这是"这一次装配不把哪些目录当材料"的政策，不是任何一个工具的实现细节。
 */
export const DEFAULT_IGNORED_DIRECTORY_NAMES: readonly string[] = Object.freeze([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".workbuddy",
]);

/**
 * 组装后的全套形状。**一次调用，五样东西**：
 * 给 Runtime 的三个（`port` / `assembleObservation` / `collectMissingMaterial`，
 * 正好是 `createToolRunner` 定义的 ToolLayerDeps 三件套——配对是结构性的，
 * 不靠记性）、给适配器的 spec 清单、给核对器的 materialReader。
 */
export interface Toolbox {
  /** allowlist：模型只能从这里面选。 */
  readonly names: readonly string[];
  readonly specs: readonly ToolSpec[];
  /**
   * 裸端口：spec 分派 + schema 校验 + 取消 → `tool_failed` 观测。
   * 它是**直接消费者**的契约——SDK 自驱循环的桥（`adapter/pi/tools.ts`）用这一层：
   * 那条路径上没有 Runtime 的"停止归因"，中止只能作为一次失败的工具结果被看见。
   */
  readonly rawPort: ToolPort;
  /**
   * 已包八道关卡的端口（校验/超时/失败隔离/截断/provenance 都在它后面）。
   * 它是 **Runtime** 的契约：中止不再是一次工具失败，而是原样上抛交给驱动方归因。
   * `createRuntime` 应该用这一个。
   */
  readonly port: ToolPort;
  readonly assembleObservation: AssembleObservation;
  readonly collectMissingMaterial: typeof collectMissingMaterial;
  /** 从观测里读出"看到了哪些材料"，按工具名分派（核对器的唯一入口）。 */
  readonly materialReader: (observation: {
    readonly tool: string;
    readonly value: unknown;
  }) => readonly MaterialRef[];
}

/**
 * 把工具集组装成可运行的形状。
 *
 * 重名注册即抛错：一个工具集里两个同名工具，allowlist 与 materialReader
 * 的分派都会变成掷骰子——这个错必须在装配时响，而不是在第一次核对时。
 */
export function createToolbox(specs: readonly ToolSpec[], options: ToolboxOptions): Toolbox {
  const repoRoot = options.repoRoot;
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.name)) {
      throw new Error(`工具重复注册：${spec.name}（同一套工具集里两个同名工具，分派会掷骰子）`);
    }
    seen.add(spec.name);
  }

  const ignore: IgnoreRules = {
    names: new Set(options.ignoreNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES),
    // 统一成 POSIX 分隔符：规则是给人写的（`out/runs`），不该因为平台而变。
    paths: new Set((options.ignorePaths ?? []).map((path) => path.replace(/\\/g, "/").replace(/\/+$/, ""))),
  };
  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  /** 裸端口：spec 的分派、schema 校验、最后一刻的取消检查。 */
  const raw: ToolPort = {
    names: Object.freeze(specs.map((spec) => spec.name)),
    async execute(intent: ToolIntent, signal: AbortSignal): Promise<ToolOutcome> {
      const spec = byName.get(intent.name);
      if (spec === undefined) {
        // allowlist 的判断本来就在执行层，这里是它的第一次落地
        return { value: null, error: { code: "invalid_tool", message: `未知工具：${intent.name}` } };
      }
      // 已经中止就不再动手：文件系统调用本身不可中断，所以闸门只能放在它前面。
      if (signal.aborted) {
        return {
          value: null,
          error: { code: "tool_failed", message: "调用已被取消，工具没有执行" },
        };
      }
      let args: Record<string, unknown>;
      try {
        args = spec.parse(intent.args);
      } catch (error) {
        return { value: null, error: failureOf(error) };
      }
      try {
        const value = await spec.run(args, { repoRoot, signal, ignore });
        return { value, error: null };
      } catch (error) {
        // 文件不存在、权限、编码——都是"这次没拿到材料"，不是 Run 的失败。
        // 越界、非法正则虽然抛在同一处，判据仍是 `invalid_args`（见 `failureOf`）。
        return { value: null, error: failureOf(error) };
      }
    },
  };

  // 八道关卡在这一层包上：名字与参数的准入、单次超时、返回值形状、
  // JSON 无损、截断、provenance 写入——`Toolbox.port` 交出去时它们已经在。
  const runner = createToolRunner({ tools: raw, clock: options.clock, ...(options.timeoutSignal === undefined ? {} : { timeoutSignal: options.timeoutSignal }) });

  const materialReader = (observation: {
    readonly tool: string;
    readonly value: unknown;
  }): readonly MaterialRef[] => {
    const spec = byName.get(observation.tool);
    if (spec?.material === undefined) return [];
    return spec.material(observation.value);
  };

  return {
    names: raw.names,
    specs,
    rawPort: raw,
    port: runner.tools,
    assembleObservation: runner.assembleObservation,
    collectMissingMaterial,
    materialReader,
  };
}

/** 一个工具的失败怎么变回 `ToolError`？执行层的词汇只有一份——这里再导出一次。 */
export type { ToolError };
