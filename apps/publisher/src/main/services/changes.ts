import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import type {
  ChangeAttachment,
  ChangeGroup,
  ChangeKind,
  ChangeReview,
  ChangeSelection,
} from "../../shared/contracts"
import { type CommandRunner, systemCommandRunner } from "../lib/commandRunner"

export type PorcelainEntry = {
  readonly recordType: "ordinary" | "rename" | "unmerged" | "untracked" | "ignored"
  readonly path: string
  readonly originalPath?: string
  readonly index: string
  readonly worktree: string
}

export interface ListChangesOptions {
  readonly workspace: string
  readonly runner?: CommandRunner
  /** Test seam for exact porcelain fixtures. Production always invokes Git itself. */
  readonly statusOutput?: string
}

type MutableGroup = {
  id: string
  label: string
  kind: ChangeKind
  selection: ChangeSelection
  description: string
  paths: string[]
  attachments: ChangeAttachment[]
}

function parseHeader(record: string, tokenCount: number): { tokens: string[]; path: string } {
  const tokens: string[] = []
  let offset = 0
  for (let index = 0; index < tokenCount; index += 1) {
    const separator = record.indexOf(" ", offset)
    if (separator < 0) throw new Error("Malformed porcelain-v2 record.")
    tokens.push(record.slice(offset, separator))
    offset = separator + 1
  }
  const path = record.slice(offset)
  if (!path) throw new Error("Malformed porcelain-v2 path.")
  return { tokens, path }
}

export function parsePorcelainV2(output: string): readonly PorcelainEntry[] {
  const fields = output.split("\0")
  if (fields.at(-1) === "") fields.pop()
  const entries: PorcelainEntry[] = []
  const paths = new Set<string>()
  const renameOrigins = new Set<string>()
  for (let cursor = 0; cursor < fields.length; cursor += 1) {
    const record = fields[cursor]!
    if (!record) throw new Error("Malformed empty porcelain-v2 record.")
    let entry: PorcelainEntry
    if (record.startsWith("1 ")) {
      const { tokens, path } = parseHeader(record, 8)
      const status = tokens[1]
      if (!status || status.length !== 2) throw new Error("Malformed porcelain-v2 status.")
      entry = { recordType: "ordinary", path, index: status[0]!, worktree: status[1]! }
    } else if (record.startsWith("2 ")) {
      const { tokens, path } = parseHeader(record, 9)
      const originalPath = fields[++cursor]
      if (!originalPath) throw new Error("Malformed porcelain-v2 rename record.")
      const status = tokens[1]
      if (!status || status.length !== 2) throw new Error("Malformed porcelain-v2 rename status.")
      entry = {
        recordType: "rename",
        path,
        originalPath,
        index: status[0]!,
        worktree: status[1]!,
      }
    } else if (record.startsWith("u ")) {
      const { tokens, path } = parseHeader(record, 10)
      const status = tokens[1]
      entry = {
        recordType: "unmerged",
        path,
        index: status?.[0] ?? "U",
        worktree: status?.[1] ?? "U",
      }
    } else if (record.startsWith("? ") || record.startsWith("! ")) {
      entry = {
        recordType: record[0] === "?" ? "untracked" : "ignored",
        path: record.slice(2),
        index: record[0]!,
        worktree: record[0]!,
      }
    } else {
      throw new Error("Unsupported porcelain-v2 record.")
    }
    if (paths.has(entry.path)) throw new Error(`Duplicate path in change status: ${entry.path}`)
    paths.add(entry.path)
    if (entry.originalPath) {
      if (renameOrigins.has(entry.originalPath))
        throw new Error(`Duplicate rename origin in change status: ${entry.originalPath}`)
      renameOrigins.add(entry.originalPath)
    }
    entries.push(entry)
  }
  return entries
}

function assertRelativePath(path: string): void {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path
  if (
    !normalized ||
    isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes("\\") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Git returned a path that is not a safe workspace path.")
  }
}

function isContained(root: string, candidate: string): boolean {
  const result = relative(root, candidate)
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result))
}

async function assertManagedPathBoundary(workspace: string, path: string): Promise<void> {
  if (!path.startsWith("content/") && !path.startsWith("private/")) return
  let current = workspace
  for (const part of path.replace(/\/$/, "").split("/")) {
    current = resolve(current, part)
    if (!isContained(workspace, current)) throw new Error("Managed path escaped the workspace.")
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink())
        throw new Error("Managed content crosses a symbolic link boundary.")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

function idFor(kind: ChangeKind, key: string): string {
  return `${kind}:${createHash("sha256").update(key).digest("hex").slice(0, 20)}`
}

function makeGroup(
  kind: ChangeKind,
  key: string,
  label: string,
  selection: ChangeSelection,
  description: string,
): MutableGroup {
  return { id: idFor(kind, key), label, kind, selection, description, paths: [], attachments: [] }
}

const publicNote = /^content\/(?:technology|reading|language|life)\/([^/]+)\.md$/
const privateNote = /^private\/(?:technology|reading|language|life)\/([^/]+)\.md$/
const publicAttachment = /^content\/_assets\/([^/]+)\/(.+)$/
const privateAttachment = /^private\/_assets\/([^/]+)\/(.+)$/

function isDeletion(entry: PorcelainEntry): boolean {
  return entry.index === "D" || entry.worktree === "D"
}

function isAddition(entry: PorcelainEntry): boolean {
  return entry.recordType === "untracked" || entry.index === "A" || entry.worktree === "A"
}

function publicDescription(kind: ChangeKind): string {
  if (kind === "added") return "新增公开文章"
  if (kind === "unpublish") return "将从公开网站移除"
  if (kind === "attachment") return "公开文章的附件变化"
  return "公开文章已修改"
}

function addUnique(target: string[], path: string): void {
  if (!target.includes(path)) target.push(path)
}

function immutableGroup(group: MutableGroup): ChangeGroup {
  return {
    ...group,
    paths: [...group.paths],
    attachments: [...group.attachments],
  }
}

export async function listChanges(options: ListChangesOptions): Promise<ChangeReview> {
  const workspace = await realpath(resolve(options.workspace))
  let output = options.statusOutput
  let ignoredPrivateOutput = ""
  if (output === undefined) {
    const result = await (options.runner ?? systemCommandRunner).run({
      executable: "git",
      args: ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      cwd: workspace,
      env: { GIT_OPTIONAL_LOCKS: "0" },
    })
    if (result.exitCode !== 0) throw new Error("Could not inspect publication changes.")
    output = result.stdout
    const ignoredPrivate = await (options.runner ?? systemCommandRunner).run({
      executable: "git",
      args: [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--",
        "private",
      ],
      cwd: workspace,
      env: { GIT_OPTIONAL_LOCKS: "0" },
    })
    if (ignoredPrivate.exitCode !== 0) throw new Error("Could not inspect private local changes.")
    ignoredPrivateOutput = ignoredPrivate.stdout
  }
  const entries = [
    ...parsePorcelainV2(output),
    ...parsePorcelainV2(ignoredPrivateOutput).filter(
      (entry) => entry.recordType === "ignored" && entry.path.startsWith("private/"),
    ),
  ]
  for (const entry of entries) {
    for (const path of [entry.path, entry.originalPath]) {
      if (!path) continue
      assertRelativePath(path)
      await assertManagedPathBoundary(workspace, path)
    }
  }

  if (entries.some((entry) => entry.recordType === "unmerged")) {
    return { groups: [], blockedReason: "检测到内容冲突，请先解决后再检查发布。" }
  }

  const staged = entries.some(
    (entry) =>
      (entry.recordType === "ordinary" || entry.recordType === "rename") && entry.index !== ".",
  )
  const noteGroups = new Map<string, MutableGroup>()
  const unattached: { slug: string; path: string; label: string; entry: PorcelainEntry }[] = []
  const privateGroups = new Map<string, MutableGroup>()
  const config = makeGroup("config", "repository", "配置修改", "optional", "高级选项，默认不发布")

  for (const entry of entries) {
    if (entry.recordType === "ignored" && !entry.path.startsWith("private/")) continue
    const publicMatch = publicNote.exec(entry.path)
    const privateMatch = privateNote.exec(entry.path)
    const attachmentMatch = publicAttachment.exec(entry.path)
    const privateAssetMatch = privateAttachment.exec(entry.path)
    const originalPublicMatch = entry.originalPath ? publicNote.exec(entry.originalPath) : null
    const originalAttachmentMatch = entry.originalPath
      ? publicAttachment.exec(entry.originalPath)
      : null
    if (originalPublicMatch && !publicMatch) {
      const slug = originalPublicMatch[1]!
      const group = makeGroup(
        "unpublish",
        entry.originalPath!,
        slug,
        "default",
        publicDescription("unpublish"),
      )
      group.paths.push(entry.originalPath!)
      noteGroups.set(entry.originalPath!, group)
    }
    if (originalAttachmentMatch && !attachmentMatch) {
      unattached.push({
        slug: originalAttachmentMatch[1]!,
        path: entry.originalPath!,
        label: originalAttachmentMatch[2]!,
        entry: {
          ...entry,
          path: entry.originalPath!,
          originalPath: undefined,
          index: "D",
          worktree: ".",
        },
      })
    }
    if (publicMatch) {
      const slug = publicMatch[1]!
      const kind: ChangeKind = isDeletion(entry)
        ? "unpublish"
        : isAddition(entry)
          ? "added"
          : "modified"
      const group = makeGroup(kind, entry.path, slug, "default", publicDescription(kind))
      addUnique(group.paths, entry.path)
      if (entry.originalPath?.startsWith("content/")) addUnique(group.paths, entry.originalPath)
      noteGroups.set(entry.path, group)
    } else if (attachmentMatch) {
      unattached.push({
        slug: attachmentMatch[1]!,
        path: entry.path,
        label: attachmentMatch[2]!,
        entry,
      })
    } else if (entry.path.startsWith("private/")) {
      const key = (privateMatch ?? privateAssetMatch)?.[1] ?? entry.path
      const label =
        (privateMatch ?? privateAssetMatch)?.[1] ?? basename(entry.path).replace(/\.[^.]*$/, "")
      if (!privateGroups.has(key)) {
        privateGroups.set(
          key,
          makeGroup("private", entry.path, label, "locked", "只保留在本机，不会发布"),
        )
      }
    } else {
      addUnique(config.paths, entry.path)
    }
  }

  for (const item of unattached) {
    const candidates = [...noteGroups.values()].filter(
      (candidate) => candidate.kind !== "attachment" && candidate.label === item.slug,
    )
    let group = candidates.length === 1 ? candidates[0] : noteGroups.get(`attachment:${item.slug}`)
    if (!group) {
      const kind: ChangeKind = "attachment"
      group = makeGroup(kind, item.path, item.slug, "default", publicDescription(kind))
      noteGroups.set(`attachment:${item.slug}`, group)
    }
    addUnique(group.paths, item.path)
    group.attachments.push({ path: item.path, label: item.label })
    if (item.entry.originalPath?.startsWith("content/"))
      addUnique(group.paths, item.entry.originalPath)
  }

  const groups = [
    ...noteGroups.values(),
    ...privateGroups.values(),
    ...(config.paths.length > 0 ? [config] : []),
  ]
    .map(immutableGroup)
    .sort((left, right) => {
      const order: Record<ChangeKind, number> = {
        added: 0,
        modified: 1,
        unpublish: 2,
        attachment: 3,
        private: 4,
        config: 5,
      }
      return order[left.kind] - order[right.kind] || left.label.localeCompare(right.label, "zh-CN")
    })
  return {
    groups,
    ...(staged ? { blockedReason: "检测到其他工具已准备中的发布内容，请先处理后再继续。" } : {}),
  }
}
