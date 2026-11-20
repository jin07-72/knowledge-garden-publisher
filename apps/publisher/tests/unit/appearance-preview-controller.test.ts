import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createAppearancePreviewController,
  type AppearancePreviewNavigation,
} from "../../src/main/appearancePreviewController"
import type { AppearancePreviewFramePort } from "../../src/main/previewAppearance"

const firstUrl = "http://127.0.0.1:4173/notes/first"
const secondUrl = "http://127.0.0.1:4173/notes/second"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function frame(
  frameTreeNodeId: number,
  initialUrl: string,
  overrides: Partial<AppearancePreviewFramePort> = {},
) {
  let currentUrl = initialUrl
  let isDetached = false
  const port: AppearancePreviewFramePort = {
    frameTreeNodeId,
    get url() {
      return currentUrl
    },
    get detached() {
      return isDetached
    },
    executeJavaScript: vi.fn(async (source: string) =>
      Function("document", "location", `return ${source}`)(document, { href: currentUrl }),
    ),
    ...overrides,
  }
  return {
    port,
    navigate(url: string) {
      currentUrl = url
      document.head.replaceChildren()
    },
    detach() {
      isDetached = true
    },
  }
}

function navigation(
  frameTreeNodeId: number,
  url: string,
  overrides: Partial<AppearancePreviewNavigation> = {},
): AppearancePreviewNavigation {
  return { frameTreeNodeId, url, finished: true, ...overrides }
}

describe("appearance preview controller", () => {
  beforeEach(() => {
    document.head.replaceChildren()
  })

  it("binds the stable frame only after the exact requested URL installs successfully", async () => {
    const unrelated = frame(11, "http://127.0.0.1:4173/notes/unrelated")
    const target = frame(22, `${firstUrl}/?draft=1#heading`)
    const frames = [unrelated.port, target.port]
    const controller = createAppearancePreviewController({ frames: () => frames })

    await expect(
      controller.install({ url: firstUrl, sessionId: "session-1", css: "body { color: teal; }" }),
    ).resolves.toBe(true)

    expect(unrelated.port.executeJavaScript).not.toHaveBeenCalled()
    expect(target.port.executeJavaScript).toHaveBeenCalledOnce()
    frames.splice(0, frames.length, unrelated.port)
    unrelated.navigate(secondUrl)
    await controller.didNavigate(navigation(11, secondUrl))
    expect(unrelated.port.executeJavaScript).not.toHaveBeenCalled()
  })

  it("reinjects into the bound frame after a finished navigation on the exact origin", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body { color: teal; }" })

    target.navigate(secondUrl)
    await controller.didNavigate(navigation(22, secondUrl))

    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(document.head.querySelector("style")?.textContent).toBe("body { color: teal; }")
  })

  it.each([
    "http://localhost:4173/notes/second",
    "https://127.0.0.1:4173/notes/second",
    "http://example.com:4173/notes/second",
    "http://127.0.0.1:5173/notes/second",
  ])("rejects navigation outside the bound exact loopback origin: %s", async (url) => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })

    target.navigate(url)
    await controller.didNavigate(navigation(22, url))

    expect(target.port.executeJavaScript).toHaveBeenCalledOnce()
    expect(document.head.querySelector("style")).toBeNull()
  })

  it("uses the latest CSS for same-session installs and later navigation", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body { color: red; }" })

    target.navigate(secondUrl)
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body { color: blue; }" })
    expect(document.head.querySelector("style")?.textContent).toBe("body { color: blue; }")

    target.navigate(firstUrl)
    await controller.didNavigate(navigation(22, firstUrl))
    expect(document.head.querySelector("style")?.textContent).toBe("body { color: blue; }")
  })

  it("removes from the bound frame's current document, forgets state, and is idempotent", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    target.navigate(secondUrl)
    await controller.didNavigate(navigation(22, secondUrl))

    await expect(controller.remove({ url: firstUrl, sessionId: "session-1" })).resolves.toBe(true)
    expect(document.head.querySelector("style")).toBeNull()
    await expect(controller.remove({ url: firstUrl, sessionId: "session-1" })).resolves.toBe(true)

    target.navigate(firstUrl)
    await controller.didNavigate(navigation(22, firstUrl))
    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(3)
  })

  it("suppresses stale queued installs after a newer install", async () => {
    const firstExecution = deferred<unknown>()
    let calls = 0
    const target = frame(22, firstUrl, {
      executeJavaScript: vi.fn(async (source: string) => {
        calls += 1
        if (calls === 1) return firstExecution.promise
        return Function("document", "location", `return ${source}`)(document, { href: firstUrl })
      }),
    })
    const controller = createAppearancePreviewController({ frames: () => [target.port] })

    const older = controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: red; }",
    })
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledOnce())
    const newer = controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: blue; }",
    })
    firstExecution.resolve(true)

    await expect(Promise.all([older, newer])).resolves.toEqual([false, true])
    expect(document.head.querySelector("style")?.textContent).toBe("body { color: blue; }")
  })

  it("suppresses queued navigation work after remove", async () => {
    const navigationExecution = deferred<unknown>()
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    target.navigate(secondUrl)
    vi.mocked(target.port.executeJavaScript).mockImplementationOnce(() => navigationExecution.promise)

    const navigating = controller.didNavigate(navigation(22, secondUrl))
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2))
    const removing = controller.remove({ url: firstUrl, sessionId: "session-1" })
    navigationExecution.resolve(true)

    await navigating
    await expect(removing).resolves.toBe(true)
    expect(document.head.querySelector("style")).toBeNull()
  })

  it("clears an initial install that becomes stale while its script is in flight", async () => {
    const firstExecution = deferred<unknown>()
    let firstSource = ""
    const target = frame(22, firstUrl, {
      executeJavaScript: vi.fn(async (source: string) => {
        if (!firstSource) {
          firstSource = source
          return firstExecution.promise
        }
        return Function("document", "location", `return ${source}`)(document, { href: firstUrl })
      }),
    })
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    const installing = controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledOnce())

    const removing = controller.remove({ url: firstUrl, sessionId: "session-1" })
    firstExecution.resolve(
      Function("document", "location", `return ${firstSource}`)(document, { href: firstUrl }),
    )

    await expect(installing).resolves.toBe(false)
    await expect(removing).resolves.toBe(true)
    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(document.head.querySelector("style")).toBeNull()
  })

  it("forgets detached or destroyed frames without throwing", async () => {
    const detached = frame(22, firstUrl)
    const frames: AppearancePreviewFramePort[] = [detached.port]
    const controller = createAppearancePreviewController({ frames: () => frames })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    detached.detach()

    await expect(controller.remove({ url: firstUrl, sessionId: "session-1" })).resolves.toBe(false)
    await expect(controller.remove({ url: firstUrl, sessionId: "session-1" })).resolves.toBe(true)

    const destroyed = {
      frameTreeNodeId: 33,
      detached: false,
      get url(): string {
        throw new Error("render frame disposed")
      },
      executeJavaScript: vi.fn(async () => true),
    }
    frames.splice(0, frames.length, destroyed)
    await expect(
      controller.install({ url: firstUrl, sessionId: "session-2", css: "body {}" }),
    ).resolves.toBe(false)
    await expect(controller.didNavigate(navigation(33, firstUrl))).resolves.toBeUndefined()
    expect(destroyed.executeJavaScript).not.toHaveBeenCalled()
  })

  it("disposes once, clears the active document, and rejects later work", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })

    await controller.dispose()
    await controller.dispose()

    expect(document.head.querySelector("style")).toBeNull()
    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2)
    await expect(
      controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" }),
    ).resolves.toBe(false)
    await expect(controller.didNavigate(navigation(22, firstUrl))).resolves.toBeUndefined()
  })

  it("clears an in-flight replacement as well as the previously bound session on dispose", async () => {
    const replacementExecution = deferred<unknown>()
    let replacementSource = ""
    const executeJavaScript = vi.fn(async (source: string) => {
      if (executeJavaScript.mock.calls.length === 2) {
        replacementSource = source
        return replacementExecution.promise
      }
      return Function("document", "location", `return ${source}`)(document, { href: firstUrl })
    })
    const target = frame(22, firstUrl, { executeJavaScript })
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    const replacing = controller.install({
      url: firstUrl,
      sessionId: "session-2",
      css: "body { color: blue; }",
    })
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalledTimes(2))

    const disposing = controller.dispose()
    replacementExecution.resolve(
      Function("document", "location", `return ${replacementSource}`)(document, { href: firstUrl }),
    )

    await expect(replacing).resolves.toBe(false)
    await disposing
    expect(document.head.querySelector("style")).toBeNull()
  })
})
