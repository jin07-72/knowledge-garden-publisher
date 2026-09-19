import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as fsRename,
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

function unkeyedManifestTag(manifest: Record<string, unknown>): string {
  return hash(
    JSON.stringify({
      version: manifest.version,
      id: manifest.id,
      originalPath: manifest.originalPath,
      createdAt: manifest.createdAt,
      contentHash: manifest.contentHash,
      mtimeMs: manifest.mtimeMs,
      sourceFile: manifest.sourceFile,
      integrityFile: manifest.integrityFile,
    }),
  )
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
    expect(await readFile(join(root, publicNote.path), "utf8")).toBe(
      [
        "---",
        'title: "Title: kept literal"',
        "date: 2026-09-19",
        'description: "A: description"',
        "tags:",
        "  - one",
        "  - false",
        "---",
        "",
        "Body",
      ].join("\n"),
    )
    expect(privateNote.path).toBe("private/life/private-note.md")
    expect(await readFile(join(root, privateNote.path), "utf8")).toBe(
      [
        "---",
        "title: Private",
        "date: 2026-09-19",
        "description: Private description",
        "tags:",
        "  - journal",
        "---",
        "",
        "",
      ].join("\n"),
    )
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
    await expect(createNote({ ...input, tags: [] })).rejects.toMatchObject({
      code: "NOTE_FILE_INVALID",
    })
    await expect(createNote({ ...input, visibility: "secret" as never })).rejects.toMatchObject({
      code: "NOTE_FILE_INVALID",
    })
    expect(await readdir(join(root, "private"))).toEqual([])
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

  it.runIf(process.platform === "win32")(
    "rejects a recovery-root directory junction escape",
    async () => {
      const root = await createGarden()
      const path = await createPublicNote(root)
      await saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "saved",
        ...(await revision(path)),
      })
      const recovery = join(root, ".garden-publisher", "recovery")
      const original = join(root, ".garden-publisher", "recovery-original")
      const outside = await mkdtemp(join(tmpdir(), "garden-recovery-outside-"))
      temporaryDirectories.push(outside)
      await fsRename(recovery, original)
      await symlink(outside, recovery, "junction")
      await expect(listRecoveries(root)).rejects.toMatchObject({ code: "NOTE_FILE_UNSAFE_PATH" })
    },
  )

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

  it("creates recovery before the replacement hook and rejects a save race without overwriting", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "new buffer",
          ...(await revision(path)),
        },
        {
          beforeReplace: async () => {
            expect(await listRecoveries(root)).toHaveLength(1)
            await writeFile(path, "external edit")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_EDIT" })
    expect(await readFile(path, "utf8")).toBe("external edit")
    expect(await listRecoveries(root)).toHaveLength(1)
  })

  it("serializes same-revision writers so exactly one reported winner installs bytes", async () => {
    for (let run = 0; run < 3; run += 1) {
      const root = await createGarden()
      const path = await createPublicNote(root)
      let entered!: () => void
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: () => void
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve
      })
      const first = saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "writer one",
          ...(await revision(path)),
        },
        {
          beforeReplace: async () => {
            entered()
            await releasePromise
          },
        },
      )
      await enteredPromise
      const second = saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "writer two",
        ...(await revision(path)),
      })
      await expect(second).rejects.toMatchObject({ code: "NOTE_FILE_LOCKED" })
      release()
      const winner = await first
      expect(await readFile(path, "utf8")).toBe("writer one")
      expect(winner.contentHash).toBe(hash("writer one"))
    }
  })

  it("keeps the live target present and restrictive temp mode before commit", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    let inspected = false
    await saveNote(
      {
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "new",
        ...(await revision(path)),
      },
      {
        beforeCommit: async (temp) => {
          inspected = true
          expect(await readFile(path, "utf8")).toContain("# Body")
          if (process.platform !== "win32") expect((await stat(temp)).mode & 0o777).toBe(0o600)
        },
      },
    )
    expect(inspected).toBe(true)
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

  it("rejects a same-size rewrite with restored millisecond mtime", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const source = await readFile(path, "utf8")
    const fixed = new Date(Math.floor((await stat(path)).mtimeMs))
    await utimes(path, fixed, fixed)
    const before = await revision(path)
    await writeFile(path, source.replace("# Body", "# Evil"))
    await utimes(path, fixed, fixed)
    await expect(
      saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "new",
        ...before,
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_EDIT" })
  })

  it("rejects traversal and absolute unmanaged paths without a privileged symlink", async () => {
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
  })

  it("rejects a direct linked file without reading through it", async ({ skip }) => {
    const root = await createGarden()
    const path = await createPublicNote(root)
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

  it("cleans temporary files when flush fails", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "new",
          ...(await revision(path)),
        },
        {
          beforeTempSync: async () => {
            throw new Error("no flush")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })
    expect(await readFile(path, "utf8")).toContain("# Body")
  })

  it("treats a rename that mutates then throws as a completed atomic save", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const adapter: NoteFileAdapter = {
      rename: async (from, to) => {
        await fsRename(from, to)
        throw new Error("rename mutated")
      },
    }
    const saved = await saveNote(
      {
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "new",
        ...(await revision(path)),
      },
      adapter,
    )
    expect(await readFile(path, "utf8")).toBe("new")
    expect(saved.contentHash).toBe(hash("new"))
    expect(
      (await readdir(join(root, "content", "technology"))).filter(
        (name) =>
          name.includes(".garden-publisher-tmp-") || name.includes(".garden-publisher-rollback-"),
      ),
    ).toEqual([])
  })

  it("keeps a normal first rename failure from removing the live target", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    let calls = 0
    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "new",
          ...(await revision(path)),
        },
        {
          rename: async () => {
            calls += 1
            throw new Error("first rename failed")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })
    expect(calls).toBe(1)
    expect(await readFile(path, "utf8")).toContain("# Body")
    expect(
      (await readdir(join(root, "content", "technology"))).filter(
        (name) =>
          name.includes(".garden-publisher-tmp-") || name.includes(".garden-publisher-rollback-"),
      ),
    ).toEqual([])
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

  it("rejects a restore race after its undo recovery is captured", async () => {
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
      restoreRecovery(
        { workspace: root, id: recovery!.id, expectedCurrentHash: hash("saved") },
        { beforeReplace: async () => writeFile(path, "external restore edit") },
      ),
    ).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" })
    expect(await readFile(path, "utf8")).toBe("external restore edit")
    expect(await listRecoveries(root)).toHaveLength(2)
  })

  it("initializes recovery storage safely under concurrent saves and orders metadata deterministically", async () => {
    const root = await createGarden()
    const first = await createPublicNote(root, "first")
    const second = await createPublicNote(root, "second")
    await Promise.all([
      saveNote({
        workspace: root,
        path: "content/technology/first.md",
        markdown: "one",
        ...(await revision(first)),
      }),
      saveNote({
        workspace: root,
        path: "content/technology/second.md",
        markdown: "two",
        ...(await revision(second)),
      }),
    ])
    const recoveries = await listRecoveries(root)
    expect(recoveries).toHaveLength(2)
    expect(
      [...recoveries].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
      ),
    ).toEqual(recoveries)
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

  it("authenticates recovery metadata and rejects orphans without leaking private source", async () => {
    const root = await createGarden()
    const privatePath = await createNote({
      workspace: root,
      visibility: "private",
      domain: "life",
      slug: "secret",
      title: "Secret",
      date: "2026-09-19",
      description: "Private",
      tags: ["private"],
      body: "PRIVATE_BODY_SENTINEL",
    })
    const path = join(root, privatePath.path)
    await saveNote({
      workspace: root,
      path: privatePath.path,
      markdown: "saved private",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    const manifestPath = join(root, ".garden-publisher", "recovery", recovery!.id, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
    manifest.originalPath = "private/life/other.md"
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(restoreRecovery({ workspace: root, id: recovery!.id })).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as { code?: string }).code).toBe("RECOVERY_INVALID")
        expect(JSON.stringify(error)).not.toContain("PRIVATE_BODY_SENTINEL")
        expect(JSON.stringify(error)).not.toContain(root)
        return true
      },
    )
    await mkdir(join(root, ".garden-publisher", "recovery", "1234567890abcdef"))
    await expect(listRecoveries(root)).rejects.toMatchObject({ code: "RECOVERY_INVALID" })
  })

  it("rejects a coherently retagged manifest without the workspace HMAC key", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    const entry = join(root, ".garden-publisher", "recovery", recovery!.id)
    const manifestPath = join(entry, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
    manifest.originalPath = "content/technology/other.md"
    manifest.integrity = unkeyedManifestTag(manifest)
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(join(entry, "integrity.sha256"), `${manifest.integrity as string}\n`)
    await expect(listRecoveries(root)).rejects.toMatchObject({ code: "RECOVERY_INVALID" })
  })

  it("rejects missing or corrupt workspace recovery HMAC keys", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(path)),
    })
    const key = join(root, ".garden-publisher", "keys", "recovery-hmac.key")
    await rm(key)
    await expect(listRecoveries(root)).rejects.toMatchObject({ code: "RECOVERY_INVALID" })

    const root2 = await createGarden()
    const second = await createPublicNote(root2)
    await saveNote({
      workspace: root2,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(second)),
    })
    await writeFile(join(root2, ".garden-publisher", "keys", "recovery-hmac.key"), "corrupt")
    await expect(listRecoveries(root2)).rejects.toMatchObject({ code: "RECOVERY_INVALID" })
  })

  it("rejects tampered recovery snapshots and swapped recovery links", async ({ skip }) => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    const snapshot = join(root, ".garden-publisher", "recovery", recovery!.id, "content.md")
    await writeFile(snapshot, "snapshot tamper")
    await expect(listRecoveries(root)).rejects.toMatchObject({ code: "RECOVERY_INVALID" })

    const root2 = await createGarden()
    const second = await createPublicNote(root2)
    await saveNote({
      workspace: root2,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(second)),
    })
    const [secondRecovery] = await listRecoveries(root2)
    const secondSnapshot = join(
      root2,
      ".garden-publisher",
      "recovery",
      secondRecovery!.id,
      "content.md",
    )
    try {
      await rm(secondSnapshot)
      await symlink(join(root2, "private", "missing.md"), secondSnapshot, "file")
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }
    await expect(listRecoveries(root2)).rejects.toMatchObject({ code: "RECOVERY_INVALID" })
  })

  it("requires the recovery integrity digest stored separately from its manifest", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    await rm(join(root, ".garden-publisher", "recovery", recovery!.id, "integrity.sha256"))
    await expect(listRecoveries(root)).rejects.toMatchObject({ code: "RECOVERY_INVALID" })
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
