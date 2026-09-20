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

function targetLockPath(root: string, path: string): string {
  return join(root, ".garden-publisher", "locks", `${hash(path)}.lock`)
}

async function writeLockDirectory(
  path: string,
  options: { token?: string; pid?: number; now?: number; expiresAt?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now()
  const token = options.token ?? "11111111-1111-4111-8111-111111111111"
  await mkdir(path, { recursive: false, mode: 0o700 })
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({ version: 1, token, pid: options.pid ?? process.pid, createdAt: now }),
    { mode: 0o600 },
  )
  await writeFile(
    join(path, "heartbeat.json"),
    JSON.stringify({
      version: 1,
      token,
      heartbeatAt: now,
      leaseExpiresAt: options.expiresAt ?? now + 10_000,
    }),
    { mode: 0o600 },
  )
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

  it("reclaims a crashed target lease and does not leave a permanent lock", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const lock = targetLockPath(root, "content/technology/first-note.md")
    await mkdir(join(root, ".garden-publisher", "locks"), { recursive: true })
    await writeLockDirectory(lock, { pid: 999_999, now: 1, expiresAt: 3 })

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "saved",
          ...(await revision(path)),
        },
        { isProcessAlive: () => false },
      ),
    ).resolves.toMatchObject({ contentHash: hash("saved") })
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("never reclaims an expired-looking target lease whose owner is live", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const lock = targetLockPath(root, "content/technology/first-note.md")
    await mkdir(join(root, ".garden-publisher", "locks"), { recursive: true })
    await writeLockDirectory(lock, { pid: process.pid, now: 1, expiresAt: 3 })

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "saved",
          ...(await revision(path)),
        },
        { isProcessAlive: () => true },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_LOCKED" })
    expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8"))).toMatchObject({
      pid: process.pid,
    })
  })

  it("does not delete a successor target lease during release", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const lock = targetLockPath(root, "content/technology/first-note.md")
    const replacementToken = "11111111-1111-4111-8111-111111111111"

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "saved",
          ...(await revision(path)),
        },
        {
          beforeLockRelease: async () => {
            await rm(lock, { recursive: true, force: true })
            await writeLockDirectory(lock, { token: replacementToken })
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_LOCKED" })

    expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8"))).toMatchObject({
      token: replacementToken,
    })
  })

  it("aborts before commit when a successor replaces the target lock directory", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const original = await readFile(path, "utf8")
    const lock = targetLockPath(root, "content/technology/first-note.md")

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "must not commit",
          ...(await revision(path)),
        },
        {
          beforeReplace: async () => {
            await rm(lock, { recursive: true, force: true })
            await writeLockDirectory(lock)
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_LOCKED" })

    expect(await readFile(path, "utf8")).toBe(original)
    expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8"))).toMatchObject({
      token: "11111111-1111-4111-8111-111111111111",
    })
  })

  it("lets exactly one stale-target reclaimer win and releases it for the next save", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    const lock = targetLockPath(root, displayPath)
    await mkdir(join(root, ".garden-publisher", "locks"), { recursive: true })
    await writeLockDirectory(lock, { pid: 999_999, now: 1, expiresAt: 3 })
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = saveNote(
      { workspace: root, path: displayPath, markdown: "first", ...(await revision(path)) },
      {
        isProcessAlive: () => false,
        beforeReplace: async () => {
          entered()
          await releasePromise
        },
      },
    )
    await enteredPromise
    await expect(
      saveNote(
        { workspace: root, path: displayPath, markdown: "second", ...(await revision(path)) },
        { isProcessAlive: () => false },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_LOCKED" })
    release()
    await first
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" })

    await expect(
      saveNote({
        workspace: root,
        path: displayPath,
        markdown: "third",
        ...(await revision(path)),
      }),
    ).resolves.toMatchObject({ contentHash: hash("third") })
  })

  it("heartbeats a target lease while a save remains active", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    const lock = targetLockPath(root, displayPath)
    let heartbeatAdvanced = false

    await saveNote(
      { workspace: root, path: displayPath, markdown: "saved", ...(await revision(path)) },
      {
        lockLeaseMs: 100,
        beforeReplace: async () => {
          const before = JSON.parse(await readFile(join(lock, "heartbeat.json"), "utf8")) as {
            heartbeatAt: number
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 90))
          const after = JSON.parse(await readFile(join(lock, "heartbeat.json"), "utf8")) as {
            heartbeatAt: number
          }
          heartbeatAdvanced = after.heartbeatAt > before.heartbeatAt
        },
      },
    )

    expect(heartbeatAdvanced).toBe(true)
  })

  it("surfaces heartbeat ownership loss and blocks the target commit", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const original = await readFile(path, "utf8")
    const lock = targetLockPath(root, "content/technology/first-note.md")
    let lost!: () => void
    const lostPromise = new Promise<void>((resolve) => {
      lost = resolve
    })
    let replaced = false

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "must not commit",
          ...(await revision(path)),
        },
        {
          lockLeaseMs: 30,
          afterLockHeartbeat: async (directory) => {
            if (directory !== lock || replaced) return
            replaced = true
            await rm(lock, { recursive: true, force: true })
            await writeLockDirectory(lock)
            lost()
          },
          beforeReplace: async () => lostPromise,
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_LOCKED" })

    expect(await readFile(path, "utf8")).toBe(original)
    expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8"))).toMatchObject({
      token: "11111111-1111-4111-8111-111111111111",
    })
  })

  it("reclaims a truncated target lock only after the bounded grace period", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const lock = targetLockPath(root, "content/technology/first-note.md")
    await mkdir(lock, { recursive: true, mode: 0o700 })
    await writeFile(join(lock, "owner.json"), "{", { mode: 0o600 })
    let now = 1_000
    let delayed = 0

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "recovered",
          ...(await revision(path)),
        },
        {
          now: () => now,
          delay: async (milliseconds) => {
            delayed += milliseconds
            now += milliseconds
          },
          lockGraceMs: 75,
          isProcessAlive: () => false,
        },
      ),
    ).resolves.toMatchObject({ contentHash: hash("recovered") })

    expect(delayed).toBeGreaterThanOrEqual(75)
  })

  it("recovers a target lock directory left before owner publication", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const lock = targetLockPath(root, "content/technology/first-note.md")
    await mkdir(lock, { recursive: true, mode: 0o700 })
    let now = 2_000

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "recovered partial",
          ...(await revision(path)),
        },
        {
          now: () => now,
          delay: async (milliseconds) => {
            now += milliseconds
          },
          lockGraceMs: 40,
        },
      ),
    ).resolves.toMatchObject({ contentHash: hash("recovered partial") })
  })

  it("does not steal a target lock whose owner metadata is published within grace", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    const lock = targetLockPath(root, displayPath)
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    let publish!: () => void
    const publishPromise = new Promise<void>((resolve) => {
      publish = resolve
    })
    const first = saveNote(
      { workspace: root, path: displayPath, markdown: "first", ...(await revision(path)) },
      {
        lockGraceMs: 200,
        beforeLockMetadataPublish: async (directory) => {
          if (directory !== lock) return
          entered()
          await publishPromise
        },
      },
    )
    await enteredPromise
    const contender = saveNote(
      { workspace: root, path: displayPath, markdown: "second", ...(await revision(path)) },
      { lockGraceMs: 200 },
    )
    void contender.catch(() => undefined)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    publish()

    await expect(contender).rejects.toMatchObject({ code: "NOTE_FILE_LOCKED" })
    await expect(first).resolves.toMatchObject({ contentHash: hash("first") })
  })

  it("allows at most one malformed-target-lock reclaimer and leaves no permanent block", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    const lock = targetLockPath(root, displayPath)
    await mkdir(lock, { recursive: true, mode: 0o700 })
    await writeFile(join(lock, "owner.json"), "truncated", { mode: 0o600 })
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    let enteredOnce = false
    const adapter: NoteFileAdapter = {
      lockGraceMs: 25,
      isProcessAlive: () => false,
      beforeReplace: async () => {
        if (!enteredOnce) {
          enteredOnce = true
          entered()
          await releasePromise
        }
      },
    }
    const before = await revision(path)
    const saves = [
      saveNote({ workspace: root, path: displayPath, markdown: "one", ...before }, adapter),
      saveNote({ workspace: root, path: displayPath, markdown: "two", ...before }, adapter),
    ]
    for (const save of saves) void save.catch(() => undefined)
    await enteredPromise
    release()
    const settled = await Promise.allSettled(saves)
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1)
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" })

    await expect(
      saveNote({ workspace: root, path: displayPath, markdown: "next", ...(await revision(path)) }),
    ).resolves.toMatchObject({ contentHash: hash("next") })
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

  it("rejects staged bytes changed after flush without mutating the target", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const original = await readFile(path, "utf8")

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "requested bytes",
          ...(await revision(path)),
        },
        {
          beforeCommit: async (temporaryPath) => {
            await writeFile(temporaryPath, "tampered staged bytes")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })

    expect(await readFile(path, "utf8")).toBe(original)
    expect(
      (await readdir(join(root, "content", "technology"))).filter((name) =>
        name.includes(".garden-publisher-tmp-"),
      ),
    ).toEqual([])
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

  it("restores the original atomically when post-replace verification fails", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const original = await readFile(path, "utf8")

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "new bytes",
          ...(await revision(path)),
        },
        {
          afterReplace: async (target) => {
            await writeFile(join(root, target), "post-replace corruption")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })

    expect(await readFile(path, "utf8")).toBe(original)
    expect(await lstat(path)).toMatchObject({ isFile: expect.any(Function) })
  })

  it("restores the original when the first directory sync fails", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const original = await readFile(path, "utf8")
    let syncs = 0

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "new bytes",
          ...(await revision(path)),
        },
        {
          syncDirectory: async () => {
            syncs += 1
            if (syncs === 1) throw new Error("injected directory sync failure")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })

    expect(syncs).toBe(2)
    expect(await readFile(path, "utf8")).toBe(original)
  })

  it("restores the original when the installed target changes during directory sync", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const original = await readFile(path, "utf8")
    let syncs = 0

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "new bytes",
          ...(await revision(path)),
        },
        {
          syncDirectory: async (target) => {
            syncs += 1
            if (syncs === 1) await writeFile(target, "changed during sync")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })

    expect(syncs).toBe(2)
    expect(await readFile(path, "utf8")).toBe(original)
  })

  it("reports an uncertain commit and retains recovery evidence when rollback cannot be confirmed", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    let renames = 0

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "new bytes",
          ...(await revision(path)),
        },
        {
          rename: async (from, to) => {
            renames += 1
            if (renames === 1) return fsRename(from, to)
            throw new Error("injected rollback failure")
          },
          afterReplace: async () => {
            throw new Error("injected post-verify failure")
          },
        },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: "NOTE_FILE_COMMIT_UNCERTAIN" })
      expect(JSON.stringify(error)).not.toContain(root)
      return true
    })

    expect(await listRecoveries(root)).toHaveLength(1)
    expect(
      (await readdir(join(root, "content", "technology"))).some((name) =>
        name.includes(".garden-publisher-rollback-"),
      ),
    ).toBe(true)
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

  it("waits for a valid recovery key initializer delayed beyond 25ms", async () => {
    const root = await createGarden()
    const first = await createPublicNote(root, "first")
    const second = await createPublicNote(root, "second")
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const adapter: NoteFileAdapter = {
      beforeKeyPublish: async () => {
        entered()
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      },
    }
    const initializing = saveNote(
      {
        workspace: root,
        path: "content/technology/first.md",
        markdown: "one",
        ...(await revision(first)),
      },
      adapter,
    )
    await enteredPromise
    const waiting = saveNote({
      workspace: root,
      path: "content/technology/second.md",
      markdown: "two",
      ...(await revision(second)),
    })

    await expect(Promise.all([initializing, waiting])).resolves.toHaveLength(2)
  })

  it("does not publish a recovery key after initializer ownership is replaced", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const keys = join(root, ".garden-publisher", "keys")
    const initializationLock = join(keys, "recovery-hmac.key.initializing")

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "must not save",
          ...(await revision(path)),
        },
        {
          beforeKeyPublish: async () => {
            await rm(initializationLock, { recursive: true, force: true })
            await writeLockDirectory(initializationLock)
          },
        },
      ),
    ).rejects.toMatchObject({ code: "RECOVERY_INVALID" })

    await expect(lstat(join(keys, "recovery-hmac.key"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      JSON.parse(await readFile(join(initializationLock, "owner.json"), "utf8")),
    ).toMatchObject({ token: "11111111-1111-4111-8111-111111111111" })
  })

  it("reclaims a crashed recovery-key initializer lease", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const keys = join(root, ".garden-publisher", "keys")
    await mkdir(keys, { recursive: true })
    await writeLockDirectory(join(keys, "recovery-hmac.key.initializing"), {
      pid: 999_999,
      now: 1,
      expiresAt: 3,
    })

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "saved",
          ...(await revision(path)),
        },
        { isProcessAlive: () => false },
      ),
    ).resolves.toMatchObject({ contentHash: hash("saved") })
  })

  it("does not reclaim an expired-looking recovery-key lease with a live owner", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const keys = join(root, ".garden-publisher", "keys")
    const initializationLock = join(keys, "recovery-hmac.key.initializing")
    await mkdir(keys, { recursive: true })
    await writeLockDirectory(initializationLock, { pid: process.pid, now: 1, expiresAt: 3 })

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "saved",
          ...(await revision(path)),
        },
        { isProcessAlive: () => true, lockWaitMs: 100 },
      ),
    ).rejects.toMatchObject({ code: "RECOVERY_INVALID" })
    expect(
      JSON.parse(await readFile(join(initializationLock, "owner.json"), "utf8")),
    ).toMatchObject({
      pid: process.pid,
    })
  })

  it("allows only one concurrent recovery-key stale-lease reclaimer", async () => {
    const root = await createGarden()
    const first = await createPublicNote(root, "first")
    const second = await createPublicNote(root, "second")
    const keys = join(root, ".garden-publisher", "keys")
    await mkdir(keys, { recursive: true })
    await writeLockDirectory(join(keys, "recovery-hmac.key.initializing"), {
      pid: 999_999,
      now: 1,
      expiresAt: 3,
    })
    let publishers = 0
    const adapter: NoteFileAdapter = {
      isProcessAlive: () => false,
      beforeKeyPublish: async () => {
        publishers += 1
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
      },
    }

    await expect(
      Promise.all([
        saveNote(
          {
            workspace: root,
            path: "content/technology/first.md",
            markdown: "one",
            ...(await revision(first)),
          },
          adapter,
        ),
        saveNote(
          {
            workspace: root,
            path: "content/technology/second.md",
            markdown: "two",
            ...(await revision(second)),
          },
          adapter,
        ),
      ]),
    ).resolves.toHaveLength(2)
    expect(publishers).toBe(1)
  })

  it("reclaims a truncated key-initializer lock only after grace", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const initializationLock = join(
      root,
      ".garden-publisher",
      "keys",
      "recovery-hmac.key.initializing",
    )
    await mkdir(initializationLock, { recursive: true, mode: 0o700 })
    await writeFile(join(initializationLock, "owner.json"), "{", { mode: 0o600 })
    let now = 5_000
    let delayed = 0

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "saved",
          ...(await revision(path)),
        },
        {
          now: () => now,
          delay: async (milliseconds) => {
            delayed += milliseconds
            now += milliseconds
          },
          lockGraceMs: 60,
          isProcessAlive: () => false,
        },
      ),
    ).resolves.toMatchObject({ contentHash: hash("saved") })
    expect(delayed).toBeGreaterThanOrEqual(60)
  })

  it("recovers a key initializer directory left before owner publication", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const initializationLock = join(
      root,
      ".garden-publisher",
      "keys",
      "recovery-hmac.key.initializing",
    )
    await mkdir(initializationLock, { recursive: true, mode: 0o700 })
    let now = 8_000

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "saved after partial",
          ...(await revision(path)),
        },
        {
          now: () => now,
          delay: async (milliseconds) => {
            now += milliseconds
          },
          lockGraceMs: 40,
        },
      ),
    ).resolves.toMatchObject({ contentHash: hash("saved after partial") })
  })

  it("does not steal delayed live key-initializer metadata published within grace", async () => {
    const root = await createGarden()
    const first = await createPublicNote(root, "first")
    const second = await createPublicNote(root, "second")
    const initializationLock = join(
      root,
      ".garden-publisher",
      "keys",
      "recovery-hmac.key.initializing",
    )
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    let publish!: () => void
    const publishPromise = new Promise<void>((resolve) => {
      publish = resolve
    })
    let delayedOnce = false
    const initializer = saveNote(
      {
        workspace: root,
        path: "content/technology/first.md",
        markdown: "one",
        ...(await revision(first)),
      },
      {
        lockGraceMs: 200,
        beforeLockMetadataPublish: async (directory) => {
          if (directory !== initializationLock || delayedOnce) return
          delayedOnce = true
          entered()
          await publishPromise
        },
      },
    )
    await enteredPromise
    const waiting = saveNote(
      {
        workspace: root,
        path: "content/technology/second.md",
        markdown: "two",
        ...(await revision(second)),
      },
      { lockGraceMs: 200 },
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    publish()

    await expect(Promise.all([initializer, waiting])).resolves.toHaveLength(2)
  })

  it("allows only one malformed key-lock reclaimer to publish and leaves no block", async () => {
    const root = await createGarden()
    const first = await createPublicNote(root, "first")
    const second = await createPublicNote(root, "second")
    const initializationLock = join(
      root,
      ".garden-publisher",
      "keys",
      "recovery-hmac.key.initializing",
    )
    await mkdir(initializationLock, { recursive: true, mode: 0o700 })
    await writeFile(join(initializationLock, "owner.json"), "truncated", { mode: 0o600 })
    let publishers = 0
    const adapter: NoteFileAdapter = {
      lockGraceMs: 25,
      isProcessAlive: () => false,
      beforeKeyPublish: async () => {
        publishers += 1
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
      },
    }

    await expect(
      Promise.all([
        saveNote(
          {
            workspace: root,
            path: "content/technology/first.md",
            markdown: "one",
            ...(await revision(first)),
          },
          adapter,
        ),
        saveNote(
          {
            workspace: root,
            path: "content/technology/second.md",
            markdown: "two",
            ...(await revision(second)),
          },
          adapter,
        ),
      ]),
    ).resolves.toHaveLength(2)
    expect(publishers).toBe(1)
    await expect(lstat(initializationLock)).rejects.toMatchObject({ code: "ENOENT" })
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
