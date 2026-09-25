import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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
    const files = await readdir(join(workspace, ".garden-publisher", "recovery", "editor"))
    expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(1)
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
    expect(trashed).toHaveLength(1)
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
})
