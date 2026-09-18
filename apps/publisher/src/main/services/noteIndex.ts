import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import matter from "gray-matter"
import type { AppError, NoteSummary, Visibility } from "../../shared/contracts"

type NoteDomain = NoteSummary["domain"]

const noteDomains = new Set<NoteDomain>(["technology", "reading", "language", "life"])
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface ScanRoot {
  readonly directory: string
  readonly name: "content" | "private"
  readonly visibility: Visibility
}

function toForwardSlashes(path: string): string {
  return path.replaceAll("\\", "/")
}

function isInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate)
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference))
}

function appError(
  code: AppError["code"],
  message: string,
  details?: AppError["details"],
): AppError {
  return details === undefined
    ? ({ code, message } as AppError)
    : ({ code, message, details } as AppError)
}

function indexPath(workspace: string, candidate: string): string {
  return toForwardSlashes(relative(workspace, candidate))
}

function accessError(path: string): AppError {
  return appError("NOTE_INDEX_ACCESS_FAILED", "Could not read a garden path.", { path })
}

function unsafePathError(path: string): AppError {
  return appError("NOTE_INDEX_UNSAFE_PATH", "Linked paths cannot be indexed.", { path })
}

function invalidNoteError(path: string, reason: string): AppError {
  return appError("NOTE_INDEX_INVALID", "A note has an invalid location or metadata.", {
    path,
    reason,
  })
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function stableDate(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString()
  return undefined
}

function metadataFor(
  path: string,
  source: string,
): Pick<NoteSummary, "title" | "date" | "description" | "tags"> {
  // Keep the same delimiter rule as scripts/content-validation.mjs. gray-matter
  // otherwise accepts an opening delimiter without its required closing one.
  if (!/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.test(source)) {
    throw invalidNoteError(path, "missing frontmatter")
  }
  let data: Record<string, unknown>
  try {
    data = matter(source).data as Record<string, unknown>
  } catch {
    throw invalidNoteError(path, "invalid frontmatter")
  }

  const date = stableDate(data.date)
  if (!hasText(data.title)) throw invalidNoteError(path, "title must be non-empty")
  if (date === undefined) throw invalidNoteError(path, "date must be non-empty")
  if (!hasText(data.description)) throw invalidNoteError(path, "description must be non-empty")
  if (
    !Array.isArray(data.tags) ||
    data.tags.length === 0 ||
    !data.tags.every((tag) => typeof tag === "string")
  ) {
    throw invalidNoteError(path, "tags must be a non-empty string array")
  }

  return { title: data.title, date, description: data.description, tags: data.tags }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareNotes(left: NoteSummary, right: NoteSummary): number {
  const dateOrder = compareText(right.updatedAt, left.updatedAt)
  if (dateOrder !== 0) return dateOrder
  const titleOrder = compareText(left.title, right.title)
  if (titleOrder !== 0) return titleOrder
  return compareText(left.path, right.path)
}

async function canonicalScanRoot(
  workspace: string,
  name: ScanRoot["name"],
  visibility: Visibility,
): Promise<ScanRoot> {
  const candidate = resolve(workspace, name)
  const path = indexPath(workspace, candidate)
  try {
    const linked = await lstat(candidate)
    if (linked.isSymbolicLink()) throw unsafePathError(path)
    const directory = await realpath(candidate)
    if (!isInside(workspace, directory)) throw unsafePathError(path)
    if (!(await stat(directory)).isDirectory()) throw accessError(path)
    return { directory, name, visibility }
  } catch (error) {
    if (isIndexError(error)) throw error
    throw accessError(path)
  }
}

function isIndexError(error: unknown): error is AppError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("NOTE_INDEX_")
  )
}

function locationFor(
  root: ScanRoot,
  workspace: string,
  file: string,
): { domain: NoteDomain; slug: string; path: string } | undefined {
  const path = indexPath(workspace, file)
  const parts = toForwardSlashes(relative(root.directory, file)).split("/")
  if (root.name === "content" && parts.length === 1 && parts[0] === "index.md") return undefined
  if (parts.length !== 2 || !noteDomains.has(parts[0] as NoteDomain)) {
    throw invalidNoteError(path, "notes must be directly inside an allowed domain")
  }
  const domain = parts[0] as NoteDomain
  if (parts[1] === "index.md") return undefined
  const slug = parts[1].slice(0, -3)
  if (!slugPattern.test(slug)) throw invalidNoteError(path, "slug must be lowercase kebab-case")
  return { domain, slug, path }
}

async function scanDirectory(
  workspace: string,
  root: ScanRoot,
  directory: string,
  notes: NoteSummary[],
  identities: Set<string>,
): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    throw accessError(indexPath(workspace, directory))
  }

  entries.sort((left, right) => compareText(left.name, right.name))
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const candidate = resolve(directory, entry.name)
    const candidatePath = indexPath(workspace, candidate)
    let linked
    try {
      linked = await lstat(candidate)
    } catch {
      throw accessError(candidatePath)
    }
    if (linked.isSymbolicLink()) throw unsafePathError(candidatePath)

    if (linked.isDirectory()) {
      let canonicalDirectory: string
      try {
        canonicalDirectory = await realpath(candidate)
      } catch {
        throw accessError(candidatePath)
      }
      if (!isInside(root.directory, canonicalDirectory)) throw unsafePathError(candidatePath)
      await scanDirectory(workspace, root, canonicalDirectory, notes, identities)
      continue
    }
    if (!linked.isFile() || !entry.name.endsWith(".md")) continue

    let canonicalFile: string
    let fileDetails
    let source: string
    try {
      canonicalFile = await realpath(candidate)
      if (!isInside(root.directory, canonicalFile)) throw unsafePathError(candidatePath)
      fileDetails = await stat(canonicalFile)
      source = await readFile(canonicalFile, "utf8")
    } catch (error) {
      if (isIndexError(error)) throw error
      throw accessError(candidatePath)
    }
    if (!fileDetails.isFile()) throw accessError(candidatePath)

    const location = locationFor(root, workspace, canonicalFile)
    if (location === undefined) continue
    const identity = `${location.domain}/${location.slug}`
    if (identities.has(identity)) {
      throw appError("NOTE_INDEX_DUPLICATE", "A public and private note share the same identity.", {
        identity,
      })
    }
    identities.add(identity)

    const metadata = metadataFor(location.path, source)
    const updatedAt = fileDetails.mtime.toISOString()
    notes.push({
      ...location,
      ...metadata,
      visibility: root.visibility,
      modifiedAt: updatedAt,
      updatedAt,
    })
  }
}

export async function scanNotes(rootPath: string): Promise<NoteSummary[]> {
  let workspace: string
  try {
    workspace = await realpath(resolve(rootPath))
    if (!(await stat(workspace)).isDirectory()) throw new Error("not a directory")
  } catch {
    throw accessError(".")
  }

  const roots = await Promise.all([
    canonicalScanRoot(workspace, "content", "public"),
    canonicalScanRoot(workspace, "private", "private"),
  ])
  const notes: NoteSummary[] = []
  const identities = new Set<string>()
  for (const root of roots) {
    await scanDirectory(workspace, root, root.directory, notes, identities)
  }
  return notes.sort(compareNotes)
}
