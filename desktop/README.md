# KuseCode Desktop

把 `ts-agent-runtime` 的 Runtime 装进 Electron 全栈壳。架构与决策见 [`../docs/11-desktop-shell.md`](../docs/11-desktop-shell.md)。

## 启动

```bash
cd desktop
npm install            # 沙箱环境：见 docs/11 第 3 节的坑与适配
npm run dev            # 开发（electron-vite dev）
npm run build          # 构建
npx electron .         # 运行构建产物
```

首次使用建议选「离线冒烟（faux）」模式：不联网、不要凭据，整条真实链路
（工具调用 → 事件流 → trace → 证据核对）都会走一遍。真实模型设
`KUSECODE_MODEL=provider/model` 后切「环境模型」模式。

## 结构

- `src/main/run-service.ts` — Runtime 宿主，零 electron import，可被根 vitest 直接测
- `src/shared/ipc-contract.ts` — 三层共享的类型化 IPC 契约
- `src/preload/` — contextBridge 薄层（invoke + 订阅交清理函数）
- `src/renderer/` — React UI（任务表单、事件流直播、trace 面板）
