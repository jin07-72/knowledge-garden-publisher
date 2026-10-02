import { app, BrowserWindow, dialog, ipcMain, net, shell } from "electron"
import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { DEFAULT_GARDEN_PATH, IPC_CHANNELS } from "../shared/contracts"
import { systemCommandRunner } from "./lib/commandRunner"
import { registerBlogManagementIpc, registerLifecycleIpc, registerPublisherIpc } from "./ipc"
import {
  createBlogManagementAdapter,
  createBlogRuntime,
  resolveBlogRegistryFile,
  resolveE2eCloneSource,
} from "./blogRuntime"
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
  createSystemBoundedCommandRunner,
  createProductionPublisher,
  createPublisherForTest,
  type PublishProgressEvent,
} from "./services/publish"
import type { PreviewStatus, PublishProgress } from "../shared/contracts"
import { resolveMainRuntimeFiles } from "./mainRuntime"
import { createBlogRegistry } from "./services/blogRegistry"
import {
  createBlogImportService,
  inspectBlogCandidate,
  type BlogImportService,
} from "./services/blogImport"

let mainWindow: BrowserWindow | undefined
let mainWindowTrust: RendererTrustPolicy | undefined
let unregisterIpc: (() => void) | undefined
let unregisterBlogIpc: (() => void) | undefined
let unregisterLifecycleIpc: (() => void) | undefined
let prepareBlogManagementShutdown: (() => Promise<void>) | undefined
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
    await prepareBlogManagementShutdown?.()
    const manager = previewManager
    const unregister = unregisterIpc
    if (manager === undefined) {
      unregister?.()
      unregisterIpc = undefined
      unregisterBlogIpc?.()
      unregisterBlogIpc = undefined
      unregisterLifecycleIpc?.()
      unregisterLifecycleIpc = undefined
      return
    }
    await disposePublisherRuntime(unregister, manager, publisherServices)
    unregisterIpc = undefined
    previewManager = undefined
    publisherServices = undefined
    unregisterBlogIpc?.()
    unregisterBlogIpc = undefined
    unregisterLifecycleIpc?.()
    unregisterLifecycleIpc = undefined
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

app.whenReady().then(async () => {
  const e2e = !app.isPackaged && process.env.GARDEN_PUBLISHER_E2E === "1"
  const requestedWorkspace = process.env.GARDEN_PUBLISHER_E2E_WORKSPACE
  const legacyWorkspace =
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
  const registry = createBlogRegistry({
    file: resolveBlogRegistryFile({
      isPackaged: app.isPackaged,
      e2e,
      userDataPath: app.getPath("userData"),
      override: process.env.GARDEN_PUBLISHER_E2E_REGISTRY,
    }),
    legacyPath: legacyWorkspace,
  })
  const importRunner = createSystemBoundedCommandRunner()
  let importer!: BlogImportService
  let blogManagement!: ReturnType<typeof createBlogManagementAdapter>
  const blogRuntime = createBlogRuntime({
    registry,
    inspect: (path) => inspectBlogCandidate(path, { runner: importRunner }),
    assertIdle: async () => {
      await blogManagement.prepareForShutdown()
      try {
        await publisherServices?.assertSwitchSafe()
      } catch (error) {
        blogManagement.restoreAfterFailedShutdown()
        throw error
      }
    },
    dispose: async () => {
      await blogManagement.prepareForShutdown()
      const manager = previewManager
      if (!manager) return
      await disposePublisherRuntime(unregisterIpc, manager, publisherServices)
      unregisterIpc = undefined
      previewManager = undefined
      publisherServices = undefined
    },
    relaunch: () => {
      // Playwright owns the next application process so it can preserve and
      // observe the isolated registry without leaving an unmanaged child.
      if (!e2e) app.relaunch()
    },
    quit: () => app.quit(),
  })
  blogManagement = createBlogManagementAdapter({
    registry,
    importer: () => importer,
    inspect: (path) => inspectBlogCandidate(path, { runner: importRunner }),
    chooseDirectory: async () => {
      const e2eSelection = resolveE2eCloneSource({
        isPackaged: app.isPackaged,
        e2e,
        override: process.env.GARDEN_PUBLISHER_E2E_CHOOSE_LOCAL,
      })
      if (e2eSelection) return e2eSelection
      const selection = await dialog.showOpenDialog({ properties: ["openDirectory"] })
      return selection.canceled ? undefined : selection.filePaths[0]
    },
    openFolder: async (path) => {
      const error = await shell.openPath(path)
      if (error) throw new Error("The blog folder could not be opened.")
    },
    switchTo: (request) => blogRuntime.switchTo(request),
  })
  prepareBlogManagementShutdown = blogManagement.prepareForShutdown
  importer = createBlogImportService({
    gitExecutable: "git",
    nodePath: runtimePath,
    npmCliPath,
    runner: importRunner,
    inspect: inspectBlogCandidate,
    onProgress: blogManagement.emitProgress,
    cloneSource: () =>
      resolveE2eCloneSource({
        isPackaged: app.isPackaged,
        e2e,
        override: process.env.GARDEN_PUBLISHER_E2E_CLONE_SOURCE,
      }),
  })
  const isTrustedSender = (event: unknown): boolean => {
    const window = mainWindow
    const trust = mainWindowTrust
    if (window === undefined || trust === undefined) return false
    return isTrustedRendererSender(event as Electron.IpcMainInvokeEvent, window, trust)
  }
  const eventTargets = () => {
    const window = mainWindow
    const trust = mainWindowTrust
    return window === undefined ||
      trust === undefined ||
      window.isDestroyed() ||
      !trust.isTrustedUrl(window.webContents.getURL())
      ? []
      : [window.webContents]
  }
  unregisterBlogIpc = registerBlogManagementIpc({
    ipcMain,
    services: blogManagement.services,
    isTrustedSender,
    eventTargets,
  })
  unregisterLifecycleIpc = registerLifecycleIpc({
    ipcMain,
    isTrustedSender,
    acknowledgeClose: ({ requestId, success }) => {
      if (pendingClose?.requestId === requestId) pendingClose.finish(success)
    },
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  let workspace: string
  try {
    workspace = (await blogRuntime.active()).canonicalPath
  } catch {
    console.error("The active blog workspace is unavailable; opening blog recovery.")
    createWindow()
    return
  }

  try {
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
      isTrustedSender,
      eventTargets,
      includeBlogManagement: false,
    })
  } catch {
    await publisherServices?.dispose().catch(() => undefined)
    await previewManager?.dispose().catch(() => undefined)
    publisherServices = undefined
    previewManager = undefined
    unregisterIpc?.()
    unregisterIpc = undefined
    console.error("The active blog runtime could not start; opening blog recovery.")
  }
  createWindow()
})

app.on("before-quit", (event) => {
  void closeCoordinator.beforeQuit(event)
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
