/**
 * 假模型：一个可断言、可复现的 `ModelPort`。
 *
 * 它存在的理由不是「方便写测试」，而是一条本步要证明的命题：
 * **Core 的循环可以在没有进程、网络、数据库和 UI 的情况下跑完。**
 * 只要模型的决策是给定的，循环的产物就完全由 Core 决定——
 * 于是任何不一致都只可能来自 Core，不可能来自 provider 的方差。
 *
 * 它同时是「模型到底看到了什么」的证人：每次 `decide` 都把入参加以记录，
 * 所以测试可以断言「观测确实回填进了下一轮的输入」，而不是只断言最终状态长得对。
 *
 * 这里没有任何 Node 内置模块，也没有 SDK——它和 Core 一样纯。
 */

import { UsageAccumulator } from "../core/usage.js";
import type { AgentState, Decision, ModelPort, ModelUsage } from "../core/types.js";

/** 脚本用尽：循环问了一次脚本回答不了的决策。 */
export class FakeScriptExhaustedError extends Error {
  constructor(
    readonly requestedCall: number,
    readonly scriptLength: number,
  ) {
    super(
      `fake model 的脚本只有 ${scriptLength} 条决策，第 ${requestedCall + 1} 次 decide 无答案——` +
        `循环比脚本多走了一轮`,
    );
    this.name = "FakeScriptExhaustedError";
  }
}

/** 假模型：端口本身，外加调用记录。 */
export interface FakeModel extends ModelPort {
  /** 被问了几次。它就是「循环迭代了几轮」的独立证据。 */
  readonly calls: number;
  /** 每次调用时收到的状态（按顺序）。用来证明「模型看到了什么」。 */
  readonly seenStates: readonly AgentState[];
  /** 每次调用时收到的取消信号。用来证明信号确实贯通到了端口。 */
  readonly signals: readonly AbortSignal[];
}

/**
 * 每一轮报多少账。三种取值对应三种**真实存在**的形态，别把它们混成一个：
 *
 * | 取值 | 假模型的行为 | 它对应现实里的什么 |
 * |---|---|---|
 * | `undefined`（不给） | 不实现 `beginRun` | 一个没有用量能力的模型端口 |
 * | `null` | 实现账本，但每轮都报"未知" | deepseek 路径：调用了，但没报 usage |
 * | 一个用量 / 一个函数 | 实现账本并逐轮累加 | 一个正常报数的 provider |
 *
 * 第一行与第二行的区别不是细节：`beginRun` 在端口上是可选的，而 Runtime 必须
 * 能处理"没有账本"（`usageOf(null)`）。第三行是步 8 新接进来的那条链路——
 * 没有它，"用量数字真的从端口流进了事件流"这件事就没有任何测试覆盖。
 *
 * 返回 `null` 的那一项表示"这一轮没测到"：它会记成未知，而不是零——
 * 两种写法在账目上完全不同，规则见 `src/core/usage.ts`。
 */
export type FakeUsage = ModelUsage | ((callIndex: number) => ModelUsage) | null;

function usageFor(report: FakeUsage, callIndex: number): ModelUsage {
  if (report === null) return { inputTokens: null, outputTokens: null };
  return typeof report === "function" ? report(callIndex) : report;
}

function recordingModel(
  decide: (state: AgentState, signal: AbortSignal) => Decision | Promise<Decision>,
  usage?: FakeUsage,
): FakeModel {
  const seenStates: AgentState[] = [];
  const signals: AbortSignal[] = [];
  /** 每个 Run 一个累积器，键是信号——与真适配器同一条规则、同一个实现。 */
  const ledgers = new WeakMap<AbortSignal, UsageAccumulator>();
  const report: FakeUsage = usage ?? null;

  return {
    get calls(): number {
      return seenStates.length;
    },
    get seenStates(): readonly AgentState[] {
      return seenStates;
    },
    get signals(): readonly AbortSignal[] {
      return signals;
    },
    // 不给用量时不实现 `beginRun`：端口上它是可选的，而"没有账本"是一个
    // 真实的形态（Runtime 必须能处理 `usageOf(null)`）。
    ...(usage === undefined
      ? {}
      : {
          beginRun(signal: AbortSignal): { usage: () => ModelUsage } {
            const ledger = new UsageAccumulator();
            ledgers.set(signal, ledger);
            return { usage: () => ledger.total() };
          },
        }),
    async decide(state: AgentState, signal: AbortSignal): Promise<Decision> {
      seenStates.push(state);
      signals.push(signal);
      const decision = await decide(state, signal);
      ledgers.get(signal)?.add(usageFor(report, seenStates.length - 1));
      return decision;
    },
  };
}

export interface ScriptedModelOptions {
  /**
   * 脚本用尽后重复最后一条决策。
   *
   * 默认 `false`：用尽就报错。因为「循环多问了一轮」在多数测试里是要被抓住的
   * bug，而不是要被容忍的行为——报错让越界立刻可见。
   * 需要无限重复的场景（例如步 5 的预算与取消）显式打开它。
   */
  readonly repeatLast?: boolean;
  /** 每一轮报多少账。省略 = 这个假模型没有账本（不实现 `beginRun`）。 */
  readonly usage?: FakeUsage;
}

/**
 * 脚本化的决策队列：按顺序回答，问完为止。
 *
 * 队列是**有界**的，这与「Core 里没有 maxIterations」并不矛盾：
 * 上限来自脚本，不来自循环。循环多问一次，`FakeScriptExhaustedError` 就会响。
 */
export function scriptedModel(
  script: readonly Decision[],
  options: ScriptedModelOptions = {},
): FakeModel {
  const repeatLast = options.repeatLast === true;
  let index = 0;

  return recordingModel(() => {
    const decision = script[index];
    if (decision !== undefined) {
      index += 1;
      return decision;
    }

    const last = script[script.length - 1];
    if (repeatLast && last !== undefined) return last;

    throw new FakeScriptExhaustedError(index, script.length);
  }, options.usage);
}

/**
 * 函数式决策：看得见状态，才决定下一步。
 *
 * 这是比队列更强的证明——队列只能证明「循环按顺序吃了 N 条」，
 * 而函数式决策可以让第二次决策**依赖第一次的观测**：
 * 观测没回填进状态，第二次决策就变了，测试立刻失败。
 */
export function decidingModel(
  decide: (state: AgentState, signal: AbortSignal) => Decision | Promise<Decision>,
  options: ScriptedModelOptions = {},
): FakeModel {
  return recordingModel(decide, options.usage);
}
