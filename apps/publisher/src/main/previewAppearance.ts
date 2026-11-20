export interface PreviewFramePort {
  readonly url: string
  executeJavaScript(source: string, userGesture?: boolean): Promise<unknown>
}

export interface AppearancePreviewFramePort extends PreviewFramePort {
  readonly frameTreeNodeId: number
  readonly detached: boolean
}

export type PreviewFrameSource = readonly PreviewFramePort[] | (() => readonly PreviewFramePort[])

export interface AppearanceFramePreviewRequest {
  readonly url: string
  readonly sessionId: string
  readonly css: string
}

export interface AppearanceFrameClearRequest {
  readonly url: string
  readonly sessionId: string
}

export function normalizedAppearancePreviewUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
    url.hash = ""
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    return url.toString()
  } catch {
    return undefined
  }
}

function installPreviewStyle(payload: {
  expectedUrl: string
  sessionId: string
  css: string
}): boolean {
  const normalize = (value: string): string | undefined => {
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
      url.hash = ""
      url.pathname = url.pathname.replace(/\/+$/, "") || "/"
      return url.toString()
    } catch {
      return undefined
    }
  }
  if (normalize(location.href) !== payload.expectedUrl) return false
  document
    .querySelectorAll("style[data-publisher-appearance-preview]")
    .forEach((node) => node.remove())
  const style = document.createElement("style")
  style.dataset.publisherAppearancePreview = payload.sessionId
  style.textContent = payload.css
  document.head.append(style)
  return true
}

function clearPreviewStyle(payload: { expectedUrl: string; sessionId: string }): boolean {
  const normalize = (value: string): string | undefined => {
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
      url.hash = ""
      url.pathname = url.pathname.replace(/\/+$/, "") || "/"
      return url.toString()
    } catch {
      return undefined
    }
  }
  if (normalize(location.href) !== payload.expectedUrl) return false
  document
    .querySelectorAll<HTMLStyleElement>("style[data-publisher-appearance-preview]")
    .forEach((style) => {
      if (style.dataset.publisherAppearancePreview === payload.sessionId) style.remove()
    })
  return true
}

function scriptFor<Payload>(operation: (payload: Payload) => boolean, payload: Payload): string {
  return `(${operation.toString()})(${JSON.stringify(payload)})`
}

async function executeInExactFrame(
  frameSource: PreviewFrameSource,
  url: string,
  execute: (frame: PreviewFramePort) => Promise<boolean>,
): Promise<boolean> {
  try {
    const requestedUrl = normalizedAppearancePreviewUrl(url)
    if (!requestedUrl) return false
    const frames = typeof frameSource === "function" ? frameSource() : frameSource
    const frame = frames.find(
      (candidate) => normalizedAppearancePreviewUrl(candidate.url) === requestedUrl,
    )
    if (!frame) return false
    return execute(frame)
  } catch {
    return false
  }
}

export async function installAppearancePreviewInFrame(
  frame: PreviewFramePort,
  request: AppearanceFramePreviewRequest,
): Promise<boolean> {
  try {
    const expectedUrl = normalizedAppearancePreviewUrl(request.url)
    if (!expectedUrl || normalizedAppearancePreviewUrl(frame.url) !== expectedUrl) return false
    return (
      (await frame.executeJavaScript(
        scriptFor(installPreviewStyle, {
          expectedUrl,
          sessionId: request.sessionId,
          css: request.css,
        }),
        true,
      )) === true
    )
  } catch {
    return false
  }
}

export async function removeAppearancePreviewFromFrame(
  frame: PreviewFramePort,
  request: AppearanceFrameClearRequest,
): Promise<boolean> {
  try {
    const expectedUrl = normalizedAppearancePreviewUrl(request.url)
    if (!expectedUrl || normalizedAppearancePreviewUrl(frame.url) !== expectedUrl) return false
    return (
      (await frame.executeJavaScript(
        scriptFor(clearPreviewStyle, {
          expectedUrl,
          sessionId: request.sessionId,
        }),
        true,
      )) === true
    )
  } catch {
    return false
  }
}

export function previewAppearance(
  frames: PreviewFrameSource,
  request: AppearanceFramePreviewRequest,
): Promise<boolean> {
  return executeInExactFrame(frames, request.url, (frame) =>
    installAppearancePreviewInFrame(frame, request),
  )
}

export function clearAppearancePreview(
  frames: PreviewFrameSource,
  request: AppearanceFrameClearRequest,
): Promise<boolean> {
  return executeInExactFrame(frames, request.url, (frame) =>
    removeAppearancePreviewFromFrame(frame, request),
  )
}
