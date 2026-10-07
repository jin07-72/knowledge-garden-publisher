import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import {
  lstat,
  mkdir,
  mkdtemp,
  open as nodeOpen,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as trashRecovery from "../../src/main/services/trashRecovery"
import { internalRecoveryKey, trashNote } from "../../src/main/services/noteFiles"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function garden(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-recovery-page-"))
  temporaryDirectories.push(root)
  await mkdir(join(root, "content", "life"), { recursive: true })
  await mkdir(join(root, "private", "life"), { recursive: true })
  await writeFile(
    join(root, "content", "life", "index.md"),
    "---\ngardenDomain: true\ntitle: Life\ndescription: Test domain.\n---\n",
  )
  return root
}

async function recycleAndRestore(root: string, path: string): Promise<string> {
  const recycle = await mkdtemp(join(tmpdir(), "garden-recovery-bin-"))
  temporaryDirectories.push(recycle)
  let staged = ""
  await trashNote({
    workspace: root,
    path,
    trash: {
      trashItem: async (target) => {
        staged = target
        await rename(target, join(recycle, "item"))
      },
    },
    isTracked: async () => false,
  })
  await rename(join(recycle, "item"), staged)
  return staged
}

async function stageFile(
  root: string,
  relativePath: string,
  options: trashRecovery.TrashRecoveryPrepareOptions = {},
): Promise<trashRecovery.TrashRecoveryStage> {
  const original = join(root, ...relativePath.split("/"))
  const details = await lstat(original, { bigint: true })
  const stage = await trashRecovery.prepareTrashRecovery(
    root,
    original,
    relativePath,
    "file",
    `${details.dev}:${details.ino}:${details.birthtimeNs}`,
    createHash("sha256")
      .update(await readFile(original))
      .digest("hex"),
    await internalRecoveryKey(root, true),
    options,
  )
  await rename(original, stage.stagedPath)
  return stage
}

async function stageDirectory(
  root: string,
  relativePath: string,
): Promise<trashRecovery.TrashRecoveryStage> {
  const original = join(root, ...relativePath.split("/"))
  const details = await lstat(original, { bigint: true })
  const stage = await trashRecovery.prepareTrashRecovery(
    root,
    original,
    relativePath,
    "directory",
    `${details.dev}:${details.ino}:${details.birthtimeNs}`,
    undefined,
    await internalRecoveryKey(root, true),
  )
  await rename(original, stage.stagedPath)
  return stage
}

function boundedClock(activeChecks: number): () => number {
  let checks = 0
  return () => (checks++ < activeChecks ? 0 : 10)
}

async function sortedDirectory(path: string) {
  const names = (await readdir(path)).sort()
  return {
    async *[Symbol.asyncIterator]() {
      for (const name of names) yield { name }
    },
    async close() {},
  }
}

describe("trash recovery directory bounds", () => {
  it("restores a custom-domain journal only while its domain remains marked", async () => {
    const root = await garden()
    await mkdir(join(root, "content", "artificial-intelligence"), { recursive: true })
    await mkdir(join(root, "private", "artificial-intelligence"), { recursive: true })
    const landing = join(root, "content", "artificial-intelligence", "index.md")
    await writeFile(landing, "---\ngardenDomain: true\ntitle: AI\ndescription: Test domain.\n---\n")
    await writeFile(join(root, "content", "artificial-intelligence", "note.md"), "# Note")
    const staged = await recycleAndRestore(root, "content/artificial-intelligence/note.md")
    await expect(
      trashRecovery.reconcileTrashRecovery(root, () => internalRecoveryKey(root, false)),
    ).resolves.toMatchObject({ restored: ["content/artificial-intelligence/note.md"] })

    await rm(join(root, "content", "artificial-intelligence", "note.md"))
    await writeFile(join(root, "content", "artificial-intelligence", "note.md"), "# Again")
    await recycleAndRestore(root, "content/artificial-intelligence/note.md")
    await rm(landing)
    await expect(
      trashRecovery.reconcileTrashRecovery(root, () => internalRecoveryKey(root, false)),
    ).resolves.toMatchObject({ restored: [] })
    expect(staged).toContain("artificial-intelligence")
  })
  it("stops after the limit plus one entry and closes the directory handle", async () => {
    let yielded = 0
    const close = vi.fn(async () => undefined)
    const handle = {
      async *[Symbol.asyncIterator]() {
        while (yielded < 50_000) {
          yielded += 1
          yield { name: `entry-${yielded}` }
        }
      },
      close,
    }
    const readBoundedDirectoryNames = (
      trashRecovery as typeof trashRecovery & {
        readBoundedDirectoryNames?: (
          path: string,
          maximumEntries: number,
          opener: () => Promise<typeof handle>,
        ) => Promise<readonly string[]>
      }
    ).readBoundedDirectoryNames

    expect(readBoundedDirectoryNames).toBeTypeOf("function")
    await expect(readBoundedDirectoryNames!("ignored", 10_000, async () => handle)).rejects.toThrow(
      /too many entries/i,
    )
    expect(yielded).toBe(10_001)
    expect(close).toHaveBeenCalledOnce()
  })

  it("stores new transactions in deterministic UUID-prefix shards", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "daily.md"), "# Daily")

    const staged = await recycleAndRestore(root, "content/life/daily.md")

    expect(staged.replaceAll("\\", "/")).toMatch(
      /\.garden-publisher\/trash-recovery\/indexed-transactions\/[a-f0-9]{2}\/[a-f0-9-]{36}\/items\/content\/life\/daily\.md$/i,
    )
  })

  it("persists an incremental cursor and drains a multi-page backlog", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "alpha.md"), "# Alpha")
    await writeFile(join(root, "content", "life", "beta.md"), "# Beta")
    await recycleAndRestore(root, "content/life/alpha.md")
    await recycleAndRestore(root, "content/life/beta.md")
    const reconcilePass = (
      trashRecovery as typeof trashRecovery & {
        reconcileTrashRecoveryPass?: (
          workspace: string,
          loadKey: () => Promise<Buffer>,
          options: { maximumTransactions: number },
        ) => Promise<{
          restored: readonly string[]
          conflicts: readonly string[]
          pending: boolean
        }>
      }
    ).reconcileTrashRecoveryPass

    expect(reconcilePass).toBeTypeOf("function")
    const first = await reconcilePass!(root, () => internalRecoveryKey(root, false), {
      maximumTransactions: 1,
    })
    expect(first.restored).toHaveLength(1)
    expect(first.pending).toBe(true)
    const second = await reconcilePass!(root, () => internalRecoveryKey(root, false), {
      maximumTransactions: 1,
    })
    expect(second.restored).toHaveLength(1)
    expect(new Set([...first.restored, ...second.restored])).toEqual(
      new Set(["content/life/alpha.md", "content/life/beta.md"]),
    )
    await expect(readFile(join(root, "content", "life", "alpha.md"), "utf8")).resolves.toBe(
      "# Alpha",
    )
    await expect(readFile(join(root, "content", "life", "beta.md"), "utf8")).resolves.toBe("# Beta")
  })

  it("migrates a legacy flat transaction without a root-entry-count lockout", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "legacy.md"), "# Legacy")
    const staged = await recycleAndRestore(root, "content/life/legacy.md")
    const transaction = dirname(dirname(dirname(dirname(staged))))
    const id = transaction.split(/[\\/]/).at(-1)!
    const legacy = join(root, ".garden-publisher", "trash-recovery", id)
    await rename(transaction, legacy)
    for (let index = 0; index < 200; index += 1) {
      await writeFile(
        join(root, ".garden-publisher", "trash-recovery", `ignored-${index}`),
        "ignored",
      )
    }

    const restored: string[] = []
    for (let pass = 0; pass < 8 && restored.length === 0; pass += 1) {
      const result = await trashRecovery.reconcileTrashRecoveryPass(root, () =>
        internalRecoveryKey(root, false),
      )
      restored.push(...result.restored)
    }
    expect(restored).toEqual(["content/life/legacy.md"])
  })

  it("restores an indexed journal even when more than 10,000 junk entries precede it", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "crowded.md"), "# Crowded")
    const staged = await recycleAndRestore(root, "content/life/crowded.md")
    const transaction = dirname(dirname(dirname(dirname(staged))))
    const shard = dirname(transaction)
    const id = transaction.split(/[\\/]/).at(-1)!
    const openDirectory = async (path: string) => {
      if (resolve(path) !== resolve(shard)) return opendir(path)
      let index = 0
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              index += 1
              if (index <= 10_001) return { done: false as const, value: { name: `junk-${index}` } }
              if (index === 10_002) return { done: false as const, value: { name: id } }
              return { done: true as const, value: undefined }
            },
          }
        },
        async close() {},
      }
    }

    let restored: readonly string[] = []
    for (let pass = 0; pass < 3 && restored.length === 0; pass += 1) {
      restored = (
        await trashRecovery.reconcileTrashRecoveryPass(
          root,
          () => internalRecoveryKey(root, false),
          { openDirectory },
        )
      ).restored
    }

    expect(restored).toContain("content/life/crowded.md")
  })

  it("shrinks legacy work across deadlines and mutations until an old journal is found", async () => {
    const root = await garden()
    const recoveryRoot = join(root, ".garden-publisher", "trash-recovery")
    await writeFile(join(root, "content", "life", "legacy-race.md"), "# Legacy race")
    const staged = await recycleAndRestore(root, "content/life/legacy-race.md")
    const transaction = dirname(dirname(dirname(dirname(staged))))
    const id = transaction.split(/[\\/]/).at(-1)!
    await rename(transaction, join(recoveryRoot, id))
    for (let index = 0; index < 1_100; index += 1) {
      await writeFile(
        join(recoveryRoot, `0000-junk-${index.toString().padStart(4, "0")}`),
        `junk-${index}`,
      )
    }

    const first = await trashRecovery.reconcileTrashRecoveryPass(
      root,
      () => internalRecoveryKey(root, false),
      { maximumElapsedMs: 10, now: boundedClock(1_040), openDirectory: sortedDirectory },
    )
    expect(first.restored).toEqual([])
    expect(first.pending).toBe(true)
    const remainingAfterDeadline = (await readdir(recoveryRoot)).filter((name) =>
      name.startsWith("0000-junk-"),
    )
    expect(remainingAfterDeadline.length).toBeLessThan(1_100)
    await rm(join(recoveryRoot, remainingAfterDeadline[0]!))
    await writeFile(join(recoveryRoot, "0000-junk-inserted"), "inserted")

    const restored: string[] = []
    let previousRemaining = (await readdir(recoveryRoot)).filter((name) =>
      name.startsWith("0000-junk-"),
    ).length
    for (let restart = 0; restart < 8 && restored.length === 0; restart += 1) {
      const pass = await trashRecovery.reconcileTrashRecoveryPass(
        root,
        () => internalRecoveryKey(root, false),
        // Freeze the test clock so host contention cannot consume the pass budget.
        { maximumElapsedMs: 10, now: () => 0, openDirectory: sortedDirectory },
      )
      restored.push(...pass.restored)
      const remaining = (await readdir(recoveryRoot)).filter((name) =>
        name.startsWith("0000-junk-"),
      ).length
      expect(remaining).toBeLessThanOrEqual(previousRemaining)
      if (pass.restored.length === 0 && previousRemaining > 0) {
        expect(remaining).toBeLessThan(previousRemaining)
      }
      previousRemaining = remaining
    }

    expect(restored).toContain("content/life/legacy-race.md")
    await expect(readFile(join(root, "content", "life", "legacy-race.md"), "utf8")).resolves.toBe(
      "# Legacy race",
    )
    const quarantined = await readdir(join(recoveryRoot, "legacy-quarantine", "000"))
    expect(quarantined.length).toBeGreaterThan(1_000)
  }, 20_000)

  it("moves a legacy junk link into quarantine without following or deleting its target", async () => {
    const root = await garden()
    const recoveryRoot = join(root, ".garden-publisher", "trash-recovery")
    await mkdir(recoveryRoot, { recursive: true })
    const outside = join(root, "outside-sentinel")
    await mkdir(outside)
    await writeFile(join(outside, "sentinel.txt"), "keep")
    const junkLink = join(recoveryRoot, "legacy-junction")
    await symlink(outside, junkLink, "junction")

    await trashRecovery.reconcileTrashRecoveryPass(root, () => internalRecoveryKey(root, true), {
      openDirectory: sortedDirectory,
    })

    await expect(readFile(join(outside, "sentinel.txt"), "utf8")).resolves.toBe("keep")
    await expect(lstat(junkLink)).rejects.toMatchObject({ code: "ENOENT" })
    const quarantined = await readdir(join(recoveryRoot, "legacy-quarantine", "000"))
    expect(quarantined).toHaveLength(1)
    expect(
      (
        await lstat(join(recoveryRoot, "legacy-quarantine", "000", quarantined[0]!))
      ).isSymbolicLink(),
    ).toBe(true)
  })

  it("quarantines an invalid legacy UUID journal instead of retrying it forever", async () => {
    const root = await garden()
    const recoveryRoot = join(root, ".garden-publisher", "trash-recovery")
    const invalid = join(recoveryRoot, "00000000-0000-4000-8000-000000000000")
    await mkdir(invalid, { recursive: true })
    await writeFile(join(invalid, "journal.json"), "{torn")

    const result = await trashRecovery.reconcileTrashRecoveryPass(
      root,
      () => internalRecoveryKey(root, true),
      { openDirectory: sortedDirectory },
    )

    expect(result.pending).toBe(false)
    await expect(lstat(invalid)).rejects.toMatchObject({ code: "ENOENT" })
    const quarantined = await readdir(join(recoveryRoot, "legacy-quarantine", "000"))
    expect(quarantined).toHaveLength(1)
    await expect(
      readFile(
        join(recoveryRoot, "legacy-quarantine", "000", quarantined[0]!, "journal.json"),
        "utf8",
      ),
    ).resolves.toBe("{torn")
  })

  it("leaves a torn queue tail unconsumed until the next append repairs it", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "alpha.md"), "# Alpha")
    await recycleAndRestore(root, "content/life/alpha.md")
    const segment = join(
      root,
      ".garden-publisher",
      "trash-recovery",
      "queue",
      "0000000000000000.log",
    )
    const handle = await nodeOpen(segment, "a")
    await handle.writeFile('{"version":1,"id":"torn')
    await handle.close()

    const first = await trashRecovery.reconcileTrashRecoveryPass(root, () =>
      internalRecoveryKey(root, false),
    )
    expect(first.restored).toContain("content/life/alpha.md")
    expect(first.pending).toBe(false)
    const before = await readFile(segment)
    const cursorPath = join(root, ".garden-publisher", "trash-recovery", "cursor.json")
    const cursorBefore = JSON.parse(await readFile(cursorPath, "utf8")) as Record<string, unknown>
    const second = await trashRecovery.reconcileTrashRecoveryPass(root, () =>
      internalRecoveryKey(root, false),
    )
    expect(second).toEqual({ restored: [], conflicts: [], pending: false })
    expect(await readFile(segment)).toEqual(before)
    const cursorAfter = JSON.parse(await readFile(cursorPath, "utf8")) as Record<string, unknown>
    expect({ segment: cursorAfter.queueSegment, offset: cursorAfter.queueOffset }).toEqual({
      segment: cursorBefore.queueSegment,
      offset: cursorBefore.queueOffset,
    })

    await writeFile(join(root, "content", "life", "beta.md"), "# Beta")
    await recycleAndRestore(root, "content/life/beta.md")
    expect((await readFile(segment, "utf8")).endsWith("\n")).toBe(true)
    const repaired = await trashRecovery.reconcileTrashRecoveryPass(root, () =>
      internalRecoveryKey(root, false),
    )
    expect(repaired.restored).toContain("content/life/beta.md")
  })

  it("reads a complete record across 64 KiB before advancing to the following segment", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "boundary-alpha.md"), "# Alpha")
    await writeFile(join(root, "content", "life", "boundary-beta.md"), "# Beta")
    await stageFile(root, "content/life/boundary-alpha.md")
    await stageFile(root, "content/life/boundary-beta.md")
    const queue = join(root, ".garden-publisher", "trash-recovery", "queue")
    const firstSegment = join(queue, "0000000000000000.log")
    const records = (await readFile(firstSegment, "utf8")).trimEnd().split("\n")
    expect(records).toHaveLength(2)
    await writeFile(
      firstSegment,
      Buffer.concat([Buffer.alloc(65_500, 0x0a), Buffer.from(`${records[0]}\n`)]),
    )
    await writeFile(join(queue, "0000000000000001.log"), `${records[1]}\n`)

    const restored: string[] = []
    for (let pass = 0; pass < 6 && restored.length < 2; pass += 1) {
      const result = await trashRecovery.reconcileTrashRecoveryPass(
        root,
        () => internalRecoveryKey(root, false),
        { now: () => 0 },
      )
      restored.push(...result.restored)
    }

    expect(restored.sort()).toEqual([
      "content/life/boundary-alpha.md",
      "content/life/boundary-beta.md",
    ])
    expect(new Set(restored).size).toBe(2)
  })

  it("syncs a new queue file before its parent and propagates either sync failure", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "durable.md"), "# Durable")
    const events: string[] = []
    let failFileSync = false
    let failDirectorySync = true
    const openFile: NonNullable<trashRecovery.TrashRecoveryPrepareOptions["openFile"]> = async (
      path,
      flags,
      mode,
    ) => {
      const handle = await nodeOpen(path, flags, mode)
      const normalized = path.replaceAll("\\", "/")
      const queueDirectory = normalized.endsWith("/.garden-publisher/trash-recovery/queue")
      const queueSegment = /\/queue\/[a-f0-9]{16}\.log$/.test(normalized)
      if (!queueDirectory && !queueSegment) return handle
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        events.push(queueSegment ? "file-sync" : "directory-sync")
        if (queueSegment && failFileSync) throw new Error("injected file sync failure")
        if (queueDirectory && failDirectorySync) throw new Error("injected directory sync failure")
        await sync()
      }
      return handle
    }

    const directorySyncFailure = await stageFile(root, "content/life/durable.md", {
      openFile,
    }).catch((error: unknown) => error)
    expect(events).toEqual(["file-sync", "directory-sync"])
    expect(directorySyncFailure).toMatchObject({ message: "injected directory sync failure" })

    events.length = 0
    failDirectorySync = false
    failFileSync = true
    await writeFile(join(root, "content", "life", "durable-file.md"), "# Durable file")
    const fileSyncFailure = await stageFile(root, "content/life/durable-file.md", {
      openFile,
    }).catch((error: unknown) => error)
    expect(events).toEqual(["file-sync"])
    expect(fileSyncFailure).toMatchObject({ message: "injected file sync failure" })
  })

  it("syncs a newly created queue through its recovery parent before publishing records", async () => {
    const root = await garden()
    const original = join(root, "content", "life", "durable-queue.md")
    const queue = join(root, ".garden-publisher", "trash-recovery", "queue")
    await writeFile(original, "# Durable queue")
    const events: string[] = []
    let failRecoveryParentSync = false
    const openFile: NonNullable<trashRecovery.TrashRecoveryPrepareOptions["openFile"]> = async (
      path,
      flags,
      mode,
    ) => {
      const handle = await nodeOpen(path, flags, mode)
      const normalized = path.replaceAll("\\", "/")
      const recoveryParent =
        normalized.endsWith("/.garden-publisher/trash-recovery") && existsSync(join(path, "queue"))
      const queueDirectory = normalized.endsWith("/.garden-publisher/trash-recovery/queue")
      const queueSegment = /\/queue\/[a-f0-9]{16}\.log$/.test(normalized)
      if (!recoveryParent && !queueDirectory && !queueSegment) return handle
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        const event = recoveryParent
          ? "recovery-parent-sync"
          : queueSegment
            ? "queue-file-sync"
            : "queue-directory-sync"
        events.push(event)
        if (recoveryParent && failRecoveryParentSync) {
          throw new Error("injected recovery parent sync failure")
        }
        await sync()
      }
      return handle
    }

    await stageFile(root, "content/life/durable-queue.md", { openFile })
    expect(events).toEqual(["recovery-parent-sync", "queue-file-sync", "queue-directory-sync"])

    const failureRoot = await garden()
    const failureOriginal = join(failureRoot, "content", "life", "durable-queue-failure.md")
    await writeFile(failureOriginal, "# Durable queue failure")
    events.length = 0
    failRecoveryParentSync = true
    await expect(
      stageFile(failureRoot, "content/life/durable-queue-failure.md", { openFile }),
    ).rejects.toThrow("injected recovery parent sync failure")
    await expect(readFile(failureOriginal, "utf8")).resolves.toBe("# Durable queue failure")
    const failureQueue = join(failureRoot, ".garden-publisher", "trash-recovery", "queue")
    expect((await readdir(failureQueue)).filter((name) => name.endsWith(".log"))).toEqual([])
  })

  it("syncs the journal and transaction directory before publishing its queue record", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "journal-order.md"), "# Journal order")
    const events: string[] = []
    let failJournalSync = false
    const openFile: NonNullable<trashRecovery.TrashRecoveryPrepareOptions["openFile"]> = async (
      path,
      flags,
      mode,
    ) => {
      const handle = await nodeOpen(path, flags, mode)
      const normalized = path.replaceAll("\\", "/")
      const journal = /\/indexed-transactions\/[a-f0-9]{2}\/[a-f0-9-]{36}\/journal\.json$/.test(
        normalized,
      )
      const transactionDirectory = /\/indexed-transactions\/[a-f0-9]{2}\/[a-f0-9-]{36}$/.test(
        normalized,
      )
      const queueSegment = /\/queue\/[a-f0-9]{16}\.log$/.test(normalized)
      if (!journal && !transactionDirectory && !queueSegment) return handle
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        const event = journal
          ? "journal-file-sync"
          : transactionDirectory
            ? "transaction-directory-sync"
            : "queue-file-sync"
        events.push(event)
        if (journal && failJournalSync) throw new Error("injected journal sync failure")
        await sync()
      }
      return handle
    }

    await stageFile(root, "content/life/journal-order.md", { openFile })
    const journalSync = events.indexOf("journal-file-sync")
    const queueSync = events.indexOf("queue-file-sync")
    expect(journalSync).toBeGreaterThanOrEqual(0)
    expect(queueSync).toBeGreaterThan(journalSync)
    expect(events.slice(journalSync + 1, queueSync)).toContain("transaction-directory-sync")

    const failureRoot = await garden()
    const original = join(failureRoot, "content", "life", "journal-failure.md")
    await writeFile(original, "# Journal failure")
    events.length = 0
    failJournalSync = true
    await expect(
      stageFile(failureRoot, "content/life/journal-failure.md", { openFile }),
    ).rejects.toThrow("injected journal sync failure")
    expect(events).toContain("journal-file-sync")
    expect(events).not.toContain("queue-file-sync")
    await expect(readFile(original, "utf8")).resolves.toBe("# Journal failure")
  })

  it("reclaims a crashed append owner only after its durable lease expires", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "lease-seed.md"), "# Seed")
    await stageFile(root, "content/life/lease-seed.md")
    const lease = join(root, ".garden-publisher", "trash-recovery", "queue", ".append.lock")
    await writeFile(
      lease,
      JSON.stringify({
        version: 1,
        token: "00000000-0000-4000-8000-000000000000",
        pid: 424_242,
        createdAt: 0,
        leaseExpiresAt: 10,
      }),
      { flag: "wx", mode: 0o600 },
    )
    await writeFile(join(root, "content", "life", "lease-reclaimed.md"), "# Reclaimed")

    const stage = await stageFile(root, "content/life/lease-reclaimed.md", {
      appendLeaseMs: 10,
      appendLeaseWaitMs: 10,
      delay: async () => undefined,
      isProcessAlive: (pid) => (pid === 424_242 ? false : true),
      now: () => 100,
    })

    expect(stage.originalRelativePath).toBe("content/life/lease-reclaimed.md")
    await expect(lstat(lease)).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      (await readdir(dirname(lease))).filter((name) => name.startsWith(".append.reclaim-")),
    ).toEqual([])
  })

  it("does not remove another writer's expired but live append lease", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "lease-owner.md"), "# Owner")
    await writeFile(join(root, "content", "life", "lease-contender.md"), "# Contender")
    let releaseOwner!: () => void
    const ownerReleased = new Promise<void>((resolveRelease) => {
      releaseOwner = resolveRelease
    })
    let ownerReachedSegment!: () => void
    const ownerAtSegment = new Promise<void>((resolveReached) => {
      ownerReachedSegment = resolveReached
    })
    const ownerOpen: NonNullable<trashRecovery.TrashRecoveryPrepareOptions["openFile"]> = async (
      path,
      flags,
      mode,
    ) => {
      const normalized = path.replaceAll("\\", "/")
      if (/\/queue\/[a-f0-9]{16}\.log$/.test(normalized)) {
        ownerReachedSegment()
        await ownerReleased
      }
      return nodeOpen(path, flags, mode)
    }
    const owner = stageFile(root, "content/life/lease-owner.md", {
      appendLeaseMs: 1,
      now: () => 0,
      openFile: ownerOpen,
    })
    await ownerAtSegment
    const lease = join(root, ".garden-publisher", "trash-recovery", "queue", ".append.lock")
    await expect(lstat(lease)).resolves.toMatchObject({})
    const metadata: unknown = JSON.parse(await readFile(lease, "utf8"))
    expect(metadata).toMatchObject({
      version: 1,
      pid: process.pid,
      leaseExpiresAt: expect.any(Number),
      token: expect.any(String),
    })

    let contenderSegmentOpens = 0
    const contenderOpen: NonNullable<
      trashRecovery.TrashRecoveryPrepareOptions["openFile"]
    > = async (path, flags, mode) => {
      const normalized = path.replaceAll("\\", "/")
      if (/\/queue\/[a-f0-9]{16}\.log$/.test(normalized)) contenderSegmentOpens += 1
      return nodeOpen(path, flags, mode)
    }

    try {
      let contenderNow = 100
      await expect(
        stageFile(root, "content/life/lease-contender.md", {
          appendLeaseMs: 1,
          appendLeaseWaitMs: 2,
          delay: async () => undefined,
          isProcessAlive: (pid) => pid === process.pid,
          now: () => contenderNow++,
          openFile: contenderOpen,
        }),
      ).rejects.toMatchObject({ code: "EEXIST" })
      expect(contenderSegmentOpens).toBe(0)
      await expect(lstat(lease)).resolves.toMatchObject({})
    } finally {
      releaseOwner()
      await owner
    }
    await expect(lstat(lease)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not move a live successor after two reclaimers validate the same stale lease", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "reclaim-seed.md"), "# Seed")
    await stageFile(root, "content/life/reclaim-seed.md")
    const lease = join(root, ".garden-publisher", "trash-recovery", "queue", ".append.lock")
    await writeFile(
      lease,
      JSON.stringify({
        version: 1,
        token: "10000000-0000-4000-8000-000000000000",
        pid: 424_242,
        createdAt: 0,
        leaseExpiresAt: 10,
      }),
      { flag: "wx", mode: 0o600 },
    )
    await writeFile(join(root, "content", "life", "reclaim-first.md"), "# First")
    await writeFile(join(root, "content", "life", "reclaim-second.md"), "# Second")

    let releaseSecondValidation!: () => void
    const secondValidationReleased = new Promise<void>((resolveRelease) => {
      releaseSecondValidation = resolveRelease
    })
    let markSecondValidated!: () => void
    const secondValidated = new Promise<void>((resolveValidated) => {
      markSecondValidated = resolveValidated
    })
    let secondLeaseReads = 0
    let liveSuccessorMoved = false
    let secondSegmentOpens = 0
    let secondNow = 100
    const secondOpen: NonNullable<trashRecovery.TrashRecoveryPrepareOptions["openFile"]> = async (
      path,
      flags,
      mode,
    ) => {
      const normalized = path.replaceAll("\\", "/")
      const handle = await nodeOpen(path, flags, mode)
      if (normalized.endsWith("/queue/.append.lock")) {
        secondLeaseReads += 1
        if (secondLeaseReads === 2) {
          const close = handle.close.bind(handle)
          handle.close = async () => {
            await close()
            markSecondValidated()
            await secondValidationReleased
          }
        }
      }
      if (normalized.includes("/queue/.append.lock.quarantine-")) {
        await expect(lstat(lease)).rejects.toMatchObject({ code: "ENOENT" })
        liveSuccessorMoved = true
      }
      if (/\/queue\/[a-f0-9]{16}\.log$/.test(normalized)) secondSegmentOpens += 1
      return handle
    }
    const second = stageFile(root, "content/life/reclaim-second.md", {
      appendLeaseMs: 10,
      appendLeaseWaitMs: 50,
      delay: async () => undefined,
      isProcessAlive: (pid) => pid === process.pid,
      now: () => secondNow++,
      openFile: secondOpen,
    })
    await secondValidated

    let releaseFirst!: () => void
    const firstReleased = new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease
    })
    let markFirstPublished!: () => void
    const firstPublished = new Promise<void>((resolvePublished) => {
      markFirstPublished = resolvePublished
    })
    const firstOpen: NonNullable<trashRecovery.TrashRecoveryPrepareOptions["openFile"]> = async (
      path,
      flags,
      mode,
    ) => {
      if (/\/queue\/[a-f0-9]{16}\.log$/.test(path.replaceAll("\\", "/"))) {
        markFirstPublished()
        await firstReleased
      }
      return nodeOpen(path, flags, mode)
    }
    const first = stageFile(root, "content/life/reclaim-first.md", {
      appendLeaseMs: 10,
      isProcessAlive: (pid) => pid === process.pid,
      now: () => 100,
      openFile: firstOpen,
    })
    await firstPublished
    releaseSecondValidation()
    await expect(second).rejects.toMatchObject({ code: "EEXIST" })
    expect(secondSegmentOpens).toBe(0)
    releaseFirst()
    await first

    expect(liveSuccessorMoved).toBe(false)
  })

  it("rotates an at-cap queue and eventually processes the next segment", async () => {
    const root = await garden()
    const queue = join(root, ".garden-publisher", "trash-recovery", "queue")
    await mkdir(queue, { recursive: true })
    await writeFile(join(queue, "0000000000000000.log"), Buffer.alloc(1024 * 1024, 0x0a))
    await writeFile(join(root, "content", "life", "rotated.md"), "# Rotated")
    await recycleAndRestore(root, "content/life/rotated.md")

    await expect(lstat(join(queue, "0000000000000001.log"))).resolves.toMatchObject({
      size: expect.any(Number),
    })
    const restored: string[] = []
    for (let pass = 0; pass < 24 && restored.length === 0; pass += 1) {
      const result = await trashRecovery.reconcileTrashRecoveryPass(root, () =>
        internalRecoveryKey(root, false),
      )
      restored.push(...result.restored)
    }
    expect(restored).toContain("content/life/rotated.md")
  })

  it("rolls back a file link when the pass aborts after mutation", async () => {
    const root = await garden()
    await writeFile(join(root, "content", "life", "rollback.md"), "# Rollback")
    const stage = await stageFile(root, "content/life/rollback.md")

    const abortAfterMutation = {
      get aborted() {
        return existsSync(stage.originalPath)
      },
    } as AbortSignal
    await expect(
      trashRecovery.reconcileTrashRecoveryPass(root, () => internalRecoveryKey(root, false), {
        signal: abortAfterMutation,
      }),
    ).resolves.toEqual({ restored: [], conflicts: [], pending: true })
    await expect(lstat(stage.originalPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(stage.stagedPath, "utf8")).resolves.toBe("# Rollback")

    const completed = await trashRecovery.reconcileTrashRecoveryPass(root, () =>
      internalRecoveryKey(root, false),
    )
    expect(completed.restored).toContain("content/life/rollback.md")
    await expect(readFile(stage.originalPath, "utf8")).resolves.toBe("# Rollback")
  })

  it("rolls back a directory rename when the pass aborts after mutation", async () => {
    const root = await garden()
    const attachment = join(root, "content", "_assets", "rollback")
    await mkdir(attachment, { recursive: true })
    const stage = await stageDirectory(root, "content/_assets/rollback")

    const abortAfterMutation = {
      get aborted() {
        return existsSync(stage.originalPath)
      },
    } as AbortSignal
    await expect(
      trashRecovery.reconcileTrashRecoveryPass(root, () => internalRecoveryKey(root, false), {
        signal: abortAfterMutation,
      }),
    ).resolves.toEqual({ restored: [], conflicts: [], pending: true })
    await expect(lstat(stage.originalPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(stage.stagedPath)).resolves.toMatchObject({})

    const completed = await trashRecovery.reconcileTrashRecoveryPass(root, () =>
      internalRecoveryKey(root, false),
    )
    expect(completed.restored).toContain("content/_assets/rollback")
    await expect(lstat(stage.originalPath)).resolves.toMatchObject({})
  })

  it.each([
    {
      kind: "file" as const,
      relativePath: "content/life/retry-file.md",
      create: async (root: string) => {
        await writeFile(join(root, "content", "life", "retry-file.md"), "# Retry file")
        return stageFile(root, "content/life/retry-file.md")
      },
    },
    {
      kind: "directory" as const,
      relativePath: "content/_assets/retry-directory",
      create: async (root: string) => {
        await mkdir(join(root, "content", "_assets", "retry-directory"), { recursive: true })
        return stageDirectory(root, "content/_assets/retry-directory")
      },
    },
  ])(
    "retries a rolled-back $kind after an ordinary post-mutation error",
    async ({ relativePath, create }) => {
      const root = await garden()
      const stage = await create(root)
      let injected = false
      const ordinaryFailureAfterMutation = {
        get aborted() {
          if (!injected && existsSync(stage.originalPath)) {
            injected = true
            throw new Error("injected verification I/O failure")
          }
          return false
        },
      } as AbortSignal

      const deferred = await trashRecovery.reconcileTrashRecoveryPass(
        root,
        () => internalRecoveryKey(root, false),
        { signal: ordinaryFailureAfterMutation },
      )
      expect(deferred).toEqual({ restored: [], conflicts: [], pending: true })
      await expect(lstat(stage.originalPath)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(lstat(stage.stagedPath)).resolves.toMatchObject({})

      const completed = await trashRecovery.reconcileTrashRecoveryPass(root, () =>
        internalRecoveryKey(root, false),
      )
      expect(completed.restored).toContain(relativePath)
      expect(completed.conflicts).toEqual([])
    },
  )

  it("defers during attachment hashing without advancing or deleting the journal", async () => {
    const root = await garden()
    const attachments = join(root, "content", "_assets", "daily")
    await mkdir(attachments, { recursive: true })
    await writeFile(join(attachments, "large.bin"), Buffer.alloc(1024 * 1024, 0x61))
    await writeFile(join(root, "content", "life", "daily.md"), "# Daily")
    const recycle = await mkdtemp(join(tmpdir(), "garden-recovery-deadline-"))
    temporaryDirectories.push(recycle)
    const staged: string[] = []
    const { trashManagedNote } = await import("../../src/main/services/trash")
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
    // Complete legacy discovery and consume the temporarily absent queue entries.
    await trashRecovery.reconcileTrashRecoveryPass(root, () => internalRecoveryKey(root, false))
    await rename(join(recycle, "item-2"), staged[1]!)

    let checkpoints = 0
    const deferred = await trashRecovery.reconcileTrashRecoveryPass(
      root,
      () => internalRecoveryKey(root, false),
      {
        maximumElapsedMs: 10,
        now: () => checkpoints++,
      },
    )

    expect(deferred).toEqual({ restored: [], conflicts: [], pending: true })
    await expect(readFile(join(staged[1]!, "large.bin"))).resolves.toHaveLength(1024 * 1024)
    await expect(readFile(join(root, "content", "_assets", "daily", "large.bin"))).rejects.toThrow()
    const completed = await trashRecovery.reconcileTrashRecoveryPass(root, () =>
      internalRecoveryKey(root, false),
    )
    expect(completed.restored).toContain("content/_assets/daily")
  })
})
