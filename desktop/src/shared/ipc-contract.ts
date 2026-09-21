/**
 * 主/预加载/渲染三层共享的 IPC 契约。
 *
 * 通道名与参数类型只在这里声明一次；主进程 `handle`、预加载 `invoke`
 * 都被这个映射钉住——渲染层永远不直接碰 `ipcRenderer`。
 */

import type { EvidenceAudit, RunTrace } from "../../../src/index";
import type { RunPushEvent, RunStartRequest, RunStartedInfo } from "../main/run-service";

/** 每个通道：入参元组 + 返回类型。请求-响应一律走 invoke/handle。 */
export interface IpcChannelMap {
  "app:ping": { args: []; return: { pong: true; pid: number } };
  "app:quit": { args: []; return: void };
  "run:start": { args: [request: RunStartRequest]; return: RunStartedInfo };
  "run:cancel": { args: [runId: string]; return: { cancelled: boolean } };
  "run:trace": {
    args: [runId: string];
    return: { trace: RunTrace; audit: EvidenceAudit | null };
  };
}

/** 主进程主动推送的通道（webContents.send / ipcRenderer.on）。 */
export interface IpcEventMap {
  "run:push": RunPushEvent;
}

export type IpcChannel = keyof IpcChannelMap;
