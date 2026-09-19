import { randomUUID, createHash } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename as nodeRename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, posix, relative, resolve } from "node:path"
import { stringify } from "yaml"
import type { AppError, SerializableValue, TrashAdapter, Visibility } from "../../shared/contracts"

const domains = new Set(["technology", "reading", "language", "life"])
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const recoveryIdPattern = /^[a-z0-9-]{16,128}$/i
const recoveryStateDirectory = ".garden-publisher"
const recoveryDirectoryName = "recovery"

export type NoteDomain = "technology" | "reading" | "language" | "life"

export interface NoteRevision {
  readonly mtimeMs: number
  readonly contentHash: string
}

export interface NoteWriteResult extends NoteRevision {
  readonly path: string
  readonly updatedAt: string
}

export interface CreateNoteInput {
  readonly workspace: string
  readonly visibility: Visibility
  readonly domain: NoteDomain
  readonly slug: string
  readonly title: string
  readonly date: string
  readonly description: string
  readonly tags: readonly SerializableValue[]
  readonly body?: string
}

export interface SaveNoteInput {
  readonly workspace: string
  readonly path: string
  readonly markdown: string
  /** Required with expectedContentHash: mtime alone is not a safe revision. */
  readonly expectedMtimeMs: number
  /** Required with expectedMtimeMs: SHA-256 avoids same-mtime overwrite races. */
  readonly expectedContentHash?: string
}

export interface RestoreRecoveryInput {
  readonly workspace: string
  readonly id: string
  /** Acknowledges the exact current target when it differs from the snapshot. */
  readonly expectedCurrentHash?: string
}

export interface DiscardRecoveryInput {
  readonly workspace: string
  readonly id: string
  readonly trash: TrashAdapter
}

export interface RecoverySummary {
  readonly id: string
  readonly originalPath: string
  readonly createdAt: string
  readonly contentHash: string
  readonly revision: NoteRevision
}

/** Deterministic failure seam for atomic-write tests. Production uses node:fs. */
export interface NoteFileAdapter {
  readonly rename?: (from: string, to: string) => Promise<void>
  readonly beforeTempWrite?: (path: string) => Promise<void> | void
  readonly beforeTempSync?: (path: string) => Promise<void> | void
  readonly beforeReplace?: (path: string) => Promise<void> | void
}

interface ManagedRoot {
  readonly workspace: string
  readonly directory: string
  readonly name: "content" | "private"
  readonly visibility: Visibility
}

interface CheckedFile {
  readonly bytes: Buffer
  readonly revision: NoteRevision
  readonly mode: number
}

interface RecoveryManifest {
  readonly version: 1
  readonly id: string
  readonly originalPath: string
  readonly createdAt: string
  readonly contentHash: string
  readonly mtimeMs: number
  readonly sourceFile: "content.md"
}

interface RecoveryEntry {
  readonly directory: string
  readonly manifest: RecoveryManifest
  readonly bytes: Buffer
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

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function forward(path: string): string {
  return path.replaceAll("\\", "/")
}

function isInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate)
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference))
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function safeRelative(workspace: string, candidate: string): string {
  return forward(relative(workspace, candidate)) || "."
}

function invalidPath(path: string): AppError {
  return appError("NOTE_FILE_INVALID", "The note path or metadata is invalid.", { path })
}

function unsafePath(path: string): AppError {
  return appError("NOTE_FILE_UNSAFE_PATH", "Linked paths cannot be modified.", { path })
}

function accessFailure(path: string): AppError {
  return appError("NOTE_FILE_ACCESS_FAILED", "Could not safely access a garden note.", { path })
}

function writeFailure(path: string): AppError {
  return appError("NOTE_FILE_WRITE_FAILED", "Could not atomically save the garden note.", { path })
}

function isNoteError(error: unknown): error is AppError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    ((error as { code: string }).code.startsWith("NOTE_") ||
      (error as { code: string }).code.startsWith("RECOVERY_") ||
      (error as { code: string }).code === "EXTERNAL_EDIT")
  )
}

function assertMetadata(input: CreateNoteInput): void {
  if (!domains.has(input.domain) || input.slug === "index" || !slugPattern.test(input.slug))
    throw invalidPath(".")
  if (
    ![input.title, input.date, input.description].every(
      (value) => typeof value === "string" && value.trim() !== "",
    )
  ) {
    throw invalidPath(".")
  }
  if (
    !Array.isArray(input.tags) ||
    input.tags.length === 0 ||
    (input.body !== undefined && typeof input.body !== "string")
  ) {
    throw invalidPath(".")
  }
}

async function canonicalWorkspace(workspacePath: string): Promise<string> {
  try {
    const workspace = await realpath(resolve(workspacePath))
    if (!(await stat(workspace)).isDirectory()) throw new Error("not a directory")
    return workspace
  } catch {
    throw accessFailure(".")
  }
}

function rootName(visibility: Visibility): "content" | "private" {
  return visibility === "public" ? "content" : "private"
}

async function managedRoot(workspace: string, visibility: Visibility): Promise<ManagedRoot> {
  const name = rootName(visibility)
  const candidate = resolve(workspace, name)
  const path = safeRelative(workspace, candidate)
  try {
    const linked = await lstat(candidate)
    if (linked.isSymbolicLink()) throw unsafePath(path)
    const directory = await realpath(candidate)
    if (!isInside(workspace, directory)) throw unsafePath(path)
    if (!(await stat(directory)).isDirectory()) throw accessFailure(path)
    return { workspace, directory, name, visibility }
  } catch (error) {
    if (isNoteError(error)) throw error
    throw accessFailure(path)
  }
}

async function checkedDomain(
  root: ManagedRoot,
  domain: NoteDomain,
  create: boolean,
): Promise<string> {
  const candidate = resolve(root.directory, domain)
  const displayPath = safeRelative(root.workspace, candidate)
  try {
    const details = await lstat(candidate)
    if (details.isSymbolicLink()) throw unsafePath(displayPath)
    const directory = await realpath(candidate)
    if (!isInside(root.directory, directory) || !(await stat(directory)).isDirectory())
      throw unsafePath(displayPath)
    return directory
  } catch (error) {
    if (isNoteError(error)) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create)
      throw accessFailure(displayPath)
  }
  try {
    await mkdir(candidate, { recursive: false, mode: 0o700 })
    return await checkedDomain(root, domain, false)
  } catch (error) {
    if (isNoteError(error)) throw error
    // A concurrent creator may have made the same domain between lstat and mkdir.
    // Revalidate it rather than treating that expected race as an access failure.
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return checkedDomain(root, domain, false)
    throw accessFailure(displayPath)
  }
}

function parseManagedPath(
  workspace: string,
  path: string,
): { visibility: Visibility; domain: NoteDomain; filename: string; displayPath: string } {
  if (
    !path ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0")
  )
    throw invalidPath(".")
  const parts = path.split("/")
  if (parts.length !== 3 || parts.some((part) => part === "" || part === "." || part === ".."))
    throw invalidPath(path)
  const [rootNameInput, domain, filename] = parts
  const visibility =
    rootNameInput === "content" ? "public" : rootNameInput === "private" ? "private" : undefined
  if (visibility === undefined || !domains.has(domain) || !filename.endsWith(".md"))
    throw invalidPath(path)
  const slug = filename.slice(0, -3)
  if (filename === "index.md" || !slugPattern.test(slug)) throw invalidPath(path)
  const root = rootName(visibility)
  const canonicalDisplayPath = `${root}/${domain}/${filename}`
  if (canonicalDisplayPath !== path || !isInside(workspace, resolve(workspace, path)))
    throw invalidPath(path)
  return { visibility, domain: domain as NoteDomain, filename, displayPath: canonicalDisplayPath }
}

function identity(details: BigIntStats): string {
  return `${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}:${details.ctimeMs}`
}

async function readCheckedFile(
  root: ManagedRoot,
  domain: string,
  filename: string,
): Promise<CheckedFile> {
  const directory = await checkedDomain(root, domain as NoteDomain, false)
  const candidate = resolve(directory, filename)
  const displayPath = safeRelative(root.workspace, candidate)
  let before: BigIntStats
  let canonical: string
  try {
    before = await lstat(candidate, { bigint: true })
    if (before.isSymbolicLink()) throw unsafePath(displayPath)
    if (!before.isFile()) throw accessFailure(displayPath)
    canonical = await realpath(candidate)
    if (!isInside(directory, canonical)) throw unsafePath(displayPath)
  } catch (error) {
    if (isNoteError(error)) throw error
    throw accessFailure(displayPath)
  }
  // POSIX makes the final-component check atomic with O_NOFOLLOW. Windows has
  // no equivalent Node flag; these pre/open/post identity and realpath checks
  // reject observable reparse-point swaps but cannot provide that kernel-level
  // guarantee on Windows.
  const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
  let handle
  try {
    handle = await open(candidate, flags)
  } catch {
    throw accessFailure(displayPath)
  }
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || identity(before) !== identity(opened)) throw accessFailure(displayPath)
    // The public revision token matches Node's conventional stat().mtimeMs
    // precision, while bigint stats above retain exact identity fields.
    const openedTimes = await handle.stat()
    const bytes = await handle.readFile()
    const after = await lstat(candidate, { bigint: true })
    const afterCanonical = await realpath(candidate)
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      !pathsEqual(canonical, afterCanonical) ||
      identity(before) !== identity(after) ||
      identity(opened) !== identity(after)
    ) {
      throw accessFailure(displayPath)
    }
    return {
      bytes,
      revision: { mtimeMs: openedTimes.mtimeMs, contentHash: hash(bytes) },
      mode: Number(opened.mode),
    }
  } catch (error) {
    if (isNoteError(error)) throw error
    throw accessFailure(displayPath)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function markdownFor(input: CreateNoteInput): string {
  const frontmatter = stringify(
    { title: input.title, date: input.date, description: input.description, tags: input.tags },
    { lineWidth: 0 },
  ).trimEnd()
  return `---\n${frontmatter}\n---\n\n${input.body ?? ""}`
}

async function exclusiveWrite(path: string, bytes: Buffer, displayPath: string): Promise<void> {
  let handle
  try {
    const flags =
      process.platform === "win32"
        ? "wx"
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    handle = await open(path, flags, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw appError("NOTE_ALREADY_EXISTS", "A note with that path already exists.", {
        path: displayPath,
      })
    }
    throw writeFailure(displayPath)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function recoveryRoot(workspace: string, create: boolean): Promise<string> {
  const state = resolve(workspace, recoveryStateDirectory)
  const recovery = resolve(state, recoveryDirectoryName)
  const displayPath = `${recoveryStateDirectory}/${recoveryDirectoryName}`
  async function directory(path: string, parent: string): Promise<string> {
    try {
      const details = await lstat(path)
      if (details.isSymbolicLink()) throw unsafePath(displayPath)
      const canonical = await realpath(path)
      if (!isInside(parent, canonical) || !(await stat(canonical)).isDirectory())
        throw unsafePath(displayPath)
      return canonical
    } catch (error) {
      if (isNoteError(error)) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create)
        throw appError("RECOVERY_NOT_FOUND", "Recovery data was not found.")
      await mkdir(path, { mode: 0o700 })
      return directory(path, parent)
    }
  }
  const canonicalState = await directory(state, workspace)
  return directory(recovery, canonicalState)
}

async function createRecovery(
  workspace: string,
  originalPath: string,
  checked: CheckedFile,
): Promise<RecoverySummary> {
  const root = await recoveryRoot(workspace, true)
  const id = `${Date.now()}-${randomUUID()}`
  const directory = resolve(root, id)
  const manifest: RecoveryManifest = {
    version: 1,
    id,
    originalPath,
    createdAt: new Date().toISOString(),
    contentHash: checked.revision.contentHash,
    mtimeMs: checked.revision.mtimeMs,
    sourceFile: "content.md",
  }
  try {
    await mkdir(directory, { mode: 0o700 })
    await writeFile(resolve(directory, manifest.sourceFile), checked.bytes, {
      mode: 0o600,
      flag: "wx",
    })
    await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    })
  } catch {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined)
    throw writeFailure(originalPath)
  }
  return {
    id,
    originalPath,
    createdAt: manifest.createdAt,
    contentHash: manifest.contentHash,
    revision: { mtimeMs: manifest.mtimeMs, contentHash: manifest.contentHash },
  }
}

async function syncContainingDirectory(target: string): Promise<void> {
  let handle
  try {
    handle = await open(dirname(target), "r")
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Windows does not consistently allow a directory FileHandle to be synced.
    // Do not hide any other platform's persistence failure.
    if (
      process.platform === "win32" &&
      ["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes(code ?? "")
    )
      return
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeTempAndReplace(
  target: string,
  displayPath: string,
  bytes: Buffer,
  mode: number | undefined,
  adapter: NoteFileAdapter,
): Promise<void> {
  const temp = `${target}.garden-publisher-tmp-${randomUUID()}`
  let handle
  try {
    handle = await open(temp, "wx", 0o600)
    if (mode !== undefined) await chmod(temp, mode & 0o777)
    await adapter.beforeTempWrite?.(temp)
    await handle.writeFile(bytes)
    await adapter.beforeTempSync?.(temp)
    await handle.sync()
    await handle.close()
    handle = undefined
    await adapter.beforeReplace?.(displayPath)
    await (adapter.rename ?? nodeRename)(temp, target)
    await syncContainingDirectory(target)
  } catch (error) {
    if (isNoteError(error)) throw error
    throw writeFailure(displayPath)
  } finally {
    await handle?.close().catch(() => undefined)
    // A failed rename leaves the original target intact. The temporary is disposable;
    // the preceding recovery snapshot remains available once replacement was attempted.
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

function result(path: string, bytes: Buffer, mtimeMs: number): NoteWriteResult {
  return { path, updatedAt: new Date(mtimeMs).toISOString(), mtimeMs, contentHash: hash(bytes) }
}

export async function createNote(input: CreateNoteInput): Promise<NoteWriteResult> {
  assertMetadata(input)
  const workspace = await canonicalWorkspace(input.workspace)
  const root = await managedRoot(workspace, input.visibility)
  const directory = await checkedDomain(root, input.domain, true)
  const path = `${root.name}/${input.domain}/${input.slug}.md`
  const target = resolve(directory, `${input.slug}.md`)
  const bytes = Buffer.from(markdownFor(input), "utf8")
  await exclusiveWrite(target, bytes, path)
  const details = await stat(target)
  return result(path, bytes, details.mtimeMs)
}

export async function saveNote(
  input: SaveNoteInput,
  adapter: NoteFileAdapter = {},
): Promise<NoteWriteResult> {
  if (typeof input.markdown !== "string" || !Number.isFinite(input.expectedMtimeMs))
    throw invalidPath(input.path || ".")
  const workspace = await canonicalWorkspace(input.workspace)
  const parsed = parseManagedPath(workspace, input.path)
  const root = await managedRoot(workspace, parsed.visibility)
  const current = await readCheckedFile(root, parsed.domain, parsed.filename)
  if (
    current.revision.mtimeMs !== input.expectedMtimeMs ||
    current.revision.contentHash !== input.expectedContentHash
  ) {
    throw appError("EXTERNAL_EDIT", "The note changed outside the editor.", {
      path: parsed.displayPath,
      revision: current.revision.contentHash,
    })
  }
  if (!input.expectedContentHash || !/^[a-f0-9]{64}$/i.test(input.expectedContentHash))
    throw invalidPath(parsed.displayPath)
  await createRecovery(workspace, parsed.displayPath, current)
  const directory = await checkedDomain(root, parsed.domain, false)
  const target = resolve(directory, parsed.filename)
  const bytes = Buffer.from(input.markdown, "utf8")
  await writeTempAndReplace(target, parsed.displayPath, bytes, current.mode, adapter)
  const details = await stat(target)
  return result(parsed.displayPath, bytes, details.mtimeMs)
}

function isManifest(value: unknown): value is RecoveryManifest {
  if (typeof value !== "object" || value === null) return false
  const manifest = value as Partial<RecoveryManifest>
  return (
    manifest.version === 1 &&
    typeof manifest.id === "string" &&
    recoveryIdPattern.test(manifest.id) &&
    typeof manifest.originalPath === "string" &&
    typeof manifest.createdAt === "string" &&
    !Number.isNaN(Date.parse(manifest.createdAt)) &&
    typeof manifest.contentHash === "string" &&
    /^[a-f0-9]{64}$/i.test(manifest.contentHash) &&
    typeof manifest.mtimeMs === "number" &&
    manifest.sourceFile === "content.md"
  )
}

async function readRecovery(workspace: string, id: string): Promise<RecoveryEntry> {
  if (!recoveryIdPattern.test(id))
    throw appError("RECOVERY_INVALID", "The recovery identifier is invalid.")
  const root = await recoveryRoot(workspace, false)
  const directory = resolve(root, id)
  if (!isInside(root, directory) || safeRelative(root, directory) !== id)
    throw appError("RECOVERY_INVALID", "The recovery identifier is invalid.")
  let manifestBytes: Buffer
  let bytes: Buffer
  async function readRecoveryFile(path: string): Promise<Buffer> {
    const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
    const handle = await open(path, flags)
    try {
      return await handle.readFile()
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
  try {
    const directoryDetails = await lstat(directory)
    if (
      directoryDetails.isSymbolicLink() ||
      !directoryDetails.isDirectory() ||
      !isInside(root, await realpath(directory))
    )
      throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  } catch (error) {
    if (isNoteError(error)) throw error
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw appError("RECOVERY_NOT_FOUND", "Recovery data was not found.")
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  try {
    for (const name of ["manifest.json", "content.md"]) {
      const file = resolve(directory, name)
      const details = await lstat(file)
      if (
        details.isSymbolicLink() ||
        !details.isFile() ||
        !isInside(directory, await realpath(file))
      )
        throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
    }
    manifestBytes = await readRecoveryFile(resolve(directory, "manifest.json"))
    bytes = await readRecoveryFile(resolve(directory, "content.md"))
  } catch (error) {
    if (isNoteError(error)) throw error
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"))
  } catch {
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  if (!isManifest(manifest) || manifest.id !== id || hash(bytes) !== manifest.contentHash)
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  try {
    parseManagedPath(workspace, manifest.originalPath)
  } catch {
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  return { directory, manifest, bytes }
}

export async function listRecoveries(workspacePath: string): Promise<RecoverySummary[]> {
  const workspace = await canonicalWorkspace(workspacePath)
  let root: string
  try {
    root = await recoveryRoot(workspace, false)
  } catch (error) {
    if ((error as { code?: string }).code === "RECOVERY_NOT_FOUND") return []
    throw error
  }
  let ids: string[]
  try {
    ids = await readdir(root)
  } catch {
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  const entries = await Promise.all(ids.sort().map((id) => readRecovery(workspace, id)))
  return entries
    .map(({ manifest }) => ({
      id: manifest.id,
      originalPath: manifest.originalPath,
      createdAt: manifest.createdAt,
      contentHash: manifest.contentHash,
      revision: { mtimeMs: manifest.mtimeMs, contentHash: manifest.contentHash },
    }))
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    )
}

export async function restoreRecovery(
  input: RestoreRecoveryInput,
  adapter: NoteFileAdapter = {},
): Promise<NoteWriteResult> {
  const workspace = await canonicalWorkspace(input.workspace)
  const entry = await readRecovery(workspace, input.id)
  const parsed = parseManagedPath(workspace, entry.manifest.originalPath)
  const root = await managedRoot(workspace, parsed.visibility)
  const target = resolve(await checkedDomain(root, parsed.domain, false), parsed.filename)
  let current: CheckedFile | undefined
  try {
    current = await readCheckedFile(root, parsed.domain, parsed.filename)
  } catch (error) {
    if ((error as { code?: string }).code !== "NOTE_FILE_ACCESS_FAILED") throw error
  }
  if (current !== undefined) {
    if (
      current.revision.contentHash !== entry.manifest.contentHash &&
      current.revision.contentHash !== input.expectedCurrentHash
    ) {
      throw appError("RECOVERY_CONFLICT", "The note changed since this recovery was created.", {
        path: parsed.displayPath,
      })
    }
    await createRecovery(workspace, parsed.displayPath, current)
  }
  await writeTempAndReplace(target, parsed.displayPath, entry.bytes, current?.mode, adapter)
  const details = await stat(target)
  return result(parsed.displayPath, entry.bytes, details.mtimeMs)
}

export async function discardRecovery(input: DiscardRecoveryInput): Promise<void> {
  const workspace = await canonicalWorkspace(input.workspace)
  const entry = await readRecovery(workspace, input.id)
  try {
    await input.trash.trashItem(entry.directory)
  } catch {
    throw appError("RECOVERY_DISCARD_FAILED", "Could not move recovery data to Trash.", {
      id: input.id,
    })
  }
}
