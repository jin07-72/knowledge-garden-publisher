import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPublisherServices, disposePublisherRuntime } from "../../src/main/publisherServices"
import type { PreviewStatus } from "../../src/shared/contracts"

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

  it("keeps post-Task-7 services explicitly unavailable", async () => {
    const workspace = await garden()
    const services = createPublisherServices({
      workspace,
      trash: { trashItem: async () => undefined },
      isTracked: async () => false,
      preview: preview(),
    })
    await expect(services.changes.list()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" })
    await expect(services.publish.start({ changeGroupIds: ["note:a"] })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    })
    await expect(services.history.git({})).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" })
  })

  it("unregisters IPC before awaiting preview disposal and absorbs no failures", async () => {
    const order: string[] = []
    const unregister = vi.fn(() => order.push("ipc"))
    const dispose = vi.fn(async () => {
      order.push("preview")
    })
    await disposePublisherRuntime(unregister, { dispose })
    expect(order).toEqual(["ipc", "preview"])

    await expect(
      disposePublisherRuntime(() => undefined, {
        dispose: async () => {
          throw new Error("stop failed")
        },
      }),
    ).rejects.toThrow("stop failed")

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
})
