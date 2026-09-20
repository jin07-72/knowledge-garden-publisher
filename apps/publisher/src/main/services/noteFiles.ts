import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto"
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
const recoveryKeyDirectory = "keys"
const recoveryKeyName = "recovery-hmac.key"

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
  readonly syncDirectory?: (path: string) => Promise<void>
  readonly beforeTempWrite?: (path: string) => Promise<void> | void
  readonly beforeTempSync?: (path: string) => Promise<void> | void
  readonly beforeCommit?: (temporaryPath: string) => Promise<void> | void
  readonly beforeReplace?: (path: string) => Promise<void> | void
  readonly afterReplace?: (path: string) => Promise<void> | void
  readonly beforeKeyPublish?: () => Promise<void> | void
  readonly beforeLockMetadataPublish?: (lockDirectory: string) => Promise<void> | void
  readonly afterLockHeartbeat?: (lockDirectory: string) => Promise<void> | void
  readonly beforeLockRelease?: (lockDirectory: string) => Promise<void> | void
  readonly now?: () => number
  readonly delay?: (milliseconds: number) => Promise<void>
  readonly isProcessAlive?: (pid: number) => boolean | undefined
  readonly lockLeaseMs?: number
  readonly lockWaitMs?: number
  readonly lockGraceMs?: number
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

interface TargetLock {
  assertOwned(): Promise<void>
  release(): Promise<void>
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
      identity: identity(opened),
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
  if (before.isSymbolicLink() || !before.isFile())
    throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
  const canonical = await realpath(path)
  if (!isInside(keysDirectory, canonical))
    throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
  const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
  const handle = await open(path, flags)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || identity(before) !== identity(opened))
      throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
    if (process.platform !== "win32" && (Number(opened.mode) & 0o777) !== 0o600) {
      throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
    }
    const key = await handle.readFile()
    const after = await lstat(path, { bigint: true })
    if (
      after.isSymbolicLink() ||
      identity(before) !== identity(after) ||
      !pathsEqual(canonical, await realpath(path))
    ) {
      throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
    }
    if (key.length !== 32) throw appError("RECOVERY_INVALID", "Recovery key is invalid.")
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

async function restoreQuarantine(quarantine: string, candidate: string): Promise<void> {
  try {
    await lstat(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await nodeRename(quarantine, candidate).catch(() => undefined)
    }
  }
}

async function acquireLease(
  candidate: string,
  parent: string,
  adapter: NoteFileAdapter,
  ownershipError: () => AppError,
): Promise<TargetLock | undefined> {
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
      await restoreQuarantine(quarantine, candidate)
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

  async function stillOwned(): Promise<boolean> {
    const current = await inspectLockDirectory(candidate, parent)
    return (
      current.kind === "present" &&
      sameDirectory(identityAtAcquisition, current.identity) &&
      current.owner?.token === token
    )
  }

  async function assertOwned(): Promise<void> {
    await heartbeatWork.catch(() => undefined)
    if (lostOwnership || !(await stillOwned())) {
      lostOwnership = true
      throw ownershipError()
    }
  }

  let heartbeatWork = Promise.resolve()
  const heartbeat = setInterval(
    () => {
      heartbeatWork = heartbeatWork.then(async () => {
        if (stopped) return
        if (!(await stillOwned())) {
          lostOwnership = true
          return
        }
        const heartbeatAt = leaseNow(adapter)
        try {
          await publishLeaseFile(candidate, leaseHeartbeatName, {
            version: 1,
            token,
            heartbeatAt,
            leaseExpiresAt: heartbeatAt + leaseMs,
          })
          await adapter.afterLockHeartbeat?.(candidate)
          if (!(await stillOwned())) lostOwnership = true
        } catch {
          lostOwnership = true
        }
      })
    },
    Math.max(1, Math.floor(leaseMs / 3)),
  )
  heartbeat.unref()

  return {
    assertOwned,
    async release(): Promise<void> {
      stopped = true
      clearInterval(heartbeat)
      await heartbeatWork.catch(() => undefined)
      try {
        await adapter.beforeLockRelease?.(candidate)
      } catch {
        throw ownershipError()
      }
      const quarantine = `${candidate}.release-${token}-${randomUUID()}`
      try {
        await nodeRename(candidate, quarantine)
      } catch (error) {
        throw ownershipError()
      }
      const moved = await inspectLockDirectory(quarantine, parent)
      if (
        moved.kind === "present" &&
        sameDirectory(identityAtAcquisition, moved.identity) &&
        moved.owner?.token === token
      ) {
        try {
          await rm(quarantine, { force: true, recursive: true })
        } catch {
          throw ownershipError()
        }
        return
      }
      await restoreQuarantine(quarantine, candidate)
      throw ownershipError()
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
  let lock: TargetLock | undefined
  while (lock === undefined) {
    try {
      lock = await acquireLease(initializationLock, keys, adapter, () =>
        appError("RECOVERY_INVALID", "Recovery key initializer ownership was lost."),
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
    await lock.assertOwned()
    await nodeRename(temporary, path)
  } catch {
    throw appError("RECOVERY_INVALID", "Recovery key could not be initialized.")
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    await lock.release()
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
    const lock = await acquireLease(candidate, locks, adapter, () =>
      appError("NOTE_FILE_LOCKED", "The note lock is no longer owned.", { path }),
    )
    if (lock !== undefined) return lock
  } catch {
    throw accessFailure(path)
  }
  throw appError("NOTE_FILE_LOCKED", "The note is being saved by another process.", { path })
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

async function createRecovery(
  workspace: string,
  originalPath: string,
  checked: CheckedFile,
  adapter: NoteFileAdapter = {},
): Promise<RecoverySummary> {
  const root = await recoveryRoot(workspace, true)
  const key = await recoveryKey(dirname(root), true, adapter)
  const id = `${Date.now()}-${randomUUID()}`
  const directory = resolve(root, id)
  const manifestData: Omit<RecoveryManifest, "integrity"> = {
    version: 1,
    id,
    originalPath,
    createdAt: new Date().toISOString(),
    contentHash: checked.revision.contentHash,
    mtimeMs: checked.revision.mtimeMs,
    sourceFile: "content.md",
    integrityFile: "integrity.sha256",
  }
  const manifest: RecoveryManifest = {
    ...manifestData,
    integrity: manifestIntegrity(key, manifestData),
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
    await writeFile(resolve(directory, manifest.integrityFile), `${manifest.integrity}\n`, {
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

interface SafeFileContents {
  readonly bytes: Buffer
  readonly identity: string
  readonly mode: number
}

async function readContainedRegularFile(
  path: string,
  parent: string,
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
    const bytes = await handle.readFile()
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

export async function createNote(input: CreateNoteInput): Promise<NoteWriteResult> {
  assertMetadata(input)
  const workspace = await canonicalWorkspace(input.workspace)
  const root = await managedRoot(workspace, input.visibility)
  const directory = await checkedDomain(root, input.domain, true)
  const path = `${root.name}/${input.domain}/${input.slug}.md`
  const target = resolve(directory, `${input.slug}.md`)
  const bytes = Buffer.from(markdownFor(input), "utf8")
  await exclusiveWrite(target, bytes, path)
  return resultFromTarget(target, path, bytes)
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
  const lock = await acquireTargetLock(workspace, parsed.displayPath, adapter)
  try {
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
    if (!input.expectedContentHash || !/^[a-f0-9]{64}$/i.test(input.expectedContentHash)) {
      throw invalidPath(parsed.displayPath)
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
  } finally {
    await lock.release()
  }
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

async function readRecovery(workspace: string, id: string): Promise<RecoveryEntry> {
  if (!recoveryIdPattern.test(id))
    throw appError("RECOVERY_INVALID", "The recovery identifier is invalid.")
  const root = await recoveryRoot(workspace, false)
  const key = await recoveryKey(dirname(root), false)
  const directory = resolve(root, id)
  if (!isInside(root, directory) || safeRelative(root, directory) !== id)
    throw appError("RECOVERY_INVALID", "The recovery identifier is invalid.")
  let manifestBytes: Buffer
  let bytes: Buffer
  let storedIntegrity: Buffer
  async function readRecoveryFile(path: string): Promise<Buffer> {
    const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
    const before = await lstat(path, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile())
      throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
    const canonical = await realpath(path)
    if (!isInside(directory, canonical))
      throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
    const handle = await open(path, flags)
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || identity(before) !== identity(opened))
        throw appError("RECOVERY_INVALID", "Recovery data is invalid.")
      const content = await handle.readFile()
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
    manifestBytes = await readRecoveryFile(resolve(directory, "manifest.json"))
    bytes = await readRecoveryFile(resolve(directory, "content.md"))
    storedIntegrity = await readRecoveryFile(resolve(directory, "integrity.sha256"))
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
    manifest.id !== id ||
    hash(bytes) !== manifest.contentHash ||
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
  const lock = await acquireTargetLock(workspace, parsed.displayPath, adapter)
  try {
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
          try {
            await readCheckedFile(root, parsed.domain, parsed.filename)
          } catch {
            return
          }
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
  } finally {
    await lock.release()
  }
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
