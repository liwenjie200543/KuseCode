/**
 * 用量账目的算术。
 *
 * `ModelUsage` 是 Core 的类型（`types.ts`），所以**它的运算法则也属于 Core**。
 * 这个文件放在这里而不是放在适配器里，是因为它有一条必须只有一份的规则，
 * 而这条规则在适配器里写一次、在假模型里再写一次时，就出过一次错（见下）。
 *
 * ## 唯一的规则：`null` 不是零，也不是加法单位元
 *
 * `null` 的含义是**"这一次 provider 没告诉我们"**（deepseek 路径的已知缺口）。
 * 于是 `null + 120` **不能**是 `120`：
 *
 * | 写法 | 读起来是 | 对不对 |
 * |---|---|---|
 * | `null + 120 = 120` | "总共花了 120" | ✗ 这是在拿一个不完全的观测冒充总和 |
 * | `null + 120 = null` | "不知道总共花了多少" | ✓ |
 *
 * 已知数相加、只要有一项不知道就把总和记成不知道——这和"没测到不许写成没花钱"
 * 是同一条规矩的两种情形。代价是它**丢信息**（我们确实看到过 120），
 * 但丢掉的信息是"下界"，而错报出来的数字是"总额"。少一个数比多一个假数好。
 *
 * ## 因此"空账本"必须是与"零"和"未知"都不同的第三种状态
 *
 * 如果账本的初始值写成 `{ inputTokens: null, outputTokens: null }`（也就是
 * "未知"），那么第一次求和就是 `null + 120 = null`——账本**永远是未知**。
 * 这不是假设：步 8 的实现就这么写过，而它骗过了当时所有的测试，因为那些测试
 * 只看"没有报错"。空账本是 `null`（一个独立的、不回答案的取值），
 * 由持有它的一方（`model.ts` 的 `LedgerEntry`）在第一次报账时**替换**。
 * `test/pi-adapter.test.ts` 里有一组用例专门钉住这条规则。
 */

import type { ModelUsage } from "./types.js";

/** 两项都不知道的用量：还没开始记账，或 provider 一次都没报。 */
export function unknownUsage(): ModelUsage {
  return { inputTokens: null, outputTokens: null };
}

/**
 * 两份用量相加。`null` 表示"这一项未知"，未知加任何数仍是未知。
 *
 * 注意它**不是**一个幺半群意义上的"加法"：`unknownUsage()` 不是单位元。
 * 所以调用方不能拿"未知"去初始化一个累加器——要先用 `null` 表示"还没有账"。
 */
export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  const sum = (left: number | null, right: number | null): number | null =>
    left === null || right === null ? null : left + right;
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
  };
}

/**
 * 累积器：把"还没有账"（`null`）与"记过账"分开。
 *
 * 它是上面那条规则的**唯一**落地方式。把它做成一个类而不是让调用方各自处理，
 * 是因为"首次替换、之后相加"这件事只要漏一次，账本就永久失效——而失效的形态
 * 是"安静地全是 null"，没有任何异常会响。
 */
export class UsageAccumulator {
  #usage: ModelUsage | null = null;

  /** 记一轮的用量。首次调用是替换，之后是相加。 */
  add(usage: ModelUsage): void {
    this.#usage = this.#usage === null ? usage : addUsage(this.#usage, usage);
  }

  /** 到目前为止的账目。一次都没记过时是"未知"，不是零。 */
  total(): ModelUsage {
    return this.#usage ?? unknownUsage();
  }

  /** 还没有任何一轮报过账。 */
  get isEmpty(): boolean {
    return this.#usage === null;
  }
}
