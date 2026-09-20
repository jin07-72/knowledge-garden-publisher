export type Visibility = "public" | "private"

export type SerializableValue =
  | null
  | boolean
  | number
  | string
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue }

export type AppErrorCode =
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
      `NOTE_FILE_${string}` | "NOTE_ALREADY_EXISTS" | "EXTERNAL_EDIT" | `RECOVERY_${string}`
  }
>

export type WorkspaceIssue = Exclude<AppError, NoteIndexError | NoteFileError> & {
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

export const DEFAULT_GARDEN_PATH = String.raw`C:\Users\11546\Desktop\web`
