import {
  IPC_CHANNELS,
  type GardenApi,
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
  channel: string,
  request?: unknown,
): Promise<IpcResult<T>> {
  return ipc.invoke(channel, request) as Promise<IpcResult<T>>
}

function subscription<T>(
  ipc: IpcRendererPort,
  channel: string,
  listener: (payload: T) => void,
): () => void {
  if (typeof listener !== "function") throw new TypeError("A progress listener is required.")
  const wrapped = (_event: unknown, payload: unknown): void => listener(payload as T)
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
  const workspace = Object.freeze({
    inspect: () => invoke<WorkspaceInspection>(ipc, IPC_CHANNELS.requests.workspaceInspect),
  })
  const notes = Object.freeze({
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
  })
  const preview = Object.freeze({
    start: (request?: PreviewStartRequest) =>
      invoke<PreviewStatus>(ipc, IPC_CHANNELS.requests.previewStart, request),
    stop: () => invoke<PreviewStatus>(ipc, IPC_CHANNELS.requests.previewStop),
    status: () => invoke<PreviewStatus>(ipc, IPC_CHANNELS.requests.previewStatus),
    onProgress: (listener: (status: PreviewStatus) => void) =>
      subscription(ipc, IPC_CHANNELS.events.previewProgress, listener),
  })
  const changes = Object.freeze({
    list: () => invoke<readonly ChangeGroup[]>(ipc, IPC_CHANNELS.requests.changesList),
  })
  const publish = Object.freeze({
    start: (request: PublishRequest) =>
      invoke<PublishStartReceipt>(ipc, IPC_CHANNELS.requests.publishStart, request),
    cancel: (request: PublishCancelRequest) =>
      invoke<void>(ipc, IPC_CHANNELS.requests.publishCancel, request),
    onProgress: (listener: (progress: PublishProgress) => void) =>
      subscription(ipc, IPC_CHANNELS.events.publishProgress, listener),
  })
  const history = Object.freeze({
    git: (request?: HistoryRequest) =>
      invoke<readonly GitCommit[]>(ipc, IPC_CHANNELS.requests.historyGit, request),
    deployments: (request?: HistoryRequest) =>
      invoke<readonly DeploymentRun[]>(ipc, IPC_CHANNELS.requests.historyDeployments, request),
  })
  return Object.freeze({ workspace, notes, preview, changes, publish, history })
}
