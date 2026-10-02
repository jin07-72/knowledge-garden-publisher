import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  startCompletion,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands"
import { markdown } from "@codemirror/lang-markdown"
import { openSearchPanel, searchKeymap } from "@codemirror/search"
import { Annotation, Compartment, EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import type {
  IpcResult,
  NoteDocument,
  NoteRecovery,
  NoteRecoveryDiscardRequest,
  NoteRecoveryReceipt,
  NoteRecoveryWriteRequest,
  NoteSaveRequest,
  NoteSummary,
  NoteWriteReceipt,
} from "../../../shared/contracts"
import { wikiCompletion } from "../editor/wikiCompletion"
import { useAutosave } from "../hooks/useAutosave"
import { ModalShell } from "./ModalShell"

const programmaticReplace = Annotation.define<boolean>()
const compareMaximumBytes = 64 * 1024
const compareMaximumLines = 500

export function boundedLines(markdown: string): { lines: readonly string[]; truncated: boolean } {
  const lines: string[] = []
  let bytes = 0
  let start = 0
  let index = 0
  let lineBytes = 0
  while (index <= markdown.length) {
    if (lines.length >= compareMaximumLines) return { lines, truncated: true }
    const atEnd = index === markdown.length
    const unit = atEnd ? 10 : markdown.charCodeAt(index)
    if (unit === 10) {
      if (bytes + lineBytes + 1 > compareMaximumBytes) return { lines, truncated: true }
      const contentEnd = index > start && markdown.charCodeAt(index - 1) === 13 ? index - 1 : index
      lines.push(markdown.slice(start, contentEnd))
      bytes += lineBytes + 1
      if (atEnd) return { lines, truncated: false }
      index += 1
      start = index
      lineBytes = 0
      continue
    }
    if (unit === 13 && markdown.charCodeAt(index + 1) === 10) {
      index += 1
      continue
    }
    let unitBytes: number
    let width = 1
    if (unit <= 0x7f) unitBytes = 1
    else if (unit <= 0x7ff) unitBytes = 2
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = markdown.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        unitBytes = 4
        width = 2
      } else unitBytes = 3
    } else unitBytes = 3
    if (bytes + lineBytes + unitBytes + 1 > compareMaximumBytes) return { lines, truncated: true }
    lineBytes += unitBytes
    index += width
  }
  return { lines, truncated: false }
}

function Comparison({
  left,
  right,
  leftLabel,
  rightLabel,
}: {
  readonly left: string
  readonly right: string
  readonly leftLabel: string
  readonly rightLabel: string
}): React.JSX.Element {
  const leftPreview = boundedLines(left)
  const rightPreview = boundedLines(right)
  const lineCount = Math.max(leftPreview.lines.length, rightPreview.lines.length)
  const column = (lines: readonly string[], other: readonly string[], label: string) => (
    <pre aria-label={label}>
      {Array.from({ length: lineCount }, (_, index) => {
        const line = lines[index] ?? ""
        return line === (other[index] ?? "") ? (
          <span key={index}>
            {line}
            {"\n"}
          </span>
        ) : (
          <mark key={index}>
            {line}
            {"\n"}
          </mark>
        )
      })}
    </pre>
  )
  return (
    <>
      <div className="compare-columns">
        {column(leftPreview.lines, rightPreview.lines, leftLabel)}
        {column(rightPreview.lines, leftPreview.lines, rightLabel)}
      </div>
      {leftPreview.truncated || rightPreview.truncated ? (
        <p role="status">比较内容过大，仅显示前 500 行或 64 KiB。</p>
      ) : null}
    </>
  )
}

export interface MarkdownEditorHandle {
  flush(): Promise<boolean>
  flushSave(): Promise<boolean>
}

interface RecoveryPort {
  get(): Promise<IpcResult<NoteRecovery | undefined>>
  write(request: NoteRecoveryWriteRequest): Promise<IpcResult<NoteRecoveryReceipt>>
  discard(request: NoteRecoveryDiscardRequest): Promise<IpcResult<void>>
}

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  {
    readonly document: NoteDocument
    readonly notes: readonly NoteSummary[]
    readonly save: (request: NoteSaveRequest) => Promise<IpcResult<NoteWriteReceipt>>
    readonly read: () => Promise<IpcResult<NoteDocument>>
    readonly recovery: RecoveryPort
    readonly onSaved?: (receipt: NoteWriteReceipt) => void
    readonly onSaveStateChange?: (label: string) => void
  }
>(function MarkdownEditor(
  { document, notes, save, read, recovery, onSaved, onSaveStateChange },
  ref,
) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | undefined>(undefined)
  const completion = useRef(new Compartment())
  const editing = useRef(new Compartment())
  const mounted = useRef(true)
  const recoveryReady = useRef(false)
  const recoveryWritesEnabled = useRef(false)
  const reloadPending = useRef(false)
  const refreshWritable = useRef<() => void>(() => undefined)
  const retryRecoveryLoad = useRef<() => void>(() => undefined)
  const [recoveryPrompt, setRecoveryPrompt] = useState<NoteRecovery>()
  const [recoveryLoadError, setRecoveryLoadError] = useState<string>()
  const [unknownRecoveryWarning, setUnknownRecoveryWarning] = useState(false)
  const [maintenanceRecovery, setMaintenanceRecovery] = useState<NoteRecovery>()
  const [maintenanceWarning, setMaintenanceWarning] = useState<string>()
  const [external, setExternal] = useState<NoteDocument>()
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const [recoveryComparisonOpen, setRecoveryComparisonOpen] = useState(false)
  const [confirmStaleRecovery, setConfirmStaleRecovery] = useState(false)
  const [readError, setReadError] = useState<string>()
  const [recoveryActionError, setRecoveryActionError] = useState<string>()
  const autosave = useAutosave({
    document,
    save,
    writeRecovery: (request) =>
      recoveryWritesEnabled.current
        ? recovery.write(request)
        : Promise.resolve({
            ok: false,
            error: {
              code: "RECOVERY_INVALID" as const,
              message: "Recovery state is not ready.",
            },
          }),
    discardRecovery: (contentHash) => recovery.discard({ path: document.path, contentHash }),
    onSaved,
  })
  const autosaveRef = useRef(autosave)
  autosaveRef.current = autosave

  useImperativeHandle(
    ref,
    () => ({
      flush: () => autosaveRef.current.flush(),
      flushSave: () => autosaveRef.current.flush(),
    }),
    [],
  )

  useEffect(() => {
    mounted.current = true
    const view = new EditorView({
      parent: host.current ?? undefined,
      state: EditorState.create({
        doc: document.markdown,
        extensions: [
          markdown(),
          EditorState.lineSeparator.of(document.markdown.includes("\r\n") ? "\r\n" : "\n"),
          history(),
          closeBrackets(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          completion.current.of(
            autocompletion({
              override: [
                wikiCompletion(notes, document.path.split("/")[1] as NoteSummary["domain"]),
              ],
              activateOnTyping: true,
            }),
          ),
          editing.current.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          EditorState.transactionFilter.of((transaction) =>
            transaction.docChanged &&
            (!recoveryReady.current || reloadPending.current) &&
            !transaction.annotation(programmaticReplace)
              ? []
              : transaction,
          ),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            if (
              update.transactions.some((transaction) => transaction.annotation(programmaticReplace))
            )
              return
            autosaveRef.current.change(update.state.sliceDoc())
            const cursor = update.state.selection.main.head
            if (update.state.doc.sliceString(Math.max(0, cursor - 2), cursor) === "[[") {
              queueMicrotask(() => {
                if (mounted.current) startCompletion(update.view)
              })
            }
          }),
        ],
      }),
    })
    editor.current = view
    let active = true
    const updateWritable = (): void => {
      if (!active) return
      const writable = recoveryReady.current && !reloadPending.current
      view.dispatch({
        effects: editing.current.reconfigure([
          EditorState.readOnly.of(!writable),
          EditorView.editable.of(writable),
        ]),
      })
    }
    refreshWritable.current = updateWritable
    const loadRecovery = async (): Promise<void> => {
      recoveryReady.current = false
      recoveryWritesEnabled.current = false
      setRecoveryLoadError(undefined)
      setUnknownRecoveryWarning(false)
      updateWritable()
      let result: IpcResult<NoteRecovery | undefined>
      try {
        result = await recovery.get()
      } catch {
        if (active) setRecoveryLoadError("无法检查本地恢复稿。请重试或明确选择继续。")
        return
      }
      if (!active) return
      if (!result.ok) {
        setRecoveryLoadError(result.error.message || "无法检查本地恢复稿。")
        return
      }
      if (result.value?.markdown === document.markdown) {
        setMaintenanceRecovery(result.value)
        try {
          const discarded = await recovery.discard({
            path: document.path,
            contentHash: result.value.contentHash,
          })
          if (!active) return
          if (discarded.ok) {
            setMaintenanceRecovery(undefined)
            setMaintenanceWarning(undefined)
          } else setMaintenanceWarning(`恢复稿清理失败：${discarded.error.message}`)
        } catch {
          if (!active) return
          setMaintenanceWarning("恢复稿清理失败，请重试。")
        }
      } else if (result.value !== undefined) setRecoveryPrompt(result.value)
      recoveryWritesEnabled.current = true
      recoveryReady.current = true
      updateWritable()
    }
    retryRecoveryLoad.current = () => void loadRecovery()
    void loadRecovery()
    return () => {
      active = false
      mounted.current = false
      recoveryReady.current = false
      reloadPending.current = false
      editor.current = undefined
      view.destroy()
    }
  }, [document.path])

  useEffect(() => {
    const view = editor.current
    if (!view) return
    view.dispatch({
      effects: completion.current.reconfigure(
        autocompletion({
          override: [wikiCompletion(notes, document.path.split("/")[1] as NoteSummary["domain"])],
          activateOnTyping: true,
        }),
      ),
    })
  }, [document.path, notes])

  const replace = (next: NoteRecovery): void => {
    const view = editor.current
    if (!view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next.markdown } })
  }

  const replaceFromDisk = async (next: NoteDocument): Promise<boolean> => {
    const reset = await autosave.reset(next)
    const view = editor.current
    if (!reset || !view) return false
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next.markdown },
      annotations: programmaticReplace.of(true),
    })
    return true
  }

  const readExternal = async (): Promise<NoteDocument | undefined> => {
    try {
      const result = await read()
      if (!result.ok || !mounted.current) {
        if (mounted.current) setReadError(result.ok ? "无法读取最新磁盘内容" : result.error.message)
        return undefined
      }
      setReadError(undefined)
      setExternal(result.value)
      return result.value
    } catch {
      if (mounted.current) setReadError("无法读取最新磁盘内容")
      return undefined
    }
  }

  const reloadExternal = async (): Promise<void> => {
    if (reloadPending.current) return
    reloadPending.current = true
    refreshWritable.current()
    try {
      const next = await readExternal()
      if (!next) return
      await replaceFromDisk(next)
    } finally {
      reloadPending.current = false
      refreshWritable.current()
    }
  }

  const continueWithoutRecovery = (): void => {
    recoveryWritesEnabled.current = false
    recoveryReady.current = true
    setRecoveryLoadError(undefined)
    setUnknownRecoveryWarning(true)
    refreshWritable.current()
  }

  const retryMaintenanceCleanup = async (): Promise<void> => {
    if (!maintenanceRecovery) return
    try {
      const result = await recovery.discard({
        path: document.path,
        contentHash: maintenanceRecovery.contentHash,
      })
      if (!mounted.current) return
      if (result.ok) {
        setMaintenanceRecovery(undefined)
        setMaintenanceWarning(undefined)
      } else setMaintenanceWarning(`恢复稿清理失败：${result.error.message}`)
    } catch {
      if (mounted.current) setMaintenanceWarning("恢复稿清理失败，请重试。")
    }
  }

  const statusLabel = {
    saved: "已保存",
    saving: "正在保存…",
    failed: "保存失败",
    conflict: "外部文件已修改",
  }[autosave.state]

  useEffect(() => {
    onSaveStateChange?.(statusLabel)
  }, [onSaveStateChange, statusLabel])

  return (
    <div className="markdown-editor">
      <div className="editor-toolbar" aria-label="编辑器工具栏">
        <button
          type="button"
          onClick={() => editor.current && undo(editor.current)}
          aria-label="撤销"
        >
          撤销
        </button>
        <button
          type="button"
          onClick={() => editor.current && redo(editor.current)}
          aria-label="重做"
        >
          重做
        </button>
        <button
          type="button"
          onClick={() => editor.current && openSearchPanel(editor.current)}
          aria-label="搜索"
        >
          搜索
        </button>
      </div>
      <div ref={host} className="codemirror-host" />
      <div
        className={`save-state save-${autosave.state}`}
        role={autosave.state === "failed" || autosave.state === "conflict" ? "alert" : "status"}
        aria-live="polite"
        aria-label="保存状态"
      >
        <span>{statusLabel}</span>
        {autosave.error ? <small>{autosave.error.message}</small> : null}
        {autosave.state === "conflict" ? (
          <span className="conflict-actions">
            <button type="button" onClick={() => void reloadExternal()}>
              重新加载
            </button>
            <button
              type="button"
              onClick={() => void readExternal().then((next) => next && setComparisonOpen(true))}
            >
              比较
            </button>
          </span>
        ) : null}
      </div>
      {readError ? (
        <p className="editor-read-error" role="alert">
          {readError}
        </p>
      ) : null}

      {recoveryLoadError ? (
        <div className="editor-recovery-warning" role="alert">
          <span>{recoveryLoadError}</span>
          <button type="button" onClick={() => retryRecoveryLoad.current()}>
            重试检查
          </button>
          <button type="button" onClick={continueWithoutRecovery}>
            不加载恢复稿继续
          </button>
        </div>
      ) : null}
      {unknownRecoveryWarning ? (
        <div className="editor-recovery-warning" role="status">
          <span>恢复稿状态未知；继续编辑不会覆盖状态未知的恢复稿。</span>
          <button type="button" onClick={() => retryRecoveryLoad.current()}>
            重新检查
          </button>
        </div>
      ) : null}
      {maintenanceWarning ? (
        <div className="editor-recovery-warning" role="status">
          <span>{maintenanceWarning}</span>
          <button type="button" onClick={() => void retryMaintenanceCleanup()}>
            重试清理
          </button>
        </div>
      ) : null}

      {recoveryPrompt ? (
        <ModalShell
          labelId={confirmStaleRecovery ? "stale-recovery-confirm-title" : "recovery-title"}
          className="editor-dialog"
          onClose={() => setConfirmStaleRecovery(false)}
          closeDisabled={!confirmStaleRecovery}
        >
          {confirmStaleRecovery ? (
            <>
              <h2 id="stale-recovery-confirm-title">确认使用旧恢复稿</h2>
              <p>这会用旧恢复稿替换编辑器内容，并以当前磁盘版本作为下一次保存基线。</p>
              <div className="dialog-actions">
                <button type="button" onClick={() => setConfirmStaleRecovery(false)}>
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    replace(recoveryPrompt)
                    setConfirmStaleRecovery(false)
                    setRecoveryPrompt(undefined)
                  }}
                >
                  确认覆盖当前版本
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 id="recovery-title">
                {recoveryPrompt.baseMtimeMs === document.mtimeMs &&
                recoveryPrompt.baseContentHash === document.contentHash
                  ? "恢复未保存内容"
                  : "旧恢复稿与磁盘版本冲突"}
              </h2>
              <p>
                {recoveryPrompt.baseMtimeMs === document.mtimeMs &&
                recoveryPrompt.baseContentHash === document.contentHash
                  ? "检测到这篇笔记的本地恢复副本。确认前不会替换当前编辑内容。"
                  : "磁盘版本已在恢复稿之后改变。旧稿不会自动保存；请先比较并明确确认。"}
              </p>
              <p className="recovery-delete-warning">
                丢弃操作会永久删除本机恢复稿，无法从回收站找回。
              </p>
              {recoveryActionError ? <p role="alert">{recoveryActionError}</p> : null}
              {recoveryComparisonOpen ? (
                <Comparison
                  left={document.markdown}
                  right={recoveryPrompt.markdown}
                  leftLabel="磁盘当前内容"
                  rightLabel="旧恢复稿内容"
                />
              ) : null}
              <div className="dialog-actions">
                {recoveryPrompt.baseMtimeMs === document.mtimeMs &&
                recoveryPrompt.baseContentHash === document.contentHash ? (
                  <button
                    type="button"
                    onClick={() => {
                      replace(recoveryPrompt)
                      setRecoveryPrompt(undefined)
                    }}
                  >
                    恢复
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={() => setRecoveryComparisonOpen(true)}>
                      比较版本
                    </button>
                    <button type="button" onClick={() => setConfirmStaleRecovery(true)}>
                      仍使用恢复稿
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void recovery
                      .discard({ path: document.path, contentHash: recoveryPrompt.contentHash })
                      .then((result) => {
                        if (!mounted.current) return
                        if (result.ok) {
                          setRecoveryPrompt(undefined)
                          setRecoveryActionError(undefined)
                        } else setRecoveryActionError(result.error.message)
                      })
                      .catch(() => {
                        if (mounted.current) setRecoveryActionError("无法永久删除恢复稿。")
                      })
                  }
                >
                  永久删除恢复稿
                </button>
              </div>
            </>
          )}
        </ModalShell>
      ) : null}

      {comparisonOpen && external ? (
        <ModalShell
          labelId="external-compare-title"
          className="editor-dialog compare-dialog"
          onClose={() => setComparisonOpen(false)}
        >
          <h2 id="external-compare-title">比较外部修改</h2>
          <Comparison
            left={editor.current?.state.sliceDoc() ?? ""}
            right={external.markdown}
            leftLabel="编辑器内容"
            rightLabel="磁盘内容"
          />
          <button type="button" onClick={() => setComparisonOpen(false)}>
            关闭
          </button>
        </ModalShell>
      ) : null}
    </div>
  )
})
