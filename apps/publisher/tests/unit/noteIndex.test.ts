import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { scanNotes } from "../../src/main/services/noteIndex"
import type { AppError } from "../../src/shared/contracts"
import { removeTemporaryDirectory } from "../helpers/fs"

const temporaryDirectories: string[] = []
const executeFile = promisify(execFile)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory))
})

async function createGarden(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-note-index-"))
  temporaryDirectories.push(root)
  await Promise.all([
    mkdir(join(root, "content"), { recursive: true }),
    mkdir(join(root, "private"), { recursive: true }),
  ])
  await Promise.all(
    ["technology", "reading", "language", "life"].map((domain) => markDomain(root, domain)),
  )
  return root
}

async function markDomain(root: string, domain: string): Promise<void> {
  await mkdir(join(root, "content", domain), { recursive: true })
  await writeFile(
    join(root, "content", domain, "index.md"),
    `---\ngardenDomain: true\ntitle: ${domain}\ndescription: Test domain.\n---\n`,
  )
}

async function writeNote(
  root: string,
  visibility: "content" | "private",
  domain: string,
  filename: string,
  frontmatter = [
    "---",
    "title: Note",
    "date: 2026-09-18",
    "description: A valid note.",
    "tags:",
    "  - test",
    "---",
    "",
    "# Note",
  ].join("\n"),
): Promise<string> {
  const path = join(root, visibility, domain, filename)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, frontmatter)
  return path
}

function errorCode(error: unknown): AppError["code"] | undefined {
  return (error as Partial<AppError>).code
}

async function publicationErrors(source: string): Promise<readonly string[]> {
  const validatorPath = pathToFileURL(
    resolve(process.cwd(), "../..", "scripts/content-validation.mjs"),
  )
  const script = `import { validateNote } from ${JSON.stringify(validatorPath.href)}; process.stdout.write(JSON.stringify(validateNote("content/technology/note.md", process.argv[1])))`
  const { stdout } = await executeFile(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    "--",
    source,
  ])
  return JSON.parse(stdout) as readonly string[]
}

describe("scanNotes", () => {
  it("indexes public and private notes without leaking private source", async () => {
    const fixtureRoot = resolve("tests/fixtures/garden")
    const root = await createGarden()
    await cp(fixtureRoot, root, { recursive: true })
    await Promise.all([markDomain(root, "technology"), markDomain(root, "life")])
    const journal = join(root, "private", "life", "journal.md")
    const cssGrid = join(root, "content", "technology", "css-grid.md")
    await utimes(
      journal,
      new Date("2026-09-18T12:00:00.000Z"),
      new Date("2026-09-18T12:00:00.000Z"),
    )
    await utimes(
      cssGrid,
      new Date("2026-09-18T11:00:00.000Z"),
      new Date("2026-09-18T11:00:00.000Z"),
    )

    const notes = await scanNotes(root)

    expect(notes.map((note) => [note.slug, note.visibility])).toEqual([
      ["journal", "private"],
      ["css-grid", "public"],
    ])
    expect(notes.find((note) => note.slug === "journal")).not.toHaveProperty("body")
    expect(JSON.stringify(notes)).not.toContain("PRIVATE_JOURNAL_SENTINEL")
    for (const note of notes) {
      expect(note).not.toHaveProperty("markdown")
      expect(note).not.toHaveProperty("raw")
      expect(note).not.toHaveProperty("content")
      expect(note).not.toHaveProperty("modifiedAt")
    }
  })

  it("scans nested root directories and normalizes returned paths", async () => {
    const root = await createGarden()
    await writeNote(root, "content", "technology", "css-grid.md")

    const [note] = await scanNotes(root)

    expect(note.path).toBe("content/technology/css-grid.md")
  })

  it("supports every discovered domain", async () => {
    const root = await createGarden()
    const paths = await Promise.all([
      writeNote(
        root,
        "content",
        "technology",
        "technology.md",
        "---\ntitle: Alpha\ndate: 2026-09-18\ndescription: A.\ntags: [test]\n---",
      ),
      writeNote(
        root,
        "content",
        "reading",
        "reading.md",
        "---\ntitle: Bravo\ndate: 2026-09-18\ndescription: B.\ntags: [test]\n---",
      ),
      writeNote(
        root,
        "content",
        "language",
        "language.md",
        "---\ntitle: Charlie\ndate: 2026-09-18\ndescription: C.\ntags: [test]\n---",
      ),
      writeNote(
        root,
        "private",
        "life",
        "life.md",
        "---\ntitle: Delta\ndate: 2026-09-18\ndescription: D.\ntags: [test]\n---",
      ),
    ])
    const timestamp = new Date("2026-09-18T10:00:00.000Z")
    await Promise.all(paths.map((path) => utimes(path, timestamp, timestamp)))

    const notes = await scanNotes(root)

    expect(notes.map((note) => note.domain)).toEqual(["technology", "reading", "language", "life"])
  })

  it("indexes a custom marked domain and rejects a note in an unmarked folder", async () => {
    const root = await createGarden()
    await markDomain(root, "artificial-intelligence")
    await writeNote(root, "content", "artificial-intelligence", "transformers.md")
    await writeNote(root, "private", "artificial-intelligence", "private-models.md")
    await mkdir(join(root, "content", "unmarked"), { recursive: true })
    await writeFile(
      join(root, "content", "unmarked", "hidden.md"),
      "---\ntitle: Hidden\ndate: 2026-09-18\ndescription: Hidden.\ntags: [test]\n---\n",
    )

    await expect(scanNotes(root)).rejects.toMatchObject({ code: "NOTE_INDEX_INVALID" })
    await rm(join(root, "content", "unmarked"), { recursive: true })
    await expect(scanNotes(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: "artificial-intelligence", slug: "transformers" }),
        expect.objectContaining({ domain: "artificial-intelligence", slug: "private-models" }),
      ]),
    )
  })

  it("fails closed when a discovered domain landing page is replaced during the scan", async () => {
    const root = await createGarden()
    await markDomain(root, "artificial-intelligence")
    await writeNote(root, "content", "artificial-intelligence", "transformers.md")
    let replaced = false

    await expect(
      scanNotes(root, {
        beforeOpen: async (path) => {
          if (replaced || !path.endsWith("transformers.md")) return
          replaced = true
          const landing = join(root, "content", "artificial-intelligence", "index.md")
          await rm(landing)
          await writeFile(landing, "---\ngardenDomain: false\n---\n")
        },
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^NOTE_INDEX_/) })
    expect(replaced).toBe(true)
  })

  it("excludes the landing page and domain index pages", async () => {
    const root = await createGarden()
    await writeFile(join(root, "content", "index.md"), "not a note")
    await writeNote(root, "content", "technology", "css-grid.md")

    const notes = await scanNotes(root)

    expect(notes.map((note) => note.slug)).toEqual(["css-grid"])
  })

  it("ignores dotfiles and dot-directories anywhere below a canonical root", async () => {
    const root = await createGarden()
    await Promise.all([
      writeNote(root, "content", "technology", ".draft.md"),
      writeNote(root, "content", ".cache", "hidden.md"),
      writeNote(root, "content", "technology", "css-grid.md"),
    ])

    const notes = await scanNotes(root)

    expect(notes.map((note) => note.slug)).toEqual(["css-grid"])
  })

  it("uses a case-sensitive .md extension policy", async () => {
    const root = await createGarden()
    await Promise.all([
      writeNote(root, "content", "technology", "ignored.MD"),
      writeNote(root, "content", "technology", "css-grid.md"),
    ])

    const notes = await scanNotes(root)

    expect(notes.map((note) => note.slug)).toEqual(["css-grid"])
  })

  it.each([
    ["technology", "Upper.md"],
    ["technology", "two words.md"],
    ["technology", "escape..md"],
    ["technology/nested", "note.md"],
    ["unapproved", "note.md"],
  ])("rejects invalid note location %s/%s without source leakage", async (domain, filename) => {
    const root = await createGarden()
    await writeNote(
      root,
      "content",
      domain,
      filename,
      "---\ntitle: Keep this private\ndate: 2026-09-18\ndescription: Secret description.\ntags: [test]\n---\nTOP SECRET",
    )

    await expect(scanNotes(root)).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("NOTE_INDEX_INVALID")
      expect(JSON.stringify(error)).not.toContain("TOP SECRET")
      expect(JSON.stringify(error)).not.toContain("Secret description")
      return true
    })
  })

  it.each([
    ["missing frontmatter", "no frontmatter"],
    ["missing title", "---\ndate: 2026-09-18\ndescription: Missing title.\ntags: [test]\n---"],
    ["missing date", "---\ntitle: Note\ndescription: Missing date.\ntags: [test]\n---"],
    ["missing description", "---\ntitle: Note\ndate: 2026-09-18\ntags: [test]\n---"],
    [
      "scalar tags",
      "---\ntitle: Note\ndate: 2026-09-18\ndescription: Scalar tags.\ntags: test\n---",
    ],
    [
      "invalid YAML",
      "---\ntitle: [\ndate: 2026-09-18\ndescription: Broken YAML.\ntags: [test]\n---",
    ],
  ])("rejects %s metadata without source leakage", async (_description, source) => {
    const root = await createGarden()
    await writeNote(
      root,
      "content",
      "technology",
      "note.md",
      `${source}\nPRIVATE_METADATA_SENTINEL`,
    )

    await expect(scanNotes(root)).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("NOTE_INDEX_INVALID")
      expect(JSON.stringify(error)).not.toContain("PRIVATE_METADATA_SENTINEL")
      return true
    })
  })

  it("reports canonical-root failures in content then private order", async () => {
    const root = await createGarden()
    await rm(join(root, "content"), { recursive: true })
    await rm(join(root, "private"), { recursive: true })

    await expect(scanNotes(root)).rejects.toMatchObject({
      code: "NOTE_INDEX_ACCESS_FAILED",
      details: { path: "content" },
    })
  })

  it("rejects an unclosed frontmatter block", async () => {
    const root = await createGarden()
    const path = join(root, "content", "technology", "unclosed.md")
    await mkdir(join(root, "content", "technology"), { recursive: true })
    await writeFile(
      path,
      "---\ntitle: Note\ndate: 2026-09-18\ndescription: Missing closing delimiter.\ntags: [test]",
    )

    await expect(scanNotes(root)).rejects.toMatchObject({ code: "NOTE_INDEX_INVALID" })
  })

  it("keeps a non-empty date string accepted by the repository validator and exposes only a stable string", async () => {
    const root = await createGarden()
    await writeNote(
      root,
      "content",
      "technology",
      "date.md",
      "---\ntitle: Date\ndate: not-a-calendar-date\ndescription: Validator-compatible date text.\ntags: [test]\n---",
    )

    const [note] = await scanNotes(root)

    expect(note.date).toBe("not-a-calendar-date")
    expect(typeof note.date).toBe("string")
  })

  it("accepts exactly the metadata accepted by the publication validator", async () => {
    const corpus = [
      ["BOM", "\uFEFF---\ntitle: Note\ndate: 2026-09-18\ndescription: Valid.\ntags: [test]\n---"],
      [
        "unquoted date",
        "---\ntitle: Note\ndate: 2026-09-18\ndescription: Valid.\ntags: [test]\n---",
      ],
      [
        "quoted date",
        '---\ntitle: Note\ndate: "2026-09-18"\ndescription: Valid.\ntags: [test]\n---',
      ],
      ["scalar tags", "---\ntitle: Note\ndate: 2026-09-18\ndescription: Invalid.\ntags: test\n---"],
      ["missing tags", "---\ntitle: Note\ndate: 2026-09-18\ndescription: Invalid.\n---"],
      ["empty tags", "---\ntitle: Note\ndate: 2026-09-18\ndescription: Invalid.\ntags: []\n---"],
      ["numeric tags", "---\ntitle: Note\ndate: 2026-09-18\ndescription: Valid.\ntags: [1]\n---"],
      [
        "mixed tags",
        "---\ntitle: Note\ndate: 2026-09-18\ndescription: Valid.\ntags: [1, mixed, false]\n---",
      ],
      ["malformed", "---\ntitle: [\ndate: 2026-09-18\ndescription: Invalid.\ntags: [test]\n---"],
      ["unclosed", "---\ntitle: Note\ndate: 2026-09-18\ndescription: Invalid.\ntags: [test]"],
      ["empty title", "---\ntitle: \ndate: 2026-09-18\ndescription: Invalid.\ntags: [test]\n---"],
      ["empty date", "---\ntitle: Note\ndate: \ndescription: Invalid.\ntags: [test]\n---"],
      ["empty description", "---\ntitle: Note\ndate: 2026-09-18\ndescription: \ntags: [test]\n---"],
    ] as const
    const acceptedDates = new Map<string, string>()

    for (const [name, source] of corpus) {
      const root = await createGarden()
      await writeNote(root, "content", "technology", "note.md", source)
      const acceptedByPublication = (await publicationErrors(source)).length === 0
      const scanned = scanNotes(root)
      if (acceptedByPublication) {
        const [note] = await scanned
        expect(note, name).toBeDefined()
        expect(typeof note?.date, name).toBe("string")
        acceptedDates.set(name, note!.date)
      } else {
        await expect(scanned, name).rejects.toMatchObject({ code: "NOTE_INDEX_INVALID" })
      }
    }

    expect(acceptedDates.get("unquoted date")).toBe("2026-09-18")
    expect(acceptedDates.get("quoted date")).toBe(acceptedDates.get("unquoted date"))

    const root = await createGarden()
    await writeNote(
      root,
      "content",
      "technology",
      "numeric.md",
      "---\ntitle: Note\ndate: 2026-09-18\ndescription: Valid.\ntags: [1, mixed, false]\n---",
    )
    const [note] = await scanNotes(root)
    expect(note.date).toBe("2026-09-18")
    expect(note.tags).toEqual(["1", "mixed", "false"])
  })

  it("sorts by updatedAt descending and title with a stable code-point tie-breaker", async () => {
    const root = await createGarden()
    const alpha = await writeNote(
      root,
      "content",
      "technology",
      "alpha.md",
      "---\ntitle: Alpha\ndate: 2026-09-18\ndescription: A.\ntags: [test]\n---",
    )
    const bravo = await writeNote(
      root,
      "content",
      "reading",
      "bravo.md",
      "---\ntitle: Bravo\ndate: 2026-09-18\ndescription: B.\ntags: [test]\n---",
    )
    const newest = await writeNote(
      root,
      "private",
      "life",
      "newest.md",
      "---\ntitle: Newest\ndate: 2026-09-18\ndescription: N.\ntags: [test]\n---",
    )
    const tieTime = new Date("2026-09-18T10:00:00.000Z")
    await Promise.all([
      utimes(alpha, tieTime, tieTime),
      utimes(bravo, tieTime, tieTime),
      utimes(newest, new Date("2026-09-18T11:00:00.000Z"), new Date("2026-09-18T11:00:00.000Z")),
    ])

    const notes = await scanNotes(root)

    expect(notes.map((note) => note.title)).toEqual(["Newest", "Alpha", "Bravo"])
    expect(notes[1]?.updatedAt).toBe(notes[2]?.updatedAt)
    expect(notes[0]?.updatedAt).toBe("2026-09-18T11:00:00.000Z")
  })

  it("rejects duplicate domain and slug identities across public and private roots", async () => {
    const root = await createGarden()
    await Promise.all([
      writeNote(root, "content", "technology", "same-note.md"),
      writeNote(root, "private", "technology", "same-note.md"),
    ])

    await expect(scanNotes(root)).rejects.toMatchObject({
      code: "NOTE_INDEX_DUPLICATE",
      details: { identity: "technology/same-note" },
    })
  })

  it("rejects linked files without reading through them", async ({ skip }) => {
    const root = await createGarden()
    const outside = await mkdtemp(join(tmpdir(), "garden-note-index-outside-"))
    temporaryDirectories.push(outside)
    const target = join(outside, "secret.md")
    await writeFile(
      target,
      "---\ntitle: Outside\ndate: 2026-09-18\ndescription: Outside.\ntags: [test]\n---\nSECRET",
    )
    const linkedPath = join(root, "content", "technology", "linked.md")
    await mkdir(join(root, "content", "technology"), { recursive: true })
    try {
      await symlink(target, linkedPath, "file")
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }

    await expect(scanNotes(root)).rejects.toMatchObject({
      code: "NOTE_INDEX_UNSAFE_PATH",
      details: { path: "content/technology/linked.md" },
    })
  })

  it("rejects a deterministic replacement with an outside link before reading it", async ({
    skip,
  }) => {
    const root = await createGarden()
    const outside = await mkdtemp(join(tmpdir(), "garden-note-index-outside-"))
    temporaryDirectories.push(outside)
    const target = join(outside, "outside.md")
    const notePath = await writeNote(root, "content", "technology", "note.md")
    await writeFile(
      target,
      "---\ntitle: Outside\ndate: 2026-09-18\ndescription: Outside.\ntags: [test]\n---\nOUTSIDE_BODY_SENTINEL",
    )

    await expect(
      scanNotes(root, {
        beforeOpen: async (path) => {
          if (path !== "content/technology/note.md") return
          await rm(notePath)
          try {
            await symlink(target, notePath, "file")
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
            throw error
          }
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("NOTE_INDEX_UNSAFE_PATH")
      expect(JSON.stringify(error)).not.toContain("OUTSIDE_BODY_SENTINEL")
      return true
    })
  })

  it("rejects a parent-directory replacement that resolves the candidate outside the root", async () => {
    const root = await createGarden()
    const outside = await mkdtemp(join(tmpdir(), "garden-note-index-outside-"))
    temporaryDirectories.push(outside)
    const domainPath = join(root, "content", "technology")
    const originalDomainPath = join(root, "content", "technology-original")
    await writeNote(root, "content", "technology", "note.md")
    await writeFile(
      join(outside, "note.md"),
      "---\ntitle: Outside\ndate: 2026-09-18\ndescription: Outside.\ntags: [test]\n---\nOUTSIDE_DIRECTORY_SENTINEL",
    )

    await expect(
      scanNotes(root, {
        beforeOpen: async (path) => {
          if (path !== "content/technology/note.md") return
          await rename(domainPath, originalDomainPath)
          await symlink(outside, domainPath, process.platform === "win32" ? "junction" : "dir")
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("NOTE_INDEX_UNSAFE_PATH")
      expect(JSON.stringify(error)).not.toContain("OUTSIDE_DIRECTORY_SENTINEL")
      return true
    })
  })

  it("rejects a regular-file identity change between the pre-check and open", async () => {
    const root = await createGarden()
    const notePath = await writeNote(root, "content", "technology", "note.md")
    const replacementPath = await writeNote(
      root,
      "content",
      "technology",
      "replacement.md",
      "---\ntitle: Replacement\ndate: 2026-09-18\ndescription: Replacement.\ntags: [test]\n---\nPRE_OPEN_REPLACEMENT_SENTINEL",
    )

    await expect(
      scanNotes(root, {
        beforeOpen: async (path) => {
          if (path !== "content/technology/note.md") return
          await rm(notePath)
          await rename(replacementPath, notePath)
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("NOTE_INDEX_CHANGED")
      expect(JSON.stringify(error)).not.toContain("PRE_OPEN_REPLACEMENT_SENTINEL")
      return true
    })
  })

  it("rejects a deterministic regular-file replacement after reading", async () => {
    const root = await createGarden()
    const notePath = await writeNote(root, "content", "technology", "note.md")
    const replacementPath = await writeNote(
      root,
      "content",
      "technology",
      "replacement.md",
      "---\ntitle: Replacement\ndate: 2026-09-18\ndescription: Replacement.\ntags: [test]\n---\nREPLACEMENT_BODY_SENTINEL",
    )

    await expect(
      scanNotes(root, {
        afterRead: async (path) => {
          if (path !== "content/technology/note.md") return
          await rm(notePath)
          await rename(replacementPath, notePath)
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("NOTE_INDEX_CHANGED")
      expect(JSON.stringify(error)).not.toContain("REPLACEMENT_BODY_SENTINEL")
      return true
    })
  })

  it("rejects an in-place same-size rewrite even when the mtime is restored", async () => {
    const root = await createGarden()
    const source = [
      "---",
      "title: Note",
      "date: 2026-09-18",
      "description: A valid note.",
      "tags: [test]",
      "---",
      "",
      "# Note",
    ].join("\n")
    const notePath = await writeNote(root, "content", "technology", "note.md", source)
    const fixedTime = new Date("2026-09-18T10:00:00.000Z")
    await utimes(notePath, fixedTime, fixedTime)

    await expect(
      scanNotes(root, {
        afterRead: async (path) => {
          if (path !== "content/technology/note.md") return
          await writeFile(notePath, source.replace("# Note", "# Evil"))
          await utimes(notePath, fixedTime, fixedTime)
        },
      }),
    ).rejects.toMatchObject({ code: "NOTE_INDEX_CHANGED" })
  })

  it("rejects linked directories without traversing them", async ({ skip }) => {
    const root = await createGarden()
    const outside = await mkdtemp(join(tmpdir(), "garden-note-index-outside-"))
    temporaryDirectories.push(outside)
    await writeNote(outside, "content", "technology", "secret.md")
    const linkedPath = join(root, "content", "technology", "linked")
    await mkdir(join(root, "content", "technology"), { recursive: true })
    try {
      await symlink(
        join(outside, "content"),
        linkedPath,
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }

    await expect(scanNotes(root)).rejects.toMatchObject({
      code: "NOTE_INDEX_UNSAFE_PATH",
      details: { path: "content/technology/linked" },
    })
  })

  it("maps filesystem failures separately without source leakage", async () => {
    const root = await createGarden()
    await writeNote(root, "content", "technology", "note.md")
    await rm(join(root, "private"), { recursive: true })

    await expect(scanNotes(root)).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("NOTE_INDEX_ACCESS_FAILED")
      expect(JSON.stringify(error)).not.toContain("# Note")
      return true
    })
  })

  it("does not leak a private body sentinel through a serialized indexing error", async () => {
    const root = await createGarden()
    await writeNote(
      root,
      "private",
      "life",
      "invalid.md",
      "---\ntitle: \ndate: 2026-09-18\ndescription: Invalid private note.\ntags: [test]\n---\nPRIVATE_ERROR_SENTINEL",
    )

    await expect(scanNotes(root)).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("NOTE_INDEX_INVALID")
      expect(JSON.stringify(error)).not.toContain("PRIVATE_ERROR_SENTINEL")
      return true
    })
  })
})
