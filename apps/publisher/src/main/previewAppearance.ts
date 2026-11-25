import type { AppearancePreviewTarget } from "../shared/contracts"

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
  readonly target?: AppearancePreviewTarget
}

export interface AppearanceFrameClearRequest {
  readonly url: string
  readonly sessionId: string
}

type AppearancePreviewQueryMatch = "exact" | "ignore"

function normalizeAppearancePreviewUrl(
  value: string,
  queryMatch: AppearancePreviewQueryMatch,
): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
    url.hash = ""
    if (queryMatch === "ignore") url.search = ""
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    return url.toString()
  } catch {
    return undefined
  }
}

export function normalizedAppearancePreviewUrl(value: string): string | undefined {
  return normalizeAppearancePreviewUrl(value, "exact")
}

function normalizedLegacyAppearancePreviewUrl(value: string): string | undefined {
  return normalizeAppearancePreviewUrl(value, "ignore")
}

function installPreviewStyle(payload: {
  expectedUrl: string
  sessionId: string
  css: string
  target?: AppearancePreviewTarget
  exactQuery: boolean
}): boolean {
  const normalize = (value: string): string | undefined => {
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
      url.hash = ""
      if (!payload.exactQuery) url.search = ""
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
  const root = document.documentElement
  root.dataset.publisherAppearanceSession = payload.sessionId
  if (payload.target) {
    root.dataset.publisherAppearanceComponent = payload.target.componentId
    root.dataset.publisherAppearanceState = payload.target.state
  } else {
    delete root.dataset.publisherAppearanceComponent
    delete root.dataset.publisherAppearanceState
  }
  document.dispatchEvent(new Event("themechange"))
  return true
}

function clearPreviewStyle(payload: {
  expectedUrl: string
  sessionId: string
  exactQuery: boolean
}): boolean {
  const normalize = (value: string): string | undefined => {
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
      url.hash = ""
      if (!payload.exactQuery) url.search = ""
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
  const root = document.documentElement
  if (root.dataset.publisherAppearanceSession === payload.sessionId) {
    delete root.dataset.publisherAppearanceSession
    delete root.dataset.publisherAppearanceComponent
    delete root.dataset.publisherAppearanceState
  }
  document.dispatchEvent(new Event("themechange"))
  return true
}

function scriptFor<Payload>(operation: (payload: Payload) => boolean, payload: Payload): string {
  return `(${operation.toString()})(${JSON.stringify(payload)})`
}

async function executeInLegacyFrame(
  frameSource: PreviewFrameSource,
  url: string,
  execute: (frame: PreviewFramePort) => Promise<boolean>,
): Promise<boolean> {
  try {
    const requestedUrl = normalizedLegacyAppearancePreviewUrl(url)
    if (!requestedUrl) return false
    const frames = typeof frameSource === "function" ? frameSource() : frameSource
    const frame = frames.find(
      (candidate) => normalizedLegacyAppearancePreviewUrl(candidate.url) === requestedUrl,
    )
    if (!frame) return false
    return execute(frame)
  } catch {
    return false
  }
}

async function installAppearancePreviewInFrameMatchingQuery(
  frame: PreviewFramePort,
  request: AppearanceFramePreviewRequest,
  queryMatch: AppearancePreviewQueryMatch,
): Promise<boolean> {
  try {
    const expectedUrl = normalizeAppearancePreviewUrl(request.url, queryMatch)
    if (!expectedUrl || normalizeAppearancePreviewUrl(frame.url, queryMatch) !== expectedUrl) {
      return false
    }
    return (
      (await frame.executeJavaScript(
        scriptFor(installPreviewStyle, {
          expectedUrl,
          sessionId: request.sessionId,
          css: request.css,
          ...(request.target ? { target: request.target } : {}),
          exactQuery: queryMatch === "exact",
        }),
        true,
      )) === true
    )
  } catch {
    return false
  }
}

export function installAppearancePreviewInFrame(
  frame: PreviewFramePort,
  request: AppearanceFramePreviewRequest,
): Promise<boolean> {
  return installAppearancePreviewInFrameMatchingQuery(frame, request, "exact")
}

async function removeAppearancePreviewFromFrameMatchingQuery(
  frame: PreviewFramePort,
  request: AppearanceFrameClearRequest,
  queryMatch: AppearancePreviewQueryMatch,
): Promise<boolean> {
  try {
    const expectedUrl = normalizeAppearancePreviewUrl(request.url, queryMatch)
    if (!expectedUrl || normalizeAppearancePreviewUrl(frame.url, queryMatch) !== expectedUrl) {
      return false
    }
    return (
      (await frame.executeJavaScript(
        scriptFor(clearPreviewStyle, {
          expectedUrl,
          sessionId: request.sessionId,
          exactQuery: queryMatch === "exact",
        }),
        true,
      )) === true
    )
  } catch {
    return false
  }
}

export function removeAppearancePreviewFromFrame(
  frame: PreviewFramePort,
  request: AppearanceFrameClearRequest,
): Promise<boolean> {
  return removeAppearancePreviewFromFrameMatchingQuery(frame, request, "exact")
}

export function previewAppearance(
  frames: PreviewFrameSource,
  request: AppearanceFramePreviewRequest,
): Promise<boolean> {
  return executeInLegacyFrame(frames, request.url, (frame) =>
    installAppearancePreviewInFrameMatchingQuery(frame, request, "ignore"),
  )
}

export function clearAppearancePreview(
  frames: PreviewFrameSource,
  request: AppearanceFrameClearRequest,
): Promise<boolean> {
  return executeInLegacyFrame(frames, request.url, (frame) =>
    removeAppearancePreviewFromFrameMatchingQuery(frame, request, "ignore"),
  )
}
