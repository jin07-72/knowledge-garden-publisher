import { cp, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { scanNotes } from "../../src/main/services/noteIndex"
import type { AppError } from "../../src/shared/contracts"
import { removeTemporaryDirectory } from "../helpers/fs"

const temporaryDirectories: string[] = []

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
  return root
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

describe("scanNotes", () => {
  it("indexes public and private notes without leaking private source", async () => {
    const fixtureRoot = resolve("tests/fixtures/garden")
    const root = await createGarden()
    await cp(fixtureRoot, root, { recursive: true })
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
    for (const note of notes) {
      expect(note).not.toHaveProperty("markdown")
      expect(note).not.toHaveProperty("raw")
      expect(note).not.toHaveProperty("content")
    }
  })

  it("scans nested root directories and normalizes returned paths", async () => {
    const root = await createGarden()
    await writeNote(root, "content", "technology", "css-grid.md")

    const [note] = await scanNotes(root)

    expect(note.path).toBe("content/technology/css-grid.md")
  })

  it("supports every allowed domain", async () => {
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

  it("excludes the landing page and domain index pages", async () => {
    const root = await createGarden()
    await writeFile(join(root, "content", "index.md"), "not a note")
    await writeNote(root, "content", "technology", "index.md")
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
      "non-string tag",
      "---\ntitle: Note\ndate: 2026-09-18\ndescription: Number tag.\ntags: [1]\n---",
    ],
    [
      "invalid YAML",
      "---\ntitle: [\ndate: 2026-09-18\ndescription: Broken YAML.\ntags: [test]\n---",
    ],
  ])("rejects %s metadata without source leakage", async (_description, source) => {
    const root = await createGarden()
    await writeNote(root, "content", "technology", "note.md", `${source}\nPRIVATE BODY`)

    await expect(scanNotes(root)).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("NOTE_INDEX_INVALID")
      expect(JSON.stringify(error)).not.toContain("PRIVATE BODY")
      return true
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
})
