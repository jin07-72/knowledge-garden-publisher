import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTemporaryGitRepository, git, type TemporaryGitRepository } from "../helpers/git"
import { listChanges, parsePorcelainV2 } from "../../src/main/services/changes"

const repositories: TemporaryGitRepository[] = []

async function repository(): Promise<TemporaryGitRepository> {
  const fixture = await createTemporaryGitRepository()
  repositories.push(fixture)
  await mkdir(join(fixture.root, "content", "technology"), { recursive: true })
  await mkdir(join(fixture.root, "content", "_assets", "css-grid"), { recursive: true })
  await mkdir(join(fixture.root, "private", "life"), { recursive: true })
  await writeFile(join(fixture.root, "content", "technology", "css-grid.md"), "public")
  await writeFile(join(fixture.root, "content", "technology", "retired.md"), "retired")
  await writeFile(join(fixture.root, "quartz.config.yaml"), "configuration: {}")
  await git(fixture.root, ["add", "."])
  await git(fixture.root, ["commit", "-m", "fixture"])
  return fixture
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((fixture) => fixture.cleanup()))
})

describe("parsePorcelainV2", () => {
  it("parses NUL records and consumes the second rename path without line splitting", () => {
    const output = [
      "1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa content/technology/line\nfeed.md",
      "2 R. N... 100644 100644 100644 bbbbbbb bbbbbbb R100 content/technology/new name.md",
      "content/technology/old name.md",
      "u UU N... 100644 100644 100644 100644 ccccccc ddddddd eeeeeee content/technology/conflict.md",
      "? content/_assets/new-note/photo 1.png",
      "! private/life/ignored.md",
      "",
    ].join("\0")

    expect(parsePorcelainV2(output)).toEqual([
      expect.objectContaining({
        recordType: "ordinary",
        path: "content/technology/line\nfeed.md",
        index: ".",
        worktree: "M",
      }),
      expect.objectContaining({
        recordType: "rename",
        path: "content/technology/new name.md",
        originalPath: "content/technology/old name.md",
      }),
      expect.objectContaining({ recordType: "unmerged", path: "content/technology/conflict.md" }),
      expect.objectContaining({
        recordType: "untracked",
        path: "content/_assets/new-note/photo 1.png",
      }),
      expect.objectContaining({ recordType: "ignored", path: "private/life/ignored.md" }),
    ])
  })

  it("rejects truncated rename records and duplicate paths", () => {
    expect(() =>
      parsePorcelainV2("2 R. N... 100644 100644 100644 aaaaaaa aaaaaaa R100 content/new.md\0"),
    ).toThrow(/rename/i)
    expect(() => parsePorcelainV2("? content/a.md\0? content/a.md\0")).toThrow(/duplicate/i)
  })

  it("accepts a recreated rename source as a distinct current path", () => {
    const output =
      "2 R. N... 100644 100644 100644 aaaaaaa aaaaaaa R100 content/new.md\0content/old.md\0? content/old.md\0"
    expect(parsePorcelainV2(output)).toEqual([
      expect.objectContaining({
        recordType: "rename",
        path: "content/new.md",
        originalPath: "content/old.md",
      }),
      expect.objectContaining({ recordType: "untracked", path: "content/old.md" }),
    ])
  })
})

describe("listChanges", () => {
  it("groups a public note with owned attachments and reports deletions as unpublish", async () => {
    const fixture = await repository()
    await writeFile(join(fixture.root, "content", "technology", "css-grid.md"), "changed")
    await writeFile(
      join(fixture.root, "content", "_assets", "css-grid", "diagram one.png"),
      "image",
    )
    await writeFile(
      join(fixture.root, "private", "life", "journal.md"),
      "PRIVATE BODY MUST NOT LEAK",
    )
    await writeFile(join(fixture.root, "quartz.config.yaml"), "configuration: changed")
    await writeFile(join(fixture.root, "content", "technology", "new-note.md"), "new")
    await writeFile(join(fixture.root, "content", "technology", "retired.md"), "retired")
    await git(fixture.root, ["rm", "content/technology/retired.md"])

    const review = await listChanges({ workspace: fixture.root })
    expect(review.blockedReason).toMatch(/其他工具.*准备中的发布内容/)
    expect(review.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "css-grid",
          kind: "modified",
          selection: "default",
          paths: ["content/technology/css-grid.md", "content/_assets/css-grid/diagram one.png"],
          attachments: [
            { path: "content/_assets/css-grid/diagram one.png", label: "diagram one.png" },
          ],
        }),
        expect.objectContaining({ label: "new-note", kind: "added", selection: "default" }),
        expect.objectContaining({
          label: "retired",
          kind: "unpublish",
          selection: "default",
          description: "将从公开网站移除",
        }),
        expect.objectContaining({
          label: "journal",
          kind: "private",
          selection: "locked",
          paths: [],
        }),
        expect.objectContaining({
          label: "配置修改",
          kind: "config",
          selection: "optional",
          paths: ["quartz.config.yaml"],
        }),
      ]),
    )
    expect(JSON.stringify(review)).not.toContain("PRIVATE BODY MUST NOT LEAK")
  })

  it("does not treat an unstaged public edit as an existing prepared publication", async () => {
    const fixture = await repository()
    await writeFile(join(fixture.root, "content", "technology", "css-grid.md"), "changed")

    const review = await listChanges({ workspace: fixture.root })
    expect(review.blockedReason).toBeUndefined()
    expect(review.groups).toEqual([
      expect.objectContaining({ kind: "modified", selection: "default" }),
    ])
  })

  it("parses a real staged rename plus unstaged edit and keeps both publication paths", async () => {
    const fixture = await repository()
    await git(fixture.root, [
      "mv",
      "content/technology/css-grid.md",
      "content/technology/grid-layout.md",
    ])
    await writeFile(
      join(fixture.root, "content", "technology", "grid-layout.md"),
      "renamed and edited",
    )

    const review = await listChanges({ workspace: fixture.root })
    expect(review.blockedReason).toMatch(/其他工具.*准备中的发布内容/)
    expect(review.groups).toEqual([
      expect.objectContaining({
        label: "grid-layout",
        kind: "modified",
        selection: "default",
        paths: ["content/technology/grid-layout.md", "content/technology/css-grid.md"],
      }),
    ])
  })

  it("keeps a renamed-away public path selected for unpublish", async () => {
    const fixture = await repository()
    await writeFile(join(fixture.root, "moved-copy.md"), "public moved outside managed content")
    const status =
      "2 R. N... 100644 100644 100644 aaaaaaa aaaaaaa R100 moved-copy.md\0content/technology/css-grid.md\0"

    const review = await listChanges({ workspace: fixture.root, statusOutput: status })
    expect(review.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "css-grid",
          kind: "unpublish",
          selection: "default",
          paths: ["content/technology/css-grid.md"],
        }),
        expect.objectContaining({
          kind: "config",
          selection: "optional",
          paths: ["moved-copy.md"],
        }),
      ]),
    )
  })

  it("blocks unmerged input and rejects unsafe or symlinked managed paths", async () => {
    const fixture = await repository()
    const unmerged = await listChanges({
      workspace: fixture.root,
      statusOutput:
        "u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc content/technology/conflict.md\0",
    })
    expect(unmerged.blockedReason).toMatch(/冲突/)
    expect(unmerged.groups).toEqual([])

    await expect(
      listChanges({ workspace: fixture.root, statusOutput: "? ../outside.md\0" }),
    ).rejects.toThrow(/safe workspace path/i)

    const external = join(fixture.root, "external")
    await mkdir(external)
    await symlink(external, join(fixture.root, "content", "linked"), "junction")
    await writeFile(join(external, "escaped.md"), "outside")
    await expect(
      listChanges({ workspace: fixture.root, statusOutput: "? content/linked/escaped.md\0" }),
    ).rejects.toThrow(/symbolic link/i)
  })

  it("locks every private-root change even when it is not a note or owned attachment", async () => {
    const fixture = await repository()
    await writeFile(join(fixture.root, "private", "local-secret.txt"), "PRIVATE CONTENT")

    const review = await listChanges({
      workspace: fixture.root,
      statusOutput: "? private/local-secret.txt\0",
    })
    expect(review.groups).toEqual([
      expect.objectContaining({
        label: "local-secret",
        kind: "private",
        selection: "locked",
        paths: [],
      }),
    ])
    expect(JSON.stringify(review)).not.toContain("PRIVATE CONTENT")
  })

  it("keeps same-slug notes in different domains as separate logical groups", async () => {
    const fixture = await repository()
    await mkdir(join(fixture.root, "content", "life"), { recursive: true })
    await writeFile(join(fixture.root, "content", "life", "css-grid.md"), "life copy")
    await git(fixture.root, ["add", "content/life/css-grid.md"])
    await git(fixture.root, ["commit", "-m", "same slug in another domain"])
    await writeFile(join(fixture.root, "content", "technology", "css-grid.md"), "technology edit")
    await writeFile(join(fixture.root, "content", "life", "css-grid.md"), "life edit")

    const review = await listChanges({ workspace: fixture.root })
    expect(review.groups).toHaveLength(2)
    expect(review.groups.map((group) => group.paths)).toEqual([
      ["content/life/css-grid.md"],
      ["content/technology/css-grid.md"],
    ])
  })

  it("uses a bounded private-only ignored query so ignored private changes remain locked", async () => {
    const fixture = await repository()
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "! private/life/ignored.md\0! node_modules/cache.bin\0",
        stderr: "",
      })

    const review = await listChanges({ workspace: fixture.root, runner: { run } })
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1]?.[0].args).toEqual(
      expect.arrayContaining(["--ignored=matching", "--", "private"]),
    )
    expect(review.groups).toEqual([
      expect.objectContaining({ kind: "private", selection: "locked", paths: [] }),
    ])
  })

  it("reports an actually ignored private tree as locked metadata", async () => {
    const fixture = await repository()
    await writeFile(join(fixture.root, ".gitignore"), "private/\n")
    await git(fixture.root, ["add", ".gitignore"])
    await git(fixture.root, ["commit", "-m", "ignore private tree"])
    await writeFile(join(fixture.root, "private", "life", "ignored.md"), "PRIVATE BODY")

    const review = await listChanges({ workspace: fixture.root })
    expect(review.groups).toEqual([
      expect.objectContaining({ kind: "private", selection: "locked", paths: [] }),
    ])
    expect(JSON.stringify(review)).not.toContain("PRIVATE BODY")
  })
})
