import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
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
    expect(trashItem).toHaveBeenCalledWith(expect.stringContaining(".garden-trash-"))
    expect(trashItem).not.toHaveBeenCalledWith(note)
    expect(isTracked).toHaveBeenCalledWith(root, "content/life/daily.md")
  })

  it("treats a moved-then-rejected Recycle Bin operation as committed", async () => {
    const { root } = await garden()
    const recycled = join(root, "recycled.md")
    await expect(
      trashNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: {
          trashItem: async (staged) => {
            await rename(staged, recycled)
            throw new Error("late shell rejection")
          },
        },
        isTracked: async () => false,
      }),
    ).resolves.toMatchObject({ path: "content/life/daily.md", historyWarning: false })
  })

  it("never trashes a recreated original pathname", async () => {
    const { root, note } = await garden()
    const recycled = join(root, "recycled.md")
    await expect(
      trashNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: {
          trashItem: async (staged) => {
            await writeFile(note, "replacement")
            await rename(staged, recycled)
          },
        },
        isTracked: async () => false,
      }),
    ).resolves.toMatchObject({ path: "content/life/daily.md" })
    await expect(readFile(note, "utf8")).resolves.toBe("replacement")
  })

  it("fails uncertain when the Recycle Bin adapter replaces the managed parent", async () => {
    const { root, note } = await garden()
    const domain = join(root, "content", "life")
    const oldDomain = join(root, "content", "life-old")
    await expect(
      trashNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: {
          trashItem: async () => {
            await rename(domain, oldDomain)
            await mkdir(domain)
            await writeFile(note, "attacker replacement")
          },
        },
        isTracked: async () => false,
      }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_COMMIT_UNCERTAIN" })
    await expect(readFile(note, "utf8")).resolves.toBe("attacker replacement")
  })

  it("restores the original note when the Recycle Bin adapter resolves without moving it", async () => {
    const { root, note, markdown } = await garden()
    await expect(
      trashNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: { trashItem: async () => undefined },
        isTracked: async () => false,
      }),
    ).rejects.toMatchObject({
      code: "NOTE_FILE_WRITE_FAILED",
      message: "The note was not moved to the Recycle Bin and was safely restored.",
    })
    await expect(readFile(note, "utf8")).resolves.toBe(markdown)
    await expect(readdir(join(root, "content", "life"))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringContaining(".garden-trash-")]),
    )
  })

  it("fails uncertain without trashing when the staged final component is swapped", async () => {
    const { root } = await garden()
    const trashItem = vi.fn(async () => undefined)
    await expect(
      trashNote(
        {
          workspace: root,
          path: "content/life/daily.md",
          trash: { trashItem },
          isTracked: async () => false,
        },
        {
          afterStage: async (staged) => {
            await rename(staged, `${staged}.original`)
            await writeFile(staged, "attacker replacement")
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "NOTE_FILE_COMMIT_UNCERTAIN",
      message: expect.stringContaining("Do not retry"),
    })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it("fails uncertain without trashing when the managed parent is swapped", async () => {
    const { root, note } = await garden()
    const domain = join(root, "content", "life")
    const oldDomain = join(root, "content", "life-old")
    const trashItem = vi.fn(async () => undefined)
    await expect(
      trashNote(
        {
          workspace: root,
          path: "content/life/daily.md",
          trash: { trashItem },
          isTracked: async () => false,
        },
        {
          afterStage: async () => {
            await rename(domain, oldDomain)
            await mkdir(domain)
            await writeFile(note, "attacker replacement")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_COMMIT_UNCERTAIN" })
    expect(trashItem).not.toHaveBeenCalled()
    await expect(readFile(note, "utf8")).resolves.toBe("attacker replacement")
  })

  it("restores the exact staged note after a definite Recycle Bin rejection", async () => {
    const { root, note, markdown } = await garden()
    await expect(
      trashNote({
        workspace: root,
        path: "content/life/daily.md",
        trash: { trashItem: async () => Promise.reject(new Error("Recycle Bin unavailable")) },
        isTracked: async () => false,
      }),
    ).rejects.toMatchObject({
      code: "NOTE_FILE_WRITE_FAILED",
      message: "The note was not moved to the Recycle Bin and was safely restored.",
    })
    await expect(readFile(note, "utf8")).resolves.toBe(markdown)
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
