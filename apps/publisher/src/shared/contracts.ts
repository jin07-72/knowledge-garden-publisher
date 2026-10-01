export type Visibility = "public" | "private"

export type SerializableValue =
  | null
  | boolean
  | number
  | string
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue }

export const APP_ERROR_CODES = [
  "INVALID_INPUT",
  "INVALID_WORKSPACE",
  "CONTENT_MISSING",
  "CONTENT_NOT_DIRECTORY",
  "PRIVATE_MISSING",
  "PRIVATE_NOT_DIRECTORY",
  "SCRIPTS_MISSING",
  "SCRIPTS_NOT_DIRECTORY",
  "PACKAGE_LOCK_MISSING",
  "PACKAGE_LOCK_NOT_FILE",
  "QUARTZ_CONFIG_MISSING",
  "QUARTZ_CONFIG_NOT_FILE",
  "VALIDATE_CONTENT_MISSING",
  "VALIDATE_CONTENT_NOT_FILE",
  "UNSAFE_PATH",
  "WORKSPACE_ACCESS_FAILED",
  "GIT_UNAVAILABLE",
  "GIT_NOT_REPOSITORY",
  "GIT_ROOT_MISMATCH",
  "GIT_ORIGIN_MISSING",
  "GIT_ORIGIN_FAILED",
  "GIT_ORIGIN_UNREACHABLE",
  "GIT_FETCH_AUTH_FAILED",
  "GIT_STATUS_FAILED",
  "DEPENDENCIES_MISSING",
  "DEPENDENCIES_INVALID",
  "PREVIEW_PORT_UNAVAILABLE",
  "REPAIR_FAILED",
  "CHANGE_SCAN_INVALID",
  "CHANGE_SCAN_LIMIT",
  "CHANGE_SCAN_CANCELLED",
  "CHANGE_SCAN_FAILED",
  "COMMAND_FAILED",
  "COMMAND_CANCELLED",
  "NOTE_INDEX_INVALID",
  "NOTE_INDEX_UNSAFE_PATH",
  "NOTE_INDEX_ACCESS_FAILED",
  "NOTE_INDEX_DUPLICATE",
  "NOTE_INDEX_CHANGED",
  "NOTE_FILE_INVALID",
  "NOTE_FILE_UNSAFE_PATH",
  "NOTE_FILE_ACCESS_FAILED",
  "NOTE_FILE_WRITE_FAILED",
  "NOTE_FILE_COMMIT_UNCERTAIN",
  "NOTE_FILE_LOCKED",
  "NOTE_ALREADY_EXISTS",
  "EXTERNAL_EDIT",
  "RECOVERY_NOT_FOUND",
  "RECOVERY_INVALID",
  "RECOVERY_CONFLICT",
  "RECOVERY_DISCARD_FAILED",
  "TRANSACTION_PLAN_BLOCKED",
  "TRANSACTION_PLAN_INVALID",
  "TRANSACTION_PLAN_TOO_LARGE",
  "TRANSACTION_JOURNAL_TOO_LARGE",
  "TRANSACTION_STALE",
  "TRANSACTION_COLLISION",
  "TRANSACTION_LOCKED",
  "TRANSACTION_PENDING",
  "TRANSACTION_FAILED",
  "TRANSACTION_UNCERTAIN",
  "RUNTIME_MISSING",
  "QUARTZ_MISSING",
  "WORKSPACE_INVALID",
  "PORT_UNAVAILABLE",
  "PREVIEW_TIMEOUT",
  "PREVIEW_BUILD_FAILED",
  "PREVIEW_START_FAILED",
  "PREVIEW_EXITED",
  "PREVIEW_STOP_FAILED",
  "IPC_UNAUTHORIZED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const

export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

export type AppError = {
  readonly [Code in AppErrorCode]: {
    readonly code: Code
    readonly message: string
    readonly details?: Readonly<Record<string, SerializableValue>>
  }
}[AppErrorCode]

type NoteIndexError = Extract<AppError, { readonly code: `NOTE_INDEX_${string}` }>
type NoteFileError = Extract<
  AppError,
  {
    readonly code:
      | `NOTE_FILE_${string}`
      | "NOTE_ALREADY_EXISTS"
      | "EXTERNAL_EDIT"
      | "INVALID_INPUT"
      | `RECOVERY_${string}`
      | `TRANSACTION_${string}`
  }
>

type PreviewError = Extract<
  AppError,
  {
    readonly code:
      | "RUNTIME_MISSING"
      | "QUARTZ_MISSING"
      | "WORKSPACE_INVALID"
      | "PORT_UNAVAILABLE"
      | "PREVIEW_TIMEOUT"
      | "PREVIEW_BUILD_FAILED"
      | "PREVIEW_START_FAILED"
      | "PREVIEW_EXITED"
      | "PREVIEW_STOP_FAILED"
  }
>

type BridgeError = Extract<
  AppError,
  { readonly code: "IPC_UNAUTHORIZED" | "SERVICE_UNAVAILABLE" | "INTERNAL_ERROR" }
>

type ChangeScanError = Extract<AppError, { readonly code: `CHANGE_SCAN_${string}` }>

export type WorkspaceIssue = Exclude<
  AppError,
  NoteIndexError | NoteFileError | PreviewError | BridgeError | ChangeScanError
> & {
  readonly path?: string
  readonly repair?: WorkspaceRepairAction
}

export type WorkspaceRepairAction = "install-dependencies"

export interface WorkspaceRepairRequest {
  readonly action: WorkspaceRepairAction
}

export interface WorkspaceRepairReceipt {
  readonly action: WorkspaceRepairAction
  readonly message: string
}

export interface WorkspaceCapabilities {
  readonly files: boolean
  readonly preview: boolean
  readonly git: boolean
  readonly publish: boolean
}

export type WorkspaceInspection =
  | {
      readonly ok: true
      readonly root: string
      readonly capabilities: WorkspaceCapabilities
      readonly issues: readonly []
    }
  | {
      readonly ok: false
      readonly root: string
      readonly capabilities: WorkspaceCapabilities
      readonly issues: readonly WorkspaceIssue[]
    }

export interface NoteSummary {
  readonly path: string
  readonly domain: "technology" | "reading" | "language" | "life"
  readonly slug: string
  readonly title: string
  readonly date: string
  readonly description: string
  readonly visibility: Visibility
  readonly updatedAt: string
  readonly tags: readonly string[]
}

export const NOTE_DOMAINS = ["technology", "reading", "language", "life"] as const
export const KEBAB_SLUG_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*"
export const MANAGED_NOTE_PATH_PATTERN = new RegExp(
  `^(content|private)/(${NOTE_DOMAINS.join("|")})/(${KEBAB_SLUG_SOURCE})\\.md$`,
)

export type ChangeKind = "added" | "modified" | "unpublish" | "attachment" | "private" | "config"
export type ChangeSelection = "default" | "optional" | "locked"

export interface ChangeAttachment {
  readonly path: string
  readonly label: string
}

export interface ChangeGroup {
  readonly id: string
  readonly label: string
  readonly kind: ChangeKind
  readonly selection: ChangeSelection
  readonly description: string
  readonly paths: readonly string[]
  readonly attachments: readonly ChangeAttachment[]
}

export interface ChangeReview {
  readonly groups: readonly ChangeGroup[]
  readonly blockedReason?: string
}

export interface PublishRequest {
  readonly changeGroupIds: readonly string[]
  readonly message?: string
}

export interface PublishProgress {
  readonly phase: "validating" | "committing" | "pushing" | "deploying" | "complete" | "failed"
  readonly message: string
  readonly percent?: number
}

export interface DeploymentRun {
  readonly id: string
  readonly headSha: string
  readonly startedAt: string
  readonly completedAt?: string
  readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled"
  readonly url?: string
  readonly error?: AppError
}

export interface DeploymentHistory {
  readonly runs: readonly DeploymentRun[]
  readonly actionsUrl: string
  readonly liveSiteUrl: string
  readonly unavailableMessage?: string
}

export interface HistoryLinkRequest {
  readonly url: string
}

export interface TrashAdapter {
  trashItem(absolutePath: string): Promise<void>
}

export type PreviewPhase = "stopped" | "starting" | "ready" | "building" | "error" | "stopping"

export interface PreviewStatus {
  readonly state: PreviewPhase
  readonly generation: number
  readonly port?: number
  readonly url?: string
  readonly lastSuccessfulUrl?: string
  readonly error?: AppError
}

export interface BlogRecord {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly canonicalPath: string
  readonly createdAt: string
  readonly lastOpenedAt: string
}

export interface BlogRegistryView {
  readonly version: 1
  readonly activeBlogId: string
  readonly blogs: readonly BlogRecord[]
}

export type BlogCandidateInspection =
  | { readonly valid: true; readonly canonicalPath: string; readonly needsInstall: boolean }
  | { readonly valid: false; readonly code: string; readonly message: string }

export interface BlogCandidateSelection {
  readonly path: string
  readonly inspection: BlogCandidateInspection
}

export interface BlogIdRequest {
  readonly id: string
}

export interface BlogPathRequest {
  readonly path: string
}

export interface BlogAddLocalRequest extends BlogPathRequest {
  readonly name: string
}

export interface BlogCloneRequest {
  readonly url: string
  readonly destination: string
  readonly name: string
}

export interface GitHubRepository {
  readonly url: string
  readonly owner: string
  readonly repository: string
}

const GITHUB_OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
const GITHUB_REPOSITORY_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?"
const GITHUB_HTTPS_REPOSITORY = new RegExp(
  `^https://github\\.com/(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPOSITORY_PATTERN})(?:\\.git)?$`,
)
const GITHUB_SSH_REPOSITORY = new RegExp(
  `^git@github\\.com:(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPOSITORY_PATTERN})(?:\\.git)?$`,
)

/** Parses only literal GitHub clone URLs which are safe as one Git argument. */
export function parseGitHubRepositoryUrl(value: string): GitHubRepository | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 2_048 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f\s]/.test(value)
  ) return undefined
  const match = GITHUB_HTTPS_REPOSITORY.exec(value) ?? GITHUB_SSH_REPOSITORY.exec(value)
  if (!match) return undefined
  const [, owner, matchedRepository] = match
  const repository = matchedRepository.endsWith(".git")
    ? matchedRepository.slice(0, -".git".length)
    : matchedRepository
  return repository && repository !== "." && repository !== ".."
    ? { url: value, owner, repository }
    : undefined
}

export interface BlogImportReceipt {
  readonly canonicalPath: string
  readonly owner: string
  readonly repository: string
}

export interface BlogRenameRequest extends BlogIdRequest {
  readonly name: string
}

export interface BlogRelocateRequest extends BlogIdRequest, BlogPathRequest {}

export interface BlogSwitchRequest extends BlogIdRequest {}

export type BlogImportPhase = "cloning" | "installing" | "validating" | "complete"

export interface BlogImportProgress {
  readonly phase: BlogImportPhase
  readonly message: string
}

export const IPC_CHANNELS = {
  requests: {
    workspaceInspectSafety: "garden:workspace:inspect-safety",
    workspaceInspect: "garden:workspace:inspect",
    workspaceRepair: "garden:workspace:repair",
    notesList: "garden:notes:list",
    notesRead: "garden:notes:read",
    notesSave: "garden:notes:save",
    notesCreate: "garden:notes:create",
    notesRename: "garden:notes:rename",
    notesChangeVisibility: "garden:notes:change-visibility",
    notesTrash: "garden:notes:trash",
    notesRecoveryGet: "garden:notes:recovery:get",
    notesRecoveryWrite: "garden:notes:recovery:write",
    notesRecoveryDiscard: "garden:notes:recovery:discard",
    previewStart: "garden:preview:start",
    previewStop: "garden:preview:stop",
    previewStatus: "garden:preview:status",
    changesList: "garden:changes:list",
    changesCancel: "garden:changes:cancel",
    publishStart: "garden:publish:start",
    publishCancel: "garden:publish:cancel",
    historyGit: "garden:history:git",
    historyDeployments: "garden:history:deployments",
    historyCancel: "garden:history:cancel",
    historyOpenLink: "garden:history:open-link",
    lifecycleCloseAck: "garden:lifecycle:close-ack",
    blogsList: "garden:blogs:list",
    blogsChooseLocal: "garden:blogs:choose-local",
    blogsAddLocal: "garden:blogs:add-local",
    blogsClone: "garden:blogs:clone",
    blogsCancelImport: "garden:blogs:cancel-import",
    blogsInstall: "garden:blogs:install",
    blogsRename: "garden:blogs:rename",
    blogsRelocate: "garden:blogs:relocate",
    blogsRemove: "garden:blogs:remove",
    blogsOpenFolder: "garden:blogs:open-folder",
    blogsSwitch: "garden:blogs:switch",
  },
  events: {
    notesRecovery: "garden:event:notes-recovery",
    previewProgress: "garden:event:preview-progress",
    publishProgress: "garden:event:publish-progress",
    beforeClose: "garden:event:before-close",
    closeBlocked: "garden:event:close-blocked",
    blogsImportProgress: "garden:event:blogs-import-progress",
  },
} as const

export type IpcResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppError }

export interface NotePathRequest {
  readonly path: string
}

export interface NoteDocument extends NotePathRequest {
  readonly markdown: string
  readonly mtimeMs: number
  readonly contentHash: string
}

export interface NoteSaveRequest extends NotePathRequest {
  readonly markdown: string
  readonly expectedMtimeMs: number
  readonly expectedContentHash: string
}

export interface NoteRecoveryWriteRequest extends NotePathRequest {
  readonly markdown: string
  readonly baseMtimeMs: number
  readonly baseContentHash: string
}

export interface NoteRecovery extends NoteRecoveryWriteRequest {
  readonly createdAt: string
  readonly contentHash: string
}

export interface NoteRecoveryReceipt {
  readonly contentHash: string
}

export interface NoteRecoveryDiscardRequest extends NotePathRequest {
  readonly contentHash: string
}

export interface BeforeCloseRequest {
  readonly requestId: string
}

export interface CloseAckRequest extends BeforeCloseRequest {
  readonly success: boolean
}

export interface NoteCreateRequest {
  readonly visibility: Visibility
  readonly domain: NoteSummary["domain"]
  readonly slug: string
  readonly title: string
  readonly date: string
  readonly description: string
  readonly tags: readonly string[]
  readonly body?: string
}

export interface NoteRenameRequest extends NotePathRequest {
  readonly newDomain?: NoteSummary["domain"]
  readonly newSlug?: string
}

export interface NoteVisibilityRequest extends NotePathRequest {
  readonly visibility: Visibility
}

export interface NoteWriteReceipt {
  readonly path: string
  readonly updatedAt: string
  readonly mtimeMs: number
  readonly contentHash: string
  readonly warnings?: readonly {
    readonly code: string
    readonly message: string
  }[]
}

export interface NoteTransactionReceipt {
  readonly id: string
  readonly changedPaths: readonly string[]
  readonly pendingPublicDeletion?: string
  readonly historyWarning: boolean
  readonly warnings: readonly { readonly code: string; readonly message: string }[]
}

export interface NoteTrashReceipt {
  readonly path: string
  readonly pendingPublicDeletion?: string
  readonly historyWarning: boolean
  readonly attachmentCleanup:
    | { readonly status: "trashed" | "not-found" }
    | { readonly status: "retained-ambiguous" | "failed"; readonly message: string }
}

export interface PreviewStartRequest {
  readonly preferredPort?: number
}

export interface PublishCancelRequest {
  readonly operationId: string
}

export interface PublishStartReceipt {
  readonly operationId: string
}

export interface HistoryRequest {
  readonly limit?: number
  readonly requestId?: string
}

export interface HistoryCancelRequest {
  readonly requestId: string
}

export interface GitCommit {
  readonly id: string
  readonly authoredAt: string
  readonly subject: string
  readonly author?: string
}

export type Unsubscribe = () => void

export interface GardenApi {
  readonly blogs: {
    list(): Promise<IpcResult<BlogRegistryView>>
    chooseLocal(): Promise<IpcResult<BlogCandidateSelection | undefined>>
    addLocal(request: BlogAddLocalRequest): Promise<IpcResult<BlogRegistryView>>
    clone(request: BlogCloneRequest): Promise<IpcResult<BlogImportReceipt>>
    cancelImport(): Promise<IpcResult<void>>
    install(request: BlogPathRequest): Promise<IpcResult<BlogCandidateInspection>>
    rename(request: BlogRenameRequest): Promise<IpcResult<BlogRegistryView>>
    relocate(request: BlogRelocateRequest): Promise<IpcResult<BlogRegistryView>>
    remove(request: BlogIdRequest): Promise<IpcResult<BlogRegistryView>>
    openFolder(request: BlogIdRequest): Promise<IpcResult<void>>
    switch(request: BlogSwitchRequest): Promise<IpcResult<void>>
    onImportProgress(listener: (progress: BlogImportProgress) => void): Unsubscribe
  }
  readonly lifecycle: {
    acknowledgeClose(request: CloseAckRequest): Promise<IpcResult<void>>
    onBeforeClose(listener: (request: BeforeCloseRequest) => void): Unsubscribe
    onCloseBlocked(listener: (message: string) => void): Unsubscribe
  }
  readonly workspace: {
    inspectSafety(): Promise<IpcResult<WorkspaceInspection>>
    inspect(): Promise<IpcResult<WorkspaceInspection>>
    repair(request: WorkspaceRepairRequest): Promise<IpcResult<WorkspaceRepairReceipt>>
  }
  readonly notes: {
    onRecovery(listener: (update: TrashRecoveryUpdate) => void): Unsubscribe
    list(): Promise<IpcResult<readonly NoteSummary[]>>
    read(request: NotePathRequest): Promise<IpcResult<NoteDocument>>
    save(request: NoteSaveRequest): Promise<IpcResult<NoteWriteReceipt>>
    create(request: NoteCreateRequest): Promise<IpcResult<NoteWriteReceipt>>
    rename(request: NoteRenameRequest): Promise<IpcResult<NoteTransactionReceipt>>
    changeVisibility(request: NoteVisibilityRequest): Promise<IpcResult<NoteTransactionReceipt>>
    trash(request: NotePathRequest): Promise<IpcResult<NoteTrashReceipt>>
    recovery: {
      get(request: NotePathRequest): Promise<IpcResult<NoteRecovery | undefined>>
      write(request: NoteRecoveryWriteRequest): Promise<IpcResult<NoteRecoveryReceipt>>
      discard(request: NoteRecoveryDiscardRequest): Promise<IpcResult<void>>
    }
  }
  readonly preview: {
    start(request?: PreviewStartRequest): Promise<IpcResult<PreviewStatus>>
    stop(): Promise<IpcResult<PreviewStatus>>
    status(): Promise<IpcResult<PreviewStatus>>
    onProgress(listener: (status: PreviewStatus) => void): Unsubscribe
  }
  readonly changes: {
    list(): Promise<IpcResult<ChangeReview>>
    cancel(): Promise<IpcResult<void>>
  }
  readonly publish: {
    start(request: PublishRequest): Promise<IpcResult<PublishStartReceipt>>
    cancel(request: PublishCancelRequest): Promise<IpcResult<void>>
    onProgress(listener: (progress: PublishProgress) => void): Unsubscribe
  }
  readonly history: {
    git(request?: HistoryRequest): Promise<IpcResult<readonly GitCommit[]>>
    deployments(request?: HistoryRequest): Promise<IpcResult<DeploymentHistory>>
    cancel(request: HistoryCancelRequest): Promise<IpcResult<void>>
    openLink(request: HistoryLinkRequest): Promise<IpcResult<void>>
  }
}

export interface TrashRecoveryUpdate {
  readonly restored: readonly string[]
  readonly conflicts: readonly string[]
}

export const DEFAULT_GARDEN_PATH = String.raw`C:\Users\11546\Desktop\web`
