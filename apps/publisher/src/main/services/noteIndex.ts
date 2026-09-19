import { constants, type BigIntStats } from "node:fs"
import { lstat, open, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { parse } from "yaml"
import type { AppError, NoteSummary, SerializableValue, Visibility } from "../../shared/contracts"

type NoteDomain = NoteSummary["domain"]

const noteDomains = new Set<NoteDomain>(["technology", "reading", "language", "life"])
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface ScanRoot {
  readonly directory: string
  readonly name: "content" | "private"
  readonly visibility: Visibility
}

export interface ScanNotesOptions {
  /** Test hook invoked after a candidate is validated and before it is opened. */
  readonly beforeOpen?: (path: string) => Promise<void> | void
  /** Test hook invoked after a handle read and before final identity validation. */
  readonly afterRead?: (path: string) => Promise<void> | void
}

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
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

function changedPathError(path: string): AppError {
  return appError("NOTE_INDEX_CHANGED", "A garden file changed while it was being indexed.", {
    path,
  })
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

function getFrontmatter(source: string): string | undefined {
  const match = source.match(/^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/)
  return match ? (match[1] ?? "") : undefined
}

function normalizeSerializable(
  value: unknown,
  ancestors = new WeakSet<object>(),
): SerializableValue {
  // The publication validator accepts any YAML array values. Preserve ordinary
  // YAML scalars and collections in a structured-clone-safe summary shape.
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return "[circular YAML value]"
    ancestors.add(value)
    const normalized = value.map((entry) => normalizeSerializable(entry, ancestors))
    ancestors.delete(value)
    return normalized
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) return "[circular YAML value]"
    ancestors.add(value)
    const normalized: Record<string, SerializableValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizeSerializable(entry, ancestors)
    }
    ancestors.delete(value)
    return normalized
  }
  return String(value)
}

function normalizeTag(value: unknown): string {
  const normalized = normalizeSerializable(value)
  if (normalized === null || typeof normalized !== "object") return String(normalized)
  return JSON.stringify(normalized)
}

function metadataFor(
  path: string,
  source: string,
): Pick<NoteSummary, "title" | "date" | "description" | "tags"> {
  const frontmatter = getFrontmatter(source.startsWith("\uFEFF") ? source.slice(1) : source)
  if (frontmatter === undefined) {
    throw invalidNoteError(path, "missing frontmatter")
  }
  let data: Record<string, unknown>
  try {
    const parsed = parse(frontmatter)
    data =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
  } catch {
    throw invalidNoteError(path, "invalid frontmatter")
  }

  if (!hasText(data.title)) throw invalidNoteError(path, "title must be non-empty")
  if (!hasText(data.date)) throw invalidNoteError(path, "date must be non-empty")
  if (!hasText(data.description)) throw invalidNoteError(path, "description must be non-empty")
  if (!Array.isArray(data.tags) || data.tags.length === 0) {
    throw invalidNoteError(path, "tags must be a non-empty array")
  }

  return {
    title: data.title,
    date: data.date,
    description: data.description,
    tags: data.tags.map(normalizeTag),
  }
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

function identityOf(details: BigIntStats): FileIdentity {
  // Windows file IDs exceed Number.MAX_SAFE_INTEGER; bigint stats also retain
  // nanosecond timestamps needed to detect same-size, mtime-restored rewrites.
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  }
}

function hasSameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function verifyCandidatePath(
  candidate: string,
  candidatePath: string,
  root: ScanRoot,
  canonicalFile: string,
  expectedIdentity: FileIdentity,
  openedIdentity: FileIdentity,
): Promise<void> {
  let details
  let canonical
  try {
    details = await lstat(candidate, { bigint: true })
    if (details.isSymbolicLink()) throw unsafePathError(candidatePath)
    canonical = await realpath(candidate)
  } catch (error) {
    if (isIndexError(error)) throw error
    throw accessError(candidatePath)
  }
  if (!details.isFile()) throw changedPathError(candidatePath)
  if (!isInside(root.directory, canonical)) throw unsafePathError(candidatePath)
  if (!pathsEqual(canonical, canonicalFile)) throw changedPathError(candidatePath)
  const currentIdentity = identityOf(details)
  if (
    !hasSameIdentity(currentIdentity, expectedIdentity) ||
    !hasSameIdentity(currentIdentity, openedIdentity)
  ) {
    throw changedPathError(candidatePath)
  }
}

async function readCandidateFile(
  candidate: string,
  candidatePath: string,
  root: ScanRoot,
  preOpenDetails: BigIntStats,
  options: ScanNotesOptions,
): Promise<{ canonicalFile: string; fileDetails: { mtime: Date }; source: string }> {
  let canonicalFile: string
  try {
    canonicalFile = await realpath(candidate)
  } catch {
    throw accessError(candidatePath)
  }
  if (!isInside(root.directory, canonicalFile)) throw unsafePathError(candidatePath)

  await options.beforeOpen?.(candidatePath)

  // POSIX O_NOFOLLOW makes the final-component symlink check atomic with open.
  // Node exposes no Windows equivalent, so Windows path APIs retain an
  // irreducible open/check race. The pre/open/post identity and canonical-path
  // checks below reject observable reparse-point swaps before using the bytes,
  // but cannot claim kernel-level no-follow guarantees on Windows.
  const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
  let handle
  try {
    handle = await open(candidate, flags)
  } catch {
    try {
      if ((await lstat(candidate)).isSymbolicLink()) throw unsafePathError(candidatePath)
    } catch (error) {
      if (isIndexError(error)) throw error
    }
    throw accessError(candidatePath)
  }
  try {
    const openedDetails = await handle.stat({ bigint: true })
    if (!openedDetails.isFile()) throw changedPathError(candidatePath)
    const expectedIdentity = identityOf(preOpenDetails)
    const openedIdentity = identityOf(openedDetails)
    await verifyCandidatePath(
      candidate,
      candidatePath,
      root,
      canonicalFile,
      expectedIdentity,
      openedIdentity,
    )

    const source = await handle.readFile({ encoding: "utf8" })
    await options.afterRead?.(candidatePath)
    const afterReadDetails = await handle.stat({ bigint: true })
    if (!hasSameIdentity(openedIdentity, identityOf(afterReadDetails))) {
      throw changedPathError(candidatePath)
    }
    await verifyCandidatePath(
      candidate,
      candidatePath,
      root,
      canonicalFile,
      expectedIdentity,
      openedIdentity,
    )
    return { canonicalFile, fileDetails: openedDetails, source }
  } catch (error) {
    if (isIndexError(error)) throw error
    throw accessError(candidatePath)
  } finally {
    await handle.close().catch(() => undefined)
  }
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
  options: ScanNotesOptions,
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
      linked = await lstat(candidate, { bigint: true })
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
      await scanDirectory(workspace, root, canonicalDirectory, notes, identities, options)
      continue
    }
    if (!linked.isFile() || !entry.name.endsWith(".md")) continue

    const { canonicalFile, fileDetails, source } = await readCandidateFile(
      candidate,
      candidatePath,
      root,
      linked,
      options,
    )

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
      updatedAt,
    })
  }
}

export async function scanNotes(
  rootPath: string,
  options: ScanNotesOptions = {},
): Promise<NoteSummary[]> {
  let workspace: string
  try {
    workspace = await realpath(resolve(rootPath))
    if (!(await stat(workspace)).isDirectory()) throw new Error("not a directory")
  } catch {
    throw accessError(".")
  }

  const roots = [
    await canonicalScanRoot(workspace, "content", "public"),
    await canonicalScanRoot(workspace, "private", "private"),
  ]
  const notes: NoteSummary[] = []
  const identities = new Set<string>()
  for (const root of roots) {
    await scanDirectory(workspace, root, root.directory, notes, identities, options)
  }
  return notes.sort(compareNotes)
}
