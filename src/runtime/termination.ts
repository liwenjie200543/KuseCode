/**
 * 终止 —— 这次 Run 为什么停下来，以及那个「为什么」住在哪里。
 *
 * 取消与墙钟是两件事，但它们在代码里的形状是同一个：一条会在任意时刻响的信号。
 * 所以它们被**合成同一条**交出去——端口不需要知道这次 Run 的预算，它只需要在信号
 * 响的时候停下手里的事。
 *
 * 但合成之后必须还能分开。一条信号响了，驱动方要说得清是「人按了停」还是
 * 「我们自己的墙钟到点了」：这两件事在审计里完全不同（一个是我们自己停的，
 * 一个是外部让我们停的），对应的事件也不同（`run_cancelled` 对
 * `run_failed{budget_timeout}`）。所以合成之外，每个来源各自保留一个可识别的身份，
 * 而且**谁先响谁负责**——后响的不改口。
 *
 * 归因的判据是信号本身，不是错误的形状。端口在中止时抛什么（DOMException、
 * `AbortError`、provider 自创的异常）是 provider 的词汇，Runtime 一个都不认；
 * 它只认自己那条信号现在是不是响着、以及是谁让它响的。这条规则让「停止原因」在
 * 日志里永远是一个我们自己说得清的事实，而不是对别人异常消息的猜测。
 */

/** 谁让这次 Run 停下来的。 */
export type TerminationCause = "external" | "wall_clock";

/**
 * 墙钟的来源。
 *
 * 默认是 `AbortSignal.timeout`：Node ≥ 17.3 与所有现代浏览器都现成，不需要 polyfill，
 * 而且它的定时器是 unref 的——一个 10 分钟的墙钟不会把进程按在事件循环里不放
 * （实测：设了 3 秒的超时之后进程 3ms 就正常退出了）。
 *
 * 可注入的理由和时钟一样：真实定时器在测试里要么太慢、要么不确定，而
 * 「预算真的按 `timeoutMs` 设了计时器」这件事必须能被断言。
 */
export type TimeoutSignalFactory = (ms: number) => AbortSignal;

/** 一次 Run 的信号，连同它的归因与清理。 */
export interface RunSignal {
  /** 交给模型与工具的那条：外部取消与墙钟的合流。 */
  readonly signal: AbortSignal;
  /** 为什么停的。`null` 表示还没停；**只有在 `signal.aborted` 之后才有意义**。 */
  readonly cause: () => TerminationCause | null;
  /**
   * 摘掉挂在两个来源上的监听器。幂等。
   *
   * 它**不能**取消已经设下的墙钟定时器：`AbortSignal.timeout` 没有公开的取消接口。
   * 代价是到点会空转一次（一次监听器调用），而不是把进程拖住——这一点是实测过的，
   * 记在 docs/05 的局限里。
   */
  readonly dispose: () => void;
}

export interface RunSignalOptions {
  readonly external?: AbortSignal | undefined;
  /** 墙钟，毫秒。`null`、非正数、非有限值都表示「不设墙钟」。 */
  readonly timeoutMs?: number | null;
  readonly timeoutSignal?: TimeoutSignalFactory;
}

/**
 * 组出这次 Run 的信号。
 *
 * 三条不变量：
 *
 * 1. **总有一条。** 调用方没传信号、预算也没设墙钟时，仍然交出一条永不中止的
 *    ——「这条 Run 不会因为信号而停」是一个显式的事实，不是某个 `??` 顺手带来的副作用。
 * 2. **只有一个来源时不做包装。** 交出去的就是那条信号本身，组合是无损的。
 * 3. **先响的说了算。** 两个来源都响过时，`cause()` 报的是先响的那个；
 *    同时响时，外部取消优先——那是人的决定，比我们自己的时钟更该被报告。
 */
export function createRunSignal(options: RunSignalOptions = {}): RunSignal {
  const external = options.external ?? null;
  const timeoutMs = options.timeoutMs ?? null;
  const withWallClock = timeoutMs !== null && Number.isFinite(timeoutMs) && timeoutMs > 0;
  const createTimeout = options.timeoutSignal ?? AbortSignal.timeout;
  const timeout = withWallClock ? createTimeout(timeoutMs) : null;

  let cause: TerminationCause | null = null;
  const detachers: Array<() => void> = [];

  const watch = (source: AbortSignal, kind: TerminationCause): void => {
    const record = (): void => {
      if (cause === null) cause = kind;
    };
    if (source.aborted) {
      record();
      return;
    }
    source.addEventListener("abort", record, { once: true });
    detachers.push(() => source.removeEventListener("abort", record));
  };

  // 先挂外部：同时响时它先记上，于是它优先。
  if (external !== null) watch(external, "external");
  if (timeout !== null) watch(timeout, "wall_clock");

  let signal: AbortSignal;
  if (external !== null && timeout !== null) signal = AbortSignal.any([external, timeout]);
  else if (external !== null) signal = external;
  else if (timeout !== null) signal = timeout;
  else signal = new AbortController().signal;

  return {
    signal,
    cause: () => cause,
    dispose: () => {
      for (const detach of detachers) detach();
      detachers.length = 0;
    },
  };
}
