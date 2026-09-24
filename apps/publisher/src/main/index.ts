import { app, BrowserWindow, ipcMain, shell } from "electron"
import { join } from "node:path"
import { DEFAULT_GARDEN_PATH } from "../shared/contracts"
import { systemCommandRunner } from "./lib/commandRunner"
import { registerPublisherIpc } from "./ipc"
import { createPublisherServices, disposePublisherRuntime } from "./publisherServices"
import {
  configureTrustedRendererNavigation,
  createRendererTrustPolicy,
  isTrustedRendererSender,
  trustedRendererArgument,
  type RendererTrustPolicy,
} from "./rendererTrust"
import type { PreviewManager } from "./services/preview"
import { createProductionPreviewManager } from "./services/previewRuntime"

let mainWindow: BrowserWindow | undefined
let mainWindowTrust: RendererTrustPolicy | undefined
let unregisterIpc: (() => void) | undefined
let previewManager: PreviewManager | undefined
let quitInProgress = false
let quitAllowed = false

async function isTracked(workspace: string, path: string): Promise<boolean> {
  const result = await systemCommandRunner.run({
    executable: "git",
    args: ["ls-files", "--error-unmatch", "--", path],
    cwd: workspace,
  })
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new Error("Git tracking state is unavailable")
}

function createWindow(): BrowserWindow {
  const rendererFile = join(__dirname, "../renderer/index.html")
  const trust = createRendererTrustPolicy(rendererFile, process.env.ELECTRON_RENDERER_URL)
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "../preload/index.js"),
      additionalArguments: [trustedRendererArgument(trust.trustedUrl)],
    },
  })
  mainWindow = window
  mainWindowTrust = trust

  configureTrustedRendererNavigation(window.webContents, trust)
  window.once("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined
      mainWindowTrust = undefined
    }
  })

  if (trust.target.kind === "url") {
    void window.loadURL(trust.target.value)
  } else {
    void window.loadFile(trust.target.value)
  }
  return window
}

app.whenReady().then(() => {
  const runtimePath = app.isPackaged
    ? join(process.resourcesPath, "node", "node.exe")
    : join(app.getAppPath(), "vendor", "node", "node.exe")
  previewManager = createProductionPreviewManager(runtimePath)
  unregisterIpc = registerPublisherIpc({
    ipcMain,
    services: createPublisherServices({
      workspace: DEFAULT_GARDEN_PATH,
      trash: { trashItem: (absolutePath) => shell.trashItem(absolutePath) },
      isTracked,
      preview: previewManager,
    }),
    isTrustedSender: (event) => {
      const window = mainWindow
      const trust = mainWindowTrust
      if (window === undefined || trust === undefined) return false
      const invokeEvent = event as Electron.IpcMainInvokeEvent
      return isTrustedRendererSender(invokeEvent, window, trust)
    },
    eventTargets: () => {
      const window = mainWindow
      const trust = mainWindowTrust
      return window === undefined ||
        trust === undefined ||
        window.isDestroyed() ||
        !trust.isTrustedUrl(window.webContents.getURL())
        ? []
        : [window.webContents]
    },
  })
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("before-quit", (event) => {
  if (quitAllowed) return
  event.preventDefault()
  if (quitInProgress) return
  quitInProgress = true
  const manager = previewManager
  const unregister = unregisterIpc
  unregisterIpc = undefined
  const shutdown =
    manager === undefined
      ? Promise.resolve().then(() => unregister?.())
      : disposePublisherRuntime(unregister, manager)
  void shutdown
    .catch(() => {
      process.exitCode = 1
      console.error("Publisher preview shutdown failed.")
    })
    .finally(() => {
      previewManager = undefined
      quitAllowed = true
      app.quit()
    })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
