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
  const generation = useRef(0)
  const persistedGeneration = useRef(0)
  const saveLoop = useRef<Promise<boolean> | undefined>(undefined)
  const latestRecovery = useRef<{ generation: number; contentHash: string } | undefined>(undefined)
  const recoveryChain = useRef(
    Promise.resolve<IpcResult<NoteRecoveryReceipt> | undefined>(undefined),
  )
  const [state, setState] = useState<SaveState>("saved")
  const [error, setError] = useState<AppError>()
  const latest = useRef(options)
  latest.current = options

  const persistRecovery = useCallback((markdown: string, recoveryGeneration: number) => {
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
      .then((result) => {
        if (
          result?.ok &&
          (latestRecovery.current === undefined ||
            recoveryGeneration >= latestRecovery.current.generation)
        ) {
          latestRecovery.current = {
            generation: recoveryGeneration,
            contentHash: result.value.contentHash,
          }
        }
        return result
      })
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

  const runSave = useCallback((): Promise<boolean> => {
    if (saveLoop.current) return saveLoop.current
    const operation = (async (): Promise<boolean> => {
      try {
        while (true) {
          const savingGeneration = generation.current
          const markdown = current.current
          if (savingGeneration === persistedGeneration.current && markdown === persisted.current) {
            const recoveryAtStart = recoveryChain.current
            await recoveryAtStart
            if (
              generation.current !== savingGeneration ||
              recoveryChain.current !== recoveryAtStart
            ) {
              continue
            }
            const pendingRecovery = latestRecovery.current
            if (pendingRecovery) {
              const discarded = await latest.current.discardRecovery(pendingRecovery.contentHash)
              if (!discarded.ok) {
                if (mounted.current) {
                  setError(discarded.error)
                  setState("failed")
                }
                return false
              }
              if (latestRecovery.current === pendingRecovery) latestRecovery.current = undefined
              continue
            }
            if (mounted.current) {
              setState("saved")
              setError(undefined)
            }
            return true
          }
          const base = revision.current
          if (mounted.current) {
            setState("saving")
            setError(undefined)
          }
          await persistRecovery(markdown, savingGeneration)
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
          persistedGeneration.current = savingGeneration
          revision.current = {
            mtimeMs: result.value.mtimeMs,
            contentHash: result.value.contentHash,
          }
          latest.current.onSaved?.(result.value)
          if (generation.current !== savingGeneration || current.current !== markdown) continue
          continue
        }
      } catch {
        if (mounted.current) {
          setError({ code: "NOTE_FILE_WRITE_FAILED", message: "无法保存这篇笔记。" })
          setState("failed")
        }
        return false
      }
    })()
    const tracked = operation.finally(() => {
      if (saveLoop.current === tracked) saveLoop.current = undefined
    })
    saveLoop.current = tracked
    return tracked
  }, [persistRecovery])

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = undefined
    return runSave()
  }, [runSave])

  const change = useCallback(
    (markdown: string): void => {
      current.current = markdown
      generation.current += 1
      if (timer.current) clearTimeout(timer.current)
      if (markdown === persisted.current && !saveLoop.current) {
        persistedGeneration.current = generation.current
        setState("saving")
        setError(undefined)
        void runSave()
        return
      }
      setState("saving")
      setError(undefined)
      void persistRecovery(markdown, generation.current)
      if (!saveLoop.current) timer.current = setTimeout(() => void runSave(), 750)
    },
    [persistRecovery, runSave],
  )

  const reset = useCallback((next: NoteDocument): void => {
    current.current = next.markdown
    persisted.current = next.markdown
    revision.current = { mtimeMs: next.mtimeMs, contentHash: next.contentHash }
    generation.current += 1
    persistedGeneration.current = generation.current
    latestRecovery.current = undefined
    if (timer.current) clearTimeout(timer.current)
    timer.current = undefined
    setState("saved")
    setError(undefined)
  }, [])

  return { state, error, change, flush, reset }
}
