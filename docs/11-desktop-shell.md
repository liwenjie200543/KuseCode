# 11 · 桌面壳：把 Runtime 装进 Electron 全栈产品

> 状态：11a/11b/11c 已落地。本文是该步的权威记录——推理细节只在这里，commit message 只留摘要。

## 0. 目标与边界

`ts-agent-runtime` 此前只有 CLI 一个产品面（步 9）。这一步给同一个 Runtime 第二张脸：
一个 Electron 全栈产品——主进程宿主 Runtime，渲染进程提供任务发起与事件流直播。

**边界**：Runtime 一行不改。桌面壳只是 `createRuntime` 的又一个消费者——
这本身就是对步 1–8 架构的一次实测：「换一个驱动方」要付出的代价，应该只有接线。

技术选型沿用 `fullstack-desktop` 路由技能分派的专家规范：

| 域 | 采用 |
| --- | --- |
| 进程/IPC/安全 | `electron-best-practices`：contextIsolation + sandbox + 无 nodeIntegration + 严格 CSP；invoke/handle + Result 包装 |
| 类型 | `typescript-pro`：IPC 契约用 mapped type 钉住；UI 状态用判别联合 |
| 渲染层 | React 18：推送订阅交出清理函数（StrictMode 双调用安全） |

## 1. 架构

```
desktop/
├── electron.vite.config.ts      # main/preload/renderer 三端构建；@kusecode/core → ../src/index.ts
├── src/
│   ├── main/
│   │   ├── index.ts             # BrowserWindow + RunService 宿主（事件广播到所有窗口）
│   │   ├── ipc.ts               # handle() + IpcResult 包装（错误不过 IPC 边界失真）
│   │   ├── run-service.ts       # ★ Runtime 宿主，零 electron import
│   │   ├── run-ipc.ts           # 契约 → 服务方法的粘合
│   │   └── run-service.test.ts  # 根 vitest 直接跑（不依赖 electron）
│   ├── preload/index.ts         # contextBridge：invoke + on（订阅交清理函数）
│   ├── shared/ipc-contract.ts   # 三层共享的通道映射（mapped type）
│   └── renderer/                # React：任务表单、事件流直播、trace 面板
```

**RunService 是唯一要点**：它一比一复刻 `src/cli/main.ts` 的 `commandRun` 接线
（toolbox → model 两路 → `store.startRun` → `createRuntime` → 事件流），
但不 import electron——事件怎么送到窗口只是构造时注入的一个 `emit` 回调。
这样根 vitest 把它当普通 TS 测，「主进程能做什么」与「Electron 是什么」解耦。

三条从既有步数继承的铁律在桌面壳里原样成立：

1. **trace 从日志读，不从事件流攒**（事件流可能被提前离场的消费者截短；`runs:list` 的 trace 查询走 `jsonlRunLog` 重读盘）。
2. **`null` 不是 0**：用量账目原样转述，UI 上「?」是账目未知，不冒充零。
3. **截断让核对降级**：`audit.conclusive === false` 时 UI 明说「不可确定」，不把「我看不见」说成「你没做」。

## 2. 决定

**决定 1：桌面壳独立成包（`desktop/`），不进根 package.json。**
根包是库（`ts-agent-runtime`），桌面包是消费者。渲染进程永远不 import 库源码——
类型通过 `import type` 擦除后共享，值只活在主进程。代价：依赖装两份（electron 链 ~150MB）。

**决定 2：主进程 bundle 直接打进 Runtime 与 pi-ai SDK（rollup alias → `../src/index.ts`）。**
一次构建出一个自包含的 `out/main/index.js`，运行时不需要根 `node_modules` 在场。
代价：bundle 6.4MB（pi-ai 的 provider 目录全量进来）。外部化 `@earendil-works/*`
可以瘦身，但那时运行时就要带 `node_modules`——打包（Forge）阶段再权衡。

**决定 3：事件推送用单通道 + 判别联合（`run:push`: event/done/failed），不用每事件一通道。**
通道注册只发生一次；渲染层一个 `on` 订阅收全部三种终局，`kind` 收窄。

**决定 4：`run:start` 只等日志登记完成就返回 `{runId, sessionId}`，Run 本体异步驱动。**
invoke 的请求-响应语义不该被一次长跑占住；事件与终态全部走推送。

## 3. 本机（Windows 沙箱）特有的坑与适配

- **npm 被沙箱拦**：全部走 `node npm-cli.js install --ignore-scripts`；
  esbuild/rollup 的平台二进制随 optionalDependencies 走，不受影响。
- **npm 缓存里的坏包**：fs-extra、@rollup/rollup-win32-x64-msvc 先后出现「解包截断」
  （`lib/index.js` 缺失 / `.node` 不是有效 Win32 映像）。用全新缓存目录
  `--cache <fresh>` 整体重装解决——`npm i` 重试命中同一个坏缓存是没用的。
- **Electron 二进制**：`--ignore-scripts` 后手动 `node node_modules/electron/install.js`，
  配 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
- **`ELECTRON_RUN_AS_NODE`**：宿主（WorkBuddy）环境会注入它，electron.exe 于是以纯
  Node 启动，`require("electron")` 解析到 npm 包（导出的是 exe 路径），`app` 为
  undefined。启动前必须 `env -u ELECTRON_RUN_AS_NODE`。**用户正常双击/终端启动无此问题。**
- **GPU 进程不可用**（沙箱/远程桌面）：连崩 10 次后 `GPU process isn't usable. Goodbye.`
  FATAL。`app.disableHardwareAcceleration()` 不够，启动参数需要
  `--disable-gpu --in-process-gpu`。普通桌面环境不需要这些参数。
- **preload 输出格式**：`"type": "module"` 会让 electron-vite 把 preload 编成 `.mjs`，
  而沙箱 preload 只支持 CJS。desktop 包去掉 `"type": "module"`，三端按 CJS 走主/预加载。
- **同文件并行 Edit 会互相覆盖**（本轮实测两次）：对一个文件的多处修改必须顺序提交，
  不能在同一条消息里并行发多个 Edit。

## 4. 落实（对应 commit）

- **11a 骨架**（`4c9540d`）：electron-vite 三端、安全默认、CSP、类型化 IPC 契约 + Result 包装、IPC 自检页。
- **11b Runtime 接线**（`ca66717`）：RunService（零 electron import）、`run:start/cancel/trace` + `run:push`、
  日志落 `userData/runs`、4 条冒烟测试（真实离线链路）。
- **11c 渲染层**（`07be66c`）：任务表单、13 种事件的语调化直播、trace/审计面板、取消按钮。

## 5. 验证

- `tsc --noEmit`：根与 desktop 双双零错误。
- `vitest run`：412 条全过（含 desktop 的 4 条：离线 Run 端到端、空任务/坏仓库拒绝、
  取消不存在返回 false、env 模式无凭据给明确指引）。
- `electron-vite build`：三端产物齐全（preload 为 CJS）。
- electron 启动冒烟：主进程存活、无 FATAL / Uncaught（`--disable-gpu --in-process-gpu`）。
- 未验证：真实 provider 模式（需要凭据，链路与 CLI 共用、已在步 8/9 验过）；打包发行（Forge）。

## 6. 局限（留给后续步）

1. `defaultRepoRoot` 用 `resolve(__dirname, "../../..")`——只对仓库内开发态成立；
   打包后必须改为显式选择目录（IPC 弹目录选择器）或配置。
2. 历史会话列表：`SessionStore.listSessions()` 已有，UI 尚未消费。
3. 主进程 bundle 6.4MB；外部化与 Forge 打包未做。
4. 签名/自动更新（electron-updater）未做——按 electron-best-practices 属发行阶段。
5. `human_input_requested` 只展示不答复——ask_human 循环的产品化是独立一步。
