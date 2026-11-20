import {
  installAppearancePreviewInFrame,
  normalizedAppearancePreviewUrl,
  removeAppearancePreviewFromFrame,
  type AppearanceFrameClearRequest,
  type AppearanceFramePreviewRequest,
  type AppearancePreviewFramePort,
} from "./previewAppearance"

export interface AppearancePreviewNavigation {
  readonly frameTreeNodeId: number
  readonly url: string
  readonly finished: boolean
}

export interface AppearancePreviewController {
  install(request: AppearanceFramePreviewRequest): Promise<boolean>
  remove(request: AppearanceFrameClearRequest): Promise<boolean>
  didNavigate(event: AppearancePreviewNavigation): Promise<void>
  dispose(): Promise<void>
}

export interface AppearancePreviewControllerOptions {
  readonly frames: () => readonly AppearancePreviewFramePort[]
}

interface BoundPreview {
  readonly sessionId: string
  readonly css: string
  readonly origin: string
  readonly frameTreeNodeId: number
  readonly revision: number
}

function exactLoopbackOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port.length === 0
    ) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

function readableFrame(
  frame: AppearancePreviewFramePort,
): { readonly id: number; readonly url: string } | undefined {
  try {
    if (frame.detached) return undefined
    return { id: frame.frameTreeNodeId, url: frame.url }
  } catch {
    return undefined
  }
}

export function createAppearancePreviewController({
  frames,
}: AppearancePreviewControllerOptions): AppearancePreviewController {
  let bound: BoundPreview | undefined
  let pending: BoundPreview | undefined
  let revision = 0
  let disposed = false
  let disposal: Promise<void> | undefined
  let operations = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operations.then(operation, operation)
    operations = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function currentFrames(): readonly AppearancePreviewFramePort[] {
    try {
      return frames()
    } catch {
      return []
    }
  }

  function frameById(frameTreeNodeId: number): AppearancePreviewFramePort | undefined {
    for (const candidate of currentFrames()) {
      const current = readableFrame(candidate)
      if (current?.id === frameTreeNodeId) return candidate
    }
    return undefined
  }

  function frameByUrl(url: string): AppearancePreviewFramePort | undefined {
    const expected = normalizedAppearancePreviewUrl(url)
    if (!expected) return undefined
    for (const candidate of currentFrames()) {
      const current = readableFrame(candidate)
      if (current && normalizedAppearancePreviewUrl(current.url) === expected) return candidate
    }
    return undefined
  }

  async function clearBoundPreview(preview: BoundPreview): Promise<boolean> {
    const frame = frameById(preview.frameTreeNodeId)
    if (!frame) return false
    const current = readableFrame(frame)
    if (!current || exactLoopbackOrigin(current.url) !== preview.origin) return false
    return removeAppearancePreviewFromFrame(frame, {
      url: current.url,
      sessionId: preview.sessionId,
    })
  }

  return {
    install(request) {
      if (disposed) return Promise.resolve(false)
      const operationRevision = ++revision
      return enqueue(async () => {
        if (disposed || operationRevision !== revision) return false

        const existing = bound
        if (existing?.sessionId === request.sessionId) {
          const frame = frameById(existing.frameTreeNodeId)
          if (!frame) return false
          const current = readableFrame(frame)
          if (!current || exactLoopbackOrigin(current.url) !== existing.origin) return false
          const installed = await installAppearancePreviewInFrame(frame, {
            url: current.url,
            sessionId: request.sessionId,
            css: request.css,
          })
          if (!installed || disposed || operationRevision !== revision) return false
          bound = { ...existing, css: request.css, revision: operationRevision }
          return true
        }

        const origin = exactLoopbackOrigin(request.url)
        if (!origin) return false
        const frame = frameByUrl(request.url)
        if (!frame) return false
        const current = readableFrame(frame)
        if (!current) return false
        const target: BoundPreview = {
          sessionId: request.sessionId,
          css: request.css,
          origin,
          frameTreeNodeId: current.id,
          revision: operationRevision,
        }
        pending = target
        try {
          const installed = await installAppearancePreviewInFrame(frame, request)
          if (!installed || disposed || operationRevision !== revision) return false
          bound = target
          return true
        } finally {
          if (pending === target) pending = undefined
        }
      })
    },

    remove(request) {
      if (disposed) return Promise.resolve(true)
      const operationRevision = ++revision
      const preview =
        bound?.sessionId === request.sessionId
          ? bound
          : pending?.sessionId === request.sessionId
            ? pending
            : undefined
      if (preview === bound) bound = undefined
      if (preview === pending) pending = undefined
      return enqueue(async () => {
        if (operationRevision !== revision) return true
        if (!preview) return true
        return clearBoundPreview(preview)
      })
    },

    didNavigate(event) {
      if (
        disposed ||
        !event.finished ||
        !bound ||
        bound.revision !== revision ||
        event.frameTreeNodeId !== bound.frameTreeNodeId ||
        exactLoopbackOrigin(event.url) !== bound.origin
      ) {
        return Promise.resolve()
      }
      const operationRevision = revision
      const eventUrl = normalizedAppearancePreviewUrl(event.url)
      return enqueue(async () => {
        if (disposed || operationRevision !== revision || !bound || !eventUrl) return
        if (bound.frameTreeNodeId !== event.frameTreeNodeId) return
        const frame = frameById(event.frameTreeNodeId)
        if (!frame) return
        const current = readableFrame(frame)
        if (
          !current ||
          normalizedAppearancePreviewUrl(current.url) !== eventUrl ||
          exactLoopbackOrigin(current.url) !== bound.origin
        ) {
          return
        }
        await installAppearancePreviewInFrame(frame, {
          url: current.url,
          sessionId: bound.sessionId,
          css: bound.css,
        })
      })
    },

    dispose() {
      if (disposal) return disposal
      disposed = true
      ++revision
      const previews = [bound, pending].filter(
        (preview): preview is BoundPreview => preview !== undefined,
      )
      bound = undefined
      pending = undefined
      disposal = enqueue(async () => {
        for (const preview of previews) await clearBoundPreview(preview)
      })
      return disposal
    },
  }
}
