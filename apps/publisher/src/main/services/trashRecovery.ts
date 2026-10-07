import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import type { BigIntStats } from "node:fs"
import {
  lstat,
  link,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import {
  captureNoteDomainSnapshot,
  revalidateNoteDomains,
  type NoteDomainSnapshot,
} from "./noteDomains"

const journalVersion = 1
const recoveryDirectory = ".garden-publisher/trash-recovery"
const transactionPattern = /^[a-f0-9-]{36}$/i
const notePattern = /^(content|private)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const attachmentPattern = /^(content|private)\/_assets\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const digestPattern = /^[a-f0-9]{64}$/
const maximumDirectoryEntries = 10_000
const maximumDirectoryBytes = 512 * 1024 * 1024
const maximumAttachmentBytes = 64 * 1024 * 1024
const maximumDirectoryDepth = 64
const recoveryTransactionsPerPass = 64
const recoveryJournalBytesPerPass = 512 * 1024
const recoveryElapsedMsPerPass = 250
const recoveryTransactionsDirectory = "transactions"
const indexedTransactionsDirectory = "indexed-transactions"
const recoveryCursorName = "cursor.json"
const legacyRecoveryQueueName = "pending.jsonl"
const recoveryQueueDirectory = "queue"
const recoveryQueueSegmentBytes = 1024 * 1024
const recoveryQueueRecordBytes = 512
const recoveryQueueSegmentPattern = /^[a-f0-9]{16}\.log$/
const recoveryQueueLeaseBytes = 1024
const recoveryQueueLeaseMs = 60_000
const recoveryQueueLeaseWaitMs = 2_000
const recoveryCursorVersion = 1
const shardPattern = /^[a-f0-9]{2}$/
const recoveryDirectoryEntriesPerPass = 1_024

interface DirectoryHandleLike {
  readonly [Symbol.asyncIterator]: () => AsyncIterator<{ readonly name: string }>
  close(): Promise<void>
}

type DirectoryOpener = (path: string) => Promise<DirectoryHandleLike>
type RecoveryFileOpener = (
  path: string,
  flags: string | number,
  mode?: number,
) => ReturnType<typeof open>

interface RecoveryCursorPayload {
  readonly version: 1
  readonly queueSegment?: number
  readonly queueOffset?: number
  readonly migrationLocation?: number
  readonly migrationOffset?: number
  readonly migrationDirectoryIdentity?: string
  readonly migrationDirectoryMtimeNs?: string
  readonly migrationComplete?: boolean
}

interface RecoveryCursorFile extends RecoveryCursorPayload {
  readonly integrity: string
}

interface RecoveryTraversalControl {
  readonly signal?: AbortSignal
  readonly deadline?: number
  readonly now?: () => number
}

class RecoveryPassDeferred extends Error {}

function assertRecoveryActive(control?: RecoveryTraversalControl): void {
  if (
    control?.signal?.aborted ||
    (control?.deadline !== undefined && (control.now ?? Date.now)() >= control.deadline)
  ) {
    throw new RecoveryPassDeferred("Trash recovery pass was deferred.")
  }
}

export async function readBoundedDirectoryNames(
  path: string,
  maximumEntries: number,
  openDirectory: DirectoryOpener = opendir,
  control?: RecoveryTraversalControl,
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
    throw new Error("Directory entry limit is invalid.")
  }
  const handle = await openDirectory(path)
  const names: string[] = []
  try {
    for await (const entry of handle) {
      assertRecoveryActive(control)
      names.push(entry.name)
      if (names.length > maximumEntries) throw new Error("Directory has too many entries.")
    }
  } finally {
    await handle.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ERR_DIR_CLOSED") throw error
    })
  }
  return names.sort()
}

export interface TrashRecoveryStage {
  readonly id: string
  readonly workspace: string
  readonly originalPath: string
  readonly originalRelativePath: string
  readonly stagedPath: string
  readonly transactionPath: string
  readonly kind: "file" | "directory"
  readonly expectedIdentity: string
  readonly expectedContentHash: string
}

interface TrashRecoveryJournal {
  readonly version: 1
  readonly id: string
  readonly kind: "file" | "directory"
  readonly originalRelativePath: string
  readonly stagedRelativePath: string
  readonly expectedIdentity: string
  readonly expectedContentHash: string
  readonly integrity: string
}

type UnsignedTrashRecoveryJournal = Omit<TrashRecoveryJournal, "integrity">

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child)
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent))
}

function validRelativePath(path: string, kind: TrashRecoveryStage["kind"]): boolean {
  return (kind === "file" ? notePattern : attachmentPattern).test(path)
}

function canonicalJournal(journal: UnsignedTrashRecoveryJournal): string {
  return JSON.stringify({
    version: journal.version,
    id: journal.id,
    kind: journal.kind,
    originalRelativePath: journal.originalRelativePath,
    stagedRelativePath: journal.stagedRelativePath,
    expectedIdentity: journal.expectedIdentity,
    expectedContentHash: journal.expectedContentHash,
  })
}

function journalIntegrity(key: Buffer, journal: UnsignedTrashRecoveryJournal): string {
  return createHmac("sha256", key)
    .update("garden-publisher/trash-recovery/journal/v1\0")
    .update(canonicalJournal(journal))
    .digest("hex")
}

function queueIntegrity(key: Buffer, id: string): string {
  return createHmac("sha256", key)
    .update("garden-publisher/trash-recovery/queue/v1\0")
    .update(id)
    .digest("hex")
}

function queueSegmentSequence(name: string): number | undefined {
  if (!recoveryQueueSegmentPattern.test(name)) return undefined
  const sequence = Number.parseInt(name.slice(0, 16), 16)
  return Number.isSafeInteger(sequence) ? sequence : undefined
}

interface RecoveryQueueLease {
  readonly version: 1
  readonly token: string
  readonly pid: number
  readonly createdAt: number
  readonly leaseExpiresAt: number
}

interface RecoveryQueueLeaseInspection {
  readonly kind: "present"
  readonly identity: string
  readonly fingerprint: string
  readonly observedAt: number
  readonly owner?: RecoveryQueueLease
  readonly legacyPid?: number
}

function isRecoveryQueueLease(value: unknown): value is RecoveryQueueLease {
  if (typeof value !== "object" || value === null) return false
  const lease = value as Partial<RecoveryQueueLease>
  return (
    lease.version === 1 &&
    typeof lease.token === "string" &&
    /^[a-f0-9-]{16,128}$/i.test(lease.token) &&
    typeof lease.pid === "number" &&
    Number.isSafeInteger(lease.pid) &&
    lease.pid > 0 &&
    typeof lease.createdAt === "number" &&
    Number.isFinite(lease.createdAt) &&
    typeof lease.leaseExpiresAt === "number" &&
    Number.isFinite(lease.leaseExpiresAt) &&
    lease.createdAt < lease.leaseExpiresAt
  )
}

function recoveryProcessLiveness(
  options: TrashRecoveryPrepareOptions,
  pid: number,
): boolean | undefined {
  if (options.isProcessAlive !== undefined) {
    try {
      return options.isProcessAlive(pid)
    } catch {
      return undefined
    }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined
  }
}

async function inspectRecoveryQueueLease(
  path: string,
  directory: string,
  openFile: RecoveryFileOpener,
): Promise<RecoveryQueueLeaseInspection | { readonly kind: "missing" | "unsafe" }> {
  let handle
  try {
    handle = await openFile(
      path,
      process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    const [opened, pathDetails, canonical] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ])
    if (
      !opened.isFile() ||
      pathDetails.isSymbolicLink() ||
      !pathDetails.isFile() ||
      stableIdentity(opened) !== stableIdentity(pathDetails) ||
      !pathsEqual(canonical, path) ||
      !isInside(directory, path)
    ) {
      return { kind: "unsafe" }
    }
    const size = Number(opened.size)
    let bytes = Buffer.alloc(0)
    if (Number.isSafeInteger(size) && size >= 0 && size <= recoveryQueueLeaseBytes) {
      bytes = Buffer.alloc(size)
      let read = 0
      while (read < size) {
        const result = await handle.read(bytes, read, size - read, read)
        if (result.bytesRead === 0) return { kind: "unsafe" }
        read += result.bytesRead
      }
    }
    const [openedAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ])
    if (
      stableIdentity(openedAfter) !== stableIdentity(opened) ||
      stableIdentity(pathAfter) !== stableIdentity(opened) ||
      openedAfter.size !== opened.size
    ) {
      return { kind: "unsafe" }
    }
    let owner: RecoveryQueueLease | undefined
    let legacyPid: number | undefined
    if (bytes.length > 0) {
      try {
        const value: unknown = JSON.parse(bytes.toString("utf8"))
        if (isRecoveryQueueLease(value)) owner = value
        else if (Number.isSafeInteger(value) && Number(value) > 0) legacyPid = Number(value)
      } catch {
        // Invalid metadata is reclaimable only after the conservative file-age timeout.
      }
    }
    return {
      kind: "present",
      identity: stableIdentity(opened),
      fingerprint:
        size <= recoveryQueueLeaseBytes
          ? createHash("sha256").update(bytes).digest("hex")
          : `oversize:${size}`,
      observedAt: Math.max(
        Number(opened.birthtimeMs),
        Number(opened.ctimeMs),
        Number(opened.mtimeMs),
      ),
      owner,
      legacyPid,
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unsafe" }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function recoveryQueueLeaseIsStale(
  inspection: RecoveryQueueLeaseInspection,
  options: TrashRecoveryPrepareOptions,
  leaseMs: number,
): boolean {
  const now = (options.now ?? Date.now)()
  const expiresAt = inspection.owner?.leaseExpiresAt ?? inspection.observedAt + leaseMs
  if (now < expiresAt) return false
  const pid = inspection.owner?.pid ?? inspection.legacyPid
  return pid === undefined || recoveryProcessLiveness(options, pid) === false
}

function recoveryQueueReclaimPrefix(identity: string): string {
  return `.append.reclaim-${createHash("sha256").update(identity).digest("hex")}-`
}

function recoveryQueueReclaimGeneration(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix) || !name.endsWith(".claim")) return undefined
  const encoded = name.slice(prefix.length, -".claim".length)
  if (!/^[a-f0-9]{8}$/.test(encoded)) return undefined
  const generation = Number.parseInt(encoded, 16)
  return Number.isSafeInteger(generation) ? generation : undefined
}

async function hasRecoveryQueueReclaimClaim(directory: string, identity: string): Promise<boolean> {
  const prefix = recoveryQueueReclaimPrefix(identity)
  return (await readBoundedDirectoryNames(directory, 10_000)).some(
    (name) => recoveryQueueReclaimGeneration(name, prefix) !== undefined,
  )
}

async function electRecoveryQueueReclaimer(
  directory: string,
  leaseIdentity: string,
  options: TrashRecoveryPrepareOptions,
  openFile: RecoveryFileOpener,
  leaseMs: number,
): Promise<readonly string[] | undefined> {
  const prefix = recoveryQueueReclaimPrefix(leaseIdentity)
  const generations = (await readBoundedDirectoryNames(directory, 10_000))
    .map((name) => ({ name, generation: recoveryQueueReclaimGeneration(name, prefix) }))
    .filter(
      (entry): entry is { readonly name: string; readonly generation: number } =>
        entry.generation !== undefined,
    )
    .sort((left, right) => left.generation - right.generation)
  const latest = generations.at(-1)
  if (latest !== undefined) {
    const latestClaim = await inspectRecoveryQueueLease(
      resolve(directory, latest.name),
      directory,
      openFile,
    )
    if (
      latestClaim.kind !== "present" ||
      !recoveryQueueLeaseIsStale(latestClaim, options, leaseMs)
    ) {
      return undefined
    }
  }
  const generation = (latest?.generation ?? -1) + 1
  if (generation > 0xffff_ffff) return undefined
  const token = randomUUID()
  const createdAt = (options.now ?? Date.now)()
  const claim = resolve(directory, `${prefix}${generation.toString(16).padStart(8, "0")}.claim`)
  const candidate = resolve(directory, `.append.reclaim-candidate-${token}`)
  let handle
  try {
    handle = await openFile(
      candidate,
      process.platform === "win32"
        ? "wx"
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(
      JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        createdAt,
        leaseExpiresAt: createdAt + leaseMs,
      } satisfies RecoveryQueueLease),
    )
    await handle.sync()
    const candidateDetails = await handle.stat({ bigint: true })
    if (!candidateDetails.isFile()) return undefined
    const candidateIdentity = stableIdentity(candidateDetails)
    await handle.close()
    handle = undefined
    try {
      await link(candidate, claim)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined
      throw error
    }
    const published = await inspectRecoveryQueueLease(claim, directory, openFile)
    if (
      published.kind !== "present" ||
      published.identity !== candidateIdentity ||
      published.owner?.token !== token
    ) {
      return undefined
    }
    await unlink(candidate)
    await syncRecoveryDirectory(directory, openFile)
    return [...generations.map((entry) => resolve(directory, entry.name)), claim]
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

async function reclaimStaleRecoveryQueueLease(
  lease: string,
  directory: string,
  options: TrashRecoveryPrepareOptions,
  openFile: RecoveryFileOpener,
  leaseMs: number,
): Promise<boolean> {
  const observed = await inspectRecoveryQueueLease(lease, directory, openFile)
  if (observed.kind === "missing") return true
  if (observed.kind !== "present" || !recoveryQueueLeaseIsStale(observed, options, leaseMs)) {
    return false
  }
  const revalidated = await inspectRecoveryQueueLease(lease, directory, openFile)
  if (
    revalidated.kind !== "present" ||
    revalidated.identity !== observed.identity ||
    revalidated.fingerprint !== observed.fingerprint ||
    !recoveryQueueLeaseIsStale(revalidated, options, leaseMs)
  ) {
    return revalidated.kind === "missing"
  }
  const reclaimClaims = await electRecoveryQueueReclaimer(
    directory,
    revalidated.identity,
    options,
    openFile,
    leaseMs,
  )
  if (reclaimClaims === undefined) return false
  const elected = await inspectRecoveryQueueLease(lease, directory, openFile)
  let reclaimed = elected.kind === "missing"
  if (
    elected.kind === "present" &&
    elected.identity === revalidated.identity &&
    elected.fingerprint === revalidated.fingerprint &&
    recoveryQueueLeaseIsStale(elected, options, leaseMs)
  ) {
    await unlink(lease)
    reclaimed = true
  }
  // Older generations are removed first. The elected generation remains the
  // barrier until the identity-bound action and every prior cleanup completes.
  for (const claim of reclaimClaims) {
    await unlink(claim).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  await syncRecoveryDirectory(directory, openFile)
  return reclaimed
}

async function syncRecoveryDirectory(
  path: string,
  openFile: RecoveryFileOpener = open,
): Promise<void> {
  const handle = await openFile(path, "r")
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (
        process.platform !== "win32" ||
        (error.code !== "EPERM" && error.code !== "EINVAL" && error.code !== "ENOTSUP")
      ) {
        throw error
      }
    })
  } finally {
    await handle.close()
  }
}

async function createRecoveryDirectory(
  path: string,
  parent: string,
  openFile: RecoveryFileOpener,
): Promise<void> {
  let created = false
  await mkdir(path, { mode: 0o700 })
    .then(() => {
      created = true
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
  if (created) await syncRecoveryDirectory(parent, openFile)
}

async function appendRecoveryQueue(
  root: string,
  id: string,
  key: Buffer,
  options: TrashRecoveryPrepareOptions = {},
): Promise<void> {
  const openFile = options.openFile ?? open
  const record = Buffer.from(
    `${JSON.stringify({ version: 1, id, integrity: queueIntegrity(key, id) })}\n`,
    "utf8",
  )
  if (record.length > recoveryQueueRecordBytes) {
    throw new Error("Trash recovery queue record is too large.")
  }
  const directory = resolve(root, recoveryQueueDirectory)
  await createRecoveryDirectory(directory, root, openFile)
  const directoryDetails = await lstat(directory)
  if (
    directoryDetails.isSymbolicLink() ||
    !directoryDetails.isDirectory() ||
    !pathsEqual(await realpath(directory), directory) ||
    !isInside(root, directory)
  ) {
    throw new Error("Trash recovery queue is unsafe.")
  }
  const lease = resolve(directory, ".append.lock")
  const leaseMs = Math.max(1, options.appendLeaseMs ?? recoveryQueueLeaseMs)
  const waitMs = Math.max(1, options.appendLeaseWaitMs ?? recoveryQueueLeaseWaitMs)
  const now = options.now ?? Date.now
  const delay =
    options.delay ??
    ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)))
  const token = randomUUID()
  const createdAt = now()
  const leaseBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      token,
      pid: process.pid,
      createdAt,
      leaseExpiresAt: createdAt + leaseMs,
    } satisfies RecoveryQueueLease),
    "utf8",
  )
  const candidate = resolve(directory, `.append.candidate-${token}`)
  let leaseIdentity: string | undefined
  let candidateHandle
  try {
    candidateHandle = await openFile(
      candidate,
      process.platform === "win32"
        ? "wx"
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await candidateHandle.writeFile(leaseBytes)
    await candidateHandle.sync()
    const candidateDetails = await candidateHandle.stat({ bigint: true })
    if (!candidateDetails.isFile()) throw new Error("Trash recovery queue lease is unsafe.")
    const candidateIdentity = stableIdentity(candidateDetails)
    await candidateHandle.close()
    candidateHandle = undefined
    if (await hasRecoveryQueueReclaimClaim(directory, candidateIdentity)) {
      throw Object.assign(new Error("Trash recovery queue reclaim is in progress."), {
        code: "EAGAIN",
      })
    }
    const deadline = createdAt + waitMs
    for (;;) {
      try {
        await link(candidate, lease)
        leaseIdentity = candidateIdentity
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        if (await reclaimStaleRecoveryQueueLease(lease, directory, options, openFile, leaseMs)) {
          continue
        }
        if (now() >= deadline) throw error
        await delay(10)
      }
    }
    const acquired = await inspectRecoveryQueueLease(lease, directory, openFile)
    if (
      acquired.kind !== "present" ||
      acquired.identity !== leaseIdentity ||
      acquired.owner?.token !== token
    ) {
      throw new Error("Trash recovery queue lease is unsafe.")
    }
    if (await hasRecoveryQueueReclaimClaim(directory, candidateIdentity)) {
      await unlink(lease)
      leaseIdentity = undefined
      throw Object.assign(new Error("Trash recovery queue reclaim won publication."), {
        code: "EAGAIN",
      })
    }
    await unlink(candidate)
    const names = await readBoundedDirectoryNames(directory, 10_000)
    const segments = names
      .map((name) => ({ name, sequence: queueSegmentSequence(name) }))
      .filter((entry): entry is { name: string; sequence: number } => entry.sequence !== undefined)
      .sort((left, right) => left.sequence - right.sequence)
    let sequence = segments.at(-1)?.sequence ?? 0
    let path = resolve(directory, `${sequence.toString(16).padStart(16, "0")}.log`)
    let created = !segments.some((entry) => entry.name === path.split(/[\\/]/).at(-1)!)
    let handle = await openFile(
      path,
      process.platform === "win32"
        ? created
          ? "wx+"
          : "r+"
        : constants.O_RDWR |
            constants.O_NOFOLLOW |
            (created ? constants.O_CREAT | constants.O_EXCL : 0),
      0o600,
    )
    try {
      let details = await handle.stat({ bigint: true })
      let pathDetails = await lstat(path, { bigint: true })
      if (
        !details.isFile() ||
        pathDetails.isSymbolicLink() ||
        !pathDetails.isFile() ||
        stableIdentity(details) !== stableIdentity(pathDetails) ||
        !pathsEqual(await realpath(path), path) ||
        !isInside(directory, path)
      ) {
        throw new Error("Trash recovery queue is unsafe.")
      }
      let size = Number(details.size)
      if (size <= recoveryQueueSegmentBytes) {
        const existing = Buffer.alloc(size)
        if (size > 0) await handle.read(existing, 0, size, 0)
        const newline = existing.lastIndexOf(0x0a)
        const repaired = newline < 0 ? 0 : newline + 1
        if (repaired !== size) {
          await handle.truncate(repaired)
          size = repaired
        }
      }
      if (size > recoveryQueueSegmentBytes || size + record.length > recoveryQueueSegmentBytes) {
        await handle.close()
        sequence += 1
        path = resolve(directory, `${sequence.toString(16).padStart(16, "0")}.log`)
        created = true
        handle = await openFile(
          path,
          process.platform === "win32"
            ? "wx+"
            : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        size = 0
        details = await handle.stat({ bigint: true })
        pathDetails = await lstat(path, { bigint: true })
        if (
          !details.isFile() ||
          pathDetails.isSymbolicLink() ||
          !pathDetails.isFile() ||
          stableIdentity(details) !== stableIdentity(pathDetails) ||
          !pathsEqual(await realpath(path), path) ||
          !isInside(directory, path)
        ) {
          throw new Error("Trash recovery queue is unsafe.")
        }
      }
      let written = 0
      while (written < record.length) {
        const result = await handle.write(record, written, record.length - written, size + written)
        if (result.bytesWritten === 0) throw new Error("Trash recovery queue write stalled.")
        written += result.bytesWritten
      }
      await handle.sync()
    } finally {
      await handle.close().catch(() => undefined)
    }
    if (created) {
      await syncRecoveryDirectory(directory, openFile)
    }
  } finally {
    await candidateHandle?.close().catch(() => undefined)
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    if (leaseIdentity !== undefined) {
      try {
        const current = await inspectRecoveryQueueLease(lease, directory, openFile)
        if (
          current.kind === "present" &&
          current.identity === leaseIdentity &&
          current.owner?.token === token
        ) {
          await unlink(lease)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
  }
}

function sameIntegrity(left: string, right: string): boolean {
  if (!digestPattern.test(left) || !digestPattern.test(right)) return false
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

async function directoryDigest(root: string, control?: RecoveryTraversalControl): Promise<string> {
  let entries = 0
  let totalBytes = 0
  const output = createHash("sha256")
  const rootBefore = await lstat(root, { bigint: true })
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
    throw new Error("Attachment recovery root is unsafe.")
  }
  const rootCanonical = await realpath(root)
  if (!pathsEqual(rootCanonical, root)) throw new Error("Attachment recovery tree is unsafe.")

  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    assertRecoveryActive(control)
    if (depth > maximumDirectoryDepth) throw new Error("Attachment recovery tree is too deep.")
    const before = await readBoundedDirectoryNames(
      directory,
      maximumDirectoryEntries - entries,
      opendir,
      control,
    )
    entries += before.length
    for (const name of before) {
      assertRecoveryActive(control)
      const path = resolve(directory, name)
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`
      if (Buffer.byteLength(relativePath, "utf8") > 4_096)
        throw new Error("Attachment recovery path is too long.")
      const details = await lstat(path, { bigint: true })
      if (details.isSymbolicLink()) throw new Error("Attachment recovery tree contains a link.")
      if (!pathsEqual(await realpath(path), path) || !isInside(rootCanonical, path)) {
        throw new Error("Attachment recovery tree escaped its root.")
      }
      if (details.isDirectory()) {
        output.update(`D\0${relativePath}\0`)
        await visit(path, relativePath, depth + 1)
        const directoryAfter = await lstat(path, { bigint: true })
        if (
          stableIdentity(directoryAfter) !== stableIdentity(details) ||
          directoryAfter.mtimeNs !== details.mtimeNs
        ) {
          throw new Error("Attachment recovery directory changed while hashing.")
        }
        continue
      }
      if (!details.isFile()) throw new Error("Attachment recovery tree contains a special file.")
      const size = Number(details.size)
      if (!Number.isSafeInteger(size) || size > maximumAttachmentBytes)
        throw new Error("Attachment recovery file is too large.")
      totalBytes += size
      if (totalBytes > maximumDirectoryBytes)
        throw new Error("Attachment recovery tree is too large.")
      const handle = await open(
        path,
        process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        const opened = await handle.stat({ bigint: true })
        if (
          !opened.isFile() ||
          stableIdentity(opened) !== stableIdentity(details) ||
          opened.size !== details.size
        ) {
          throw new Error("Attachment recovery file changed while hashing.")
        }
        const content = createHash("sha256")
        const buffer = Buffer.allocUnsafe(64 * 1024)
        let offset = 0
        while (offset < size) {
          assertRecoveryActive(control)
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, size - offset),
            offset,
          )
          if (bytesRead === 0) throw new Error("Attachment recovery file was truncated.")
          content.update(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
        const after = await handle.stat({ bigint: true })
        if (
          stableIdentity(after) !== stableIdentity(details) ||
          after.size !== details.size ||
          after.mtimeNs !== details.mtimeNs
        ) {
          throw new Error("Attachment recovery file changed while hashing.")
        }
        output.update(`F\0${relativePath}\0${size}\0${content.digest("hex")}\0`)
      } finally {
        await handle.close()
      }
    }
    const after = await readBoundedDirectoryNames(directory, before.length, opendir, control)
    if (before.length !== after.length || before.some((name, index) => name !== after[index])) {
      throw new Error("Attachment recovery directory changed while hashing.")
    }
  }

  await visit(root, "", 0)
  const rootAfter = await lstat(root, { bigint: true })
  if (
    stableIdentity(rootAfter) !== stableIdentity(rootBefore) ||
    rootAfter.mtimeNs !== rootBefore.mtimeNs
  ) {
    throw new Error("Attachment recovery root changed while hashing.")
  }
  return output.digest("hex")
}

async function safeRecoveryRoot(
  workspaceInput: string,
  create: boolean,
  openFile: RecoveryFileOpener = open,
): Promise<{ workspace: string; root: string }> {
  const workspace = await realpath(resolve(workspaceInput))
  const state = resolve(workspace, ".garden-publisher")
  const root = resolve(workspace, recoveryDirectory)
  if (create) {
    await createRecoveryDirectory(state, workspace, openFile)
  }
  const [stateDetails, canonicalState] = await Promise.all([lstat(state), realpath(state)])
  if (
    stateDetails.isSymbolicLink() ||
    !stateDetails.isDirectory() ||
    !pathsEqual(canonicalState, state) ||
    !isInside(workspace, state)
  ) {
    throw new Error("Trash recovery storage is unsafe.")
  }
  if (create) {
    await createRecoveryDirectory(root, state, openFile)
  }
  const [rootDetails, canonicalRoot] = await Promise.all([lstat(root), realpath(root)])
  if (
    rootDetails.isSymbolicLink() ||
    !rootDetails.isDirectory() ||
    !pathsEqual(canonicalRoot, root) ||
    !isInside(workspace, root)
  ) {
    throw new Error("Trash recovery storage is unsafe.")
  }
  return { workspace, root }
}

export interface TrashRecoveryPrepareOptions {
  readonly openFile?: RecoveryFileOpener
  readonly appendLeaseMs?: number
  readonly appendLeaseWaitMs?: number
  readonly delay?: (milliseconds: number) => Promise<void>
  readonly isProcessAlive?: (pid: number) => boolean | undefined
  readonly now?: () => number
  readonly domainSnapshot?: NoteDomainSnapshot
}

export async function prepareTrashRecovery(
  workspaceInput: string,
  originalPathInput: string,
  originalRelativePath: string,
  kind: TrashRecoveryStage["kind"],
  expectedIdentity: string,
  expectedContentHash: string | undefined,
  key: Buffer,
  options: TrashRecoveryPrepareOptions = {},
): Promise<TrashRecoveryStage> {
  const openFile = options.openFile ?? open
  const { workspace, root } = await safeRecoveryRoot(workspaceInput, true, openFile)
  const normalized = originalRelativePath.replaceAll("\\", "/")
  const originalPath = resolve(originalPathInput)
  if (
    !validRelativePath(normalized, kind) ||
    !pathsEqual(resolve(workspace, ...normalized.split("/")), originalPath) ||
    !isInside(workspace, originalPath) ||
    !/^\d+:\d+:\d+$/.test(expectedIdentity) ||
    (kind === "file" && !digestPattern.test(expectedContentHash ?? "")) ||
    key?.length !== 32
  ) {
    throw new Error("Trash recovery target is unsafe.")
  }
  const noteMatch = kind === "file" ? notePattern.exec(normalized) : undefined
  const noteDomain = noteMatch?.[2]
  const domains =
    options.domainSnapshot ?? (await captureNoteDomainSnapshot(workspace).catch(() => undefined))
  if (domains === undefined || (noteDomain !== undefined && !domains.has(noteDomain))) {
    throw new Error("Trash recovery domain is unavailable.")
  }
  await revalidateNoteDomains(domains, noteDomain === undefined ? [] : [noteDomain]).catch(() => {
    throw new Error("Trash recovery domain changed.")
  })
  const id = randomUUID()
  const transactions = resolve(root, indexedTransactionsDirectory)
  const shard = resolve(transactions, id.slice(0, 2))
  await createRecoveryDirectory(transactions, root, openFile)
  await createRecoveryDirectory(shard, transactions, openFile)
  for (const directory of [transactions, shard]) {
    const [details, canonical] = await Promise.all([lstat(directory), realpath(directory)])
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      !pathsEqual(canonical, directory) ||
      !isInside(root, directory)
    ) {
      throw new Error("Trash recovery storage is unsafe.")
    }
  }
  const transactionPath = resolve(shard, id)
  const stagedRelativePath = `items/${normalized}`
  const stagedPath = resolve(transactionPath, ...stagedRelativePath.split("/"))
  await mkdir(transactionPath, { mode: 0o700 })
  await syncRecoveryDirectory(shard, openFile)
  let stagedParent = transactionPath
  for (const segment of stagedRelativePath.split("/").slice(0, -1)) {
    const child = resolve(stagedParent, segment)
    await mkdir(child, { mode: 0o700 })
    await syncRecoveryDirectory(stagedParent, openFile)
    stagedParent = child
  }
  const contentHash =
    kind === "directory" ? await directoryDigest(originalPath) : expectedContentHash!
  const unsigned: UnsignedTrashRecoveryJournal = {
    version: journalVersion,
    id,
    kind,
    originalRelativePath: normalized,
    stagedRelativePath,
    expectedIdentity,
    expectedContentHash: contentHash,
  }
  const journal: TrashRecoveryJournal = { ...unsigned, integrity: journalIntegrity(key!, unsigned) }
  const journalBytes = Buffer.from(JSON.stringify(journal), "utf8")
  if (journalBytes.length > 64 * 1024) throw new Error("Trash recovery journal is too large.")
  const journalPath = resolve(transactionPath, "journal.json")
  const journalHandle = await openFile(
    journalPath,
    process.platform === "win32"
      ? "wx"
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    let written = 0
    while (written < journalBytes.length) {
      const result = await journalHandle.write(
        journalBytes,
        written,
        journalBytes.length - written,
        written,
      )
      if (result.bytesWritten === 0) throw new Error("Trash recovery journal write stalled.")
      written += result.bytesWritten
    }
    await journalHandle.sync()
  } finally {
    await journalHandle.close()
  }
  await syncRecoveryDirectory(transactionPath, openFile)
  // The original item is staged only after this durable journal has been published
  // to the authenticated queue and prepareTrashRecovery returns to its caller.
  await appendRecoveryQueue(root, id, key, options)
  return {
    id,
    workspace,
    originalPath,
    originalRelativePath: normalized,
    stagedPath,
    transactionPath,
    kind,
    expectedIdentity,
    expectedContentHash: contentHash,
  }
}

async function rollbackTrashRecoveryMutation(
  stage: TrashRecoveryStage,
  mutation: "file-linked" | "directory-renamed" | undefined,
): Promise<void> {
  if (mutation === undefined) return
  try {
    if (!(await matchesExpectedItem(stage.originalPath, stage))) {
      throw new RecoveryPassDeferred("Trash recovery rollback was deferred.")
    }
    if (mutation === "file-linked") {
      await unlink(stage.originalPath)
      return
    }
    try {
      await lstat(stage.stagedPath)
      throw new RecoveryPassDeferred("Trash recovery rollback target is occupied.")
    } catch (error) {
      if (error instanceof RecoveryPassDeferred) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await rename(stage.originalPath, stage.stagedPath)
  } catch (error) {
    if (error instanceof RecoveryPassDeferred) throw error
    throw new RecoveryPassDeferred("Trash recovery rollback was deferred.")
  }
}

export async function restoreLocalTrashStage(
  stage: TrashRecoveryStage,
  control?: RecoveryTraversalControl,
): Promise<boolean> {
  let mutation: "file-linked" | "directory-renamed" | undefined
  try {
    if (!(await matchesExpectedItem(stage.stagedPath, stage, control))) return false
    assertRecoveryActive(control)
    if (stage.kind === "file") {
      await link(stage.stagedPath, stage.originalPath)
      mutation = "file-linked"
      if (!(await inspectExpectedItem(stage.originalPath, stage, control))) return false
      await unlink(stage.stagedPath)
      mutation = undefined
    } else {
      await rename(stage.stagedPath, stage.originalPath)
      mutation = "directory-renamed"
      if (!(await inspectExpectedItem(stage.originalPath, stage, control))) return false
      mutation = undefined
    }
    await rm(stage.transactionPath, { recursive: true }).catch(() => undefined)
    return true
  } catch (error) {
    if (error instanceof RecoveryPassDeferred) throw error
    if (mutation !== undefined) {
      throw new RecoveryPassDeferred("Trash recovery commit verification was deferred.")
    }
    return false
  } finally {
    // A failed verification returns rather than throws; restore the staged shape in
    // that path too so a later authenticated pass can retry instead of conflicting.
    await rollbackTrashRecoveryMutation(stage, mutation)
  }
}

function parseJournal(
  value: unknown,
  expectedId: string,
  key: Buffer,
): TrashRecoveryJournal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const fields = [
    "expectedContentHash",
    "expectedIdentity",
    "id",
    "integrity",
    "kind",
    "originalRelativePath",
    "stagedRelativePath",
    "version",
  ]
  if (Object.keys(record).sort().join("\0") !== fields.join("\0")) return undefined
  if (
    record.version !== journalVersion ||
    record.id !== expectedId ||
    (record.kind !== "file" && record.kind !== "directory")
  )
    return undefined
  if (
    typeof record.originalRelativePath !== "string" ||
    !validRelativePath(record.originalRelativePath, record.kind)
  )
    return undefined
  if (typeof record.expectedIdentity !== "string" || !/^\d+:\d+:\d+$/.test(record.expectedIdentity))
    return undefined
  if (
    typeof record.stagedRelativePath !== "string" ||
    record.stagedRelativePath !== `items/${record.originalRelativePath}`
  )
    return undefined
  if (
    typeof record.expectedContentHash !== "string" ||
    !digestPattern.test(record.expectedContentHash)
  )
    return undefined
  if (typeof record.integrity !== "string") return undefined
  const journal = record as unknown as TrashRecoveryJournal
  const { integrity, ...unsigned } = journal
  return sameIntegrity(integrity, journalIntegrity(key, unsigned)) ? journal : undefined
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  control?: RecoveryTraversalControl,
): Promise<Buffer> {
  const handle = await open(
    path,
    process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maximumBytes))
      throw new Error("Recovery file is unsafe.")
    const buffer = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < buffer.length) {
      assertRecoveryActive(control)
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) throw new Error("Recovery file was truncated.")
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      stableIdentity(after) !== stableIdentity(before) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    ) {
      throw new Error("Recovery file changed while reading.")
    }
    return buffer
  } finally {
    await handle.close()
  }
}

function stableIdentity(details: BigIntStats): string {
  return `${details.dev}:${details.ino}:${details.birthtimeNs}`
}

async function inspectExpectedItem(
  path: string,
  expected: Pick<TrashRecoveryStage, "kind" | "expectedIdentity" | "expectedContentHash">,
  control?: RecoveryTraversalControl,
): Promise<boolean> {
  assertRecoveryActive(control)
  const details = await lstat(path, { bigint: true })
  if (
    details.isSymbolicLink() ||
    (expected.kind === "file" ? !details.isFile() : !details.isDirectory()) ||
    stableIdentity(details) !== expected.expectedIdentity
  ) {
    return false
  }
  const contentHash =
    expected.kind === "file"
      ? createHash("sha256")
          .update(await readBoundedRegularFile(path, 16 * 1024 * 1024, control))
          .digest("hex")
      : await directoryDigest(path, control)
  if (contentHash !== expected.expectedContentHash) return false
  const after = await lstat(path, { bigint: true })
  if (stableIdentity(after) !== stableIdentity(details) || after.mtimeNs !== details.mtimeNs) {
    return false
  }
  return pathsEqual(await realpath(path), path)
}

async function matchesExpectedItem(
  path: string,
  expected: Pick<TrashRecoveryStage, "kind" | "expectedIdentity" | "expectedContentHash">,
  control?: RecoveryTraversalControl,
): Promise<boolean> {
  try {
    return await inspectExpectedItem(path, expected, control)
  } catch (error) {
    if (error instanceof RecoveryPassDeferred) throw error
    return false
  }
}

export async function verifyTrashRecoveryStage(stage: TrashRecoveryStage): Promise<boolean> {
  return matchesExpectedItem(stage.stagedPath, stage)
}

function cursorPayload(cursor: RecoveryCursorPayload): string {
  return JSON.stringify({
    version: cursor.version,
    queueSegment: cursor.queueSegment ?? 0,
    queueOffset: cursor.queueOffset ?? 0,
    migrationLocation: cursor.migrationLocation ?? 0,
    migrationOffset: cursor.migrationOffset ?? 0,
    migrationDirectoryIdentity: cursor.migrationDirectoryIdentity ?? "",
    migrationDirectoryMtimeNs: cursor.migrationDirectoryMtimeNs ?? "",
    migrationComplete: cursor.migrationComplete ?? false,
  })
}

function cursorIntegrity(key: Buffer, cursor: RecoveryCursorPayload): string {
  return createHmac("sha256", key)
    .update("garden-publisher/trash-recovery/cursor/v1\0")
    .update(cursorPayload(cursor))
    .digest("hex")
}

function parseRecoveryCursor(value: unknown, key: Buffer): RecoveryCursorPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const cursor = value as Partial<RecoveryCursorFile>
  if (
    cursor.version !== recoveryCursorVersion ||
    (cursor.queueSegment !== undefined &&
      (!Number.isSafeInteger(cursor.queueSegment) || cursor.queueSegment < 0)) ||
    (cursor.queueOffset !== undefined &&
      (!Number.isSafeInteger(cursor.queueOffset) || cursor.queueOffset < 0)) ||
    (cursor.migrationLocation !== undefined &&
      (!Number.isSafeInteger(cursor.migrationLocation) ||
        cursor.migrationLocation < 0 ||
        cursor.migrationLocation > 256)) ||
    (cursor.migrationOffset !== undefined &&
      (!Number.isSafeInteger(cursor.migrationOffset) || cursor.migrationOffset < 0)) ||
    (cursor.migrationDirectoryIdentity !== undefined &&
      (typeof cursor.migrationDirectoryIdentity !== "string" ||
        !/^\d+:\d+:\d+$/.test(cursor.migrationDirectoryIdentity))) ||
    (cursor.migrationDirectoryMtimeNs !== undefined &&
      (typeof cursor.migrationDirectoryMtimeNs !== "string" ||
        !/^\d+$/.test(cursor.migrationDirectoryMtimeNs))) ||
    (cursor.migrationComplete !== undefined && typeof cursor.migrationComplete !== "boolean") ||
    typeof cursor.integrity !== "string"
  ) {
    return undefined
  }
  const payload: RecoveryCursorPayload = {
    version: recoveryCursorVersion,
    ...(cursor.queueSegment === undefined ? {} : { queueSegment: cursor.queueSegment }),
    ...(cursor.queueOffset === undefined ? {} : { queueOffset: cursor.queueOffset }),
    ...(cursor.migrationLocation === undefined
      ? {}
      : { migrationLocation: cursor.migrationLocation }),
    ...(cursor.migrationOffset === undefined ? {} : { migrationOffset: cursor.migrationOffset }),
    ...(cursor.migrationDirectoryIdentity === undefined
      ? {}
      : { migrationDirectoryIdentity: cursor.migrationDirectoryIdentity }),
    ...(cursor.migrationDirectoryMtimeNs === undefined
      ? {}
      : { migrationDirectoryMtimeNs: cursor.migrationDirectoryMtimeNs }),
    ...(cursor.migrationComplete === undefined
      ? {}
      : { migrationComplete: cursor.migrationComplete }),
  }
  return sameIntegrity(cursor.integrity, cursorIntegrity(key, payload)) ? payload : undefined
}

async function readRecoveryCursor(root: string, key: Buffer): Promise<RecoveryCursorPayload> {
  const path = resolve(root, recoveryCursorName)
  try {
    const details = await lstat(path)
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      details.size > 4_096 ||
      !pathsEqual(await realpath(path), path)
    ) {
      return { version: recoveryCursorVersion }
    }
    return (
      parseRecoveryCursor(
        JSON.parse((await readBoundedRegularFile(path, 4_096)).toString("utf8")),
        key,
      ) ?? { version: recoveryCursorVersion }
    )
  } catch {
    return { version: recoveryCursorVersion }
  }
}

async function writeRecoveryCursor(
  root: string,
  key: Buffer,
  cursor: RecoveryCursorPayload,
): Promise<void> {
  const path = resolve(root, recoveryCursorName)
  const temporary = resolve(root, `.cursor-${randomUUID()}.tmp`)
  const file: RecoveryCursorFile = {
    ...cursor,
    integrity: cursorIntegrity(key, cursor),
  }
  try {
    await writeFile(temporary, JSON.stringify(file), { encoding: "utf8", flag: "wx", mode: 0o600 })
    const details = await lstat(temporary)
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      !pathsEqual(await realpath(temporary), temporary) ||
      !isInside(root, temporary)
    ) {
      throw new Error("Trash recovery cursor is unsafe.")
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function recoveryTransactionsRoot(
  root: string,
  directoryName = recoveryTransactionsDirectory,
): Promise<string> {
  const transactions = resolve(root, directoryName)
  await mkdir(transactions, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const [details, canonical] = await Promise.all([lstat(transactions), realpath(transactions)])
  if (
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    !pathsEqual(canonical, transactions) ||
    !isInside(root, transactions)
  ) {
    throw new Error("Trash recovery storage is unsafe.")
  }
  return transactions
}

interface RecoveryDirectoryPageEntry {
  readonly name: string
  readonly offsetBefore: number
  readonly offsetAfter: number
}

interface RecoveryDirectoryPage {
  readonly entries: readonly RecoveryDirectoryPageEntry[]
  readonly nextOffset: number
  readonly done: boolean
}

interface RecoveryQueuePageEntry {
  readonly id: string
  readonly offsetBefore: number
  readonly offsetAfter: number
}

interface RecoveryQueuePage {
  readonly entries: readonly RecoveryQueuePageEntry[]
  readonly segment: number
  readonly nextSegment: number
  readonly nextOffset: number
  readonly done: boolean
}

async function readRecoveryDirectoryPage(
  path: string,
  offset: number,
  openDirectory: DirectoryOpener,
  control: RecoveryTraversalControl,
): Promise<RecoveryDirectoryPage> {
  const handle = await openDirectory(path)
  const iterator = handle[Symbol.asyncIterator]()
  const entries: RecoveryDirectoryPageEntry[] = []
  let currentOffset = 0
  try {
    while (currentOffset < offset) {
      assertRecoveryActive(control)
      const skipped = await iterator.next()
      if (skipped.done) return { entries, nextOffset: 0, done: true }
      currentOffset += 1
    }
    while (entries.length < recoveryDirectoryEntriesPerPass) {
      assertRecoveryActive(control)
      const next = await iterator.next()
      if (next.done) return { entries, nextOffset: 0, done: true }
      entries.push({
        name: next.value.name,
        offsetBefore: currentOffset,
        offsetAfter: currentOffset + 1,
      })
      currentOffset += 1
    }
    return { entries, nextOffset: currentOffset, done: false }
  } catch (error) {
    if (error instanceof RecoveryPassDeferred && entries.length > 0) {
      return { entries, nextOffset: currentOffset, done: false }
    }
    throw error
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readRecoveryQueuePage(
  root: string,
  segmentInput: number,
  offsetInput: number,
  key: Buffer,
  control: RecoveryTraversalControl,
): Promise<RecoveryQueuePage> {
  const directory = resolve(root, recoveryQueueDirectory)
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const directoryDetails = await lstat(directory)
  if (
    directoryDetails.isSymbolicLink() ||
    !directoryDetails.isDirectory() ||
    !pathsEqual(await realpath(directory), directory) ||
    !isInside(root, directory)
  ) {
    throw new Error("Trash recovery queue is unsafe.")
  }
  const legacy = resolve(root, legacyRecoveryQueueName)
  const firstSegment = resolve(directory, "0000000000000000.log")
  try {
    const legacyDetails = await lstat(legacy)
    if (!legacyDetails.isSymbolicLink() && legacyDetails.isFile()) {
      await rename(legacy, firstSegment).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const segments = (await readBoundedDirectoryNames(directory, 10_000))
    .map(queueSegmentSequence)
    .filter((sequence): sequence is number => sequence !== undefined)
    .sort((left, right) => left - right)
  if (segments.length === 0) {
    return { entries: [], segment: 0, nextSegment: 0, nextOffset: 0, done: true }
  }
  const segment = segments.find((candidate) => candidate >= segmentInput) ?? segments[0]!
  const segmentIndex = segments.indexOf(segment)
  const following = segments[segmentIndex + 1]
  const path = resolve(directory, `${segment.toString(16).padStart(16, "0")}.log`)
  let handle
  try {
    handle = await open(path, "r")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        entries: [],
        segment,
        nextSegment: following ?? segments[0]!,
        nextOffset: 0,
        done: following === undefined,
      }
    }
    throw error
  }
  try {
    const [details, pathDetails, canonical] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ])
    if (
      !details.isFile() ||
      pathDetails.isSymbolicLink() ||
      !pathDetails.isFile() ||
      details.size > BigInt(recoveryQueueSegmentBytes) ||
      stableIdentity(details) !== stableIdentity(pathDetails) ||
      !pathsEqual(canonical, path) ||
      !isInside(root, canonical)
    ) {
      return {
        entries: [],
        segment,
        nextSegment: following ?? segments[0]!,
        nextOffset: 0,
        done: following === undefined,
      }
    }
    const size = Number(details.size)
    const offset = offsetInput > size ? 0 : offsetInput
    const pageBytes = 64 * 1024
    const buffer = Buffer.alloc(pageBytes + recoveryQueueRecordBytes)
    assertRecoveryActive(control)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    if (bytesRead === 0)
      return {
        entries: [],
        segment,
        nextSegment: following ?? segments[0]!,
        nextOffset: 0,
        done: following === undefined,
      }
    const bytes = buffer.subarray(0, bytesRead)
    const atEnd = offset + bytesRead >= size
    let consumed: number
    if (atEnd) {
      const lastNewline = bytes.lastIndexOf(0x0a)
      // Only bytes without a newline at the actual EOF are crash-torn.
      consumed = lastNewline < 0 ? 0 : lastNewline + 1
    } else {
      const newlineAfterPage = bytes.indexOf(0x0a, pageBytes)
      if (newlineAfterPage >= 0) {
        consumed = newlineAfterPage + 1
      } else {
        const lastNewline = bytes.lastIndexOf(0x0a, pageBytes - 1)
        // A line longer than the authenticated record bound is corrupt. Advance a
        // bounded page if no record boundary exists so it cannot block later segments.
        consumed = lastNewline < 0 ? Math.min(pageBytes, bytesRead) : lastNewline + 1
      }
    }
    const entries: RecoveryQueuePageEntry[] = []
    let lineOffset = 0
    for (const line of bytes.subarray(0, consumed).toString("utf8").split("\n")) {
      assertRecoveryActive(control)
      const lineBytes = Buffer.byteLength(line, "utf8") + 1
      if (line === "") {
        lineOffset += lineBytes
        continue
      }
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (
          value.version === 1 &&
          typeof value.id === "string" &&
          transactionPattern.test(value.id) &&
          typeof value.integrity === "string" &&
          sameIntegrity(value.integrity, queueIntegrity(key, value.id))
        ) {
          entries.push({
            id: value.id,
            offsetBefore: offset + lineOffset,
            offsetAfter: offset + lineOffset + lineBytes,
          })
        }
      } catch {
        // Invalid queue lines are skipped; authenticated journals remain untouched.
      }
      lineOffset += lineBytes
    }
    const reachedTail = offset + consumed >= size
    const hasIncompleteTail = atEnd && consumed < bytesRead
    if (hasIncompleteTail && following === undefined) {
      return {
        entries,
        segment,
        nextSegment: segment,
        nextOffset: offset + consumed,
        done: true,
      }
    }
    const segmentDone = reachedTail || hasIncompleteTail
    return {
      entries,
      segment,
      nextSegment: segmentDone ? (following ?? segments[0]!) : segment,
      nextOffset: segmentDone ? 0 : offset + consumed,
      done: segmentDone && following === undefined,
    }
  } finally {
    await handle.close()
  }
}

async function validLegacyTransaction(
  root: string,
  source: string,
  id: string,
  key: Buffer,
  control: RecoveryTraversalControl,
): Promise<boolean> {
  try {
    const details = await lstat(source)
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      !pathsEqual(await realpath(source), source) ||
      !isInside(root, source)
    ) {
      return false
    }
    const journalPath = resolve(source, "journal.json")
    const journalDetails = await lstat(journalPath)
    if (
      journalDetails.isSymbolicLink() ||
      !journalDetails.isFile() ||
      journalDetails.size > 64 * 1024
    ) {
      return false
    }
    return Boolean(
      parseJournal(
        JSON.parse(
          (await readBoundedRegularFile(journalPath, 64 * 1024, control)).toString("utf8"),
        ),
        id,
        key,
      ),
    )
  } catch (error) {
    if (error instanceof RecoveryPassDeferred) throw error
    return false
  }
}

async function discoverLegacyTransactions(
  root: string,
  transactions: string,
  indexedTransactions: string,
  cursor: RecoveryCursorPayload,
  key: Buffer,
  openDirectory: DirectoryOpener,
  control: RecoveryTraversalControl,
): Promise<{ readonly cursor: RecoveryCursorPayload; readonly pending: boolean }> {
  let location = cursor.migrationLocation ?? 0
  const quarantine = resolve(root, "legacy-quarantine")
  await mkdir(quarantine, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const [quarantineDetails, canonicalQuarantine] = await Promise.all([
    lstat(quarantine),
    realpath(quarantine),
  ])
  if (
    quarantineDetails.isSymbolicLink() ||
    !quarantineDetails.isDirectory() ||
    !pathsEqual(canonicalQuarantine, quarantine) ||
    !isInside(root, quarantine)
  ) {
    throw new Error("Trash recovery quarantine is unsafe.")
  }
  const reservedRootEntries = new Set([
    recoveryCursorName,
    legacyRecoveryQueueName,
    recoveryQueueDirectory,
    recoveryTransactionsDirectory,
    indexedTransactionsDirectory,
    "legacy-quarantine",
  ])

  const actionable = (entry: RecoveryDirectoryPageEntry): boolean =>
    location !== 0 || !reservedRootEntries.has(entry.name)

  while (location <= 256) {
    assertRecoveryActive(control)
    if (location === 1) {
      const legacyShards = await readRecoveryDirectoryPage(transactions, 0, openDirectory, control)
      if (legacyShards.done && legacyShards.entries.length === 0) break
    }
    const directory =
      location === 0 ? root : resolve(transactions, (location - 1).toString(16).padStart(2, "0"))
    let page: RecoveryDirectoryPage
    try {
      const directoryDetails = await lstat(directory)
      if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
        throw new Error("Trash recovery migration directory is unsafe.")
      }
      page = await readRecoveryDirectoryPage(directory, 0, openDirectory, control)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        location += 1
        continue
      }
      throw error
    }
    const bucket = resolve(quarantine, location.toString(16).padStart(3, "0"))
    await mkdir(bucket, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    const [bucketDetails, canonicalBucket] = await Promise.all([lstat(bucket), realpath(bucket)])
    if (
      bucketDetails.isSymbolicLink() ||
      !bucketDetails.isDirectory() ||
      !pathsEqual(canonicalBucket, bucket) ||
      !isInside(quarantine, bucket)
    ) {
      throw new Error("Trash recovery quarantine is unsafe.")
    }
    let blocked = false
    let transformed = false
    for (const entry of page.entries.filter(actionable)) {
      if (transformed) assertRecoveryActive(control)
      const id = entry.name
      const source = resolve(directory, id)
      try {
        if (
          transactionPattern.test(id) &&
          (await validLegacyTransaction(root, source, id, key, transformed ? control : {}))
        ) {
          const shard = resolve(indexedTransactions, id.slice(0, 2))
          const target = resolve(shard, id)
          await mkdir(shard, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error
          })
          const [shardDetails, canonicalShard] = await Promise.all([lstat(shard), realpath(shard)])
          if (
            shardDetails.isSymbolicLink() ||
            !shardDetails.isDirectory() ||
            !pathsEqual(canonicalShard, shard) ||
            !isInside(indexedTransactions, shard)
          ) {
            throw new Error("Trash recovery migration target is unsafe.")
          }
          await appendRecoveryQueue(root, id, key)
          await rename(source, target)
          transformed = true
          continue
        }
        await rename(source, resolve(bucket, randomUUID()))
        transformed = true
      } catch (error) {
        if (error instanceof RecoveryPassDeferred) throw error
        if ((error as NodeJS.ErrnoException).code === "ENOENT") transformed = true
        else blocked = true
      }
    }
    if (!page.done || blocked) {
      return {
        cursor: { ...cursor, migrationLocation: location, migrationOffset: 0 },
        pending: true,
      }
    }
    const remaining = await readRecoveryDirectoryPage(directory, 0, openDirectory, control)
    if (remaining.entries.some(actionable) || !remaining.done) {
      return {
        cursor: { ...cursor, migrationLocation: location, migrationOffset: 0 },
        pending: true,
      }
    }
    location += 1
  }
  const {
    migrationDirectoryIdentity: _identity,
    migrationDirectoryMtimeNs: _mtime,
    ...withoutDirectory
  } = cursor
  return {
    cursor: {
      ...withoutDirectory,
      migrationLocation: 0,
      migrationOffset: 0,
      migrationComplete: true,
    },
    pending: false,
  }
}

export interface TrashRecoveryPassOptions {
  readonly maximumTransactions?: number
  readonly maximumJournalBytes?: number
  readonly maximumElapsedMs?: number
  readonly openDirectory?: DirectoryOpener
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface TrashRecoveryPassResult {
  readonly restored: readonly string[]
  readonly conflicts: readonly string[]
  readonly pending: boolean
}

/** Performs one authenticated, bounded page of Recycle Bin reconciliation. */
export async function reconcileTrashRecoveryPass(
  workspaceInput: string,
  loadKey: () => Promise<Buffer>,
  options: TrashRecoveryPassOptions = {},
): Promise<TrashRecoveryPassResult> {
  let storage: { workspace: string; root: string }
  try {
    storage = await safeRecoveryRoot(workspaceInput, false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { restored: [], conflicts: [], pending: false }
    }
    throw error
  }
  const restored: string[] = []
  const conflicts: string[] = []
  const domains = await captureNoteDomainSnapshot(storage.workspace).catch(() => undefined)
  if (domains === undefined) return { restored, conflicts, pending: false }
  const key = await loadKey()
  if (key.length !== 32) throw new Error("Trash recovery key is invalid.")
  const maximumTransactions = Math.max(
    1,
    Math.min(1_024, Math.floor(options.maximumTransactions ?? recoveryTransactionsPerPass)),
  )
  const maximumJournalBytes = Math.max(
    64 * 1024,
    Math.min(
      16 * 1024 * 1024,
      Math.floor(options.maximumJournalBytes ?? recoveryJournalBytesPerPass),
    ),
  )
  const maximumElapsedMs = Math.max(
    10,
    Math.min(5_000, Math.floor(options.maximumElapsedMs ?? recoveryElapsedMsPerPass)),
  )
  const now = options.now ?? Date.now
  const control: RecoveryTraversalControl = {
    signal: options.signal,
    deadline: now() + maximumElapsedMs,
    now,
  }
  const openDirectory = options.openDirectory ?? opendir
  const transactions = await recoveryTransactionsRoot(storage.root)
  const indexedTransactions = await recoveryTransactionsRoot(
    storage.root,
    indexedTransactionsDirectory,
  )
  let cursor = await readRecoveryCursor(storage.root, key)
  let pending = false
  try {
    if (!cursor.migrationComplete) {
      const legacy = await discoverLegacyTransactions(
        storage.root,
        transactions,
        indexedTransactions,
        cursor,
        key,
        openDirectory,
        control,
      )
      cursor = legacy.cursor
      pending = legacy.pending
    }
  } catch (error) {
    if (!(error instanceof RecoveryPassDeferred)) throw error
    await writeRecoveryCursor(storage.root, key, cursor)
    return { restored, conflicts, pending: true }
  }
  let journalBytes = 0
  let processed = 0
  const seenIds = new Set<string>()
  let queuePage: RecoveryQueuePage
  try {
    queuePage = await readRecoveryQueuePage(
      storage.root,
      cursor.queueSegment ?? 0,
      cursor.queueOffset ?? 0,
      key,
      control,
    )
  } catch (error) {
    if (!(error instanceof RecoveryPassDeferred)) throw error
    await writeRecoveryCursor(storage.root, key, cursor)
    return { restored, conflicts, pending: true }
  }
  for (const entry of queuePage.entries) {
    const id = entry.id
    cursor = { ...cursor, queueSegment: queuePage.segment, queueOffset: entry.offsetBefore }
    if (seenIds.has(id)) {
      cursor = { ...cursor, queueSegment: queuePage.segment, queueOffset: entry.offsetAfter }
      continue
    }
    seenIds.add(id)
    if (processed >= maximumTransactions) {
      pending = true
      await writeRecoveryCursor(storage.root, key, cursor)
      return { restored, conflicts, pending }
    }
    const shardName = id.slice(0, 2)
    if (!shardPattern.test(shardName)) continue
    const shard = resolve(indexedTransactions, shardName)
    const transactionPath = resolve(shard, id)
    let advanceCursor = true
    try {
      const transaction = await lstat(transactionPath)
      const journalPath = resolve(transactionPath, "journal.json")
      const journalDetails = await lstat(journalPath)
      if (
        transaction.isSymbolicLink() ||
        !transaction.isDirectory() ||
        journalDetails.isSymbolicLink() ||
        !journalDetails.isFile() ||
        journalDetails.size > 64 * 1024
      ) {
        continue
      }
      if (journalBytes + journalDetails.size > maximumJournalBytes) {
        advanceCursor = false
        pending = true
        await writeRecoveryCursor(storage.root, key, cursor)
        return { restored, conflicts, pending }
      }
      journalBytes += journalDetails.size
      if (!pathsEqual(await realpath(transactionPath), transactionPath)) continue
      const journal = parseJournal(
        JSON.parse(
          (await readBoundedRegularFile(journalPath, 64 * 1024, control)).toString("utf8"),
        ),
        id,
        key,
      )
      if (!journal) continue
      const noteMatch =
        journal.kind === "file" ? notePattern.exec(journal.originalRelativePath) : undefined
      const noteDomain = noteMatch?.[2]
      if (noteDomain !== undefined && !domains.has(noteDomain)) continue
      const original = resolve(storage.workspace, ...journal.originalRelativePath.split("/"))
      const staged = resolve(transactionPath, ...journal.stagedRelativePath.split("/"))
      if (!isInside(transactionPath, staged) || !isInside(storage.workspace, original)) continue
      let stagedDetails
      try {
        stagedDetails = await lstat(staged)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      if (
        stagedDetails.isSymbolicLink() ||
        (journal.kind === "file" ? !stagedDetails.isFile() : !stagedDetails.isDirectory())
      )
        continue
      if (!pathsEqual(await realpath(staged), staged)) continue
      try {
        await lstat(original)
        conflicts.push(journal.originalRelativePath)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const parent = dirname(original)
      const canonicalParent = await realpath(parent)
      if (!pathsEqual(canonicalParent, parent) || !isInside(storage.workspace, canonicalParent))
        continue
      const stage: TrashRecoveryStage = {
        id,
        workspace: storage.workspace,
        originalPath: original,
        originalRelativePath: journal.originalRelativePath,
        stagedPath: staged,
        transactionPath,
        kind: journal.kind,
        expectedIdentity: journal.expectedIdentity,
        expectedContentHash: journal.expectedContentHash,
      }
      if (!(await matchesExpectedItem(staged, stage, control))) {
        conflicts.push(journal.originalRelativePath)
        continue
      }
      if (noteDomain !== undefined) {
        try {
          await revalidateNoteDomains(domains, [noteDomain])
        } catch {
          continue
        }
      }
      if (await restoreLocalTrashStage(stage, control)) restored.push(journal.originalRelativePath)
      else conflicts.push(journal.originalRelativePath)
    } catch (error) {
      if (error instanceof RecoveryPassDeferred) {
        advanceCursor = false
        await writeRecoveryCursor(storage.root, key, cursor)
        return { restored, conflicts, pending: true }
      }
      // Invalid or racing journals are retained for manual inspection.
    } finally {
      if (advanceCursor) {
        cursor = { ...cursor, queueSegment: queuePage.segment, queueOffset: entry.offsetAfter }
      }
      processed += 1
    }
  }
  cursor = {
    ...cursor,
    queueSegment: queuePage.nextSegment,
    queueOffset: queuePage.nextOffset,
  }
  pending ||= !queuePage.done
  await writeRecoveryCursor(storage.root, key, cursor)
  return { restored, conflicts, pending }
}

/** Reinstalls one bounded page; conflicts remain authenticated in recovery storage. */
export async function reconcileTrashRecovery(
  workspaceInput: string,
  loadKey: () => Promise<Buffer>,
  options: TrashRecoveryPassOptions = {},
): Promise<{ readonly restored: readonly string[]; readonly conflicts: readonly string[] }> {
  const { restored, conflicts } = await reconcileTrashRecoveryPass(workspaceInput, loadKey, options)
  return { restored, conflicts }
}
