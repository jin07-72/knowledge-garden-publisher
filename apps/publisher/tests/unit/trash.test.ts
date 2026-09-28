import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createElectronTrashAdapter, trashManagedNote } from "../../src/main/services/trash"
import { internalRecoveryKey } from "../../src/main/services/noteFiles"
import { reconcileTrashRecovery } from "../../src/main/services/trashRecovery"

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
    expect(trashItem.mock.calls[0]![0]).toMatch(/[\\/]content[\\/]life[\\/]daily\.md$/)
    expect(trashItem.mock.calls[1]![0]).toMatch(/[\\/]content[\\/]_assets[\\/]daily$/)
    expect(trashItem.mock.calls[0]![0]).not.toBe(join(root, "content", "life", "daily.md"))
    expect(trashItem.mock.calls[1]![0]).not.toBe(join(root, "content", "_assets", "daily"))
    await expect(readFile(join(recycle, "item-2", "chart.png"), "utf8")).resolves.toBe("chart")
    await rename(join(recycle, "item-1"), trashItem.mock.calls[0]![0])
    await rename(join(recycle, "item-2"), trashItem.mock.calls[1]![0])
    await expect(
      reconcileTrashRecovery(root, () => internalRecoveryKey(root, false)),
    ).resolves.toEqual({
      restored: expect.arrayContaining(["content/life/daily.md", "content/_assets/daily"]),
      conflicts: [],
    })
    await expect(readFile(join(root, "content", "life", "daily.md"), "utf8")).resolves.toBe(
      "# Daily",
    )
    await expect(
      readFile(join(root, "content", "_assets", "daily", "chart.png"), "utf8"),
    ).resolves.toBe("chart")
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
    await expect(
      readFile(join(root, "content", "_assets", "daily", "chart.png"), "utf8"),
    ).resolves.toBe("chart")
  })

  it("does not report ambiguous attachment retention when no attachment directory exists", async () => {
    const root = await garden()
    await rm(join(root, "content", "_assets", "daily"), { recursive: true })
    await mkdir(join(root, "content", "reading"), { recursive: true })
    await writeFile(join(root, "content", "reading", "daily.md"), "# Other daily")
    const trashItem = vi.fn(async (target: string) =>
      rename(target, join(root, "recycled-note.md")),
    )

    await expect(
      trashManagedNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: { trashItem },
        isTracked: async () => false,
      }),
    ).resolves.toMatchObject({ attachmentCleanup: { status: "not-found" } })
    expect(trashItem).toHaveBeenCalledOnce()
  })

  it("keeps an attachment replacement created inside trashItem and stages the recoverable original", async () => {
    const root = await garden()
    const note = join(root, "content", "life", "daily.md")
    const attachments = join(root, "content", "_assets", "daily")
    const recycle = await mkdtemp(join(tmpdir(), "garden-adversarial-recycle-"))
    temporaryDirectories.push(recycle)
    let call = 0
    const trashItem = vi.fn(async (staged: string) => {
      call += 1
      if (call === 2) {
        await mkdir(attachments)
        await writeFile(join(attachments, "replacement.png"), "replacement attachment")
      }
      await rename(staged, join(recycle, `original-${call}`))
    })

    await expect(
      trashManagedNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: { trashItem },
        isTracked: async () => false,
      }),
    ).resolves.toMatchObject({ attachmentCleanup: { status: "trashed" } })
    await expect(readFile(note, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(attachments, "replacement.png"), "utf8")).resolves.toBe(
      "replacement attachment",
    )
    await expect(readFile(join(recycle, "original-1"), "utf8")).resolves.toBe("# Daily")
    await expect(readFile(join(recycle, "original-2", "chart.png"), "utf8")).resolves.toBe("chart")
  })

  it("refuses to restore an attachment tree whose signed contents were modified", async () => {
    const root = await garden()
    const recycle = await mkdtemp(join(tmpdir(), "garden-modified-attachment-recycle-"))
    temporaryDirectories.push(recycle)
    const staged: string[] = []
    await trashManagedNote({
      workspace: root,
      path: "content/life/daily.md",
      trash: {
        trashItem: async (target) => {
          staged.push(target)
          await rename(target, join(recycle, `item-${staged.length}`))
        },
      },
      isTracked: async () => false,
    })
    await rename(join(recycle, "item-2"), staged[1]!)
    await writeFile(join(staged[1]!, "chart.png"), "modified")

    await expect(
      reconcileTrashRecovery(root, () => internalRecoveryKey(root, false)),
    ).resolves.toEqual({ restored: [], conflicts: ["content/_assets/daily"] })
  })

  it("refuses to restore an attachment tree containing a symlink", async ({ skip }) => {
    const root = await garden()
    const recycle = await mkdtemp(join(tmpdir(), "garden-linked-attachment-recycle-"))
    temporaryDirectories.push(recycle)
    const outside = join(root, "outside.png")
    await writeFile(outside, "outside")
    const staged: string[] = []
    await trashManagedNote({
      workspace: root,
      path: "content/life/daily.md",
      trash: {
        trashItem: async (target) => {
          staged.push(target)
          await rename(target, join(recycle, `item-${staged.length}`))
        },
      },
      isTracked: async () => false,
    })
    await rename(join(recycle, "item-2"), staged[1]!)
    await rm(join(staged[1]!, "chart.png"))
    try {
      await symlink(outside, join(staged[1]!, "chart.png"), "file")
    } catch {
      skip()
      return
    }

    await expect(
      reconcileTrashRecovery(root, () => internalRecoveryKey(root, false)),
    ).resolves.toEqual({ restored: [], conflicts: ["content/_assets/daily"] })
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
    expect(trashItem.mock.calls[1]![0]).toMatch(/[\\/]content[\\/]_assets[\\/]daily$/)
    await expect(
      readFile(join(root, "content", "_assets", "daily", "chart.png"), "utf8"),
    ).resolves.toBe("chart")
  })

  it("adapts only the injected Electron shell trash capability", async () => {
    const shellTrash = vi.fn(async (_path: string) => undefined)
    const adapter = createElectronTrashAdapter({ trashItem: shellTrash })
    await adapter.trashItem("C:\\garden\\content\\life\\daily.md")
    expect(shellTrash).toHaveBeenCalledWith("C:\\garden\\content\\life\\daily.md")
    expect(Object.keys(adapter)).toEqual(["trashItem"])
  })
})
