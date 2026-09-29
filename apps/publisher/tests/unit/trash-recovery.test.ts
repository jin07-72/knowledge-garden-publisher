import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

describe("trash recovery directory bounds", () => {
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
      /\.garden-publisher\/trash-recovery\/transactions\/[a-f0-9]{2}\/[a-f0-9-]{36}\/items\/content\/life\/daily\.md$/i,
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

    await expect(
      trashRecovery.reconcileTrashRecovery(root, () => internalRecoveryKey(root, false)),
    ).resolves.toEqual({ restored: ["content/life/legacy.md"], conflicts: [] })
  })
})
