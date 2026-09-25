import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  startCompletion,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands"
import { markdown } from "@codemirror/lang-markdown"
import { openSearchPanel, searchKeymap } from "@codemirror/search"
import { EditorState } from "@codemirror/state"
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

export interface MarkdownEditorHandle {
  flush(): Promise<boolean>
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
  const mounted = useRef(true)
  const [recoveryPrompt, setRecoveryPrompt] = useState<NoteRecovery>()
  const [external, setExternal] = useState<NoteDocument>()
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const autosave = useAutosave({
    document,
    save,
    writeRecovery: recovery.write,
    discardRecovery: (contentHash) => recovery.discard({ path: document.path, contentHash }),
    onSaved,
  })
  const autosaveRef = useRef(autosave)
  autosaveRef.current = autosave

  useImperativeHandle(ref, () => ({ flush: () => autosaveRef.current.flush() }), [])

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
          autocompletion({ override: [wikiCompletion(notes)], activateOnTyping: true }),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
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
    void recovery
      .get()
      .then((result) => {
        if (
          mounted.current &&
          result.ok &&
          result.value !== undefined &&
          result.value.markdown !== document.markdown
        ) {
          setRecoveryPrompt(result.value)
        }
      })
      .catch(() => undefined)
    return () => {
      mounted.current = false
      editor.current = undefined
      view.destroy()
    }
  }, [document.path])

  const replace = (next: NoteDocument | NoteRecovery): void => {
    const view = editor.current
    if (!view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next.markdown } })
    if ("mtimeMs" in next) autosave.reset(next)
  }

  const readExternal = async (): Promise<NoteDocument | undefined> => {
    try {
      const result = await read()
      if (!result.ok || !mounted.current) return undefined
      setExternal(result.value)
      return result.value
    } catch {
      return undefined
    }
  }

  const reloadExternal = async (): Promise<void> => {
    const next = await readExternal()
    if (!next) return
    replace(next)
    try {
      const draft = await recovery.get()
      if (draft.ok && draft.value) {
        await recovery.discard({ path: document.path, contentHash: draft.value.contentHash })
      }
    } catch {
      // Reloaded disk content is still safe; a stale recovery remains available on disk.
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

      {recoveryPrompt ? (
        <div className="editor-dialog-backdrop">
          <section
            className="editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="恢复未保存内容"
          >
            <h2>恢复未保存内容</h2>
            <p>检测到这篇笔记的本地恢复副本。确认前不会替换当前编辑内容。</p>
            <div>
              <button
                type="button"
                onClick={() => {
                  replace(recoveryPrompt)
                  setRecoveryPrompt(undefined)
                }}
              >
                恢复
              </button>
              <button
                type="button"
                onClick={() =>
                  void recovery
                    .discard({ path: document.path, contentHash: recoveryPrompt.contentHash })
                    .then((result) => {
                      if (mounted.current && result.ok) setRecoveryPrompt(undefined)
                    })
                    .catch(() => undefined)
                }
              >
                丢弃
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {comparisonOpen && external ? (
        <div className="editor-dialog-backdrop">
          <section
            className="editor-dialog compare-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="比较外部修改"
          >
            <h2>比较外部修改</h2>
            <div className="compare-columns">
              <pre aria-label="编辑器内容">{editor.current?.state.sliceDoc()}</pre>
              <pre aria-label="磁盘内容">{external.markdown}</pre>
            </div>
            <button type="button" onClick={() => setComparisonOpen(false)}>
              关闭
            </button>
          </section>
        </div>
      ) : null}
    </div>
  )
})
