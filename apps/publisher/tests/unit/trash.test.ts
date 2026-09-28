import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createElectronTrashAdapter,
  trashManagedNote,
} from "../../src/main/services/trash"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function garden(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-trash-"))
  temporaryDirectories.push(root)
  await mkdir(join(root, "content", "life"), { recursive: true })
  await mkdir(join(root, "private", "life"), { recursive: true })
  await mkdir(join(root, "content", "_assets", "daily"), { recursive: true })
  await writeFile(join(root, "content", "life", "daily.md"), "# Daily")
  await writeFile(join(root, "content", "_assets", "daily", "chart.png"), "chart")
  return root
}

describe("safe note trash", () => {
  it("rejects paths outside managed note roots before calling the Recycle Bin", async () => {
    const root = await garden()
    const trashItem = vi.fn(async () => undefined)

    await expect(
      trashManagedNote({
        workspace: root,
        path: "../outside.md",
        trash: { trashItem },
        isTracked: async () => false,
      }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_INVALID" })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it("moves the verified note and its owned attachment directory to the Recycle Bin", async () => {
    const root = await garden()
    const recycle = await mkdtemp(join(tmpdir(), "garden-recycle-"))
    temporaryDirectories.push(recycle)
    let sequence = 0
    const trashItem = vi.fn(async (target: string) => {
      sequence += 1
      await rename(target, join(recycle, `item-${sequence}`))
    })

    await expect(
      trashManagedNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: { trashItem },
        isTracked: async () => true,
      }),
    ).resolves.toEqual({
      path: "content/life/daily.md",
      pendingPublicDeletion: "content/life/daily.md",
      historyWarning: true,
      attachmentCleanup: { status: "trashed" },
    })
    expect(trashItem).toHaveBeenCalledTimes(2)
    expect(trashItem).toHaveBeenNthCalledWith(1, join(root, "content", "life", "daily.md"))
    expect(trashItem).toHaveBeenNthCalledWith(2, join(root, "content", "_assets", "daily"))
    await expect(readFile(join(recycle, "item-2", "chart.png"), "utf8")).resolves.toBe("chart")
  })

  it("retains ambiguous same-slug attachments shared by notes in different domains", async () => {
    const root = await garden()
    await mkdir(join(root, "content", "reading"), { recursive: true })
    await writeFile(join(root, "content", "reading", "daily.md"), "# Other daily")
    const recycled = join(root, "recycled-note.md")
    const trashItem = vi.fn(async (target: string) => rename(target, recycled))

    await expect(
      trashManagedNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: { trashItem },
        isTracked: async () => true,
      }),
    ).resolves.toEqual({
      path: "content/life/daily.md",
      pendingPublicDeletion: "content/life/daily.md",
      historyWarning: true,
      attachmentCleanup: {
        status: "retained-ambiguous",
        message: expect.stringContaining("slug"),
      },
    })
    expect(trashItem).toHaveBeenCalledOnce()
    await expect(readFile(join(root, "content", "_assets", "daily", "chart.png"), "utf8")).resolves.toBe("chart")
  })

  it("returns note success and an attachment warning when the second recycle call fails", async () => {
    const root = await garden()
    const recycled = join(root, "recycled-note.md")
    const trashItem = vi.fn(async (target: string) => {
      if (target.endsWith("daily.md")) await rename(target, recycled)
      else throw new Error("Recycle Bin unavailable")
    })

    await expect(
      trashManagedNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: { trashItem },
        isTracked: async () => true,
      }),
    ).resolves.toEqual({
      path: "content/life/daily.md",
      pendingPublicDeletion: "content/life/daily.md",
      historyWarning: true,
      attachmentCleanup: {
        status: "failed",
        message: expect.stringContaining("attachments remain"),
      },
    })
    expect(trashItem).toHaveBeenNthCalledWith(2, join(root, "content", "_assets", "daily"))
    await expect(readFile(join(root, "content", "_assets", "daily", "chart.png"), "utf8")).resolves.toBe("chart")
  })

  it("adapts only the injected Electron shell trash capability", async () => {
    const shellTrash = vi.fn(async (_path: string) => undefined)
    const adapter = createElectronTrashAdapter({ trashItem: shellTrash })
    await adapter.trashItem("C:\\garden\\content\\life\\daily.md")
    expect(shellTrash).toHaveBeenCalledWith("C:\\garden\\content\\life\\daily.md")
    expect(Object.keys(adapter)).toEqual(["trashItem"])
  })
})
