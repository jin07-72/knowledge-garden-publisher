import { z } from "zod"
import {
  IPC_CHANNELS,
  type ChangeReview,
  type CloseAckRequest,
  type DeploymentRun,
  type GitCommit,
  type HistoryRequest,
  type IpcResult,
  type NoteCreateRequest,
  type NoteDocument,
  type NotePathRequest,
  type NoteRenameRequest,
  type NoteRecovery,
  type NoteRecoveryDiscardRequest,
  type NoteRecoveryReceipt,
  type NoteRecoveryWriteRequest,
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
import {
  IPC_SUCCESS_SCHEMAS,
  appErrorSchema,
  markdownSchema,
  previewProgressSchema,
  publishProgressSchema,
} from "../shared/ipcSchemas"

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
    recovery: {
      get(request: NotePathRequest): Promise<NoteRecovery | undefined>
      write(request: NoteRecoveryWriteRequest): Promise<NoteRecoveryReceipt>
      discard(request: NoteRecoveryDiscardRequest): Promise<void>
    }
  }
  readonly preview: {
    start(request: PreviewStartRequest): Promise<PreviewStatus>
    stop(): Promise<PreviewStatus>
    status(): Promise<PreviewStatus> | PreviewStatus
    subscribe(listener: (status: PreviewStatus) => void): () => void
  }
  readonly changes: {
    list(): Promise<ChangeReview>
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
  readonly acknowledgeClose?: (request: CloseAckRequest) => void
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
    markdown: markdownSchema,
    expectedMtimeMs: z.number().finite().nonnegative(),
    expectedContentHash: hashSchema,
  })
  .strict()
const noteRecoveryWriteSchema = z
  .object({
    path: notePathSchema,
    markdown: markdownSchema,
    baseMtimeMs: z.number().finite().nonnegative(),
    baseContentHash: hashSchema,
  })
  .strict()
const noteRecoveryDiscardSchema = z
  .object({ path: notePathSchema, contentHash: hashSchema })
  .strict()
const noteCreateSchema = z
  .object({
    visibility: visibilitySchema,
    domain: domainSchema,
    slug: slugSchema,
    title: z.string().trim().min(1).max(256),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().trim().min(1).max(2_000),
    tags: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
    body: markdownSchema.optional(),
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
  .refine((request) => new Set(request.changeGroupIds).size === request.changeGroupIds.length)
const publishCancelSchema = z.object({ operationId: opaqueIdSchema }).strict()
const historySchema = z
  .object({ limit: z.number().int().min(1).max(500).optional() })
  .strict()
  .optional()
  .transform((request) => request ?? {})
const closeAckSchema = z.object({ requestId: z.string().uuid(), success: z.boolean() }).strict()

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
  try {
    const parsed = appErrorSchema.safeParse(error)
    if (parsed.success) return { ok: false, error: parsed.data }
  } catch {
    // Hostile getters and cyclic values are never allowed to escape the bridge.
  }
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
  channel: keyof typeof IPC_SUCCESS_SCHEMAS,
  schema: z.ZodType<Input>,
  authorize: (event: unknown) => boolean,
  operation: (input: Input) => Promise<Output> | Output,
): RequestHandler {
  return async (event, request): Promise<IpcResult<Output>> => {
    try {
      if (!senderIsLive(event) || !authorize(event)) return unauthorized()
    } catch {
      return unauthorized()
    }
    let parsed: z.ZodSafeParseResult<Input>
    try {
      parsed = schema.safeParse(request)
    } catch {
      return invalidInput()
    }
    if (!parsed.success) return invalidInput()
    try {
      const output = IPC_SUCCESS_SCHEMAS[channel].safeParse(await operation(parsed.data))
      if (!output.success) return serializeFailure(undefined)
      return { ok: true, value: output.data as Output }
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
      IPC_CHANNELS.requests.lifecycleCloseAck,
      secureHandler(
        IPC_CHANNELS.requests.lifecycleCloseAck,
        closeAckSchema,
        isTrustedSender,
        (request) => options.acknowledgeClose?.(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.workspaceInspect,
      secureHandler(IPC_CHANNELS.requests.workspaceInspect, noRequestSchema, isTrustedSender, () =>
        services.workspace.inspect(),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesList,
      secureHandler(IPC_CHANNELS.requests.notesList, noRequestSchema, isTrustedSender, () =>
        services.notes.list(),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesRead,
      secureHandler(
        IPC_CHANNELS.requests.notesRead,
        notePathRequestSchema,
        isTrustedSender,
        (request) => services.notes.read(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesSave,
      secureHandler(IPC_CHANNELS.requests.notesSave, noteSaveSchema, isTrustedSender, (request) =>
        services.notes.save(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesCreate,
      secureHandler(
        IPC_CHANNELS.requests.notesCreate,
        noteCreateSchema,
        isTrustedSender,
        (request) => services.notes.create(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesRename,
      secureHandler(
        IPC_CHANNELS.requests.notesRename,
        noteRenameSchema,
        isTrustedSender,
        (request) => services.notes.rename(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesChangeVisibility,
      secureHandler(
        IPC_CHANNELS.requests.notesChangeVisibility,
        noteVisibilitySchema,
        isTrustedSender,
        (request) => services.notes.changeVisibility(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesTrash,
      secureHandler(
        IPC_CHANNELS.requests.notesTrash,
        notePathRequestSchema,
        isTrustedSender,
        (request) => services.notes.trash(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesRecoveryGet,
      secureHandler(
        IPC_CHANNELS.requests.notesRecoveryGet,
        notePathRequestSchema,
        isTrustedSender,
        (request) => services.notes.recovery.get(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesRecoveryWrite,
      secureHandler(
        IPC_CHANNELS.requests.notesRecoveryWrite,
        noteRecoveryWriteSchema,
        isTrustedSender,
        (request) => services.notes.recovery.write(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.notesRecoveryDiscard,
      secureHandler(
        IPC_CHANNELS.requests.notesRecoveryDiscard,
        noteRecoveryDiscardSchema,
        isTrustedSender,
        (request) => services.notes.recovery.discard(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.previewStart,
      secureHandler(
        IPC_CHANNELS.requests.previewStart,
        previewStartSchema,
        isTrustedSender,
        (request) => services.preview.start(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.previewStop,
      secureHandler(IPC_CHANNELS.requests.previewStop, noRequestSchema, isTrustedSender, () =>
        services.preview.stop(),
      ),
    ],
    [
      IPC_CHANNELS.requests.previewStatus,
      secureHandler(IPC_CHANNELS.requests.previewStatus, noRequestSchema, isTrustedSender, () =>
        services.preview.status(),
      ),
    ],
    [
      IPC_CHANNELS.requests.changesList,
      secureHandler(IPC_CHANNELS.requests.changesList, noRequestSchema, isTrustedSender, () =>
        services.changes.list(),
      ),
    ],
    [
      IPC_CHANNELS.requests.publishStart,
      secureHandler(
        IPC_CHANNELS.requests.publishStart,
        publishRequestSchema,
        isTrustedSender,
        (request) => services.publish.start(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.publishCancel,
      secureHandler(
        IPC_CHANNELS.requests.publishCancel,
        publishCancelSchema,
        isTrustedSender,
        (request) => services.publish.cancel(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.historyGit,
      secureHandler(IPC_CHANNELS.requests.historyGit, historySchema, isTrustedSender, (request) =>
        services.history.git(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.historyDeployments,
      secureHandler(
        IPC_CHANNELS.requests.historyDeployments,
        historySchema,
        isTrustedSender,
        (request) => services.history.deployments(request),
      ),
    ],
  ]

  const registered: string[] = []
  const subscriptions: Array<() => void> = []
  const broadcast = (channel: string, schema: z.ZodType, payload: unknown): void => {
    let parsed
    try {
      parsed = schema.safeParse(payload)
    } catch {
      return
    }
    if (!parsed.success) return
    let targets: readonly IpcEventTarget[]
    try {
      targets = eventTargets()
    } catch {
      return
    }
    for (const target of targets) {
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
        broadcast(IPC_CHANNELS.events.previewProgress, previewProgressSchema, status),
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
