import { mkdir, symlink, unlink, writeFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTemporaryGitRepository, git, type TemporaryGitRepository } from "../helpers/git"
import {
  createChangeScanner,
  createBoundedChangeCommandRunner,
  listChanges,
  MAX_CHANGE_STATUS_BYTES,
  parsePorcelainV2,
  type ChangeCommandRunner,
  type ChangeCommandProcess,
} from "../../src/main/services/changes"

const repositories: TemporaryGitRepository[] = []
const oidA = "a".repeat(40)
const oidB = "b".repeat(40)
const oidC = "c".repeat(40)
const raw = (value: string): Buffer => Buffer.from(value, "utf8")
function expectInvalid(action: () => unknown): void {
  try {
    action()
    throw new Error("expected parser rejection")
  } catch (error) {
    expect(error).toMatchObject({ code: "CHANGE_SCAN_INVALID" })
  }
}

function domainPage(title: string, order: number): string {
  return [
    "---",
    "gardenDomain: true",
    `title: ${title}`,
    `description: ${title} notes.`,
    `domainOrder: ${order}`,
    "---",
    "",
    `# ${title}`,
  ].join("\n")
}

async function addCommittedDomain(
  fixture: TemporaryGitRepository,
  slug: string,
  title: string,
  order: number,
): Promise<void> {
  await mkdir(join(fixture.root, "content", slug), { recursive: true })
  await mkdir(join(fixture.root, "private", slug), { recursive: true })
  await writeFile(join(fixture.root, "content", slug, "index.md"), domainPage(title, order))
  await git(fixture.root, ["add", `content/${slug}/index.md`])
  await git(fixture.root, ["commit", "-m", `add ${slug} domain`])
}

async function repository(): Promise<TemporaryGitRepository> {
  const fixture = await createTemporaryGitRepository()
  repositories.push(fixture)
  for (const [slug, title, order] of [
    ["technology", "Technology", 0],
    ["life", "Life", 1],
    ["reading", "Reading", 2],
  ] as const) {
    await mkdir(join(fixture.root, "content", slug), { recursive: true })
    await mkdir(join(fixture.root, "private", slug), { recursive: true })
    await writeFile(join(fixture.root, "content", slug, "index.md"), domainPage(title, order))
  }
  await mkdir(join(fixture.root, "content", "_assets", "css-grid"), { recursive: true })
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
      `1 .M N... 100644 100644 100644 ${oidA} ${oidA} content/technology/css-grid.md`,
      `2 R. N... 100644 100644 100644 ${oidB} ${oidB} R100 content/technology/new-name.md`,
      "content/technology/old name.md",
      `u UU N... 100644 100644 100644 100644 ${oidA} ${oidB} ${oidC} content/technology/conflict.md`,
      "? content/_assets/new-note/photo 1.png",
      "! private/life/ignored.md",
      "",
    ].join("\0")

    expect(parsePorcelainV2(raw(output))).toEqual([
      expect.objectContaining({
        recordType: "ordinary",
        path: "content/technology/css-grid.md",
        index: ".",
        worktree: "M",
      }),
      expect.objectContaining({
        recordType: "rename",
        path: "content/technology/new-name.md",
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
      parsePorcelainV2(raw(`2 R. N... 100644 100644 100644 ${oidA} ${oidA} R100 content/new.md\0`)),
    ).toThrow(/rename/i)
    expect(() => parsePorcelainV2(raw("? content/a.md\0? content/a.md\0"))).toThrow(/duplicate/i)
  })

  it("accepts a recreated rename source as a distinct current path", () => {
    const output = `2 R. N... 100644 100644 100644 ${oidA} ${oidA} R100 content/new.md\0content/old.md\0? content/old.md\0`
    expect(parsePorcelainV2(raw(output))).toEqual([
      expect.objectContaining({
        recordType: "rename",
        path: "content/new.md",
        originalPath: "content/old.md",
      }),
      expect.objectContaining({ recordType: "untracked", path: "content/old.md" }),
    ])
  })

  it("fails closed on invalid UTF-8, missing terminators, malformed fields, and invalid scores", () => {
    expectInvalid(() => parsePorcelainV2(Buffer.from([0x3f, 0x20, 0xff, 0x00])))
    expectInvalid(() =>
      parsePorcelainV2(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw("? content/a.md\0")])),
    )
    expectInvalid(() => parsePorcelainV2(raw("? content/a.md")))
    expectInvalid(() =>
      parsePorcelainV2(raw(`1 .M N... 10064 100644 100644 ${oidA} ${oidA} content/a.md\0`)),
    )
    expectInvalid(() =>
      parsePorcelainV2(
        raw(`2 R. N... 100644 100644 100644 ${oidA} ${oidA} X999 content/new.md\0content/old.md\0`),
      ),
    )
    expectInvalid(() =>
      parsePorcelainV2(raw(`1 R. N... 100644 100644 100644 ${oidA} ${oidA} content/a.md\0`)),
    )
    expectInvalid(() =>
      parsePorcelainV2(raw(`1 AA N... 100644 100644 100644 ${oidA} ${oidA} content/a.md\0`)),
    )
    expectInvalid(() =>
      parsePorcelainV2(
        raw(`1 .M N... 100644 100644 100644 ${oidA} ${"b".repeat(64)} content/a.md\0`),
      ),
    )
    expect(
      parsePorcelainV2(
        raw(`2 .R N... 100644 100644 100644 ${oidA} ${oidA} R100 content/new.md\0content/old.md\0`),
      ),
    ).toEqual([expect.objectContaining({ recordType: "rename", index: ".", worktree: "R" })])
    expect(
      parsePorcelainV2(
        raw(`2 .C N... 100644 100644 100644 ${oidA} ${oidA} C75 content/new.md\0content/old.md\0`),
      ),
    ).toEqual([expect.objectContaining({ recordType: "rename", index: ".", worktree: "C" })])
    for (const [status, score] of [
      [".R", "C100"],
      ["C.", "R100"],
      ["RR", "R100"],
      [".M", "R100"],
    ]) {
      expectInvalid(() =>
        parsePorcelainV2(
          raw(
            `2 ${status} N... 100644 100644 100644 ${oidA} ${oidA} ${score} content/new.md\0content/old.md\0`,
          ),
        ),
      )
    }
  })
})

describe("bounded change command runner", () => {
  function child(kill: () => boolean): {
    process: EventEmitter & ChangeCommandProcess
    stdout: PassThrough
  } {
    const stdout = new PassThrough()
    const process = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout,
      stderr: new PassThrough(),
      kill,
    }) as EventEmitter & ChangeCommandProcess
    return { process, stdout }
  }

  function request(
    signal: AbortSignal,
    deadlineMs = 100,
  ): Parameters<ChangeCommandRunner["run"]>[0] {
    return {
      executable: "git",
      args: ["status"],
      cwd: process.cwd(),
      env: {},
      signal,
      deadlineMs,
      maxStdoutBytes: 8,
      maxStderrBytes: 8,
    }
  }

  it("escalates kill=false and settles fail-closed without a close event", async () => {
    const { process } = child(() => false)
    const terminate = vi.fn(async () => false)
    const runner = createBoundedChangeCommandRunner({
      spawner: () => process,
      terminate,
      terminationDeadlineMs: 5,
    })
    const controller = new AbortController()
    const command = runner.run(request(controller.signal))
    controller.abort()

    await expect(command).rejects.toMatchObject({ code: "CHANGE_SCAN_FAILED" })
    expect(terminate).toHaveBeenCalledWith(process)
  })

  it("preserves the output-limit error after confirmed escalation and ignores late close", async () => {
    const { process, stdout } = child(() => false)
    const terminate = vi.fn(async () => true)
    const runner = createBoundedChangeCommandRunner({ spawner: () => process, terminate })
    const command = runner.run(request(new AbortController().signal))
    stdout.write(Buffer.alloc(9, 0x61))

    await expect(command).rejects.toMatchObject({ code: "CHANGE_SCAN_LIMIT" })
    expect(() => process.emit("close", null)).not.toThrow()
  })

  it("bounds timeout teardown even when direct kill succeeds but close never arrives", async () => {
    const { process } = child(() => true)
    const terminate = vi.fn(async () => true)
    const runner = createBoundedChangeCommandRunner({ spawner: () => process, terminate })

    await expect(runner.run(request(new AbortController().signal, 1))).rejects.toMatchObject({
      code: "CHANGE_SCAN_FAILED",
      message: expect.stringMatching(/timed out/i),
    })
    expect(terminate).toHaveBeenCalledWith(process)
  })

  it("does not let an immediate child close bypass process-tree confirmation", async () => {
    const { process } = child(() => true)
    let confirmTermination!: (confirmed: boolean) => void
    const terminate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          confirmTermination = resolve
        }),
    )
    const runner = createBoundedChangeCommandRunner({ spawner: () => process, terminate })
    const controller = new AbortController()
    const command = runner.run(request(controller.signal))
    let settled = false
    void command.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    controller.abort()
    process.emit("close", null)
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledWith(process))
    expect(settled).toBe(false)

    confirmTermination(true)
    await expect(command).rejects.toMatchObject({ code: "CHANGE_SCAN_CANCELLED" })
  })
})

describe("listChanges", () => {
  it("keeps a removed custom-domain landing page in the default unpublish selection", async () => {
    const fixture = await repository()
    await addCommittedDomain(fixture, "field-notes", "Field Notes", 3)
    await unlink(join(fixture.root, "content", "field-notes", "index.md"))

    const review = await listChanges({ workspace: fixture.root })

    expect(review.groups).toEqual([
      expect.objectContaining({
        label: "index",
        kind: "unpublish",
        selection: "default",
        paths: ["content/field-notes/index.md"],
      }),
    ])
  })

  it("keeps a note's removed-domain origin in the default selection when its landing is deleted", async () => {
    const fixture = await repository()
    await addCommittedDomain(fixture, "field-notes", "Field Notes", 3)
    await writeFile(join(fixture.root, "content", "field-notes", "observations.md"), "notes")
    await git(fixture.root, ["add", "content/field-notes/observations.md"])
    await git(fixture.root, ["commit", "-m", "add field notes observation"])
    await git(fixture.root, [
      "mv",
      "content/field-notes/observations.md",
      "content/technology/observations.md",
    ])
    await unlink(join(fixture.root, "content", "field-notes", "index.md"))

    const review = await listChanges({ workspace: fixture.root })

    expect(review.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "observations",
          kind: "modified",
          selection: "default",
          paths: ["content/technology/observations.md", "content/field-notes/observations.md"],
        }),
        expect.objectContaining({
          label: "index",
          kind: "unpublish",
          selection: "default",
          paths: ["content/field-notes/index.md"],
        }),
      ]),
    )
  })

  it("does not treat a similarly named deleted file as removed-domain evidence", async () => {
    const fixture = await repository()
    const status = raw(
      [
        `1 .D N... 100644 100644 100644 ${oidA} ${oidA} content/field-notes/indexXmd`,
        `1 .D N... 100644 100644 100644 ${oidA} ${oidA} content/field-notes/old-note.md`,
        "",
      ].join("\0"),
    )

    const review = await listChanges({ workspace: fixture.root, statusOutput: status })

    expect(review.groups).toEqual([
      expect.objectContaining({
        kind: "config",
        selection: "optional",
        paths: ["content/field-notes/indexXmd", "content/field-notes/old-note.md"],
      }),
    ])
  })

  it("does not expand publication classification when a domain appears after discovery", async () => {
    const fixture = await repository()
    await mkdir(join(fixture.root, "content", "field-notes"), { recursive: true })
    await writeFile(join(fixture.root, "content", "field-notes", "observations.md"), "notes")
    const run = vi
      .fn<ChangeCommandRunner["run"]>()
      .mockImplementationOnce(async () => {
        await writeFile(
          join(fixture.root, "content", "field-notes", "index.md"),
          domainPage("Field Notes", 3),
        )
        return {
          exitCode: 0,
          stdout: raw("? content/field-notes/observations.md\0"),
          stderr: Buffer.alloc(0),
        }
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })

    const review = await listChanges({ workspace: fixture.root, runner: { run } })

    expect(review.groups).toEqual([
      expect.objectContaining({
        kind: "config",
        selection: "optional",
        paths: ["content/field-notes/observations.md"],
      }),
    ])
  })

  it("counts custom-domain additions and modifications as default publication groups", async () => {
    const fixture = await repository()
    await addCommittedDomain(fixture, "field-notes", "Field Notes", 3)
    await writeFile(join(fixture.root, "content", "field-notes", "existing.md"), "original")
    await git(fixture.root, ["add", "content/field-notes/existing.md"])
    await git(fixture.root, ["commit", "-m", "add existing custom-domain note"])
    await writeFile(join(fixture.root, "content", "field-notes", "existing.md"), "changed")
    await writeFile(join(fixture.root, "content", "field-notes", "new-note.md"), "new")

    const review = await listChanges({ workspace: fixture.root })

    expect(review.groups.filter((group) => group.selection === "default")).toHaveLength(2)
    expect(review.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "existing",
          kind: "modified",
          selection: "default",
          paths: ["content/field-notes/existing.md"],
        }),
        expect.objectContaining({
          label: "new-note",
          kind: "added",
          selection: "default",
          paths: ["content/field-notes/new-note.md"],
        }),
      ]),
    )
  })

  it("keeps both custom-domain paths in one default group when a note is renamed", async () => {
    const fixture = await repository()
    await addCommittedDomain(fixture, "field-notes", "Field Notes", 3)
    await writeFile(join(fixture.root, "content", "field-notes", "old-name.md"), "note")
    await git(fixture.root, ["add", "content/field-notes/old-name.md"])
    await git(fixture.root, ["commit", "-m", "add custom-domain note"])
    await git(fixture.root, [
      "mv",
      "content/field-notes/old-name.md",
      "content/field-notes/new-name.md",
    ])

    const review = await listChanges({ workspace: fixture.root })

    expect(review.groups).toEqual([
      expect.objectContaining({
        label: "new-name",
        kind: "modified",
        selection: "default",
        paths: ["content/field-notes/new-name.md", "content/field-notes/old-name.md"],
      }),
    ])
  })

  it("locks a custom-domain private target and defaults its public origin to unpublish", async () => {
    const fixture = await repository()
    await addCommittedDomain(fixture, "field-notes", "Field Notes", 3)
    await writeFile(join(fixture.root, "private", "field-notes", "draft.md"), "private")
    const status = raw(
      `2 R. N... 100644 100644 100644 ${oidA} ${oidA} R100 private/field-notes/draft.md\0content/field-notes/published.md\0`,
    )

    const review = await listChanges({ workspace: fixture.root, statusOutput: status })

    expect(review.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "published",
          kind: "unpublish",
          selection: "default",
          paths: ["content/field-notes/published.md"],
        }),
        expect.objectContaining({
          label: "draft",
          kind: "private",
          selection: "locked",
          paths: [],
        }),
      ]),
    )
  })

  it("groups a custom-domain note modification with its owned attachment", async () => {
    const fixture = await repository()
    await addCommittedDomain(fixture, "field-notes", "Field Notes", 3)
    await writeFile(join(fixture.root, "content", "field-notes", "observations.md"), "original")
    await git(fixture.root, ["add", "content/field-notes/observations.md"])
    await git(fixture.root, ["commit", "-m", "add attachment owner"])
    await writeFile(join(fixture.root, "content", "field-notes", "observations.md"), "changed")
    await mkdir(join(fixture.root, "content", "_assets", "observations"), { recursive: true })
    await writeFile(
      join(fixture.root, "content", "_assets", "observations", "diagram.png"),
      "image",
    )

    const review = await listChanges({ workspace: fixture.root })

    expect(review.groups).toEqual([
      expect.objectContaining({
        label: "observations",
        kind: "modified",
        selection: "default",
        paths: ["content/field-notes/observations.md", "content/_assets/observations/diagram.png"],
        attachments: [{ path: "content/_assets/observations/diagram.png", label: "diagram.png" }],
      }),
    ])
  })

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

  it("forces rename detection even when repository status.renames is disabled", async () => {
    const fixture = await repository()
    await git(fixture.root, ["config", "status.renames", "false"])
    await git(fixture.root, [
      "mv",
      "content/technology/css-grid.md",
      "content/technology/grid-layout.md",
    ])

    const review = await listChanges({ workspace: fixture.root })
    expect(review.groups).toEqual([
      expect.objectContaining({
        kind: "modified",
        paths: ["content/technology/grid-layout.md", "content/technology/css-grid.md"],
      }),
    ])
  })

  it("keeps a renamed-away public path selected for unpublish", async () => {
    const fixture = await repository()
    await writeFile(join(fixture.root, "moved-copy.md"), "public moved outside managed content")
    const status = raw(
      `2 R. N... 100644 100644 100644 ${oidA} ${oidA} R100 moved-copy.md\0content/technology/css-grid.md\0`,
    )

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

  it.each([
    {
      name: "config to config",
      status: `2 R. N... 100644 100644 100644 ${oidA} ${oidA} R100 new.config.json\0old.config.json\0`,
      expected: [
        { kind: "config", selection: "optional", paths: ["new.config.json", "old.config.json"] },
      ],
    },
    {
      name: "config to public",
      status: `2 R. N... 100644 100644 100644 ${oidA} ${oidA} R100 content/technology/new-note.md\0old.config.json\0`,
      expected: [
        { kind: "modified", selection: "default", paths: ["content/technology/new-note.md"] },
        { kind: "config", selection: "optional", paths: ["old.config.json"] },
      ],
    },
    {
      name: "public to config",
      status: `2 R. N... 100644 100644 100644 ${oidA} ${oidA} R100 moved.json\0content/technology/css-grid.md\0`,
      expected: [
        { kind: "unpublish", selection: "default", paths: ["content/technology/css-grid.md"] },
        { kind: "config", selection: "optional", paths: ["moved.json"] },
      ],
    },
  ])("preserves unique delta ownership for $name rename", async ({ status, expected }) => {
    const fixture = await repository()
    const review = await listChanges({ workspace: fixture.root, statusOutput: raw(status) })
    expect(review.groups).toEqual(expected.map((value) => expect.objectContaining(value)))
    const allPaths = review.groups.flatMap((group) => group.paths)
    expect(new Set(allPaths).size).toBe(allPaths.length)
  })

  it("blocks a rename whose recreated origin would overlap selectable groups", async () => {
    const fixture = await repository()
    const status = `2 R. N... 100644 100644 100644 ${oidA} ${oidA} R100 content/technology/new-note.md\0content/technology/css-grid.md\0? content/technology/css-grid.md\0`
    const review = await listChanges({ workspace: fixture.root, statusOutput: raw(status) })
    expect(review.blockedReason).toMatch(/重叠|同时/)
    expect(review.groups).toEqual([])
  })

  it("blocks unmerged input and rejects unsafe or symlinked managed paths", async () => {
    const fixture = await repository()
    const unmerged = await listChanges({
      workspace: fixture.root,
      statusOutput: raw(
        `u UU N... 100644 100644 100644 100644 ${oidA} ${oidB} ${oidC} content/technology/conflict.md\0`,
      ),
    })
    expect(unmerged.blockedReason).toMatch(/冲突/)
    expect(unmerged.groups).toEqual([])

    await expect(
      listChanges({ workspace: fixture.root, statusOutput: raw("? ../outside.md\0") }),
    ).rejects.toThrow(/safe workspace path/i)

    const external = join(fixture.root, "external")
    await mkdir(external)
    await symlink(external, join(fixture.root, "content", "linked"), "junction")
    await writeFile(join(external, "escaped.md"), "outside")
    await expect(
      listChanges({
        workspace: fixture.root,
        statusOutput: raw("? content/linked/escaped.md\0"),
      }),
    ).rejects.toMatchObject({ code: "DOMAIN_UNSAFE_PATH" })
  })

  it("blocks dirty submodules and non-canonical or invalid managed note paths", async () => {
    const fixture = await repository()
    const dirty = await listChanges({
      workspace: fixture.root,
      statusOutput: raw(
        `1 .M S.M. 160000 160000 160000 ${oidA} ${oidA} content/technology/submodule\0`,
      ),
    })
    expect(dirty.blockedReason).toMatch(/子模块/)

    for (const path of [
      "Content/technology/unsafe.md",
      "Private/life/secret.md",
      "content/Technology/unsafe.md",
      "content/technology/Not-Kebab.md",
      "content/_Assets/css-grid/unsafe.png",
      "private/_Assets/journal/unsafe.png",
    ]) {
      const review = await listChanges({
        workspace: fixture.root,
        statusOutput: raw(`? ${path}\0`),
      })
      expect(review.blockedReason, path).toBeTruthy()
      expect(review.groups, path).toEqual([])
    }
  })

  it("locks every private-root change even when it is not a note or owned attachment", async () => {
    const fixture = await repository()
    await writeFile(join(fixture.root, "private", "local-secret.txt"), "PRIVATE CONTENT")

    const review = await listChanges({
      workspace: fixture.root,
      statusOutput: raw("? private/local-secret.txt\0"),
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

  it("keeps private note identities separate across domains", async () => {
    const fixture = await repository()
    const review = await listChanges({
      workspace: fixture.root,
      statusOutput: raw("? private/life/journal.md\0? private/reading/journal.md\0"),
    })
    expect(review.groups).toHaveLength(2)
    expect(review.groups.every((group) => group.selection === "locked")).toBe(true)
  })

  it("blocks ambiguous owned attachments instead of offering a standalone default group", async () => {
    const fixture = await repository()
    await mkdir(join(fixture.root, "content", "life"), { recursive: true })
    await writeFile(join(fixture.root, "content", "life", "css-grid.md"), "same slug")
    const review = await listChanges({
      workspace: fixture.root,
      statusOutput: raw("? content/_assets/css-grid/ambiguous.png\0"),
    })
    expect(review.blockedReason).toMatch(/附件.*归属/)
    expect(review.groups).toEqual([])
  })

  it("uses a bounded private-only ignored query so ignored private changes remain locked", async () => {
    const fixture = await repository()
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: raw("! private/life/ignored.md\0! node_modules/cache.bin\0"),
        stderr: Buffer.alloc(0),
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

  it("fails closed when the ignored-private query returns a case alias", async () => {
    const fixture = await repository()
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: raw("! Private/life/secret.md\0"),
        stderr: Buffer.alloc(0),
      })

    const review = await listChanges({ workspace: fixture.root, runner: { run } })
    expect(review.blockedReason).toMatch(/大小写/)
    expect(review.groups).toEqual([])
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

  it("rejects oversized output before parsing and supplies finite runner budgets", async () => {
    const fixture = await repository()
    await expect(
      listChanges({
        workspace: fixture.root,
        statusOutput: Buffer.alloc(MAX_CHANGE_STATUS_BYTES + 1, 0x61),
      }),
    ).rejects.toMatchObject({ code: "CHANGE_SCAN_LIMIT" })

    const run = vi
      .fn<ChangeCommandRunner["run"]>()
      .mockResolvedValue({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
    await listChanges({ workspace: fixture.root, runner: { run } })
    expect(run).toHaveBeenCalledTimes(2)
    for (const [request] of run.mock.calls) {
      expect(request.deadlineMs).toBeGreaterThan(0)
      expect(request.maxStdoutBytes).toBeGreaterThan(0)
      expect(request.maxStdoutBytes).toBeLessThanOrEqual(MAX_CHANGE_STATUS_BYTES)
      expect(request.maxStderrBytes).toBeGreaterThan(0)
      expect(request.args).toContain("--ignore-submodules=none")
    }
  })

  it("enforces a cumulative output budget across both serialized commands", async () => {
    const fixture = await repository()
    const half = Math.floor(MAX_CHANGE_STATUS_BYTES / 2) + 1
    const run = vi.fn<ChangeCommandRunner["run"]>().mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.alloc(half, 0x61),
      stderr: Buffer.alloc(0),
    })

    await expect(listChanges({ workspace: fixture.root, runner: { run } })).rejects.toMatchObject({
      code: "CHANGE_SCAN_LIMIT",
    })
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1]?.[0].deadlineMs).toBeLessThanOrEqual(
      run.mock.calls[0]?.[0].deadlineMs ?? 0,
    )
  })

  it("runs scans single-flight and aborts the superseded request", async () => {
    const fixture = await repository()
    let calls = 0
    const run: ChangeCommandRunner["run"] = (request) => {
      calls += 1
      if (calls === 1) {
        return new Promise((_, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject({ code: "CHANGE_SCAN_CANCELLED", message: "cancelled" }),
            { once: true },
          )
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
    }
    const scanner = createChangeScanner({ workspace: fixture.root, runner: { run } })
    const stale = scanner.list()
    await vi.waitFor(() => expect(calls).toBe(1))
    const current = scanner.list()
    await expect(stale).rejects.toMatchObject({ code: "CHANGE_SCAN_CANCELLED" })
    await expect(current).resolves.toEqual({ groups: [] })
    expect(calls).toBe(3)
  })

  it("waits for cancelled process teardown before starting the replacement scan", async () => {
    const fixture = await repository()
    let calls = 0
    let release: (() => void) | undefined
    const run: ChangeCommandRunner["run"] = (request) => {
      calls += 1
      if (calls === 1) {
        return new Promise((_, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              release = () => reject({ code: "CHANGE_SCAN_CANCELLED", message: "cancelled" })
            },
            { once: true },
          )
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
    }
    const scanner = createChangeScanner({ workspace: fixture.root, runner: { run } })
    const stale = scanner.list()
    await vi.waitFor(() => expect(calls).toBe(1))
    const current = scanner.list()
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    expect(calls).toBe(1)
    release?.()
    await expect(stale).rejects.toMatchObject({ code: "CHANGE_SCAN_CANCELLED" })
    await expect(current).resolves.toEqual({ groups: [] })
    expect(calls).toBe(3)
  })

  it("makes disposal terminal before awaiting active scan teardown", async () => {
    const fixture = await repository()
    let calls = 0
    let release: (() => void) | undefined
    const run: ChangeCommandRunner["run"] = (request) => {
      calls += 1
      return new Promise((_, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            release = () => reject({ code: "CHANGE_SCAN_CANCELLED", message: "cancelled" })
          },
          { once: true },
        )
      })
    }
    const scanner = createChangeScanner({ workspace: fixture.root, runner: { run } })
    const active = scanner.list()
    await vi.waitFor(() => expect(calls).toBe(1))

    const disposal = scanner.dispose()
    await expect(scanner.list()).rejects.toMatchObject({ code: "CHANGE_SCAN_FAILED" })
    expect(calls).toBe(1)
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    release?.()

    await expect(active).rejects.toMatchObject({ code: "CHANGE_SCAN_CANCELLED" })
    await expect(disposal).resolves.toBeUndefined()
    await expect(scanner.list()).rejects.toMatchObject({ code: "CHANGE_SCAN_FAILED" })
    expect(calls).toBe(1)
  })

  it("does not start a queued scan after predecessor termination becomes uncertain", async () => {
    const fixture = await repository()
    let spawnCalls = 0
    const commandRunner = createBoundedChangeCommandRunner({
      spawner: () => {
        spawnCalls += 1
        const process = Object.assign(new EventEmitter(), {
          pid: 4242,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => false,
        }) as EventEmitter & ChangeCommandProcess
        if (spawnCalls > 1) {
          queueMicrotask(() => process.emit("close", 0))
        }
        return process
      },
      terminate: async () => false,
      terminationDeadlineMs: 5,
    })
    const scanner = createChangeScanner({ workspace: fixture.root, runner: commandRunner })
    const predecessor = scanner.list()
    await vi.waitFor(() => expect(spawnCalls).toBe(1))

    const queued = scanner.list()
    await expect(predecessor).rejects.toMatchObject({ code: "CHANGE_SCAN_FAILED" })
    await expect(queued).rejects.toMatchObject({ code: "CHANGE_SCAN_FAILED" })
    await expect(scanner.list()).rejects.toMatchObject({ code: "CHANGE_SCAN_FAILED" })
    expect(spawnCalls).toBe(1)
  })
})
