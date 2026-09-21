/**
 * 证据核对 —— 「每条论断都指向证据」这句话的可执行形式。
 *
 * README 把这个项目的真实任务写成了一句话：Agent 有用的判据是**每条论断都指向
 * 证据**（一个文件路径加行号），而找不到依据时它明说缺了什么，而不是编一个结论。
 * 前半句在前面的步骤里只被**要求**过（system prompt 让模型这么做），没有被**核对**过：
 * 模型完全可以在 `evidence` 里写一个它从没读过的路径，而没有任何东西会响。
 *
 * `src/tools/repo-tools.ts` 的收尾注释把这件事挂到步 9/10，这里是它的落点。
 * 步 10 只做语料（golden transcripts），所以"模型引用的区间读过了、但 `excerpt` 里写的
 * 是那段区间里没有的话"这一档**没有被这一步覆盖**，它记在 `docs/09-cli-trace.md` 局限三。
 *
 * ## 它核对的不是"这条论断对不对"
 *
 * 判断一句话在语义上是否成立需要另一个模型，那是另一个循环。这里核对的是一件
 * 便宜得多、而且是**可以完全确定**的事：**这些行，我们真的看到过吗？**
 *
 * 两者不能混为一谈。一个模型可以引用真实存在的行却得出错误结论（那是推理问题），
 * 也可以得出正确结论却引用了没读过的行（那是**证据问题**，也就是这里管的事）。
 * 后者更危险：它让结论看起来有依据，而依据是编的——所以它必须是可见的。
 *
 * ## 材料从哪来
 *
 * 「看到过哪些路径的哪些行」只有**工具自己**说得清：`read_file` 的返回里有
 * `path` 与行窗口，`search_text` 的每条命中带一个行号，`list_dir` 只说明了路径存在。
 * 于是这个知识住在工具那里（`ToolSpec.material`），本文件只接收一个已经抽好的
 * 清单——Runtime 不需要、也不该知道任何一个工具的名字，这与步 8「schema 住在工具
 * 自己那里」是同一条理由。
 */

import type { AgentEvent, Evidence, MaterialRef, Report } from "../core/types.js";

/**
 * 从一条观测里抽出"看到了什么"。
 *
 * 它是一个接缝：位置（谁调用它、什么时候调用）属于 Runtime，**策略**
 * （`read_file` 的返回值里哪两个字段是行号）属于工具自己。
 */
export type MaterialReader = (observation: {
  readonly tool: string;
  readonly value: unknown;
}) => readonly MaterialRef[];

export interface EvidenceAudit {
  /** 核对过的证据条数（所有论断的 `evidence` 之和）。 */
  readonly total: number;
  readonly supported: number;
  /** 引用了没看过的行的证据，形如 `README.md:7-8`。按出现顺序，去重。 */
  readonly unsupported: readonly string[];
  /** 论断自己就没有给依据（`evidence` 是空数组）。它不是错误，但必须可见。 */
  readonly unbacked: readonly string[];
  /**
   * 被截断的观测条数。
   *
   * 这个数字决定这次核对**可不可信**，因为截断是**替换**（步 6 的决定 6）：
   * 超过上限时 `value` 变成一段文本预览，原来的结构就没了——于是我们**看不到
   * 那条结果里到底有哪些行**，只能保守地说"没在能读到的材料里找到"。
   *
   * 不加这个字段的后果是实测撞出来的：一次 `search_text` 结果被截断，
   * 核对器于是把一条本该成立的引用报成"没有任何一次调用看到过这几行"——
   * 一句**不成立的指控**。宁可说"这次核不了"，也不能把"我看不见"说成"你没做"。
   */
  readonly truncatedObservations: number;
  /** 每条论断都给了依据、每条依据都对得上、而且没有看不清的材料。 */
  readonly ok: boolean;
  /**
   * 这次核对的结论**是不是确定的**。
   *
   * 有截断的观测时是 `false`：`unsupported` 里的条目仍然值得看，但它们的意思从
   * "没看过"降级成"在我能读到的材料里没找到"。两种说法对应两种行动
   * （前者要改模型，后者要缩小结果），所以不能混成一个。
   */
  readonly conclusive: boolean;
}

/** 路径的规范化：`./a` 与 `a` 是同一个东西，Windows 上分隔符可能不同。 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function describe(reference: Evidence): string {
  const path = normalizePath(reference.path);
  if (reference.lines === null) return path;
  return `${path}:${reference.lines[0]}-${reference.lines[1]}`;
}

/**
 * 引用被材料支撑了吗？
 *
 * 判据是**包含**，不是重叠：读过 7-8 行而引用 1-40 行没有被支撑。
 * 用重叠会放过后者，而"我读了那两行，所以我可以说整段话"正是要防的那种夸大。
 */
function isSupported(reference: Evidence, viewed: readonly MaterialRef[]): boolean {
  const path = normalizePath(reference.path);
  return viewed.some((material) => {
    if (normalizePath(material.path) !== path) return false;
    if (reference.lines === null) return true;
    if (material.lines === null) return false;
    return material.lines[0] <= reference.lines[0] && reference.lines[1] <= material.lines[1];
  });
}

/**
 * 核对一份结论。
 *
 * `viewed` 是这次 Run 看到过的所有材料——注意它来自**观测**，不是来自结论：
 * 一个模型引用自己刚才在 `read_file` 结果里看到的行，那是正常行为；引用一个
 * 谁也没读过的路径，那是伪造依据。
 */
export function auditReport(
  report: Report,
  viewed: readonly MaterialRef[],
  truncatedObservations = 0,
): EvidenceAudit {
  let total = 0;
  let supported = 0;
  const unsupported: string[] = [];
  const unbacked: string[] = [];
  const seen = new Set<string>();

  for (const claim of report.claims) {
    if (claim.evidence.length === 0) unbacked.push(claim.text);

    for (const reference of claim.evidence) {
      total += 1;
      if (isSupported(reference, viewed)) {
        supported += 1;
        continue;
      }
      const label = describe(reference);
      if (!seen.has(label)) {
        seen.add(label);
        unsupported.push(label);
      }
    }
  }

  return {
    total,
    supported,
    unsupported,
    unbacked,
    truncatedObservations,
    ok: unsupported.length === 0 && unbacked.length === 0 && truncatedObservations === 0,
    conclusive: truncatedObservations === 0,
  };
}

/**
 * 从事件日志里核对这次 Run 交付的结论。
 *
 * 它同时做两件事，因为它们需要的是同一份输入：把所有 `observation_added` 里的
 * 观测过一遍（用工具自己的读取器抽出材料），再拿 `run_completed` 的结论去对。
 *
 * 没有交付结论时（失败、取消、挂起）返回 `null`——那时**没有东西需要核对**，
 * 而不是"核对通过了"。这两种情况的差别必须看得出来。
 */
export function auditRun(
  events: readonly AgentEvent[],
  read: MaterialReader,
): EvidenceAudit | null {
  const viewed: MaterialRef[] = [];
  let report: Report | null = null;
  let truncated = 0;

  for (const event of events) {
    if (event.type === "observation_added") {
      // 截断的观测计数要在抽取**之前**加：截断之后结构没了，抽出来的必然是空，
      // 而"抽不出来"不等于"没看到"——那是这条计数存在的全部理由。
      if (event.observation.truncated) truncated += 1;
      viewed.push(...read(event.observation));
    } else if (event.type === "run_completed") {
      report = event.result;
    }
  }

  return report === null ? null : auditReport(report, viewed, truncated);
}
