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
const maximumRecoveryTransactions = 10_000

interface DirectoryHandleLike {
  readonly [Symbol.asyncIterator]: () => AsyncIterator<{ readonly name: string }>
  close(): Promise<void>
}

type DirectoryOpener = (path: string) => Promise<DirectoryHandleLike>

export async function readBoundedDirectoryNames(
  path: string,
  maximumEntries: number,
  openDirectory: DirectoryOpener = opendir,
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
    throw new Error("Directory entry limit is invalid.")
  }
  const handle = await openDirectory(path)
  const names: string[] = []
  try {
    for await (const entry of handle) {
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

function sameIntegrity(left: string, right: string): boolean {
  if (!digestPattern.test(left) || !digestPattern.test(right)) return false
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

async function directoryDigest(root: string): Promise<string> {
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
    if (depth > maximumDirectoryDepth) throw new Error("Attachment recovery tree is too deep.")
    const before = await readBoundedDirectoryNames(directory, maximumDirectoryEntries - entries)
    entries += before.length
    for (const name of before) {
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
    const after = await readBoundedDirectoryNames(directory, before.length)
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
  const transactionPath = resolve(root, id)
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

export async function restoreLocalTrashStage(stage: TrashRecoveryStage): Promise<boolean> {
  try {
    if (!(await matchesExpectedItem(stage.stagedPath, stage))) return false
    if (stage.kind === "file") {
      await link(stage.stagedPath, stage.originalPath)
      if (!(await matchesExpectedItem(stage.originalPath, stage))) return false
      await unlink(stage.stagedPath)
    } else {
      await rename(stage.stagedPath, stage.originalPath)
      if (!(await matchesExpectedItem(stage.originalPath, stage))) return false
    }
    await rm(stage.transactionPath, { recursive: true }).catch(() => undefined)
    return true
  } catch {
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

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
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
): Promise<boolean> {
  try {
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
            .update(await readBoundedRegularFile(path, 16 * 1024 * 1024))
            .digest("hex")
        : await directoryDigest(path)
    if (contentHash !== expected.expectedContentHash) return false
    const after = await lstat(path, { bigint: true })
    if (stableIdentity(after) !== stableIdentity(details) || after.mtimeNs !== details.mtimeNs) {
      return false
    }
    return pathsEqual(await realpath(path), path)
  } catch {
    return false
  }
}

export async function verifyTrashRecoveryStage(stage: TrashRecoveryStage): Promise<boolean> {
  return matchesExpectedItem(stage.stagedPath, stage)
}

/** Reinstalls items restored from Windows Recycle Bin; conflicts remain in the recovery area. */
export async function reconcileTrashRecovery(
  workspaceInput: string,
  loadKey: () => Promise<Buffer>,
): Promise<{ readonly restored: readonly string[]; readonly conflicts: readonly string[] }> {
  let storage: { workspace: string; root: string }
  try {
    storage = await safeRecoveryRoot(workspaceInput, false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { restored: [], conflicts: [] }
    throw error
  }
  const restored: string[] = []
  const conflicts: string[] = []
  const key = await loadKey()
  if (key.length !== 32) throw new Error("Trash recovery key is invalid.")
  const entries = (
    await readBoundedDirectoryNames(storage.root, maximumRecoveryTransactions)
  ).filter((name) => transactionPattern.test(name))
  for (const id of entries) {
    const transactionPath = resolve(storage.root, id)
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
      )
        continue
      if (!pathsEqual(await realpath(transactionPath), transactionPath)) continue
      const journal = parseJournal(
        JSON.parse((await readBoundedRegularFile(journalPath, 64 * 1024)).toString("utf8")),
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
      if (!(await matchesExpectedItem(staged, stage))) {
        conflicts.push(journal.originalRelativePath)
        continue
      }
      if (await restoreLocalTrashStage(stage)) restored.push(journal.originalRelativePath)
      else conflicts.push(journal.originalRelativePath)
    } catch {
      // Invalid or racing journals are retained for manual inspection.
    }
  }
  return { restored, conflicts }
}
