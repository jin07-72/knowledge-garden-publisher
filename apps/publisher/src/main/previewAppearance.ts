export interface PreviewFramePort {
  readonly url: string
  executeJavaScript(source: string, userGesture?: boolean): Promise<unknown>
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

function normalizedLoopbackUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
    url.hash = ""
    url.search = ""
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
      url.search = ""
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
      url.search = ""
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
  source: (expectedUrl: string) => string,
): Promise<boolean> {
  try {
    const requestedUrl = normalizedLoopbackUrl(url)
    if (!requestedUrl) return false
    const frames = typeof frameSource === "function" ? frameSource() : frameSource
    const frame = frames.find((candidate) => normalizedLoopbackUrl(candidate.url) === requestedUrl)
    if (!frame) return false
    return (await frame.executeJavaScript(source(requestedUrl), true)) === true
  } catch {
    return false
  }
}

export function previewAppearance(
  frames: PreviewFrameSource,
  request: AppearanceFramePreviewRequest,
): Promise<boolean> {
  return executeInExactFrame(frames, request.url, (expectedUrl) =>
    scriptFor(installPreviewStyle, {
      expectedUrl,
      sessionId: request.sessionId,
      css: request.css,
    }),
  )
}

export function clearAppearancePreview(
  frames: PreviewFrameSource,
  request: AppearanceFrameClearRequest,
): Promise<boolean> {
  return executeInExactFrame(frames, request.url, (expectedUrl) =>
    scriptFor(clearPreviewStyle, {
      expectedUrl,
      sessionId: request.sessionId,
    }),
  )
}
