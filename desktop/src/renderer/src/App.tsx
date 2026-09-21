import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { eventLabel } from "./event-label";
import type { AgentEvent } from "../../../../src/index";
import type { RunFinishedInfo } from "../../main/run-service";

/** preload 注入的 API（contextBridge）。渲染层不碰任何 Node 词汇。 */
declare global {
  interface Window {
    desktop: {
      invoke<K extends keyof import("../../shared/ipc-contract").IpcChannelMap>(
        channel: K,
        ...args: import("../../shared/ipc-contract").IpcChannelMap[K]["args"]
      ): Promise<
        | { success: true; data: import("../../shared/ipc-contract").IpcChannelMap[K]["return"] }
        | { success: false; error: string }
      >;
      on<K extends keyof import("../../shared/ipc-contract").IpcEventMap>(
        channel: K,
        callback: (payload: import("../../shared/ipc-contract").IpcEventMap[K]) => void,
      ): () => void;
    };
  }
}

type Phase = "idle" | "running";

const TONE_CLASS: Record<string, string> = {
  info: "tone-info",
  tool: "tone-tool",
  ok: "tone-ok",
  warn: "tone-warn",
  error: "tone-error",
  human: "tone-human",
};

export function App(): ReactElement {
  const [phase, setPhase] = useState<Phase>("idle");
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<"offline" | "env">("offline");
  const [repoRoot, setRepoRoot] = useState("");
  const [events, setEvents] = useState<readonly AgentEvent[]>([]);
  const [runInfo, setRunInfo] = useState<{ runId: string; sessionId: string } | null>(null);
  const [finished, setFinished] = useState<RunFinishedInfo | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  // 推送订阅：挂载一次，卸载时清理（StrictMode 的双调用靠它不漏监听）。
  useEffect(() => {
    return window.desktop.on("run:push", (push) => {
      if (push.kind === "event") {
        setEvents((prev) => [...prev, push.event]);
        return;
      }
      if (push.kind === "done") {
        setFinished(push.result);
        setPhase("idle");
        return;
      }
      setFailure({ code: push.code, message: push.message });
      setPhase("idle");
    });
  }, []);

  // 事件流到底部。
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  const startRun = useCallback(async (): Promise<void> => {
    setRequestError(null);
    setFailure(null);
    setFinished(null);
    setEvents([]);
    const result = await window.desktop.invoke("run:start", {
      task,
      mode,
      ...(repoRoot.trim() === "" ? {} : { repoRoot: repoRoot.trim() }),
    });
    if (!result.success) {
      setRequestError(result.error);
      return;
    }
    setRunInfo(result.data);
    setPhase("running");
  }, [task, mode, repoRoot]);

  const cancelRun = useCallback(async (): Promise<void> => {
    if (runInfo === null) return;
    const result = await window.desktop.invoke("run:cancel", runInfo.runId);
    if (!result.success) setRequestError(result.error);
  }, [runInfo]);

  const running = phase === "running";

  return (
    <main className="shell">
      <header>
        <h1>KuseCode Desktop</h1>
        <p className="subtitle">把 Agent Runtime 装进桌面的全栈壳</p>
      </header>

      <section className="card">
        <h2>任务</h2>
        <textarea
          value={task}
          placeholder="描述要做什么。例如：阅读 README，总结这个仓库是干什么的"
          onChange={(e) => setTask(e.target.value)}
          disabled={running}
          rows={3}
        />
        <div className="row">
          <label>
            模式{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value as "offline" | "env")} disabled={running}>
              <option value="offline">离线冒烟（faux）</option>
              <option value="env">环境模型（KUSECODE_MODEL）</option>
            </select>
          </label>
          <input
            className="grow"
            value={repoRoot}
            placeholder="仓库根目录（留空 = 默认仓库）"
            onChange={(e) => setRepoRoot(e.target.value)}
            disabled={running}
          />
          {running ? (
            <button className="danger" onClick={() => void cancelRun()}>
              取消
            </button>
          ) : (
            <button onClick={() => void startRun()} disabled={task.trim() === ""}>
              开始 Run
            </button>
          )}
        </div>
        {requestError !== null && <p className="error">请求失败：{requestError}</p>}
        {runInfo !== null && (
          <p className="meta">
            Run <code>{runInfo.runId}</code> · 会话 <code>{runInfo.sessionId}</code>
            {running ? " · 进行中…" : ""}
          </p>
        )}
      </section>

      <section className="card">
        <h2>事件流{events.length > 0 ? `（${events.length} 条）` : ""}</h2>
        {events.length === 0 ? (
          <p className="meta">还没有事件。发起一次 Run，事件会实时出现在这里。</p>
        ) : (
          <ol className="stream">
            {events.map((event) => {
              const label = eventLabel(event);
              return (
                <li key={`${event.sequence}-${event.type}`} className={TONE_CLASS[label.tone]}>
                  <span className="seq">{event.sequence}</span>
                  <span className="type">{event.type}</span>
                  <span>{label.text}</span>
                </li>
              );
            })}
            <div ref={listEndRef} />
          </ol>
        )}
      </section>

      {finished !== null && <TraceCard finished={finished} />}
      {failure !== null && (
        <section className="card">
          <h2>失败</h2>
          <p className="error">
            [{failure.code}] {failure.message}
          </p>
        </section>
      )}
    </main>
  );
}

function TraceCard({ finished }: { finished: RunFinishedInfo }): ReactElement {
  const { trace, audit } = finished;
  return (
    <section className="card">
      <h2>Trace（从日志读回）</h2>
      <p className="meta">
        模型 {finished.modelName}
        {finished.offline ? "（离线冒烟，结论不是模型推理）" : ""} · 事件 {trace.eventCount} 条
      </p>
      <p>
        收场：
        <StopBadge stop={trace.stop} />
      </p>
      {trace.usage !== null && (
        <p className="meta">
          用量：{trace.usage.inputTokens ?? "?"} 入 / {trace.usage.outputTokens ?? "?"} 出 · 工具{" "}
          {trace.usage.toolCalls} 次 · {trace.usage.durationMs}ms
        </p>
      )}
      {trace.steps.length > 0 && (
        <p className="meta">步骤：{trace.steps.map((s) => s.tool).join(" → ")}</p>
      )}
      {audit !== null && (
        <p className="meta">
          证据核对：{audit.conclusive ? "可确定" : "不可确定（有截断观测）"} · 依据 {audit.total}{" "}
          条（成立 {audit.supported}）{audit.unsupported.length > 0 ? ` · 未对上 ${audit.unsupported.length}` : ""}
          {audit.unbacked.length > 0 ? ` · 无依据论断 ${audit.unbacked.length}` : ""}
          {audit.ok ? " · 全部对上" : ""}
        </p>
      )}
    </section>
  );
}

function StopBadge({ stop }: { stop: import("../../../../src/index").RunTrace["stop"] }): ReactElement {
  switch (stop.kind) {
    case "completed":
      return <span className={stop.status === "complete" ? "tone-ok" : "tone-warn"}>完成（{stop.status === "complete" ? "完整" : "部分"}）</span>;
    case "failed":
      return <span className="tone-error">失败 [{stop.code}] {stop.message}</span>;
    case "cancelled":
      return <span className="tone-warn">已取消</span>;
    case "awaiting_human":
      return <span className="tone-human">等待人：{stop.question}</span>;
    case "unfinished":
      return <span className="tone-warn">未走完（{stop.status}）</span>;
    default: {
      const _exhaustive: never = stop;
      return <span className="tone-error">{JSON.stringify(_exhaustive)}</span>;
    }
  }
}
