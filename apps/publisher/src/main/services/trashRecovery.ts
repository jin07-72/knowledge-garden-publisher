import { createHash, randomUUID } from "node:crypto"
import type { BigIntStats } from "node:fs"
import {
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
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

export interface TrashRecoveryStage {
  readonly id: string
  readonly workspace: string
  readonly originalPath: string
  readonly originalRelativePath: string
  readonly stagedPath: string
  readonly transactionPath: string
  readonly kind: "file" | "directory"
  readonly expectedIdentity: string
  readonly expectedContentHash?: string
}

interface TrashRecoveryJournal {
  readonly version: 1
  readonly kind: "file" | "directory"
  readonly originalRelativePath: string
  readonly expectedIdentity: string
  readonly expectedContentHash?: string
}

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
  expectedContentHash?: string,
): Promise<TrashRecoveryStage> {
  const { workspace, root } = await safeRecoveryRoot(workspaceInput, true)
  const normalized = originalRelativePath.replaceAll("\\", "/")
  const originalPath = resolve(originalPathInput)
  if (
    !validRelativePath(normalized, kind) ||
    !pathsEqual(resolve(workspace, ...normalized.split("/")), originalPath) ||
    !isInside(workspace, originalPath) ||
    !/^\d+:\d+:\d+$/.test(expectedIdentity) ||
    (kind === "file" && !/^[a-f0-9]{64}$/.test(expectedContentHash ?? "")) ||
    (kind === "directory" && expectedContentHash !== undefined)
  ) {
    throw new Error("Trash recovery target is unsafe.")
  }
  const id = randomUUID()
  const transactionPath = resolve(root, id)
  const stagedPath = resolve(transactionPath, "items", ...normalized.split("/"))
  await mkdir(transactionPath, { mode: 0o700 })
  await mkdir(dirname(stagedPath), { recursive: true, mode: 0o700 })
  const journal: TrashRecoveryJournal = {
    version: journalVersion,
    kind,
    originalRelativePath: normalized,
    expectedIdentity,
    ...(expectedContentHash === undefined ? {} : { expectedContentHash }),
  }
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
    ...(expectedContentHash === undefined ? {} : { expectedContentHash }),
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

function parseJournal(value: unknown): TrashRecoveryJournal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== journalVersion || (record.kind !== "file" && record.kind !== "directory"))
    return undefined
  if (
    typeof record.originalRelativePath !== "string" ||
    !validRelativePath(record.originalRelativePath, record.kind)
  )
    return undefined
  if (typeof record.expectedIdentity !== "string" || !/^\d+:\d+:\d+$/.test(record.expectedIdentity))
    return undefined
  if (
    record.kind === "file" &&
    (typeof record.expectedContentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.expectedContentHash))
  )
    return undefined
  if (record.kind === "directory" && record.expectedContentHash !== undefined) return undefined
  return record as unknown as TrashRecoveryJournal
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
    if (expected.kind === "file") {
      const contentHash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
      if (contentHash !== expected.expectedContentHash) return false
    }
    return pathsEqual(await realpath(path), path)
  } catch {
    return false
  }
}

/** Reinstalls items restored from Windows Recycle Bin; conflicts remain in the recovery area. */
export async function reconcileTrashRecovery(
  workspaceInput: string,
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
  const entries = (await readdir(storage.root))
    .filter((name) => transactionPattern.test(name))
    .sort()
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
      const journal = parseJournal(JSON.parse(await readFile(journalPath, "utf8")))
      if (!journal) continue
      const original = resolve(storage.workspace, ...journal.originalRelativePath.split("/"))
      const staged = resolve(transactionPath, "items", ...journal.originalRelativePath.split("/"))
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
        ...(journal.expectedContentHash === undefined
          ? {}
          : { expectedContentHash: journal.expectedContentHash }),
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
