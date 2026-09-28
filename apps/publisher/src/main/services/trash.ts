import type { BigIntStats } from "node:fs"
import { lstat, realpath, rename } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import {
  MANAGED_NOTE_PATH_PATTERN,
  NOTE_DOMAINS,
  type AppError,
  type NoteTrashReceipt,
  type TrashAdapter,
} from "../../shared/contracts"
import { trashNote as trashVerifiedNote } from "./noteFiles"
import { prepareTrashRecovery, restoreLocalTrashStage } from "./trashRecovery"

export interface TrashManagedNoteInput {
  readonly workspace: string
  readonly path: string
  readonly trash: TrashAdapter
  readonly isTracked: (workspace: string, path: string) => Promise<boolean>
}

function noteError(code: AppError["code"], message: string): AppError {
  return { code, message } as AppError
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
}

function entryIdentity(details: BigIntStats): string {
  return `${details.dev}:${details.ino}:${details.birthtimeNs}`
}

async function ownedAttachmentDirectory(
  workspaceInput: string,
  notePath: string,
): Promise<
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous" }
  | {
      readonly kind: "owned"
      readonly workspace: string
      readonly directory: string
      readonly assetsRoot: string
      readonly assetsIdentity: string
      readonly directoryIdentity: string
    }
> {
  const match = MANAGED_NOTE_PATH_PATTERN.exec(notePath)
  if (!match) {
    throw noteError("NOTE_FILE_INVALID", "Choose a note inside a managed content directory.")
  }
  let workspace: string
  try {
    workspace = await realpath(resolve(workspaceInput))
  } catch {
    throw noteError("NOTE_FILE_ACCESS_FAILED", "The knowledge garden workspace is unavailable.")
  }
  const visibilityRoot = match[1]!
  const slug = match[3]!
  const managedRoot = resolve(workspace, visibilityRoot)
  const assetsRoot = resolve(managedRoot, "_assets")
  const directory = resolve(assetsRoot, slug)
  if (!isInside(workspace, managedRoot) || !isInside(managedRoot, directory)) {
    throw noteError("NOTE_FILE_UNSAFE_PATH", "The attachment path left the managed workspace.")
  }
  try {
    const details = await lstat(directory)
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw noteError("NOTE_FILE_UNSAFE_PATH", "The owned attachment path is unsafe.")
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not-found" }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      String(error.code).startsWith("NOTE_")
    )
      throw error
    throw noteError("NOTE_FILE_ACCESS_FAILED", "Could not validate the owned attachments.")
  }
  const identities: string[] = []
  for (const domain of NOTE_DOMAINS) {
    const candidate = resolve(managedRoot, domain, `${slug}.md`)
    try {
      const details = await lstat(candidate)
      if (details.isSymbolicLink() || !details.isFile()) continue
      const canonical = await realpath(candidate)
      if (pathsEqual(canonical, candidate) && isInside(managedRoot, canonical)) {
        identities.push(`${domain}/${slug}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw noteError("NOTE_FILE_ACCESS_FAILED", "Could not determine attachment ownership.")
      }
    }
  }
  if (identities.length > 1) return { kind: "ambiguous" }
  try {
    const rootDetails = await lstat(assetsRoot, { bigint: true })
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
      throw noteError("NOTE_FILE_UNSAFE_PATH", "The managed attachment root is unsafe.")
    }
    const canonicalAssets = await realpath(assetsRoot)
    if (!pathsEqual(canonicalAssets, assetsRoot) || !isInside(managedRoot, canonicalAssets)) {
      throw noteError("NOTE_FILE_UNSAFE_PATH", "The managed attachment root is unsafe.")
    }
    const details = await lstat(directory, { bigint: true })
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw noteError("NOTE_FILE_UNSAFE_PATH", "The owned attachment path is unsafe.")
    }
    const canonical = await realpath(directory)
    if (!pathsEqual(canonical, directory) || !isInside(canonicalAssets, canonical)) {
      throw noteError("NOTE_FILE_UNSAFE_PATH", "The owned attachment path is unsafe.")
    }
    return {
      kind: "owned",
      workspace,
      directory,
      assetsRoot: canonicalAssets,
      assetsIdentity: entryIdentity(rootDetails),
      directoryIdentity: entryIdentity(details),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not-found" }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      String(error.code).startsWith("NOTE_")
    ) {
      throw error
    }
    throw noteError("NOTE_FILE_ACCESS_FAILED", "Could not validate the owned attachments.")
  }
}

async function trashOwnedAttachments(
  owned: {
    readonly kind: "owned"
    readonly workspace: string
    readonly directory: string
    readonly assetsRoot: string
    readonly assetsIdentity: string
    readonly directoryIdentity: string
  },
  trash: TrashAdapter,
): Promise<NoteTrashReceipt["attachmentCleanup"]> {
  try {
    const [assets, directory, canonicalAssets, canonicalDirectory] = await Promise.all([
      lstat(owned.assetsRoot, { bigint: true }),
      lstat(owned.directory, { bigint: true }),
      realpath(owned.assetsRoot),
      realpath(owned.directory),
    ])
    if (
      assets.isSymbolicLink() ||
      directory.isSymbolicLink() ||
      !assets.isDirectory() ||
      !directory.isDirectory() ||
      entryIdentity(assets) !== owned.assetsIdentity ||
      entryIdentity(directory) !== owned.directoryIdentity ||
      !pathsEqual(canonicalAssets, owned.assetsRoot) ||
      !pathsEqual(canonicalDirectory, owned.directory)
    ) {
      throw new Error("attachment identity changed")
    }
  } catch {
    return {
      status: "failed",
      message: "The note was recycled, but its attachments remain because their path changed.",
    }
  }
  let stage: Awaited<ReturnType<typeof prepareTrashRecovery>>
  try {
    stage = await prepareTrashRecovery(
      owned.workspace,
      owned.directory,
      relative(owned.workspace, owned.directory).replaceAll("\\", "/"),
      "directory",
      owned.directoryIdentity,
    )
    await rename(owned.directory, stage.stagedPath)
    const [staged, canonicalStaged] = await Promise.all([
      lstat(stage.stagedPath, { bigint: true }),
      realpath(stage.stagedPath),
    ])
    if (
      staged.isSymbolicLink() ||
      !staged.isDirectory() ||
      entryIdentity(staged) !== owned.directoryIdentity ||
      !pathsEqual(canonicalStaged, stage.stagedPath)
    ) {
      throw new Error("staged attachment identity changed")
    }
    try {
      await trash.trashItem(stage.stagedPath)
    } catch {
      // shell.trashItem can reject after Windows has accepted the move; reconcile below.
    }
    const [assets, canonicalAssets] = await Promise.all([
      lstat(owned.assetsRoot, { bigint: true }),
      realpath(owned.assetsRoot),
    ])
    if (
      assets.isSymbolicLink() ||
      !assets.isDirectory() ||
      entryIdentity(assets) !== owned.assetsIdentity ||
      !pathsEqual(canonicalAssets, owned.assetsRoot)
    ) {
      return {
        status: "failed",
        message: "The note was recycled, but attachment cleanup could not be confirmed.",
      }
    }
    try {
      const remaining = await lstat(stage.stagedPath, { bigint: true })
      if (remaining.isDirectory() && entryIdentity(remaining) === owned.directoryIdentity) {
        await restoreLocalTrashStage(stage)
        return {
          status: "failed",
          message: "The note was recycled, but its attachments remain in the workspace.",
        }
      }
      return {
        status: "failed",
        message: "The note was recycled, but attachment cleanup could not be confirmed.",
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "trashed" }
      throw error
    }
  } catch {
    return {
      status: "failed",
      message: "The note was recycled, but attachment cleanup could not be confirmed.",
    }
  }
}

async function hasAnotherOwner(workspace: string, notePath: string): Promise<boolean> {
  const match = MANAGED_NOTE_PATH_PATTERN.exec(notePath)!
  const managedRoot = resolve(workspace, match[1]!)
  const slug = match[3]!
  for (const domain of NOTE_DOMAINS) {
    const candidate = resolve(managedRoot, domain, `${slug}.md`)
    try {
      const details = await lstat(candidate)
      if (!details.isSymbolicLink() && details.isFile()) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return false
}

export function createElectronTrashAdapter(shell: Pick<TrashAdapter, "trashItem">): TrashAdapter {
  if (typeof shell?.trashItem !== "function") {
    throw new TypeError("An Electron shell.trashItem capability is required.")
  }
  return Object.freeze({ trashItem: (absolutePath: string) => shell.trashItem(absolutePath) })
}

/** Deletes only one validated note and the attachment directory owned by its slug. */
export async function trashManagedNote(input: TrashManagedNoteInput): Promise<NoteTrashReceipt> {
  if (typeof input.trash?.trashItem !== "function" || typeof input.isTracked !== "function") {
    throw noteError("INVALID_INPUT", "A Recycle Bin adapter and tracking check are required.")
  }
  const owned = await ownedAttachmentDirectory(input.workspace, input.path)
  const receipt = await trashVerifiedNote(input)
  let attachmentCleanup: NoteTrashReceipt["attachmentCleanup"]
  if (owned.kind === "not-found") {
    attachmentCleanup = { status: "not-found" }
  } else if (owned.kind === "ambiguous") {
    attachmentCleanup = {
      status: "retained-ambiguous",
      message: "Attachments were retained because this slug belongs to notes in multiple domains.",
    }
  } else {
    const confirmedOwned = owned
    try {
      const workspace = await realpath(resolve(input.workspace))
      attachmentCleanup = (await hasAnotherOwner(workspace, input.path))
        ? {
            status: "retained-ambiguous",
            message: "Attachments were retained because another note now uses this slug.",
          }
        : await trashOwnedAttachments(confirmedOwned, input.trash)
    } catch {
      attachmentCleanup = {
        status: "failed",
        message:
          "The note was recycled, but its attachments remain because ownership could not be confirmed.",
      }
    }
  }
  return { ...receipt, attachmentCleanup }
}

export const trashNote = trashManagedNote
