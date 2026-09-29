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

const journalVersion = 1
const recoveryDirectory = ".garden-publisher/trash-recovery"
const transactionPattern = /^[a-f0-9-]{36}$/i
const notePattern =
  /^(content|private)\/(technology|reading|language|life)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
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
const recoveryCursorName = "cursor.json"
const recoveryQueueName = "pending.jsonl"
const recoveryCursorVersion = 1
const shardPattern = /^[a-f0-9]{2}$/
const recoveryDirectoryEntriesPerPass = 1_024

interface DirectoryHandleLike {
  readonly [Symbol.asyncIterator]: () => AsyncIterator<{ readonly name: string }>
  close(): Promise<void>
}

type DirectoryOpener = (path: string) => Promise<DirectoryHandleLike>

interface RecoveryCursorPayload {
  readonly version: 1
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

async function appendRecoveryQueue(root: string, id: string, key: Buffer): Promise<void> {
  const path = resolve(root, recoveryQueueName)
  const line = `${JSON.stringify({ version: 1, id, integrity: queueIntegrity(key, id) })}\n`
  const handle = await open(
    path,
    process.platform === "win32"
      ? "a"
      : constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const [opened, pathDetails, canonical] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ])
    if (
      !opened.isFile() ||
      pathDetails.isSymbolicLink() ||
      !pathDetails.isFile() ||
      opened.size > BigInt(256 * 1024 * 1024) ||
      stableIdentity(opened) !== stableIdentity(pathDetails) ||
      !pathsEqual(canonical, path) ||
      !isInside(root, canonical)
    ) {
      throw new Error("Trash recovery queue is unsafe.")
    }
    await handle.writeFile(line)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function sameIntegrity(left: string, right: string): boolean {
  if (!digestPattern.test(left) || !digestPattern.test(right)) return false
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

async function directoryDigest(
  root: string,
  control?: RecoveryTraversalControl,
): Promise<string> {
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
): Promise<{ workspace: string; root: string }> {
  const workspace = await realpath(resolve(workspaceInput))
  const state = resolve(workspace, ".garden-publisher")
  const root = resolve(workspace, recoveryDirectory)
  if (create) {
    try {
      await mkdir(state, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
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
    try {
      await mkdir(root, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
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

export async function prepareTrashRecovery(
  workspaceInput: string,
  originalPathInput: string,
  originalRelativePath: string,
  kind: TrashRecoveryStage["kind"],
  expectedIdentity: string,
  expectedContentHash: string | undefined,
  key: Buffer,
): Promise<TrashRecoveryStage> {
  const { workspace, root } = await safeRecoveryRoot(workspaceInput, true)
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
  const id = randomUUID()
  const transactions = resolve(root, recoveryTransactionsDirectory)
  const shard = resolve(transactions, id.slice(0, 2))
  await mkdir(transactions, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  await mkdir(shard, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
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
  await mkdir(dirname(stagedPath), { recursive: true, mode: 0o700 })
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
  // Publish the durable queue entry first. A concurrent recovery pass may observe an
  // incomplete transaction, but the cyclic queue will revisit it. The opposite order
  // could strand a complete journal forever if the process exited before queueing it.
  await appendRecoveryQueue(root, id, key)
  await writeFile(resolve(transactionPath, "journal.json"), JSON.stringify(journal), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  })
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

export async function restoreLocalTrashStage(
  stage: TrashRecoveryStage,
  control?: RecoveryTraversalControl,
): Promise<boolean> {
  try {
    if (!(await matchesExpectedItem(stage.stagedPath, stage, control))) return false
    assertRecoveryActive(control)
    if (stage.kind === "file") {
      await link(stage.stagedPath, stage.originalPath)
      if (!(await matchesExpectedItem(stage.originalPath, stage, control))) return false
      await unlink(stage.stagedPath)
    } else {
      await rename(stage.stagedPath, stage.originalPath)
      if (!(await matchesExpectedItem(stage.originalPath, stage, control))) return false
    }
    await rm(stage.transactionPath, { recursive: true }).catch(() => undefined)
    return true
  } catch (error) {
    if (error instanceof RecoveryPassDeferred) throw error
    return false
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

async function matchesExpectedItem(
  path: string,
  expected: Pick<TrashRecoveryStage, "kind" | "expectedIdentity" | "expectedContentHash">,
  control?: RecoveryTraversalControl,
): Promise<boolean> {
  try {
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
    ...(cursor.queueOffset === undefined ? {} : { queueOffset: cursor.queueOffset }),
    ...(cursor.migrationLocation === undefined
      ? {}
      : { migrationLocation: cursor.migrationLocation }),
    ...(cursor.migrationOffset === undefined
      ? {}
      : { migrationOffset: cursor.migrationOffset }),
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

async function recoveryTransactionsRoot(root: string): Promise<string> {
  const transactions = resolve(root, recoveryTransactionsDirectory)
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
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readRecoveryQueuePage(
  root: string,
  offsetInput: number,
  key: Buffer,
  control: RecoveryTraversalControl,
): Promise<RecoveryQueuePage> {
  const path = resolve(root, recoveryQueueName)
  let handle
  try {
    handle = await open(path, "r")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], nextOffset: 0, done: true }
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
      details.size > BigInt(256 * 1024 * 1024) ||
      stableIdentity(details) !== stableIdentity(pathDetails) ||
      !pathsEqual(canonical, path) ||
      !isInside(root, canonical)
    ) {
      throw new Error("Trash recovery queue is unsafe.")
    }
    const size = Number(details.size)
    const offset = offsetInput > size ? 0 : offsetInput
    const buffer = Buffer.alloc(64 * 1024)
    assertRecoveryActive(control)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    if (bytesRead === 0) return { entries: [], nextOffset: 0, done: true }
    const bytes = buffer.subarray(0, bytesRead)
    const lastNewline = bytes.lastIndexOf(0x0a)
    const consumed = lastNewline < 0 ? bytesRead : lastNewline + 1
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
    const done = offset + consumed >= size
    return { entries, nextOffset: done ? 0 : offset + consumed, done }
  } finally {
    await handle.close()
  }
}

async function discoverLegacyTransactions(
  root: string,
  transactions: string,
  cursor: RecoveryCursorPayload,
  key: Buffer,
  openDirectory: DirectoryOpener,
  control: RecoveryTraversalControl,
): Promise<{ readonly cursor: RecoveryCursorPayload; readonly pending: boolean }> {
  let location = cursor.migrationLocation ?? 0
  let offset = cursor.migrationOffset ?? 0
  while (location <= 256) {
    assertRecoveryActive(control)
    const directory =
      location === 0
        ? root
        : resolve(transactions, (location - 1).toString(16).padStart(2, "0"))
    let directoryBefore: BigIntStats
    let page: RecoveryDirectoryPage
    try {
      directoryBefore = await lstat(directory, { bigint: true })
      if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
        throw new Error("Trash recovery migration directory is unsafe.")
      }
      const identity = stableIdentity(directoryBefore)
      const mtimeNs = directoryBefore.mtimeNs.toString()
      if (
        offset > 0 &&
        (cursor.migrationDirectoryIdentity !== identity ||
          cursor.migrationDirectoryMtimeNs !== mtimeNs)
      ) {
        // An insertion or removal before a raw directory offset could otherwise hide
        // an older journal. Restart this one bounded directory until a stable sweep.
        offset = 0
      }
      cursor = {
        ...cursor,
        migrationLocation: location,
        migrationOffset: offset,
        migrationDirectoryIdentity: identity,
        migrationDirectoryMtimeNs: mtimeNs,
      }
      page = await readRecoveryDirectoryPage(directory, offset, openDirectory, control)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        location += 1
        offset = 0
        const {
          migrationDirectoryIdentity: _identity,
          migrationDirectoryMtimeNs: _mtime,
          ...withoutDirectory
        } = cursor
        cursor = withoutDirectory
        continue
      }
      throw error
    }
    for (const entry of page.entries) {
      assertRecoveryActive(control)
      const id = entry.name
      if (!transactionPattern.test(id)) continue
      await appendRecoveryQueue(root, id, key)
      if (location !== 0) continue
      const source = resolve(root, id)
      const shard = resolve(transactions, id.slice(0, 2))
      const target = resolve(shard, id)
      try {
        const [details, canonical] = await Promise.all([lstat(source), realpath(source)])
        if (
          details.isSymbolicLink() ||
          !details.isDirectory() ||
          !pathsEqual(canonical, source) ||
          !isInside(root, source)
        ) {
          continue
        }
        await mkdir(shard, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
        })
        const [shardDetails, canonicalShard] = await Promise.all([lstat(shard), realpath(shard)])
        if (
          shardDetails.isSymbolicLink() ||
          !shardDetails.isDirectory() ||
          !pathsEqual(canonicalShard, shard) ||
          !isInside(transactions, shard)
        ) {
          continue
        }
        await rename(source, target)
      } catch {
        // Racing or invalid legacy entries stay in place for a later/manual pass.
      }
    }
    const directoryAfter = await lstat(directory, { bigint: true })
    if (
      stableIdentity(directoryAfter) !== stableIdentity(directoryBefore) ||
      directoryAfter.mtimeNs !== directoryBefore.mtimeNs
    ) {
      return {
        cursor: {
          ...cursor,
          migrationLocation: location,
          migrationOffset: 0,
          migrationDirectoryIdentity: stableIdentity(directoryAfter),
          migrationDirectoryMtimeNs: directoryAfter.mtimeNs.toString(),
        },
        pending: true,
      }
    }
    if (!page.done) {
      return {
        cursor: { ...cursor, migrationLocation: location, migrationOffset: page.nextOffset },
        pending: true,
      }
    }
    location += 1
    offset = 0
    const {
      migrationDirectoryIdentity: _identity,
      migrationDirectoryMtimeNs: _mtime,
      ...withoutDirectory
    } = cursor
    cursor = withoutDirectory
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
  let cursor = await readRecoveryCursor(storage.root, key)
  let pending = false
  try {
    if (!cursor.migrationComplete) {
      const legacy = await discoverLegacyTransactions(
        storage.root,
        transactions,
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
      cursor = { ...cursor, queueOffset: entry.offsetBefore }
      if (seenIds.has(id)) {
        cursor = { ...cursor, queueOffset: entry.offsetAfter }
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
      const shard = resolve(transactions, shardName)
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
          cursor = { ...cursor, queueOffset: entry.offsetAfter }
        }
        processed += 1
      }
  }
  cursor = { ...cursor, queueOffset: queuePage.nextOffset }
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
