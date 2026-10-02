import {
  IPC_CHANNELS,
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
  type GardenApi,
  type ChangeReview,
  type BeforeCloseRequest,
  type CloseAckRequest,
  type DeploymentHistory,
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
  beforeCloseSchema,
  blogImportProgressSchema,
  closeBlockedSchema,
  ipcResultSchema,
  previewProgressSchema,
  publishProgressSchema,
  trashRecoveryUpdateSchema,
} from "../shared/ipcSchemas"
import { z } from "zod"

declare global {
  interface Window {
    readonly garden: GardenApi
  }
}

export interface IpcRendererPort {
  invoke(channel: string, request?: unknown): Promise<unknown>
  on(channel: string, listener: (event: unknown, payload: unknown) => void): this
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): this
}

function invoke<T>(
  ipc: IpcRendererPort,
  channel: keyof typeof IPC_SUCCESS_SCHEMAS,
  request?: unknown,
): Promise<IpcResult<T>> {
  const invalid = (): IpcResult<T> => ({
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "The application returned an invalid response." },
  })
  return Promise.resolve()
    .then(() => ipc.invoke(channel, request))
    .then((result) => {
      try {
        const parsed = ipcResultSchema(
          IPC_SUCCESS_SCHEMAS[channel] as z.ZodType<unknown>,
        ).safeParse(result)
        return parsed.success ? (parsed.data as IpcResult<T>) : invalid()
      } catch {
        return invalid()
      }
    }, invalid)
}

function subscription<T>(
  ipc: IpcRendererPort,
  channel: string,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  listener: (payload: T) => void,
): () => void {
  if (typeof listener !== "function") throw new TypeError("A progress listener is required.")
  const wrapped = (_event: unknown, payload: unknown): void => {
    try {
      const parsed = schema.safeParse(payload)
      if (parsed.success) listener(parsed.data as T)
    } catch {
      // Malformed events never cross the preload boundary.
    }
  }
  ipc.on(channel, wrapped)
  let active = true
  return () => {
    if (!active) return
    active = false
    ipc.removeListener(channel, wrapped)
  }
}

/** Builds the only renderer-facing capability object. No Electron primitive escapes this closure. */
export function createGardenApi(ipc: IpcRendererPort): GardenApi {
  const blogs = Object.freeze({
    list: () => invoke<BlogRegistryStatus>(ipc, IPC_CHANNELS.requests.blogsList),
    chooseLocal: () =>
      invoke<BlogCandidateSelection | undefined>(ipc, IPC_CHANNELS.requests.blogsChooseLocal),
    addLocal: (request: BlogAddLocalRequest) =>
      invoke<BlogRegistryView>(ipc, IPC_CHANNELS.requests.blogsAddLocal, request),
    clone: (request: BlogCloneRequest) =>
      invoke<BlogImportReceipt>(ipc, IPC_CHANNELS.requests.blogsClone, request),
    cancelImport: () => invoke<void>(ipc, IPC_CHANNELS.requests.blogsCancelImport),
    install: (request: BlogPathRequest) =>
      invoke<BlogCandidateInspection>(ipc, IPC_CHANNELS.requests.blogsInstall, request),
    rename: (request: BlogRenameRequest) =>
      invoke<BlogRegistryView>(ipc, IPC_CHANNELS.requests.blogsRename, request),
    relocate: (request: BlogRelocateRequest) =>
      invoke<BlogRegistryView>(ipc, IPC_CHANNELS.requests.blogsRelocate, request),
    remove: (request: BlogIdRequest) =>
      invoke<BlogRegistryView>(ipc, IPC_CHANNELS.requests.blogsRemove, request),
    openFolder: (request: BlogIdRequest) =>
      invoke<void>(ipc, IPC_CHANNELS.requests.blogsOpenFolder, request),
    switch: (request: BlogSwitchRequest) =>
      invoke<void>(ipc, IPC_CHANNELS.requests.blogsSwitch, request),
    onImportProgress: (listener: (progress: BlogImportProgress) => void) =>
      subscription(ipc, IPC_CHANNELS.events.blogsImportProgress, blogImportProgressSchema, listener),
  })
  const lifecycle = Object.freeze({
    acknowledgeClose: (request: CloseAckRequest) =>
      invoke<void>(ipc, IPC_CHANNELS.requests.lifecycleCloseAck, request),
    onBeforeClose: (listener: (request: BeforeCloseRequest) => void) =>
      subscription(ipc, IPC_CHANNELS.events.beforeClose, beforeCloseSchema, listener),
    onCloseBlocked: (listener: (message: string) => void) =>
      subscription(ipc, IPC_CHANNELS.events.closeBlocked, closeBlockedSchema, ({ message }) =>
        listener(message),
      ),
  })
  const workspace = Object.freeze({
    inspectSafety: () =>
      invoke<WorkspaceInspection>(ipc, IPC_CHANNELS.requests.workspaceInspectSafety),
    inspect: () => invoke<WorkspaceInspection>(ipc, IPC_CHANNELS.requests.workspaceInspect),
    repair: (request: WorkspaceRepairRequest) =>
      invoke<WorkspaceRepairReceipt>(ipc, IPC_CHANNELS.requests.workspaceRepair, request),
  })
  const notes = Object.freeze({
    onRecovery: (listener: (update: TrashRecoveryUpdate) => void) =>
      subscription(ipc, IPC_CHANNELS.events.notesRecovery, trashRecoveryUpdateSchema, listener),
    list: () => invoke<readonly NoteSummary[]>(ipc, IPC_CHANNELS.requests.notesList),
    read: (request: NotePathRequest) =>
      invoke<NoteDocument>(ipc, IPC_CHANNELS.requests.notesRead, request),
    save: (request: NoteSaveRequest) =>
      invoke<NoteWriteReceipt>(ipc, IPC_CHANNELS.requests.notesSave, request),
    create: (request: NoteCreateRequest) =>
      invoke<NoteWriteReceipt>(ipc, IPC_CHANNELS.requests.notesCreate, request),
    rename: (request: NoteRenameRequest) =>
      invoke<NoteTransactionReceipt>(ipc, IPC_CHANNELS.requests.notesRename, request),
    changeVisibility: (request: NoteVisibilityRequest) =>
      invoke<NoteTransactionReceipt>(ipc, IPC_CHANNELS.requests.notesChangeVisibility, request),
    trash: (request: NotePathRequest) =>
      invoke<NoteTrashReceipt>(ipc, IPC_CHANNELS.requests.notesTrash, request),
    recovery: Object.freeze({
      get: (request: NotePathRequest) =>
        invoke<NoteRecovery | undefined>(ipc, IPC_CHANNELS.requests.notesRecoveryGet, request),
      write: (request: NoteRecoveryWriteRequest) =>
        invoke<NoteRecoveryReceipt>(ipc, IPC_CHANNELS.requests.notesRecoveryWrite, request),
      discard: (request: NoteRecoveryDiscardRequest) =>
        invoke<void>(ipc, IPC_CHANNELS.requests.notesRecoveryDiscard, request),
    }),
  })
  const preview = Object.freeze({
    start: (request?: PreviewStartRequest) =>
      invoke<PreviewStatus>(ipc, IPC_CHANNELS.requests.previewStart, request),
    stop: () => invoke<PreviewStatus>(ipc, IPC_CHANNELS.requests.previewStop),
    status: () => invoke<PreviewStatus>(ipc, IPC_CHANNELS.requests.previewStatus),
    onProgress: (listener: (status: PreviewStatus) => void) =>
      subscription(ipc, IPC_CHANNELS.events.previewProgress, previewProgressSchema, listener),
  })
  const changes = Object.freeze({
    list: () => invoke<ChangeReview>(ipc, IPC_CHANNELS.requests.changesList),
    cancel: () => invoke<void>(ipc, IPC_CHANNELS.requests.changesCancel),
  })
  const publish = Object.freeze({
    start: (request: PublishRequest) =>
      invoke<PublishStartReceipt>(ipc, IPC_CHANNELS.requests.publishStart, request),
    cancel: (request: PublishCancelRequest) =>
      invoke<void>(ipc, IPC_CHANNELS.requests.publishCancel, request),
    onProgress: (listener: (progress: PublishProgress) => void) =>
      subscription(ipc, IPC_CHANNELS.events.publishProgress, publishProgressSchema, listener),
  })
  const history = Object.freeze({
    git: (request?: HistoryRequest) =>
      invoke<readonly GitCommit[]>(ipc, IPC_CHANNELS.requests.historyGit, request),
    deployments: (request?: HistoryRequest) =>
      invoke<DeploymentHistory>(ipc, IPC_CHANNELS.requests.historyDeployments, request),
    cancel: (request: HistoryCancelRequest) =>
      invoke<void>(ipc, IPC_CHANNELS.requests.historyCancel, request),
    openLink: (request: HistoryLinkRequest) =>
      invoke<void>(ipc, IPC_CHANNELS.requests.historyOpenLink, request),
  })
  return Object.freeze({ blogs, lifecycle, workspace, notes, preview, changes, publish, history })
}
