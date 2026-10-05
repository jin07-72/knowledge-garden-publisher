import { randomUUID } from "node:crypto"
import type {
  AppError,
  PreviewStatus,
  PublishProgress,
  TrashAdapter,
  TrashRecoveryUpdate,
} from "../shared/contracts"
import type { PublisherIpcServices } from "./ipc"
import {
  createNote,
  executeRename,
  executeVisibilityChange,
  internalRecoveryKey,
  planRename,
  planVisibilityChange,
  readNote,
  saveNote,
} from "./services/noteFiles"
import { trashManagedNote } from "./services/trash"
import { reconcileTrashRecoveryPass } from "./services/trashRecovery"
import {
  discardEditorRecovery,
  getEditorRecovery,
  writeEditorRecovery,
} from "./services/editorRecovery"
import { scanNotes } from "./services/noteIndex"
import {
  inspectWorkspace,
  inspectWorkspaceSafety,
  repairWorkspace,
  type BundledNpmRuntime,
} from "./services/workspace"
import { createChangeScanner, type ChangeScanner } from "./services/changes"
import {
  createDeploymentHistoryService,
  type DeploymentHistoryService,
} from "./services/deployments"
import {
  createDomainCatalog,
  type DomainCatalog,
  type DomainCatalogOptions,
} from "./services/domains"

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
  readonly domainCatalogFactory?: (options: DomainCatalogOptions) => DomainCatalog
  readonly openExternal?: (url: string) => Promise<void>
  readonly runtime?: BundledNpmRuntime
  readonly previewPortAvailable?: () => Promise<boolean>
  readonly online?: () => boolean | Promise<boolean>
  readonly reconcileTrash?: (signal: AbortSignal) => Promise<{
    readonly pending: boolean
    readonly restored?: readonly string[]
    readonly conflicts?: readonly string[]
  }>
  readonly publisherFactory?: (onProgress: (progress: PublishProgress) => void) => {
    publish(selection: {
      readonly paths: readonly string[]
      readonly message?: string
    }): Promise<unknown>
    cancel(): Promise<void>
    dispose(): Promise<void>
  }
  readonly publishCompletionMessage?: string
}

export type PublisherRuntimeServices = PublisherIpcServices & {
  assertSwitchSafe(): Promise<void>
  dispose(): Promise<void>
}

function unavailable(name: string): AppError {
  return { code: "SERVICE_UNAVAILABLE", message: `${name} is not available yet.` }
}

function switchBusy(restoreSafe = false): AppError & { readonly restoreSafe: boolean } {
  return {
    code: "BLOG_SWITCH_BUSY",
    message: "Finish the current publication task before switching blogs.",
    restoreSafe,
  }
}

export function canRestorePublisherRuntime(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "restoreSafe" in error &&
    error.restoreSafe === true
  )
}

/** Wires implemented capabilities; publishing remains unavailable until Task 11. */
export async function createPublisherServices(
  dependencies: PublisherServiceDependencies,
): Promise<PublisherRuntimeServices> {
  const { workspace, trash, preview, isTracked } = dependencies
  const ownsChangeScanner = dependencies.changeScanner === undefined
  const changeScanner = dependencies.changeScanner ?? createChangeScanner({ workspace })
  let domains: DomainCatalog | undefined
  let deploymentHistory: DeploymentHistoryService | undefined
  let publisher:
    ReturnType<NonNullable<PublisherServiceDependencies["publisherFactory"]>> | undefined

  let reject!: <T>(name: string) => Promise<T>
  let publishListeners!: Set<(progress: PublishProgress) => void>
  let emitPublish!: (progress: PublishProgress) => void
  const rollbackConstruction = async (primary: unknown): Promise<never> => {
    const failures: unknown[] = []
    if (publisher) {
      try {
        await publisher.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (deploymentHistory && dependencies.deploymentHistory === undefined) {
      try {
        await deploymentHistory.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (domains) {
      try {
        await domains.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (ownsChangeScanner) {
      try {
        await (changeScanner.dispose?.() ?? changeScanner.cancel())
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError([primary, ...failures], "Publisher service construction failed.")
    }
    throw primary
  }
  try {
    domains = (dependencies.domainCatalogFactory ?? createDomainCatalog)({ workspace, trash })
    deploymentHistory =
      dependencies.deploymentHistory ??
      createDeploymentHistoryService({ workspace, openExternal: dependencies.openExternal })
    reject = async <T>(name: string): Promise<T> => Promise.reject(unavailable(name))
    publishListeners = new Set<(progress: PublishProgress) => void>()
    emitPublish = (progress: PublishProgress): void => {
      for (const listener of publishListeners) listener(progress)
    }
    publisher = dependencies.publisherFactory?.(emitPublish)
  } catch (primary) {
    return rollbackConstruction(primary)
  }
  const catalog = domains
  const history = deploymentHistory
  if (!catalog || !history)
    return rollbackConstruction(new Error("Publisher services failed to initialize."))
  let activePublish: string | undefined
  let preparingPublish = 0
  let switchPreparing = false
  const recoveryListeners = new Set<(update: TrashRecoveryUpdate) => void>()
  const reconcileTrash =
    dependencies.reconcileTrash ??
    ((signal: AbortSignal) =>
      reconcileTrashRecoveryPass(workspace, () => internalRecoveryKey(workspace, false), {
        signal,
      }))
  let recoveryFlight: Promise<void> | undefined
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  let recoveryAbort: AbortController | undefined
  let recoveryRetryMs = 50
  let recoveryDisposed = false
  const scheduleRecovery = (delayMs: number): void => {
    if (recoveryDisposed || recoveryTimer !== undefined) return
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined
      recoveryFlight = undefined
      startRecovery()
    }, delayMs)
  }
  const startRecovery = (): void => {
    if (recoveryDisposed || recoveryFlight !== undefined) return
    recoveryAbort = new AbortController()
    const pass = Promise.resolve().then(() => reconcileTrash(recoveryAbort!.signal))
    recoveryFlight = pass
      .then(({ pending, restored = [], conflicts = [] }) => {
        recoveryRetryMs = 50
        if (restored.length > 0 || conflicts.length > 0) {
          const update = { restored, conflicts }
          for (const listener of recoveryListeners) listener(update)
        }
        if (pending && !recoveryDisposed) {
          scheduleRecovery(0)
        }
      })
      .catch(() => {
        if (!recoveryDisposed && !recoveryAbort?.signal.aborted) {
          scheduleRecovery(recoveryRetryMs)
          recoveryRetryMs = Math.min(5_000, recoveryRetryMs * 2)
        }
      })
      .finally(() => {
        recoveryAbort = undefined
        if (recoveryTimer === undefined) recoveryFlight = undefined
      })
  }
  return {
    assertSwitchSafe: async () => {
      if (activePublish || preparingPublish > 0) throw switchBusy(true)
      switchPreparing = true
      try {
        await changeScanner.cancel()
        await catalog.assertIdle()
      } catch (error) {
        const restoreSafe =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "DOMAIN_BUSY"
        if (restoreSafe) switchPreparing = false
        throw switchBusy(restoreSafe)
      }
    },
    dispose: async () => {
      switchPreparing = true
      await catalog.dispose()
      recoveryDisposed = true
      if (recoveryTimer) clearTimeout(recoveryTimer)
      recoveryAbort?.abort()
      await Promise.all([
        recoveryFlight,
        changeScanner.dispose?.() ?? changeScanner.cancel(),
        history.dispose(),
        publisher?.dispose(),
      ])
    },
    workspace: {
      inspectSafety: () => inspectWorkspaceSafety(workspace),
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
    domains: catalog,
    notes: {
      subscribeRecovery: (listener) => {
        recoveryListeners.add(listener)
        return () => recoveryListeners.delete(listener)
      },
      list: async () => {
        startRecovery()
        return scanNotes(workspace)
      },
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
      list: () => (switchPreparing ? Promise.reject(switchBusy()) : changeScanner.list()),
      cancel: () => changeScanner.cancel(),
    },
    publish: {
      start: async (request) => {
        if (switchPreparing) throw switchBusy()
        if (!publisher) return reject("Publishing")
        if (activePublish) {
          throw {
            code: "INVALID_INPUT",
            message: "A publication is already running.",
          } satisfies AppError
        }
        preparingPublish += 1
        let review
        try {
          review = await changeScanner.list()
        } finally {
          preparingPublish -= 1
        }
        if (switchPreparing) throw switchBusy()
        const groups = request.changeGroupIds.map((id) =>
          review.groups.find((group) => group.id === id),
        )
        if (
          groups.some((group) => !group || group.selection === "locked" || group.kind === "private")
        ) {
          throw {
            code: "INVALID_INPUT",
            message: "The publication selection is invalid.",
          } satisfies AppError
        }
        const paths = [
          ...new Set(
            groups
              .flatMap((group) => group?.paths ?? [])
              .filter((path) => !/^private(?:\/|$)/i.test(path)),
          ),
        ]
        if (paths.length === 0) {
          throw {
            code: "INVALID_INPUT",
            message: "The publication selection is empty.",
          } satisfies AppError
        }
        const operationId = randomUUID()
        activePublish = operationId
        void publisher
          .publish({ paths, ...(request.message ? { message: request.message } : {}) })
          .then(
            () =>
              emitPublish({
                phase: "complete",
                message: dependencies.publishCompletionMessage ?? "发布成功，正在等待部署。",
                percent: 100,
              }),
            () => emitPublish({ phase: "failed", message: "发布失败；本地编辑内容仍已保留。" }),
          )
          .finally(() => {
            if (activePublish === operationId) activePublish = undefined
          })
        return { operationId }
      },
      cancel: async (request) => {
        if (!publisher) return reject("Publishing")
        if (activePublish !== request.operationId) {
          throw {
            code: "INVALID_INPUT",
            message: "The publication operation is unavailable.",
          } satisfies AppError
        }
        await publisher.cancel()
      },
      subscribe: (listener) => {
        publishListeners.add(listener)
        return () => publishListeners.delete(listener)
      },
    },
    history: {
      git: (request) => history.git(request),
      deployments: (request) => history.deployments(request),
      cancel: (request) => history.cancel(request),
      openLink: ({ url }) => history.openLink(url),
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

export function createPublisherRuntimeShutdown(options: {
  readonly services?: {
    assertSwitchSafe?(): Promise<void>
    dispose(): Promise<void>
  }
  readonly preview?: { dispose(): Promise<void> }
  readonly unregister?: () => void
  readonly getServices?: () =>
    | {
        assertSwitchSafe?(): Promise<void>
        dispose(): Promise<void>
      }
    | undefined
  readonly getPreview?: () => { dispose(): Promise<void> } | undefined
  readonly getUnregister?: () => (() => void) | undefined
  readonly preflight?: (markRestoreUnsafe: () => void) => Promise<void>
}): (markRestoreUnsafe?: () => void, skipPreflight?: boolean) => Promise<void> {
  let servicesDisposed = false
  let irreversibleStarted = false
  let previewDisposed = false
  let ipcUnregistered = false
  let flight: Promise<void> | undefined
  const pendingMarks = new Set<() => void>()
  const getServices = options.getServices ?? (() => options.services)
  const getPreview = options.getPreview ?? (() => options.preview)
  const getUnregister = options.getUnregister ?? (() => options.unregister)

  const beginIrreversibleCleanup = (): void => {
    if (irreversibleStarted) return
    irreversibleStarted = true
    const marks = [...pendingMarks]
    pendingMarks.clear()
    for (const mark of marks) mark()
  }

  return (markRestoreUnsafe = () => undefined, skipPreflight = false) => {
    let marked = false
    const mark = (): void => {
      if (marked) return
      marked = true
      markRestoreUnsafe()
    }
    if (irreversibleStarted) mark()
    else pendingMarks.add(mark)
    if (flight) return flight

    const operation = (async () => {
      try {
        if (!servicesDisposed) {
          const services = getServices()
          if (services) {
            if (!skipPreflight && !irreversibleStarted) {
              if (options.preflight) await options.preflight(mark)
              else await services.assertSwitchSafe?.()
            }
            beginIrreversibleCleanup()
            await services.dispose()
          }
          servicesDisposed = true
        }
        if (!previewDisposed) {
          await getPreview()?.dispose()
          previewDisposed = true
        }
        if (!ipcUnregistered) {
          getUnregister()?.()
          ipcUnregistered = true
        }
      } finally {
        pendingMarks.clear()
      }
    })()
    const tracked = operation.finally(() => {
      if (flight === tracked) flight = undefined
    })
    flight = tracked
    return tracked
  }
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
    const tracked = operation.finally(() => {
      if (flight !== tracked) return
      flight = undefined
      if ((closeRequested && !closeAllowed) || (quitRequested && !quitAllowed)) return run()
    })
    flight = tracked
    return tracked
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
