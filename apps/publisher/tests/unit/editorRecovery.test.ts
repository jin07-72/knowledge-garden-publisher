import { createHash } from "node:crypto"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  discardEditorRecovery,
  getEditorRecovery,
  writeEditorRecovery,
} from "../../src/main/services/editorRecovery"
import { listRecoveries } from "../../src/main/services/noteFiles"

const roots: string[] = []
const path = "private/life/journal.md"

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

async function garden(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-editor-recovery-"))
  roots.push(root)
  await Promise.all([
    mkdir(join(root, "content", "life"), { recursive: true }),
    mkdir(join(root, "private", "life"), { recursive: true }),
  ])
  await writeFile(join(root, path), "# saved\n")
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("editor recovery", () => {
  it("returns no draft before the recovery key has ever been initialized", async () => {
    const workspace = await garden()
    await expect(getEditorRecovery(workspace, { path })).resolves.toBeUndefined()
    await expect(
      discardEditorRecovery(
        workspace,
        { path, contentHash: "a".repeat(64) },
        {
          trashItem: async () => undefined,
        },
      ),
    ).resolves.toBeUndefined()
  })

  it("round-trips exact private Markdown in the isolated editor namespace", async () => {
    const workspace = await garden()
    const markdown = "---\r\ntitle: Private\r\n---\r\nPRIVATE_BODY\r\n"
    const receipt = await writeEditorRecovery(workspace, {
      path,
      markdown,
      baseMtimeMs: 1,
      baseContentHash: "a".repeat(64),
    })

    await expect(getEditorRecovery(workspace, { path })).resolves.toMatchObject({
      path,
      markdown,
      contentHash: receipt.contentHash,
    })
    await expect(listRecoveries(workspace)).resolves.toEqual([])
    const files = await readdir(join(workspace, ".garden-publisher", "editor-recovery"))
    expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(1)
  })

  it("allocates recovery reads from the verified file size instead of the global limit", async () => {
    const workspace = await garden()
    await writeEditorRecovery(workspace, {
      path,
      markdown: "small authenticated draft",
      baseMtimeMs: 1,
      baseContentHash: "a".repeat(64),
    })
    const file = join(workspace, ".garden-publisher", "editor-recovery", `${hash(path)}.json`)
    const size = (await stat(file)).size
    const allocation = vi.spyOn(Buffer, "alloc")

    await expect(getEditorRecovery(workspace, { path })).resolves.toMatchObject({
      markdown: "small authenticated draft",
    })

    expect(allocation).toHaveBeenCalledWith(size + 1)
    expect(Math.max(...allocation.mock.calls.map(([bytes]) => bytes))).toBeLessThanOrEqual(
      16 * 1024 * 1024 + 1,
    )
  })

  it("does not let an old save discard a newer crash-recovery buffer", async () => {
    const workspace = await garden()
    const first = await writeEditorRecovery(workspace, {
      path,
      markdown: "first private buffer",
      baseMtimeMs: 1,
      baseContentHash: "a".repeat(64),
    })
    const secondMarkdown = "newer private buffer"
    const second = await writeEditorRecovery(workspace, {
      path,
      markdown: secondMarkdown,
      baseMtimeMs: 1,
      baseContentHash: "a".repeat(64),
    })
    const trashed: string[] = []
    const trash = { trashItem: async (target: string) => void trashed.push(target) }

    await discardEditorRecovery(workspace, { path, contentHash: first.contentHash }, trash)
    expect(trashed).toEqual([])
    await expect(getEditorRecovery(workspace, { path })).resolves.toMatchObject({
      markdown: secondMarkdown,
    })

    await discardEditorRecovery(workspace, { path, contentHash: second.contentHash }, trash)
    expect(trashed).toHaveLength(0)
    await expect(getEditorRecovery(workspace, { path })).resolves.toBeUndefined()
  })

  it("rejects oversized or unmanaged input without echoing private content", async () => {
    const workspace = await garden()
    await expect(
      writeEditorRecovery(workspace, {
        path,
        markdown: "x".repeat(16 * 1024 * 1024 + 1),
        baseMtimeMs: 1,
        baseContentHash: hash("saved"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    await expect(
      getEditorRecovery(workspace, { path: "private/life/../../outside.md" }),
    ).rejects.not.toThrow("PRIVATE_BODY")
  })

  it("rejects a pre-existing state junction before creating anything through it", async ({
    skip,
  }) => {
    const workspace = await garden()
    const outside = await mkdtemp(join(tmpdir(), "garden-editor-recovery-outside-"))
    roots.push(outside)
    try {
      await symlink(outside, join(workspace, ".garden-publisher"), "junction")
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) skip()
      throw error
    }
    await expect(
      writeEditorRecovery(workspace, {
        path,
        markdown: "private draft",
        baseMtimeMs: 1,
        baseContentHash: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_INVALID" })
    await expect(access(join(outside, "editor-recovery"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects a corrupt HMAC key and a swapped draft symlink", async ({ skip }) => {
    const workspace = await garden()
    await writeEditorRecovery(workspace, {
      path,
      markdown: "authenticated private draft",
      baseMtimeMs: 1,
      baseContentHash: "a".repeat(64),
    })
    const state = join(workspace, ".garden-publisher")
    const file = join(state, "editor-recovery", `${hash(path)}.json`)
    await writeFile(join(state, "keys", "recovery-hmac.key"), "corrupt")
    await expect(getEditorRecovery(workspace, { path })).rejects.toMatchObject({
      code: "RECOVERY_INVALID",
    })

    const second = await garden()
    await writeEditorRecovery(second, {
      path,
      markdown: "draft to swap",
      baseMtimeMs: 1,
      baseContentHash: "a".repeat(64),
    })
    const secondFile = join(second, ".garden-publisher", "editor-recovery", `${hash(path)}.json`)
    const outside = join(second, "outside.json")
    await writeFile(
      outside,
      await import("node:fs/promises").then(({ readFile }) => readFile(secondFile)),
    )
    await unlink(secondFile)
    try {
      await symlink(outside, secondFile, "file")
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) skip()
      throw error
    }
    await expect(getEditorRecovery(second, { path })).rejects.toMatchObject({
      code: "RECOVERY_INVALID",
    })
    await expect(access(file)).resolves.toBeUndefined()
  })

  it("publishes one authenticated result under concurrent writes without leaving staging files", async () => {
    const workspace = await garden()
    const requests = ["first concurrent draft", "second concurrent draft"].map((markdown) =>
      writeEditorRecovery(workspace, {
        path,
        markdown,
        baseMtimeMs: 1,
        baseContentHash: "a".repeat(64),
      }),
    )
    const receipts = await Promise.all(requests)
    const recovered = await getEditorRecovery(workspace, { path })
    expect(receipts.map(({ contentHash }) => contentHash)).toContain(recovered?.contentHash)
    expect(
      (await readdir(join(workspace, ".garden-publisher", "editor-recovery"))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([])
  })

  it("rejects a draft when authenticated metadata, body, or integrity is changed", async () => {
    const workspace = await garden()
    await writeEditorRecovery(workspace, {
      path,
      markdown: "private body before tamper",
      baseMtimeMs: 1,
      baseContentHash: "a".repeat(64),
    })
    const file = join(workspace, ".garden-publisher", "editor-recovery", `${hash(path)}.json`)
    const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    stored.markdown = "private body after tamper"
    await writeFile(file, JSON.stringify(stored))
    await expect(getEditorRecovery(workspace, { path })).rejects.toMatchObject({
      code: "RECOVERY_INVALID",
    })
  })

  it("keeps the 500-entry retention boundary without deleting the active authenticated draft", async () => {
    const workspace = await garden()
    const request = {
      path,
      markdown: "active private recovery",
      baseMtimeMs: 1,
      baseContentHash: "a".repeat(64),
    }
    await writeEditorRecovery(workspace, request)
    const root = join(workspace, ".garden-publisher", "editor-recovery")
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        writeFile(join(root, `${index.toString(16).padStart(64, "0")}.json`), "stale"),
      ),
    )
    await writeEditorRecovery(workspace, request)
    const retained = (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    expect(retained).toHaveLength(500)
    await expect(getEditorRecovery(workspace, { path })).resolves.toMatchObject({
      markdown: request.markdown,
    })
  })
})
