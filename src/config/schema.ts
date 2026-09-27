/**
 * KuseCode 配置的**词汇**（SDD T3，docs/sdd/03-architecture.md §3.4）。
 *
 * 这个文件只声明形状与默认值，不做解析——解析在 `loader.ts`。
 * 两条规矩：
 *
 * 1. **配置是驱动方的关注点**（与预算同理），它永远到不了 Core：
 *    Core 的投影函数只认 `ProjectionPolicy` 参数，不认 `KuseConfig`。
 * 2. **观测截断 8000 不在配置里**，这是刻意的：`docs/06` 的既有决定——
 *    没有证据表明它需要按调用方变化，而多一个旋钮就多一种
 *    「同一个任务在不同配置下产出了不同的证据」的可能。
 */

import type { ProjectionPolicy } from "../core/project.js";
import type { RunBudget } from "../core/types.js";

/** 驱动方交给装配层的全部配置。**全量、已校验**——字段不允许缺省。 */
export interface KuseConfig {
  /**
   * 模型：`"provider/model"`，或 `"faux"`（离线剧本）。
   * `null` = 未指定，由装配层按环境解析（解析失败是装配层的事）。
   */
  readonly model: string | null;
  /** 一次 Run 的预算。语义与执法见 `src/runtime/budget.ts`，这里只承载默认。 */
  readonly budget: RunBudget;
  /** 请求级对话投影的策略参数（Core 词汇，见 `src/core/project.ts`）。 */
  readonly projection: ProjectionPolicy;
  /**
   * runs/sessions 数据根。`null` = 默认 `<repoRoot>/runs`。
   * 显式给出时通常是为了把产物挪出被分析的仓库（自指问题，见 `docs/09`）。
   */
  readonly dataRoot: string | null;
}

/** 配置文件的局部形状：逐键可选；对象逐字段合并（见 `mergeConfig`）。 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
