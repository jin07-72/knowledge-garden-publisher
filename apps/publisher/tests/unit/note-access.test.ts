import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readNote, trashNote } from "../../src/main/services/noteFiles"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function garden(): Promise<{ root: string; note: string; markdown: string }> {
  const root = await mkdtemp(join(tmpdir(), "garden-note-access-"))
  temporaryDirectories.push(root)
  const note = join(root, "content", "life", "daily.md")
  const markdown =
    "---\ntitle: Daily\ndate: 2026-09-24\ndescription: Daily note\ntags: [life]\n---\n\n# Daily"
  await mkdir(join(root, "content", "life"), { recursive: true })
  await mkdir(join(root, "private", "life"), { recursive: true })
  await writeFile(note, markdown)
  return { root, note, markdown }
}

describe("note access", () => {
  it("reads exact Markdown with a revision through the managed file boundary", async () => {
    const { root, markdown } = await garden()
    const result = await readNote({ workspace: root, path: "content/life/daily.md" })
    expect(result).toEqual({
      path: "content/life/daily.md",
      markdown,
      mtimeMs: expect.any(Number),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it("rejects symlinks while reading", async ({ skip }) => {
    const { root, note } = await garden()
    const outside = join(root, "outside.md")
    await writeFile(outside, "outside")
    const linked = join(root, "content", "life", "linked.md")
    try {
      await symlink(outside, linked, "file")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }
    await expect(
      readNote({ workspace: root, path: "content/life/linked.md" }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_UNSAFE_PATH" })
    expect(note).toBeTruthy()
  })

  it("rejects observable file-identity swaps while reading", async () => {
    const { root, note } = await garden()
    await expect(
      readNote(
        { workspace: root, path: "content/life/daily.md" },
        {
          afterRead: async () => {
            await rename(note, `${note}.old`)
            await writeFile(note, "replacement")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_ACCESS_FAILED" })
  })

  it("trashes only one verified note and reports a tracked public deletion", async () => {
    const { root, note } = await garden()
    const recycled = join(root, "recycled.md")
    const trashItem = vi.fn(async (path: string) => rename(path, recycled))
    const isTracked = vi.fn(async () => true)
    await expect(
      trashNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: { trashItem },
        isTracked,
      }),
    ).resolves.toEqual({
      path: "content/life/daily.md",
      pendingPublicDeletion: "content/life/daily.md",
      historyWarning: true,
    })
    expect(trashItem).toHaveBeenCalledOnce()
    expect(trashItem).toHaveBeenCalledWith(note)
    expect(isTracked).toHaveBeenCalledWith(root, "content/life/daily.md")
  })

  it("rejects linked, directory, attachment, and traversal trash targets", async () => {
    const { root } = await garden()
    const trashItem = vi.fn(async () => undefined)
    for (const path of [
      "content/life",
      "content/_assets/daily/chart.png",
      "../content/life/daily.md",
    ]) {
      await expect(
        trashNote({ workspace: root, path, trash: { trashItem }, isTracked: async () => false }),
      ).rejects.toMatchObject({ code: "NOTE_FILE_INVALID" })
    }
    expect(trashItem).not.toHaveBeenCalled()
  })
})
