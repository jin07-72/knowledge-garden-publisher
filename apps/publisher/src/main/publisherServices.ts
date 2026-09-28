import type { AppError, PreviewStatus, TrashAdapter } from "../shared/contracts"
import type { PublisherIpcServices } from "./ipc"
import {
  createNote,
  executeRename,
  executeVisibilityChange,
  planRename,
  planVisibilityChange,
  readNote,
  saveNote,
} from "./services/noteFiles"
import { trashManagedNote } from "./services/trash"
import {
  discardEditorRecovery,
  getEditorRecovery,
  writeEditorRecovery,
} from "./services/editorRecovery"
import { scanNotes } from "./services/noteIndex"
import { inspectWorkspace, repairWorkspace, type BundledNpmRuntime } from "./services/workspace"
import { createChangeScanner, type ChangeScanner } from "./services/changes"
import {
  createDeploymentHistoryService,
  type DeploymentHistoryService,
} from "./services/deployments"

export interface PreviewServicePort {
  start(request: {
    readonly workspace: string
    readonly preferredPort?: number
  }): Promise<PreviewStatus>
  stop(): Promise<PreviewStatus>
  getStatus(): PreviewStatus
  subscribe(listener: (status: PreviewStatus) => void): () => void
}

export interface PublisherServiceDependencies {
  readonly workspace: string
  readonly trash: TrashAdapter
  readonly isTracked: (workspace: string, path: string) => Promise<boolean>
  readonly preview: PreviewServicePort
  readonly changeScanner?: Pick<ChangeScanner, "list" | "cancel"> &
    Partial<Pick<ChangeScanner, "dispose">>
  readonly deploymentHistory?: DeploymentHistoryService
  readonly openExternal?: (url: string) => Promise<void>
  readonly runtime?: BundledNpmRuntime
  readonly previewPortAvailable?: () => Promise<boolean>
  readonly online?: () => boolean | Promise<boolean>
}

export type PublisherRuntimeServices = PublisherIpcServices & { dispose(): Promise<void> }

function unavailable(name: string): AppError {
  return { code: "SERVICE_UNAVAILABLE", message: `${name} is not available yet.` }
}

/** Wires implemented capabilities; publishing remains unavailable until Task 11. */
export function createPublisherServices(
  dependencies: PublisherServiceDependencies,
): PublisherRuntimeServices {
  const { workspace, trash, preview, isTracked } = dependencies
  const changeScanner = dependencies.changeScanner ?? createChangeScanner({ workspace })
  const deploymentHistory =
    dependencies.deploymentHistory ??
    createDeploymentHistoryService({ workspace, openExternal: dependencies.openExternal })
  const reject = async <T>(name: string): Promise<T> => Promise.reject(unavailable(name))
  return {
    dispose: async () => {
      await Promise.all([
        changeScanner.dispose?.() ?? changeScanner.cancel(),
        deploymentHistory.dispose(),
      ])
    },
    workspace: {
      inspect: () =>
        inspectWorkspace(workspace, {
          checkGit: true,
          checkRemote: dependencies.runtime !== undefined,
          online: dependencies.online,
          runtime: dependencies.runtime,
          previewPortAvailable: dependencies.previewPortAvailable,
        }),
      repair: (request) => {
        if (!dependencies.runtime) return reject("Dependency repair")
        return repairWorkspace(workspace, request, { runtime: dependencies.runtime })
      },
    },
    notes: {
      list: () => scanNotes(workspace),
      read: (request) => readNote({ workspace, ...request }),
      save: (request) => saveNote({ workspace, recoveryTrash: trash, ...request }),
      create: (request) => createNote({ workspace, ...request }),
      rename: async (request) => {
        const plan = await planRename({ workspace, ...request })
        return executeRename(plan, { workspace, transactionTrash: trash })
      },
      changeVisibility: async (request) => {
        const plan = await planVisibilityChange({ workspace, ...request })
        return executeVisibilityChange(plan, { workspace, transactionTrash: trash })
      },
      trash: (request) => trashManagedNote({ workspace, trash, isTracked, ...request }),
      recovery: {
        get: (request) => getEditorRecovery(workspace, request),
        write: (request) => writeEditorRecovery(workspace, request),
        discard: (request) => discardEditorRecovery(workspace, request, trash),
      },
    },
    preview: {
      start: (request) => preview.start({ workspace, ...request }),
      stop: () => preview.stop(),
      status: () => preview.getStatus(),
      subscribe: (listener) => preview.subscribe(listener),
    },
    changes: {
      list: () => changeScanner.list(),
      cancel: () => changeScanner.cancel(),
    },
    publish: {
      start: () => reject("Publishing"),
      cancel: () => reject("Publishing"),
      subscribe: () => () => undefined,
    },
    history: {
      git: (request) => deploymentHistory.git(request),
      deployments: (request) => deploymentHistory.deployments(request),
      cancel: (request) => deploymentHistory.cancel(request),
      openLink: ({ url }) => deploymentHistory.openLink(url),
    },
  }
}

export async function disposePublisherRuntime(
  unregisterIpc: (() => void) | undefined,
  preview: { dispose(): Promise<void> },
  services?: { dispose(): Promise<void> },
): Promise<void> {
  await services?.dispose()
  await preview.dispose()
  unregisterIpc?.()
}

export interface PublisherQuitCoordinator {
  beforeQuit(event: { preventDefault(): void }): Promise<void>
}

export interface PublisherCloseCoordinator {
  beforeWindowClose(event: { preventDefault(): void }): Promise<void>
  beforeQuit(event: { preventDefault(): void }): Promise<void>
}

/** Fail-closed close barrier. Cleanup cannot begin until the renderer confirms durable state. */
export function createPublisherCloseCoordinator(options: {
  readonly requestRendererFlush: () => Promise<boolean>
  readonly cleanup: () => Promise<void>
  readonly allowClose: () => void
  readonly allowQuit: () => void
  readonly reportFailure: (message: string) => void
  readonly timeoutMs?: number
}): PublisherCloseCoordinator {
  let flushed = false
  let closeAllowed = false
  let quitAllowed = false
  let closeRequested = false
  let quitRequested = false
  let flight: Promise<void> | undefined
  const requestFlush = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        options.requestRendererFlush(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), options.timeoutMs ?? 10_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const run = (): Promise<void> => {
    if (flight) return flight
    const operation = (async () => {
      try {
        if (!flushed) {
          if (!(await requestFlush())) {
            closeRequested = false
            quitRequested = false
            options.reportFailure("保存失败，窗口仍保持打开。")
            return
          }
          flushed = true
        }
        if (closeRequested && !closeAllowed) {
          closeAllowed = true
          try {
            options.allowClose()
          } catch (error) {
            closeAllowed = false
            throw error
          }
        }
        if (quitRequested && !quitAllowed) {
          await options.cleanup()
          quitAllowed = true
          try {
            options.allowQuit()
          } catch (error) {
            quitAllowed = false
            throw error
          }
        }
      } catch {
        flushed = false
        closeAllowed = false
        closeRequested = false
        quitRequested = false
        options.reportFailure("保存或关闭准备失败，窗口仍保持打开。")
      }
    })()
    flight = operation.finally(() => {
      if (flight === tracked) flight = undefined
    })
    const tracked = flight
    return flight
  }

  return {
    beforeWindowClose(event) {
      if (closeAllowed || quitAllowed) return Promise.resolve()
      event.preventDefault()
      closeRequested = true
      return run()
    },
    beforeQuit(event) {
      if (quitAllowed) return Promise.resolve()
      event.preventDefault()
      quitRequested = true
      return run()
    },
  }
}

export function createPublisherQuitCoordinator(options: {
  readonly cleanup: () => Promise<void>
  readonly allowQuit: () => void
  readonly logFailure: (message: string) => void
  readonly maximumAttempts?: number
  readonly retryDelay?: () => Promise<void>
  readonly restoreOperable?: () => void
}): PublisherQuitCoordinator {
  const maximumAttempts = Math.max(1, options.maximumAttempts ?? 3)
  const retryDelay =
    options.retryDelay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 250)))
  let allowed = false
  let inFlight: Promise<void> | undefined

  return {
    beforeQuit(event) {
      if (allowed) return Promise.resolve()
      event.preventDefault()
      if (inFlight !== undefined) return inFlight
      inFlight = (async () => {
        let attempts = 0
        while (attempts < maximumAttempts) {
          attempts += 1
          try {
            await options.cleanup()
            allowed = true
            options.allowQuit()
            return
          } catch {
            if (attempts < maximumAttempts) {
              await retryDelay()
            }
          }
        }
        options.logFailure("Publisher preview shutdown failed.")
        try {
          options.restoreOperable?.()
        } catch {
          // Failure recovery must remain fail-closed even if UI restoration races.
        }
      })().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
}
