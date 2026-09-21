import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { IpcChannelMap, IpcEventMap } from "../shared/ipc-contract.js";

/**
 * contextBridge 之上的类型化薄层：渲染层拿到的是几个具名函数，
 * 不是裸 `ipcRenderer`。invoke 返回统一是 `IpcResult`；
 * 推送订阅交出清理函数（React StrictMode 的 effect 清理靠它）。
 */
const api = {
  invoke<K extends keyof IpcChannelMap>(
    channel: K,
    ...args: IpcChannelMap[K]["args"]
  ): Promise<{ success: true; data: IpcChannelMap[K]["return"] } | { success: false; error: string }> {
    return ipcRenderer.invoke(channel, ...args);
  },
  on<K extends keyof IpcEventMap>(
    channel: K,
    callback: (payload: IpcEventMap[K]) => void,
  ): () => void {
    const handler = (_event: IpcRendererEvent, payload: IpcEventMap[K]): void => {
      callback(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld("desktop", api);
