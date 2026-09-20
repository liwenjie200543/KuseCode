/**
 * 假工具 + 观测组装替身。
 *
 * 两个东西放在一起，是因为它们回答的是同一个问题的两半：
 * **工具能说什么**（`ToolOutcome`）与**谁把它的说法变成状态里的观测**（组装）。
 * 在真实系统里这两半分属不同的层（工具体 vs 步 6 的 tool-runner），
 * 在这里它们都是假的，但**接缝的位置必须一样**——否则本步的假通道就证明不了
 * 步 6 的边界。
 *
 * 这个 fake 刻意**不做**三件真实系统必须做的事，它们都属于步 6：
 * 参数形状校验、单次调用超时、结果截断。它只做一件事：把 `ToolOutcome`
 * 组装成 `Observation`，并补上工具自己填不了的那两个字段。
 *
 * 这里没有任何 Node 内置模块，也没有 SDK——它和 Core 一样纯。
 */

import type { AssembleObservation } from "../core/loop.js";
import type { Observation, ToolIntent, ToolOutcome, ToolPort } from "../core/types.js";

/** 一个假工具：固定答复，或按意图现算。 */
export type FakeToolBehavior = ToolOutcome | ((intent: ToolIntent) => ToolOutcome);

/** 假工具集：端口 + 调用记录。 */
export interface FakeTools extends ToolPort {
  /** 全部被请求的意图，含被拒绝的。 */
  readonly calls: readonly ToolIntent[];
  /** 真正跑过的意图。不在 allowlist 里的一次都不会出现在这里。 */
  readonly executed: readonly ToolIntent[];
  /** 每次执行时收到的取消信号。用来证明信号确实贯通到了工具端口。 */
  readonly signals: readonly AbortSignal[];
}

/**
 * 按名字注册一批假工具。`Object.keys` 就是 `names`（allowlist）。
 *
 * 名字不在表里 → 返回 `invalid_tool` 错误，**且不执行**。这一步刻意放在端口这一侧：
 * 「未知工具被拒绝」是执行层的执法（步 6 的 tool-runner 同样在这里执法），
 * Core 只负责把结果记成观测。Core 没有任何 allowlist 判断，也不该有。
 */
export function fakeTools(behaviors: Readonly<Record<string, FakeToolBehavior>>): FakeTools {
  const names = Object.keys(behaviors);
  const calls: ToolIntent[] = [];
  const executed: ToolIntent[] = [];
  const signals: AbortSignal[] = [];

  return {
    names,
    get calls(): readonly ToolIntent[] {
      return calls;
    },
    get executed(): readonly ToolIntent[] {
      return executed;
    },
    get signals(): readonly AbortSignal[] {
      return signals;
    },
    async execute(intent: ToolIntent, signal: AbortSignal): Promise<ToolOutcome> {
      calls.push(intent);

      const behavior = behaviors[intent.name];
      if (behavior === undefined) {
        return {
          value: null,
          error: {
            code: "invalid_tool",
            message: `没有名为 ${intent.name} 的工具（allowlist：${names.join(", ")}）`,
          },
        };
      }

      executed.push(intent);
      signals.push(signal);
      return typeof behavior === "function" ? behavior(intent) : behavior;
    },
  };
}

/**
 * 确定性时钟。
 *
 * 观测要带 `provenance.at`，而时间必须是**可复现**的：用 `Date.now()`，
 * 同一段脚本跑两次得到的就不是同一个状态，「回放幂等」（步 7）也就无从断言。
 * 真实时钟在 Runtime 那一侧；Core 与测试永远用这个。
 */
export function fakeClock(start = 1_700_000_000_000, step = 1): () => number {
  let current = start - step;
  return () => {
    current += step;
    return current;
  };
}

export interface FakeObservationAssemblerOptions {
  /** 时间来源。默认是确定性时钟，绝不读真实时间。 */
  readonly now?: () => number;
}

/**
 * 步 6 的 tool-runner 在本步的替身：只组装，不校验、不超时、不截断。
 *
 * 它写下工具**写不了**的两个字段：
 * - `provenance`：这条材料从哪来（工具名）、什么时候取的（注入的时钟）；
 * - `truncated`：这里恒为 `false`，因为截断是步 6 的语义，本步不做也假装不了。
 */
export function fakeObservationAssembler(
  options: FakeObservationAssemblerOptions = {},
): AssembleObservation {
  const now = options.now ?? fakeClock();

  return (intent: ToolIntent, outcome: ToolOutcome): Observation => ({
    tool: intent.name,
    value: outcome.value,
    error: outcome.error,
    truncated: false,
    provenance: { source: intent.name, at: now() },
  });
}
