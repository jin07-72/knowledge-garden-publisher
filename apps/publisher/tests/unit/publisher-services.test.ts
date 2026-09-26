import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createPublisherCloseCoordinator,
  createPublisherQuitCoordinator,
  createPublisherServices,
  disposePublisherRuntime,
} from "../../src/main/publisherServices"
import type { PreviewStatus } from "../../src/shared/contracts"
import { git } from "../helpers/git"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function garden(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-publisher-services-"))
  temporaryDirectories.push(root)
  await mkdir(join(root, "content", "life"), { recursive: true })
  await mkdir(join(root, "private", "life"), { recursive: true })
  await writeFile(
    join(root, "content", "life", "daily.md"),
    "---\ntitle: Daily\ndate: 2026-09-24\ndescription: Daily note\ntags: [life]\n---\n\n# Daily",
  )
  await git(root, ["init", "--initial-branch=main", "--object-format=sha1"])
  await git(root, ["config", "user.name", "Garden Test"])
  await git(root, ["config", "user.email", "garden-test@example.invalid"])
  return root
}

function preview() {
  const status: PreviewStatus = { state: "stopped", generation: 0 }
  return {
    start: vi.fn(async () => status),
    stop: vi.fn(async () => status),
    getStatus: vi.fn(() => status),
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(async () => undefined),
  }
}

describe("publisher service wiring", () => {
  it("wires existing note and singleton preview capabilities to the fixed workspace", async () => {
    const workspace = await garden()
    const manager = preview()
    const services = createPublisherServices({
      workspace,
      trash: { trashItem: async () => undefined },
      isTracked: async () => false,
      preview: manager,
    })

    await expect(services.notes.read({ path: "content/life/daily.md" })).resolves.toMatchObject({
      path: "content/life/daily.md",
      markdown: expect.stringContaining("# Daily"),
    })
    await services.preview.start({ preferredPort: 43120 })
    expect(manager.start).toHaveBeenCalledWith({ workspace, preferredPort: 43120 })
    await services.preview.stop()
    expect(manager.stop).toHaveBeenCalledOnce()
    expect(services.preview.status()).toEqual({ state: "stopped", generation: 0 })
    const listener = vi.fn()
    services.preview.subscribe(listener)
    expect(manager.subscribe).toHaveBeenCalledWith(listener)
  })

  it("wires change review while keeping post-Task-10 services explicitly unavailable", async () => {
    const workspace = await garden()
    const services = createPublisherServices({
      workspace,
      trash: { trashItem: async () => undefined },
      isTracked: async () => false,
      preview: preview(),
    })
    await expect(services.changes.list()).resolves.toMatchObject({
      groups: [expect.objectContaining({ kind: "added", selection: "default" })],
    })
    await expect(services.publish.start({ changeGroupIds: ["note:a"] })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    })
    await expect(services.history.git({})).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" })
  })

  it("keeps IPC registered until preview disposal succeeds", async () => {
    const order: string[] = []
    const unregister = vi.fn(() => order.push("ipc"))
    const dispose = vi.fn(async () => {
      order.push("preview")
    })
    await disposePublisherRuntime(unregister, { dispose })
    expect(order).toEqual(["preview", "ipc"])

    const unregisterAfterFailedDispose = vi.fn()
    await expect(
      disposePublisherRuntime(unregisterAfterFailedDispose, {
        dispose: async () => {
          throw new Error("stop failed")
        },
      }),
    ).rejects.toThrow("stop failed")
    expect(unregisterAfterFailedDispose).not.toHaveBeenCalled()

    const disposeAfterUnregisterFailure = vi.fn(async () => undefined)
    await expect(
      disposePublisherRuntime(
        () => {
          throw new Error("unregister failed")
        },
        { dispose: disposeAfterUnregisterFailure },
      ),
    ).rejects.toThrow("unregister failed")
    expect(disposeAfterUnregisterFailure).toHaveBeenCalledOnce()
  })

  it("keeps quit blocked after cleanup failure and retries without concurrent cleanup", async () => {
    let resolveFirst!: () => void
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => first.then(() => Promise.reject(new Error("stop failed"))))
      .mockResolvedValueOnce(undefined)
    const allowQuit = vi.fn()
    const logFailure = vi.fn()
    const coordinator = createPublisherQuitCoordinator({
      cleanup,
      allowQuit,
      logFailure,
      retryDelay: async () => undefined,
    })
    const firstEvent = { preventDefault: vi.fn() }
    const repeatedEvent = { preventDefault: vi.fn() }
    const pending = coordinator.beforeQuit(firstEvent)
    const repeated = coordinator.beforeQuit(repeatedEvent)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce()
    resolveFirst()
    await Promise.all([pending, repeated])
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(allowQuit).toHaveBeenCalledOnce()
    expect(logFailure).not.toHaveBeenCalled()
    const allowedEvent = { preventDefault: vi.fn() }
    await coordinator.beforeQuit(allowedEvent)
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled()
  })

  it("bounds each failed quit flight, restores operability, and permits a later gesture", async () => {
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("stop failed"))
      .mockRejectedValueOnce(new Error("stop failed"))
      .mockResolvedValueOnce(undefined)
    const allowQuit = vi.fn()
    const restoreOperable = vi.fn()
    const coordinator = createPublisherQuitCoordinator({
      cleanup,
      allowQuit,
      logFailure: vi.fn(),
      maximumAttempts: 2,
      retryDelay: async () => undefined,
      restoreOperable,
    })
    const firstGesture = { preventDefault: vi.fn() }
    await coordinator.beforeQuit(firstGesture)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(allowQuit).not.toHaveBeenCalled()
    expect(restoreOperable).toHaveBeenCalledOnce()

    const secondGesture = { preventDefault: vi.fn() }
    await coordinator.beforeQuit(secondGesture)
    expect(cleanup).toHaveBeenCalledTimes(3)
    expect(allowQuit).toHaveBeenCalledOnce()
    expect(firstGesture.preventDefault).toHaveBeenCalledOnce()
    expect(secondGesture.preventDefault).toHaveBeenCalledOnce()
  })

  it("coalesces close and quit until the renderer confirms a durable save, then cleans up", async () => {
    let resolveFlush!: (saved: boolean) => void
    const pendingFlush = new Promise<boolean>((resolve) => {
      resolveFlush = resolve
    })
    const order: string[] = []
    const coordinator = createPublisherCloseCoordinator({
      requestRendererFlush: vi.fn(() => pendingFlush),
      cleanup: vi.fn(async () => {
        order.push("cleanup")
      }),
      allowClose: vi.fn(() => order.push("close")),
      allowQuit: vi.fn(() => order.push("quit")),
      reportFailure: vi.fn(),
    })
    const closeEvent = { preventDefault: vi.fn() }
    const quitEvent = { preventDefault: vi.fn() }
    const close = coordinator.beforeWindowClose(closeEvent)
    const quit = coordinator.beforeQuit(quitEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce()
    expect(order).toEqual([])
    resolveFlush(true)
    await Promise.all([close, quit])
    expect(order).toEqual(["close", "cleanup", "quit"])
  })

  it("keeps the app operable after a failed save and permits an explicit retry", async () => {
    const requestRendererFlush = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const cleanup = vi.fn(async () => undefined)
    const allowClose = vi.fn()
    const reportFailure = vi.fn()
    const coordinator = createPublisherCloseCoordinator({
      requestRendererFlush,
      cleanup,
      allowClose,
      allowQuit: vi.fn(),
      reportFailure,
    })
    await coordinator.beforeWindowClose({ preventDefault: vi.fn() })
    expect(cleanup).not.toHaveBeenCalled()
    expect(allowClose).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith("保存失败，窗口仍保持打开。")
    await coordinator.beforeWindowClose({ preventDefault: vi.fn() })
    expect(allowClose).toHaveBeenCalledOnce()
    await coordinator.beforeQuit({ preventDefault: vi.fn() })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it("fails closed when the renderer is destroyed or does not acknowledge before timeout", async () => {
    vi.useFakeTimers()
    const reportFailure = vi.fn()
    const cleanup = vi.fn()
    const allowQuit = vi.fn()
    const coordinator = createPublisherCloseCoordinator({
      requestRendererFlush: () => new Promise<boolean>(() => undefined),
      cleanup,
      allowClose: vi.fn(),
      allowQuit,
      reportFailure,
      timeoutMs: 50,
    })
    const quit = coordinator.beforeQuit({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(50)
    await quit
    expect(cleanup).not.toHaveBeenCalled()
    expect(allowQuit).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith("保存失败，窗口仍保持打开。")
    vi.useRealTimers()
  })

  it("allows the window close event emitted synchronously by an approved app quit", async () => {
    const closeEvent = { preventDefault: vi.fn() }
    let coordinator!: ReturnType<typeof createPublisherCloseCoordinator>
    coordinator = createPublisherCloseCoordinator({
      requestRendererFlush: vi.fn(async () => true),
      cleanup: vi.fn(async () => undefined),
      allowClose: vi.fn(),
      allowQuit: vi.fn(() => {
        void coordinator.beforeWindowClose(closeEvent)
      }),
      reportFailure: vi.fn(),
    })

    await coordinator.beforeQuit({ preventDefault: vi.fn() })

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
  })

  it("requires a fresh renderer flush after close preparation fails", async () => {
    const requestRendererFlush = vi.fn(async () => true)
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce(undefined)
    const allowQuit = vi.fn()
    const coordinator = createPublisherCloseCoordinator({
      requestRendererFlush,
      cleanup,
      allowClose: vi.fn(),
      allowQuit,
      reportFailure: vi.fn(),
    })

    await coordinator.beforeQuit({ preventDefault: vi.fn() })
    await coordinator.beforeQuit({ preventDefault: vi.fn() })

    expect(requestRendererFlush).toHaveBeenCalledTimes(2)
    expect(allowQuit).toHaveBeenCalledOnce()
  })

  it("re-arms the close barrier when cleanup fails after an allowed close", async () => {
    const requestRendererFlush = vi.fn(async () => true)
    const coordinator = createPublisherCloseCoordinator({
      requestRendererFlush,
      cleanup: vi.fn(async () => {
        throw new Error("cleanup failed")
      }),
      allowClose: vi.fn(),
      allowQuit: vi.fn(),
      reportFailure: vi.fn(),
    })

    const close = coordinator.beforeWindowClose({ preventDefault: vi.fn() })
    const quit = coordinator.beforeQuit({ preventDefault: vi.fn() })
    await Promise.all([close, quit])
    const retriedClose = { preventDefault: vi.fn() }
    await coordinator.beforeWindowClose(retriedClose)

    expect(retriedClose.preventDefault).toHaveBeenCalledOnce()
    expect(requestRendererFlush).toHaveBeenCalledTimes(2)
  })
})
