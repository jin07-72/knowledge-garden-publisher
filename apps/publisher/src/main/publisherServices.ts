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
  trashNote,
} from "./services/noteFiles"
import { scanNotes } from "./services/noteIndex"
import { inspectWorkspace } from "./services/workspace"

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
}

function unavailable(name: string): AppError {
  return { code: "SERVICE_UNAVAILABLE", message: `${name} is not available yet.` }
}

/** Wires only implemented Task 3-7 capabilities; later services fail explicitly. */
export function createPublisherServices(
  dependencies: PublisherServiceDependencies,
): PublisherIpcServices {
  const { workspace, trash, preview, isTracked } = dependencies
  const reject = async <T>(name: string): Promise<T> => Promise.reject(unavailable(name))
  return {
    workspace: {
      inspect: () => inspectWorkspace(workspace, { checkGit: true }),
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
      trash: (request) => trashNote({ workspace, trash, isTracked, ...request }),
    },
    preview: {
      start: (request) => preview.start({ workspace, ...request }),
      stop: () => preview.stop(),
      status: () => preview.getStatus(),
      subscribe: (listener) => preview.subscribe(listener),
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

export async function disposePublisherRuntime(
  unregisterIpc: (() => void) | undefined,
  preview: { dispose(): Promise<void> },
): Promise<void> {
  let failure: unknown
  try {
    unregisterIpc?.()
  } catch (error) {
    failure = error
  }
  try {
    await preview.dispose()
  } catch (error) {
    failure ??= error
  }
  if (failure !== undefined) throw failure
}

export interface PublisherQuitCoordinator {
  beforeQuit(event: { preventDefault(): void }): Promise<void>
}

export function createPublisherQuitCoordinator(options: {
  readonly cleanup: () => Promise<void>
  readonly allowQuit: () => void
  readonly logFailure: (message: string) => void
  readonly maximumAttempts?: number
  readonly retryDelay?: () => Promise<void>
}): PublisherQuitCoordinator {
  const maximumAttempts = Math.max(1, options.maximumAttempts ?? 3)
  const retryDelay =
    options.retryDelay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 250)))
  let attempts = 0
  let allowed = false
  let inFlight: Promise<void> | undefined

  return {
    beforeQuit(event) {
      if (allowed) return Promise.resolve()
      event.preventDefault()
      if (inFlight !== undefined) return inFlight
      if (attempts >= maximumAttempts) return Promise.resolve()
      inFlight = (async () => {
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
      })().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
}
