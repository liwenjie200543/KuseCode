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

import type { AgentState, Decision, ModelPort } from "../core/types.js";

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

function recordingModel(
  decide: (state: AgentState, signal: AbortSignal) => Decision | Promise<Decision>,
): FakeModel {
  const seenStates: AgentState[] = [];
  const signals: AbortSignal[] = [];

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
    async decide(state: AgentState, signal: AbortSignal): Promise<Decision> {
      seenStates.push(state);
      signals.push(signal);
      return decide(state, signal);
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
  });
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
): FakeModel {
  return recordingModel(decide);
}
