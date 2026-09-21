import { app, BrowserWindow, shell } from "electron";
import { join, resolve } from "node:path";
import { registerShellHandlers } from "./ipc.js";
import { RunService, storeRootFor } from "./run-service.js";
import { registerRunHandlers } from "./run-ipc.js";

// 沙箱/远程桌面环境下 GPU 进程常不可用（连崩 10 次后 FATAL 退出）。
// 纯 UI 应用不需要硬件加速，显式关掉换来任何环境都能起。
app.disableHardwareAcceleration();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on("ready-to-show", () => win.show());

  // 外链交给系统浏览器，绝不在渲染进程里开第三方页面。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  // Runtime 宿主：事件日志落在 userData/runs，事件推给每一个窗口。
  const service = new RunService({
    storeRoot: storeRootFor(app.getPath("userData")),
    // out/main 向上三层是仓库根（打包后需重新考虑，见 docs/11 局限）。
    defaultRepoRoot: resolve(__dirname, "../../.."),
    emit: (push) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("run:push", push);
      }
    },
  });

  registerShellHandlers();
  registerRunHandlers(service);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
