import { app, BrowserWindow, ipcMain, shell } from "electron"
import { join } from "node:path"
import { DEFAULT_GARDEN_PATH, type AppError } from "../shared/contracts"
import { registerPublisherIpc, type PublisherIpcServices } from "./ipc"
import {
  configureTrustedRendererNavigation,
  createRendererTrustPolicy,
  isTrustedRendererSender,
  trustedRendererArgument,
  type RendererTrustPolicy,
} from "./rendererTrust"
import {
  createNote,
  executeRename,
  executeVisibilityChange,
  planRename,
  planVisibilityChange,
  saveNote,
} from "./services/noteFiles"
import { scanNotes } from "./services/noteIndex"
import { inspectWorkspace } from "./services/workspace"

let mainWindow: BrowserWindow | undefined
let mainWindowTrust: RendererTrustPolicy | undefined
let unregisterIpc: (() => void) | undefined

function unavailable(name: string): AppError {
  return { code: "SERVICE_UNAVAILABLE", message: `${name} is not available yet.` }
}

function createPublisherServices(): PublisherIpcServices {
  const reject = async <T>(name: string): Promise<T> => Promise.reject(unavailable(name))
  const trash = { trashItem: (absolutePath: string) => shell.trashItem(absolutePath) }
  return {
    workspace: {
      inspect: () => inspectWorkspace(DEFAULT_GARDEN_PATH, { checkGit: true }),
    },
    notes: {
      list: () => scanNotes(DEFAULT_GARDEN_PATH),
      read: () => reject("Opening notes"),
      save: (request) =>
        saveNote({ workspace: DEFAULT_GARDEN_PATH, recoveryTrash: trash, ...request }),
      create: (request) => createNote({ workspace: DEFAULT_GARDEN_PATH, ...request }),
      rename: async (request) => {
        const plan = await planRename({ workspace: DEFAULT_GARDEN_PATH, ...request })
        return executeRename(plan, { workspace: DEFAULT_GARDEN_PATH, transactionTrash: trash })
      },
      changeVisibility: async (request) => {
        const plan = await planVisibilityChange({ workspace: DEFAULT_GARDEN_PATH, ...request })
        return executeVisibilityChange(plan, {
          workspace: DEFAULT_GARDEN_PATH,
          transactionTrash: trash,
        })
      },
      trash: () => reject("Moving notes to the Recycle Bin"),
    },
    preview: {
      start: () => reject("Local preview"),
      stop: () => reject("Local preview"),
      status: () => reject("Local preview"),
      subscribe: () => () => undefined,
    },
    changes: { list: () => reject("Change review") },
    publish: {
      start: () => reject("Publishing"),
      cancel: () => reject("Publishing"),
      subscribe: () => () => undefined,
    },
    history: {
      git: () => reject("Git history"),
      deployments: () => reject("Deployment history"),
    },
  }
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
  createWindow()
  unregisterIpc = registerPublisherIpc({
    ipcMain,
    services: createPublisherServices(),
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.once("will-quit", () => {
  unregisterIpc?.()
  unregisterIpc = undefined
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
