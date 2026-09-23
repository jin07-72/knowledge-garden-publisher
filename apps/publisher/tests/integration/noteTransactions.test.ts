import { execFile } from "node:child_process"
import { createHash, createHmac, randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  createNote,
  executeRename as executeRenameRaw,
  executeVisibilityChange as executeVisibilityChangeRaw,
  DEFAULT_TRANSACTION_GLOBAL_RETENTION,
  DEFAULT_TRANSACTION_PER_NOTE_RETENTION,
  MAX_TRANSACTION_RETENTION_SCAN,
  MAX_TRANSACTION_RETENTION_TRASH_CALLS,
  MAX_TRANSACTION_MANIFEST_BYTES,
  inspectPendingTransactions,
  planRename,
  planVisibilityChange,
  saveNote,
  type NoteFileAdapter,
  type NoteTransactionAdapter,
} from "../../src/main/services/noteFiles"

const run = promisify(execFile)
const roots: string[] = []

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`
}

function authenticate(key: Buffer, value: unknown): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex")
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
  )
}

async function garden(options: { git?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-note-transactions-"))
  roots.push(root)
  for (const top of ["content", "private"]) {
    await mkdir(join(root, top, "_assets"), { recursive: true })
    for (const domain of ["technology", "reading", "language", "life"]) {
      await mkdir(join(root, top, domain), { recursive: true })
    }
  }
  if (options.git) await run("git", ["init", "--quiet"], { cwd: root })
  return root
}

async function put(root: string, path: string, contents: string | Buffer): Promise<void> {
  const target = join(root, ...path.split("/"))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

async function putAssetTree(root: string, visibility: "content" | "private", count: number) {
  const directory = join(root, visibility, "_assets", "topic")
  await mkdir(directory, { recursive: true })
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      writeFile(join(directory, `${String(index).padStart(4, "0")}.bin`), `asset-${index}`),
    ),
  )
}

async function revision(
  root: string,
  path: string,
): Promise<{ expectedMtimeMs: number; expectedContentHash: string }> {
  const target = join(root, ...path.split("/"))
  const [details, bytes] = await Promise.all([lstat(target), readFile(target)])
  return { expectedMtimeMs: details.mtimeMs, expectedContentHash: hash(bytes) }
}

const noTrash = { trashItem: async () => undefined }

type OptionalTrashContext = Omit<
  Parameters<typeof executeVisibilityChangeRaw>[1],
  "transactionTrash"
> & {
  transactionTrash?: Parameters<typeof executeVisibilityChangeRaw>[1]["transactionTrash"]
}

function executeVisibilityChange(
  plan: Parameters<typeof executeVisibilityChangeRaw>[0],
  context: OptionalTrashContext,
) {
  return executeVisibilityChangeRaw(plan, { transactionTrash: noTrash, ...context })
}

function executeRename(
  plan: Parameters<typeof executeRenameRaw>[0],
  context: OptionalTrashContext,
) {
  return executeRenameRaw(plan, { transactionTrash: noTrash, ...context })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("note visibility transactions", () => {
  it("moves a public note and its nested owned attachments and reports the public deletion", async () => {
    const workspace = await garden({ git: true })
    const markdown = Buffer.from(
      "---\r\ntitle: Weekly\r\n---\r\n\r\n![chart](../_assets/weekly-review/nested/chart%20one.png)\r\n",
    )
    const attachment = Buffer.from([0, 1, 2, 255])
    await put(workspace, "content/life/weekly-review.md", markdown)
    await put(workspace, "content/_assets/weekly-review/nested/chart one.png", attachment)

    const plan = await planVisibilityChange({
      workspace,
      path: "content/life/weekly-review.md",
      visibility: "private",
    })
    expect(JSON.stringify(plan)).not.toContain("title: Weekly")
    expect(plan.moves.map(({ source, target }) => [source, target])).toEqual([
      ["content/life/weekly-review.md", "private/life/weekly-review.md"],
      [
        "content/_assets/weekly-review/nested/chart one.png",
        "private/_assets/weekly-review/nested/chart one.png",
      ],
    ])
    expect(plan.collisionChecks.map(({ path }) => path)).toEqual([
      "private/life/weekly-review.md",
      "private/_assets/weekly-review",
      "private/_assets/weekly-review/nested/chart one.png",
    ])

    const result = await executeVisibilityChange(plan, { workspace })

    expect(result.pendingPublicDeletion).toBe("content/life/weekly-review.md")
    expect(await readFile(join(workspace, "private/life/weekly-review.md"))).toEqual(markdown)
    expect(
      await readFile(join(workspace, "private/_assets/weekly-review/nested/chart one.png")),
    ).toEqual(attachment)
    expect(await exists(join(workspace, "content/_assets/weekly-review"))).toBe(false)
  })

  it("moves a private note into public storage without a pending deletion", async () => {
    const workspace = await garden()
    const markdown = "---\ntitle: Private\n---\n\nsecret body\n"
    await put(workspace, "private/reading/private-note.md", markdown)

    const plan = await planVisibilityChange({
      workspace,
      path: "private/reading/private-note.md",
      visibility: "public",
    })
    const result = await executeVisibilityChange(plan, { workspace })

    expect(result.pendingPublicDeletion).toBeUndefined()
    expect(await readFile(join(workspace, "content/reading/private-note.md"), "utf8")).toBe(
      markdown,
    )
    expect(await exists(join(workspace, "private/reading/private-note.md"))).toBe(false)
  })

  it("reports whether a public source is tracked without taking Git locks", async () => {
    const workspace = await garden({ git: true })
    await put(workspace, "content/life/tracked.md", "---\ntitle: Tracked\n---\n")
    await put(workspace, "content/life/untracked.md", "---\ntitle: Untracked\n---\n")
    await run("git", ["add", "content/life/tracked.md"], { cwd: workspace })

    const tracked = await planVisibilityChange({
      workspace,
      path: "content/life/tracked.md",
      visibility: "private",
    })
    const untracked = await planVisibilityChange({
      workspace,
      path: "content/life/untracked.md",
      visibility: "private",
    })

    expect(tracked.historyWarning).toBe(true)
    expect(untracked.historyWarning).toBe(false)
  })

  it("uses read-only Git inspection and never exposes command stderr", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/tracked.md", "---\ntitle: Tracked\n---\nPRIVATE_BODY\n")
    const requests: Array<{
      executable: string
      args: readonly string[]
      cwd: string
      env?: Readonly<Record<string, string | undefined>>
    }> = []
    const runner = {
      async run(request: (typeof requests)[number]) {
        requests.push(request)
        return { exitCode: 2, stdout: "", stderr: `${workspace} PRIVATE_BODY` }
      },
    }

    let failure: unknown
    try {
      await planVisibilityChange({
        workspace,
        path: "content/life/tracked.md",
        visibility: "private",
        runner,
      })
    } catch (error) {
      failure = error
    }

    expect(requests).toEqual([
      expect.objectContaining({
        executable: "git",
        args: ["ls-files", "--error-unmatch", "--", "content/life/tracked.md"],
        cwd: workspace,
        env: { GIT_OPTIONAL_LOCKS: "0" },
      }),
    ])
    expect(failure).toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "GIT_HISTORY_CHECK_FAILED", path: "content/life/tracked.md" },
    })
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_BODY")
    expect(JSON.stringify(failure)).not.toContain(workspace)
  })

  it("returns a typed planning issue when Git history cannot be inspected", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/no-git.md", "---\ntitle: No Git\n---\n")

    await expect(
      planVisibilityChange({ workspace, path: "content/life/no-git.md", visibility: "private" }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "GIT_HISTORY_CHECK_FAILED" },
    })
    expect(await exists(join(workspace, ".garden-publisher"))).toBe(false)
  })

  it("fails closed for note and attachment collisions", async () => {
    const workspace = await garden({ git: true })
    await put(workspace, "content/life/collision.md", "---\ntitle: Source\n---\n")
    await put(workspace, "private/life/collision.md", "---\ntitle: Target\n---\n")

    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/collision.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "TARGET_EXISTS" },
    })

    await rm(join(workspace, "private/life/collision.md"))
    await put(workspace, "content/_assets/collision/a.png", "source")
    await put(workspace, "private/_assets/collision/a.png", "target")
    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/collision.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "ATTACHMENT_TARGET_EXISTS" },
    })
  })

  it("blocks referenced local files outside the owned attachment directory", async () => {
    const workspace = await garden({ git: true })
    await put(
      workspace,
      "content/life/ambiguous.md",
      "---\ntitle: Ambiguous\n---\n\n![shared](../shared.png)\n![[../other/shared.pdf]]\n",
    )
    await put(workspace, "content/shared.png", "shared")

    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/ambiguous.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "AMBIGUOUS_ATTACHMENT" },
    })
  })

  it("blocks missing local attachment references outside the owned attachment directory", async () => {
    const workspace = await garden({ git: true })
    await put(
      workspace,
      "content/life/missing.md",
      "---\ntitle: Missing\n---\n\n![missing](../shared/missing.png)\n",
    )

    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/missing.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "AMBIGUOUS_ATTACHMENT" },
    })
  })

  it("blocks an owned attachment tree referenced by another note", async () => {
    const workspace = await garden({ git: true })
    await put(
      workspace,
      "content/life/topic.md",
      "---\ntitle: Topic\n---\n\n![chart](../_assets/topic/chart.png)\n",
    )
    await put(
      workspace,
      "content/reading/reference.md",
      "---\ntitle: Reference\n---\n\n![shared](../_assets/topic/chart.png)\n",
    )
    await put(workspace, "content/_assets/topic/chart.png", "chart")

    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/topic.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "SHARED_ATTACHMENT" },
    })
  })

  it("blocks reference-style local attachments outside the owned tree", async () => {
    const workspace = await garden({ git: true })
    await put(
      workspace,
      "content/life/references.md",
      [
        "---",
        "title: References",
        "---",
        "",
        "![image][shared]",
        "[download][shared]",
        "",
        '[shared]: ../shared/manual%20copy.pdf "Manual"',
        "",
      ].join("\n"),
    )

    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/references.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "AMBIGUOUS_ATTACHMENT" },
    })
  })

  it("blocks CommonMark angle destinations outside the owned tree", async () => {
    const workspace = await garden({ git: true })
    await put(
      workspace,
      "content/life/angles.md",
      [
        "---",
        "title: Angles",
        "---",
        "",
        '![image](<../shared/chart one.png> "Chart title")',
        "[download](<../shared/manual one.pdf> 'Manual title')",
        "",
      ].join("\n"),
    )

    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/angles.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "AMBIGUOUS_ATTACHMENT" },
    })
  })

  it("fails closed for a malformed local angle destination", async () => {
    const workspace = await garden({ git: true })
    await put(
      workspace,
      "content/life/malformed.md",
      "---\ntitle: Malformed\n---\n\n![image](<../_assets/malformed/chart one.png)\n",
    )

    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/malformed.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "UNSUPPORTED_ATTACHMENT_REFERENCE" },
    })
  })

  it("fails closed for an unresolved local image reference", async () => {
    const workspace = await garden({ git: true })
    await put(
      workspace,
      "content/life/unresolved.md",
      "---\ntitle: Unresolved\n---\n\n![chart][missing-definition]\n",
    )

    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/unresolved.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "UNSUPPORTED_ATTACHMENT_REFERENCE" },
    })
  })

  it("rejects unsafe links inside an owned attachment tree", async () => {
    const workspace = await garden({ git: true })
    const outside = await mkdtemp(join(tmpdir(), "garden-note-attachment-outside-"))
    roots.push(outside)
    await put(workspace, "content/life/unsafe.md", "---\ntitle: Unsafe\n---\n")
    await mkdir(join(workspace, "content/_assets/unsafe"), { recursive: true })
    try {
      await symlink(
        outside,
        join(workspace, "content/_assets/unsafe/junction"),
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return
      throw error
    }

    await expect(
      planVisibilityChange({
        workspace,
        path: "content/life/unsafe.md",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "UNSAFE_ATTACHMENT_ENTRY" },
    })
  })

  it("returns a body-free typed error when transaction state is an unsafe link", async () => {
    const workspace = await garden()
    const outside = await mkdtemp(join(tmpdir(), "garden-note-state-outside-"))
    roots.push(outside)
    await put(workspace, "private/life/unsafe-state.md", "---\ntitle: PRIVATE_SENTINEL\n---\n")
    try {
      await symlink(
        outside,
        join(workspace, ".garden-publisher"),
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return
      throw error
    }

    let failure: unknown
    try {
      await planVisibilityChange({
        workspace,
        path: "private/life/unsafe-state.md",
        visibility: "public",
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: "TRANSACTION_PLAN_BLOCKED" })
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL")
    expect(JSON.stringify(failure)).not.toContain(workspace)
  })

  it("rejects an in-workspace junction in a managed note path", async () => {
    const workspace = await garden()
    await put(workspace, "private/reading/junction-note.md", "---\ntitle: Junction\n---\n")
    await rm(join(workspace, "private/life"), { recursive: true })
    try {
      await symlink(
        join(workspace, "private/reading"),
        join(workspace, "private/life"),
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return
      throw error
    }

    await expect(
      planVisibilityChange({
        workspace,
        path: "private/life/junction-note.md",
        visibility: "public",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
    })
  })

  it("rejects tampered plans, stale sources, and targets created after planning", async () => {
    const workspace = await garden({ git: true })
    await put(workspace, "content/life/change-me.md", "---\ntitle: Original\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "content/life/change-me.md",
      visibility: "private",
    })

    const tampered = structuredClone(plan)
    tampered.moves[0] = { ...tampered.moves[0], target: "private/life/other.md" }
    await expect(executeVisibilityChange(tampered, { workspace })).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_INVALID",
    })

    await put(workspace, "content/life/change-me.md", "---\ntitle: Changed\n---\n")
    await expect(executeVisibilityChange(plan, { workspace })).rejects.toMatchObject({
      code: "TRANSACTION_STALE",
    })

    const fresh = await planVisibilityChange({
      workspace,
      path: "content/life/change-me.md",
      visibility: "private",
    })
    await put(workspace, "private/life/change-me.md", "new collision")
    await expect(executeVisibilityChange(fresh, { workspace })).rejects.toMatchObject({
      code: "TRANSACTION_COLLISION",
    })
  })

  it("rejects a valid plan in a different workspace", async () => {
    const workspace = await garden()
    const other = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(other, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(executeVisibilityChange(plan, { workspace: other })).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_INVALID",
    })
  })

  it("executes a versioned plan after a JSON serialization round trip", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const planned = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    const serialized = JSON.stringify(planned)
    expect(serialized).not.toContain(workspace)
    expect(serialized).not.toContain("title: Topic")

    const plan = JSON.parse(serialized) as typeof planned
    expect(plan.version).toBe(1)
    await expect(executeVisibilityChange(plan, { workspace })).resolves.toMatchObject({
      id: plan.id,
    })
  })

  it("does not overwrite a target created at the publication boundary", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    const external = "late external target"

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async beforePublish(path) {
            if (path === "content/life/topic.md") await put(workspace, path, external)
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_COLLISION" })
    expect(await readFile(join(workspace, "content/life/topic.md"), "utf8")).toBe(external)
    expect(await exists(join(workspace, "private/life/topic.md"))).toBe(true)
  })

  it("does not replace an attachment directory created at the final publication boundary", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "private/_assets/topic/source.txt", "source")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    const external = "late external attachment"

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async beforeAttachmentRootPublish(path: string) {
            expect(path).toBe("content/_assets/topic")
            await put(workspace, "content/_assets/topic/external.txt", external)
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" })
    expect(await readFile(join(workspace, "content/_assets/topic/external.txt"), "utf8")).toBe(
      external,
    )
    expect(await readFile(join(workspace, "private/_assets/topic/source.txt"), "utf8")).toBe(
      "source",
    )
  })
})

describe("note rename transactions", () => {
  it("renames a slug and owned attachments, edits qualified Wiki links, and appends one alias", async () => {
    const workspace = await garden()
    const source = [
      "---",
      "title: Old",
      "aliases:",
      "  - legacy",
      "---",
      "",
      "Body bytes stay here.",
      "",
    ].join("\n")
    await put(workspace, "content/life/old-name.md", source)
    await put(workspace, "content/_assets/old-name/nested/chart.png", "chart")
    await put(
      workspace,
      "content/reading/incoming.md",
      [
        "---",
        "title: Incoming [[life/old-name]]",
        "---",
        "[[life/old-name]]",
        "[[life/old-name|Shown]]",
        "[[life/old-name#Heading]]",
        "![[life/old-name#Part|Embed]]",
        "`[[life/old-name]]`",
        "\\[[life/old-name]]",
        "```md",
        "[[life/old-name]]",
        "```",
        "https://example.invalid/[[life/old-name]]",
        "",
      ].join("\n"),
    )

    const plan = await planRename({
      workspace,
      path: "content/life/old-name.md",
      slug: "new-name",
    })
    expect(plan.linkEdits).toEqual([
      expect.objectContaining({
        path: "content/reading/incoming.md",
        oldTarget: "life/old-name",
        newTarget: "life/new-name",
        count: 4,
      }),
    ])
    const result = await executeRename(plan, { workspace })

    expect(result.changedPaths).toContain("content/life/new-name.md")
    const renamed = await readFile(join(workspace, "content/life/new-name.md"), "utf8")
    expect(renamed).toContain("aliases:\n  - legacy\n  - old-name\n")
    expect((renamed.match(/  - old-name/g) ?? []).length).toBe(1)
    const incoming = await readFile(join(workspace, "content/reading/incoming.md"), "utf8")
    expect((incoming.match(/\[\[life\/new-name/g) ?? []).length).toBe(4)
    expect(incoming).toContain("title: Incoming [[life/old-name]]")
    expect(incoming).toContain("`[[life/old-name]]`")
    expect(incoming).toContain("\\[[life/old-name]]")
    expect(incoming).toContain("https://example.invalid/[[life/old-name]]")
    expect(await exists(join(workspace, "content/_assets/old-name"))).toBe(false)
    expect(
      await readFile(join(workspace, "content/_assets/new-name/nested/chart.png"), "utf8"),
    ).toBe("chart")
  })

  it("updates owned attachment references in the renamed note only in Markdown content", async () => {
    const workspace = await garden()
    await put(
      workspace,
      "content/life/topic.md",
      [
        "---",
        "title: ../_assets/topic/chart.png",
        "---",
        "",
        "![chart](../_assets/topic/chart.png)",
        "![[../_assets/topic/chart.png|Chart]]",
        "`![chart](../_assets/topic/chart.png)`",
        "\\![chart](../_assets/topic/chart.png)",
        "https://example.invalid/_assets/topic/chart.png",
        "",
      ].join("\n"),
    )
    await put(workspace, "content/_assets/topic/chart.png", "chart")

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    const renamed = await readFile(join(workspace, "content/life/renamed.md"), "utf8")
    expect(renamed).toContain("![chart](../_assets/renamed/chart.png)")
    expect(renamed).toContain("![[../_assets/renamed/chart.png|Chart]]")
    expect(renamed).toContain("title: ../_assets/topic/chart.png")
    expect(renamed).toContain("`![chart](../_assets/topic/chart.png)`")
    expect(renamed).toContain("\\![chart](../_assets/topic/chart.png)")
    expect(renamed).toContain("https://example.invalid/_assets/topic/chart.png")
  })

  it("parses and rewrites CommonMark angle destinations with spaces and titles", async () => {
    const workspace = await garden()
    await put(
      workspace,
      "content/life/topic.md",
      [
        "---",
        "title: Topic",
        "angle: '![front](<../_assets/topic/front one.png>)'",
        "---",
        "",
        '![Chart](<../_assets/topic/chart one.png> "Chart title")',
        "[Manual](<../_assets/topic/manual one.pdf> 'Manual title')",
        "[Escaped](<../_assets/topic/escaped\\ file.svg> (Escaped title))",
        "",
        "    ![code](<../_assets/topic/code one.png>)",
        "",
      ].join("\n"),
    )
    await put(workspace, "content/_assets/topic/chart one.png", "chart")
    await put(workspace, "content/_assets/topic/manual one.pdf", "manual")
    await put(workspace, "content/_assets/topic/escaped file.svg", "escaped")

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    const renamed = await readFile(join(workspace, "content/life/renamed.md"), "utf8")
    expect(renamed).toContain('![Chart](<../_assets/renamed/chart one.png> "Chart title")')
    expect(renamed).toContain("[Manual](<../_assets/renamed/manual one.pdf> 'Manual title')")
    expect(renamed).toContain("[Escaped](<../_assets/renamed/escaped\\ file.svg> (Escaped title))")
    expect(renamed).toContain("angle: '![front](<../_assets/topic/front one.png>)'")
    expect(renamed).toContain("    ![code](<../_assets/topic/code one.png>)")
  })

  it("updates owned reference definitions while leaving reference uses and code unchanged", async () => {
    const workspace = await garden()
    await put(
      workspace,
      "content/life/topic.md",
      [
        "---",
        "title: Topic",
        "reference: '[chart]: ../_assets/topic/frontmatter.png'",
        "---",
        "",
        "![Chart][chart]",
        "[Download][]",
        "![shortcut]",
        "",
        '[chart]: <../_assets/topic/chart%20one.png> "Chart"',
        "[download]: ../_assets/topic/download.pdf",
        "[shortcut]: ../_assets/topic/shortcut.svg",
        "",
        "    [code]: ../_assets/topic/code.png",
        "",
      ].join("\n"),
    )
    await put(workspace, "content/_assets/topic/chart one.png", "chart")
    await put(workspace, "content/_assets/topic/download.pdf", "download")
    await put(workspace, "content/_assets/topic/shortcut.svg", "shortcut")

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    const renamed = await readFile(join(workspace, "content/life/renamed.md"), "utf8")
    expect(renamed).toContain("![Chart][chart]")
    expect(renamed).toContain("[Download][]")
    expect(renamed).toContain("![shortcut]")
    expect(renamed).toContain('[chart]: <../_assets/renamed/chart%20one.png> "Chart"')
    expect(renamed).toContain("[download]: ../_assets/renamed/download.pdf")
    expect(renamed).toContain("[shortcut]: ../_assets/renamed/shortcut.svg")
    expect(renamed).toContain("reference: '[chart]: ../_assets/topic/frontmatter.png'")
    expect(renamed).toContain("    [code]: ../_assets/topic/code.png")
  })

  it("moves domains, updates qualified identities, and preserves bytes outside approved edits", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\r\ntitle: Topic\r\n---\r\n\r\nBody\r\n")
    await put(workspace, "private/reading/ref.md", "![[life/topic|Topic]]\r\n")

    const plan = await planRename({
      workspace,
      path: "private/life/topic.md",
      domain: "reading",
    })
    await executeRename(plan, { workspace })

    expect(await readFile(join(workspace, "private/reading/ref.md"), "utf8")).toBe(
      "![[reading/topic|Topic]]\r\n",
    )
    const renamed = await readFile(join(workspace, "private/reading/topic.md"), "utf8")
    expect(renamed).toContain("aliases:\r\n  - life/topic\r\n")
    expect(renamed).toContain("Body\r\n")
  })

  it("keeps the owned attachment directory in place for a pure domain move", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "private/_assets/topic/chart.png", "chart")

    const plan = await planRename({ workspace, path: "private/life/topic.md", domain: "reading" })
    expect(plan.moves.filter(({ kind }) => kind === "attachment")).toEqual([])
    await executeRename(plan, { workspace })

    expect(await readFile(join(workspace, "private/_assets/topic/chart.png"), "utf8")).toBe("chart")
  })

  it("updates an unqualified Wiki link only when the old slug is unique", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "private/reading/ref.md", "[[topic#Part|Topic]]\n")

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    expect(plan.linkEdits).toEqual([
      expect.objectContaining({ oldTarget: "topic", newTarget: "renamed", count: 1 }),
    ])
    await executeRename(plan, { workspace })
    expect(await readFile(join(workspace, "private/reading/ref.md"), "utf8")).toBe(
      "[[renamed#Part|Topic]]\n",
    )
  })

  it("keeps UTF-16 replacement offsets exact when Unicode precedes a Wiki link", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(
      workspace,
      "content/reading/ref.md",
      "🌱 `[[life/topic]]` garden [[life/topic|主题]] end\n",
    )

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    expect(await readFile(join(workspace, "content/reading/ref.md"), "utf8")).toBe(
      "🌱 `[[life/topic]]` garden [[life/renamed|主题]] end\n",
    )
  })

  it("keeps UTF-16 masks aligned around repeated astral characters", async () => {
    const workspace = await garden()
    await put(
      workspace,
      "content/life/topic.md",
      [
        "---",
        "title: 🌱🌱 Topic [[life/topic]]",
        "---",
        "",
        "🌱🌱 `[[life/topic]] ![code](<../_assets/topic/chart one.png>)`",
        "```md",
        "🌱🌱 [[life/topic]] ![fenced](<../_assets/topic/chart one.png>)",
        "```",
        "🌱🌱 [[life/topic]] ![real](<../_assets/topic/chart one.png>)",
        "",
      ].join("\n"),
    )
    await put(workspace, "content/_assets/topic/chart one.png", "chart")

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    const renamed = await readFile(join(workspace, "content/life/renamed.md"), "utf8")
    expect(renamed).toContain("title: 🌱🌱 Topic [[life/topic]]")
    expect(renamed).toContain("🌱🌱 `[[life/topic]] ![code](<../_assets/topic/chart one.png>)`")
    expect(renamed).toContain("🌱🌱 [[life/topic]] ![fenced](<../_assets/topic/chart one.png>)")
    expect(renamed).toContain("🌱🌱 [[life/renamed]] ![real](<../_assets/renamed/chart one.png>)")
  })

  it("does not rewrite Wiki links inside indented code blocks", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "content/reading/ref.md", "    [[life/topic]]\n\nOutside [[life/topic]]\n")

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    expect(await readFile(join(workspace, "content/reading/ref.md"), "utf8")).toBe(
      "    [[life/topic]]\n\nOutside [[life/renamed]]\n",
    )
  })

  it("does not rewrite Wiki links inside an unclosed fenced code block", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(
      workspace,
      "content/reading/ref.md",
      "Outside [[life/topic]]\n\n```md\n[[life/topic]]\n",
    )

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    expect(await readFile(join(workspace, "content/reading/ref.md"), "utf8")).toBe(
      "Outside [[life/renamed]]\n\n```md\n[[life/topic]]\n",
    )
  })

  it("blocks ambiguous unqualified Wiki links", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: Life\n---\n")
    await put(workspace, "content/reading/topic.md", "---\ntitle: Reading\n---\n")
    await put(workspace, "content/technology/ref.md", "[[topic]]\n")

    await expect(
      planRename({ workspace, path: "content/life/topic.md", slug: "renamed" }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "AMBIGUOUS_WIKI_LINK" },
    })
  })

  it("rejects execution when an incoming link file becomes stale", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "content/reading/ref.md", "[[life/topic]]\n")
    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await put(workspace, "content/reading/ref.md", "changed [[life/topic]]\n")

    await expect(executeRename(plan, { workspace })).rejects.toMatchObject({
      code: "TRANSACTION_STALE",
    })
  })

  it("preserves flow aliases and never appends the original alias twice", async () => {
    const workspace = await garden()
    await put(
      workspace,
      "content/life/topic.md",
      "---\ntitle: Topic\naliases: [legacy, topic]\n---\n\nbody\n",
    )
    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    const renamed = await readFile(join(workspace, "content/life/renamed.md"), "utf8")
    expect(renamed).toContain("aliases: [legacy, topic]")
    expect((renamed.match(/topic/g) ?? []).length).toBe(1)
  })

  it("preserves a quoted scalar alias when converting it to a list", async () => {
    const workspace = await garden()
    await put(
      workspace,
      "content/life/topic.md",
      '---\ntitle: Topic\naliases: "legacy: topic"\n---\n\nbody\n',
    )

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    const renamed = await readFile(join(workspace, "content/life/renamed.md"), "utf8")
    expect(renamed).toContain('aliases:\n  - "legacy: topic"\n  - topic\n')
  })

  it("uses the YAML AST to preserve a commented flow alias collection", async () => {
    const workspace = await garden()
    await put(
      workspace,
      "content/life/topic.md",
      "---\ntitle: Topic\naliases: [legacy] # preserve this comment\n---\n\nbody\n",
    )

    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    await executeRename(plan, { workspace })

    const renamed = await readFile(join(workspace, "content/life/renamed.md"), "utf8")
    expect(renamed).toContain("aliases: [ legacy, topic ] # preserve this comment")
    expect(renamed.match(/^aliases:/gm)).toHaveLength(1)
  })

  it("blocks aliases with non-string YAML structures", async () => {
    const workspace = await garden()
    await put(
      workspace,
      "content/life/topic.md",
      "---\ntitle: Topic\naliases: { legacy: true }\n---\n\nbody\n",
    )

    await expect(
      planRename({ workspace, path: "content/life/topic.md", slug: "renamed" }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_BLOCKED",
      details: { issue: "ALIASES_UNSUPPORTED" },
    })
  })
})

describe("transaction recovery", () => {
  it("publishes safe bounded transaction-retention defaults", () => {
    expect(MAX_TRANSACTION_MANIFEST_BYTES).toBe(256 * 1024)
    expect(DEFAULT_TRANSACTION_PER_NOTE_RETENTION).toBe(20)
    expect(DEFAULT_TRANSACTION_GLOBAL_RETENTION).toBeLessThan(MAX_TRANSACTION_RETENTION_SCAN)
    expect(MAX_TRANSACTION_RETENTION_TRASH_CALLS).toBeLessThanOrEqual(
      MAX_TRANSACTION_RETENTION_SCAN,
    )
  })

  it("keeps createNote from recreating a source while its transaction lease is held", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    let entered!: () => void
    let proceed!: () => void
    const paused = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (proceed = resolve))
    const transaction = executeVisibilityChange(plan, {
      workspace,
      transactionTrash: noTrash,
      adapter: {
        async afterPhase(phase) {
          if (phase !== "source-removed") return
          entered()
          await gate
        },
      },
    })
    await paused

    const creation = createNote(
      {
        workspace,
        visibility: "private",
        domain: "life",
        slug: "topic",
        title: "Concurrent recreation",
        date: "2026-09-23",
        description: "Must not race the move",
        tags: ["race"],
      },
      { lockWaitMs: 1, delay: async () => undefined },
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )

    const creationOutcome = await creation
    proceed()
    const transactionOutcome = await transaction
    expect(creationOutcome).toMatchObject({ error: { code: "NOTE_FILE_LOCKED" } })
    expect(transactionOutcome).toMatchObject({ id: plan.id })
    expect(await exists(join(workspace, source))).toBe(false)
    expect(await exists(join(workspace, plan.target))).toBe(true)
  })

  it("makes a transaction lose to a createNote lease already publishing its target", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    let entered!: () => void
    let proceed!: () => void
    const paused = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (proceed = resolve))
    const creation = createNote(
      {
        workspace,
        visibility: "public",
        domain: "life",
        slug: "topic",
        title: "Target winner",
        date: "2026-09-23",
        description: "Owns the target first",
        tags: ["race"],
      },
      {
        async beforeLockRelease() {
          entered()
          await gate
        },
      },
    )
    await expect(
      Promise.race([
        paused.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]),
    ).resolves.toBe(true)

    const transactionOutcome = await executeVisibilityChange(plan, {
      workspace,
      transactionTrash: noTrash,
      adapter: { leaseAdapter: { lockWaitMs: 1, delay: async () => undefined } },
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    proceed()
    const creationOutcome = await creation

    expect(transactionOutcome).toMatchObject({
      error: { code: expect.stringMatching(/^TRANSACTION_(?:LOCKED|COLLISION|STALE)$/) },
    })
    expect(creationOutcome).toMatchObject({ path: plan.target })
    expect(await exists(join(workspace, source))).toBe(true)
  }, 20_000)

  it("returns a create result with a warning when only lease cleanup fails", async () => {
    const workspace = await garden()
    const created = await createNote(
      {
        workspace,
        visibility: "private",
        domain: "life",
        slug: "created",
        title: "Created",
        date: "2026-09-23",
        description: "Committed before cleanup",
        tags: ["lease"],
      },
      {
        beforeLockRelease() {
          throw new Error("injected release failure")
        },
      },
    )

    expect(created.path).toBe("private/life/created.md")
    expect(created.warnings).toContainEqual(
      expect.objectContaining({ code: "LOCK_RELEASE_FAILED" }),
    )
    expect(await exists(join(workspace, created.path))).toBe(true)
  })

  it("preserves a create collision as primary when lease cleanup also fails", async () => {
    const workspace = await garden()
    const path = "private/life/created.md"
    await put(workspace, path, "external")

    await expect(
      createNote(
        {
          workspace,
          visibility: "private",
          domain: "life",
          slug: "created",
          title: "Created",
          date: "2026-09-23",
          description: "Must preserve collision",
          tags: ["lease"],
        },
        {
          beforeLockRelease() {
            throw new Error("injected release failure")
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "NOTE_ALREADY_EXISTS",
      details: {
        cleanupWarnings: [expect.objectContaining({ code: "LOCK_RELEASE_FAILED" })],
      },
    })
    expect(await readFile(join(workspace, path), "utf8")).toBe("external")
  })

  it("rejects execution without a retention Trash adapter before mutation", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    const original = "---\ntitle: Topic\n---\n"
    await put(workspace, source, original)
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })

    await expect(executeVisibilityChangeRaw(plan, { workspace } as never)).rejects.toMatchObject({
      code: "TRANSACTION_PLAN_INVALID",
    })
    expect(await readFile(join(workspace, ...source.split("/")), "utf8")).toBe(original)
    expect(await exists(join(workspace, plan.target))).toBe(false)
  })

  it("keeps pending inspection and execution independent from oversized failing history", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    const key = await readFile(join(workspace, ".garden-publisher", "keys", "recovery-hmac.key"))
    for (let index = 0; index <= MAX_TRANSACTION_RETENTION_SCAN; index += 1) {
      const id = randomUUID()
      const payload = {
        version: 1 as const,
        id,
        kind: "visibility" as const,
        createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
        phase: "complete" as const,
        source: "content/life/history.md",
      }
      await put(
        workspace,
        `.garden-publisher/transactions/history/${id}/terminal.json`,
        JSON.stringify({ ...payload, integrity: authenticate(key, payload) }),
      )
    }

    await expect(inspectPendingTransactions({ workspace })).resolves.toEqual([])
    await expect(
      executeVisibilityChange(plan, {
        workspace,
        transactionTrash: { trashItem: async () => Promise.reject(new Error("Trash unavailable")) },
      }),
    ).resolves.toMatchObject({ id: plan.id })
    await expect(inspectPendingTransactions({ workspace })).resolves.toEqual([])
  }, 30_000)

  it("resumes bounded Trash cleanup for an authenticated abandoned history quarantine", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    const key = await readFile(join(workspace, ".garden-publisher", "keys", "recovery-hmac.key"))
    const id = randomUUID()
    const payload = {
      version: 1 as const,
      id,
      kind: "visibility" as const,
      createdAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
      phase: "complete" as const,
      source: "content/life/history.md",
    }
    const quarantine = `.retention-${id}-${randomUUID()}`
    await put(
      workspace,
      `.garden-publisher/transactions/history/${quarantine}/terminal.json`,
      JSON.stringify({ ...payload, integrity: authenticate(key, payload) }),
    )
    const trashed: string[] = []

    await executeVisibilityChange(plan, {
      workspace,
      transactionTrash: {
        async trashItem(path) {
          trashed.push(path)
          await rm(path, { recursive: true })
        },
      },
    })

    expect(trashed.some((path) => path.endsWith(quarantine))).toBe(true)
    expect(
      await exists(join(workspace, ".garden-publisher", "transactions", "history", quarantine)),
    ).toBe(false)
  })

  it("migrates authenticated legacy root terminal evidence into history", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    const key = await readFile(join(workspace, ".garden-publisher", "keys", "recovery-hmac.key"))
    const id = randomUUID()
    const payload = {
      version: 1 as const,
      id,
      kind: "visibility" as const,
      createdAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
      phase: "complete" as const,
      source: "content/life/legacy.md",
    }
    await put(
      workspace,
      `.garden-publisher/transactions/${id}/terminal.json`,
      JSON.stringify({ ...payload, integrity: authenticate(key, payload) }),
    )

    await executeVisibilityChange(plan, { workspace, transactionTrash: noTrash })

    expect(await exists(join(workspace, ".garden-publisher", "transactions", id))).toBe(false)
    expect(await exists(join(workspace, ".garden-publisher", "transactions", "history", id))).toBe(
      true,
    )
  })

  it("locks attachment roots without acquiring one lease per contained file", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    await putAssetTree(workspace, "private", 64)
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    const acquired: string[] = []

    await executeVisibilityChange(plan, {
      workspace,
      transactionTrash: noTrash,
      adapter: {
        beforeLockOwnerPublish(path) {
          acquired.push(path)
        },
      },
    })

    expect(acquired).toHaveLength(4)
  }, 30_000)

  it("rejects a canonical transaction plan larger than 256 KiB", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    await putAssetTree(workspace, "private", 1_000)

    await expect(
      planVisibilityChange({ workspace, path: source, visibility: "public" }),
    ).rejects.toMatchObject({ code: "TRANSACTION_PLAN_TOO_LARGE" })
    expect(await exists(join(workspace, ".garden-publisher", "transactions"))).toBe(false)
    expect(await exists(join(workspace, source))).toBe(true)
  }, 30_000)

  it("rejects an oversized journal before creating staging evidence or mutating notes", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    await putAssetTree(workspace, "private", 800)
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })

    await expect(
      executeVisibilityChange(plan, { workspace, transactionTrash: noTrash }),
    ).rejects.toMatchObject({ code: "TRANSACTION_JOURNAL_TOO_LARGE" })
    expect(await exists(join(workspace, source))).toBe(true)
    expect(await exists(join(workspace, plan.target))).toBe(false)
    const pending = join(workspace, ".garden-publisher", "transactions", "pending")
    expect((await readdir(pending)).filter((entry) => entry.includes(plan.id))).toEqual([])
  }, 60_000)

  it("keeps a near-limit journal authenticated and readable from pending", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    await putAssetTree(workspace, "private", 755)
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    expect(Buffer.byteLength(canonicalJson(plan), "utf8")).toBeGreaterThan(220_000)
    let entered!: () => void
    let proceed!: () => void
    const paused = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (proceed = resolve))
    const transaction = executeVisibilityChange(plan, {
      workspace,
      transactionTrash: noTrash,
      adapter: {
        async afterPhase(phase) {
          if (phase !== "journal-created") return
          entered()
          await gate
        },
      },
    })
    await paused

    await expect(inspectPendingTransactions({ workspace })).resolves.toEqual([
      expect.objectContaining({ id: plan.id, phase: "prepared" }),
    ])
    proceed()
    await expect(transaction).resolves.toMatchObject({ id: plan.id })
  }, 60_000)

  it("retains at most twenty terminal transactions per note via Trash", async () => {
    const workspace = await garden({ git: true })
    let path = "private/life/topic.md"
    await put(workspace, path, "---\ntitle: Topic\n---\n")
    const trashed: string[] = []
    let injectTrashFailure = true
    const retentionWarnings: string[] = []
    const trash = {
      async trashItem(absolutePath: string) {
        if (injectTrashFailure) {
          injectTrashFailure = false
          throw new Error("injected Trash failure")
        }
        trashed.push(absolutePath)
        await rm(absolutePath, { recursive: true })
      },
    }

    for (let index = 0; index < 22; index += 1) {
      const visibility = path.startsWith("private/") ? "public" : "private"
      const plan = await planVisibilityChange({ workspace, path, visibility })
      const result = await executeVisibilityChange(plan, { workspace, transactionTrash: trash })
      retentionWarnings.push(...result.warnings.map(({ code }) => code))
      path = plan.target
    }

    const entries = await readdir(join(workspace, ".garden-publisher", "transactions", "history"))
    expect(entries.filter((entry) => !entry.startsWith(".")).length).toBeLessThanOrEqual(20)
    expect(trashed.length).toBeGreaterThanOrEqual(2)
    expect(trashed).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/[\\/]\.retention-[a-f0-9-]{36}-[a-f0-9-]{36}$/i),
      ]),
    )
    expect(retentionWarnings).toContain("TRANSACTION_RETENTION_FAILED")
  }, 30_000)

  it("bounds failed retention work and never selects authenticated nonterminal evidence", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    const key = await readFile(join(workspace, ".garden-publisher", "keys", "recovery-hmac.key"))
    const transactionRoot = join(workspace, ".garden-publisher", "transactions")
    await mkdir(transactionRoot, { recursive: true })
    for (let index = 0; index < 40; index += 1) {
      const id = randomUUID()
      const payload = {
        version: 1 as const,
        id,
        kind: "visibility" as const,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        phase: "complete" as const,
        source: "content/life/retained.md",
      }
      await put(
        workspace,
        `.garden-publisher/transactions/${id}/terminal.json`,
        JSON.stringify({ ...payload, integrity: authenticate(key, payload) }),
      )
    }
    const pendingId = randomUUID()
    const pendingPayload = {
      version: 1 as const,
      id: pendingId,
      kind: "rename" as const,
      createdAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
      phase: "rollback-uncertain",
      source: "private/reading/pending.md",
      paths: ["private/reading/pending.md"],
      backups: [],
    }
    await put(
      workspace,
      `.garden-publisher/transactions/${pendingId}/manifest.json`,
      JSON.stringify({ ...pendingPayload, integrity: authenticate(key, pendingPayload) }),
    )
    const attempted: string[] = []

    const result = await executeVisibilityChange(plan, {
      workspace,
      transactionTrash: {
        async trashItem(path) {
          attempted.push(path)
          throw new Error("injected Trash failure")
        },
      },
    })

    expect(attempted).toHaveLength(MAX_TRANSACTION_RETENTION_TRASH_CALLS)
    expect(attempted).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/[\\/]\.retention-[a-f0-9-]{36}-[a-f0-9-]{36}$/i),
      ]),
    )
    expect(attempted.some((path) => path.includes(pendingId))).toBe(false)
    expect(await exists(join(transactionRoot, pendingId))).toBe(true)
    expect((await readdir(transactionRoot)).some((entry) => entry.startsWith(".retention-"))).toBe(
      false,
    )
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "TRANSACTION_RETENTION_FAILED" }),
    )
  })

  it("keeps completed journals from the previous authenticated format recoverable", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    const key = await readFile(join(workspace, ".garden-publisher", "keys", "recovery-hmac.key"))
    const legacyPayload = {
      version: 1 as const,
      id: randomUUID(),
      kind: "visibility" as const,
      createdAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
      phase: "complete",
      paths: ["private/reading/legacy.md", "content/reading/legacy.md"],
      backups: [],
    }
    await put(
      workspace,
      `.garden-publisher/transactions/${legacyPayload.id}/manifest.json`,
      JSON.stringify({ ...legacyPayload, integrity: authenticate(key, legacyPayload) }),
    )

    await expect(inspectPendingTransactions({ workspace })).resolves.toEqual([])
    await expect(executeVisibilityChange(plan, { workspace })).resolves.toMatchObject({
      id: plan.id,
    })
    expect(
      await exists(
        join(
          workspace,
          ".garden-publisher",
          "transactions",
          "history",
          legacyPayload.id,
          "manifest.json",
        ),
      ),
    ).toBe(true)
  })

  it("keeps corrupted terminal history isolated from new transactions", async () => {
    const workspace = await garden({ git: true })
    await put(workspace, "private/life/topic.md", "---\ntitle: PRIVATE_SENTINEL\n---\n")
    const first = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    await executeVisibilityChange(first, { workspace, transactionTrash: noTrash })
    await writeFile(
      join(workspace, ".garden-publisher", "transactions", "history", first.id, "manifest.json"),
      "PRIVATE_SENTINEL invalid manifest",
    )

    const inspected = await inspectPendingTransactions({ workspace })
    expect(inspected).toEqual([])
    expect(JSON.stringify(inspected)).not.toContain("PRIVATE_SENTINEL")

    const second = await planVisibilityChange({
      workspace,
      path: "content/life/topic.md",
      visibility: "private",
    })
    await expect(
      executeVisibilityChange(second, { workspace, transactionTrash: noTrash }),
    ).resolves.toMatchObject({ id: second.id })
  })

  it("restores a link source when failure occurs after atomic quarantine", async () => {
    const workspace = await garden()
    const original = "Incoming [[life/topic]]\n"
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "content/reading/ref.md", original)
    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })

    await expect(
      executeRename(plan, {
        workspace,
        adapter: {
          afterLinkQuarantine() {
            throw new Error("injected post-quarantine failure")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" })

    expect(await readFile(join(workspace, "content/reading/ref.md"), "utf8")).toBe(original)
    expect(await exists(join(workspace, "content/life/renamed.md"))).toBe(false)
    expect(await inspectPendingTransactions({ workspace })).toEqual([])
  })

  it("preserves an external link replacement and retains an uncertain journal", async () => {
    const workspace = await garden()
    const external = "EXTERNAL [[life/topic]]\n"
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "content/reading/ref.md", "Incoming [[life/topic]]\n")
    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })

    await expect(
      executeRename(plan, {
        workspace,
        adapter: {
          async afterLinkQuarantine(path) {
            await writeFile(join(workspace, path), external)
            throw new Error("external replacement after quarantine")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_UNCERTAIN" })

    expect(await readFile(join(workspace, "content/reading/ref.md"), "utf8")).toBe(external)
    expect(await exists(join(workspace, "content/life/renamed.md"))).toBe(false)
    await expect(inspectPendingTransactions({ workspace })).resolves.toEqual([
      expect.objectContaining({ id: plan.id, phase: "rollback-uncertain" }),
    ])
  })

  it("preserves a source note recreated after quarantine and rejects success", async () => {
    const workspace = await garden()
    const external = "---\ntitle: RECREATED_NOTE\n---\n"
    await put(workspace, "private/life/topic.md", "---\ntitle: Original\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async afterSourceQuarantine(path) {
            if (path === plan.source) await writeFile(join(workspace, path), external)
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_STALE" })

    expect(await readFile(join(workspace, plan.source), "utf8")).toBe(external)
    expect(await exists(join(workspace, plan.target))).toBe(false)
  })

  it("preserves an attachment tree recreated after quarantine and rejects success", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Original\n---\n")
    await put(workspace, "private/_assets/topic/original.bin", "original")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async afterSourceQuarantine(path) {
            if (path === "private/_assets/topic") {
              await put(workspace, "private/_assets/topic/external.bin", "external")
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_STALE" })

    expect(await readFile(join(workspace, "private/_assets/topic/external.bin"), "utf8")).toBe(
      "external",
    )
    expect(await exists(join(workspace, "content/_assets/topic"))).toBe(false)
    expect(await exists(join(workspace, plan.target))).toBe(false)
  })

  it("preserves a source save made at the quarantine boundary", async () => {
    const workspace = await garden()
    const original = "---\ntitle: Original\n---\n"
    const external = "---\ntitle: BOUNDARY_SAVE\n---\n"
    await put(workspace, "private/life/topic.md", original)
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async beforeSourceQuarantine(path) {
            if (path === plan.source) await writeFile(join(workspace, path), external)
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_STALE" })

    expect(await readFile(join(workspace, plan.source), "utf8")).toBe(external)
    expect(await exists(join(workspace, plan.target))).toBe(false)
  })

  it("rolls back a source quarantined before the atomic primitive reports failure", async () => {
    const workspace = await garden()
    const original = "---\ntitle: Original\n---\n"
    await put(workspace, "private/life/topic.md", original)
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          afterSourceQuarantine(path) {
            if (path === plan.source) throw new Error("injected post-rename failure")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" })

    expect(await readFile(join(workspace, plan.source), "utf8")).toBe(original)
    expect(await exists(join(workspace, plan.target))).toBe(false)
    expect(await inspectPendingTransactions({ workspace })).toEqual([])
  })

  it("preserves a note saved after attachment publication and rolls back targets as stale", async () => {
    const workspace = await garden()
    const original = "---\ntitle: Original\n---\n"
    const external = "---\ntitle: EXTERNAL_SAVE\n---\n"
    await put(workspace, "private/life/topic.md", original)
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async afterPhase(phase) {
            if (phase === "attachments-published") {
              await writeFile(join(workspace, "private/life/topic.md"), external)
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_STALE" })

    expect(await readFile(join(workspace, "private/life/topic.md"), "utf8")).toBe(external)
    expect(await exists(join(workspace, "content/life/topic.md"))).toBe(false)
    expect(await inspectPendingTransactions({ workspace })).toEqual([])
    const transactionRoot = join(workspace, ".garden-publisher", "transactions", "history", plan.id)
    expect(
      await readFile(join(transactionRoot, "backups", `0000-${hash(plan.source)}.bin`), "utf8"),
    ).not.toContain("EXTERNAL_SAVE")
  })

  it("preserves an attachment changed immediately before source removal", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "private/_assets/topic/data.bin", "original")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async afterPhase(phase) {
            if (phase === "attachments-published") {
              await writeFile(join(workspace, "private/_assets/topic/data.bin"), "external")
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_STALE" })

    expect(await readFile(join(workspace, "private/_assets/topic/data.bin"), "utf8")).toBe(
      "external",
    )
    expect(await exists(join(workspace, "content/_assets/topic"))).toBe(false)
    expect(await readFile(join(workspace, "private/life/topic.md"), "utf8")).toContain(
      "title: Topic",
    )
  })

  it("never exposes a partially staged attachment tree as the final target", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "private/_assets/topic/a.bin", "a")
    await put(workspace, "private/_assets/topic/b.bin", "b")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          afterAttachmentStageFile(path: string) {
            if (path.endsWith("/a.bin")) throw new Error("injected partial staging failure")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" })

    expect(await exists(join(workspace, "content/_assets/topic"))).toBe(false)
    expect(await readFile(join(workspace, "private/_assets/topic/a.bin"), "utf8")).toBe("a")
    expect(await readFile(join(workspace, "private/_assets/topic/b.bin"), "utf8")).toBe("b")
  })

  it("recognizes a completed atomic attachment-root publish when the primitive reports failure", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "private/_assets/topic/a.bin", "a")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          afterAttachmentRootPublish() {
            throw new Error("rename completed before failure")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" })

    expect(await exists(join(workspace, "content/_assets/topic"))).toBe(false)
    expect(await readFile(join(workspace, "private/_assets/topic/a.bin"), "utf8")).toBe("a")
  })

  it("atomically quarantines an externally replaced attachment target tree", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "private/_assets/topic/a.bin", "a")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async afterPhase(phase) {
            if (phase !== "attachments-published") return
            await writeFile(join(workspace, "content/_assets/topic/a.bin"), "external")
            throw new Error("external attachment replacement")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_UNCERTAIN" })

    expect(await exists(join(workspace, "content/_assets/topic"))).toBe(false)
    expect(
      await readFile(
        join(
          workspace,
          ".garden-publisher",
          "transactions",
          "pending",
          plan.id,
          "rollback-quarantine",
          "attachments-target",
          "a.bin",
        ),
        "utf8",
      ),
    ).toBe("external")
  })

  it("marks the journal uncertain when the first publication was installed then replaced", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    const external = "EXTERNAL_AFTER_FIRST_PUBLICATION"

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async afterExclusivePublish(path: string) {
            if (path !== plan.target) return
            await writeFile(join(workspace, ...path.split("/")), external)
            throw new Error("installed then failed")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_UNCERTAIN" })

    expect(await exists(join(workspace, "content/life/topic.md"))).toBe(false)
    expect(
      await readFile(
        join(
          workspace,
          ".garden-publisher",
          "transactions",
          "pending",
          plan.id,
          "rollback-quarantine",
          "note-target",
        ),
        "utf8",
      ),
    ).toBe(external)
    await expect(inspectPendingTransactions({ workspace })).resolves.toEqual([
      expect.objectContaining({ id: plan.id, phase: "rollback-uncertain" }),
    ])
  })

  it("rolls back byte-for-byte after every mutable phase and leaves no target", async () => {
    for (const phase of [
      "journal-created",
      "note-published",
      "links-published",
      "attachments-published",
      "source-removed",
    ] as const) {
      const workspace = await garden()
      const note = "---\ntitle: Topic\n---\n\nbody\n"
      const incoming = "[[life/topic]]\n"
      await put(workspace, "content/life/topic.md", note)
      await put(workspace, "content/reading/ref.md", incoming)
      await put(workspace, "content/_assets/topic/a.bin", Buffer.from([1, 2, 3]))
      const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
      const adapter: NoteTransactionAdapter = {
        afterPhase(current) {
          if (current === phase) throw new Error(`injected ${phase}`)
        },
      }

      await expect(executeRename(plan, { workspace, adapter })).rejects.toMatchObject({
        code: "TRANSACTION_FAILED",
      })
      expect(await readFile(join(workspace, "content/life/topic.md"), "utf8")).toBe(note)
      expect(await readFile(join(workspace, "content/reading/ref.md"), "utf8")).toBe(incoming)
      expect(await readFile(join(workspace, "content/_assets/topic/a.bin"))).toEqual(
        Buffer.from([1, 2, 3]),
      )
      expect(await exists(join(workspace, "content/life/renamed.md"))).toBe(false)
      expect(await exists(join(workspace, "content/_assets/renamed"))).toBe(false)
      expect(await inspectPendingTransactions({ workspace })).toEqual([])
    }
  }, 20_000)

  it("allows exactly one of two conflicting executions to win", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    let entered!: () => void
    let proceed!: () => void
    const atJournal = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (proceed = resolve))
    const first = executeVisibilityChange(plan, {
      workspace,
      adapter: {
        async afterPhase(phase) {
          if (phase !== "journal-created") return
          entered()
          await gate
        },
      },
    })
    await atJournal
    const second = executeVisibilityChange(plan, { workspace })
    await expect(second).rejects.toMatchObject({
      code: expect.stringMatching(/^TRANSACTION_(?:PENDING|LOCKED)$/),
    })
    proceed()

    await expect(first).resolves.toMatchObject({ id: plan.id })
    expect(await exists(join(workspace, "content/life/topic.md"))).toBe(true)
  })

  it("does not let a transaction race a save paused before replacement", async () => {
    const workspace = await garden()
    const path = "private/life/topic.md"
    await put(workspace, path, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path, visibility: "public" })
    let entered!: () => void
    let proceed!: () => void
    const paused = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (proceed = resolve))
    const adapter: NoteFileAdapter = {
      async beforeReplace() {
        entered()
        await gate
      },
    }
    const saving = saveNote(
      {
        workspace,
        path,
        markdown: "---\ntitle: Saved\n---\n",
        ...(await revision(workspace, path)),
        recoveryTrash: noTrash,
      },
      adapter,
    )
    await paused
    const transactionOutcome = await executeVisibilityChange(plan, { workspace }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    proceed()
    const saveOutcome = await saving.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    expect(transactionOutcome).toMatchObject({
      error: { code: expect.stringMatching(/^TRANSACTION_(?:LOCKED|STALE)$/) },
    })
    expect(saveOutcome).toMatchObject({ value: { path } })
    expect(await exists(join(workspace, plan.target))).toBe(false)
    expect(await readFile(join(workspace, path), "utf8")).toContain("title: Saved")
  })

  it("blocks saveNote while a visibility transaction owns the source lease", async () => {
    const workspace = await garden()
    const path = "private/life/topic.md"
    await put(workspace, path, "---\ntitle: Topic\n---\n")
    const before = await revision(workspace, path)
    const plan = await planVisibilityChange({ workspace, path, visibility: "public" })
    let entered!: () => void
    let proceed!: () => void
    const paused = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (proceed = resolve))
    const transaction = executeVisibilityChange(plan, {
      workspace,
      adapter: {
        async afterPhase(phase) {
          if (phase !== "journal-created") return
          entered()
          await gate
        },
      },
    })
    await paused
    const saveOutcome = await saveNote({
      workspace,
      path,
      markdown: "---\ntitle: Saved\n---\n",
      ...before,
      recoveryTrash: noTrash,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    proceed()
    const transactionOutcome = await transaction.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    expect(saveOutcome).toMatchObject({ error: { code: "NOTE_FILE_LOCKED" } })
    expect(transactionOutcome).toMatchObject({ value: { id: plan.id } })
    expect(await exists(join(workspace, path))).toBe(false)
  })

  it("locks every incoming Markdown file edited by rename against saveNote", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    const incoming = "content/reading/ref.md"
    await put(workspace, incoming, "[[life/topic]]\n")
    const incomingRevision = await revision(workspace, incoming)
    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    let entered!: () => void
    let proceed!: () => void
    const paused = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (proceed = resolve))
    const transaction = executeRename(plan, {
      workspace,
      adapter: {
        async afterPhase(phase) {
          if (phase !== "journal-created") return
          entered()
          await gate
        },
      },
    })
    await paused
    const saveOutcome = await saveNote({
      workspace,
      path: incoming,
      markdown: "external [[life/topic]]\n",
      ...incomingRevision,
      recoveryTrash: noTrash,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    proceed()
    const transactionOutcome = await transaction.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    expect(saveOutcome).toMatchObject({ error: { code: "NOTE_FILE_LOCKED" } })
    expect(transactionOutcome).toMatchObject({ value: { id: plan.id } })
    expect(await readFile(join(workspace, incoming), "utf8")).toContain("[[life/renamed]]")
  })

  it("shares one stable protected key during concurrent first-use save and planning", async () => {
    const workspace = await garden()
    const moving = "private/life/topic.md"
    const saving = "private/reading/draft.md"
    await put(workspace, moving, "---\ntitle: Topic\n---\n")
    await put(workspace, saving, "---\ntitle: Draft\n---\n")
    const savingRevision = await revision(workspace, saving)
    let entered!: () => void
    let proceed!: () => void
    const keyPublishPaused = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (proceed = resolve))
    const save = saveNote(
      {
        workspace,
        path: saving,
        markdown: "---\ntitle: Saved\n---\n",
        ...savingRevision,
        recoveryTrash: noTrash,
      },
      {
        async beforeKeyPublish() {
          entered()
          await gate
        },
      },
    )
    await keyPublishPaused
    const planned = planVisibilityChange({ workspace, path: moving, visibility: "public" })
    proceed()

    await expect(save).resolves.toMatchObject({ path: saving })
    const plan = await planned
    await expect(executeVisibilityChange(plan, { workspace })).resolves.toMatchObject({
      id: plan.id,
    })
  })

  it("cleans up an orphan lock when owner metadata publication fails", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          beforeLockOwnerPublish() {
            throw new Error("injected owner publication failure")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_LOCKED" })

    await expect(executeVisibilityChange(plan, { workspace })).resolves.toMatchObject({
      id: plan.id,
    })
  })

  it("conservatively recovers an old ownerless lock directory", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    const lock = join(workspace, ".garden-publisher", "locks", `${hash(plan.source)}.lock`)
    await mkdir(lock, { recursive: true })
    const old = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(lock, old, old)

    await expect(executeVisibilityChange(plan, { workspace })).resolves.toMatchObject({
      id: plan.id,
    })
  })

  it("recovers an expired dead-owner lease left after owner publication", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    const lock = join(workspace, ".garden-publisher", "locks", `${hash(source)}.lock`)
    await mkdir(lock, { recursive: true })
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        version: 1,
        token: "00000000-0000-4000-8000-000000000000",
        pid: 9,
        createdAt: 1,
      }),
    )
    let clock = 10_000

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          leaseAdapter: {
            now: () => clock,
            delay: async (milliseconds) => {
              clock += milliseconds
            },
            isProcessAlive: () => false,
            lockGraceMs: 1,
          },
        },
      }),
    ).resolves.toMatchObject({ id: plan.id })
  })

  it("attempts every path-lock release and preserves a successful transaction outcome", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    const releaseAttempts: string[] = []

    const result = await executeVisibilityChange(plan, {
      workspace,
      adapter: {
        beforeLockRelease(path) {
          releaseAttempts.push(path)
          throw new Error("injected release failure")
        },
      },
    })

    expect(releaseAttempts.length).toBeGreaterThan(1)
    expect(new Set(releaseAttempts).size).toBe(releaseAttempts.length)
    expect(result).toMatchObject({ id: plan.id })
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "LOCK_RELEASE_FAILED" }))
  })

  it("never removes a successor lock that replaces the owned lease before release", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    let successor: string | undefined

    const result = await executeVisibilityChange(plan, {
      workspace,
      adapter: {
        async beforeLockRelease(lockPath: string) {
          if (successor !== undefined) return
          await rename(lockPath, `${lockPath}.predecessor`)
          await mkdir(lockPath)
          await writeFile(join(lockPath, "successor"), "must survive")
          successor = lockPath
        },
      },
    })

    expect(successor).toBeDefined()
    expect(await readFile(join(successor!, "successor"), "utf8")).toBe("must survive")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "LOCK_RELEASE_FAILED" }))
    const liveLocks = (await readdir(join(workspace, ".garden-publisher", "locks"))).filter(
      (entry) => entry.endsWith(".lock"),
    )
    expect(liveLocks).toEqual([successor!.split(/[\\/]/).at(-1)])
  })

  it("attaches release warnings to the primary typed transaction failure", async () => {
    const workspace = await garden()
    const source = "private/life/topic.md"
    await put(workspace, source, "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({ workspace, path: source, visibility: "public" })
    let replaced = false
    let failure: unknown
    try {
      await executeVisibilityChange(plan, {
        workspace,
        adapter: {
          afterPhase(phase) {
            if (phase === "journal-created") throw new Error("injected primary failure")
          },
          async beforeLockRelease(lockPath) {
            if (replaced) return
            replaced = true
            await rename(lockPath, `${lockPath}.predecessor`)
            await mkdir(lockPath)
          },
        },
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      code: "TRANSACTION_FAILED",
      details: {
        cleanupWarnings: [expect.objectContaining({ code: "LOCK_RELEASE_FAILED" })],
      },
    })
    const liveLocks = (await readdir(join(workspace, ".garden-publisher", "locks"))).filter(
      (entry) => entry.endsWith(".lock"),
    )
    expect(liveLocks).toHaveLength(1)
  })

  it("retains an authenticated pending journal and returns uncertainty when rollback fails", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: SENTINEL_PRIVATE_BODY\n---\n")
    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    const adapter: NoteTransactionAdapter = {
      afterPhase(phase) {
        if (phase === "note-published") throw new Error("injected mutation failure")
      },
      beforeRollback() {
        throw new Error("injected rollback failure")
      },
    }

    let failure: unknown
    try {
      await executeRename(plan, { workspace, adapter })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: "TRANSACTION_UNCERTAIN" })
    expect(JSON.stringify(failure)).not.toContain("SENTINEL_PRIVATE_BODY")
    expect(JSON.stringify(failure)).not.toContain(dirname(workspace))

    const pending = await inspectPendingTransactions({ workspace })
    expect(pending).toEqual([
      expect.objectContaining({ id: plan.id, kind: "rename", phase: "rollback-uncertain" }),
    ])
    expect(JSON.stringify(pending)).not.toContain("SENTINEL_PRIVATE_BODY")
    const manifest = await readFile(
      join(workspace, ".garden-publisher", "transactions", "pending", plan.id, "manifest.json"),
      "utf8",
    )
    expect(manifest).not.toContain("SENTINEL_PRIVATE_BODY")
    expect(JSON.parse(manifest)).toMatchObject({
      id: plan.id,
      phase: "rollback-uncertain",
      integrity: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it("fails closed when retained transaction evidence no longer authenticates", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: PRIVATE_SENTINEL\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    const transaction = join(workspace, ".garden-publisher", "transactions", "pending", plan.id)
    await mkdir(transaction, { recursive: true })
    await writeFile(
      join(transaction, "manifest.json"),
      JSON.stringify({
        version: 1,
        id: plan.id,
        kind: "visibility",
        createdAt: new Date().toISOString(),
        phase: "prepared",
        paths: [plan.source, plan.target],
        backups: [],
        integrity: "0".repeat(64),
      }),
    )

    let failure: unknown
    try {
      await inspectPendingTransactions({ workspace })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: "TRANSACTION_PENDING" })
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL")
    expect(JSON.stringify(failure)).not.toContain(workspace)
    await expect(executeVisibilityChange(plan, { workspace })).rejects.toMatchObject({
      code: "TRANSACTION_PENDING",
    })
    expect(await exists(join(workspace, "content/life/topic.md"))).toBe(false)
  })

  it("returns a typed body-free error for inspect setup failures", async () => {
    const workspace = await garden()
    await writeFile(join(workspace, ".garden-publisher"), "PRIVATE_SETUP_SENTINEL")

    let failure: unknown
    try {
      await inspectPendingTransactions({ workspace })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: expect.stringMatching(/^TRANSACTION_/) })
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_SETUP_SENTINEL")
    expect(JSON.stringify(failure)).not.toContain(workspace)
  })

  it("quarantines an external target replacement without deleting or overwriting it", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })
    const external = "external replacement that must survive"

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async afterPhase(phase) {
            if (phase !== "note-published") return
            await writeFile(join(workspace, "content/life/topic.md"), external)
            throw new Error("fail after external edit")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_UNCERTAIN" })
    expect(await exists(join(workspace, "content/life/topic.md"))).toBe(false)
    expect(
      await readFile(
        join(
          workspace,
          ".garden-publisher",
          "transactions",
          "pending",
          plan.id,
          "rollback-quarantine",
          "note-target",
        ),
        "utf8",
      ),
    ).toBe(external)
  })

  it("does not claim an identical-byte external note replacement during rollback", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async afterPhase(phase) {
            if (phase !== "note-published") return
            const target = join(workspace, plan.target)
            const bytes = await readFile(target)
            const external = `${target}.external`
            await writeFile(external, bytes)
            await rename(external, target)
            throw new Error("fail after identical external replacement")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_UNCERTAIN" })

    expect(await exists(join(workspace, plan.target))).toBe(false)
    expect(
      await readFile(
        join(
          workspace,
          ".garden-publisher",
          "transactions",
          "pending",
          plan.id,
          "rollback-quarantine",
          "note-target",
        ),
        "utf8",
      ),
    ).toContain("title: Topic")
  })

  it("does not claim an identical external attachment tree during rollback", async () => {
    const workspace = await garden()
    await put(workspace, "private/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "private/_assets/topic/data.bin", "same bytes")
    const plan = await planVisibilityChange({
      workspace,
      path: "private/life/topic.md",
      visibility: "public",
    })

    await expect(
      executeVisibilityChange(plan, {
        workspace,
        adapter: {
          async afterPhase(phase) {
            if (phase !== "attachments-published") return
            const target = join(workspace, "content/_assets/topic/data.bin")
            const external = `${target}.external`
            await writeFile(external, "same bytes")
            await rename(external, target)
            throw new Error("fail after identical external tree replacement")
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_UNCERTAIN" })

    expect(await exists(join(workspace, "content/_assets/topic"))).toBe(false)
    expect(
      await readFile(
        join(
          workspace,
          ".garden-publisher",
          "transactions",
          "pending",
          plan.id,
          "rollback-quarantine",
          "attachments-target",
          "data.bin",
        ),
        "utf8",
      ),
    ).toBe("same bytes")
  })

  it("does not apply a link edit to a file changed after the note was published", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "content/reading/ref.md", "[[life/topic]]\n")
    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    const external = "external [[life/topic]]\n"

    await expect(
      executeRename(plan, {
        workspace,
        adapter: {
          async afterPhase(phase) {
            if (phase === "note-published") {
              await writeFile(join(workspace, "content/reading/ref.md"), external)
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_STALE" })
    expect(await readFile(join(workspace, "content/reading/ref.md"), "utf8")).toBe(external)
    expect(await exists(join(workspace, "content/life/renamed.md"))).toBe(false)
  })

  it("preserves a link source changed at the atomic quarantine boundary", async () => {
    const workspace = await garden()
    await put(workspace, "content/life/topic.md", "---\ntitle: Topic\n---\n")
    await put(workspace, "content/reading/ref.md", "[[life/topic]]\n")
    const plan = await planRename({ workspace, path: "content/life/topic.md", slug: "renamed" })
    const external = "boundary replacement [[life/topic]]\n"

    await expect(
      executeRename(plan, {
        workspace,
        adapter: {
          async beforeLinkQuarantine(path) {
            if (path === "content/reading/ref.md") {
              await writeFile(join(workspace, path), external)
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_STALE" })
    expect(await readFile(join(workspace, "content/reading/ref.md"), "utf8")).toBe(external)
    expect(await exists(join(workspace, "content/life/renamed.md"))).toBe(false)
  })
})
