import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { EditorView } from "@codemirror/view"
import { StrictMode, createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../../src/renderer/src/components/MarkdownEditor"
import type {
  IpcResult,
  NoteDocument,
  NoteRecovery,
  NoteSummary,
  NoteWriteReceipt,
} from "../../src/shared/contracts"

const publicNote: NoteSummary = {
  path: "content/technology/css-grid.md",
  domain: "technology",
  slug: "css-grid",
  title: "CSS Grid",
  date: "2026-09-25",
  description: "public description",
  visibility: "public",
  updatedAt: "2026-09-25T00:00:00.000Z",
  tags: ["css"],
}
const privateNote: NoteSummary = {
  path: "private/life/journal.md",
  domain: "life",
  slug: "journal",
  title: "Journal",
  date: "2026-09-25",
  description: "PRIVATE_BODY_MUST_NOT_APPEAR",
  visibility: "private",
  updatedAt: "2026-09-25T00:00:00.000Z",
  tags: ["private"],
}
const original = "---\r\ntitle: Grid\r\naliases: [A, B]\r\n---\r\n\r\n# Grid\r\n"
const document: NoteDocument = {
  path: publicNote.path,
  markdown: original,
  mtimeMs: 10,
  contentHash: "a".repeat(64),
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function receipt(markdown: string): NoteWriteReceipt {
  return {
    path: publicNote.path,
    updatedAt: "2026-09-25T01:00:00.000Z",
    mtimeMs: 11,
    contentHash: markdown.length.toString(16).padStart(64, "0"),
  }
}

function setup(
  options: {
    save?: (markdown: string) => Promise<IpcResult<NoteWriteReceipt>>
    read?: () => Promise<IpcResult<NoteDocument>>
    recovery?: NoteRecovery
    discardRecovery?: () => Promise<IpcResult<void>>
  } = {},
) {
  const save = vi.fn(options.save ?? (async (markdown: string) => ok(receipt(markdown))))
  const read = vi.fn(options.read ?? (async () => ok(document)))
  const getRecovery = vi.fn(async () => ok(options.recovery))
  const writeRecovery = vi.fn(async () => ok({ contentHash: "c".repeat(64) }))
  const discardRecovery = vi.fn(options.discardRecovery ?? (async () => ok(undefined)))
  const ref = createRef<MarkdownEditorHandle>()
  const view = render(
    <MarkdownEditor
      ref={ref}
      document={document}
      notes={[publicNote, privateNote]}
      save={async (request) => save(request.markdown)}
      read={read}
      recovery={{ get: getRecovery, write: writeRecovery, discard: discardRecovery }}
    />,
  )
  return { ...view, ref, save, read, getRecovery, writeRecovery, discardRecovery }
}

function editorView(): EditorView {
  const content = globalThis.document.querySelector(".cm-content")
  if (!(content instanceof HTMLElement)) throw new Error("CodeMirror content not mounted")
  const view = EditorView.findFromDOM(content)
  if (!view) throw new Error("CodeMirror view not found")
  return view
}

function replaceDoc(markdown: string): void {
  const view = editorView()
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: markdown } })
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

beforeEach(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }),
    },
  })
})

describe("MarkdownEditor", () => {
  it("preserves raw frontmatter bytes and coalesces changes into one save after 750ms", async () => {
    vi.useFakeTimers()
    const { save, writeRecovery } = setup()
    const changed = `${original}first\r\nsecond\r\n`
    replaceDoc(`${original}first\r\n`)
    replaceDoc(changed)

    await act(async () => Promise.resolve())
    expect(writeRecovery).toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(749))
    expect(save).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(changed)
    expect(screen.getByRole("status", { name: "保存状态" })).toHaveTextContent("已保存")
  })

  it("keeps one flush pending until edits made during save1 are durably saved by save2", async () => {
    const save1 = deferred<IpcResult<NoteWriteReceipt>>()
    const save2 = deferred<IpcResult<NoteWriteReceipt>>()
    let call = 0
    const { ref, save, discardRecovery, writeRecovery } = setup({
      save: async () => (++call === 1 ? save1.promise : save2.promise),
    })
    replaceDoc(`${original}first buffer`)
    let barrierResolved = false
    const barrier = ref.current!.flush().then((result) => {
      barrierResolved = true
      return result
    })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    replaceDoc(`${original}newer buffer`)
    await act(async () => {
      save1.resolve(ok(receipt(`${original}first buffer`)))
      await Promise.resolve()
    })

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(barrierResolved).toBe(false)
    expect(discardRecovery).not.toHaveBeenCalled()
    expect(writeRecovery).toHaveBeenLastCalledWith(
      expect.objectContaining({ markdown: `${original}newer buffer` }),
    )
    await act(async () => {
      save2.resolve(ok(receipt(`${original}newer buffer`)))
      await expect(barrier).resolves.toBe(true)
    })
    expect(discardRecovery).toHaveBeenCalledTimes(1)
  })

  it("returns false from every coalesced flush when save2 fails", async () => {
    const save1 = deferred<IpcResult<NoteWriteReceipt>>()
    const save2 = deferred<IpcResult<NoteWriteReceipt>>()
    let call = 0
    const { ref, save } = setup({
      save: async () => (++call === 1 ? save1.promise : save2.promise),
    })
    replaceDoc(`${original}v1`)
    const first = ref.current!.flush()
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    replaceDoc(`${original}v2`)
    const second = ref.current!.flush()
    save1.resolve(ok(receipt(`${original}v1`)))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    save2.resolve({
      ok: false,
      error: { code: "NOTE_FILE_WRITE_FAILED", message: "save2 failed" },
    })

    await act(async () => {
      await expect(first).resolves.toBe(false)
      await expect(second).resolves.toBe(false)
    })
    expect(editorView().state.sliceDoc()).toContain("v2")
  })

  it("blocks a durable flush until the matching recovery draft is cleaned", async () => {
    let discardAttempt = 0
    const { ref, save, discardRecovery } = setup({
      discardRecovery: async () =>
        ++discardAttempt === 1
          ? {
              ok: false,
              error: { code: "RECOVERY_DISCARD_FAILED", message: "cleanup failed" },
            }
          : ok(undefined),
    })
    replaceDoc(`${original}saved but draft pending`)

    await act(async () => {
      await expect(ref.current!.flush()).resolves.toBe(false)
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(discardRecovery).toHaveBeenCalledTimes(1)

    await act(async () => {
      await expect(ref.current!.flush()).resolves.toBe(true)
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(discardRecovery).toHaveBeenCalledTimes(2)
  })

  it("automatically cleans an immediate recovery when the buffer returns to disk content", async () => {
    const { ref, save, writeRecovery, discardRecovery } = setup()
    replaceDoc(`${original}temporary edit`)
    replaceDoc(original)

    await waitFor(() => expect(discardRecovery).toHaveBeenCalled())
    await expect(ref.current!.flush()).resolves.toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(writeRecovery).toHaveBeenCalled()
    expect(discardRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: "c".repeat(64) }),
    )
  })

  it("flushes before a switch and retains the buffer when a failed flush blocks it", async () => {
    vi.useFakeTimers()
    const { ref, save } = setup({
      save: async () => ({
        ok: false,
        error: { code: "NOTE_FILE_WRITE_FAILED", message: "磁盘不可写" },
      }),
    })
    replaceDoc(`${original}unsaved buffer`)

    await act(async () => {
      await expect(ref.current?.flush()).resolves.toBe(false)
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(editorView().state.doc.toString()).toContain("unsaved buffer")
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败")
  })

  it("keeps a stale buffer and offers safe Reload and Compare actions", async () => {
    const external: NoteDocument = {
      ...document,
      markdown: `${original}external`,
      mtimeMs: 12,
      contentHash: "b".repeat(64),
    }
    const { ref } = setup({
      save: async () => ({
        ok: false,
        error: { code: "EXTERNAL_EDIT", message: "changed elsewhere" },
      }),
      read: async () => ok(external),
    })
    replaceDoc(`${original}local buffer`)
    await act(async () => void (await ref.current?.flush()))

    expect(screen.getByRole("alert")).toHaveTextContent("外部文件已修改")
    expect(editorView().state.doc.toString()).toContain("local buffer")
    await userEvent.click(screen.getByRole("button", { name: "比较" }))
    const comparison = await screen.findByRole("dialog", { name: "比较外部修改" })
    expect(within(comparison).getByLabelText("编辑器内容")).toHaveTextContent("local buffer")
    expect(within(comparison).getByLabelText("磁盘内容")).toHaveTextContent("external")

    await userEvent.click(within(comparison).getByRole("button", { name: "关闭" }))
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }))
    await waitFor(() => expect(editorView().state.doc.toString()).toContain("external"))
  })

  it("prompts for disk recovery without replacing the buffer until confirmed", async () => {
    const recovery: NoteRecovery = {
      path: publicNote.path,
      markdown: `${original}recovered buffer`,
      createdAt: "2026-09-25T00:30:00.000Z",
      baseMtimeMs: document.mtimeMs,
      baseContentHash: document.contentHash,
      contentHash: "c".repeat(64),
    }
    const { discardRecovery } = setup({ recovery })
    const prompt = await screen.findByRole("dialog", { name: "恢复未保存内容" })
    expect(editorView().state.sliceDoc()).toBe(original)
    await userEvent.click(within(prompt).getByRole("button", { name: "恢复" }))
    expect(editorView().state.doc.toString()).toContain("recovered buffer")

    cleanup()
    const secondSetup = setup({ recovery })
    const second = await screen.findByRole("dialog", { name: "恢复未保存内容" })
    await userEvent.click(within(second).getByRole("button", { name: "丢弃" }))
    expect(discardRecovery).not.toHaveBeenCalled()
    expect(secondSetup.discardRecovery).toHaveBeenCalledTimes(1)
  })

  it("supports search, undo, redo, and keyboard-selectable Wiki completion using metadata only", async () => {
    setup()
    const user = userEvent.setup()
    replaceDoc("alpha beta")
    await user.click(screen.getByRole("button", { name: "撤销" }))
    expect(editorView().state.sliceDoc()).toBe(original)
    await user.click(screen.getByRole("button", { name: "重做" }))
    expect(editorView().state.doc.toString()).toBe("alpha beta")

    await user.click(screen.getByRole("button", { name: "搜索" }))
    expect(globalThis.document.querySelector(".cm-search")).toBeTruthy()

    const completionView = editorView()
    act(() => {
      completionView.focus()
      completionView.dispatch({
        changes: { from: 0, to: completionView.state.doc.length, insert: "[[" },
        selection: { anchor: 2 },
        userEvent: "input.type",
      })
    })
    await act(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const completion = await screen.findByRole("listbox")
    expect(completion).toHaveTextContent("CSS Grid")
    expect(completion).toHaveTextContent("technology/css-grid")
    expect(completion).toHaveTextContent("公开")
    expect(completion).toHaveTextContent("Journal")
    expect(completion).toHaveTextContent("私密")
    expect(completion).not.toHaveTextContent("PRIVATE_BODY_MUST_NOT_APPEAR")
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)))
    const content = globalThis.document.querySelector(".cm-content") as HTMLElement
    fireEvent.keyDown(content, { key: "ArrowDown", code: "ArrowDown" })
    fireEvent.keyDown(content, { key: "Enter", code: "Enter" })
    expect(editorView().state.doc.toString()).toMatch(/^\[\[(?:CSS Grid|Journal)\]\]$/)
  })

  it("handles rejected promises, unmount races, and StrictMode without act warnings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    let rejectSave!: (reason: unknown) => void
    const pending = new Promise<IpcResult<NoteWriteReceipt>>((_, reject) => {
      rejectSave = reject
    })
    const ref = createRef<MarkdownEditorHandle>()
    const writeRecovery = vi.fn(async () => ok({ contentHash: "c".repeat(64) }))
    const view = render(
      <StrictMode>
        <MarkdownEditor
          ref={ref}
          document={document}
          notes={[publicNote, privateNote]}
          save={() => pending}
          read={async () => ok(document)}
          recovery={{
            get: async () => ok(undefined),
            write: writeRecovery,
            discard: async () => ok(undefined),
          }}
        />
      </StrictMode>,
    )
    replaceDoc(`${original}late`)
    const flush = ref.current?.flush()
    view.unmount()
    await act(async () => {
      rejectSave(new Error("late rejection PRIVATE_BODY_MUST_NOT_APPEAR"))
      await flush
    })
    expect(writeRecovery).toHaveBeenLastCalledWith(
      expect.objectContaining({ markdown: `${original}late` }),
    )
    expect(error).not.toHaveBeenCalled()
  })

  it("finishes the latest durable generation when unmounted during an active flush", async () => {
    const save1 = deferred<IpcResult<NoteWriteReceipt>>()
    const save2 = deferred<IpcResult<NoteWriteReceipt>>()
    let call = 0
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { ref, save, unmount } = setup({
      save: async () => (++call === 1 ? save1.promise : save2.promise),
    })
    replaceDoc(`${original}v1 before unmount`)
    const barrier = ref.current!.flush()
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    replaceDoc(`${original}v2 before unmount`)
    unmount()

    save1.resolve(ok(receipt(`${original}v1 before unmount`)))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    save2.resolve(ok(receipt(`${original}v2 before unmount`)))
    await expect(barrier).resolves.toBe(true)
    expect(error).not.toHaveBeenCalled()
  })
})
