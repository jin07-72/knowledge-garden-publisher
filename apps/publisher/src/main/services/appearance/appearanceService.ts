import { lstat, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { compileAppearanceCss } from "../../../shared/appearance"
import type {
  AppearanceApplyReceipt,
  AppearanceApplyRequest,
  AppearanceBackgroundSelection,
  AppearanceClearPreviewRequest,
  AppearancePreviewReceipt,
  AppearancePreviewRequest,
  AppearancePreviewTarget,
  AppearanceSnapshot,
  AppearanceUndoRequest,
  AppError,
  PreviewStatus,
} from "../../../shared/contracts"
import type { AppearanceAdapter, AppearancePlan } from "./appearanceAdapter"
import type { AppearanceAssetService } from "./appearanceAssets"
import {
  executeAppearancePlan,
  recoverAppearanceTransactions,
  undoAppearanceTransaction,
  type AppearanceTransactionReceipt,
} from "./appearanceTransaction"

interface PreviewInstallRequest {
  readonly url: string
  readonly sessionId: string
  readonly css: string
  readonly target?: AppearancePreviewTarget
}

interface PreviewRemoveRequest {
  readonly url: string
  readonly sessionId: string
}

export interface AppearancePreviewManagerPort {
  getStatus(): PreviewStatus
  stop(): Promise<PreviewStatus>
  start(request: { readonly workspace: string }): Promise<PreviewStatus>
}

export interface AppearanceServiceDependencies {
  readonly workspace: string
  readonly adapter: AppearanceAdapter
  readonly assets: AppearanceAssetService
  readonly preview: AppearancePreviewManagerPort
  readonly installPreview: (request: PreviewInstallRequest) => Promise<boolean>
  readonly removePreview: (request: PreviewRemoveRequest) => Promise<boolean>
  readonly executePlan?: (
    workspace: string,
    plan: AppearancePlan,
    verifyBuild: () => Promise<void>,
  ) => Promise<AppearanceTransactionReceipt>
  readonly undoTransaction?: (
    workspace: string,
    baselineHash: string,
    verifyBuild: () => Promise<void>,
  ) => Promise<AppearanceTransactionReceipt>
  readonly recoverTransactions?: (
    workspace: string,
  ) => Promise<readonly AppearanceTransactionReceipt[]>
  readonly hasUndoHistory?: (workspace: string) => Promise<boolean>
}

export interface AppearanceService {
  read(): Promise<AppearanceSnapshot>
  chooseBackground(): Promise<AppearanceBackgroundSelection | undefined>
  preview(request: AppearancePreviewRequest): Promise<AppearancePreviewReceipt>
  clearPreview(request: AppearanceClearPreviewRequest): Promise<void>
  apply(request: AppearanceApplyRequest): Promise<AppearanceApplyReceipt>
  undo(request: AppearanceUndoRequest): Promise<AppearanceApplyReceipt>
  dispose(): Promise<void>
}

function appearanceError(code: AppError["code"], message: string): AppError {
  return { code, message } as AppError
}

function unavailable(): AppError {
  return appearanceError(
    "APPEARANCE_UNSUPPORTED",
    "This blog framework does not have an appearance adapter.",
  )
}

function inactive(): AppError {
  return appearanceError("APPEARANCE_CONFLICT", "The appearance service is no longer active.")
}

function busy(): AppError {
  return appearanceError("APPEARANCE_CONFLICT", "Another appearance update is already in progress.")
}

function previewUnavailable(): AppError {
  return appearanceError(
    "APPEARANCE_PREVIEW_UNAVAILABLE",
    "The local appearance preview is unavailable.",
  )
}

function previewBaseDir(rawUrl: string, previewUrl: URL): string {
  const pathStart = rawUrl.indexOf("/", rawUrl.indexOf("://") + 3)
  if (pathStart < 0) return ""
  const rawPathAndSuffix = rawUrl.slice(pathStart)
  const suffixStart = rawPathAndSuffix.search(/[?#]/)
  const rawPath = suffixStart < 0 ? rawPathAndSuffix : rawPathAndSuffix.slice(0, suffixStart)
  if (rawPath !== previewUrl.pathname) return ""
  const match = /^\/([a-f0-9]{32})(?:\/|$)/.exec(rawPath)
  return match === null ? "" : `/${match[1]}`
}

function stagedImageUrl(
  request: AppearancePreviewRequest,
  assets: AppearanceAssetService,
): string | undefined {
  if (request.settings.background.kind !== "image") return undefined
  const asset = request.settings.background.asset
  if (asset.source === "managed") {
    const previewUrl = new URL(request.url)
    const baseDir = previewBaseDir(request.url, previewUrl)
    return new URL(
      `${baseDir}/publisher/${encodeURIComponent(asset.name)}`,
      previewUrl.origin,
    ).toString()
  }
  const staged = assets.resolve(asset.token)
  if (staged.name !== asset.name) {
    throw appearanceError("APPEARANCE_INVALID", "The staged background does not match the draft.")
  }
  const mime = staged.extension === ".jpg" ? "jpeg" : staged.extension.slice(1)
  return `data:image/${mime};base64,${Buffer.from(staged.bytes).toString("base64")}`
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Capability probe only; authenticated history is still validated by the transaction executor. */
export async function hasAppearanceUndoHistory(workspace: string): Promise<boolean> {
  const current = resolve(workspace, ".garden-publisher", "appearance-history", "current")
  try {
    const details = await lstat(current)
    if (!details.isDirectory() || details.isSymbolicLink()) return false
    return pathsEqual(await realpath(current), current)
  } catch {
    return false
  }
}

function errorStatus(status: PreviewStatus): AppError {
  return (
    status.error ??
    appearanceError("PREVIEW_BUILD_FAILED", "The local preview could not rebuild the appearance.")
  )
}

function errorCode(error: unknown): AppError["code"] | undefined {
  try {
    return typeof error === "object" && error !== null && "code" in error
      ? (error.code as AppError["code"])
      : undefined
  } catch {
    return undefined
  }
}

export async function createAppearanceService(
  dependencies: AppearanceServiceDependencies,
): Promise<AppearanceService> {
  const executePlan = dependencies.executePlan ?? executeAppearancePlan
  const undoTransaction = dependencies.undoTransaction ?? undoAppearanceTransaction
  const recoverTransactions = dependencies.recoverTransactions ?? recoverAppearanceTransactions
  const recovered = await recoverTransactions(dependencies.workspace)
  let canUndo =
    (recovered.at(-1)?.canUndo ?? false) ||
    (await (dependencies.hasUndoHistory ?? hasAppearanceUndoHistory)(dependencies.workspace))
  let disposed = false
  let disposeFlight: Promise<void> | undefined
  let mutationFlight: Promise<AppearanceApplyReceipt> | undefined
  let previewRevision = 0
  let previewTail: Promise<void> = Promise.resolve()
  let requestedPreview: PreviewRemoveRequest | undefined
  let activePreview: PreviewRemoveRequest | undefined

  const assertActive = (): void => {
    if (disposed || disposeFlight !== undefined) throw inactive()
  }

  const readSnapshot = async (): Promise<AppearanceSnapshot> => {
    const current = await dependencies.adapter.read()
    const effectiveCanUndo = current.canUndo || canUndo
    return current.supported && current.canUndo !== effectiveCanUndo
      ? { ...current, canUndo: effectiveCanUndo }
      : current
  }

  const read = async (): Promise<AppearanceSnapshot> => {
    assertActive()
    return readSnapshot()
  }

  const assertSupported = async (): Promise<void> => {
    if (!(await dependencies.adapter.read()).supported) throw unavailable()
  }

  const enqueuePreview = <T>(operation: () => Promise<T>): Promise<T> => {
    const flight = previewTail.then(operation, operation)
    previewTail = flight.then(
      () => undefined,
      () => undefined,
    )
    return flight
  }

  const clearAllPreview = async (): Promise<void> => {
    previewRevision += 1
    requestedPreview = undefined
    const tracked = activePreview
    await enqueuePreview(async () => {
      if (tracked !== undefined) await dependencies.removePreview(tracked)
      if (activePreview === tracked) activePreview = undefined
    })
  }

  const restartPreview = async (): Promise<void> => {
    const previous = dependencies.preview.getStatus()
    const stopped = await dependencies.preview.stop()
    if (stopped.state === "error") throw errorStatus(stopped)
    const next = await dependencies.preview.start({ workspace: dependencies.workspace })
    if (next.state !== "ready" || next.generation <= previous.generation) throw errorStatus(next)
  }

  const executeVerifiedMutation = async (
    expectedCanUndo: boolean,
    execute: (verifyBuild: () => Promise<void>) => Promise<AppearanceTransactionReceipt>,
  ): Promise<AppearanceSnapshot> => {
    let verificationAttempted = false
    let verifiedSnapshot: AppearanceSnapshot | undefined
    const verifyBuild = async (): Promise<void> => {
      verificationAttempted = true
      await restartPreview()
      verifiedSnapshot = await dependencies.adapter.read()
    }
    try {
      await execute(verifyBuild)
    } catch (error) {
      const code = errorCode(error)
      if (
        verificationAttempted &&
        (code === "APPEARANCE_TRANSACTION_FAILED" || code === "APPEARANCE_CONFLICT")
      ) {
        await restartPreview()
      }
      throw error
    }
    if (verifiedSnapshot === undefined) {
      throw appearanceError(
        "APPEARANCE_TRANSACTION_UNCERTAIN",
        "The committed appearance snapshot is unavailable.",
      )
    }
    canUndo = expectedCanUndo
    return verifiedSnapshot.canUndo === expectedCanUndo
      ? verifiedSnapshot
      : { ...verifiedSnapshot, canUndo: expectedCanUndo }
  }

  const mutation = (operation: () => Promise<AppearanceApplyReceipt>) => {
    assertActive()
    if (mutationFlight !== undefined) return Promise.reject(busy())
    const flight = operation()
    mutationFlight = flight
    void flight.then(
      () => {
        if (mutationFlight === flight) mutationFlight = undefined
      },
      () => {
        if (mutationFlight === flight) mutationFlight = undefined
      },
    )
    return flight
  }

  return {
    read,

    async chooseBackground() {
      assertActive()
      await assertSupported()
      return dependencies.assets.choose()
    },

    async preview(request) {
      assertActive()
      if (mutationFlight !== undefined) throw busy()
      const revision = ++previewRevision
      requestedPreview = { url: request.url, sessionId: request.sessionId }
      try {
        await assertSupported()
      } catch (error) {
        if (revision === previewRevision) requestedPreview = undefined
        throw error
      }
      if (revision !== previewRevision) return { sessionId: request.sessionId }
      const css = compileAppearanceCss(request.settings, {
        imageUrl: stagedImageUrl(request, dependencies.assets),
      })
      return enqueuePreview(async () => {
        if (revision !== previewRevision) return { sessionId: request.sessionId }
        const installed = await dependencies.installPreview({
          url: request.url,
          sessionId: request.sessionId,
          css,
          ...(request.target ? { target: request.target } : {}),
        })
        if (revision !== previewRevision) {
          if (installed) {
            await dependencies.removePreview({ url: request.url, sessionId: request.sessionId })
          }
          return { sessionId: request.sessionId }
        }
        if (!installed) throw previewUnavailable()
        activePreview = { url: request.url, sessionId: request.sessionId }
        return { sessionId: request.sessionId }
      })
    },

    async clearPreview(request) {
      assertActive()
      const cancelsRequested = requestedPreview?.sessionId === request.sessionId
      const tracked = activePreview?.sessionId === request.sessionId ? activePreview : undefined
      if (!cancelsRequested && tracked === undefined) return
      if (cancelsRequested) {
        previewRevision += 1
        requestedPreview = undefined
      }
      await enqueuePreview(async () => {
        if (tracked !== undefined) await dependencies.removePreview(tracked)
        if (activePreview === tracked) activePreview = undefined
      })
    },

    apply(request) {
      return mutation(async () => {
        await clearAllPreview()
        await assertSupported()
        const background = request.settings.background
        const staged =
          background.kind === "image" && background.asset.source === "staged"
            ? dependencies.assets.resolve(background.asset.token)
            : undefined
        const appearancePlan = await dependencies.adapter.plan(
          request.settings,
          request.baselineHash,
          staged,
        )
        const snapshot = await executeVerifiedMutation(true, (verifyBuild) =>
          executePlan(dependencies.workspace, appearancePlan, verifyBuild),
        )
        if (staged !== undefined) {
          try {
            const consumed = dependencies.assets.consume(staged.token)
            consumed.bytes.fill(0)
          } catch {
            // The committed managed resource no longer depends on the in-memory staging token.
          }
        }
        return { snapshot }
      })
    },

    undo(request) {
      return mutation(async () => {
        await clearAllPreview()
        await assertSupported()
        const snapshot = await executeVerifiedMutation(false, (verifyBuild) =>
          undoTransaction(dependencies.workspace, request.baselineHash, verifyBuild),
        )
        return { snapshot }
      })
    },

    async dispose() {
      if (disposeFlight !== undefined) return disposeFlight
      disposeFlight = (async () => {
        await mutationFlight?.catch(() => undefined)
        disposed = true
        try {
          await clearAllPreview()
        } finally {
          dependencies.assets.dispose()
        }
      })()
      return disposeFlight
    },
  }
}
