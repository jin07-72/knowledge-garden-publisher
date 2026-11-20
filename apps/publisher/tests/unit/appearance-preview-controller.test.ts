import { describe, expect, it, vi } from "vitest"
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

function frame(frameTreeNodeId: number, initialUrl: string) {
  let currentUrl = initialUrl
  let isDetached = false
  let currentDocument = document.implementation.createHTMLDocument()
  let nextExecution:
    | {
        readonly matches: (source: string) => boolean
        readonly execute: (run: () => unknown) => Promise<unknown>
      }
    | undefined
  const port: AppearancePreviewFramePort = {
    frameTreeNodeId,
    get url() {
      return currentUrl
    },
    get detached() {
      return isDetached
    },
    executeJavaScript: vi.fn(async (source: string) => {
      const executionDocument = currentDocument
      const executionUrl = currentUrl
      const run = () =>
        Function(
          "document",
          "location",
          `return ${source}`,
        )(executionDocument, {
          href: executionUrl,
        })
      const behavior = nextExecution
      if (behavior?.matches(source)) {
        nextExecution = undefined
        return behavior.execute(run)
      }
      return run()
    }),
  }
  return {
    port,
    get style() {
      return currentDocument.head.querySelector<HTMLStyleElement>(
        "style[data-publisher-appearance-preview]",
      )
    },
    navigate(url: string) {
      currentUrl = url
      currentDocument = document.implementation.createHTMLDocument()
    },
    detach() {
      isDetached = true
    },
    deferNextExecutionAfterMutation(wait: Promise<void>) {
      nextExecution = {
        matches: () => true,
        execute: async (run) => {
          const result = run()
          await wait
          return result
        },
      }
    },
    failNextExecution() {
      nextExecution = { matches: () => true, execute: async () => false }
    },
    deferNextFailure(wait: Promise<void>) {
      nextExecution = {
        matches: () => true,
        execute: async () => {
          await wait
          return false
        },
      }
    },
    failNextExecutionForSession(sessionId: string) {
      nextExecution = {
        matches: (source) => source.includes(`"sessionId":"${sessionId}"`),
        execute: async () => false,
      }
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
  it("binds only the frame whose URL has the exact requested session query", async () => {
    const untagged = frame(11, firstUrl)
    const taggedUrl = `${firstUrl}?appearanceSession=session-1`
    const target = frame(22, `${firstUrl}/?appearanceSession=session-1#heading`)
    const frames = [untagged.port, target.port]
    const controller = createAppearancePreviewController({ frames: () => frames })

    await expect(
      controller.install({
        url: taggedUrl,
        sessionId: "session-1",
        css: "body { color: teal; }",
      }),
    ).resolves.toBe(true)

    expect(untagged.port.executeJavaScript).not.toHaveBeenCalled()
    expect(target.port.executeJavaScript).toHaveBeenCalledOnce()
    target.navigate(secondUrl)
    await controller.didNavigate(navigation(22, secondUrl))
    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(untagged.port.executeJavaScript).not.toHaveBeenCalled()
  })

  it("reinjects into the bound frame after a finished navigation on the exact origin", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: teal; }",
    })

    target.navigate(secondUrl)
    await controller.didNavigate(navigation(22, secondUrl))

    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(target.style?.textContent).toBe("body { color: teal; }")
  })

  it("reinjects when navigation finishes while the first install result is still pending", async () => {
    const firstExecution = deferred<void>()
    const target = frame(22, firstUrl)
    target.deferNextExecutionAfterMutation(firstExecution.promise)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })

    const installing = controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: teal; }",
    })
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledOnce())
    expect(target.style?.textContent).toBe("body { color: teal; }")

    target.navigate(secondUrl)
    const navigating = controller.didNavigate(navigation(22, secondUrl))
    firstExecution.resolve()

    await expect(installing).resolves.toBe(true)
    await navigating
    expect(target.style?.textContent).toBe("body { color: teal; }")
  })

  it("keeps proven frame identity when navigation and newer CSS supersede the first install", async () => {
    const firstExecution = deferred<void>()
    const taggedUrl = `${firstUrl}?appearanceSession=session-1`
    const target = frame(22, taggedUrl)
    target.deferNextExecutionAfterMutation(firstExecution.promise)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })

    const installing = controller.install({
      url: taggedUrl,
      sessionId: "session-1",
      css: "body { color: red; }",
    })
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledOnce())
    expect(target.style?.textContent).toBe("body { color: red; }")

    target.navigate(secondUrl)
    const navigating = controller.didNavigate(navigation(22, secondUrl))
    const updating = controller.install({
      url: taggedUrl,
      sessionId: "session-1",
      css: "body { color: blue; }",
    })
    firstExecution.resolve()

    await expect(installing).resolves.toBe(false)
    await navigating
    await expect(updating).resolves.toBe(true)
    expect(target.style?.dataset.publisherAppearancePreview).toBe("session-1")
    expect(target.style?.textContent).toBe("body { color: blue; }")
  })

  it("reinjects the retained CSS when navigation outlives a failed pending replacement", async () => {
    const replacementExecution = deferred<void>()
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: teal; }",
    })
    target.navigate(secondUrl)
    target.deferNextFailure(replacementExecution.promise)

    const replacing = controller.install({
      url: secondUrl,
      sessionId: "session-2",
      css: "body { color: blue; }",
    })
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2))
    const navigating = controller.didNavigate(navigation(22, secondUrl))
    replacementExecution.resolve()

    await expect(replacing).resolves.toBe(false)
    await navigating
    expect(target.style?.dataset.publisherAppearancePreview).toBe("session-1")
    expect(target.style?.textContent).toBe("body { color: teal; }")
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
    expect(target.style).toBeNull()
  })

  it("uses the latest CSS for same-session installs and later navigation", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body { color: red; }" })

    target.navigate(secondUrl)
    await controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: blue; }",
    })
    expect(target.style?.textContent).toBe("body { color: blue; }")

    target.navigate(firstUrl)
    await controller.didNavigate(navigation(22, firstUrl))
    expect(target.style?.textContent).toBe("body { color: blue; }")
  })

  it("retains the bound session after an update fails while its frame is temporarily external", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: teal; }",
    })

    target.navigate("https://example.com/temporary")
    await expect(
      controller.install({
        url: firstUrl,
        sessionId: "session-1",
        css: "body { color: blue; }",
      }),
    ).resolves.toBe(false)
    target.navigate(secondUrl)
    await controller.didNavigate(navigation(22, secondUrl))

    expect(target.style?.textContent).toBe("body { color: teal; }")
  })

  it("does not invalidate the active session when removing a different session", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })

    await expect(controller.remove({ url: firstUrl, sessionId: "session-2" })).resolves.toBe(true)
    target.navigate(secondUrl)
    await controller.didNavigate(navigation(22, secondUrl))

    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(target.style?.dataset.publisherAppearancePreview).toBe("session-1")
  })

  it("retains the active session when a replacement fails to install", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: teal; }",
    })
    target.failNextExecution()

    await expect(
      controller.install({ url: firstUrl, sessionId: "session-2", css: "body { color: blue; }" }),
    ).resolves.toBe(false)
    target.navigate(secondUrl)
    await controller.didNavigate(navigation(22, secondUrl))

    expect(target.style?.textContent).toBe("body { color: teal; }")
    expect(target.style?.dataset.publisherAppearancePreview).toBe("session-1")
  })

  it("rolls back a stale replacement mutation when the active session is removed", async () => {
    const replacementExecution = deferred<void>()
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: teal; }",
    })
    target.deferNextExecutionAfterMutation(replacementExecution.promise)

    const replacing = controller.install({
      url: firstUrl,
      sessionId: "session-2",
      css: "body { color: blue; }",
    })
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2))
    expect(target.style?.dataset.publisherAppearancePreview).toBe("session-2")
    const removing = controller.remove({ url: firstUrl, sessionId: "session-1" })
    replacementExecution.resolve()

    await expect(replacing).resolves.toBe(false)
    await expect(removing).resolves.toBe(true)
    expect(target.style).toBeNull()
  })

  it("restores the retained binding after a stale replacement and failed successor", async () => {
    const replacementExecution = deferred<void>()
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: teal; }",
    })
    target.deferNextExecutionAfterMutation(replacementExecution.promise)

    const stale = controller.install({
      url: firstUrl,
      sessionId: "session-2",
      css: "body { color: blue; }",
    })
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2))
    target.failNextExecutionForSession("session-3")
    const successor = controller.install({
      url: firstUrl,
      sessionId: "session-3",
      css: "body { color: purple; }",
    })
    replacementExecution.resolve()

    await expect(stale).resolves.toBe(false)
    await expect(successor).resolves.toBe(false)
    expect(target.style?.dataset.publisherAppearancePreview).toBe("session-1")
    expect(target.style?.textContent).toBe("body { color: teal; }")
  })

  it("clears the previous frame after replacement binds a different exact frame", async () => {
    const previous = frame(11, firstUrl)
    const replacement = frame(22, secondUrl)
    const controller = createAppearancePreviewController({
      frames: () => [previous.port, replacement.port],
    })
    await controller.install({
      url: firstUrl,
      sessionId: "session-1",
      css: "body { color: teal; }",
    })

    await expect(
      controller.install({
        url: secondUrl,
        sessionId: "session-2",
        css: "body { color: blue; }",
      }),
    ).resolves.toBe(true)

    expect(previous.style).toBeNull()
    expect(replacement.style?.dataset.publisherAppearancePreview).toBe("session-2")
  })

  it("removes from the bound frame's current document, forgets state, and is idempotent", async () => {
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    target.navigate(secondUrl)
    await controller.didNavigate(navigation(22, secondUrl))

    await expect(controller.remove({ url: firstUrl, sessionId: "session-1" })).resolves.toBe(true)
    expect(target.style).toBeNull()
    await expect(controller.remove({ url: firstUrl, sessionId: "session-1" })).resolves.toBe(true)

    target.navigate(firstUrl)
    await controller.didNavigate(navigation(22, firstUrl))
    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(3)
  })

  it("suppresses stale queued installs after a newer install", async () => {
    const firstExecution = deferred<void>()
    const target = frame(22, firstUrl)
    target.deferNextExecutionAfterMutation(firstExecution.promise)
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
    firstExecution.resolve()

    await expect(Promise.all([older, newer])).resolves.toEqual([false, true])
    expect(target.style?.textContent).toBe("body { color: blue; }")
  })

  it("suppresses queued navigation work after remove", async () => {
    const navigationExecution = deferred<void>()
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    target.navigate(secondUrl)
    target.deferNextExecutionAfterMutation(navigationExecution.promise)

    const navigating = controller.didNavigate(navigation(22, secondUrl))
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2))
    const removing = controller.remove({ url: firstUrl, sessionId: "session-1" })
    navigationExecution.resolve()

    await navigating
    await expect(removing).resolves.toBe(true)
    expect(target.style).toBeNull()
  })

  it("clears an initial install that becomes stale while its script is in flight", async () => {
    const firstExecution = deferred<void>()
    const target = frame(22, firstUrl)
    target.deferNextExecutionAfterMutation(firstExecution.promise)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    const installing = controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledOnce())

    const removing = controller.remove({ url: firstUrl, sessionId: "session-1" })
    firstExecution.resolve()

    await expect(installing).resolves.toBe(false)
    await expect(removing).resolves.toBe(true)
    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(3)
    expect(target.style).toBeNull()
  })

  it("forgets detached or destroyed frames without throwing", async () => {
    const detached = frame(22, firstUrl)
    const frames: AppearancePreviewFramePort[] = [detached.port]
    const controller = createAppearancePreviewController({ frames: () => frames })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    detached.detach()

    await expect(controller.remove({ url: firstUrl, sessionId: "session-1" })).resolves.toBe(true)
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

    expect(target.style).toBeNull()
    expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2)
    await expect(
      controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" }),
    ).resolves.toBe(false)
    await expect(controller.didNavigate(navigation(22, firstUrl))).resolves.toBeUndefined()
  })

  it("clears an in-flight replacement as well as the previously bound session on dispose", async () => {
    const replacementExecution = deferred<void>()
    const target = frame(22, firstUrl)
    const controller = createAppearancePreviewController({ frames: () => [target.port] })
    await controller.install({ url: firstUrl, sessionId: "session-1", css: "body {}" })
    target.deferNextExecutionAfterMutation(replacementExecution.promise)
    const replacing = controller.install({
      url: firstUrl,
      sessionId: "session-2",
      css: "body { color: blue; }",
    })
    await vi.waitFor(() => expect(target.port.executeJavaScript).toHaveBeenCalledTimes(2))

    const disposing = controller.dispose()
    replacementExecution.resolve()

    await expect(replacing).resolves.toBe(false)
    await disposing
    expect(target.style).toBeNull()
  })
})
