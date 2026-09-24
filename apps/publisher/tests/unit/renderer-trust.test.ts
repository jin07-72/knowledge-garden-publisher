import { pathToFileURL } from "node:url"
import { describe, expect, it, vi } from "vitest"
import {
  configureTrustedRendererNavigation,
  createRendererTrustPolicy,
  isTrustedRendererSender,
  trustedRendererArgument,
  trustedRendererUrlFromArguments,
} from "../../src/main/rendererTrust"

describe("renderer trust policy", () => {
  it("accepts only an exact loopback development entry URL", () => {
    const trusted = [
      ["http://127.0.0.1:5173", "http://127.0.0.1:5173/"],
      ["http://127.0.0.1:5173/", "http://127.0.0.1:5173/"],
      ["http://[::1]:5173", "http://[::1]:5173/"],
      ["http://[::1]:5173/", "http://[::1]:5173/"],
    ] as const
    for (const [input, canonical] of trusted) {
      const policy = createRendererTrustPolicy("C:/publisher/renderer/index.html", input)
      expect(policy.target).toEqual({ kind: "url", value: canonical })
      expect(policy.trustedUrl).toBe(canonical)
      expect(policy.isTrustedUrl(canonical)).toBe(true)
      expect(policy.isTrustedUrl(input)).toBe(input === canonical)
      expect(policy.isTrustedUrl(`${canonical}remote`)).toBe(false)
    }
  })

  it("rejects remote, ambiguous, credentialed, and non-root development URLs", () => {
    const rejected = [
      "https://example.com/",
      "http://example.com:5173/",
      "http://localhost:5173/",
      "http://127.0.0.1/",
      "http://user@127.0.0.1:5173/",
      "http://127.0.0.1:5173/app",
      "http://127.0.0.1:5173/?redirect=https://example.com",
      "http://127.0.0.1:5173/#remote",
    ]
    for (const url of rejected) {
      expect(() => createRendererTrustPolicy("C:/publisher/renderer/index.html", url)).toThrow(
        "ELECTRON_RENDERER_URL",
      )
    }
  })

  it("trusts only the exact packaged renderer file when no dev URL is configured", () => {
    const rendererFile = "C:/publisher/renderer/index.html"
    const rendererUrl = pathToFileURL(rendererFile).href
    const policy = createRendererTrustPolicy(rendererFile)
    expect(policy.target).toEqual({ kind: "file", value: rendererFile })
    expect(policy.isTrustedUrl(rendererUrl)).toBe(true)
    expect(policy.isTrustedUrl(`${rendererUrl}#remote`)).toBe(false)
    expect(policy.isTrustedUrl("https://example.com/")).toBe(false)
  })

  it("requires one main-process-issued renderer argument before preload exposure", () => {
    const url = "http://127.0.0.1:5173/"
    const argument = trustedRendererArgument(url)
    expect(trustedRendererUrlFromArguments(["electron", argument])).toBe(url)
    expect(trustedRendererUrlFromArguments(["electron"])).toBeUndefined()
    expect(trustedRendererUrlFromArguments(["electron", argument, argument])).toBeUndefined()
    expect(
      trustedRendererUrlFromArguments(["electron", trustedRendererArgument("https://evil.test/")]),
    ).toBeUndefined()
  })

  it("blocks remote navigation, redirects, and every new window", () => {
    const policy = createRendererTrustPolicy(
      "C:/publisher/renderer/index.html",
      "http://127.0.0.1:5173/",
    )
    const listeners = new Map<string, (event: { preventDefault(): void }, url: string) => void>()
    let openHandler: (() => { action: string }) | undefined
    configureTrustedRendererNavigation(
      {
        setWindowOpenHandler(handler) {
          openHandler = handler
        },
        on(event, listener) {
          listeners.set(event, listener)
        },
      },
      policy,
    )

    expect(openHandler?.()).toEqual({ action: "deny" })
    for (const eventName of ["will-navigate", "will-redirect"]) {
      const preventRemote = vi.fn()
      listeners.get(eventName)?.({ preventDefault: preventRemote }, "https://example.com/")
      expect(preventRemote).toHaveBeenCalledOnce()

      const preventTrusted = vi.fn()
      listeners.get(eventName)?.({ preventDefault: preventTrusted }, "http://127.0.0.1:5173/")
      expect(preventTrusted).not.toHaveBeenCalled()
    }
  })

  it("requires the live main frame and both frame and page URLs for IPC", () => {
    const policy = createRendererTrustPolicy(
      "C:/publisher/renderer/index.html",
      "http://127.0.0.1:5173/",
    )
    const mainFrame = { url: policy.trustedUrl }
    const webContents = {
      isDestroyed: () => false,
      getURL: () => policy.trustedUrl,
      mainFrame,
    }
    const window = { isDestroyed: () => false, webContents }
    expect(
      isTrustedRendererSender({ sender: webContents, senderFrame: mainFrame }, window, policy),
    ).toBe(true)
    expect(
      isTrustedRendererSender(
        { sender: webContents, senderFrame: { url: "https://example.com/" } },
        window,
        policy,
      ),
    ).toBe(false)
    expect(
      isTrustedRendererSender(
        { sender: webContents, senderFrame: mainFrame },
        { ...window, webContents: { ...webContents, getURL: () => "https://example.com/" } },
        policy,
      ),
    ).toBe(false)
  })

  it("returns false when Electron lifecycle accessors throw during destruction", () => {
    const policy = createRendererTrustPolicy(
      "C:/publisher/renderer/index.html",
      "http://127.0.0.1:5173/",
    )
    const webContents = {
      isDestroyed: () => false,
      getURL: () => {
        throw new Error("destroyed")
      },
      mainFrame: { url: policy.trustedUrl },
    }
    expect(
      isTrustedRendererSender(
        { sender: webContents, senderFrame: webContents.mainFrame },
        { isDestroyed: () => false, webContents },
        policy,
      ),
    ).toBe(false)
  })
})
