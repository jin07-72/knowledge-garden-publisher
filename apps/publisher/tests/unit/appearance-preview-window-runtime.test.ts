import { describe, expect, it, vi } from "vitest"
import {
  createAppearancePreviewWindowRuntimeManager,
  forwardAppearancePreviewNavigation,
  type AppearancePreviewNavigationFramePort,
} from "../../src/main/appearancePreviewWindowRuntime"
import type { AppearancePreviewController } from "../../src/main/appearancePreviewController"
import type {
  AppearanceFrameClearRequest,
  AppearanceFramePreviewRequest,
} from "../../src/main/previewAppearance"

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function controller(
  dispose: AppearancePreviewController["dispose"] = vi.fn(async () => undefined),
): AppearancePreviewController {
  return {
    install: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    didNavigate: vi.fn(async () => undefined),
    dispose,
  }
}

const previewRequest: AppearanceFramePreviewRequest = {
  url: "http://127.0.0.1:4173/notes/first?kgpAppearance=session-1",
  sessionId: "session-1",
  css: ":root { --publisher-accent: #123456; }",
}

const clearRequest: AppearanceFrameClearRequest = {
  url: previewRequest.url,
  sessionId: previewRequest.sessionId,
}

describe("appearance preview window runtime manager", () => {
  it("creates one controller and listener registration per window and disposes the replaced runtime once", async () => {
    const firstController = controller()
    const secondController = controller()
    const createController = vi
      .fn()
      .mockReturnValueOnce(firstController)
      .mockReturnValueOnce(secondController)
    const firstRemoveListeners = vi.fn()
    const secondRemoveListeners = vi.fn()
    const installNavigation = vi
      .fn()
      .mockReturnValueOnce(firstRemoveListeners)
      .mockReturnValueOnce(secondRemoveListeners)
    const manager = createAppearancePreviewWindowRuntimeManager({
      createController,
      installNavigation,
      isWindowUsable: () => true,
    })
    const firstWindow = { id: "first" }
    const secondWindow = { id: "second" }

    manager.activate(firstWindow)
    manager.activate(secondWindow)
    await vi.waitFor(() => expect(firstController.dispose).toHaveBeenCalledOnce())

    expect(createController).toHaveBeenNthCalledWith(1, firstWindow)
    expect(createController).toHaveBeenNthCalledWith(2, secondWindow)
    expect(installNavigation).toHaveBeenNthCalledWith(1, firstWindow, firstController)
    expect(installNavigation).toHaveBeenNthCalledWith(2, secondWindow, secondController)
    expect(firstRemoveListeners).toHaveBeenCalledOnce()
    expect(secondRemoveListeners).not.toHaveBeenCalled()
    await expect(manager.install(previewRequest)).resolves.toBe(true)
    expect(firstController.install).not.toHaveBeenCalled()
    expect(secondController.install).toHaveBeenCalledWith(previewRequest)
  })

  it("does not let late cleanup from an old window clear or dispose the new holder", async () => {
    const oldDisposal = deferred()
    const oldController = controller(vi.fn(() => oldDisposal.promise))
    const newController = controller()
    const manager = createAppearancePreviewWindowRuntimeManager({
      createController: vi
        .fn()
        .mockReturnValueOnce(oldController)
        .mockReturnValueOnce(newController),
      installNavigation: vi.fn(() => vi.fn()),
      isWindowUsable: () => true,
    })
    const oldRuntime = manager.activate({ id: "old" })
    manager.activate({ id: "new" })

    const lateCleanup = manager.dispose(oldRuntime)
    await expect(manager.install(previewRequest)).resolves.toBe(true)
    expect(newController.dispose).not.toHaveBeenCalled()
    oldDisposal.resolve()
    await lateCleanup
    await expect(manager.remove(clearRequest)).resolves.toBe(true)
    expect(newController.remove).toHaveBeenCalledWith(clearRequest)
    expect(newController.dispose).not.toHaveBeenCalled()
    expect(oldController.dispose).toHaveBeenCalledOnce()
  })

  it("retains the current holder until irreversible disposal explicitly clears it", async () => {
    const activeController = controller()
    const manager = createAppearancePreviewWindowRuntimeManager({
      createController: vi.fn(() => activeController),
      installNavigation: vi.fn(() => vi.fn()),
      isWindowUsable: () => true,
    })
    manager.activate({ id: "active" })

    await expect(manager.install(previewRequest)).resolves.toBe(true)
    expect(activeController.dispose).not.toHaveBeenCalled()

    await manager.disposeCurrent()
    await expect(manager.install(previewRequest)).resolves.toBe(false)
    await expect(manager.remove(clearRequest)).resolves.toBe(true)
    expect(activeController.dispose).toHaveBeenCalledOnce()
  })

  it("fails safely when no usable window holder exists", async () => {
    const activeController = controller()
    const manager = createAppearancePreviewWindowRuntimeManager({
      createController: vi.fn(() => activeController),
      installNavigation: vi.fn(() => vi.fn()),
      isWindowUsable: () => false,
    })

    await expect(manager.install(previewRequest)).resolves.toBe(false)
    await expect(manager.remove(clearRequest)).resolves.toBe(true)
    manager.activate({ id: "destroyed" })
    await expect(manager.install(previewRequest)).resolves.toBe(false)
    expect(activeController.install).not.toHaveBeenCalled()
  })
})

describe("appearance preview navigation forwarding", () => {
  it("passes only a primitive frame snapshot to the controller", async () => {
    const previewController = controller()
    const frame: AppearancePreviewNavigationFramePort = {
      detached: false,
      frameTreeNodeId: 42,
      url: "http://127.0.0.1:4173/notes/second",
    }

    await forwardAppearancePreviewNavigation({
      findFrame: () => frame,
      controller: previewController,
    })

    expect(previewController.didNavigate).toHaveBeenCalledWith({
      frameTreeNodeId: 42,
      url: "http://127.0.0.1:4173/notes/second",
      finished: true,
    })
  })

  it.each(["lookup", "detached", "frameTreeNodeId", "url"] as const)(
    "swallows a synchronous %s property failure before it reaches the controller",
    async (failure) => {
      const previewController = controller()
      const frame = {
        get detached() {
          if (failure === "detached") throw new Error("detached frame")
          return false
        },
        get frameTreeNodeId() {
          if (failure === "frameTreeNodeId") throw new Error("detached frame")
          return 42
        },
        get url() {
          if (failure === "url") throw new Error("detached frame")
          return "http://127.0.0.1:4173/notes/second"
        },
      }

      await expect(
        forwardAppearancePreviewNavigation({
          findFrame: () => {
            if (failure === "lookup") throw new Error("frame lookup failed")
            return frame
          },
          controller: previewController,
        }),
      ).resolves.toBeUndefined()
      expect(previewController.didNavigate).not.toHaveBeenCalled()
    },
  )

  it("reports asynchronous controller failures without rejecting the event adapter", async () => {
    const failure = new Error("navigation failed")
    const previewController = controller()
    vi.mocked(previewController.didNavigate).mockRejectedValueOnce(failure)
    const onError = vi.fn()

    await expect(
      forwardAppearancePreviewNavigation({
        findFrame: () => ({
          detached: false,
          frameTreeNodeId: 42,
          url: "http://127.0.0.1:4173/notes/second",
        }),
        controller: previewController,
        onError,
      }),
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(failure)
  })
})
