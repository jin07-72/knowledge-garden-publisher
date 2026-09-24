import { pathToFileURL } from "node:url"
import {
  normalizeStrictLoopbackRendererUrl,
  trustedRendererArgument,
  trustedRendererUrlFromArguments,
} from "../shared/rendererTrust"

export { trustedRendererArgument, trustedRendererUrlFromArguments }

export interface RendererTrustPolicy {
  readonly target: { readonly kind: "url" | "file"; readonly value: string }
  readonly trustedUrl: string
  isTrustedUrl(candidate: string): boolean
}

export interface RendererNavigationPort {
  setWindowOpenHandler(handler: () => { readonly action: "deny" }): void
  on(
    event: "will-navigate" | "will-redirect",
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): void
}

interface RendererFramePort {
  readonly url: string
}

interface RendererWebContentsPort {
  readonly mainFrame: RendererFramePort
  isDestroyed(): boolean
  getURL(): string
}

interface RendererWindowPort {
  readonly webContents: RendererWebContentsPort
  isDestroyed(): boolean
}

interface RendererInvokeEventPort {
  readonly sender: RendererWebContentsPort
  readonly senderFrame: RendererFramePort | null
}

export function createRendererTrustPolicy(
  rendererFile: string,
  devRendererUrl?: string,
): RendererTrustPolicy {
  const normalizedDevRendererUrl =
    devRendererUrl === undefined ? undefined : normalizeStrictLoopbackRendererUrl(devRendererUrl)
  if (devRendererUrl !== undefined && normalizedDevRendererUrl === undefined) {
    throw new Error(
      "ELECTRON_RENDERER_URL must be an exact loopback HTTP origin with an explicit port.",
    )
  }

  const target =
    normalizedDevRendererUrl === undefined
      ? ({ kind: "file", value: rendererFile } as const)
      : ({ kind: "url", value: normalizedDevRendererUrl } as const)
  const trustedUrl = target.kind === "file" ? pathToFileURL(target.value).href : target.value

  return Object.freeze({
    target,
    trustedUrl,
    isTrustedUrl: (candidate: string) => candidate === trustedUrl,
  })
}

export function configureTrustedRendererNavigation(
  webContents: RendererNavigationPort,
  trust: RendererTrustPolicy,
): void {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  const preventUntrustedNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (!trust.isTrustedUrl(url)) event.preventDefault()
  }
  webContents.on("will-navigate", preventUntrustedNavigation)
  webContents.on("will-redirect", preventUntrustedNavigation)
}

export function isTrustedRendererSender(
  event: RendererInvokeEventPort,
  window: RendererWindowPort,
  trust: RendererTrustPolicy,
): boolean {
  try {
    return (
      !window.isDestroyed() &&
      !event.sender.isDestroyed() &&
      event.senderFrame !== null &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      trust.isTrustedUrl(event.senderFrame.url) &&
      trust.isTrustedUrl(window.webContents.getURL())
    )
  } catch {
    return false
  }
}
