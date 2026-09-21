import { contextBridge, ipcRenderer } from "electron";
import type { IpcChannelMap } from "../shared/ipc-contract.js";

/**
 * contextBridge 之上的类型化薄层：渲染层拿到的是几个具名函数，
 * 不是裸 `ipcRenderer`。返回值统一是 `IpcResult`。
 */
const api = {
  invoke<K extends keyof IpcChannelMap>(
    channel: K,
    ...args: IpcChannelMap[K]["args"]
  ): Promise<{ success: true; data: IpcChannelMap[K]["return"] } | { success: false; error: string }> {
    return ipcRenderer.invoke(channel, ...args);
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld("desktop", api);
