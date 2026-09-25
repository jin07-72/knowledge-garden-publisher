import { useCallback, useEffect, useRef, useState } from "react"
import type {
  AppError,
  IpcResult,
  NoteDocument,
  NoteRecoveryWriteRequest,
  NoteRecoveryReceipt,
  NoteSaveRequest,
  NoteWriteReceipt,
} from "../../../shared/contracts"

export type SaveState = "saved" | "saving" | "failed" | "conflict"

export interface AutosaveController {
  readonly state: SaveState
  readonly error?: AppError
  change(markdown: string): void
  flush(): Promise<boolean>
  reset(document: NoteDocument): void
}

export function useAutosave(options: {
  readonly document: NoteDocument
  readonly save: (request: NoteSaveRequest) => Promise<IpcResult<NoteWriteReceipt>>
  readonly writeRecovery: (
    request: NoteRecoveryWriteRequest,
  ) => Promise<IpcResult<NoteRecoveryReceipt>>
  readonly discardRecovery: (contentHash: string) => Promise<IpcResult<void>>
  readonly onSaved?: (receipt: NoteWriteReceipt) => void
}): AutosaveController {
  const mounted = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const current = useRef(options.document.markdown)
  const persisted = useRef(options.document.markdown)
  const revision = useRef({
    mtimeMs: options.document.mtimeMs,
    contentHash: options.document.contentHash,
  })
  const inFlight = useRef<Promise<boolean> | undefined>(undefined)
  const recoveryChain = useRef(
    Promise.resolve<IpcResult<NoteRecoveryReceipt> | undefined>(undefined),
  )
  const [state, setState] = useState<SaveState>("saved")
  const [error, setError] = useState<AppError>()
  const latest = useRef(options)
  latest.current = options

  const persistRecovery = useCallback((markdown: string) => {
    const base = revision.current
    recoveryChain.current = recoveryChain.current
      .catch(() => undefined)
      .then(() =>
        latest.current.writeRecovery({
          path: latest.current.document.path,
          markdown,
          baseMtimeMs: base.mtimeMs,
          baseContentHash: base.contentHash,
        }),
      )
      .catch(() => undefined)
    return recoveryChain.current
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const runSave = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) {
      const previous = await inFlight.current
      if (!previous) return false
    }
    if (current.current === persisted.current) return true
    const markdown = current.current
    const base = revision.current
    if (mounted.current) {
      setState("saving")
      setError(undefined)
    }
    const operation = (async (): Promise<boolean> => {
      try {
        const recovery = await persistRecovery(markdown)
        const result = await latest.current.save({
          path: latest.current.document.path,
          markdown,
          expectedMtimeMs: base.mtimeMs,
          expectedContentHash: base.contentHash,
        })
        if (!result.ok) {
          if (mounted.current) {
            setError(result.error)
            setState(result.error.code === "EXTERNAL_EDIT" ? "conflict" : "failed")
          }
          return false
        }
        persisted.current = markdown
        revision.current = {
          mtimeMs: result.value.mtimeMs,
          contentHash: result.value.contentHash,
        }
        latest.current.onSaved?.(result.value)
        if (current.current === markdown) {
          if (recovery?.ok) {
            await latest.current.discardRecovery(recovery.value.contentHash).catch(() => undefined)
          }
          if (mounted.current) setState("saved")
        } else if (mounted.current) {
          timer.current = setTimeout(() => void runSave(), 750)
        }
        return true
      } catch {
        if (mounted.current) {
          setError({ code: "NOTE_FILE_WRITE_FAILED", message: "无法保存这篇笔记。" })
          setState("failed")
        }
        return false
      }
    })()
    inFlight.current = operation
    try {
      return await operation
    } finally {
      if (inFlight.current === operation) inFlight.current = undefined
    }
  }, [persistRecovery])

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = undefined
    return runSave()
  }, [runSave])

  const change = useCallback(
    (markdown: string): void => {
      current.current = markdown
      if (timer.current) clearTimeout(timer.current)
      if (markdown === persisted.current) {
        setState("saved")
        setError(undefined)
        return
      }
      setState("saving")
      setError(undefined)
      void persistRecovery(markdown)
      timer.current = setTimeout(() => void runSave(), 750)
    },
    [persistRecovery, runSave],
  )

  const reset = useCallback((next: NoteDocument): void => {
    current.current = next.markdown
    persisted.current = next.markdown
    revision.current = { mtimeMs: next.mtimeMs, contentHash: next.contentHash }
    if (timer.current) clearTimeout(timer.current)
    timer.current = undefined
    setState("saved")
    setError(undefined)
  }, [])

  return { state, error, change, flush, reset }
}
