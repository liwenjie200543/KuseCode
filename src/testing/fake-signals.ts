/**
 * 假信号源 —— 「取消」与「墙钟」在测试里必须是可复现的。
 *
 * 真实的取消来自外部（人按了停），真实的墙钟来自进程里的定时器。两者在测试里都不能
 * 依赖真实时间：一个太慢，一个不确定，而「预算真的按 `timeoutMs` 设了计时器」这件事
 * 又必须能被断言。所以这里给出它们的手动替身，外加「真实适配器在中止时怎么表现」的
 * 那一小段行为——它是「在途调用被信号打断」这句话的另一半证据（另一半是 Runtime
 * 自己的执法，在 `src/runtime/budget.ts`）。
 *
 * 这里没有任何 Node 内置模块，也没有 SDK——它和 Core 一样纯。
 */

import type { TimeoutSignalFactory } from "../runtime/termination.js";

/** 手动墙钟：可以被测试点名、也可以被点名几次。 */
export interface ManualTimeouts {
  /** 交给 Runtime 的墙钟工厂。 */
  readonly timeouts: TimeoutSignalFactory;
  /** 被要求的超时（毫秒，按顺序）。它证明 Runtime 真的按预算设了计时器。 */
  readonly requested: readonly number[];
  /** 让第 `index` 个（默认最后一个）计时器到点。 */
  fire(index?: number): void;
}

export function manualTimeouts(): ManualTimeouts {
  const requested: number[] = [];
  const controllers: AbortController[] = [];

  return {
    requested,
    timeouts: (ms: number): AbortSignal => {
      requested.push(ms);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    },
    fire: (index?: number): void => {
      const at = index ?? controllers.length - 1;
      const controller = controllers[at];
      if (controller === undefined) throw new Error(`没有第 ${at} 个计时器可以点响`);
      controller.abort();
    },
  };
}

/**
 * 一次「在途」的调用：信号一响，就用信号自己的 reason 拒绝。
 *
 * 这就是真实适配器在中止时必须表现出的行为（步 8 会在适配器里兑现它）。
 * 写成一个小工具，是为了让「取消能打断在途调用」这件事在测试里只被兑现一次。
 *
 * 先看 `aborted` 再看监听器不是洁癖：信号如果在注册之前就响了，监听器永远不会被调用，
 * 而一个永远不落地的 promise 会让测试挂住——那时断言不会失败，它只是不返回。
 */
export function inFlight<T>(signal: AbortSignal): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
