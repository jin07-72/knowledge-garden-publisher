import { app, BrowserWindow, ipcMain, net, shell } from "electron"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { DEFAULT_GARDEN_PATH, IPC_CHANNELS } from "../shared/contracts"
import { systemCommandRunner } from "./lib/commandRunner"
import { registerPublisherIpc } from "./ipc"
import {
  createPublisherCloseCoordinator,
  createPublisherServices,
  disposePublisherRuntime,
  type PublisherRuntimeServices,
} from "./publisherServices"
import {
  configureTrustedRendererNavigation,
  createRendererTrustPolicy,
  isTrustedRendererSender,
  trustedRendererArgument,
  type RendererTrustPolicy,
} from "./rendererTrust"
import type { PreviewManager } from "./services/preview"
import { createProductionPreviewManager } from "./services/previewRuntime"
import { isPreviewPortAvailable } from "./services/previewRuntime"
import { createElectronTrashAdapter } from "./services/trash"

let mainWindow: BrowserWindow | undefined
let mainWindowTrust: RendererTrustPolicy | undefined
let unregisterIpc: (() => void) | undefined
let previewManager: PreviewManager | undefined
let publisherServices: PublisherRuntimeServices | undefined

let pendingClose:
  | {
      readonly requestId: string
      readonly promise: Promise<boolean>
      readonly finish: (success: boolean) => void
    }
  | undefined

function requestRendererFlush(): Promise<boolean> {
  if (pendingClose) return pendingClose.promise
  const window = mainWindow
  const trust = mainWindowTrust
  if (
    !window ||
    !trust ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    !trust.isTrustedUrl(window.webContents.getURL())
  )
    return Promise.resolve(false)
  const requestId = randomUUID()
  let finish!: (success: boolean) => void
  const promise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000)
    finish = (success) => {
      clearTimeout(timer)
      resolve(success)
    }
  }).finally(() => {
    if (pendingClose?.requestId === requestId) pendingClose = undefined
  })
  pendingClose = { requestId, promise, finish }
  window.webContents.send(IPC_CHANNELS.events.beforeClose, { requestId })
  return promise
}

const closeCoordinator = createPublisherCloseCoordinator({
  requestRendererFlush,
  cleanup: async () => {
    const manager = previewManager
    const unregister = unregisterIpc
    if (manager === undefined) {
      unregister?.()
      unregisterIpc = undefined
      return
    }
    await disposePublisherRuntime(unregister, manager, publisherServices)
    unregisterIpc = undefined
    previewManager = undefined
    publisherServices = undefined
  },
  allowQuit: () => app.quit(),
  allowClose: () => mainWindow?.close(),
  reportFailure: (message) => {
    console.error(message)
    let window = mainWindow
    if ((!window || window.isDestroyed() || window.webContents.isDestroyed()) && app.isReady())
      window = createWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    if (window.webContents.isLoading()) {
      window.webContents.once("did-finish-load", () => {
        if (!window?.isDestroyed())
          window?.webContents.send(IPC_CHANNELS.events.closeBlocked, { message })
      })
    } else window.webContents.send(IPC_CHANNELS.events.closeBlocked, { message })
  },
})

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
  window.on("close", (event) => {
    void closeCoordinator.beforeWindowClose(event)
  })
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
  const npmCliPath = app.isPackaged
    ? join(process.resourcesPath, "node", "node_modules", "npm", "bin", "npm-cli.js")
    : join(app.getAppPath(), "vendor", "node", "node_modules", "npm", "bin", "npm-cli.js")
  const bundledRuntime =
    app.isPackaged || (existsSync(runtimePath) && existsSync(npmCliPath))
      ? { nodePath: runtimePath, npmCliPath }
      : undefined
  previewManager = createProductionPreviewManager(runtimePath)
  publisherServices = createPublisherServices({
    workspace: DEFAULT_GARDEN_PATH,
    trash: createElectronTrashAdapter(shell),
    isTracked,
    preview: previewManager,
    openExternal: (url) => shell.openExternal(url),
    ...(bundledRuntime ? { runtime: bundledRuntime } : {}),
    previewPortAvailable: () => isPreviewPortAvailable(8080),
    online: () => net.isOnline(),
  })
  unregisterIpc = registerPublisherIpc({
    ipcMain,
    services: publisherServices,
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
    acknowledgeClose: ({ requestId, success }) => {
      if (pendingClose?.requestId === requestId) pendingClose.finish(success)
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
  void closeCoordinator.beforeQuit(event)
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
