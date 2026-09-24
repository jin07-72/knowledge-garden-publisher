import { z } from "zod"
import {
  IPC_CHANNELS,
  type AppError,
  type ChangeGroup,
  type DeploymentRun,
  type GitCommit,
  type HistoryRequest,
  type IpcResult,
  type NoteCreateRequest,
  type NoteDocument,
  type NotePathRequest,
  type NoteRenameRequest,
  type NoteSaveRequest,
  type NoteSummary,
  type NoteTransactionReceipt,
  type NoteTrashReceipt,
  type NoteVisibilityRequest,
  type NoteWriteReceipt,
  type PreviewStartRequest,
  type PreviewStatus,
  type PublishCancelRequest,
  type PublishProgress,
  type PublishRequest,
  type PublishStartReceipt,
  type WorkspaceInspection,
} from "../shared/contracts"

type RequestHandler = (event: unknown, request?: unknown) => Promise<unknown>

export interface IpcMainPort {
  handle(channel: string, handler: RequestHandler): void
  removeHandler(channel: string): void
}

export interface IpcEventTarget {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

export interface PublisherIpcServices {
  readonly workspace: {
    inspect(): Promise<WorkspaceInspection>
  }
  readonly notes: {
    list(): Promise<readonly NoteSummary[]>
    read(request: NotePathRequest): Promise<NoteDocument>
    save(request: NoteSaveRequest): Promise<NoteWriteReceipt>
    create(request: NoteCreateRequest): Promise<NoteWriteReceipt>
    rename(request: NoteRenameRequest): Promise<NoteTransactionReceipt>
    changeVisibility(request: NoteVisibilityRequest): Promise<NoteTransactionReceipt>
    trash(request: NotePathRequest): Promise<NoteTrashReceipt>
  }
  readonly preview: {
    start(request: PreviewStartRequest): Promise<PreviewStatus>
    stop(): Promise<PreviewStatus>
    status(): Promise<PreviewStatus> | PreviewStatus
    subscribe(listener: (status: PreviewStatus) => void): () => void
  }
  readonly changes: {
    list(): Promise<readonly ChangeGroup[]>
  }
  readonly publish: {
    start(request: PublishRequest): Promise<PublishStartReceipt>
    cancel(request: PublishCancelRequest): Promise<void>
    subscribe(listener: (progress: PublishProgress) => void): () => void
  }
  readonly history: {
    git(request: HistoryRequest): Promise<readonly GitCommit[]>
    deployments(request: HistoryRequest): Promise<readonly DeploymentRun[]>
  }
}

export interface RegisterPublisherIpcOptions {
  readonly ipcMain: IpcMainPort
  readonly services: PublisherIpcServices
  readonly isTrustedSender: (event: unknown) => boolean
  readonly eventTargets: () => readonly IpcEventTarget[]
}

function bestEffortCleanup(actions: readonly (() => void)[]): void {
  for (const action of [...actions].reverse()) {
    try {
      action()
    } catch {
      // Teardown must continue so one faulty adapter cannot leave privileged handlers active.
    }
  }
}

const appErrorCodes = [
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
  "GIT_STATUS_FAILED",
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
] as const satisfies readonly AppError["code"][]

const serializableSchema = z.json()
const appErrorSchema = z
  .object({
    code: z.enum(appErrorCodes),
    message: z.string().min(1).max(1_000),
    details: z.record(z.string(), serializableSchema).optional(),
  })
  .strict()

const noRequestSchema = z.undefined()
const notePathSchema = z
  .string()
  .max(512)
  .regex(
    /^(?:content|private)\/(?:technology|reading|language|life)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
  )
const notePathRequestSchema = z.object({ path: notePathSchema }).strict()
const domainSchema = z.enum(["technology", "reading", "language", "life"])
const slugSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const visibilitySchema = z.enum(["public", "private"])
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const noteSaveSchema = z
  .object({
    path: notePathSchema,
    markdown: z.string().max(16 * 1024 * 1024),
    expectedMtimeMs: z.number().finite().nonnegative(),
    expectedContentHash: hashSchema,
  })
  .strict()
const noteCreateSchema = z
  .object({
    visibility: visibilitySchema,
    domain: domainSchema,
    slug: slugSchema,
    title: z.string().trim().min(1).max(256),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().trim().min(1).max(2_000),
    tags: z.array(z.string().trim().min(1).max(128)).max(100),
    body: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
  })
  .strict()
const noteRenameSchema = z
  .object({
    path: notePathSchema,
    newDomain: domainSchema.optional(),
    newSlug: slugSchema.optional(),
  })
  .strict()
  .refine((request) => request.newDomain !== undefined || request.newSlug !== undefined)
const noteVisibilitySchema = z
  .object({ path: notePathSchema, visibility: visibilitySchema })
  .strict()
const previewStartSchema = z
  .object({ preferredPort: z.number().int().min(1).max(65_535).optional() })
  .strict()
  .optional()
  .transform((request) => request ?? {})
const opaqueIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
const publishRequestSchema = z
  .object({
    changeGroupIds: z.array(opaqueIdSchema).min(1).max(1_000),
    message: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
const publishCancelSchema = z.object({ operationId: opaqueIdSchema }).strict()
const historySchema = z
  .object({ limit: z.number().int().min(1).max(500).optional() })
  .strict()
  .optional()
  .transform((request) => request ?? {})

const loopbackUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return url.protocol === "http:" && url.hostname === "127.0.0.1"
  })
const previewStatusSchema = z
  .object({
    state: z.enum(["stopped", "starting", "ready", "building", "error", "stopping"]),
    generation: z.number().int().nonnegative(),
    port: z.number().int().min(1).max(65_535).optional(),
    url: loopbackUrlSchema.optional(),
    lastSuccessfulUrl: loopbackUrlSchema.optional(),
    error: appErrorSchema.optional(),
  })
  .strict()
const publishProgressSchema = z
  .object({
    phase: z.enum(["validating", "committing", "pushing", "deploying", "complete", "failed"]),
    message: z.string().max(2_000),
    percent: z.number().min(0).max(100).optional(),
  })
  .strict()

function invalidInput(): IpcResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", message: "The request is invalid." } }
}

function unauthorized(): IpcResult<never> {
  return {
    ok: false,
    error: { code: "IPC_UNAUTHORIZED", message: "This application window is not authorized." },
  }
}

function serializeFailure(error: unknown): IpcResult<never> {
  const parsed = appErrorSchema.safeParse(error)
  if (parsed.success) return { ok: false, error: parsed.data as AppError }
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "The application could not complete the request." },
  }
}

function senderIsLive(event: unknown): boolean {
  if (typeof event !== "object" || event === null || !("sender" in event)) return false
  const sender = (event as { readonly sender?: unknown }).sender
  if (typeof sender !== "object" || sender === null || !("isDestroyed" in sender)) return false
  const isDestroyed = (sender as { readonly isDestroyed?: unknown }).isDestroyed
  if (typeof isDestroyed !== "function") return false
  try {
    return !isDestroyed.call(sender)
  } catch {
    return false
  }
}

function secureHandler<Input, Output>(
  schema: z.ZodType<Input>,
  authorize: (event: unknown) => boolean,
  operation: (input: Input) => Promise<Output> | Output,
): RequestHandler {
  return async (event, request): Promise<IpcResult<Output>> => {
    if (!senderIsLive(event) || !authorize(event)) return unauthorized()
    const parsed = schema.safeParse(request)
    if (!parsed.success) return invalidInput()
    try {
      return { ok: true, value: await operation(parsed.data) }
    } catch (error) {
      return serializeFailure(error)
    }
  }
}

/** Registers the complete and finite publisher IPC surface and returns an idempotent disposer. */
export function registerPublisherIpc(options: RegisterPublisherIpcOptions): () => void {
  const { ipcMain, services, isTrustedSender, eventTargets } = options
  const handlers: ReadonlyArray<readonly [string, RequestHandler]> = [
    [
      IPC_CHANNELS.requests.workspaceInspect,
      secureHandler(noRequestSchema, isTrustedSender, () => services.workspace.inspect()),
    ],
    [
      IPC_CHANNELS.requests.notesList,
      secureHandler(noRequestSchema, isTrustedSender, () => services.notes.list()),
    ],
    [
      IPC_CHANNELS.requests.notesRead,
      secureHandler(notePathRequestSchema, isTrustedSender, (request) =>
        services.notes.read(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesSave,
      secureHandler(noteSaveSchema, isTrustedSender, (request) => services.notes.save(request)),
    ],
    [
      IPC_CHANNELS.requests.notesCreate,
      secureHandler(noteCreateSchema, isTrustedSender, (request) => services.notes.create(request)),
    ],
    [
      IPC_CHANNELS.requests.notesRename,
      secureHandler(noteRenameSchema, isTrustedSender, (request) => services.notes.rename(request)),
    ],
    [
      IPC_CHANNELS.requests.notesChangeVisibility,
      secureHandler(noteVisibilitySchema, isTrustedSender, (request) =>
        services.notes.changeVisibility(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesTrash,
      secureHandler(notePathRequestSchema, isTrustedSender, (request) =>
        services.notes.trash(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.previewStart,
      secureHandler(previewStartSchema, isTrustedSender, (request) =>
        services.preview.start(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.previewStop,
      secureHandler(noRequestSchema, isTrustedSender, () => services.preview.stop()),
    ],
    [
      IPC_CHANNELS.requests.previewStatus,
      secureHandler(noRequestSchema, isTrustedSender, () => services.preview.status()),
    ],
    [
      IPC_CHANNELS.requests.changesList,
      secureHandler(noRequestSchema, isTrustedSender, () => services.changes.list()),
    ],
    [
      IPC_CHANNELS.requests.publishStart,
      secureHandler(publishRequestSchema, isTrustedSender, (request) =>
        services.publish.start(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.publishCancel,
      secureHandler(publishCancelSchema, isTrustedSender, (request) =>
        services.publish.cancel(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.historyGit,
      secureHandler(historySchema, isTrustedSender, (request) => services.history.git(request)),
    ],
    [
      IPC_CHANNELS.requests.historyDeployments,
      secureHandler(historySchema, isTrustedSender, (request) =>
        services.history.deployments(request),
      ),
    ],
  ]

  const registered: string[] = []
  const subscriptions: Array<() => void> = []
  const broadcast = (channel: string, schema: z.ZodType, payload: unknown): void => {
    const parsed = schema.safeParse(payload)
    if (!parsed.success) return
    for (const target of eventTargets()) {
      try {
        if (!target.isDestroyed()) target.send(channel, parsed.data)
      } catch {
        // A closing window cannot block delivery to another live application window.
      }
    }
  }

  try {
    for (const [channel, handler] of handlers) {
      ipcMain.handle(channel, handler)
      registered.push(channel)
    }
    subscriptions.push(
      services.preview.subscribe((status) =>
        broadcast(IPC_CHANNELS.events.previewProgress, previewStatusSchema, status),
      ),
    )
    subscriptions.push(
      services.publish.subscribe((progress) =>
        broadcast(IPC_CHANNELS.events.publishProgress, publishProgressSchema, progress),
      ),
    )
  } catch (error) {
    bestEffortCleanup([
      ...registered.map((channel) => () => ipcMain.removeHandler(channel)),
      ...subscriptions,
    ])
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    bestEffortCleanup([
      ...registered.map((channel) => () => ipcMain.removeHandler(channel)),
      ...subscriptions,
    ])
  }
}

export function unavailableService(name: string): never {
  throw {
    code: "SERVICE_UNAVAILABLE",
    message: `${name} is not available in this version yet.`,
  } satisfies AppError
}
