import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  executeRename,
  executeVisibilityChange,
  inspectPendingTransactions,
  planRename,
  planVisibilityChange,
  type NoteTransactionAdapter,
} from "../../src/main/services/noteFiles"

const run = promisify(execFile)
const roots: string[] = []

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
        } as NoteTransactionAdapter,
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
        } as NoteTransactionAdapter & {
          beforeAttachmentRootPublish(path: string): Promise<void>
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
})

describe("transaction recovery", () => {
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
  })

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
      join(workspace, ".garden-publisher", "transactions", plan.id, "manifest.json"),
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
    const transaction = join(workspace, ".garden-publisher", "transactions", plan.id)
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

  it("does not delete an external replacement discovered during rollback", async () => {
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
    expect(await readFile(join(workspace, "content/life/topic.md"), "utf8")).toBe(external)
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
    ).rejects.toMatchObject({ code: "TRANSACTION_UNCERTAIN" })
    expect(await readFile(join(workspace, "content/reading/ref.md"), "utf8")).toBe(external)
  })
})
