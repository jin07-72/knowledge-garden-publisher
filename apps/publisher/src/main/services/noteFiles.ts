import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename as nodeRename,
  rm,
  stat,
} from "node:fs/promises"
import { dirname, isAbsolute, posix, relative, resolve } from "node:path"
import { stringify } from "yaml"
import type {
  AppError,
  NoteDocument,
  NoteTrashReceipt,
  SerializableValue,
  TrashAdapter,
  Visibility,
} from "../../shared/contracts"

// Transactions are kept in a focused internal module because this service also
// owns the lower-level 2,500-line atomic save/recovery implementation.
export {
  DEFAULT_TRANSACTION_GLOBAL_RETENTION,
  DEFAULT_TRANSACTION_PER_NOTE_RETENTION,
  executeRename,
  executeVisibilityChange,
  inspectPendingTransactions,
  MAX_TRANSACTION_RETENTION_SCAN,
  MAX_TRANSACTION_RETENTION_TRASH_CALLS,
  MAX_TRANSACTION_MANIFEST_BYTES,
  planRename,
  planVisibilityChange,
  type NoteTransactionAdapter,
  type NoteTransactionPlan,
  type PendingTransaction,
  type RenameInput,
  type RenamePlan,
  type TransactionContext,
  type TransactionMove,
  type TransactionResult,
  type VisibilityChangeInput,
  type VisibilityChangePlan,
  type WikiLinkEdit,
} from "./noteTransactions"

const domains = new Set(["technology", "reading", "language", "life"])
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const recoveryIdPattern = /^[a-z0-9-]{16,128}$/i
const recoveryStateDirectory = ".garden-publisher"
const recoveryDirectoryName = "recovery"
const recoveryKeyDirectory = "keys"
const recoveryKeyName = "recovery-hmac.key"
const recoveryStagingPattern = /^\.staging-([a-z0-9-]{16,128})-([a-f0-9-]{36})$/i
const recoveryQuarantinePattern = /^\.quarantine-[a-f0-9-]{36}$/i
const recoveryRetentionQuarantinePattern = /^\.retention-([a-z0-9-]{16,128})-([a-f0-9-]{36})$/i
const abandonedRecoveryStagingAgeMs = 24 * 60 * 60 * 1_000
export const DEFAULT_RECOVERY_PER_NOTE_LIMIT = 20
export const DEFAULT_RECOVERY_GLOBAL_LIMIT = 500
export const DEFAULT_RECOVERY_LIST_LIMIT = 100
export const MAX_RECOVERY_PER_NOTE_LIMIT = 100
export const MAX_RECOVERY_GLOBAL_LIMIT = 2_000
export const RECOVERY_RETENTION_MAX_DIRECTORY_ENTRIES = 16
export const RECOVERY_RETENTION_MAX_AUTH_ATTEMPTS = 16
export const RECOVERY_RETENTION_MAX_TRASH_CALLS = 4
export const RECOVERY_RETENTION_MAX_BACKLOG = 4
export const RECOVERY_RETENTION_MAX_WARNINGS = 1
export const RECOVERY_RETENTION_MAX_SNAPSHOT_READS = 0
const maximumRecoveryListLimit = 500
const recoveryRetentionStateName = "recovery-retention-state.json"
const maximumRecoveryRetentionStateBytes = 256 * 1_024
const maximumRecoveryManifestBytes = 64 * 1_024
const maximumRecoveryIntegrityBytes = 128

export type NoteDomain = "technology" | "reading" | "language" | "life"

export interface NoteRevision {
  readonly mtimeMs: number
  readonly contentHash: string
}

export interface NoteWriteResult extends NoteRevision {
  readonly path: string
  readonly updatedAt: string
  readonly warnings?: readonly NoteOperationWarning[]
}

export interface NoteOperationWarning {
  readonly code: "RECOVERY_RETENTION_FAILED" | "LOCK_RELEASE_FAILED"
  readonly message: string
  readonly details: Readonly<Record<string, SerializableValue>>
}

export interface RecoveryRetentionPolicy {
  readonly perNoteLimit: number
  readonly globalLimit: number
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
  readonly expectedContentHash: string
  readonly recoveryTrash: TrashAdapter
  readonly recoveryPolicy?: RecoveryRetentionPolicy
}

export interface RestoreRecoveryInput {
  readonly workspace: string
  readonly id: string
  /** Acknowledges the exact current target when it differs from the snapshot. */
  readonly expectedCurrentHash?: string
  readonly recoveryTrash: TrashAdapter
  readonly recoveryPolicy?: RecoveryRetentionPolicy
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

export interface RecoveryIssue {
  readonly id: string
  readonly code: "RECOVERY_INVALID"
  readonly message: "Recovery data is invalid."
}

export type RecoveryListItem = RecoverySummary | RecoveryIssue

export interface RecoveryListOptions {
  readonly limit?: number
  /** Continue strictly after this recovery ID in newest-ID-first order. */
  readonly cursor?: string
}

function recoveryIssue(id: string): RecoveryIssue {
  return { id, code: "RECOVERY_INVALID", message: "Recovery data is invalid." }
}

/** Deterministic failure seam for atomic-write tests. Production uses node:fs. */
export interface NoteFileAdapter {
  readonly rename?: (from: string, to: string) => Promise<void>
  readonly syncDirectory?: (path: string) => Promise<void>
  readonly beforeTempWrite?: (path: string) => Promise<void> | void
  readonly beforeTempSync?: (path: string) => Promise<void> | void
  readonly beforeCommit?: (temporaryPath: string) => Promise<void> | void
  readonly beforeReplace?: (path: string) => Promise<void> | void
  readonly afterReplace?: (path: string) => Promise<void> | void
  readonly beforeKeyPublish?: () => Promise<void> | void
  readonly afterKeyPublish?: () => Promise<void> | void
  readonly beforeLockMetadataPublish?: (lockDirectory: string) => Promise<void> | void
  readonly afterLockMetadataPublish?: (lockDirectory: string) => Promise<void> | void
  readonly afterLockHeartbeat?: (lockDirectory: string) => Promise<void> | void
  readonly beforeHeartbeatPublish?: (lockDirectory: string, attempt: number) => Promise<void> | void
  readonly beforeLockRelease?: (lockDirectory: string) => Promise<void> | void
  readonly startHeartbeat?: (
    lockDirectory: string,
    heartbeat: () => Promise<void>,
    intervalMs: number,
  ) => () => void
  readonly now?: () => number
  readonly delay?: (milliseconds: number) => Promise<void>
  readonly isProcessAlive?: (pid: number) => boolean | undefined
  readonly lockLeaseMs?: number
  readonly lockWaitMs?: number
  readonly lockGraceMs?: number
  readonly heartbeatRetryLimit?: number
  readonly heartbeatRetryDelayMs?: number
}

export interface NoteReadAdapter {
  readonly beforeOpen?: (path: string) => Promise<void> | void
  readonly afterRead?: (path: string) => Promise<void> | void
}

export interface ReadNoteInput {
  readonly workspace: string
  readonly path: string
}

export interface TrashNoteInput extends ReadNoteInput {
  readonly trash: TrashAdapter
  readonly isTracked: (workspace: string, path: string) => Promise<boolean>
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
  readonly identity: string
}

interface RecoveryManifest {
  readonly version: 1
  readonly id: string
  readonly originalPath: string
  readonly createdAt: string
  readonly contentHash: string
  readonly mtimeMs: number
  readonly sourceFile: "content.md"
  readonly integrityFile: "integrity.sha256"
  readonly integrity: string
}

interface RecoveryEntry {
  readonly directory: string
  readonly manifest: RecoveryManifest
  readonly bytes: Buffer
}

interface RecoveryMetadata {
  readonly directory: string
  readonly directoryName: string
  readonly directoryIdentity: DirectoryIdentity
  readonly manifest: RecoveryManifest
}

interface LeaseLock {
  assertOwned(): Promise<void>
  release(): Promise<void>
}

interface TargetLock extends LeaseLock {
  readonly lockId: string
}

interface LeaseOwner {
  readonly version: 1
  readonly token: string
  readonly pid: number
  readonly createdAt: number
}

interface LeaseHeartbeat {
  readonly version: 1
  readonly token: string
  readonly heartbeatAt: number
  readonly leaseExpiresAt: number
}

interface DirectoryIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly birthtimeNs: bigint
  readonly ctimeNs: bigint
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

function invalidInput(path: string): AppError {
  return appError("INVALID_INPUT", "The request is invalid.", { path })
}

function isValidRecoveryPolicy(policy: unknown): policy is RecoveryRetentionPolicy | undefined {
  if (policy === undefined) return true
  if (typeof policy !== "object" || policy === null) return false
  const candidate = policy as Partial<RecoveryRetentionPolicy>
  const { perNoteLimit, globalLimit } = candidate
  return (
    typeof perNoteLimit === "number" &&
    Number.isInteger(perNoteLimit) &&
    perNoteLimit >= 1 &&
    perNoteLimit <= MAX_RECOVERY_PER_NOTE_LIMIT &&
    typeof globalLimit === "number" &&
    Number.isInteger(globalLimit) &&
    globalLimit >= 1 &&
    globalLimit <= MAX_RECOVERY_GLOBAL_LIMIT
  )
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

function uncertainCommit(): AppError {
  return appError(
    "NOTE_FILE_COMMIT_UNCERTAIN",
    "The note commit could not be safely confirmed or rolled back.",
  )
}

function isNoteError(error: unknown): error is AppError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    ((error as { code: string }).code.startsWith("NOTE_") ||
      (error as { code: string }).code.startsWith("RECOVERY_") ||
      (error as { code: string }).code === "EXTERNAL_EDIT" ||
      (error as { code: string }).code === "INVALID_INPUT")
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
  if (visibility !== "public" && visibility !== "private") throw invalidPath(".")
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
  return `${details.dev}:${details.ino}:${details.size}:${details.mtimeNs}:${details.ctimeNs}`
}

type CheckedFileState =
  { readonly kind: "present"; readonly file: CheckedFile } | { readonly kind: "absent" }

async function readCheckedFileState(
  root: ManagedRoot,
  domain: string,
  filename: string,
  options: NoteReadAdapter & { readonly maximumBytes?: number } = {},
): Promise<CheckedFileState> {
  const directory = await checkedDomain(root, domain as NoteDomain, false)
  const candidate = resolve(directory, filename)
  const displayPath = safeRelative(root.workspace, candidate)
  let before: BigIntStats
  let canonical: string
  try {
    before = await lstat(candidate, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }
    throw accessFailure(displayPath)
  }
  if (before.isSymbolicLink()) throw unsafePath(displayPath)
  if (
    !before.isFile() ||
    (options.maximumBytes !== undefined && before.size > BigInt(options.maximumBytes))
  )
    throw accessFailure(displayPath)
  try {
    canonical = await realpath(candidate)
  } catch {
    throw accessFailure(displayPath)
  }
  if (!isInside(directory, canonical)) throw unsafePath(displayPath)
  await options.beforeOpen?.(displayPath)
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
    if (
      !opened.isFile() ||
      identity(before) !== identity(opened) ||
      (options.maximumBytes !== undefined && opened.size > BigInt(options.maximumBytes))
    )
      throw accessFailure(displayPath)
    // The public revision token matches Node's conventional stat().mtimeMs
    // precision, while bigint stats above retain exact identity fields.
    const openedTimes = await handle.stat()
    const bytes =
      options.maximumBytes === undefined
        ? await handle.readFile()
        : await readBoundedHandle(handle, options.maximumBytes)
    if (bytes === undefined) throw accessFailure(displayPath)
    await options.afterRead?.(displayPath)
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
      kind: "present",
      file: {
        bytes,
        revision: { mtimeMs: openedTimes.mtimeMs, contentHash: hash(bytes) },
        mode: Number(opened.mode),
        identity: identity(opened),
      },
    }
  } catch (error) {
    if (isNoteError(error)) throw error
    throw accessFailure(displayPath)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readCheckedFile(
  root: ManagedRoot,
  domain: string,
  filename: string,
  options: NoteReadAdapter & { readonly maximumBytes?: number } = {},
): Promise<CheckedFile> {
  const state = await readCheckedFileState(root, domain, filename, options)
  if (state.kind === "absent") {
    throw accessFailure(safeRelative(root.workspace, resolve(root.directory, domain, filename)))
  }
  return state.file
}

export async function readNote(
  input: ReadNoteInput,
  adapter: NoteReadAdapter = {},
): Promise<NoteDocument> {
  const workspace = await canonicalWorkspace(input.workspace)
  const parsed = parseManagedPath(workspace, input.path)
  const root = await managedRoot(workspace, parsed.visibility)
  const file = await readCheckedFile(root, parsed.domain, parsed.filename, {
    ...adapter,
    maximumBytes: 16 * 1024 * 1024,
  })
  let markdown: string
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
  } catch {
    throw accessFailure(parsed.displayPath)
  }
  return { path: parsed.displayPath, markdown, ...file.revision }
}

export async function trashNote(
  input: TrashNoteInput,
  adapter: NoteReadAdapter = {},
): Promise<NoteTrashReceipt> {
  if (typeof input.trash?.trashItem !== "function" || typeof input.isTracked !== "function")
    throw invalidInput(input.path || ".")
  const workspace = await canonicalWorkspace(input.workspace)
  const parsed = parseManagedPath(workspace, input.path)
  const root = await managedRoot(workspace, parsed.visibility)
  const lock = await acquireTargetLock(workspace, parsed.displayPath, {})
  let primaryError: unknown
  let result: NoteTrashReceipt | undefined
  try {
    await lock.assertOwned()
    const current = await readCheckedFile(root, parsed.domain, parsed.filename, {
      ...adapter,
      maximumBytes: 16 * 1024 * 1024,
    })
    let tracked: boolean
    try {
      tracked =
        parsed.visibility === "public" && (await input.isTracked(workspace, parsed.displayPath))
    } catch {
      throw accessFailure(parsed.displayPath)
    }
    if (!(await verifyUnchanged(root, parsed.domain, parsed.filename, current)))
      throw accessFailure(parsed.displayPath)
    await lock.assertOwned()
    const directory = await checkedDomain(root, parsed.domain, false)
    const target = resolve(directory, parsed.filename)
    try {
      await input.trash.trashItem(target)
      await lstat(target)
      throw new Error("trash target still exists")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (isNoteError(error)) throw error
        throw writeFailure(parsed.displayPath)
      }
    }
    result = {
      path: parsed.displayPath,
      ...(tracked ? { pendingPublicDeletion: parsed.displayPath } : {}),
      historyWarning: tracked,
    }
  } catch (error) {
    primaryError = error
  }
  try {
    await lock.release()
  } catch {
    if (primaryError === undefined) primaryError = uncertainCommit()
  }
  if (primaryError !== undefined) throw primaryError
  return result as NoteTrashReceipt
}

function markdownFor(input: CreateNoteInput): string {
  const frontmatter = stringify(
    { title: input.title, date: input.date, description: input.description, tags: input.tags },
    { lineWidth: 0 },
  ).trimEnd()
  return `---\n${frontmatter}\n---\n\n${input.body ?? ""}`
}

function stableFileIdentity(details: BigIntStats): string {
  return `${details.dev}:${details.ino}:${details.birthtimeNs}`
}

async function readBoundedHandle(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Buffer | undefined> {
  const bounded = Buffer.alloc(maximumBytes + 1)
  let offset = 0
  while (offset < bounded.length) {
    const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset > maximumBytes ? undefined : bounded.subarray(0, offset)
}

async function removeFailedExclusiveFile(path: string, createdIdentity: string): Promise<void> {
  let before: BigIntStats
  try {
    before = await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    stableFileIdentity(before) !== createdIdentity
  ) {
    throw new Error("exclusive destination identity changed")
  }

  const quarantine = `${path}.garden-publisher-failed-${randomUUID()}`
  await nodeRename(path, quarantine)
  const moved = await lstat(quarantine, { bigint: true })
  if (!moved.isFile() || stableFileIdentity(moved) !== createdIdentity) {
    try {
      await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await nodeRename(quarantine, path).catch(() => undefined)
      }
    }
    throw new Error("exclusive cleanup identity changed")
  }
  await rm(quarantine, { force: true })
  await syncContainingDirectory(path)
}

async function exclusiveWrite(
  path: string,
  bytes: Buffer,
  displayPath: string,
  adapter: NoteFileAdapter,
  assertLockOwned: () => Promise<void>,
): Promise<void> {
  const temporary = `${path}.garden-publisher-create-${randomUUID()}`
  let handle
  let temporaryIdentity: string | undefined
  let publishedIdentity: string | undefined
  try {
    const flags =
      process.platform === "win32"
        ? "wx"
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    handle = await open(temporary, flags, 0o600)
    const created = await lstat(temporary, { bigint: true })
    if (created.isSymbolicLink() || !created.isFile()) throw new Error("invalid create staging")
    temporaryIdentity = stableFileIdentity(created)
    await adapter.beforeTempWrite?.(temporary)
    await handle.writeFile(bytes)
    await adapter.beforeTempSync?.(temporary)
    await handle.sync()
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || stableFileIdentity(opened) !== temporaryIdentity) {
      throw new Error("create staging identity changed")
    }
    await adapter.beforeCommit?.(temporary)
    await handle.close()
    handle = undefined
    const parent = dirname(path)
    const parentDetails = await lstat(parent)
    if (
      parentDetails.isSymbolicLink() ||
      !parentDetails.isDirectory() ||
      !pathsEqual(await realpath(parent), parent)
    ) {
      throw unsafePath(displayPath)
    }
    await assertLockOwned()
    await link(temporary, path)
    publishedIdentity = temporaryIdentity
    const installed = await lstat(path, { bigint: true })
    if (
      installed.isSymbolicLink() ||
      !installed.isFile() ||
      stableFileIdentity(installed) !== temporaryIdentity
    ) {
      throw new Error("created destination identity changed")
    }
    await removeFailedExclusiveFile(temporary, temporaryIdentity)
    temporaryIdentity = undefined
    await (adapter.syncDirectory ?? syncContainingDirectory)(path)
    await assertLockOwned()
  } catch (error) {
    await handle?.close().catch(() => undefined)
    handle = undefined
    if (publishedIdentity !== undefined) {
      try {
        await removeFailedExclusiveFile(path, publishedIdentity)
        publishedIdentity = undefined
      } catch {
        throw uncertainCommit()
      }
    }
    if (temporaryIdentity !== undefined) {
      await removeFailedExclusiveFile(temporary, temporaryIdentity).catch(() => undefined)
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw appError("NOTE_ALREADY_EXISTS", "A note with that path already exists.", {
        path: displayPath,
      })
    }
    if (isNoteError(error)) throw error
    throw writeFailure(displayPath)
  } finally {
    await handle?.close().catch(() => undefined)
    if (temporaryIdentity !== undefined) {
      await removeFailedExclusiveFile(temporary, temporaryIdentity).catch(() => undefined)
    }
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
      try {
        await mkdir(path, { mode: 0o700 })
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw appError("RECOVERY_INVALID", "Recovery storage could not be initialized.")
        }
      }
      return directory(path, parent)
    }
  }
  const canonicalState = await directory(state, workspace)
  return directory(recovery, canonicalState)
}

async function stateChild(state: string, name: string, create: boolean): Promise<string> {
  const candidate = resolve(state, name)
  try {
    const details = await lstat(candidate)
    if (details.isSymbolicLink()) throw appError("RECOVERY_INVALID", "Recovery storage is invalid.")
    const canonical = await realpath(candidate)
    if (!isInside(state, canonical) || !(await stat(canonical)).isDirectory()) {
      throw appError("RECOVERY_INVALID", "Recovery storage is invalid.")
    }
    return canonical
  } catch (error) {
    if (isNoteError(error)) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      throw appError("RECOVERY_INVALID", "Recovery storage is invalid.")
    }
    try {
      await mkdir(candidate, { mode: 0o700 })
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw appError("RECOVERY_INVALID", "Recovery storage could not be initialized.")
      }
    }
    return stateChild(state, name, false)
  }
}

async function readProtectedKey(path: string, keysDirectory: string): Promise<Buffer> {
  const before = await lstat(path, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile() || before.size !== 32n)
    throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
  const canonical = await realpath(path)
  if (!isInside(keysDirectory, canonical))
    throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
  const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
  const handle = await open(path, flags)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.size !== 32n || identity(before) !== identity(opened))
      throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
    if (process.platform !== "win32" && (Number(opened.mode) & 0o777) !== 0o600) {
      throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
    }
    const key = await readBoundedHandle(handle, 32)
    const after = await lstat(path, { bigint: true })
    if (
      after.isSymbolicLink() ||
      identity(before) !== identity(after) ||
      !pathsEqual(canonical, await realpath(path))
    ) {
      throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
    }
    if (key === undefined || key.length !== 32)
      throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
    return key
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const defaultLockLeaseMs = 60_000
const defaultLockWaitMs = 2_000
const defaultLockGraceMs = 250
const leaseOwnerName = "owner.json"
const leaseHeartbeatName = "heartbeat.json"

function leaseNow(adapter: NoteFileAdapter): number {
  return (adapter.now ?? Date.now)()
}

function leaseDelay(adapter: NoteFileAdapter, milliseconds: number): Promise<void> {
  return (
    adapter.delay?.(milliseconds) ??
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  )
}

function processLiveness(adapter: NoteFileAdapter, pid: number): boolean | undefined {
  if (adapter.isProcessAlive !== undefined) {
    try {
      return adapter.isProcessAlive(pid)
    } catch {
      return undefined
    }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    return undefined
  }
}

function isLeaseOwner(value: unknown): value is LeaseOwner {
  if (typeof value !== "object" || value === null) return false
  const owner = value as Partial<LeaseOwner>
  return (
    owner.version === 1 &&
    typeof owner.token === "string" &&
    /^[a-f0-9-]{16,128}$/i.test(owner.token) &&
    typeof owner.pid === "number" &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.createdAt === "number" &&
    Number.isFinite(owner.createdAt)
  )
}

function isLeaseHeartbeat(value: unknown): value is LeaseHeartbeat {
  if (typeof value !== "object" || value === null) return false
  const heartbeat = value as Partial<LeaseHeartbeat>
  return (
    heartbeat.version === 1 &&
    typeof heartbeat.token === "string" &&
    /^[a-f0-9-]{16,128}$/i.test(heartbeat.token) &&
    typeof heartbeat.heartbeatAt === "number" &&
    Number.isFinite(heartbeat.heartbeatAt) &&
    typeof heartbeat.leaseExpiresAt === "number" &&
    Number.isFinite(heartbeat.leaseExpiresAt) &&
    heartbeat.heartbeatAt < heartbeat.leaseExpiresAt
  )
}

function directoryIdentity(details: BigIntStats): DirectoryIdentity {
  return {
    dev: details.dev,
    ino: details.ino,
    birthtimeNs: details.birthtimeNs,
    ctimeNs: details.ctimeNs,
  }
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  // Directory ctime changes when owner/heartbeat entries are atomically published.
  // Device, inode, and birth time identify the immutable directory object.
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
}

async function readLeaseFile<T>(
  directory: string,
  name: string,
  validate: (value: unknown) => value is T,
): Promise<{ readonly value?: T; readonly fingerprint: string }> {
  const checked = await readContainedRegularFile(resolve(directory, name), directory)
  if (checked === undefined || (process.platform !== "win32" && (checked.mode & 0o777) !== 0o600)) {
    return { fingerprint: "missing-or-unsafe" }
  }
  const fingerprint = `${hash(checked.bytes)}:${checked.mode & 0o777}`
  try {
    const value: unknown = JSON.parse(checked.bytes.toString("utf8"))
    return validate(value) ? { value, fingerprint } : { fingerprint }
  } catch {
    return { fingerprint }
  }
}

interface LockInspection {
  readonly kind: "present"
  readonly identity: DirectoryIdentity
  readonly ownerFingerprint: string
  readonly heartbeatFingerprint: string
  readonly owner?: LeaseOwner
  readonly heartbeat?: LeaseHeartbeat
}

async function inspectLockDirectory(
  path: string,
  parent: string,
): Promise<LockInspection | { readonly kind: "missing" | "unsafe" }> {
  try {
    const details = await lstat(path, { bigint: true })
    if (details.isSymbolicLink() || !details.isDirectory()) return { kind: "unsafe" }
    const canonical = await realpath(path)
    if (!isInside(parent, canonical)) return { kind: "unsafe" }
    const owner = await readLeaseFile(path, leaseOwnerName, isLeaseOwner)
    const heartbeat = await readLeaseFile(path, leaseHeartbeatName, isLeaseHeartbeat)
    const after = await lstat(path, { bigint: true })
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !sameDirectory(directoryIdentity(details), directoryIdentity(after)) ||
      !pathsEqual(canonical, await realpath(path))
    ) {
      return { kind: "unsafe" }
    }
    return {
      kind: "present",
      identity: directoryIdentity(after),
      owner: owner.value,
      heartbeat: heartbeat.value,
      ownerFingerprint: owner.fingerprint,
      heartbeatFingerprint: heartbeat.fingerprint,
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unsafe" }
  }
}

async function publishLeaseFile(
  directory: string,
  name: string,
  value: LeaseOwner | LeaseHeartbeat,
): Promise<void> {
  const finalPath = resolve(directory, name)
  const temporary = resolve(directory, `.${name}.tmp-${value.token}-${randomUUID()}`)
  let handle
  try {
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
    await handle.close()
    handle = undefined
    const staged = await readContainedRegularFile(temporary, directory)
    if (
      staged === undefined ||
      !staged.bytes.equals(Buffer.from(JSON.stringify(value))) ||
      (process.platform !== "win32" && (staged.mode & 0o777) !== 0o600)
    ) {
      throw new Error("lease metadata could not be revalidated")
    }
    await nodeRename(temporary, finalPath)
    await syncContainingDirectory(finalPath)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function validLease(inspection: LockInspection): inspection is LockInspection & {
  readonly owner: LeaseOwner
  readonly heartbeat: LeaseHeartbeat
} {
  return (
    inspection.owner !== undefined &&
    inspection.heartbeat !== undefined &&
    inspection.owner.token === inspection.heartbeat.token &&
    inspection.owner.createdAt <= inspection.heartbeat.heartbeatAt
  )
}

async function restoreQuarantine(
  quarantine: string,
  candidate: string,
  adapter: NoteFileAdapter,
): Promise<boolean> {
  const retryDelayMs = Math.max(1, adapter.heartbeatRetryDelayMs ?? 10)
  const retryLimit = Math.max(
    2,
    Math.min(200, Math.ceil((adapter.lockWaitMs ?? defaultLockWaitMs) / retryDelayMs)),
  )
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      await lstat(candidate)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false
    }
    try {
      await nodeRename(quarantine, candidate)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOENT") return false
      if (attempt === retryLimit) return false
      await leaseDelay(adapter, retryDelayMs)
    }
  }
  return false
}

async function acquireLease(
  candidate: string,
  parent: string,
  adapter: NoteFileAdapter,
  ownershipError: (stage?: "release-rename" | "release-cleanup" | "release-mismatch") => AppError,
): Promise<LeaseLock | undefined> {
  const leaseMs = Math.max(1, adapter.lockLeaseMs ?? defaultLockLeaseMs)
  const graceMs = Math.max(1, adapter.lockGraceMs ?? defaultLockGraceMs)
  const token = randomUUID()
  const createdAt = leaseNow(adapter)
  const owner: LeaseOwner = {
    version: 1,
    token,
    pid: process.pid,
    createdAt,
  }
  let acquiredIdentity: DirectoryIdentity | undefined
  let partialSeenAt: number | undefined
  const reclaimedQuarantines: string[] = []

  while (acquiredIdentity === undefined) {
    try {
      await mkdir(candidate, { mode: 0o700 })
      const acquired = await inspectLockDirectory(candidate, parent)
      if (acquired.kind !== "present") throw new Error("lock directory is unsafe")
      acquiredIdentity = acquired.identity
      await adapter.beforeLockMetadataPublish?.(candidate)
      const heartbeatAt = leaseNow(adapter)
      await publishLeaseFile(candidate, leaseOwnerName, owner)
      await publishLeaseFile(candidate, leaseHeartbeatName, {
        version: 1,
        token,
        heartbeatAt,
        leaseExpiresAt: heartbeatAt + leaseMs,
      })
      const published = await inspectLockDirectory(candidate, parent)
      if (
        published.kind !== "present" ||
        !sameDirectory(acquiredIdentity, published.identity) ||
        !validLease(published) ||
        published.owner.token !== token
      ) {
        throw new Error("lock ownership could not be published")
      }
      await adapter.afterLockMetadataPublish?.(candidate)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }

    const observed = await inspectLockDirectory(candidate, parent)
    if (observed.kind !== "present") {
      if (observed.kind === "missing") continue
      return undefined
    }
    const now = leaseNow(adapter)
    const complete = validLease(observed)
    if (
      complete &&
      (observed.heartbeat.leaseExpiresAt > now ||
        processLiveness(adapter, observed.owner.pid) !== false)
    ) {
      return undefined
    }
    if (!complete) {
      partialSeenAt ??= now
      const elapsed = now - partialSeenAt
      if (elapsed < graceMs) {
        await leaseDelay(adapter, Math.min(25, Math.max(1, graceMs - elapsed)))
        continue
      }
    }

    const quarantine = `${candidate}.quarantine-${randomUUID()}`
    const beforeQuarantine = await inspectLockDirectory(candidate, parent)
    if (beforeQuarantine.kind === "missing") continue
    if (
      beforeQuarantine.kind !== "present" ||
      !sameDirectory(observed.identity, beforeQuarantine.identity) ||
      beforeQuarantine.ownerFingerprint !== observed.ownerFingerprint ||
      beforeQuarantine.heartbeatFingerprint !== observed.heartbeatFingerprint
    ) {
      return undefined
    }
    try {
      await nodeRename(candidate, quarantine)
    } catch {
      continue
    }
    const moved = await inspectLockDirectory(quarantine, parent)
    if (
      moved.kind !== "present" ||
      !sameDirectory(beforeQuarantine.identity, moved.identity) ||
      moved.ownerFingerprint !== beforeQuarantine.ownerFingerprint ||
      moved.heartbeatFingerprint !== beforeQuarantine.heartbeatFingerprint ||
      (validLease(moved) &&
        (moved.heartbeat.leaseExpiresAt > leaseNow(adapter) ||
          processLiveness(adapter, moved.owner.pid) !== false))
    ) {
      await restoreQuarantine(quarantine, candidate, adapter)
      return undefined
    }
    reclaimedQuarantines.push(quarantine)
    partialSeenAt = undefined
  }

  const identityAtAcquisition = acquiredIdentity
  await Promise.all(
    reclaimedQuarantines.map((quarantine) =>
      rm(quarantine, { force: true, recursive: true }).catch(() => undefined),
    ),
  )
  let stopped = false
  let lostOwnership = false
  const heartbeatRetryLimit = Math.max(0, Math.min(5, adapter.heartbeatRetryLimit ?? 2))
  const heartbeatRetryDelayMs = Math.max(1, adapter.heartbeatRetryDelayMs ?? 10)
  const ownershipRetryLimit = Math.max(
    2,
    Math.min(200, Math.ceil((adapter.lockWaitMs ?? defaultLockWaitMs) / heartbeatRetryDelayMs)),
  )

  async function ownershipStatus(): Promise<"owned" | "lost" | "unknown"> {
    const current = await inspectLockDirectory(candidate, parent)
    if (current.kind === "unsafe") return "unknown"
    // A concurrent stale-lock contender can briefly quarantine this directory
    // between its identity check and rename. Missing is therefore ambiguous
    // until the bounded ownership retry policy is exhausted.
    if (current.kind === "missing") return "unknown"
    if (current.kind !== "present") return "unknown"
    return sameDirectory(identityAtAcquisition, current.identity) && current.owner?.token === token
      ? "owned"
      : "lost"
  }

  async function assertOwned(): Promise<void> {
    await heartbeatWork.catch(() => undefined)
    if (!lostOwnership) {
      for (let attempt = 0; attempt <= ownershipRetryLimit; attempt += 1) {
        const status = await ownershipStatus()
        if (status === "owned") return
        if (status === "lost") break
        if (attempt < ownershipRetryLimit) {
          await leaseDelay(adapter, heartbeatRetryDelayMs)
        }
      }
    }
    lostOwnership = true
    throw ownershipError()
  }

  let heartbeatWork = Promise.resolve()

  async function runHeartbeat(): Promise<void> {
    if (stopped) return
    for (let attempt = 0; attempt <= heartbeatRetryLimit; attempt += 1) {
      const before = await ownershipStatus()
      if (before === "lost") {
        lostOwnership = true
        return
      }
      try {
        if (before !== "owned") throw new Error("heartbeat ownership was ambiguous")
        const heartbeatAt = leaseNow(adapter)
        await adapter.beforeHeartbeatPublish?.(candidate, attempt)
        await publishLeaseFile(candidate, leaseHeartbeatName, {
          version: 1,
          token,
          heartbeatAt,
          leaseExpiresAt: heartbeatAt + leaseMs,
        })
        await adapter.afterLockHeartbeat?.(candidate)
        const after = await ownershipStatus()
        if (after === "lost") {
          lostOwnership = true
          return
        }
        if (after === "owned") return
        throw new Error("heartbeat ownership was ambiguous")
      } catch {
        const afterFailure = await ownershipStatus()
        if (afterFailure !== "owned") {
          lostOwnership = true
          return
        }
        if (attempt === heartbeatRetryLimit) {
          lostOwnership = true
          return
        }
        await leaseDelay(adapter, heartbeatRetryDelayMs * (attempt + 1))
      }
    }
  }

  function queueHeartbeat(): Promise<void> {
    heartbeatWork = heartbeatWork.then(runHeartbeat)
    return heartbeatWork
  }

  const heartbeatInterval = Math.max(1, Math.floor(leaseMs / 3))
  let stopHeartbeat: () => void
  if (adapter.startHeartbeat !== undefined) {
    stopHeartbeat = adapter.startHeartbeat(candidate, queueHeartbeat, heartbeatInterval)
  } else {
    const heartbeat = setInterval(() => void queueHeartbeat(), heartbeatInterval)
    heartbeat.unref()
    stopHeartbeat = () => clearInterval(heartbeat)
  }

  return {
    assertOwned,
    async release(): Promise<void> {
      stopped = true
      stopHeartbeat()
      await heartbeatWork.catch(() => undefined)
      try {
        await adapter.beforeLockRelease?.(candidate)
      } catch {
        throw ownershipError()
      }
      const quarantine = `${candidate}.release-${token}-${randomUUID()}`
      let quarantined = false
      for (let attempt = 0; attempt <= ownershipRetryLimit; attempt += 1) {
        try {
          await nodeRename(candidate, quarantine)
          quarantined = true
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          const transient =
            code === "ENOENT" ||
            code === "EPERM" ||
            code === "EACCES" ||
            code === "EBUSY" ||
            code === "ENOTEMPTY"
          const status = await ownershipStatus()
          if (status === "lost" || !transient || attempt === ownershipRetryLimit) {
            throw ownershipError("release-rename")
          }
          await leaseDelay(adapter, heartbeatRetryDelayMs)
        }
      }
      if (!quarantined) throw ownershipError("release-rename")
      const moved = await inspectLockDirectory(quarantine, parent)
      if (
        moved.kind === "present" &&
        sameDirectory(identityAtAcquisition, moved.identity) &&
        moved.owner?.token === token
      ) {
        const cleanupRetries = Math.max(5, heartbeatRetryLimit)
        for (let attempt = 0; attempt <= cleanupRetries; attempt += 1) {
          try {
            await rm(quarantine, { force: true, recursive: true })
            return
          } catch {
            if (attempt === cleanupRetries) throw ownershipError("release-cleanup")
            await leaseDelay(adapter, heartbeatRetryDelayMs * (attempt + 1))
          }
        }
      }
      await restoreQuarantine(quarantine, candidate, adapter)
      throw ownershipError("release-mismatch")
    },
  }
}

async function recoveryKey(
  state: string,
  create: boolean,
  adapter: NoteFileAdapter = {},
): Promise<Buffer> {
  const keys = await stateChild(state, recoveryKeyDirectory, create)
  const path = resolve(keys, recoveryKeyName)
  async function existing(): Promise<Buffer | undefined> {
    try {
      return await readProtectedKey(path, keys)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }
  const present = await existing()
  if (present !== undefined) return present
  if (!create) throw appError("RECOVERY_INVALID", "Recovery key is invalid.")

  const initializationLock = `${path}.initializing`
  const deadline = leaseNow(adapter) + Math.max(1, adapter.lockWaitMs ?? defaultLockWaitMs)
  let lock: LeaseLock | undefined
  while (lock === undefined) {
    const publishedBeforeLock = await existing()
    if (publishedBeforeLock !== undefined) return publishedBeforeLock
    try {
      lock = await acquireLease(initializationLock, keys, adapter, (stage) =>
        appError(
          "RECOVERY_INVALID",
          stage === undefined
            ? "Recovery key initializer ownership was lost."
            : `Recovery key initializer ownership was lost at ${stage}.`,
        ),
      )
    } catch {
      throw appError("RECOVERY_INVALID", "Recovery key could not be initialized.")
    }
    if (lock !== undefined) break
    const published = await existing()
    if (published !== undefined) return published
    if (leaseNow(adapter) >= deadline)
      throw appError("RECOVERY_INVALID", "Recovery key could not be initialized.")
    await leaseDelay(adapter, 25)
  }

  const temporary = `${path}.tmp-${randomUUID()}`
  let handle
  try {
    const concurrentlyPublished = await existing()
    if (concurrentlyPublished !== undefined) return concurrentlyPublished
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(randomBytes(32))
    await handle.sync()
    await handle.close()
    handle = undefined
    await adapter.beforeKeyPublish?.()
    try {
      await lock.assertOwned()
    } catch (error) {
      if (isNoteError(error)) throw error
      throw appError(
        "RECOVERY_INVALID",
        "Recovery key initializer ownership was lost before publication.",
      )
    }
    await nodeRename(temporary, path)
    await (adapter.syncDirectory !== undefined
      ? adapter.syncDirectory(keys)
      : syncExactDirectory(keys))
    await adapter.afterKeyPublish?.()
  } catch (error) {
    if (isNoteError(error)) throw error
    throw appError("RECOVERY_INVALID", "Recovery key could not be initialized.")
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    try {
      await lock.release()
    } catch (error) {
      if (isNoteError(error)) throw error
      throw appError(
        "RECOVERY_INVALID",
        "Recovery key initializer ownership was lost during release.",
      )
    }
  }
  try {
    return await readProtectedKey(path, keys)
  } catch {
    throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
  }
}

async function acquireTargetLock(
  workspace: string,
  path: string,
  adapter: NoteFileAdapter,
): Promise<TargetLock> {
  const recovery = await recoveryRoot(workspace, true)
  const locks = await stateChild(dirname(recovery), "locks", true)
  const candidate = resolve(locks, `${hash(path)}.lock`)
  try {
    const lock = await acquireLease(candidate, locks, adapter, (stage) =>
      appError(
        "NOTE_FILE_LOCKED",
        stage === undefined
          ? "The note lock is no longer owned."
          : `The note lock failed at ${stage}.`,
        { path },
      ),
    )
    if (lock !== undefined) return { ...lock, lockId: `${hash(path)}.lock` }
  } catch {
    throw accessFailure(path)
  }
  throw appError("NOTE_FILE_LOCKED", "The note is being saved by another process.", { path })
}

/** Narrow internal bridge shared with multi-path note transactions. */
export interface InternalNotePathLease {
  readonly lockId: string
  assertOwned(): Promise<void>
  release(): Promise<void>
}

/** Uses the exact save/restore lease namespace and lifecycle for a canonical relative note path. */
export async function acquireInternalNotePathLease(
  workspace: string,
  path: string,
  adapter: NoteFileAdapter = {},
): Promise<InternalNotePathLease> {
  return acquireTargetLock(workspace, path, adapter)
}

/** Uses the exact recovery key initialization lease and protected read implementation. */
export async function internalRecoveryKey(
  workspace: string,
  create: boolean,
  adapter: NoteFileAdapter = {},
): Promise<Buffer> {
  const recovery = await recoveryRoot(workspace, create)
  return recoveryKey(dirname(recovery), create, adapter)
}

function manifestPayload(manifest: Omit<RecoveryManifest, "integrity">): string {
  return JSON.stringify({
    version: manifest.version,
    id: manifest.id,
    originalPath: manifest.originalPath,
    createdAt: manifest.createdAt,
    contentHash: manifest.contentHash,
    mtimeMs: manifest.mtimeMs,
    sourceFile: manifest.sourceFile,
    integrityFile: manifest.integrityFile,
  })
}

function manifestIntegrity(key: Buffer, manifest: Omit<RecoveryManifest, "integrity">): string {
  // This detects accidental or entry-local coherent tampering. It does not
  // protect against an attacker that can read this workspace-local key.
  return createHmac("sha256", key).update(manifestPayload(manifest)).digest("hex")
}

function sameIntegrity(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

async function writeSyncedExclusiveFile(path: string, bytes: Uint8Array | string): Promise<void> {
  let handle
  try {
    handle = await open(path, "wx", 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function removeOwnedRecoveryStaging(
  root: string,
  staging: string,
  ownedIdentity: DirectoryIdentity,
): Promise<void> {
  const name = safeRelative(root, staging)
  if (!recoveryStagingPattern.test(name) || !isInside(root, staging)) return
  const before = await lstat(staging, { bigint: true }).catch(() => undefined)
  if (
    before === undefined ||
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !sameDirectory(directoryIdentity(before), ownedIdentity)
  ) {
    return
  }
  const quarantine = resolve(root, `.quarantine-${randomUUID()}`)
  await nodeRename(staging, quarantine)
  const moved = await lstat(quarantine, { bigint: true }).catch(() => undefined)
  if (
    moved === undefined ||
    moved.isSymbolicLink() ||
    !moved.isDirectory() ||
    !sameDirectory(directoryIdentity(moved), ownedIdentity)
  ) {
    return
  }
  await rm(quarantine, { force: true, recursive: true })
}

function resolvedRecoveryPolicy(policy?: RecoveryRetentionPolicy): RecoveryRetentionPolicy {
  return {
    perNoteLimit: Math.max(1, Math.floor(policy?.perNoteLimit ?? DEFAULT_RECOVERY_PER_NOTE_LIMIT)),
    globalLimit: Math.max(1, Math.floor(policy?.globalLimit ?? DEFAULT_RECOVERY_GLOBAL_LIMIT)),
  }
}

interface RecoveryRetentionStatePayload {
  readonly version: 1
  readonly cursor?: string
  readonly globalSeen: number
  readonly perNoteCounts: Readonly<Record<string, number>>
  readonly backlog: readonly string[]
}

interface RecoveryRetentionState extends RecoveryRetentionStatePayload {
  readonly integrity: string
}

function emptyRecoveryRetentionState(): RecoveryRetentionStatePayload {
  return { version: 1, globalSeen: 0, perNoteCounts: {}, backlog: [] }
}

function retentionStatePayload(state: RecoveryRetentionStatePayload): string {
  const perNoteCounts = Object.fromEntries(
    Object.entries(state.perNoteCounts).sort(([left], [right]) => left.localeCompare(right)),
  )
  return JSON.stringify({
    version: state.version,
    cursor: state.cursor ?? null,
    globalSeen: state.globalSeen,
    perNoteCounts,
    backlog: state.backlog,
  })
}

function retentionStateIntegrity(key: Buffer, state: RecoveryRetentionStatePayload): string {
  return createHmac("sha256", key).update(retentionStatePayload(state)).digest("hex")
}

function isRetentionCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (recoveryIdPattern.test(value) ||
      recoveryStagingPattern.test(value) ||
      recoveryQuarantinePattern.test(value) ||
      recoveryRetentionQuarantinePattern.test(value))
  )
}

function isRecoveryMaintenanceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (recoveryIdPattern.test(value) || recoveryRetentionQuarantinePattern.test(value))
  )
}

function parseRecoveryRetentionState(
  value: unknown,
  key: Buffer,
): RecoveryRetentionStatePayload | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const state = value as Partial<RecoveryRetentionState>
  if (
    state.version !== 1 ||
    (state.cursor !== undefined && state.cursor !== null && !isRetentionCursor(state.cursor)) ||
    typeof state.globalSeen !== "number" ||
    !Number.isSafeInteger(state.globalSeen) ||
    state.globalSeen < 0 ||
    typeof state.perNoteCounts !== "object" ||
    state.perNoteCounts === null ||
    Array.isArray(state.perNoteCounts) ||
    !Array.isArray(state.backlog) ||
    state.backlog.length > RECOVERY_RETENTION_MAX_BACKLOG ||
    !state.backlog.every(isRecoveryMaintenanceName) ||
    new Set(state.backlog).size !== state.backlog.length ||
    typeof state.integrity !== "string"
  ) {
    return undefined
  }
  const countEntries = Object.entries(state.perNoteCounts)
  if (
    countEntries.length > MAX_RECOVERY_GLOBAL_LIMIT ||
    countEntries.some(
      ([pathHash, count]) =>
        !/^[a-f0-9]{64}$/.test(pathHash) || !Number.isSafeInteger(count) || count < 1,
    )
  ) {
    return undefined
  }
  const payload: RecoveryRetentionStatePayload = {
    version: 1,
    ...(typeof state.cursor === "string" ? { cursor: state.cursor } : {}),
    globalSeen: state.globalSeen,
    perNoteCounts: Object.fromEntries(countEntries),
    backlog: [...state.backlog],
  }
  return sameIntegrity(state.integrity, retentionStateIntegrity(key, payload)) ? payload : undefined
}

async function readRecoveryRetentionState(
  stateDirectory: string,
  key: Buffer,
): Promise<RecoveryRetentionStatePayload> {
  const path = resolve(stateDirectory, recoveryRetentionStateName)
  const file = await readContainedRegularFile(
    path,
    stateDirectory,
    maximumRecoveryRetentionStateBytes,
  )
  if (file === undefined || (process.platform !== "win32" && (file.mode & 0o777) !== 0o600)) {
    return emptyRecoveryRetentionState()
  }
  try {
    return (
      parseRecoveryRetentionState(JSON.parse(file.bytes.toString("utf8")), key) ??
      emptyRecoveryRetentionState()
    )
  } catch {
    return emptyRecoveryRetentionState()
  }
}

async function writeRecoveryRetentionState(
  stateDirectory: string,
  key: Buffer,
  payload: RecoveryRetentionStatePayload,
): Promise<void> {
  const path = resolve(stateDirectory, recoveryRetentionStateName)
  const temporary = resolve(stateDirectory, `.${recoveryRetentionStateName}.tmp-${randomUUID()}`)
  let temporaryIdentity: string | undefined
  try {
    const state: RecoveryRetentionState = {
      ...payload,
      integrity: retentionStateIntegrity(key, payload),
    }
    await writeSyncedExclusiveFile(temporary, JSON.stringify(state))
    const details = await lstat(temporary, { bigint: true })
    if (details.isSymbolicLink() || !details.isFile()) throw new Error("invalid retention state")
    temporaryIdentity = stableFileIdentity(details)
    await nodeRename(temporary, path)
    temporaryIdentity = undefined
    await syncExactDirectory(stateDirectory)
  } finally {
    if (temporaryIdentity !== undefined) {
      await removeFailedExclusiveFile(temporary, temporaryIdentity).catch(() => undefined)
    }
  }
}

function retentionWarning(
  operation: "save" | "restore",
  attemptedCount: number,
  failureCount: number,
): NoteOperationWarning {
  return {
    code: "RECOVERY_RETENTION_FAILED",
    message: `The ${operation} completed, but bounded recovery maintenance needs another pass.`,
    details: { operation, attemptedCount, failureCount },
  }
}

async function cleanupAbandonedRecoveryQuarantine(root: string, name: string): Promise<void> {
  if (!recoveryQuarantinePattern.test(name)) return
  const candidate = resolve(root, name)
  if (!isInside(root, candidate) || safeRelative(root, candidate) !== name) return
  const before = await lstat(candidate, { bigint: true }).catch(() => undefined)
  if (
    before === undefined ||
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    Date.now() - Number(before.mtimeMs) < abandonedRecoveryStagingAgeMs ||
    (process.platform !== "win32" && (Number(before.mode) & 0o777) !== 0o700)
  ) {
    return
  }
  const ownedIdentity = directoryIdentity(before)
  const movedPath = resolve(root, `.quarantine-${randomUUID()}`)
  await nodeRename(candidate, movedPath)
  const moved = await lstat(movedPath, { bigint: true }).catch(() => undefined)
  if (
    moved === undefined ||
    moved.isSymbolicLink() ||
    !moved.isDirectory() ||
    !sameDirectory(directoryIdentity(moved), ownedIdentity)
  ) {
    return
  }
  await rm(movedPath, { force: true, recursive: true })
}

interface RecoveryTrashAttempt {
  readonly attempted: boolean
  readonly failed: boolean
  readonly retryName?: string
}

async function trashAuthenticatedRecovery(
  root: string,
  entry: RecoveryMetadata,
  trash: TrashAdapter,
): Promise<RecoveryTrashAttempt> {
  const source = resolve(root, entry.directoryName)
  if (
    !isInside(root, source) ||
    safeRelative(root, source) !== entry.directoryName ||
    !isRecoveryMaintenanceName(entry.directoryName)
  ) {
    return { attempted: false, failed: true }
  }
  const before = await lstat(source, { bigint: true }).catch(() => undefined)
  if (
    before === undefined ||
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !sameDirectory(directoryIdentity(before), entry.directoryIdentity)
  ) {
    return { attempted: false, failed: true, retryName: entry.directoryName }
  }
  const movedName = `.retention-${entry.manifest.id}-${randomUUID()}`
  const movedPath = resolve(root, movedName)
  try {
    await nodeRename(source, movedPath)
  } catch {
    return { attempted: false, failed: true, retryName: entry.directoryName }
  }
  const moved = await lstat(movedPath, { bigint: true }).catch(() => undefined)
  if (
    moved === undefined ||
    moved.isSymbolicLink() ||
    !moved.isDirectory() ||
    !sameDirectory(directoryIdentity(moved), entry.directoryIdentity) ||
    !isInside(root, await realpath(movedPath).catch(() => ""))
  ) {
    return { attempted: false, failed: true, retryName: movedName }
  }
  try {
    await trash.trashItem(movedPath)
    return { attempted: true, failed: false }
  } catch {
    return { attempted: true, failed: true, retryName: movedName }
  }
}

async function maintainRecoveryRetention(
  workspace: string,
  trash: TrashAdapter,
  requestedPolicy?: RecoveryRetentionPolicy,
  operation: "save" | "restore" = "save",
): Promise<readonly NoteOperationWarning[]> {
  const policy = resolvedRecoveryPolicy(requestedPolicy)
  let attemptedCount = 0
  let failureCount = 0
  try {
    const root = await recoveryRoot(workspace, false)
    const stateDirectory = dirname(root)
    // The key is intentionally loaded once for the whole maintenance pass.
    const key = await recoveryKey(stateDirectory, false)
    const previous = await readRecoveryRetentionState(stateDirectory, key)
    const backlog = [...previous.backlog]
    const deferredBacklog: string[] = []
    const failedBacklog: string[] = []
    let authenticationAttempts = 0
    let trashCalls = 0
    let backlogEntriesProcessed = 0

    for (const name of backlog) {
      if (
        authenticationAttempts >= RECOVERY_RETENTION_MAX_AUTH_ATTEMPTS ||
        backlogEntriesProcessed >= Math.ceil(RECOVERY_RETENTION_MAX_TRASH_CALLS / 2)
      ) {
        deferredBacklog.push(name)
        continue
      }
      backlogEntriesProcessed += 1
      authenticationAttempts += 1
      try {
        const entry = await readRecoveryMetadata(workspace, root, key, name)
        const outcome = await trashAuthenticatedRecovery(root, entry, trash)
        if (outcome.attempted) {
          attemptedCount += 1
          trashCalls += 1
        }
        if (outcome.failed) {
          failureCount += 1
          if (outcome.retryName !== undefined) failedBacklog.push(outcome.retryName)
        }
      } catch {
        // Missing or corrupt backlog entries are forgotten, never trashed.
      }
    }
    const nextBacklog = [...deferredBacklog, ...failedBacklog].slice(
      0,
      RECOVERY_RETENTION_MAX_BACKLOG,
    )
    function enqueueBacklog(name: string): void {
      if (!isRecoveryMaintenanceName(name) || nextBacklog.includes(name)) return
      if (nextBacklog.length >= RECOVERY_RETENTION_MAX_BACKLOG) nextBacklog.shift()
      nextBacklog.push(name)
    }

    const names = (await readdir(root))
      .filter(
        (name) =>
          recoveryIdPattern.test(name) ||
          recoveryStagingPattern.test(name) ||
          recoveryQuarantinePattern.test(name) ||
          recoveryRetentionQuarantinePattern.test(name),
      )
      .sort()
      .reverse()
    const pageBudget = Math.min(
      RECOVERY_RETENTION_MAX_DIRECTORY_ENTRIES,
      RECOVERY_RETENTION_MAX_AUTH_ATTEMPTS - authenticationAttempts,
    )
    const page = names
      .filter((name) => previous.cursor === undefined || name.localeCompare(previous.cursor) < 0)
      .slice(0, pageBudget)
    let globalSeen = previous.globalSeen
    const perNoteCounts = { ...previous.perNoteCounts }

    for (const name of page) {
      if (recoveryStagingPattern.test(name)) {
        await cleanupAbandonedRecoveryStaging(root, name).catch(() => undefined)
        continue
      }
      if (recoveryQuarantinePattern.test(name)) {
        await cleanupAbandonedRecoveryQuarantine(root, name).catch(() => undefined)
        continue
      }
      authenticationAttempts += 1
      let entry: RecoveryMetadata
      try {
        entry = await readRecoveryMetadata(workspace, root, key, name)
      } catch {
        // Corrupt IDs advance the cursor but are never selected automatically.
        continue
      }
      const pathHash = hash(entry.manifest.originalPath)
      const noteSeen = perNoteCounts[pathHash] ?? 0
      const shouldTrash =
        recoveryRetentionQuarantinePattern.test(name) ||
        globalSeen >= policy.globalLimit ||
        noteSeen >= policy.perNoteLimit
      if (!shouldTrash) {
        globalSeen += 1
        perNoteCounts[pathHash] = noteSeen + 1
      }
      if (!shouldTrash) continue
      if (trashCalls >= RECOVERY_RETENTION_MAX_TRASH_CALLS) {
        enqueueBacklog(name)
        continue
      }
      const outcome = await trashAuthenticatedRecovery(root, entry, trash)
      if (outcome.attempted) {
        attemptedCount += 1
        trashCalls += 1
      }
      if (outcome.failed) {
        failureCount += 1
        enqueueBacklog(outcome.retryName ?? name)
      }
    }
    const completedSweep = page.length < pageBudget
    const nextState: RecoveryRetentionStatePayload = completedSweep
      ? {
          version: 1,
          globalSeen: 0,
          perNoteCounts: {},
          backlog: nextBacklog.slice(0, RECOVERY_RETENTION_MAX_BACKLOG),
        }
      : {
          version: 1,
          cursor: page.at(-1),
          globalSeen,
          perNoteCounts,
          backlog: nextBacklog.slice(0, RECOVERY_RETENTION_MAX_BACKLOG),
        }
    try {
      await writeRecoveryRetentionState(stateDirectory, key, nextState)
    } catch {
      failureCount += 1
    }
  } catch {
    failureCount += 1
  }
  return failureCount === 0
    ? []
    : [retentionWarning(operation, attemptedCount, failureCount)].slice(
        0,
        RECOVERY_RETENTION_MAX_WARNINGS,
      )
}

async function createRecovery(
  workspace: string,
  originalPath: string,
  checked: CheckedFile,
  adapter: NoteFileAdapter = {},
): Promise<RecoverySummary> {
  const root = await recoveryRoot(workspace, true)
  const key = await recoveryKey(dirname(root), true, adapter)
  const createdAtMs = Date.now()
  const id = `${createdAtMs}-${randomUUID()}`
  const directory = resolve(root, id)
  const staging = resolve(root, `.staging-${id}-${randomUUID()}`)
  const manifestData: Omit<RecoveryManifest, "integrity"> = {
    version: 1,
    id,
    originalPath,
    createdAt: new Date(createdAtMs).toISOString(),
    contentHash: checked.revision.contentHash,
    mtimeMs: checked.revision.mtimeMs,
    sourceFile: "content.md",
    integrityFile: "integrity.sha256",
  }
  const manifest: RecoveryManifest = {
    ...manifestData,
    integrity: manifestIntegrity(key, manifestData),
  }
  let stagingIdentity: DirectoryIdentity | undefined
  try {
    await mkdir(staging, { mode: 0o700 })
    const created = await lstat(staging, { bigint: true })
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("invalid staging")
    stagingIdentity = directoryIdentity(created)
    await writeSyncedExclusiveFile(resolve(staging, manifest.sourceFile), checked.bytes)
    await writeSyncedExclusiveFile(resolve(staging, "manifest.json"), JSON.stringify(manifest))
    await writeSyncedExclusiveFile(
      resolve(staging, manifest.integrityFile),
      `${manifest.integrity}\n`,
    )
    await (adapter.syncDirectory !== undefined
      ? adapter.syncDirectory(staging)
      : syncExactDirectory(staging))
    try {
      await (adapter.rename ?? nodeRename)(staging, directory)
    } catch (renameError) {
      try {
        await readRecovery(workspace, id)
      } catch {
        throw renameError
      }
    }
    await (adapter.syncDirectory !== undefined
      ? adapter.syncDirectory(root)
      : syncExactDirectory(root))
  } catch {
    if (stagingIdentity !== undefined) {
      await removeOwnedRecoveryStaging(root, staging, stagingIdentity).catch(() => undefined)
    }
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
  return syncExactDirectory(dirname(target))
}

async function syncExactDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, "r")
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

interface SafeFileContents {
  readonly bytes: Buffer
  readonly identity: string
  readonly mode: number
}

async function readContainedRegularFile(
  path: string,
  parent: string,
  maximumBytes?: number,
): Promise<SafeFileContents | undefined> {
  let handle
  try {
    const before = await lstat(path, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile()) return undefined
    const canonical = await realpath(path)
    if (!isInside(parent, canonical)) return undefined
    const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
    handle = await open(path, flags)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || identity(before) !== identity(opened)) return undefined
    if (maximumBytes !== undefined && opened.size > BigInt(maximumBytes)) return undefined
    let bytes: Buffer
    if (maximumBytes === undefined) {
      bytes = await handle.readFile()
    } else {
      const bounded = await readBoundedHandle(handle, maximumBytes)
      if (bounded === undefined) return undefined
      bytes = bounded
    }
    const after = await lstat(path, { bigint: true })
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      identity(before) !== identity(after) ||
      identity(opened) !== identity(after) ||
      !pathsEqual(canonical, await realpath(path))
    ) {
      return undefined
    }
    return { bytes, identity: identity(opened), mode: Number(opened.mode) }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeTempAndReplace(
  target: string,
  displayPath: string,
  bytes: Buffer,
  recoveryBytes: Buffer | undefined,
  mode: number | undefined,
  adapter: NoteFileAdapter,
  assertLockOwned: () => Promise<void>,
  verifyBeforeCommit: () => Promise<void>,
): Promise<void> {
  const temp = `${target}.garden-publisher-tmp-${randomUUID()}`
  let handle
  let stagedIdentity: string | undefined

  async function rollback(): Promise<boolean> {
    if (recoveryBytes === undefined) return false
    const rollbackTemp = `${target}.garden-publisher-rollback-${randomUUID()}`
    let rollbackHandle
    try {
      rollbackHandle = await open(rollbackTemp, "wx", 0o600)
      await rollbackHandle.writeFile(recoveryBytes)
      await rollbackHandle.sync()
      const writtenIdentity = identity(await rollbackHandle.stat({ bigint: true }))
      await rollbackHandle.close()
      rollbackHandle = undefined
      const staged = await readContainedRegularFile(rollbackTemp, dirname(rollbackTemp))
      if (
        staged === undefined ||
        staged.identity !== writtenIdentity ||
        staged.bytes.length !== recoveryBytes.length ||
        hash(staged.bytes) !== hash(recoveryBytes) ||
        !staged.bytes.equals(recoveryBytes) ||
        (process.platform !== "win32" && (staged.mode & 0o777) !== 0o600)
      ) {
        return false
      }
      try {
        await assertLockOwned()
        await (adapter.rename ?? nodeRename)(rollbackTemp, target)
      } catch {
        const restored = await readContainedRegularFile(target, dirname(target))
        if (!restored?.bytes.equals(recoveryBytes)) return false
      }
      if (mode !== undefined) await chmod(target, mode & 0o777)
      await (adapter.syncDirectory ?? syncContainingDirectory)(target)
      await assertLockOwned()
      const restored = await readContainedRegularFile(target, dirname(target))
      return (
        restored !== undefined &&
        restored.bytes.length === recoveryBytes.length &&
        hash(restored.bytes) === hash(recoveryBytes) &&
        restored.bytes.equals(recoveryBytes)
      )
    } catch {
      return false
    } finally {
      await rollbackHandle?.close().catch(() => undefined)
    }
  }

  try {
    handle = await open(temp, "wx", 0o600)
    await adapter.beforeTempWrite?.(temp)
    await handle.writeFile(bytes)
    await adapter.beforeTempSync?.(temp)
    await handle.sync()
    stagedIdentity = identity(await handle.stat({ bigint: true }))
    await handle.close()
    handle = undefined
    await adapter.beforeCommit?.(temp)
    await adapter.beforeReplace?.(displayPath)
    await assertLockOwned()
    await verifyBeforeCommit()
    // Keep staged content owner-only until it has been completely written,
    // flushed, closed, and revalidated immediately before the final swap.
    const staged = await readContainedRegularFile(temp, dirname(temp))
    if (
      staged === undefined ||
      staged.identity !== stagedIdentity ||
      staged.bytes.length !== bytes.length ||
      hash(staged.bytes) !== hash(bytes) ||
      !staged.bytes.equals(bytes) ||
      (process.platform !== "win32" && (staged.mode & 0o777) !== 0o600)
    ) {
      throw new Error("staged content changed")
    }
    await assertLockOwned()
    try {
      await (adapter.rename ?? nodeRename)(temp, target)
    } catch (renameError) {
      // A replace can complete before an adapter reports failure. Inspect the
      // live target: reporting failure after installing the requested bytes
      // would mislead a concurrent editor and discard a completed operation.
      if (!(await readContainedRegularFile(target, dirname(target)))?.bytes.equals(bytes))
        throw renameError
    }
    try {
      if (mode !== undefined) await chmod(target, mode & 0o777)
      await adapter.afterReplace?.(displayPath)
      await assertLockOwned()
      const installed = await readContainedRegularFile(target, dirname(target))
      if (
        installed === undefined ||
        installed.bytes.length !== bytes.length ||
        hash(installed.bytes) !== hash(bytes) ||
        !installed.bytes.equals(bytes)
      ) {
        throw new Error("replacement identity changed")
      }
      await (adapter.syncDirectory ?? syncContainingDirectory)(target)
      await assertLockOwned()
      const durable = await readContainedRegularFile(target, dirname(target))
      if (
        durable === undefined ||
        durable.bytes.length !== bytes.length ||
        hash(durable.bytes) !== hash(bytes) ||
        !durable.bytes.equals(bytes)
      ) {
        throw new Error("replacement changed during directory sync")
      }
    } catch {
      if (!(await rollback())) throw uncertainCommit()
      throw writeFailure(displayPath)
    }
  } catch (error) {
    if (isNoteError(error)) throw error
    throw writeFailure(displayPath)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

function result(path: string, bytes: Buffer, mtimeMs: number): NoteWriteResult {
  return { path, updatedAt: new Date(mtimeMs).toISOString(), mtimeMs, contentHash: hash(bytes) }
}

function resultWithWarnings(
  writeResult: NoteWriteResult,
  warnings: readonly NoteOperationWarning[],
): NoteWriteResult {
  return warnings.length === 0 ? writeResult : { ...writeResult, warnings }
}

function lockReleaseWarning(
  lockId: string,
  operation: "create" | "save" | "restore",
): NoteOperationWarning {
  return {
    code: "LOCK_RELEASE_FAILED",
    message: `The ${operation} completed, but its lock could not be cleaned up.`,
    details: { lockId },
  }
}

function attachCleanupWarning(error: unknown, warning: NoteOperationWarning): unknown {
  if (!isNoteError(error)) return error
  const existing = error.details?.cleanupWarnings
  const cleanupWarnings = Array.isArray(existing) ? [...existing, warning] : [warning]
  return { ...error, details: { ...error.details, cleanupWarnings } } satisfies AppError
}

async function preserveOutcomeAcrossLockRelease(
  lock: TargetLock,
  operation: "create" | "save" | "restore",
  work: () => Promise<NoteWriteResult>,
): Promise<NoteWriteResult> {
  let writeResult: NoteWriteResult | undefined
  let primaryError: unknown
  let failed = false
  try {
    writeResult = await work()
  } catch (error) {
    failed = true
    primaryError = error
  }

  let cleanupWarning: NoteOperationWarning | undefined
  try {
    await lock.release()
  } catch {
    cleanupWarning = lockReleaseWarning(lock.lockId, operation)
  }
  if (failed) {
    throw cleanupWarning === undefined
      ? primaryError
      : attachCleanupWarning(primaryError, cleanupWarning)
  }
  const completed = writeResult as NoteWriteResult
  return cleanupWarning === undefined
    ? completed
    : resultWithWarnings(completed, [...(completed.warnings ?? []), cleanupWarning])
}

async function resultFromTarget(
  target: string,
  displayPath: string,
  bytes: Buffer,
): Promise<NoteWriteResult> {
  try {
    const details = await stat(target)
    if (!details.isFile()) throw new Error("not a file")
    return result(displayPath, bytes, details.mtimeMs)
  } catch {
    throw accessFailure(displayPath)
  }
}

async function verifyUnchanged(
  root: ManagedRoot,
  domain: NoteDomain,
  filename: string,
  expected: CheckedFile,
): Promise<boolean> {
  try {
    const current = await readCheckedFile(root, domain, filename)
    return (
      current.identity === expected.identity &&
      current.revision.mtimeMs === expected.revision.mtimeMs &&
      current.revision.contentHash === expected.revision.contentHash
    )
  } catch {
    return false
  }
}

export async function createNote(
  input: CreateNoteInput,
  adapter: NoteFileAdapter = {},
): Promise<NoteWriteResult> {
  assertMetadata(input)
  const workspace = await canonicalWorkspace(input.workspace)
  const root = await managedRoot(workspace, input.visibility)
  const directory = await checkedDomain(root, input.domain, true)
  const path = `${root.name}/${input.domain}/${input.slug}.md`
  const target = resolve(directory, `${input.slug}.md`)
  const bytes = Buffer.from(markdownFor(input), "utf8")
  const lock = await acquireTargetLock(workspace, path, adapter)
  return preserveOutcomeAcrossLockRelease(lock, "create", async () => {
    await lock.assertOwned()
    await exclusiveWrite(target, bytes, path, adapter, () => lock.assertOwned())
    return resultFromTarget(target, path, bytes)
  })
}

export async function saveNote(
  input: SaveNoteInput,
  adapter: NoteFileAdapter = {},
): Promise<NoteWriteResult> {
  if (
    typeof input.markdown !== "string" ||
    !Number.isFinite(input.expectedMtimeMs) ||
    typeof input.expectedContentHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(input.expectedContentHash) ||
    typeof input.recoveryTrash?.trashItem !== "function" ||
    !isValidRecoveryPolicy(input.recoveryPolicy)
  ) {
    throw invalidInput(input.path || ".")
  }
  const workspace = await canonicalWorkspace(input.workspace)
  const parsed = parseManagedPath(workspace, input.path)
  const root = await managedRoot(workspace, parsed.visibility)
  const lock = await acquireTargetLock(workspace, parsed.displayPath, adapter)
  const completed = await preserveOutcomeAcrossLockRelease(lock, "save", async () => {
    const current = await readCheckedFile(root, parsed.domain, parsed.filename)
    if (
      current.revision.mtimeMs !== input.expectedMtimeMs ||
      current.revision.contentHash !== input.expectedContentHash.toLowerCase()
    ) {
      throw appError("EXTERNAL_EDIT", "The note changed outside the editor.", {
        path: parsed.displayPath,
        revision: current.revision.contentHash,
      })
    }
    const recovery = await createRecovery(workspace, parsed.displayPath, current, adapter)
    const authenticatedRecovery = await readRecovery(workspace, recovery.id)
    const directory = await checkedDomain(root, parsed.domain, false)
    const target = resolve(directory, parsed.filename)
    const bytes = Buffer.from(input.markdown, "utf8")
    await writeTempAndReplace(
      target,
      parsed.displayPath,
      bytes,
      authenticatedRecovery.bytes,
      current.mode,
      adapter,
      () => lock.assertOwned(),
      async () => {
        if (!(await verifyUnchanged(root, parsed.domain, parsed.filename, current))) {
          throw appError("EXTERNAL_EDIT", "The note changed outside the editor.", {
            path: parsed.displayPath,
          })
        }
      },
    )
    return resultFromTarget(target, parsed.displayPath, bytes)
  })
  if (completed.warnings?.some(({ code }) => code === "LOCK_RELEASE_FAILED")) return completed
  const maintenanceWarnings = await maintainRecoveryRetention(
    workspace,
    input.recoveryTrash,
    input.recoveryPolicy,
    "save",
  )
  return resultWithWarnings(completed, [...(completed.warnings ?? []), ...maintenanceWarnings])
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
    manifest.sourceFile === "content.md" &&
    manifest.integrityFile === "integrity.sha256" &&
    typeof manifest.integrity === "string" &&
    /^[a-f0-9]{64}$/i.test(manifest.integrity)
  )
}

async function readRecoveryFile(
  directory: string,
  path: string,
  maximumBytes?: number,
): Promise<Buffer> {
  const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
  const before = await lstat(path, { bigint: true })
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (maximumBytes !== undefined && before.size > BigInt(maximumBytes))
  )
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  const canonical = await realpath(path)
  if (!isInside(directory, canonical))
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  const handle = await open(path, flags)
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      identity(before) !== identity(opened) ||
      (maximumBytes !== undefined && opened.size > BigInt(maximumBytes))
    )
      throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
    const content =
      maximumBytes === undefined
        ? await handle.readFile()
        : await readBoundedHandle(handle, maximumBytes)
    if (content === undefined) throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
    const after = await lstat(path, { bigint: true })
    const afterCanonical = await realpath(path)
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      identity(before) !== identity(after) ||
      identity(opened) !== identity(after) ||
      !pathsEqual(canonical, afterCanonical) ||
      !isInside(directory, afterCanonical)
    ) {
      throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
    }
    return content
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readRecoveryMetadata(
  workspace: string,
  root: string,
  key: Buffer,
  directoryName: string,
): Promise<RecoveryMetadata> {
  const retentionMatch = recoveryRetentionQuarantinePattern.exec(directoryName)
  const expectedId = recoveryIdPattern.test(directoryName) ? directoryName : retentionMatch?.[1]
  if (expectedId === undefined || !recoveryIdPattern.test(expectedId))
    throw appError("RECOVERY_INVALID", "The recovery identifier is invalid.")
  const directory = resolve(root, directoryName)
  if (!isInside(root, directory) || safeRelative(root, directory) !== directoryName)
    throw appError("RECOVERY_INVALID", "The recovery identifier is invalid.")
  let manifestBytes: Buffer
  let storedIntegrity: Buffer
  let directoryIdentityAtRead: DirectoryIdentity
  let directoryCanonical: string
  try {
    const directoryDetails = await lstat(directory, { bigint: true })
    directoryCanonical = await realpath(directory)
    if (
      directoryDetails.isSymbolicLink() ||
      !directoryDetails.isDirectory() ||
      !isInside(root, directoryCanonical)
    )
      throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
    directoryIdentityAtRead = directoryIdentity(directoryDetails)
  } catch (error) {
    if (isNoteError(error)) throw error
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw appError("RECOVERY_NOT_FOUND", "Recovery data was not found.")
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  try {
    for (const name of ["manifest.json", "content.md", "integrity.sha256"]) {
      const file = resolve(directory, name)
      const details = await lstat(file)
      if (
        details.isSymbolicLink() ||
        !details.isFile() ||
        !isInside(directory, await realpath(file))
      )
        throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
    }
    manifestBytes = await readRecoveryFile(
      directory,
      resolve(directory, "manifest.json"),
      maximumRecoveryManifestBytes,
    )
    storedIntegrity = await readRecoveryFile(
      directory,
      resolve(directory, "integrity.sha256"),
      maximumRecoveryIntegrityBytes,
    )
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
  if (
    !isManifest(manifest) ||
    manifest.id !== expectedId ||
    !sameIntegrity(
      manifest.integrity,
      manifestIntegrity(key, {
        version: manifest.version,
        id: manifest.id,
        originalPath: manifest.originalPath,
        createdAt: manifest.createdAt,
        contentHash: manifest.contentHash,
        mtimeMs: manifest.mtimeMs,
        sourceFile: manifest.sourceFile,
        integrityFile: manifest.integrityFile,
      }),
    ) ||
    !sameIntegrity(storedIntegrity.toString("utf8").trim(), manifest.integrity)
  )
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  try {
    parseManagedPath(workspace, manifest.originalPath)
    const after = await lstat(directory, { bigint: true })
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !sameDirectory(directoryIdentityAtRead, directoryIdentity(after)) ||
      !pathsEqual(directoryCanonical, await realpath(directory))
    ) {
      throw new Error("recovery directory changed")
    }
  } catch {
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  return {
    directory,
    directoryName,
    directoryIdentity: directoryIdentityAtRead,
    manifest,
  }
}

async function readRecovery(workspace: string, id: string): Promise<RecoveryEntry> {
  const root = await recoveryRoot(workspace, false)
  const key = await recoveryKey(dirname(root), false)
  const metadata = await readRecoveryMetadata(workspace, root, key, id)
  let bytes: Buffer
  try {
    bytes = await readRecoveryFile(metadata.directory, resolve(metadata.directory, "content.md"))
  } catch (error) {
    if (isNoteError(error)) throw error
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  if (hash(bytes) !== metadata.manifest.contentHash) {
    throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  return { ...metadata, bytes }
}

async function cleanupAbandonedRecoveryStaging(root: string, name: string): Promise<void> {
  if (!recoveryStagingPattern.test(name)) return
  const staging = resolve(root, name)
  if (!isInside(root, staging) || safeRelative(root, staging) !== name) return
  const before = await lstat(staging, { bigint: true }).catch(() => undefined)
  if (
    before === undefined ||
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    Date.now() - Number(before.mtimeMs) < abandonedRecoveryStagingAgeMs ||
    (process.platform !== "win32" && (Number(before.mode) & 0o777) !== 0o700)
  ) {
    return
  }
  const ownedIdentity = directoryIdentity(before)
  const quarantine = resolve(root, `.quarantine-${randomUUID()}`)
  await nodeRename(staging, quarantine).catch(() => undefined)
  const moved = await lstat(quarantine, { bigint: true }).catch(() => undefined)
  if (
    moved !== undefined &&
    !moved.isSymbolicLink() &&
    moved.isDirectory() &&
    sameDirectory(directoryIdentity(moved), ownedIdentity)
  ) {
    await rm(quarantine, { force: true, recursive: true }).catch(() => undefined)
  }
}

export async function listRecoveries(
  workspacePath: string,
  options: RecoveryListOptions = {},
): Promise<RecoveryListItem[]> {
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > maximumRecoveryListLimit)
  ) {
    throw invalidInput(".")
  }
  if (options.cursor !== undefined && !recoveryIdPattern.test(options.cursor)) {
    throw invalidInput(".")
  }
  const limit = options.limit ?? DEFAULT_RECOVERY_LIST_LIMIT
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
  for (const staging of ids.filter((id) => recoveryStagingPattern.test(id)).slice(0, 32)) {
    await cleanupAbandonedRecoveryStaging(root, staging).catch(() => undefined)
  }
  const entries: RecoveryListItem[] = []
  const candidates = ids
    .filter(
      (id) =>
        recoveryIdPattern.test(id) &&
        (options.cursor === undefined || id.localeCompare(options.cursor) < 0),
    )
    .sort()
    .reverse()
    .slice(0, limit)
  for (const id of candidates) {
    try {
      const { manifest } = await readRecovery(workspace, id)
      entries.push({
        id: manifest.id,
        originalPath: manifest.originalPath,
        createdAt: manifest.createdAt,
        contentHash: manifest.contentHash,
        revision: { mtimeMs: manifest.mtimeMs, contentHash: manifest.contentHash },
      })
    } catch {
      entries.push(recoveryIssue(id))
    }
  }
  return entries
}

export async function restoreRecovery(
  input: RestoreRecoveryInput,
  adapter: NoteFileAdapter = {},
): Promise<NoteWriteResult> {
  if (
    typeof input.recoveryTrash?.trashItem !== "function" ||
    !isValidRecoveryPolicy(input.recoveryPolicy)
  ) {
    throw invalidInput(".")
  }
  const workspace = await canonicalWorkspace(input.workspace)
  const entry = await readRecovery(workspace, input.id)
  const parsed = parseManagedPath(workspace, entry.manifest.originalPath)
  const root = await managedRoot(workspace, parsed.visibility)
  const lock = await acquireTargetLock(workspace, parsed.displayPath, adapter)
  const completed = await preserveOutcomeAcrossLockRelease(lock, "restore", async () => {
    const target = resolve(await checkedDomain(root, parsed.domain, false), parsed.filename)
    let current: CheckedFile | undefined
    const currentState = await readCheckedFileState(root, parsed.domain, parsed.filename)
    if (currentState.kind === "present") current = currentState.file
    if (current !== undefined) {
      if (
        current.revision.contentHash !== entry.manifest.contentHash &&
        current.revision.contentHash !== input.expectedCurrentHash
      ) {
        throw appError("RECOVERY_CONFLICT", "The note changed since this recovery was created.", {
          path: parsed.displayPath,
        })
      }
      await createRecovery(workspace, parsed.displayPath, current, adapter)
    }
    await writeTempAndReplace(
      target,
      parsed.displayPath,
      entry.bytes,
      current?.bytes,
      current?.mode,
      adapter,
      () => lock.assertOwned(),
      async () => {
        if (current === undefined) {
          const state = await readCheckedFileState(root, parsed.domain, parsed.filename)
          if (state.kind === "absent") return
          throw appError("RECOVERY_CONFLICT", "The note changed since this recovery was created.", {
            path: parsed.displayPath,
          })
        }
        if (!(await verifyUnchanged(root, parsed.domain, parsed.filename, current))) {
          throw appError("RECOVERY_CONFLICT", "The note changed since this recovery was created.", {
            path: parsed.displayPath,
          })
        }
      },
    )
    return resultFromTarget(target, parsed.displayPath, entry.bytes)
  })
  if (completed.warnings?.some(({ code }) => code === "LOCK_RELEASE_FAILED")) return completed
  const maintenanceWarnings = await maintainRecoveryRetention(
    workspace,
    input.recoveryTrash,
    input.recoveryPolicy,
    "restore",
  )
  return resultWithWarnings(completed, [...(completed.warnings ?? []), ...maintenanceWarnings])
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
