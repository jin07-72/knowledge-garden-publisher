export type Visibility = "public" | "private"

export type SerializableValue =
  | null
  | boolean
  | number
  | string
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue }

export type AppErrorCode =
  | "INVALID_INPUT"
  | "INVALID_WORKSPACE"
  | "CONTENT_MISSING"
  | "CONTENT_NOT_DIRECTORY"
  | "PRIVATE_MISSING"
  | "PRIVATE_NOT_DIRECTORY"
  | "SCRIPTS_MISSING"
  | "SCRIPTS_NOT_DIRECTORY"
  | "PACKAGE_LOCK_MISSING"
  | "PACKAGE_LOCK_NOT_FILE"
  | "QUARTZ_CONFIG_MISSING"
  | "QUARTZ_CONFIG_NOT_FILE"
  | "VALIDATE_CONTENT_MISSING"
  | "VALIDATE_CONTENT_NOT_FILE"
  | "UNSAFE_PATH"
  | "WORKSPACE_ACCESS_FAILED"
  | "GIT_UNAVAILABLE"
  | "GIT_NOT_REPOSITORY"
  | "GIT_ROOT_MISMATCH"
  | "GIT_ORIGIN_MISSING"
  | "GIT_ORIGIN_FAILED"
  | "GIT_STATUS_FAILED"
  | "COMMAND_FAILED"
  | "COMMAND_CANCELLED"
  | "NOTE_INDEX_INVALID"
  | "NOTE_INDEX_UNSAFE_PATH"
  | "NOTE_INDEX_ACCESS_FAILED"
  | "NOTE_INDEX_DUPLICATE"
  | "NOTE_INDEX_CHANGED"
  | "NOTE_FILE_INVALID"
  | "NOTE_FILE_UNSAFE_PATH"
  | "NOTE_FILE_ACCESS_FAILED"
  | "NOTE_FILE_WRITE_FAILED"
  | "NOTE_FILE_COMMIT_UNCERTAIN"
  | "NOTE_FILE_LOCKED"
  | "NOTE_ALREADY_EXISTS"
  | "EXTERNAL_EDIT"
  | "RECOVERY_NOT_FOUND"
  | "RECOVERY_INVALID"
  | "RECOVERY_CONFLICT"
  | "RECOVERY_DISCARD_FAILED"
  | "TRANSACTION_PLAN_BLOCKED"
  | "TRANSACTION_PLAN_INVALID"
  | "TRANSACTION_PLAN_TOO_LARGE"
  | "TRANSACTION_JOURNAL_TOO_LARGE"
  | "TRANSACTION_STALE"
  | "TRANSACTION_COLLISION"
  | "TRANSACTION_LOCKED"
  | "TRANSACTION_PENDING"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_UNCERTAIN"
  | "RUNTIME_MISSING"
  | "QUARTZ_MISSING"
  | "WORKSPACE_INVALID"
  | "PORT_UNAVAILABLE"
  | "PREVIEW_TIMEOUT"
  | "PREVIEW_BUILD_FAILED"
  | "PREVIEW_START_FAILED"
  | "PREVIEW_EXITED"
  | "PREVIEW_STOP_FAILED"
  | "IPC_UNAUTHORIZED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR"

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

export type WorkspaceIssue = Exclude<
  AppError,
  NoteIndexError | NoteFileError | PreviewError | BridgeError
> & {
  readonly path?: string
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

export interface ChangeGroup {
  readonly id: string
  readonly label: string
  readonly paths: readonly string[]
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
  readonly startedAt: string
  readonly completedAt?: string
  readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled"
  readonly url?: string
  readonly error?: AppError
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

export const IPC_CHANNELS = {
  requests: {
    workspaceInspect: "garden:workspace:inspect",
    notesList: "garden:notes:list",
    notesRead: "garden:notes:read",
    notesSave: "garden:notes:save",
    notesCreate: "garden:notes:create",
    notesRename: "garden:notes:rename",
    notesChangeVisibility: "garden:notes:change-visibility",
    notesTrash: "garden:notes:trash",
    previewStart: "garden:preview:start",
    previewStop: "garden:preview:stop",
    previewStatus: "garden:preview:status",
    changesList: "garden:changes:list",
    publishStart: "garden:publish:start",
    publishCancel: "garden:publish:cancel",
    historyGit: "garden:history:git",
    historyDeployments: "garden:history:deployments",
  },
  events: {
    previewProgress: "garden:event:preview-progress",
    publishProgress: "garden:event:publish-progress",
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
}

export interface GitCommit {
  readonly id: string
  readonly authoredAt: string
  readonly subject: string
  readonly author?: string
}

export type Unsubscribe = () => void

export interface GardenApi {
  readonly workspace: {
    inspect(): Promise<IpcResult<WorkspaceInspection>>
  }
  readonly notes: {
    list(): Promise<IpcResult<readonly NoteSummary[]>>
    read(request: NotePathRequest): Promise<IpcResult<NoteDocument>>
    save(request: NoteSaveRequest): Promise<IpcResult<NoteWriteReceipt>>
    create(request: NoteCreateRequest): Promise<IpcResult<NoteWriteReceipt>>
    rename(request: NoteRenameRequest): Promise<IpcResult<NoteTransactionReceipt>>
    changeVisibility(request: NoteVisibilityRequest): Promise<IpcResult<NoteTransactionReceipt>>
    trash(request: NotePathRequest): Promise<IpcResult<NoteTrashReceipt>>
  }
  readonly preview: {
    start(request?: PreviewStartRequest): Promise<IpcResult<PreviewStatus>>
    stop(): Promise<IpcResult<PreviewStatus>>
    status(): Promise<IpcResult<PreviewStatus>>
    onProgress(listener: (status: PreviewStatus) => void): Unsubscribe
  }
  readonly changes: {
    list(): Promise<IpcResult<readonly ChangeGroup[]>>
  }
  readonly publish: {
    start(request: PublishRequest): Promise<IpcResult<PublishStartReceipt>>
    cancel(request: PublishCancelRequest): Promise<IpcResult<void>>
    onProgress(listener: (progress: PublishProgress) => void): Unsubscribe
  }
  readonly history: {
    git(request?: HistoryRequest): Promise<IpcResult<readonly GitCommit[]>>
    deployments(request?: HistoryRequest): Promise<IpcResult<readonly DeploymentRun[]>>
  }
}

export const DEFAULT_GARDEN_PATH = String.raw`C:\Users\11546\Desktop\web`
