import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
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
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createNote,
  DEFAULT_RECOVERY_GLOBAL_LIMIT,
  DEFAULT_RECOVERY_PER_NOTE_LIMIT,
  MAX_RECOVERY_GLOBAL_LIMIT,
  MAX_RECOVERY_PER_NOTE_LIMIT,
  RECOVERY_RETENTION_MAX_AUTH_ATTEMPTS,
  RECOVERY_RETENTION_MAX_DIRECTORY_ENTRIES,
  RECOVERY_RETENTION_MAX_SNAPSHOT_READS,
  RECOVERY_RETENTION_MAX_TRASH_CALLS,
  discardRecovery,
  listRecoveries,
  readNote,
  restoreRecovery as restoreRecoveryService,
  saveNote as saveNoteService,
  type NoteFileAdapter,
} from "../../src/main/services/noteFiles"
import type { TrashAdapter } from "../../src/shared/contracts"

const temporaryDirectories: string[] = []
const defaultRecoveryTrash: TrashAdapter = { trashItem: async () => undefined }

function saveNote(
  input: Omit<Parameters<typeof saveNoteService>[0], "recoveryTrash" | "recoveryPolicy"> & {
    readonly recoveryTrash?: TrashAdapter
    readonly recoveryPolicy?: { readonly perNoteLimit: number; readonly globalLimit: number }
  },
  adapter?: NoteFileAdapter,
) {
  const { recoveryTrash = defaultRecoveryTrash, ...rest } = input
  return saveNoteService({ ...rest, recoveryTrash }, adapter)
}

function restoreRecovery(
  input: Omit<Parameters<typeof restoreRecoveryService>[0], "recoveryTrash" | "recoveryPolicy"> & {
    readonly recoveryTrash?: TrashAdapter
    readonly recoveryPolicy?: { readonly perNoteLimit: number; readonly globalLimit: number }
  },
  adapter?: NoteFileAdapter,
) {
  const { recoveryTrash = defaultRecoveryTrash, ...rest } = input
  return restoreRecoveryService({ ...rest, recoveryTrash }, adapter)
}

afterEach(async () => {
  vi.restoreAllMocks()
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
  for (const domain of ["technology", "reading", "language", "life"]) {
    await mkdir(join(root, "content", domain), { recursive: true })
    await writeFile(
      join(root, "content", domain, "index.md"),
      `---\ngardenDomain: true\ntitle: ${domain}\ndescription: Test domain.\n---\n`,
    )
  }
  return root
}

async function markDomain(root: string, domain: string): Promise<void> {
  await mkdir(join(root, "content", domain), { recursive: true })
  await mkdir(join(root, "private", domain), { recursive: true })
  await writeFile(
    join(root, "content", domain, "index.md"),
    `---\ngardenDomain: true\ntitle: ${domain}\ndescription: Test domain.\n---\n`,
  )
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
  it("creates, reads, and saves a note in a custom marked domain", async () => {
    const root = await createGarden()
    await markDomain(root, "artificial-intelligence")
    const created = await createNote({
      workspace: root,
      visibility: "public",
      domain: "artificial-intelligence",
      slug: "transformers",
      title: "Transformers",
      date: "2026-10-07",
      description: "Attention models.",
      tags: ["ai"],
      body: "First",
    })
    expect(created.path).toBe("content/artificial-intelligence/transformers.md")
    const document = await readNote({ workspace: root, path: created.path })
    const current = document.markdown
    expect(document.path).toBe(created.path)
    const saved = await saveNote({
      workspace: root,
      path: created.path,
      markdown: `${current}\nSecond`,
      expectedMtimeMs: created.mtimeMs,
      expectedContentHash: created.contentHash,
    })
    expect(saved.path).toBe(created.path)
  })

  it("rejects an unmarked or removed domain before creating or saving", async () => {
    const root = await createGarden()
    await mkdir(join(root, "content", "unmarked"), { recursive: true })
    await expect(
      createNote({
        workspace: root,
        visibility: "public",
        domain: "unmarked",
        slug: "note",
        title: "Note",
        date: "2026-10-07",
        description: "No marker.",
        tags: ["test"],
      }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_INVALID" })

    await markDomain(root, "artificial-intelligence")
    const created = await createNote({
      workspace: root,
      visibility: "public",
      domain: "artificial-intelligence",
      slug: "transformers",
      title: "Transformers",
      date: "2026-10-07",
      description: "Attention models.",
      tags: ["ai"],
    })
    await rm(join(root, "content", "artificial-intelligence", "index.md"))
    await expect(
      saveNote({
        workspace: root,
        path: created.path,
        markdown: "changed",
        expectedMtimeMs: created.mtimeMs,
        expectedContentHash: created.contentHash,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^NOTE_FILE_/) })
  })

  it("does not publish into a custom domain whose landing page changes before commit", async () => {
    const root = await createGarden()
    await markDomain(root, "artificial-intelligence")
    const landing = join(root, "content", "artificial-intelligence", "index.md")
    const target = join(root, "content", "artificial-intelligence", "race.md")

    await expect(
      createNote(
        {
          workspace: root,
          visibility: "public",
          domain: "artificial-intelligence",
          slug: "race",
          title: "Race",
          date: "2026-10-07",
          description: "Domain replacement race.",
          tags: ["test"],
        },
        {
          beforeCommit: async () => {
            await rm(landing)
            await writeFile(landing, "---\ngardenDomain: false\n---\n")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_UNSAFE_PATH" })
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not trust an unmarked replacement captured after domain classification", async () => {
    const root = await createGarden()
    await markDomain(root, "artificial-intelligence")
    const landing = join(root, "content", "artificial-intelligence", "index.md")
    const target = join(root, "content", "artificial-intelligence", "classification-race.md")
    let flipped = false

    await expect(
      createNote(
        {
          workspace: root,
          visibility: "public",
          domain: "artificial-intelligence",
          slug: "classification-race",
          title: "Classification race",
          date: "2026-10-07",
          description: "Classification evidence race.",
          tags: ["test"],
        },
        {
          afterDomainClassified: async (path: string) => {
            if (flipped || path !== "content/artificial-intelligence/index.md") return
            flipped = true
            await rm(landing)
            await writeFile(landing, "---\ngardenDomain: false\n---\n")
          },
        } as NoteFileAdapter & {
          afterDomainClassified(path: string): Promise<void>
        },
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^NOTE_FILE_/) })
    expect(flipped).toBe(true)
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
  })
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

  it.each(["writeFile", "sync", "commit"] as const)(
    "removes an exclusively-created destination when the %s stage fails so a retry can succeed",
    async (method) => {
      const root = await createGarden()
      const failure = Object.assign(new Error(`injected ${method} failure`), { code: "EIO" })
      const adapter: NoteFileAdapter =
        method === "writeFile"
          ? { beforeTempWrite: () => Promise.reject(failure) }
          : method === "sync"
            ? { beforeTempSync: () => Promise.reject(failure) }
            : { beforeCommit: () => Promise.reject(failure) }
      const input = {
        workspace: root,
        visibility: "public" as const,
        domain: "technology" as const,
        slug: `exclusive-${method.toLowerCase()}`,
        title: "Exclusive cleanup",
        date: "2026-09-20",
        description: "Exercises failed exclusive creation.",
        tags: ["test"],
      }
      const destination = join(root, "content", "technology", `${input.slug}.md`)

      await expect(createNote(input, adapter)).rejects.toMatchObject({
        code: "NOTE_FILE_WRITE_FAILED",
      })
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })

      await expect(createNote(input)).resolves.toMatchObject({
        path: `content/technology/${input.slug}.md`,
      })
    },
  )

  it("never removes a successor that replaces a failed exclusive destination", async () => {
    const root = await createGarden()
    const destination = join(root, "content", "technology", "exclusive-successor.md")
    await expect(
      createNote(
        {
          workspace: root,
          visibility: "public",
          domain: "technology",
          slug: "exclusive-successor",
          title: "Exclusive successor",
          date: "2026-09-20",
          description: "Preserves replacement identity.",
          tags: ["test"],
        },
        {
          async beforeTempWrite() {
            await writeFile(destination, "successor bytes")
            throw Object.assign(new Error("injected write failure after replacement"), {
              code: "EIO",
            })
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })
    expect(await readFile(destination, "utf8")).toBe("successor bytes")
  })

  it("never publishes a final note when temp identity stat fails and allows retry", async () => {
    const root = await createGarden()
    const destination = join(root, "content", "technology", "exclusive-stat.md")
    const probe = join(root, "exclusive-stat-probe")
    const probeHandle = await open(probe, "wx", 0o600)
    const prototype = Object.getPrototypeOf(probeHandle) as {
      stat: (options?: { bigint?: boolean }) => Promise<unknown>
    }
    const originalStat = prototype.stat
    await probeHandle.close()
    await rm(probe)
    let failNextStat = false
    const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: typeof probeHandle,
      options,
    ) {
      if (failNextStat) {
        failNextStat = false
        throw Object.assign(new Error("injected identity stat failure"), { code: "EIO" })
      }
      return Reflect.apply(originalStat, this, [options])
    })
    const input = {
      workspace: root,
      visibility: "public" as const,
      domain: "technology" as const,
      slug: "exclusive-stat",
      title: "Exclusive stat",
      date: "2026-09-20",
      description: "Fails before publication.",
      tags: ["test"],
    }

    await expect(
      createNote(input, {
        beforeTempWrite() {
          failNextStat = true
        },
      }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    spy.mockRestore()
    await expect(createNote(input)).resolves.toMatchObject({
      path: "content/technology/exclusive-stat.md",
    })
  })

  it("removes a published note when its final directory sync fails and allows retry", async () => {
    const root = await createGarden()
    const destination = join(root, "content", "technology", "exclusive-directory-sync.md")
    const input = {
      workspace: root,
      visibility: "public" as const,
      domain: "technology" as const,
      slug: "exclusive-directory-sync",
      title: "Exclusive directory sync",
      date: "2026-09-20",
      description: "Fails after no-replace publication.",
      tags: ["test"],
    }

    await expect(
      createNote(input, {
        syncDirectory: async () => {
          throw Object.assign(new Error("injected final directory sync failure"), { code: "EIO" })
        },
      }),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(createNote(input)).resolves.toMatchObject({
      path: "content/technology/exclusive-directory-sync.md",
    })
  })

  it("rejects a malformed expected content hash before workspace access or locking", async () => {
    const root = await createGarden()
    const missingWorkspace = join(root, "missing")

    await expect(
      saveNote({
        workspace: missingWorkspace,
        path: "content/technology/first-note.md",
        markdown: "new",
        expectedMtimeMs: 0,
        expectedContentHash: "not-a-sha-256",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    await expect(lstat(join(root, ".garden-publisher"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([
    { perNoteLimit: MAX_RECOVERY_PER_NOTE_LIMIT + 1, globalLimit: MAX_RECOVERY_GLOBAL_LIMIT },
    { perNoteLimit: MAX_RECOVERY_PER_NOTE_LIMIT, globalLimit: MAX_RECOVERY_GLOBAL_LIMIT + 1 },
  ])("rejects an oversized retention policy before workspace access or locking", async (policy) => {
    const root = await createGarden()

    await expect(
      saveNote({
        workspace: join(root, "missing"),
        path: "content/technology/first-note.md",
        markdown: "new",
        expectedMtimeMs: 0,
        expectedContentHash: hash("revision"),
        recoveryPolicy: policy,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    await expect(lstat(join(root, ".garden-publisher"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps the documented default and maximum retention policy values", () => {
    expect({
      defaultPerNote: DEFAULT_RECOVERY_PER_NOTE_LIMIT,
      defaultGlobal: DEFAULT_RECOVERY_GLOBAL_LIMIT,
      maximumPerNote: MAX_RECOVERY_PER_NOTE_LIMIT,
      maximumGlobal: MAX_RECOVERY_GLOBAL_LIMIT,
    }).toEqual({
      defaultPerNote: 20,
      defaultGlobal: 500,
      maximumPerNote: 100,
      maximumGlobal: 2_000,
    })
  })

  it("rejects a null retention policy with the same deterministic input error", async () => {
    const root = await createGarden()

    await expect(
      saveNoteService({
        workspace: join(root, "missing"),
        path: "content/technology/first-note.md",
        markdown: "new",
        expectedMtimeMs: 0,
        expectedContentHash: hash("revision"),
        recoveryTrash: defaultRecoveryTrash,
        recoveryPolicy: null as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    await expect(lstat(join(root, ".garden-publisher"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("accepts an uppercase SHA-256 expected content hash", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const expected = await revision(path)

    await expect(
      saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "updated",
        expectedMtimeMs: expected.expectedMtimeMs,
        expectedContentHash: expected.expectedContentHash.toUpperCase(),
      }),
    ).resolves.toMatchObject({ contentHash: hash("updated") })
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
      reason: {
        code: expect.stringMatching(/^NOTE_(?:ALREADY_EXISTS|FILE_LOCKED|FILE_UNSAFE_PATH)$/),
      },
    })
    expect(
      (await readdir(join(root, "content", "technology"))).filter((name) =>
        name.includes(".garden-publisher-create-"),
      ),
    ).toEqual([])
    expect(["first", "second"]).toContain(
      (await readFile(join(root, "content/technology/same-note.md"), "utf8")).split("\n").at(-1),
    )
  })

  it("rejects a linked destination parent", async ({ skip }) => {
    const root = await createGarden()
    const outside = await mkdtemp(join(tmpdir(), "garden-note-outside-"))
    temporaryDirectories.push(outside)
    await rm(join(root, "content", "technology"), { recursive: true })
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
    let now = 1_000
    let tick: (() => Promise<void>) | undefined

    await saveNote(
      { workspace: root, path: displayPath, markdown: "saved", ...(await revision(path)) },
      {
        lockLeaseMs: 100,
        now: () => now,
        startHeartbeat: (directory, heartbeat) => {
          if (directory === lock) tick = heartbeat
          return () => undefined
        },
        beforeReplace: async () => {
          const before = JSON.parse(await readFile(join(lock, "heartbeat.json"), "utf8")) as {
            heartbeatAt: number
          }
          now += 50
          expect(tick).toBeTypeOf("function")
          await tick!()
          const after = JSON.parse(await readFile(join(lock, "heartbeat.json"), "utf8")) as {
            heartbeatAt: number
          }
          heartbeatAdvanced = after.heartbeatAt > before.heartbeatAt
        },
      },
    )

    expect(heartbeatAdvanced).toBe(true)
  })

  it("retries one transient heartbeat publication failure while ownership is unchanged", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    const lock = targetLockPath(root, displayPath)
    let tick: (() => Promise<void>) | undefined
    let attempts = 0
    let retries = 0

    await expect(
      saveNote(
        { workspace: root, path: displayPath, markdown: "saved", ...(await revision(path)) },
        {
          startHeartbeat: (directory, heartbeat) => {
            if (directory === lock) tick = heartbeat
            return () => undefined
          },
          beforeHeartbeatPublish: async (directory) => {
            if (directory !== lock) return
            attempts += 1
            if (attempts === 1) throw new Error("transient heartbeat failure")
          },
          heartbeatRetryLimit: 1,
          delay: async () => {
            retries += 1
          },
          beforeReplace: async () => {
            expect(tick).toBeTypeOf("function")
            await tick!()
          },
        },
      ),
    ).resolves.toMatchObject({ contentHash: hash("saved") })

    expect(attempts).toBe(2)
    expect(retries).toBe(1)
  })

  it("does not retry a failed heartbeat while ownership is ambiguous", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    const lock = targetLockPath(root, displayPath)
    let tick: (() => Promise<void>) | undefined
    let retries = 0

    await expect(
      saveNote(
        {
          workspace: root,
          path: displayPath,
          markdown: "must not commit",
          ...(await revision(path)),
        },
        {
          lockWaitMs: 1,
          startHeartbeat: (directory, heartbeat) => {
            if (directory === lock) tick = heartbeat
            return () => undefined
          },
          beforeHeartbeatPublish: async (directory) => {
            if (directory !== lock) return
            await rm(lock, { recursive: true, force: true })
            throw new Error("heartbeat ownership became ambiguous")
          },
          delay: async () => {
            retries += 1
            await writeLockDirectory(lock)
          },
          beforeReplace: async () => {
            expect(tick).toBeTypeOf("function")
            await tick!()
            if (retries === 0) await writeLockDirectory(lock)
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_LOCKED" })

    expect(retries).toBe(0)
    expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8"))).toMatchObject({
      token: "11111111-1111-4111-8111-111111111111",
    })
  })

  it("surfaces heartbeat ownership loss and blocks the target commit", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const original = await readFile(path, "utf8")
    const lock = targetLockPath(root, "content/technology/first-note.md")
    let tick: (() => Promise<void>) | undefined
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
          startHeartbeat: (directory, heartbeat) => {
            if (directory === lock) tick = heartbeat
            return () => undefined
          },
          afterLockHeartbeat: async (directory) => {
            if (directory !== lock || replaced) return
            replaced = true
            await rm(lock, { recursive: true, force: true })
            await writeLockDirectory(lock)
          },
          beforeReplace: async () => {
            expect(tick).toBeTypeOf("function")
            await tick!()
          },
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
    let resumeContender!: () => void
    const resumeContenderPromise = new Promise<void>((resolve) => {
      resumeContender = resolve
    })
    let contenderWaiting!: () => void
    const contenderWaitingPromise = new Promise<void>((resolve) => {
      contenderWaiting = resolve
    })
    let now = 10_000
    let published!: () => void
    const publishedPromise = new Promise<void>((resolve) => {
      published = resolve
    })
    const first = saveNote(
      { workspace: root, path: displayPath, markdown: "first", ...(await revision(path)) },
      {
        lockGraceMs: 200,
        now: () => now,
        beforeLockMetadataPublish: async (directory) => {
          if (directory !== lock) return
          entered()
          await publishPromise
        },
        afterLockMetadataPublish: async (directory) => {
          if (directory === lock) published()
        },
      },
    )
    await enteredPromise
    const contender = saveNote(
      { workspace: root, path: displayPath, markdown: "second", ...(await revision(path)) },
      {
        lockGraceMs: 200,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds
          contenderWaiting()
          await resumeContenderPromise
        },
      },
    )
    void contender.catch(() => undefined)
    await contenderWaitingPromise
    expect(now).toBeLessThan(10_200)
    publish()
    await publishedPromise
    resumeContender()

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
        expectedContentHash: hash("stale revision"),
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
          syncDirectory: async (target) => {
            if (target !== path) return
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
            if (target !== path) return
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
            if (from.includes(".staging-")) return fsRename(from, to)
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

  it("keeps a custom-domain recovery intact when its domain marker was removed", async () => {
    const root = await createGarden()
    await markDomain(root, "artificial-intelligence")
    const path = join(root, "content", "artificial-intelligence", "recovery-note.md")
    await createNote({
      workspace: root,
      visibility: "public",
      domain: "artificial-intelligence",
      slug: "recovery-note",
      title: "Recovery note",
      date: "2026-10-07",
      description: "Custom recovery.",
      tags: ["test"],
      body: "original",
    })
    await saveNote({
      workspace: root,
      path: "content/artificial-intelligence/recovery-note.md",
      markdown: "current",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    const evidence = join(root, ".garden-publisher", "recovery", recovery!.id)
    await rm(join(root, "content", "artificial-intelligence", "index.md"))

    await expect(
      restoreRecovery({
        workspace: root,
        id: recovery!.id,
        expectedCurrentHash: hash("current"),
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:NOTE_FILE_INVALID|RECOVERY_INVALID)$/),
    })
    await expect(readFile(path, "utf8")).resolves.toBe("current")
    await expect(lstat(evidence)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
  })

  it("blocks custom-domain recovery when its landing page is replaced before commit", async () => {
    const root = await createGarden()
    await markDomain(root, "artificial-intelligence")
    const path = join(root, "content", "artificial-intelligence", "recovery-race.md")
    const landing = join(root, "content", "artificial-intelligence", "index.md")
    await createNote({
      workspace: root,
      visibility: "public",
      domain: "artificial-intelligence",
      slug: "recovery-race",
      title: "Recovery race",
      date: "2026-10-07",
      description: "Custom recovery race.",
      tags: ["test"],
      body: "original",
    })
    await saveNote({
      workspace: root,
      path: "content/artificial-intelligence/recovery-race.md",
      markdown: "current",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    const evidence = join(root, ".garden-publisher", "recovery", recovery!.id)

    await expect(
      restoreRecovery(
        { workspace: root, id: recovery!.id, expectedCurrentHash: hash("current") },
        {
          beforeReplace: async () => {
            await rm(landing)
            await writeFile(landing, "---\ngardenDomain: false\n---\n")
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_UNSAFE_PATH" })
    await expect(readFile(path, "utf8")).resolves.toBe("current")
    await expect(lstat(evidence)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
  })

  it.each(["EACCES", "EIO"])(
    "does not treat a target %s read failure as absence during restore",
    async (code) => {
      const root = await createGarden()
      const path = await createPublicNote(root)
      await saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "current target bytes",
        ...(await revision(path)),
      })
      const [recovery] = await listRecoveries(root)
      const probe = join(root, "restore-read-probe")
      const probeHandle = await open(probe, "wx", 0o600)
      const prototype = Object.getPrototypeOf(probeHandle) as { readFile: () => Promise<Buffer> }
      await probeHandle.close()
      await rm(probe)
      const originalReadFile = prototype.readFile
      let injected = false
      let replacementAttempted = false
      vi.spyOn(prototype, "readFile").mockImplementation(async function (this: typeof prototype) {
        const bytes = await Reflect.apply(originalReadFile, this, Array.from(arguments))
        if (!injected && bytes.toString("utf8") === "current target bytes") {
          injected = true
          throw Object.assign(new Error(`injected ${code}`), { code })
        }
        return bytes
      })

      await expect(
        restoreRecovery(
          { workspace: root, id: recovery!.id },
          {
            beforeTempWrite: () => {
              replacementAttempted = true
            },
          },
        ),
      ).rejects.toMatchObject({ code: "NOTE_FILE_ACCESS_FAILED" })
      expect(injected).toBe(true)
      expect(replacementAttempted).toBe(false)
      expect(await readFile(path, "utf8")).toBe("current target bytes")
    },
  )

  it("does not treat an unsafe linked restore target as absence", async ({ skip }) => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "current target bytes",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    const outside = join(root, "outside.md")
    await writeFile(outside, "outside")
    try {
      await rm(path)
      await symlink(outside, path, "file")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }
    let replacementAttempted = false

    await expect(
      restoreRecovery(
        { workspace: root, id: recovery!.id },
        { beforeTempWrite: () => void (replacementAttempted = true) },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_UNSAFE_PATH" })
    expect(replacementAttempted).toBe(false)
    expect(await readFile(outside, "utf8")).toBe("outside")
  })

  it("restores after confirmed target absence without creating an undo snapshot", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "current target bytes",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    await rm(path)

    await restoreRecovery({ workspace: root, id: recovery!.id })

    expect(await readFile(path, "utf8")).toContain("# Body")
    expect(await listRecoveries(root)).toHaveLength(1)
  })

  it("returns a committed save with a lock cleanup warning when release fails", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    const lock = targetLockPath(root, displayPath)

    const saved = await saveNote(
      {
        workspace: root,
        path: displayPath,
        markdown: "committed despite release failure",
        ...(await revision(path)),
      },
      {
        beforeLockRelease: (directory) => {
          if (directory === lock) throw new Error("injected release failure")
        },
      },
    )

    expect(await readFile(path, "utf8")).toBe("committed despite release failure")
    expect(saved.warnings).toEqual([
      {
        code: "LOCK_RELEASE_FAILED",
        message: "The save completed, but its lock could not be cleaned up.",
        details: { lockId: `${hash(displayPath)}.lock` },
      },
    ])
  })

  it("returns a committed restore with a lock cleanup warning when release fails", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "current target bytes",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    const lock = targetLockPath(root, displayPath)

    const restored = await restoreRecovery(
      {
        workspace: root,
        id: recovery!.id,
        expectedCurrentHash: hash("current target bytes"),
      },
      {
        beforeLockRelease: (directory) => {
          if (directory === lock) throw new Error("injected restore release failure")
        },
      },
    )

    expect(await readFile(path, "utf8")).toContain("# Body")
    expect(restored.warnings).toEqual([
      {
        code: "LOCK_RELEASE_FAILED",
        message: "The restore completed, but its lock could not be cleaned up.",
        details: { lockId: `${hash(displayPath)}.lock` },
      },
    ])
  })

  it("preserves a primary save failure when lock release also fails", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const original = await readFile(path, "utf8")
    const displayPath = "content/technology/first-note.md"
    const lock = targetLockPath(root, displayPath)

    await expect(
      saveNote(
        {
          workspace: root,
          path: displayPath,
          markdown: "must not install",
          ...(await revision(path)),
        },
        {
          beforeTempWrite: () => {
            throw new Error("injected primary failure")
          },
          beforeLockRelease: (directory) => {
            if (directory === lock) throw new Error("injected release failure")
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "NOTE_FILE_WRITE_FAILED",
      details: {
        cleanupWarnings: [
          expect.objectContaining({
            code: "LOCK_RELEASE_FAILED",
            details: { lockId: `${hash(displayPath)}.lock` },
          }),
        ],
      },
    })
    expect(await readFile(path, "utf8")).toBe(original)
  })

  it.each(["snapshot", "manifest", "tag"] as const)(
    "never exposes a partial final recovery when the %s file write is interrupted",
    async (stage) => {
      const root = await createGarden()
      const path = await createPublicNote(root)
      await saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "saved once",
        ...(await revision(path)),
      })
      const recoveryRoot = join(root, ".garden-publisher", "recovery")
      const existing = (await listRecoveries(root)).map(({ id }) => id)
      const probe = join(root, "recovery-write-probe")
      const probeHandle = await open(probe, "wx", 0o600)
      const prototype = Object.getPrototypeOf(probeHandle) as {
        writeFile: (value: string | Uint8Array) => Promise<void>
      }
      await probeHandle.close()
      await rm(probe)
      const originalWriteFile = prototype.writeFile
      let interrupted = false
      vi.spyOn(prototype, "writeFile").mockImplementation(async function (
        this: typeof prototype,
        value,
      ) {
        const text = Buffer.from(value).toString("utf8")
        const matches =
          stage === "snapshot"
            ? text === "saved once"
            : stage === "manifest"
              ? text.includes('"originalPath":"content/technology/first-note.md"')
              : /^[a-f0-9]{64}\n$/i.test(text)
        if (matches && !interrupted) {
          interrupted = true
          const visible = (await readdir(recoveryRoot)).filter((name) => !name.startsWith("."))
          expect(visible).toEqual(existing)
          throw Object.assign(new Error(`interrupted ${stage}`), { code: "EIO" })
        }
        return Reflect.apply(originalWriteFile, this, [value])
      })

      await expect(
        saveNote({
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "should not install",
          ...(await revision(path)),
        }),
      ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })
      expect(interrupted).toBe(true)
      expect((await listRecoveries(root)).map(({ id }) => id)).toEqual(existing)
      expect((await readdir(recoveryRoot)).filter((name) => name.startsWith(".staging-"))).toEqual(
        [],
      )
      expect(await readFile(path, "utf8")).toBe("saved once")
    },
  )

  it("publishes a recovery only after its staging directory is complete and durable", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const synced: string[] = []
    let recoveryRenameObserved = false

    await saveNote(
      {
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "durable save",
        ...(await revision(path)),
      },
      {
        rename: async (from, to) => {
          if (from.includes(".staging-")) {
            recoveryRenameObserved = true
            expect((await readdir(from)).sort()).toEqual([
              "content.md",
              "integrity.sha256",
              "manifest.json",
            ])
          }
          await fsRename(from, to)
        },
        syncDirectory: async (value) => {
          synced.push(value)
        },
      },
    )

    expect(recoveryRenameObserved).toBe(true)
    expect(synced.some((value) => value.includes(".garden-publisher\\keys"))).toBe(true)
    expect(synced.some((value) => value.includes(".staging-"))).toBe(true)
    expect(synced).toContain(join(root, ".garden-publisher", "recovery"))
  })

  it("keeps prior recoveries listable when publication fails before the directory rename", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved once",
      ...(await revision(path)),
    })
    const existing = (await listRecoveries(root)).map(({ id }) => id)

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "not installed",
          ...(await revision(path)),
        },
        {
          rename: async (from, to) => {
            if (from.includes(".staging-")) throw new Error("interrupted before publish")
            await fsRename(from, to)
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NOTE_FILE_WRITE_FAILED" })
    expect((await listRecoveries(root)).map(({ id }) => id)).toEqual(existing)
    expect(await readFile(path, "utf8")).toBe("saved once")
  })

  it("recognizes a complete recovery when interruption happens after the directory rename", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    let interrupted = false

    await expect(
      saveNote(
        {
          workspace: root,
          path: "content/technology/first-note.md",
          markdown: "installed after recovery publish",
          ...(await revision(path)),
        },
        {
          rename: async (from, to) => {
            await fsRename(from, to)
            if (from.includes(".staging-") && !interrupted) {
              interrupted = true
              throw new Error("interrupted after publish")
            }
          },
        },
      ),
    ).resolves.toMatchObject({ contentHash: hash("installed after recovery publish") })
    expect(interrupted).toBe(true)
    expect(await listRecoveries(root)).toHaveLength(1)
  })

  it("lists valid recoveries with typed body-free issues and ignores staging namespaces", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(path)),
    })
    const recoveryRoot = join(root, ".garden-publisher", "recovery")
    const corruptId = "1234567890abcdef"
    await mkdir(join(recoveryRoot, corruptId), { mode: 0o700 })
    const youngStaging = join(
      recoveryRoot,
      ".staging-1234567890abcdef-11111111-1111-4111-8111-111111111111",
    )
    await mkdir(youngStaging, { mode: 0o700 })
    await mkdir(join(recoveryRoot, ".quarantine-11111111-1111-4111-8111-111111111111"), {
      mode: 0o700,
    })

    const listed = await listRecoveries(root)

    expect(listed.filter((item) => "originalPath" in item)).toHaveLength(1)
    expect(listed.find((item) => item.id === corruptId)).toEqual({
      id: corruptId,
      code: "RECOVERY_INVALID",
      message: "Recovery data is invalid.",
    })
    expect(JSON.stringify(listed)).not.toContain("# Body")
    expect(JSON.stringify(listed)).not.toContain("saved")
    expect(listed).toHaveLength(2)
    await expect(lstat(youngStaging)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
  })

  it("cleans only conservatively old, owned recovery staging directories", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "initialize recovery storage",
      ...(await revision(path)),
    })
    const staging = join(
      root,
      ".garden-publisher",
      "recovery",
      ".staging-1234567890abcdef-22222222-2222-4222-8222-222222222222",
    )
    await mkdir(staging, { mode: 0o700 })
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000)
    await utimes(staging, old, old)

    await listRecoveries(root)

    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("prunes oldest per-note recoveries through Trash after the new recovery is durable", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const trashed: string[] = []
    const trashRoot = join(root, "recoverable-trash")
    await mkdir(trashRoot)
    const recoveryTrash: TrashAdapter = {
      trashItem: async (value) => {
        trashed.push(value)
        await fsRename(value, join(trashRoot, value.split(/[/\\]/).at(-1)!))
      },
    }
    const recoveryPolicy = { perNoteLimit: 2, globalLimit: 10 }

    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "version one",
      ...(await revision(path)),
      recoveryTrash,
      recoveryPolicy,
    })
    const [oldest] = await listRecoveries(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "version two",
      ...(await revision(path)),
      recoveryTrash,
      recoveryPolicy,
    })
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "version three",
      ...(await revision(path)),
      recoveryTrash,
      recoveryPolicy,
    })

    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toMatch(new RegExp(`[/\\\\]\\.retention-${oldest!.id}-[a-f0-9-]{36}$`, "i"))
    expect(await listRecoveries(root)).toHaveLength(2)
    await expect(lstat(join(trashRoot, trashed[0]!.split(/[/\\]/).at(-1)!))).resolves.toMatchObject(
      {
        isDirectory: expect.any(Function),
      },
    )
  })

  it("enforces the global recovery cap across notes through the same Trash adapter", async () => {
    const root = await createGarden()
    const trashed: string[] = []
    const trashRoot = join(root, "recoverable-trash")
    await mkdir(trashRoot)
    const recoveryTrash: TrashAdapter = {
      trashItem: async (value) => {
        trashed.push(value)
        await fsRename(value, join(trashRoot, value.split(/[/\\]/).at(-1)!))
      },
    }
    const recoveryPolicy = { perNoteLimit: 20, globalLimit: 3 }
    const paths: string[] = []
    for (const slug of ["global-one", "global-two", "global-three", "global-four"]) {
      paths.push(await createPublicNote(root, slug))
    }
    let oldestId = ""
    for (const [index, path] of paths.entries()) {
      await saveNote({
        workspace: root,
        path: `content/technology/global-${["one", "two", "three", "four"][index]}.md`,
        markdown: `version ${index}`,
        ...(await revision(path)),
        recoveryTrash,
        recoveryPolicy,
      })
      if (index === 0) oldestId = (await listRecoveries(root))[0]!.id
    }

    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toMatch(new RegExp(`[/\\\\]\\.retention-${oldestId}-[a-f0-9-]{36}$`, "i"))
    expect(await listRecoveries(root)).toHaveLength(3)
  })

  it("commits the save and returns a serializable warning when retention Trash fails", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const lock = targetLockPath(root, "content/technology/first-note.md")
    let lockPresentDuringMaintenance = false
    const recoveryTrash: TrashAdapter = {
      trashItem: async () => {
        lockPresentDuringMaintenance = await lstat(lock).then(
          () => true,
          () => false,
        )
        throw new Error("Trash unavailable")
      },
    }
    const recoveryPolicy = { perNoteLimit: 1, globalLimit: 10 }
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "version one",
      ...(await revision(path)),
      recoveryTrash,
      recoveryPolicy,
    })

    const saved = await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "version two",
      ...(await revision(path)),
      recoveryTrash,
      recoveryPolicy,
    })

    expect(await readFile(path, "utf8")).toBe("version two")
    expect(saved.warnings).toEqual([
      {
        code: "RECOVERY_RETENTION_FAILED",
        message: "The save completed, but bounded recovery maintenance needs another pass.",
        details: { attemptedCount: 1, failureCount: 1, operation: "save" },
      },
    ])
    expect(lockPresentDuringMaintenance).toBe(false)
    expect(() => JSON.stringify(saved)).not.toThrow()
  })

  it("never auto-trashes a recovery whose snapshot file is structurally corrupt", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    const setupPolicy = { perNoteLimit: MAX_RECOVERY_PER_NOTE_LIMIT, globalLimit: 100 }
    for (const markdown of ["version one", "version two"]) {
      await saveNote({
        workspace: root,
        path: displayPath,
        markdown,
        ...(await revision(path)),
        recoveryPolicy: setupPolicy,
      })
    }
    const recoveries = await listRecoveries(root)
    const corruptId = recoveries.at(-1)!.id
    await rm(join(root, ".garden-publisher", "recovery", corruptId, "content.md"))
    await rm(join(root, ".garden-publisher", "recovery-retention-state.json"), { force: true })
    const attemptedPaths: string[] = []

    await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "version three",
      ...(await revision(path)),
      recoveryPolicy: { perNoteLimit: 1, globalLimit: 100 },
      recoveryTrash: {
        trashItem: async (value) => {
          attemptedPaths.push(value)
        },
      },
    })

    expect(attemptedPaths).not.toContain(join(root, ".garden-publisher", "recovery", corruptId))
  })

  it("parameterizes bounded retention warnings for restore after releasing its lock", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "current target",
      ...(await revision(path)),
    })
    const [recovery] = await listRecoveries(root)
    const lock = targetLockPath(root, displayPath)
    let lockPresentDuringMaintenance = false
    const restored = await restoreRecovery({
      workspace: root,
      id: recovery!.id,
      expectedCurrentHash: hash("current target"),
      recoveryTrash: {
        trashItem: async () => {
          lockPresentDuringMaintenance = await lstat(lock).then(
            () => true,
            () => false,
          )
          throw new Error("Trash unavailable")
        },
      },
      recoveryPolicy: { perNoteLimit: 1, globalLimit: 10 },
    })

    expect(restored.warnings).toEqual([
      {
        code: "RECOVERY_RETENTION_FAILED",
        message: "The restore completed, but bounded recovery maintenance needs another pass.",
        details: { attemptedCount: 1, failureCount: 1, operation: "restore" },
      },
    ])
    expect(lockPresentDuringMaintenance).toBe(false)
  })

  it("bounds degraded retention work, skips bodies and corrupt IDs, and advances its cursor", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    const setupPolicy = { perNoteLimit: 100, globalLimit: 2_000 }
    for (let index = 0; index < RECOVERY_RETENTION_MAX_DIRECTORY_ENTRIES * 2 + 6; index += 1) {
      await saveNote({
        workspace: root,
        path: displayPath,
        markdown: `stress-version-${index}`,
        ...(await revision(path)),
        recoveryPolicy: setupPolicy,
      })
    }
    const recoveryRoot = join(root, ".garden-publisher", "recovery")
    const validIds = (await readdir(recoveryRoot))
      .filter((name) => /^\d+-/.test(name))
      .sort()
      .reverse()
    const corruptIds = validIds.slice(4, 7).map((id, index) => {
      const timestamp = id.split("-")[0]
      return `${timestamp}-${String(index + 1).repeat(8)}-ffff-4fff-8fff-${String(index + 1).repeat(12)}`
    })
    for (const id of corruptIds) await mkdir(join(recoveryRoot, id), { mode: 0o700 })
    const statePath = join(root, ".garden-publisher", "recovery-retention-state.json")
    await rm(statePath, { force: true })
    const lock = targetLockPath(root, displayPath)
    const probe = join(root, "retention-read-probe")
    const probeHandle = await open(probe, "wx", 0o600)
    type ProbeHandle = {
      readFile: () => Promise<Buffer>
      read: (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>
    }
    const prototype = Object.getPrototypeOf(probeHandle) as ProbeHandle
    await probeHandle.close()
    await rm(probe)
    const originalReadFile = prototype.readFile
    const originalRead = prototype.read
    let keyReadsAfterRelease = 0
    let manifestReadsAfterRelease = 0
    let snapshotReadsAfterRelease = 0
    vi.spyOn(prototype, "readFile").mockImplementation(async function (this: typeof prototype) {
      const lockPresent = await lstat(lock).then(
        () => true,
        () => false,
      )
      const bytes = await Reflect.apply(originalReadFile, this, Array.from(arguments))
      if (!lockPresent) {
        const text = bytes.toString("utf8")
        if (text.startsWith("stress-version-")) snapshotReadsAfterRelease += 1
      }
      return bytes
    })
    vi.spyOn(prototype, "read").mockImplementation(async function (
      this: typeof prototype,
      buffer,
      offset,
      length,
      position,
    ) {
      const lockPresent = await lstat(lock).then(
        () => true,
        () => false,
      )
      const result = await Reflect.apply(originalRead, this, [buffer, offset, length, position])
      if (!lockPresent) {
        const bytes = buffer.subarray(offset, offset + result.bytesRead)
        const text = bytes.toString("utf8")
        if (buffer.length === 33 && result.bytesRead === 32) keyReadsAfterRelease += 1
        if (text.includes('"originalPath":"content/technology/first-note.md"')) {
          manifestReadsAfterRelease += 1
        }
      }
      return result
    })
    const attemptedPaths: string[] = []
    let lockPresentDuringTrash = false
    const recoveryTrash: TrashAdapter = {
      trashItem: async (value) => {
        attemptedPaths.push(value)
        lockPresentDuringTrash ||= await lstat(lock).then(
          () => true,
          () => false,
        )
        throw new Error("persistent Trash failure")
      },
    }
    const degradedPolicy = { perNoteLimit: 3, globalLimit: 3 }

    const first = await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "stress-final-one",
      ...(await revision(path)),
      recoveryTrash,
      recoveryPolicy: degradedPolicy,
    })
    const firstState = JSON.parse(await readFile(statePath, "utf8")) as { cursor?: string }

    expect(first.warnings).toHaveLength(1)
    expect(first.warnings?.[0]).toMatchObject({
      code: "RECOVERY_RETENTION_FAILED",
      details: {
        attemptedCount: RECOVERY_RETENTION_MAX_TRASH_CALLS,
        failureCount: RECOVERY_RETENTION_MAX_TRASH_CALLS,
        operation: "save",
      },
    })
    expect(attemptedPaths).toHaveLength(RECOVERY_RETENTION_MAX_TRASH_CALLS)
    expect(attemptedPaths.some((value) => corruptIds.some((id) => value.includes(id)))).toBe(false)
    expect(lockPresentDuringTrash).toBe(false)
    expect(keyReadsAfterRelease).toBe(1)
    expect(manifestReadsAfterRelease).toBeLessThanOrEqual(RECOVERY_RETENTION_MAX_AUTH_ATTEMPTS)
    expect(snapshotReadsAfterRelease).toBe(RECOVERY_RETENTION_MAX_SNAPSHOT_READS)
    expect(firstState.cursor).toEqual(expect.any(String))
    const firstAttemptedIds = attemptedPaths.map(
      (value) =>
        /\.retention-(.+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.exec(
          value,
        )?.[1],
    )

    vi.restoreAllMocks()
    attemptedPaths.length = 0
    const second = await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "stress-final-two",
      ...(await revision(path)),
      recoveryTrash,
      recoveryPolicy: degradedPolicy,
    })
    const secondState = JSON.parse(await readFile(statePath, "utf8")) as { cursor?: string }

    expect(second.warnings).toHaveLength(1)
    expect(attemptedPaths).toHaveLength(RECOVERY_RETENTION_MAX_TRASH_CALLS)
    expect(
      attemptedPaths.some((value) => {
        const id =
          /\.retention-(.+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.exec(
            value,
          )?.[1]
        return id !== undefined && !firstAttemptedIds.includes(id)
      }),
    ).toBe(true)
    expect(secondState.cursor).toEqual(expect.any(String))
    expect(secondState.cursor).not.toBe(firstState.cursor)
  }, 30_000)

  it("cleans only old recovery quarantines within the maintenance entry budget", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "initialize",
      ...(await revision(path)),
    })
    const recoveryRoot = join(root, ".garden-publisher", "recovery")
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000)
    const oldQuarantines: string[] = []
    for (let index = 0; index < RECOVERY_RETENTION_MAX_DIRECTORY_ENTRIES + 4; index += 1) {
      const directory = join(
        recoveryRoot,
        `.quarantine-${String(index).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`,
      )
      oldQuarantines.push(directory)
      await mkdir(directory, { mode: 0o700 })
      await utimes(directory, old, old)
    }
    const fresh = join(recoveryRoot, ".quarantine-ffffffff-ffff-4fff-8fff-ffffffffffff")
    await mkdir(fresh, { mode: 0o700 })

    await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "trigger bounded cleanup",
      ...(await revision(path)),
    })

    const remaining = await readdir(recoveryRoot)
    const removedCount = oldQuarantines.filter(
      (directory) => !remaining.includes(directory.split(/[/\\]/).at(-1)!),
    ).length
    expect(removedCount).toBeGreaterThan(0)
    expect(removedCount).toBeLessThanOrEqual(RECOVERY_RETENTION_MAX_DIRECTORY_ENTRIES)
    await expect(lstat(fresh)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
  })

  it("resets corrupt cursor state without following untrusted backlog paths", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "initialize retention state",
      ...(await revision(path)),
    })
    const statePath = join(root, ".garden-publisher", "recovery-retention-state.json")
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        cursor: "../../outside",
        globalSeen: 50_000,
        perNoteCounts: { "../../outside": 50_000 },
        backlog: ["../../outside"],
        integrity: "0".repeat(64),
      }),
    )
    const attemptedPaths: string[] = []

    const saved = await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "continue after corrupt state reset",
      ...(await revision(path)),
      recoveryTrash: {
        trashItem: async (value) => {
          attemptedPaths.push(value)
        },
      },
    })

    expect(saved.warnings).toBeUndefined()
    expect(attemptedPaths).toEqual([])
    await expect(readFile(statePath, "utf8")).resolves.toContain('"integrity"')
  })

  it("resets an oversized retention state without reading its body", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "initialize retention state",
      ...(await revision(path)),
    })
    const statePath = join(root, ".garden-publisher", "recovery-retention-state.json")
    await writeFile(statePath, "x".repeat(256 * 1_024 + 1))
    const probe = join(root, "oversized-state-read-probe")
    const probeHandle = await open(probe, "wx", 0o600)
    const prototype = Object.getPrototypeOf(probeHandle) as { readFile: () => Promise<Buffer> }
    await probeHandle.close()
    await rm(probe)
    const originalReadFile = prototype.readFile
    let oversizedBodyReads = 0
    vi.spyOn(prototype, "readFile").mockImplementation(async function (this: typeof prototype) {
      const bytes = await Reflect.apply(originalReadFile, this, Array.from(arguments))
      if (bytes.length > 256 * 1_024) oversizedBodyReads += 1
      return bytes
    })

    await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "continue after state reset",
      ...(await revision(path)),
    })

    expect(oversizedBodyReads).toBe(0)
  })

  it("rejects an oversized recovery key without reading its body", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const stateDirectory = join(root, ".garden-publisher")
    await mkdir(join(stateDirectory, "recovery"), { recursive: true, mode: 0o700 })
    await mkdir(join(stateDirectory, "keys"), { recursive: true, mode: 0o700 })
    await writeFile(join(stateDirectory, "keys", "recovery-hmac.key"), Buffer.alloc(256 * 1_024))
    const probe = join(root, "oversized-key-read-probe")
    const probeHandle = await open(probe, "wx", 0o600)
    const prototype = Object.getPrototypeOf(probeHandle) as { readFile: () => Promise<Buffer> }
    await probeHandle.close()
    await rm(probe)
    const originalReadFile = prototype.readFile
    let oversizedBodyReads = 0
    vi.spyOn(prototype, "readFile").mockImplementation(async function (this: typeof prototype) {
      const bytes = await Reflect.apply(originalReadFile, this, Array.from(arguments))
      if (bytes.length > 128 * 1_024) oversizedBodyReads += 1
      return bytes
    })

    await expect(
      saveNote({
        workspace: root,
        path: "content/technology/first-note.md",
        markdown: "must not read an oversized key",
        ...(await revision(path)),
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_INVALID" })
    expect(oversizedBodyReads).toBe(0)
  })

  it("rejects oversized retention metadata without reading its body", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    const displayPath = "content/technology/first-note.md"
    for (const markdown of ["version one", "version two"]) {
      await saveNote({
        workspace: root,
        path: displayPath,
        markdown,
        ...(await revision(path)),
        recoveryPolicy: { perNoteLimit: MAX_RECOVERY_PER_NOTE_LIMIT, globalLimit: 100 },
      })
    }
    const corruptId = (await listRecoveries(root)).at(-1)!.id
    await writeFile(
      join(root, ".garden-publisher", "recovery", corruptId, "manifest.json"),
      Buffer.alloc(256 * 1_024),
    )
    await rm(join(root, ".garden-publisher", "recovery-retention-state.json"), { force: true })
    const probe = join(root, "oversized-metadata-read-probe")
    const probeHandle = await open(probe, "wx", 0o600)
    const prototype = Object.getPrototypeOf(probeHandle) as { readFile: () => Promise<Buffer> }
    await probeHandle.close()
    await rm(probe)
    const originalReadFile = prototype.readFile
    let oversizedBodyReads = 0
    vi.spyOn(prototype, "readFile").mockImplementation(async function (this: typeof prototype) {
      const bytes = await Reflect.apply(originalReadFile, this, Array.from(arguments))
      if (bytes.length > 64 * 1_024) oversizedBodyReads += 1
      return bytes
    })
    const attemptedPaths: string[] = []

    await saveNote({
      workspace: root,
      path: displayPath,
      markdown: "version three",
      ...(await revision(path)),
      recoveryPolicy: { perNoteLimit: 1, globalLimit: 100 },
      recoveryTrash: {
        trashItem: async (value) => {
          attemptedPaths.push(value)
        },
      },
    })

    expect(oversizedBodyReads).toBe(0)
    expect(attemptedPaths.some((value) => value.includes(corruptId))).toBe(false)
  })

  it("bounds recovery authentication with a deterministic newest-ID-first limit", async () => {
    const root = await createGarden()
    const path = await createPublicNote(root)
    await saveNote({
      workspace: root,
      path: "content/technology/first-note.md",
      markdown: "initialize recovery key",
      ...(await revision(path)),
    })
    const recoveryRoot = join(root, ".garden-publisher", "recovery")
    const fakeIds: string[] = []
    for (let index = 0; index < 1_200; index += 1) {
      const id = `${9_000_000_000_000 + index}-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
      fakeIds.push(id)
      await mkdir(join(recoveryRoot, id), { mode: 0o700 })
    }

    const listed = await listRecoveries(root, { limit: 25 })
    const next = await listRecoveries(root, { limit: 25, cursor: listed.at(-1)!.id })

    expect(listed).toHaveLength(25)
    expect(listed.map(({ id }) => id)).toEqual(fakeIds.sort().reverse().slice(0, 25))
    expect(listed.every((item) => "code" in item && item.code === "RECOVERY_INVALID")).toBe(true)
    expect(next.map(({ id }) => id)).toEqual(fakeIds.sort().reverse().slice(25, 50))
    expect(next.some(({ id }) => listed.some((item) => item.id === id))).toBe(false)
  }, 20_000)

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
    const recoveries = (await listRecoveries(root)).filter(
      (item): item is Extract<typeof item, { readonly createdAt: string }> => "createdAt" in item,
    )
    expect(recoveries).toHaveLength(2)
    expect(
      [...recoveries].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
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
    let publish!: () => void
    const publishPromise = new Promise<void>((resolve) => {
      publish = resolve
    })
    const adapter: NoteFileAdapter = {
      beforeKeyPublish: async () => {
        entered()
        await publishPromise
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
    let resumeWaiter!: () => void
    const resumeWaiterPromise = new Promise<void>((resolve) => {
      resumeWaiter = resolve
    })
    let waiterEntered!: () => void
    const waiterEnteredPromise = new Promise<void>((resolve) => {
      waiterEntered = resolve
    })
    let now = 20_000
    const waiting = saveNote(
      {
        workspace: root,
        path: "content/technology/second.md",
        markdown: "two",
        ...(await revision(second)),
      },
      {
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds
          waiterEntered()
          await resumeWaiterPromise
        },
      },
    )
    await waiterEnteredPromise
    publish()
    await expect(initializing).resolves.toMatchObject({ contentHash: hash("one") })
    resumeWaiter()
    await expect(waiting).resolves.toMatchObject({ contentHash: hash("two") })
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
    let publisherEntered!: () => void
    const publisherEnteredPromise = new Promise<void>((resolve) => {
      publisherEntered = resolve
    })
    let releasePublisher!: () => void
    const releasePublisherPromise = new Promise<void>((resolve) => {
      releasePublisher = resolve
    })
    const adapter: NoteFileAdapter = {
      isProcessAlive: () => false,
      beforeKeyPublish: async () => {
        publishers += 1
        publisherEntered()
        await releasePublisherPromise
      },
    }

    const saves = [
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
    ]
    await publisherEnteredPromise
    releasePublisher()
    await expect(Promise.all(saves)).resolves.toHaveLength(2)
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
    let metadataPublished!: () => void
    const metadataPublishedPromise = new Promise<void>((resolve) => {
      metadataPublished = resolve
    })
    let keyPublished!: () => void
    const keyPublishedPromise = new Promise<void>((resolve) => {
      keyPublished = resolve
    })
    let waiterEntered!: () => void
    const waiterEnteredPromise = new Promise<void>((resolve) => {
      waiterEntered = resolve
    })
    let resumeWaiter!: () => void
    const resumeWaiterPromise = new Promise<void>((resolve) => {
      resumeWaiter = resolve
    })
    let now = 30_000
    let delayCalls = 0
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
        now: () => now,
        beforeLockMetadataPublish: async (directory) => {
          if (directory !== initializationLock || delayedOnce) return
          delayedOnce = true
          entered()
          await publishPromise
        },
        afterLockMetadataPublish: async (directory) => {
          if (directory === initializationLock) metadataPublished()
        },
        afterKeyPublish: async () => keyPublished(),
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
      {
        lockGraceMs: 200,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds
          delayCalls += 1
          if (delayCalls === 1) {
            waiterEntered()
            await resumeWaiterPromise
          } else {
            await keyPublishedPromise
          }
        },
      },
    )
    await waiterEnteredPromise
    expect(now).toBeLessThan(30_200)
    publish()
    await metadataPublishedPromise
    resumeWaiter()

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
    let publisherEntered!: () => void
    const publisherEnteredPromise = new Promise<void>((resolve) => {
      publisherEntered = resolve
    })
    let releasePublisher!: () => void
    const releasePublisherPromise = new Promise<void>((resolve) => {
      releasePublisher = resolve
    })
    const adapter: NoteFileAdapter = {
      lockGraceMs: 25,
      isProcessAlive: () => false,
      beforeKeyPublish: async () => {
        publishers += 1
        publisherEntered()
        await releasePublisherPromise
      },
    }

    const saves = [
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
    ]
    await publisherEnteredPromise
    releasePublisher()
    await expect(Promise.all(saves)).resolves.toHaveLength(2)
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
    await expect(listRecoveries(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: recovery!.id, code: "RECOVERY_INVALID" }),
        expect.objectContaining({ id: "1234567890abcdef", code: "RECOVERY_INVALID" }),
      ]),
    )
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
    await expect(listRecoveries(root)).resolves.toContainEqual({
      id: recovery!.id,
      code: "RECOVERY_INVALID",
      message: "Recovery data is invalid.",
    })
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
    await expect(listRecoveries(root)).resolves.toContainEqual({
      id: (await readdir(join(root, ".garden-publisher", "recovery")))[0],
      code: "RECOVERY_INVALID",
      message: "Recovery data is invalid.",
    })

    const root2 = await createGarden()
    const second = await createPublicNote(root2)
    await saveNote({
      workspace: root2,
      path: "content/technology/first-note.md",
      markdown: "saved",
      ...(await revision(second)),
    })
    await writeFile(join(root2, ".garden-publisher", "keys", "recovery-hmac.key"), "corrupt")
    await expect(listRecoveries(root2)).resolves.toEqual([
      expect.objectContaining({ code: "RECOVERY_INVALID" }),
    ])
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
    await expect(listRecoveries(root)).resolves.toContainEqual({
      id: recovery!.id,
      code: "RECOVERY_INVALID",
      message: "Recovery data is invalid.",
    })

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
    await expect(listRecoveries(root2)).resolves.toContainEqual({
      id: secondRecovery!.id,
      code: "RECOVERY_INVALID",
      message: "Recovery data is invalid.",
    })
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
    await expect(listRecoveries(root)).resolves.toContainEqual({
      id: recovery!.id,
      code: "RECOVERY_INVALID",
      message: "Recovery data is invalid.",
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
