import { createHash } from "node:crypto"
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import {
  createNote,
  discardRecovery,
  listRecoveries,
  restoreRecovery,
  saveNote,
  type NoteFileAdapter,
} from "../../src/main/services/noteFiles"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function createGarden(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-note-files-"))
  temporaryDirectories.push(root)
  await Promise.all(
    ["content", "private"].map((name) =>
      writeFile(join(root, name, ".gitkeep"), "", { flag: "w" }).catch(async () => {
        const { mkdir } = await import("node:fs/promises")
        await mkdir(join(root, name), { recursive: true })
      }),
    ),
  )
  return root
}

function hash(source: string): string {
  return createHash("sha256").update(source).digest("hex")
}

async function revision(
  path: string,
): Promise<{ expectedMtimeMs: number; expectedContentHash: string }> {
  const source = await readFile(path, "utf8")
  return { expectedMtimeMs: (await stat(path)).mtimeMs, expectedContentHash: hash(source) }
}

async function createPublicNote(root: string, slug = "first-note"): Promise<string> {
  const result = await createNote({
    workspace: root,
    visibility: "public",
    domain: "technology",
    slug,
    title: "First: note",
    date: "2026-09-19",
    description: "A safe description.",
    tags: ["test", 1],
    body: "# Body\n",
  })
  return join(root, result.path)
}

describe("note files", () => {
  it("returns an empty metadata-only list before any recovery exists", async () => {
    const root = await createGarden()
    await expect(listRecoveries(root)).resolves.toEqual([])
  })

  it("creates public and private notes with serialized frontmatter and revision", async () => {
    const root = await createGarden()
    const publicNote = await createNote({
      workspace: root,
      visibility: "public",
      domain: "technology",
      slug: "safe-note",
      title: "Title: kept literal",
      date: "2026-09-19",
      description: "A: description",
      tags: ["one", false],
      body: "Body",
    })
    const privateNote = await createNote({
      workspace: root,
      visibility: "private",
      domain: "life",
      slug: "private-note",
      title: "Private",
      date: "2026-09-19",
      description: "Private description",
      tags: ["journal"],
    })

    expect(publicNote.path).toBe("content/technology/safe-note.md")
    expect(await readFile(join(root, publicNote.path), "utf8")).toContain(
      'title: "Title: kept literal"',
    )
    expect(await readFile(join(root, publicNote.path), "utf8")).toContain("---\n\nBody")
    expect(privateNote.path).toBe("private/life/private-note.md")
    expect(publicNote.contentHash).toHaveLength(64)
  })

  it("rejects invalid creation inputs and concurrent collisions without overwriting", async () => {
    const root = await createGarden()
    const input = {
      workspace: root,
      visibility: "public" as const,
      domain: "technology" as const,
      slug: "same-note",
      title: "Title",
      date: "2026-09-19",
      description: "Description",
      tags: ["tag"],
      body: "first",
    }
    await expect(createNote({ ...input, domain: "other" as never })).rejects.toMatchObject({
      code: "NOTE_FILE_INVALID",
    })
    await expect(createNote({ ...input, slug: "Upper" })).rejects.toMatchObject({
      code: "NOTE_FILE_INVALID",
    })
    await expect(createNote({ ...input, slug: "index" })).rejects.toMatchObject({
      code: "NOTE_FILE_INVALID",
    })
    const results = await Promise.allSettled([
      createNote(input),
      createNote({ ...input, body: "second" }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "NOTE_ALREADY_EXISTS" },
    })
    expect(["first", "second"]).toContain(
      (await readFile(join(root, "content/technology/same-note.md"), "utf8")).split("\n").at(-1),
    )
  })

  it("rejects a linked destination parent", async ({ skip }) => {
    const root = await createGarden()
    const outside = await mkdtemp(join(tmpdir(), "garden-note-outside-"))
    temporaryDirectories.push(outside)
    try {
      await symlink(
        outside,
        join(root, "content", "technology"),
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }
    await expect(
      createNote({
        workspace: root,
        visibility: "public",
        domain: "technology",
        slug: "nope",
        title: "Title",
        date: "2026-09-19",
        description: "Description",
        tags: ["tag"],
      }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_UNSAFE_PATH" })
  })

  it("saves atomically after making a recovery snapshot and returns a new hash", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const result = await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "changed",
      ...(await revision(path)),
    })
    expect(await readFile(path, "utf8")).toBe("changed")
    expect(result.contentHash).toBe(hash("changed"))
    const recoveries = await listRecoveries(root)
    expect(recoveries).toHaveLength(1)
    expect(recoveries[0]).toMatchObject({
      originalPath: "content/technology/first-note.md",
      contentHash: hash(
        await readFile(
          join(root, ".garden-publisher", "recovery", recoveries[0]!.id, "content.md"),
          "utf8",
        ),
      ),
    })
  })

  it("rejects stale and same-mtime external edits without overwriting source", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await writeFile(path, "external")
    await expect(
      saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "new",
        expectedMtimeMs: 1,
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_EDIT" })
    expect(await readFile(path, "utf8")).toBe("external")

    const before = await revision(path)
    const fixed = new Date(before.expectedMtimeMs)
    await writeFile(path, "changed!")
    await utimes(path, fixed, fixed)
    await expect(
      saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "new",
        ...before,
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_EDIT" })
    expect(await readFile(path, "utf8")).toBe("changed!")
  })

  it("rejects unmanaged paths and linked files without exposing private source", async ({
    skip,
  }) => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await expect(
      saveNote({
        workspace: root,
        path: "../outside.md",
        markdown: "new",
        ...(await revision(path)),
      }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_INVALID" })
    await expect(
      saveNote({ workspace: root, path, markdown: "new", ...(await revision(path)) }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_INVALID" })
    const outside = await mkdtemp(join(tmpdir(), "garden-note-outside-"))
    temporaryDirectories.push(outside)
    try {
      await rm(path)
      await symlink(join(outside, "secret.md"), path, "file")
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }
    await expect(
      saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "new",
        expectedMtimeMs: 0,
        expectedContentHash: hash("x"),
      }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_UNSAFE_PATH" })
  })

  it("cleans temporary files and preserves original bytes when replacement fails", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const adapter: NoteFileAdapter = {
      rename: async () => {
        throw Object.assign(new Error("no rename"), { code: "EIO" })
      },
    }
    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "new",
          ...(await revision(path)),
        },
        adapter,
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })
    expect(await readFile(path, "utf8")).toContain("# Body")
    expect(
      (await readdir(join(root, "content", "technology"))).filter((name) =>
        name.includes(".garden-publisher-tmp-"),
      ).length,
    ).toBe(0)
  })

  it("cleans temporary files when the temporary write step fails", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const adapter = {
      beforeTempWrite: async () => {
        throw new Error("no write")
      },
    }
    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "new",
          ...(await revision(path)),
        },
        adapter,
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })
    expect(await readFile(path, "utf8")).toContain("# Body")
    expect(
      (await readdir(join(root, "content", "technology"))).filter((name) =>
        name.includes(".garden-publisher-tmp-"),
      ).length,
    ).toBe(0)
  })

  it("lists metadata only, restores with undo recovery, and refuses stale restoration", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const saved = await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    expect(JSON.stringify(recovery)).not.toContain("# Body")
    await writeFile(path, "external")
    await expect(restoreRecovery({ workspace: root, id: recovery!.id })).rejects.toMatchObject({
      code: "RECOVERY_CONFLICT",
    })
    const restored = await restoreRecovery({
      workspace: root,
      id: recovery!.id,
      expectedCurrentHash: hash("external"),
    })
    expect(await readFile(path, "utf8")).toContain("# Body")
    expect(restored.contentHash).not.toBe(saved.contentHash)
    expect(await listRecoveries(root)).toHaveLength(2)
  })

  it("rejects corrupt recoveries and trashes only the exact contained recovery target", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    const calls: string[] = []
    await discardRecovery({
      workspace: root,
      id: recovery!.id,
      trash: {
        trashItem: async (value) => {
          calls.push(value)
        },
      },
    })
    expect(calls).toEqual([join(root, ".garden-publisher", "recovery", recovery!.id)])
    await expect(
      discardRecovery({
        workspace: root,
        id: "../nope",
        trash: { trashItem: async () => undefined },
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_INVALID" })
  })

  it("returns stable errors for missing and tampered recovery entries", async () => {
    const root = await createGarden()
    await expect(
      restoreRecovery({ workspace: root, id: "1234567890123456" }),
    ).rejects.toMatchObject({ code: "RECOVERY_NOT_FOUND" })
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    await writeFile(
      join(root, ".garden-publisher", "recovery", recovery!.id, "manifest.json"),
      "{}",
    )
    await expect(restoreRecovery({ workspace: root, id: recovery!.id })).rejects.toMatchObject({
      code: "RECOVERY_INVALID",
    })
  })

  it("maps recovery trash adapter failures to typed errors", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    await expect(
      discardRecovery({
        workspace: root,
        id: recovery!.id,
        trash: {
          trashItem: async () => {
            throw new Error("adapter failure")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_DISCARD_FAILED" })
  })
})
