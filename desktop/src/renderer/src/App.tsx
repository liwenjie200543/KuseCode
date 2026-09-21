import { useEffect, useState, type ReactElement } from "react";

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
    };
  }
}

export function App(): ReactElement {
  const [pong, setPong] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.desktop
      .invoke("app:ping")
      .then((result) => {
        if (!alive) return;
        if (result.success) setPong(`pong (pid ${result.data.pid})`);
        else setError(result.error);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="shell">
      <h1>KuseCode Desktop</h1>
      <p className="subtitle">Agent Runtime · Electron 全栈壳（步 11a 骨架）</p>
      <section className="card">
        <h2>IPC 自检</h2>
        {error ? (
          <p className="error">失败：{error}</p>
        ) : pong ? (
          <p className="ok">main ↔ renderer 打通：{pong}</p>
        ) : (
          <p>等待主进程回应…</p>
        )}
      </section>
    </main>
  );
}
