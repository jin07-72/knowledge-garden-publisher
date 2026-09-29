import { useEffect, useRef, useState } from "react"
import { Trash2, TriangleAlert } from "lucide-react"
import type { NoteSummary, NoteTrashReceipt } from "../../../shared/contracts"
import { ModalShell } from "./ModalShell"

interface DeleteNoteDialogProps {
  readonly note: NoteSummary
  readonly onClose: () => void
  readonly onDelete: () => Promise<NoteTrashReceipt>
  readonly onDeleted: () => void
}

export function DeleteNoteDialog({
  note,
  onClose,
  onDelete,
  onDeleted,
}: DeleteNoteDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const cancel = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const confirm = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await onDelete()
      if (mounted.current) onDeleted()
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
        <p>
          <strong>{note.title}</strong>
        </p>
        <code>{note.path}</code>
        <p>
          笔记和归属明确的专属附件会先放入带恢复记录的安全暂存区，再以原名称移入 Windows
          回收站。还原后，应用会按记录放回原路径；冲突项会保留并提示。未能安全清理的附件会明确提示。
        </p>
        {note.visibility === "public" ? (
          <p className="delete-public-warning">
            <TriangleAlert size={16} aria-hidden="true" />
            若这篇公开笔记已经发布，它仍会在线，直到你再次发布下架变化。
          </p>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <button
          ref={cancel}
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="button"
          className="primary-button danger-button"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? "正在移入回收站…" : "移入回收站"}
        </button>
      </div>
    </ModalShell>
  )
}
