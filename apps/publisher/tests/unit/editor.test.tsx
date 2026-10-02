import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { EditorView } from "@codemirror/view"
import { createHash } from "node:crypto"
import { StrictMode, createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  boundedLines,
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
    contentHash: createHash("sha256").update(markdown).digest("hex"),
  }
}

function setup(
  options: {
    save?: (markdown: string) => Promise<IpcResult<NoteWriteReceipt>>
    read?: () => Promise<IpcResult<NoteDocument>>
    recovery?: NoteRecovery
    getRecovery?: () => Promise<IpcResult<NoteRecovery | undefined>>
    discardRecovery?: () => Promise<IpcResult<void>>
    document?: NoteDocument
    readOnly?: boolean
  } = {},
) {
  const selectedDocument = options.document ?? document
  const save = vi.fn(options.save ?? (async (markdown: string) => ok(receipt(markdown))))
  const read = vi.fn(options.read ?? (async () => ok(selectedDocument)))
  const getRecovery = vi.fn(options.getRecovery ?? (async () => ok(options.recovery)))
  const writeRecovery = vi.fn(async () => ok({ contentHash: "c".repeat(64) }))
  const discardRecovery = vi.fn(options.discardRecovery ?? (async () => ok(undefined)))
  const ref = createRef<MarkdownEditorHandle>()
  const editor = (readOnly = options.readOnly) => (
    <MarkdownEditor
      ref={ref}
      document={selectedDocument}
      notes={[publicNote, privateNote]}
      save={async (request) => save(request.markdown)}
      read={read}
      recovery={{ get: getRecovery, write: writeRecovery, discard: discardRecovery }}
      readOnly={readOnly}
    />
  )
  const view = render(editor())
  return {
    ...view,
    ref,
    save,
    read,
    getRecovery,
    writeRecovery,
    discardRecovery,
    rerenderReadOnly: (readOnly: boolean) => view.rerender(editor(readOnly)),
  }
}

function editorView(): EditorView {
  const content = globalThis.document.querySelector(".cm-content")
  if (!(content instanceof HTMLElement)) throw new Error("CodeMirror content not mounted")
  const view = EditorView.findFromDOM(content)
  if (!view) throw new Error("CodeMirror view not found")
  return view
}

function dispatchDoc(markdown: string): void {
  const view = editorView()
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: markdown } })
  })
}

async function replaceDoc(markdown: string): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
  })
  expect(editorView().contentDOM).toHaveAttribute("contenteditable", "true")
  dispatchDoc(markdown)
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
  it("blocks user and programmatic document changes while a switch barrier is active", async () => {
    const recovery: NoteRecovery = {
      path: publicNote.path,
      markdown: `${original}recovery replacement`,
      baseMtimeMs: document.mtimeMs,
      baseContentHash: document.contentHash,
      createdAt: "2026-09-25T00:30:00.000Z",
      contentHash: "c".repeat(64),
    }
    setup({ recovery, readOnly: true })

    const prompt = await screen.findByRole("dialog", { name: "恢复未保存内容" })
    expect(editorView().contentDOM).toHaveAttribute("contenteditable", "false")
    expect(screen.getByRole("status", { name: "编辑器切换状态" })).toHaveTextContent("编辑已暂停")
    dispatchDoc(`${original}external dispatch`)
    expect(editorView().state.sliceDoc()).toBe(original)
    await userEvent.click(within(prompt).getByRole("button", { name: "恢复" }))
    expect(editorView().state.sliceDoc()).toBe(original)
  })

  it("does not apply an annotated disk reload after the switch barrier begins", async () => {
    const external: NoteDocument = {
      ...document,
      markdown: `${original}external replacement`,
      mtimeMs: 12,
      contentHash: createHash("sha256").update(`${original}external replacement`).digest("hex"),
    }
    const { ref, rerenderReadOnly } = setup({
      save: async () => ({
        ok: false,
        error: { code: "EXTERNAL_EDIT", message: "changed elsewhere" },
      }),
      read: async () => ok(external),
    })
    await replaceDoc(`${original}local buffer`)
    await act(async () => void (await ref.current!.flush()))
    rerenderReadOnly(true)

    await userEvent.click(screen.getByRole("button", { name: "重新加载" }))
    expect(editorView().state.sliceDoc()).toBe(`${original}local buffer`)
  })

  it("keeps the editor read-only until recovery loading is handled", async () => {
    const pending = deferred<IpcResult<NoteRecovery | undefined>>()
    const recovery: NoteRecovery = {
      path: publicNote.path,
      markdown: `${original}older unsaved draft`,
      baseMtimeMs: document.mtimeMs,
      baseContentHash: document.contentHash,
      createdAt: "2026-09-25T00:30:00.000Z",
      contentHash: "c".repeat(64),
    }
    const { writeRecovery } = setup({ getRecovery: () => pending.promise })
    const view = editorView()
    expect(view.contentDOM).toHaveAttribute("contenteditable", "false")

    dispatchDoc(`${original}early input`)
    expect(view.state.sliceDoc()).toBe(original)
    expect(writeRecovery).not.toHaveBeenCalled()

    pending.resolve(ok(recovery))
    const prompt = await screen.findByRole("dialog", { name: "恢复未保存内容" })
    expect(writeRecovery).not.toHaveBeenCalled()
    await userEvent.click(within(prompt).getByRole("button", { name: "永久删除恢复稿" }))
    await waitFor(() => expect(view.contentDOM).toHaveAttribute("contenteditable", "true"))
    await replaceDoc(`${original}ready input`)
    await waitFor(() => expect(writeRecovery).toHaveBeenCalledOnce())
  })

  it("requires an explicit recovery-load decision and preserves an unknown draft", async () => {
    const { writeRecovery } = setup({
      getRecovery: async () => {
        throw new Error("recovery unavailable")
      },
    })
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("无法检查本地恢复稿")
    expect(editorView().contentDOM).toHaveAttribute("contenteditable", "false")
    await userEvent.click(screen.getByRole("button", { name: "不加载恢复稿继续" }))
    await waitFor(() => expect(editorView().contentDOM).toHaveAttribute("contenteditable", "true"))
    await replaceDoc(`${original}continue safely`)
    await waitFor(() => expect(writeRecovery).not.toHaveBeenCalled())
    expect(screen.getByText(/不会覆盖状态未知的恢复稿/)).toBeVisible()
  })

  it("returns immediately from flushSave for a clean editor without writing or saving", async () => {
    const { ref, save, writeRecovery } = setup()
    await expect(ref.current!.flushSave()).resolves.toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(writeRecovery).not.toHaveBeenCalled()
  })

  it("preserves raw frontmatter bytes and coalesces changes into one save after 750ms", async () => {
    vi.useFakeTimers()
    const { ref, save, writeRecovery } = setup()
    const changed = `${original}first\r\nsecond\r\n`
    await replaceDoc(`${original}first\r\n`)
    await replaceDoc(changed)

    await act(async () => Promise.resolve())
    expect(writeRecovery).toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(749))
    expect(save).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))

    await act(async () => {
      await expect(ref.current!.flush()).resolves.toBe(true)
    })

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(changed)
    expect(screen.getByRole("status", { name: "保存状态" })).toHaveTextContent("已保存")
  })

  it("keeps existing mixed CRLF/LF text and saves the editor's exact current buffer", async () => {
    const mixed = "first\r\nsecond\nthird"
    const mixedDocument = {
      ...document,
      markdown: mixed,
      contentHash: createHash("sha256").update(mixed).digest("hex"),
    }
    const { ref, save } = setup({ document: mixedDocument })
    await act(async () => {
      for (let index = 0; index < 4; index += 1) await Promise.resolve()
    })
    const view = editorView()
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nfourth" } }))
    await act(async () => void (await ref.current!.flushSave()))
    expect(save).toHaveBeenCalledWith("first\r\nsecond\nthird\nfourth")
  })

  it("keeps one flush pending until edits made during save1 are durably saved by save2", async () => {
    const save1 = deferred<IpcResult<NoteWriteReceipt>>()
    const save2 = deferred<IpcResult<NoteWriteReceipt>>()
    let call = 0
    const { ref, save, discardRecovery, writeRecovery } = setup({
      save: async () => (++call === 1 ? save1.promise : save2.promise),
    })
    await replaceDoc(`${original}first buffer`)
    let barrierResolved = false
    const barrier = ref.current!.flushSave().then((result) => {
      barrierResolved = true
      return result
    })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    await replaceDoc(`${original}newer buffer`)
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
    await replaceDoc(`${original}v1`)
    const first = ref.current!.flushSave()
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    await replaceDoc(`${original}v2`)
    const second = ref.current!.flushSave()
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
    await replaceDoc(`${original}saved but draft pending`)

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

  it("rejects a mismatched save receipt without advancing revision or clearing recovery", async () => {
    const { ref, save, discardRecovery } = setup({
      save: async (markdown) =>
        ok({ ...receipt(markdown), path: "private/life/journal.md", contentHash: "f".repeat(64) }),
    })
    await replaceDoc(`${original}receipt mismatch`)
    await act(async () => {
      await expect(ref.current!.flush()).resolves.toBe(false)
    })
    expect(save).toHaveBeenCalledOnce()
    expect(discardRecovery).not.toHaveBeenCalled()
    expect(screen.getByRole("alert", { name: "保存状态" })).toHaveTextContent("保存失败")
  })

  it("automatically cleans an immediate recovery when the buffer returns to disk content", async () => {
    const { ref, save, writeRecovery, discardRecovery } = setup()
    await replaceDoc(`${original}temporary edit`)
    await replaceDoc(original)

    await waitFor(() => expect(discardRecovery).toHaveBeenCalled())
    await expect(ref.current!.flush()).resolves.toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(writeRecovery).toHaveBeenCalled()
    expect(discardRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: "c".repeat(64) }),
    )
  })

  it("safely discards a loaded recovery whose content already matches the disk", async () => {
    const matching: NoteRecovery = {
      path: publicNote.path,
      markdown: document.markdown,
      baseMtimeMs: document.mtimeMs,
      baseContentHash: document.contentHash,
      createdAt: "2026-09-25T00:30:00.000Z",
      contentHash: createHash("sha256").update(document.markdown).digest("hex"),
    }
    const { discardRecovery } = setup({ recovery: matching })
    await waitFor(() =>
      expect(discardRecovery).toHaveBeenCalledWith({
        path: publicNote.path,
        contentHash: matching.contentHash,
      }),
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("flushes before a switch and retains the buffer when a failed flush blocks it", async () => {
    vi.useFakeTimers()
    const { ref, save } = setup({
      save: async () => ({
        ok: false,
        error: { code: "NOTE_FILE_WRITE_FAILED", message: "磁盘不可写" },
      }),
    })
    await replaceDoc(`${original}unsaved buffer`)

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
    await replaceDoc(`${original}local buffer`)
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

  it("reloads with a programmatic transaction and does not create a replacement recovery draft", async () => {
    const external: NoteDocument = {
      ...document,
      markdown: `${original}external reload`,
      mtimeMs: 12,
      contentHash: createHash("sha256").update(`${original}external reload`).digest("hex"),
    }
    const { ref, writeRecovery } = setup({
      save: async () => ({
        ok: false,
        error: { code: "EXTERNAL_EDIT", message: "changed elsewhere" },
      }),
      read: async () => ok(external),
    })
    await replaceDoc(`${original}local buffer`)
    await act(async () => void (await ref.current!.flush()))
    writeRecovery.mockClear()
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }))
    await waitFor(() => expect(editorView().state.sliceDoc()).toBe(external.markdown))
    expect(writeRecovery).not.toHaveBeenCalled()
  })

  it("locks editing while a deferred Reload is reading and resetting disk state", async () => {
    const pendingRead = deferred<IpcResult<NoteDocument>>()
    const external: NoteDocument = {
      ...document,
      markdown: `${original}external after deferred read`,
      mtimeMs: 12,
      contentHash: createHash("sha256")
        .update(`${original}external after deferred read`)
        .digest("hex"),
    }
    const { ref } = setup({
      save: async () => ({
        ok: false,
        error: { code: "EXTERNAL_EDIT", message: "changed elsewhere" },
      }),
      read: () => pendingRead.promise,
    })
    await waitFor(() => expect(editorView().contentDOM).toHaveAttribute("contenteditable", "true"))
    await replaceDoc(`${original}local before reload`)
    await act(async () => void (await ref.current!.flush()))
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }))
    expect(editorView().contentDOM).toHaveAttribute("contenteditable", "false")
    dispatchDoc(`${original}late input must be blocked`)
    expect(editorView().state.sliceDoc()).toContain("local before reload")
    pendingRead.resolve(ok(external))
    await waitFor(() => expect(editorView().state.sliceDoc()).toBe(external.markdown))
    expect(editorView().contentDOM).toHaveAttribute("contenteditable", "true")
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
    await userEvent.click(within(second).getByRole("button", { name: "永久删除恢复稿" }))
    expect(discardRecovery).not.toHaveBeenCalled()
    expect(secondSetup.discardRecovery).toHaveBeenCalledTimes(1)
  })

  it("treats a recovery based on an older disk revision as a conflict requiring confirmation", async () => {
    const recovery: NoteRecovery = {
      path: publicNote.path,
      markdown: `${original}old recovered buffer`,
      createdAt: "2026-09-25T00:30:00.000Z",
      baseMtimeMs: 1,
      baseContentHash: "b".repeat(64),
      contentHash: "c".repeat(64),
    }
    const appShell = globalThis.document.createElement("main")
    appShell.className = "app-shell"
    globalThis.document.body.append(appShell)
    const { save } = setup({ recovery })
    const prompt = await screen.findByRole("dialog", { name: "旧恢复稿与磁盘版本冲突" })
    expect(editorView().state.sliceDoc()).toBe(original)
    expect(save).not.toHaveBeenCalled()
    await userEvent.click(within(prompt).getByRole("button", { name: "比较版本" }))
    expect(within(prompt).getByLabelText("磁盘当前内容")).toHaveTextContent("# Grid")
    expect(within(prompt).getByLabelText("旧恢复稿内容")).toHaveTextContent("old recovered buffer")
    await userEvent.click(within(prompt).getByRole("button", { name: "仍使用恢复稿" }))
    const confirmation = await screen.findByRole("dialog", { name: "确认使用旧恢复稿" })
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    await waitFor(() => expect(appShell).toHaveAttribute("inert"))
    expect(appShell).toHaveAttribute("aria-hidden", "true")
    expect(within(confirmation).getByRole("button", { name: "取消" })).toHaveFocus()
    expect(editorView().state.sliceDoc()).toBe(original)
    await userEvent.click(within(confirmation).getByRole("button", { name: "确认覆盖当前版本" }))
    expect(editorView().state.sliceDoc()).toContain("old recovered buffer")
    appShell.remove()
  })

  it("bounds diff scanning without splitting a million-line document", () => {
    const split = vi.spyOn(String.prototype, "split")
    const preview = boundedLines("x\n".repeat(1_000_000))
    expect(preview.lines).toHaveLength(500)
    expect(preview.truncated).toBe(true)
    expect(split).not.toHaveBeenCalled()
  })

  it("stops a 16 MiB single-line preview at the byte bound without whole-line work", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode")
    const slice = vi.spyOn(String.prototype, "slice")
    const preview = boundedLines("x".repeat(16 * 1024 * 1024))
    expect(preview).toEqual({ lines: [], truncated: true })
    expect(encode).not.toHaveBeenCalled()
    expect(slice).not.toHaveBeenCalled()
  })

  it("counts surrogate pairs exactly at the bounded preview byte edge", () => {
    const fitting = `${"😀".repeat(16_383)}abc`
    expect(boundedLines(fitting)).toEqual({ lines: [fitting], truncated: false })
    expect(boundedLines("😀".repeat(16_384))).toEqual({ lines: [], truncated: true })
  })

  it("shows and retries a non-blocking warning when same-content recovery cleanup fails", async () => {
    const matching: NoteRecovery = {
      path: publicNote.path,
      markdown: document.markdown,
      baseMtimeMs: document.mtimeMs,
      baseContentHash: document.contentHash,
      createdAt: "2026-09-25T00:30:00.000Z",
      contentHash: createHash("sha256").update(document.markdown).digest("hex"),
    }
    const discardRecovery = vi
      .fn<() => Promise<IpcResult<void>>>()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "RECOVERY_DISCARD_FAILED", message: "cleanup failed" },
      })
      .mockResolvedValueOnce(ok(undefined))
    setup({ recovery: matching, discardRecovery })
    const warningText = await screen.findByText(/恢复稿清理失败/)
    const warning = warningText.closest<HTMLElement>('[role="status"]')
    expect(warning).not.toBeNull()
    expect(editorView().contentDOM).toHaveAttribute("contenteditable", "true")
    await userEvent.click(within(warning!).getByRole("button", { name: "重试清理" }))
    await waitFor(() => expect(screen.queryByText(/恢复稿清理失败/)).not.toBeInTheDocument())
    expect(discardRecovery).toHaveBeenCalledTimes(2)
  })

  it("keeps editing available when same-content recovery cleanup rejects", async () => {
    const matching: NoteRecovery = {
      path: publicNote.path,
      markdown: document.markdown,
      baseMtimeMs: document.mtimeMs,
      baseContentHash: document.contentHash,
      createdAt: "2026-09-25T00:30:00.000Z",
      contentHash: createHash("sha256").update(document.markdown).digest("hex"),
    }
    setup({
      recovery: matching,
      discardRecovery: async () => {
        throw new Error("cleanup unavailable")
      },
    })
    expect(await screen.findByText("恢复稿清理失败，请重试。")).toBeVisible()
    expect(editorView().contentDOM).toHaveAttribute("contenteditable", "true")
  })

  it("bounds recovery comparison DOM and announces truncation", async () => {
    const recovery: NoteRecovery = {
      path: publicNote.path,
      markdown: Array.from({ length: 700 }, (_, index) => `private line ${index}`).join("\n"),
      createdAt: "2026-09-25T00:30:00.000Z",
      baseMtimeMs: 1,
      baseContentHash: "b".repeat(64),
      contentHash: "c".repeat(64),
    }
    setup({ recovery })
    const prompt = await screen.findByRole("dialog", { name: "旧恢复稿与磁盘版本冲突" })
    await userEvent.click(within(prompt).getByRole("button", { name: "比较版本" }))
    expect(within(prompt).getByRole("status")).toHaveTextContent("仅显示前 500 行或 64 KiB")
    expect(within(prompt).getAllByText(/private line/)).toHaveLength(500)
  })

  it("shows a safe read error when Reload or Compare cannot read the disk version", async () => {
    const { ref } = setup({
      save: async () => ({
        ok: false,
        error: { code: "EXTERNAL_EDIT", message: "changed elsewhere" },
      }),
      read: async () => ({
        ok: false,
        error: { code: "NOTE_FILE_ACCESS_FAILED", message: "无法读取最新磁盘内容" },
      }),
    })
    await replaceDoc(`${original}local buffer`)
    await act(async () => void (await ref.current!.flush()))
    await userEvent.click(screen.getByRole("button", { name: "比较" }))
    expect(await screen.findByText("无法读取最新磁盘内容")).toHaveAttribute("role", "alert")
  })

  it("supports search, undo, redo, and keyboard-selectable Wiki completion using metadata only", async () => {
    setup()
    const user = userEvent.setup()
    await replaceDoc("alpha beta")
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

  it("reconfigures Wiki completion metadata without recreating the editor instance", async () => {
    const mounted = setup()
    await act(async () => {
      for (let index = 0; index < 4; index += 1) await Promise.resolve()
    })
    const firstView = editorView()
    const renamed = { ...publicNote, title: "Grid Layout Renamed" }
    mounted.rerender(
      <MarkdownEditor
        ref={mounted.ref}
        document={document}
        notes={[renamed, privateNote]}
        save={async (request) => mounted.save(request.markdown)}
        read={mounted.read}
        recovery={{
          get: mounted.getRecovery,
          write: mounted.writeRecovery,
          discard: mounted.discardRecovery,
        }}
      />,
    )
    expect(editorView()).toBe(firstView)
    act(() => {
      firstView.dispatch({
        changes: { from: 0, to: firstView.state.doc.length, insert: "[[Grid" },
        selection: { anchor: 6 },
        userEvent: "input.type",
      })
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)))
    const completion = await screen.findByRole("listbox")
    expect(completion).toHaveTextContent("Grid Layout Renamed")
    expect(completion).not.toHaveTextContent("CSS Grid")
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
    await replaceDoc(`${original}late`)
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
    await replaceDoc(`${original}v1 before unmount`)
    const barrier = ref.current!.flush()
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    await replaceDoc(`${original}v2 before unmount`)
    unmount()

    save1.resolve(ok(receipt(`${original}v1 before unmount`)))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    save2.resolve(ok(receipt(`${original}v2 before unmount`)))
    await expect(barrier).resolves.toBe(true)
    expect(error).not.toHaveBeenCalled()
  })
})
