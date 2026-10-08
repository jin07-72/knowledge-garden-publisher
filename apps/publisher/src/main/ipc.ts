import { z } from "zod"
import {
  IPC_CHANNELS,
  MANAGED_NOTE_PATH_PATTERN,
  type AppError,
  type BlogAddLocalRequest,
  type BlogCandidateInspection,
  type BlogCandidateSelection,
  type BlogCloneRequest,
  type BlogIdRequest,
  type BlogImportProgress,
  type BlogImportReceipt,
  type BlogPathRequest,
  type BlogRegistryView,
  type BlogRegistryStatus,
  type BlogRelocateRequest,
  type BlogRenameRequest,
  type BlogSwitchRequest,
  type ChangeReview,
  type CloseAckRequest,
  type DeploymentHistory,
  type DomainCreateRequest,
  type DomainRemoveRequest,
  type DomainRenameRequest,
  type DomainSummary,
  type GitCommit,
  type HistoryCancelRequest,
  type HistoryRequest,
  type HistoryLinkRequest,
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
  type WorkspaceRepairReceipt,
  type WorkspaceRepairRequest,
  type TrashRecoveryUpdate,
} from "../shared/contracts"
import {
  IPC_SUCCESS_SCHEMAS,
  appErrorSchema,
  blogAddLocalRequestSchema,
  blogCloneRequestSchema,
  blogIdRequestSchema,
  blogImportProgressSchema,
  blogPathRequestSchema,
  blogRelocateRequestSchema,
  blogRenameRequestSchema,
  blogSwitchRequestSchema,
  domainCreateSchema,
  domainRemoveSchema,
  domainRenameSchema,
  domainSlugSchema,
  markdownSchema,
  previewProgressSchema,
  publishProgressSchema,
  trashRecoveryUpdateSchema,
} from "../shared/ipcSchemas"
import { BlogImportError, type BlogImportErrorCode } from "./services/blogImport"

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
    inspectSafety(): Promise<WorkspaceInspection>
    inspect(): Promise<WorkspaceInspection>
    repair(request: WorkspaceRepairRequest): Promise<WorkspaceRepairReceipt>
  }
  readonly domains: {
    list(): Promise<readonly DomainSummary[]>
    create(request: DomainCreateRequest): Promise<readonly DomainSummary[]>
    rename(request: DomainRenameRequest): Promise<readonly DomainSummary[]>
    remove(request: DomainRemoveRequest): Promise<readonly DomainSummary[]>
  }
  readonly notes: {
    subscribeRecovery(listener: (update: TrashRecoveryUpdate) => void): () => void
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
    cancel(): Promise<void>
  }
  readonly publish: {
    start(request: PublishRequest): Promise<PublishStartReceipt>
    cancel(request: PublishCancelRequest): Promise<void>
    subscribe(listener: (progress: PublishProgress) => void): () => void
  }
  readonly history: {
    git(request: HistoryRequest): Promise<readonly GitCommit[]>
    deployments(request: HistoryRequest): Promise<DeploymentHistory>
    cancel(request: HistoryCancelRequest): Promise<void>
    openLink(request: HistoryLinkRequest): Promise<void>
  }
  readonly blogs?: {
    list(): Promise<BlogRegistryStatus>
    chooseLocal(): Promise<BlogCandidateSelection | undefined>
    addLocal(request: BlogAddLocalRequest): Promise<BlogRegistryView>
    recoverLocal(request: BlogAddLocalRequest): Promise<BlogRegistryView>
    clone(request: BlogCloneRequest): Promise<BlogImportReceipt>
    cancelImport(): Promise<void>
    install(request: BlogPathRequest): Promise<BlogCandidateInspection>
    rename(request: BlogRenameRequest): Promise<BlogRegistryView>
    relocate(request: BlogRelocateRequest): Promise<BlogRegistryView>
    remove(request: BlogIdRequest): Promise<BlogRegistryView>
    openFolder(request: BlogIdRequest): Promise<void>
    switch(request: BlogSwitchRequest): Promise<void>
    subscribeProgress(listener: (progress: BlogImportProgress) => void): () => void
  }
}

export interface RegisterPublisherIpcOptions {
  readonly ipcMain: IpcMainPort
  readonly services: PublisherIpcServices
  readonly isTrustedSender: (event: unknown) => boolean
  readonly eventTargets: () => readonly IpcEventTarget[]
  readonly includeBlogManagement?: boolean
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
const workspaceRepairSchema = z.object({ action: z.literal("install-dependencies") }).strict()
const notePathSchema = z.string().max(512).regex(MANAGED_NOTE_PATH_PATTERN)
const notePathRequestSchema = z.object({ path: notePathSchema }).strict()
const domainSchema = domainSlugSchema
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
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    requestId: opaqueIdSchema.optional(),
  })
  .strict()
  .optional()
  .transform((request) => request ?? {})
const historyCancelSchema = z.object({ requestId: opaqueIdSchema }).strict()
const historyLinkSchema = z.object({ url: z.string().url().max(2_048) }).strict()
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

const blogServiceUnavailable: AppError = {
  code: "SERVICE_UNAVAILABLE",
  message: "Blog management is not available.",
}

function serviceUnavailable(): never {
  throw blogServiceUnavailable
}

const blogImportFailureMap: ReadonlyMap<BlogImportErrorCode, AppError> = new Map([
  [
    "DESTINATION_EXISTS",
    { code: "BLOG_DESTINATION_EXISTS", message: "The destination already exists." },
  ],
  [
    "DESTINATION_INVALID",
    { code: "BLOG_DESTINATION_INVALID", message: "The selected destination is unavailable." },
  ],
  [
    "TARGET_CHANGED",
    { code: "BLOG_TARGET_CHANGED", message: "The selected destination changed unexpectedly." },
  ],
  [
    "IMPORT_ACTIVE",
    { code: "BLOG_IMPORT_ACTIVE", message: "Another blog import is already running." },
  ],
  ["CANCELLED", { code: "BLOG_IMPORT_CANCELLED", message: "Blog import was cancelled." }],
  [
    "CLONE_FAILED",
    { code: "BLOG_CLONE_FAILED", message: "Git could not clone the blog repository." },
  ],
  [
    "INSTALL_FAILED",
    { code: "BLOG_INSTALL_FAILED", message: "Blog dependencies could not be installed." },
  ],
  [
    "VALIDATION_FAILED",
    { code: "BLOG_VALIDATION_FAILED", message: "The blog could not be validated." },
  ],
  [
    "IMPORT_UNAVAILABLE",
    { code: "BLOG_IMPORT_UNAVAILABLE", message: "Blog import requires an application restart." },
  ],
  ["INVALID_REPOSITORY_URL", { code: "INVALID_INPUT", message: "The request is invalid." }],
])

function serializeFailure(error: unknown, isBlogImportChannel = false): IpcResult<never> {
  if (isBlogImportChannel) {
    if (error === blogServiceUnavailable) return { ok: false, error: blogServiceUnavailable }
    if (error instanceof BlogImportError) {
      const mapped = blogImportFailureMap.get(error.code)
      if (mapped) return { ok: false, error: mapped }
    }
    try {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "BLOG_SWITCH_BUSY"
      ) {
        return {
          ok: false,
          error: {
            code: "BLOG_SWITCH_BUSY",
            message: "Finish the current publication task before switching blogs.",
          },
        }
      }
    } catch {
      // Hostile getters never cross the privileged boundary.
    }
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application could not complete the request." },
    }
  }
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
      return serializeFailure(error, channel.startsWith("garden:blogs:"))
    }
  }
}

type BlogManagementIpcServices = NonNullable<PublisherIpcServices["blogs"]>

function blogRequestHandlers(
  services: BlogManagementIpcServices,
  isTrustedSender: (event: unknown) => boolean,
): ReadonlyArray<readonly [string, RequestHandler]> {
  return [
    [
      IPC_CHANNELS.requests.blogsList,
      secureHandler(IPC_CHANNELS.requests.blogsList, noRequestSchema, isTrustedSender, () =>
        services.list(),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsChooseLocal,
      secureHandler(IPC_CHANNELS.requests.blogsChooseLocal, noRequestSchema, isTrustedSender, () =>
        services.chooseLocal(),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsAddLocal,
      secureHandler(
        IPC_CHANNELS.requests.blogsAddLocal,
        blogAddLocalRequestSchema,
        isTrustedSender,
        (request) => services.addLocal(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsRecoverLocal,
      secureHandler(
        IPC_CHANNELS.requests.blogsRecoverLocal,
        blogAddLocalRequestSchema,
        isTrustedSender,
        (request) => services.recoverLocal(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsClone,
      secureHandler(
        IPC_CHANNELS.requests.blogsClone,
        blogCloneRequestSchema,
        isTrustedSender,
        (request) => services.clone(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsCancelImport,
      secureHandler(IPC_CHANNELS.requests.blogsCancelImport, noRequestSchema, isTrustedSender, () =>
        services.cancelImport(),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsInstall,
      secureHandler(
        IPC_CHANNELS.requests.blogsInstall,
        blogPathRequestSchema,
        isTrustedSender,
        (request) => services.install(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsRename,
      secureHandler(
        IPC_CHANNELS.requests.blogsRename,
        blogRenameRequestSchema,
        isTrustedSender,
        (request) => services.rename(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsRelocate,
      secureHandler(
        IPC_CHANNELS.requests.blogsRelocate,
        blogRelocateRequestSchema,
        isTrustedSender,
        (request) => services.relocate(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsRemove,
      secureHandler(
        IPC_CHANNELS.requests.blogsRemove,
        blogIdRequestSchema,
        isTrustedSender,
        (request) => services.remove(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsOpenFolder,
      secureHandler(
        IPC_CHANNELS.requests.blogsOpenFolder,
        blogIdRequestSchema,
        isTrustedSender,
        (request) => services.openFolder(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsSwitch,
      secureHandler(
        IPC_CHANNELS.requests.blogsSwitch,
        blogSwitchRequestSchema,
        isTrustedSender,
        (request) => services.switch(request),
      ),
    ],
  ]
}

function unavailableBlogRequestHandlers(
  isTrustedSender: (event: unknown) => boolean,
): ReadonlyArray<readonly [string, RequestHandler]> {
  return [
    [
      IPC_CHANNELS.requests.blogsList,
      secureHandler(
        IPC_CHANNELS.requests.blogsList,
        noRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsChooseLocal,
      secureHandler(
        IPC_CHANNELS.requests.blogsChooseLocal,
        noRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsAddLocal,
      secureHandler(
        IPC_CHANNELS.requests.blogsAddLocal,
        blogAddLocalRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsRecoverLocal,
      secureHandler(
        IPC_CHANNELS.requests.blogsRecoverLocal,
        blogAddLocalRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsClone,
      secureHandler(
        IPC_CHANNELS.requests.blogsClone,
        blogCloneRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsCancelImport,
      secureHandler(
        IPC_CHANNELS.requests.blogsCancelImport,
        noRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsInstall,
      secureHandler(
        IPC_CHANNELS.requests.blogsInstall,
        blogPathRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsRename,
      secureHandler(
        IPC_CHANNELS.requests.blogsRename,
        blogRenameRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsRelocate,
      secureHandler(
        IPC_CHANNELS.requests.blogsRelocate,
        blogRelocateRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsRemove,
      secureHandler(
        IPC_CHANNELS.requests.blogsRemove,
        blogIdRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsOpenFolder,
      secureHandler(
        IPC_CHANNELS.requests.blogsOpenFolder,
        blogIdRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
    [
      IPC_CHANNELS.requests.blogsSwitch,
      secureHandler(
        IPC_CHANNELS.requests.blogsSwitch,
        blogSwitchRequestSchema,
        isTrustedSender,
        serviceUnavailable,
      ),
    ],
  ]
}

export function registerBlogManagementIpc(options: {
  readonly ipcMain: IpcMainPort
  readonly services: BlogManagementIpcServices
  readonly isTrustedSender: (event: unknown) => boolean
  readonly eventTargets: () => readonly IpcEventTarget[]
}): () => void {
  const registered: string[] = []
  let unsubscribe: (() => void) | undefined
  try {
    for (const [channel, handler] of blogRequestHandlers(
      options.services,
      options.isTrustedSender,
    )) {
      options.ipcMain.handle(channel, handler)
      registered.push(channel)
    }
    unsubscribe = options.services.subscribeProgress((progress) => {
      const parsed = blogImportProgressSchema.safeParse(progress)
      if (!parsed.success) return
      let targets: readonly IpcEventTarget[]
      try {
        targets = options.eventTargets()
      } catch {
        return
      }
      for (const target of targets) {
        try {
          if (!target.isDestroyed()) {
            target.send(IPC_CHANNELS.events.blogsImportProgress, parsed.data)
          }
        } catch {
          // A closing window cannot block another target.
        }
      }
    })
  } catch (error) {
    bestEffortCleanup([
      ...registered.map((channel) => () => options.ipcMain.removeHandler(channel)),
      ...(unsubscribe ? [unsubscribe] : []),
    ])
    throw error
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    bestEffortCleanup([
      ...registered.map((channel) => () => options.ipcMain.removeHandler(channel)),
      ...(unsubscribe ? [unsubscribe] : []),
    ])
  }
}

/** Keeps the close acknowledgement available for the entire BrowserWindow lifetime. */
export function registerLifecycleIpc(options: {
  readonly ipcMain: IpcMainPort
  readonly isTrustedSender: (event: unknown) => boolean
  readonly acknowledgeClose: (request: CloseAckRequest) => void
}): () => void {
  const channel = IPC_CHANNELS.requests.lifecycleCloseAck
  options.ipcMain.handle(
    channel,
    secureHandler(channel, closeAckSchema, options.isTrustedSender, (request) =>
      options.acknowledgeClose(request),
    ),
  )
  let active = true
  return () => {
    if (!active) return
    active = false
    options.ipcMain.removeHandler(channel)
  }
}

/** Registers the complete and finite publisher IPC surface and returns an idempotent disposer. */
export function registerPublisherIpc(options: RegisterPublisherIpcOptions): () => void {
  const { ipcMain, services, isTrustedSender, eventTargets } = options
  const handlers: ReadonlyArray<readonly [string, RequestHandler]> = [
    ...(options.includeBlogManagement === false
      ? []
      : services.blogs
        ? blogRequestHandlers(services.blogs, isTrustedSender)
        : unavailableBlogRequestHandlers(isTrustedSender)),
    [
      IPC_CHANNELS.requests.workspaceInspectSafety,
      secureHandler(
        IPC_CHANNELS.requests.workspaceInspectSafety,
        noRequestSchema,
        isTrustedSender,
        () => services.workspace.inspectSafety(),
      ),
    ],
    [
      IPC_CHANNELS.requests.workspaceInspect,
      secureHandler(IPC_CHANNELS.requests.workspaceInspect, noRequestSchema, isTrustedSender, () =>
        services.workspace.inspect(),
      ),
    ],
    [
      IPC_CHANNELS.requests.workspaceRepair,
      secureHandler(
        IPC_CHANNELS.requests.workspaceRepair,
        workspaceRepairSchema,
        isTrustedSender,
        (request) => services.workspace.repair(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.domainsList,
      secureHandler(IPC_CHANNELS.requests.domainsList, noRequestSchema, isTrustedSender, () =>
        services.domains.list(),
      ),
    ],
    [
      IPC_CHANNELS.requests.domainsCreate,
      secureHandler(
        IPC_CHANNELS.requests.domainsCreate,
        domainCreateSchema,
        isTrustedSender,
        (request) => services.domains.create(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.domainsRename,
      secureHandler(
        IPC_CHANNELS.requests.domainsRename,
        domainRenameSchema,
        isTrustedSender,
        (request) => services.domains.rename(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.domainsRemove,
      secureHandler(
        IPC_CHANNELS.requests.domainsRemove,
        domainRemoveSchema,
        isTrustedSender,
        (request) => services.domains.remove(request),
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
      IPC_CHANNELS.requests.changesCancel,
      secureHandler(IPC_CHANNELS.requests.changesCancel, noRequestSchema, isTrustedSender, () =>
        services.changes.cancel(),
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
    [
      IPC_CHANNELS.requests.historyCancel,
      secureHandler(
        IPC_CHANNELS.requests.historyCancel,
        historyCancelSchema,
        isTrustedSender,
        (request) => services.history.cancel(request),
      ),
    ],
    [
      IPC_CHANNELS.requests.historyOpenLink,
      secureHandler(
        IPC_CHANNELS.requests.historyOpenLink,
        historyLinkSchema,
        isTrustedSender,
        (request) => services.history.openLink(request),
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
      services.notes.subscribeRecovery((update) =>
        broadcast(IPC_CHANNELS.events.notesRecovery, trashRecoveryUpdateSchema, update),
      ),
    )
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
    if (options.includeBlogManagement !== false && services.blogs) {
      subscriptions.push(
        services.blogs.subscribeProgress((progress) =>
          broadcast(IPC_CHANNELS.events.blogsImportProgress, blogImportProgressSchema, progress),
        ),
      )
    }
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
