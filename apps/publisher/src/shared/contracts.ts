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

export type AppError = {
  readonly [Code in AppErrorCode]: {
    readonly code: Code
    readonly message: string
    readonly details?: Readonly<Record<string, SerializableValue>>
  }
}[AppErrorCode]

export type WorkspaceIssue = AppError & {
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
  readonly title: string
  readonly visibility: Visibility
  readonly modifiedAt: string
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
