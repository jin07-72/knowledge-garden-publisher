import { app, BrowserWindow, ipcMain, net, shell } from "electron"
import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { DEFAULT_GARDEN_PATH, IPC_CHANNELS } from "../shared/contracts"
import { systemCommandRunner } from "./lib/commandRunner"
import { registerPublisherIpc } from "./ipc"
import {
  createPublisherCloseCoordinator,
  createPublisherServices,
  disposePublisherRuntime,
  type PreviewServicePort,
  type PublisherRuntimeServices,
} from "./publisherServices"
import {
  configureTrustedRendererNavigation,
  createRendererTrustPolicy,
  isTrustedRendererSender,
  trustedRendererArgument,
  type RendererTrustPolicy,
} from "./rendererTrust"
import { createProductionPreviewManager } from "./services/previewRuntime"
import { isPreviewPortAvailable } from "./services/previewRuntime"
import { createElectronTrashAdapter } from "./services/trash"
import {
  createProductionPublisher,
  createPublisherForTest,
  type PublishProgressEvent,
} from "./services/publish"
import type { PreviewStatus, PublishProgress } from "../shared/contracts"
import { resolveMainRuntimeFiles } from "./mainRuntime"

let mainWindow: BrowserWindow | undefined
let mainWindowTrust: RendererTrustPolicy | undefined
let unregisterIpc: (() => void) | undefined
let previewManager: (PreviewServicePort & { dispose(): Promise<void> }) | undefined
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
  const { rendererFile, preloadFile } = resolveMainRuntimeFiles(import.meta.url)
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
      preload: preloadFile,
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

function mapPublishProgress(progress: PublishProgressEvent): PublishProgress | undefined {
  if (progress.phase === "complete") return undefined
  const phase: PublishProgress["phase"] =
    progress.phase === "update-local-ref"
      ? "committing"
      : progress.phase === "push" || progress.phase === "cleanup"
        ? "pushing"
        : "validating"
  return { phase, message: progress.message }
}

function e2ePreview(): PreviewServicePort & { dispose(): Promise<void> } {
  const status: PreviewStatus = {
    state: "ready",
    generation: 1,
    port: 8080,
    url: "http://127.0.0.1:8080",
  }
  return {
    start: async () => status,
    stop: async () => ({ state: "stopped", generation: 2 }),
    getStatus: () => status,
    subscribe: () => () => undefined,
    dispose: async () => undefined,
  }
}

app.whenReady().then(() => {
  const e2e = !app.isPackaged && process.env.GARDEN_PUBLISHER_E2E === "1"
  const requestedWorkspace = process.env.GARDEN_PUBLISHER_E2E_WORKSPACE
  const workspace =
    e2e && requestedWorkspace && isAbsolute(requestedWorkspace)
      ? resolve(requestedWorkspace)
      : DEFAULT_GARDEN_PATH
  const e2eRuntimeRoot = process.env.GARDEN_PUBLISHER_E2E_RUNTIME
  const runtimePath =
    e2e && e2eRuntimeRoot
      ? join(resolve(e2eRuntimeRoot), "node.exe")
      : app.isPackaged
        ? join(process.resourcesPath, "node", "node.exe")
        : join(app.getAppPath(), "vendor", "node", "node.exe")
  const npmCliPath =
    e2e && e2eRuntimeRoot
      ? join(resolve(e2eRuntimeRoot), "node_modules", "npm", "bin", "npm-cli.js")
      : app.isPackaged
        ? join(process.resourcesPath, "node", "node_modules", "npm", "bin", "npm-cli.js")
        : join(app.getAppPath(), "vendor", "node", "node_modules", "npm", "bin", "npm-cli.js")
  const bundledRuntime =
    app.isPackaged || (existsSync(runtimePath) && existsSync(npmCliPath))
      ? { nodePath: runtimePath, npmCliPath }
      : undefined
  previewManager = e2e ? e2ePreview() : createProductionPreviewManager(runtimePath)
  const publisherFactory = (onProgress: (progress: PublishProgress) => void) => {
    const relay = (progress: PublishProgressEvent): void => {
      const mapped = mapPublishProgress(progress)
      if (mapped) onProgress(mapped)
    }
    if (e2e && e2eRuntimeRoot) {
      return createPublisherForTest({
        workspace,
        runtime: {
          root: resolve(e2eRuntimeRoot),
          nodeExecutable: runtimePath,
          npmCliPath,
          nodeModules: join(workspace, "node_modules"),
        },
        validateDependencies: async () => true,
        verifySite: async () => ({ exitCode: 0 }),
        onProgress: relay,
      })
    }
    return createProductionPublisher({
      workspace,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      onProgress: relay,
    })
  }
  publisherServices = createPublisherServices({
    workspace,
    trash: createElectronTrashAdapter(shell),
    isTracked,
    preview: previewManager,
    openExternal: (url) => shell.openExternal(url),
    ...(bundledRuntime ? { runtime: bundledRuntime } : {}),
    ...(e2e ? {} : { previewPortAvailable: () => isPreviewPortAvailable(8080) }),
    online: () => (e2e ? true : net.isOnline()),
    publisherFactory,
    ...(e2e && process.env.GARDEN_PUBLISHER_E2E_DEPLOYMENT === "success"
      ? { publishCompletionMessage: "部署成功" }
      : {}),
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
