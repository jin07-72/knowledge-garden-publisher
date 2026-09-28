import { useEffect, useRef, useState } from "react"
import { Trash2, TriangleAlert } from "lucide-react"
import type { NoteSummary, NoteTrashReceipt } from "../../../shared/contracts"
import { ModalShell } from "./ModalShell"

interface DeleteNoteDialogProps {
  readonly note: NoteSummary
  readonly onClose: () => void
  readonly onDelete: () => Promise<NoteTrashReceipt>
}

export function DeleteNoteDialog({ note, onClose, onDelete }: DeleteNoteDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const cancel = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const confirm = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await onDelete()
      if (mounted.current) onClose()
    } catch (failure) {
      if (!mounted.current) return
      setError(failure instanceof Error ? failure.message : "无法将笔记移入回收站。")
      setBusy(false)
    }
  }

  return (
    <ModalShell
      labelId="delete-note-title"
      className="new-note-dialog delete-note-dialog"
      initialFocus={cancel}
      closeDisabled={busy}
      onClose={onClose}
    >
      <header>
        <Trash2 size={20} aria-hidden="true" />
        <h2 id="delete-note-title">将笔记移入回收站？</h2>
      </header>
      <div className="delete-note-copy">
        <p><strong>{note.title}</strong></p>
        <code>{note.path}</code>
        <p>笔记及其专属附件会移入 Windows 回收站，可从回收站恢复。</p>
        {note.visibility === "public" ? (
          <p className="delete-public-warning">
            <TriangleAlert size={16} aria-hidden="true" />
            若这篇公开笔记已经发布，它仍会在线，直到你再次发布下架变化。
          </p>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button type="button" className="primary-button danger-button" disabled={busy} onClick={() => void confirm()}>
          {busy ? "正在移入回收站…" : "移入回收站"}
        </button>
      </div>
    </ModalShell>
  )
}
