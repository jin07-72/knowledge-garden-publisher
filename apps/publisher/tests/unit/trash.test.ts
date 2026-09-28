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
    })
    expect(trashItem).toHaveBeenCalledTimes(2)
    expect(trashItem.mock.calls.some(([path]) => path.includes("content\\_assets\\.garden-trash-"))).toBe(
      true,
    )
    await expect(readFile(join(recycle, "item-2", "chart.png"), "utf8")).resolves.toBe("chart")
  })

  it("adapts only the injected Electron shell trash capability", async () => {
    const shellTrash = vi.fn(async (_path: string) => undefined)
    const adapter = createElectronTrashAdapter({ trashItem: shellTrash })
    await adapter.trashItem("C:\\garden\\content\\life\\daily.md")
    expect(shellTrash).toHaveBeenCalledWith("C:\\garden\\content\\life\\daily.md")
    expect(Object.keys(adapter)).toEqual(["trashItem"])
  })
})
