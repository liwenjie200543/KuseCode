import { ipcMain, app } from "electron";
import type { IpcChannelMap } from "../shared/ipc-contract.js";

/**
 * 带 Result 包装的 invoke/handle：Electron 只序列化 Error 的 message，
 * 这里把完整错误语境放进返回值，不让错误在边界上失真。
 */
export type IpcResult<T> = { success: true; data: T } | { success: false; error: string };

export function ok<T>(data: T): IpcResult<T> {
  return { success: true, data };
}

export function fail(error: unknown): IpcResult<never> {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

type Handler<K extends keyof IpcChannelMap> = (
  ...args: IpcChannelMap[K]["args"]
) => Promise<IpcChannelMap[K]["return"]> | IpcChannelMap[K]["return"];

export function handle<K extends keyof IpcChannelMap>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, (_event, ...args: unknown[]) => {
    return Promise.resolve(handler(...(args as IpcChannelMap[K]["args"]))).then(
      (data) => ok(data),
      (error) => fail(error),
    );
  });
}

/** 步 11a 只注册应用级通道；RunService 的通道在 11b 接上。 */
export function registerShellHandlers(): void {
  handle("app:ping", () => ({ pong: true, pid: process.pid }));
  handle("app:quit", () => {
    app.quit();
  });
}
