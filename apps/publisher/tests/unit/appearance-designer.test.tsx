import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { APPEARANCE_PRESETS, DEFAULT_APPEARANCE } from "../../src/shared/appearance"
import type { AppearanceSnapshot, GardenApi, IpcResult } from "../../src/shared/contracts"
import { AppearanceDesigner } from "../../src/renderer/src/components/AppearanceDesigner"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)
const PREVIEW_URL = "http://127.0.0.1:8080/notes/current"

const supportedSnapshot = (overrides: Partial<AppearanceSnapshot> = {}): AppearanceSnapshot => ({
  framework: "quartz",
  supported: true,
  settings: APPEARANCE_PRESETS.paper,
  baselineHash: HASH_A,
  canUndo: true,
  ...overrides,
})

const success = <T,>(value: T): IpcResult<T> => ({ ok: true, value })

function appearanceApi(overrides: Partial<GardenApi["appearance"]> = {}): GardenApi["appearance"] {
  return {
    read: vi.fn().mockResolvedValue(success(supportedSnapshot())),
    chooseBackground: vi.fn().mockResolvedValue(
      success({
        source: "staged" as const,
        token: "123e4567-e89b-42d3-a456-426614174000",
        name: "garden.webp",
      }),
    ),
    preview: vi.fn().mockImplementation(({ sessionId }) => Promise.resolve(success({ sessionId }))),
    clearPreview: vi.fn().mockResolvedValue(success(undefined)),
    apply: vi
      .fn()
      .mockResolvedValue(
        success({ snapshot: supportedSnapshot({ baselineHash: HASH_B, canUndo: true }) }),
      ),
    undo: vi
      .fn()
      .mockResolvedValue(
        success({ snapshot: supportedSnapshot({ baselineHash: HASH_B, canUndo: false }) }),
      ),
    ...overrides,
  }
}

function renderDesigner(
  options: {
    api?: GardenApi["appearance"]
    previewUrl?: string
    onClose?: () => void
    onChanged?: () => void
    strict?: boolean
  } = {},
) {
  const api = options.api ?? appearanceApi()
  const onClose = options.onClose ?? vi.fn()
  const onChanged = options.onChanged ?? vi.fn()
  render(
    <>
      <main className="app-shell">
        <button type="button">外部按钮</button>
      </main>
      <AppearanceDesigner
        api={api}
        previewUrl={options.previewUrl ?? PREVIEW_URL}
        onClose={onClose}
        onChanged={onChanged}
      />
    </>,
    { reactStrictMode: options.strict },
  )
  return { api, onClose, onChanged }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("AppearanceDesigner", () => {
  it("loads a snapshot, renders a sandboxed active loopback preview, and rejects public preview URLs", async () => {
    const pending = new Promise<IpcResult<AppearanceSnapshot>>(() => undefined)
    const loadingApi = appearanceApi({ read: vi.fn().mockReturnValue(pending) })
    renderDesigner({ api: loadingApi })
    expect(screen.getByRole("status")).toHaveTextContent("正在读取外观设置")
    cleanup()

    const view = renderDesigner()
    expect(await screen.findByRole("heading", { name: "外观设置" })).toBeVisible()
    const frame = screen.getByTitle("博客外观实时预览")
    const frameUrl = new URL(frame.getAttribute("src")!)
    expect(`${frameUrl.origin}${frameUrl.pathname}`).toBe(PREVIEW_URL)
    expect(frameUrl.searchParams.has("kgpAppearance")).toBe(true)
    expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts")
    cleanup()

    renderDesigner({ previewUrl: "https://public.example.com/" })
    expect(await screen.findByText("本地预览不可用")).toBeVisible()
    expect(screen.queryByTitle("博客外观实时预览")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "一键应用" })).toBeDisabled()
    expect(view.api.read).toHaveBeenCalledOnce()
  })

  it("uses one stable UUID-tagged URL for the appearance iframe and preview requests", async () => {
    vi.useFakeTimers()
    const { api } = renderDesigner()
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(100)

    const frame = screen.getByTitle("博客外观实时预览")
    const first = vi.mocked(api.preview).mock.calls[0]![0]
    const sessionPreviewUrl = new URL(first.url)
    expect(frame).toHaveAttribute("src", first.url)
    expect(sessionPreviewUrl.searchParams.get("kgpAppearance")).toBe(first.sessionId)
    expect(first.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )

    fireEvent.change(screen.getByLabelText("强调色"), { target: { value: "#111111" } })
    await vi.advanceTimersByTimeAsync(100)

    const latest = vi.mocked(api.preview).mock.calls.at(-1)![0]
    expect(latest.url).toBe(first.url)
    expect(latest.sessionId).toBe(first.sessionId)
    expect(frame).toHaveAttribute("src", latest.url)
  })

  it("renders unsupported frameworks read-only with the adapter message", async () => {
    const api = appearanceApi({
      read: vi.fn().mockResolvedValue(
        success(
          supportedSnapshot({
            framework: "hugo",
            supported: false,
            message: "Hugo 外观适配器尚未安装。",
          }),
        ),
      ),
    })
    renderDesigner({ api })

    expect(await screen.findByRole("alert")).toHaveTextContent("Hugo 外观适配器尚未安装")
    expect(screen.queryByRole("button", { name: "一键应用" })).not.toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "快速主题" })).not.toBeInTheDocument()
  })

  it("ignores an older appearance read when Strict Mode replays the loading effect", async () => {
    const reads: Array<(value: IpcResult<AppearanceSnapshot>) => void> = []
    const api = appearanceApi({
      read: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            reads.push(resolve)
          }),
      ),
    })
    renderDesigner({ api, strict: true })
    expect(reads).toHaveLength(2)

    await act(async () =>
      reads[1]!(
        success(
          supportedSnapshot({
            settings: APPEARANCE_PRESETS.minimal,
            baselineHash: HASH_B,
          }),
        ),
      ),
    )
    expect(screen.getByLabelText("强调色")).toHaveValue(APPEARANCE_PRESETS.minimal.colors.accent)

    await act(async () => reads[0]!(success(supportedSnapshot())))
    expect(screen.getByLabelText("强调色")).toHaveValue(APPEARANCE_PRESETS.minimal.colors.accent)
  })

  it("offers all presets and previews a preset without applying it", async () => {
    const { api } = renderDesigner()
    const user = userEvent.setup()
    const presets = await screen.findByRole("group", { name: "快速主题" })
    expect(within(presets).getByRole("button", { name: "知识花园" })).toBeVisible()
    expect(within(presets).getByRole("button", { name: "纸张" })).toBeVisible()
    expect(within(presets).getByRole("button", { name: "极简" })).toBeVisible()

    await user.click(within(presets).getByRole("button", { name: "知识花园" }))
    await waitFor(
      () =>
        expect(api.preview).toHaveBeenLastCalledWith(
          expect.objectContaining({ settings: APPEARANCE_PRESETS["knowledge-garden"] }),
        ),
      { timeout: 800 },
    )
    expect(api.apply).not.toHaveBeenCalled()
    expect(screen.getByText("有未应用的更改")).toBeVisible()
  })

  it("edits every background mode and imports an image without mutating the snapshot", async () => {
    const { api } = renderDesigner()
    const user = userEvent.setup()
    const backgroundType = await screen.findByLabelText("背景类型")

    await user.selectOptions(backgroundType, "gradient")
    expect(screen.getByLabelText("渐变起始色")).toHaveValue("#f4efe3")
    fireEvent.change(screen.getByLabelText("渐变角度"), { target: { value: "125" } })

    await user.selectOptions(backgroundType, "image")
    expect(screen.getByRole("button", { name: "选择背景图片" })).toBeVisible()
    expect(screen.getByRole("button", { name: "一键应用" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "选择背景图片" }))
    expect(api.chooseBackground).toHaveBeenCalledOnce()
    expect(screen.getByText("garden.webp")).toBeVisible()
    fireEvent.change(screen.getByLabelText("图片遮罩强度"), { target: { value: "0.45" } })
    await user.selectOptions(screen.getByLabelText("图片位置"), "top")
    await user.click(screen.getByLabelText("固定背景"))

    await user.selectOptions(backgroundType, "solid")
    fireEvent.change(screen.getByLabelText("背景颜色"), { target: { value: "#123456" } })
    expect(screen.getByText("有未应用的更改")).toBeVisible()
    expect(supportedSnapshot().settings.background).toEqual({ kind: "solid", color: "#f4efe3" })
  })

  it("exposes labelled bounded palette, typography, layout, sidebar, and custom CSS fields", async () => {
    renderDesigner()
    await screen.findByLabelText("强调色")

    fireEvent.change(screen.getByLabelText("强调色"), { target: { value: "#112233" } })
    fireEvent.change(screen.getByLabelText("标题字体"), { target: { value: "Georgia, serif" } })
    fireEvent.change(screen.getByLabelText("正文字体"), { target: { value: "Inter, sans-serif" } })
    fireEvent.change(screen.getByLabelText("代码字体"), {
      target: { value: "Consolas, monospace" },
    })
    fireEvent.change(screen.getByLabelText("基础字号"), { target: { value: "18" } })
    fireEvent.change(screen.getByLabelText("行高"), { target: { value: "1.9" } })
    fireEvent.change(screen.getByLabelText("正文宽度"), { target: { value: "80" } })
    fireEvent.change(screen.getByLabelText("页面最大宽度"), { target: { value: "1500" } })
    fireEvent.change(screen.getByLabelText("侧栏宽度"), { target: { value: "300" } })
    fireEvent.change(screen.getByLabelText("内容间距"), { target: { value: "40" } })
    fireEvent.change(screen.getByLabelText("侧栏显示"), { target: { value: "none" } })
    fireEvent.change(screen.getByLabelText("自定义 CSS"), {
      target: { value: ".article-title { letter-spacing: .02em; }" },
    })

    expect(screen.getByLabelText("基础字号")).toHaveAttribute("min", "10")
    expect(screen.getByLabelText("基础字号")).toHaveAttribute("max", "32")
    expect(screen.getByLabelText("正文宽度")).toHaveAttribute("min", "32")
    expect(screen.getByLabelText("正文宽度")).toHaveAttribute("max", "120")
    expect(screen.getByLabelText("页面最大宽度")).toHaveAttribute("max", "2560")
    expect(screen.getByLabelText("侧栏宽度")).toHaveAttribute("min", "160")
    expect(screen.getByLabelText("内容间距")).toHaveAttribute("max", "128")
    expect(screen.getByRole("button", { name: "一键应用" })).toBeEnabled()
  })

  it("debounces previews, uses monotonic session IDs, and ignores stale completions", async () => {
    vi.useFakeTimers()
    const completions: Array<(value: IpcResult<{ sessionId: string }>) => void> = []
    const api = appearanceApi({
      preview: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            completions.push(resolve)
          }),
      ),
    })
    renderDesigner({ api })
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(100)
    expect(api.preview).toHaveBeenCalledTimes(1)
    const first = vi.mocked(api.preview).mock.calls[0]![0]

    fireEvent.change(screen.getByLabelText("强调色"), { target: { value: "#111111" } })
    await vi.advanceTimersByTimeAsync(99)
    expect(api.preview).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.preview).toHaveBeenCalledTimes(2)
    const second = vi.mocked(api.preview).mock.calls[1]![0]
    expect(second.sessionId).toBe(first.sessionId)

    await act(async () => completions[1]!(success({ sessionId: second.sessionId })))
    expect(screen.getByText("实时预览已更新")).toBeVisible()
    await act(async () => completions[0]!(success({ sessionId: first.sessionId })))
    expect(screen.getByText("实时预览已更新")).toBeVisible()

    fireEvent.change(screen.getByLabelText("强调色"), { target: { value: "#222222" } })
    await vi.advanceTimersByTimeAsync(100)
    expect(api.preview).toHaveBeenCalledTimes(3)
    fireEvent.change(screen.getByLabelText("自定义 CSS"), { target: { value: "</style>" } })
    await act(async () =>
      completions[2]!(success({ sessionId: vi.mocked(api.preview).mock.calls[2]![0].sessionId })),
    )
    expect(screen.queryByText("实时预览已更新")).not.toBeInTheDocument()
  })

  it("clears preview before the Cancel button closes the designer", async () => {
    const order: string[] = []
    const api = appearanceApi({
      clearPreview: vi.fn().mockImplementation(async () => {
        order.push("clear")
        return success(undefined)
      }),
    })
    const onClose = vi.fn(() => order.push("close"))
    renderDesigner({ api, onClose })

    await userEvent.setup().click(await screen.findByRole("button", { name: "取消" }))
    await waitFor(() => expect(order).toEqual(["clear", "close"]))
  })

  it("cancels a pending debounced preview before clearing and closing", async () => {
    vi.useFakeTimers()
    const order: string[] = []
    let finishClear!: () => void
    const clearPending = new Promise<void>((resolve) => {
      finishClear = resolve
    })
    const api = appearanceApi({
      preview: vi.fn().mockImplementation(({ sessionId }) => {
        order.push("preview")
        return Promise.resolve(success({ sessionId }))
      }),
      clearPreview: vi.fn().mockImplementation(async () => {
        order.push("clear")
        await clearPending
        return success(undefined)
      }),
    })
    const onClose = vi.fn(() => order.push("close"))
    renderDesigner({ api, onClose })
    await act(async () => Promise.resolve())

    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(order).toEqual(["clear"])
    await vi.advanceTimersByTimeAsync(100)
    expect(api.preview).not.toHaveBeenCalled()
    expect(order).toEqual(["clear"])

    await act(async () => finishClear())
    expect(order).toEqual(["clear", "close"])
  })

  it("clears preview before Escape closes and traps focus inside the modal", async () => {
    const order: string[] = []
    const api = appearanceApi({
      clearPreview: vi.fn().mockImplementation(async () => {
        order.push("clear")
        return success(undefined)
      }),
    })
    const onClose = vi.fn(() => order.push("close"))
    renderDesigner({ api, onClose })
    await screen.findByRole("button", { name: "取消" })

    const dialog = screen.getByRole("dialog", { name: "外观设置" })
    const first = within(dialog)
      .getAllByRole("button")
      .find(
        (button): button is HTMLButtonElement =>
          button instanceof HTMLButtonElement && !button.disabled,
      )!
    const last = within(dialog)
      .getAllByRole("button")
      .filter(
        (button): button is HTMLButtonElement =>
          button instanceof HTMLButtonElement && !button.disabled,
      )
      .at(-1)!
    first.focus()
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true })
    expect(last).toHaveFocus()

    await userEvent.setup().keyboard("{Escape}")
    await waitFor(() => expect(order).toEqual(["clear", "close"]))
  })

  it.each(["result", "rejection"] as const)(
    "keeps the designer open when preview cleanup fails by %s and retries through the same close path",
    async (failure) => {
      const clearPreview =
        failure === "result"
          ? vi
              .fn()
              .mockResolvedValueOnce({
                ok: false,
                error: { code: "INTERNAL_ERROR", message: "预览清理失败" },
              })
              .mockResolvedValueOnce(success(undefined))
          : vi
              .fn()
              .mockRejectedValueOnce(new Error("预览通道断开"))
              .mockResolvedValueOnce(success(undefined))
      const api = appearanceApi({ clearPreview })
      const onClose = vi.fn()
      renderDesigner({ api, onClose })

      await userEvent.setup().click(await screen.findByRole("button", { name: "取消" }))
      expect(screen.getByRole("dialog", { name: "外观设置" })).toBeVisible()
      expect(screen.getByRole("alert")).toHaveTextContent(
        failure === "result" ? "预览清理失败" : "预览通道断开",
      )
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: "取消" })).toBeEnabled()

      await userEvent.setup().keyboard("{Escape}")
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
      expect(clearPreview).toHaveBeenCalledTimes(2)
    },
  )

  it("disables apply for invalid drafts and while busy, then updates the baseline on success", async () => {
    let finishApply!: (value: IpcResult<{ snapshot: AppearanceSnapshot }>) => void
    const api = appearanceApi({
      apply: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          finishApply = resolve
        }),
      ),
    })
    const { onChanged } = renderDesigner({ api })
    const user = userEvent.setup()
    await screen.findByLabelText("自定义 CSS")
    fireEvent.change(screen.getByLabelText("自定义 CSS"), {
      target: { value: "</style><script>bad()</script>" },
    })
    expect(screen.getByRole("alert")).toHaveTextContent("自定义 CSS")
    expect(screen.getByRole("button", { name: "一键应用" })).toBeDisabled()

    fireEvent.change(screen.getByLabelText("自定义 CSS"), { target: { value: ".ok {}" } })
    await user.click(screen.getByRole("button", { name: "一键应用" }))
    expect(api.apply).toHaveBeenCalledWith(
      expect.objectContaining({ baselineHash: HASH_A, settings: expect.any(Object) }),
    )
    expect(screen.getByRole("button", { name: "正在应用…" })).toBeDisabled()
    finishApply(success({ snapshot: supportedSnapshot({ baselineHash: HASH_B }) }))
    expect(await screen.findByText(/外观已应用/)).toHaveAttribute("role", "status")
    expect(screen.getByRole("dialog", { name: "外观设置" })).toBeVisible()
    expect(screen.queryByText("有未应用的更改")).not.toBeInTheDocument()
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it.each([
    ["APPEARANCE_CONFLICT", "外观文件已在其他位置发生变化", "重新读取"],
    ["APPEARANCE_TRANSACTION_FAILED", "构建失败，已恢复应用前的外观", "修正后重试"],
  ] as const)("explains %s apply failures", async (code, expected, action) => {
    const api = appearanceApi({
      apply: vi.fn().mockResolvedValue({
        ok: false,
        error: { code, message: code === "APPEARANCE_CONFLICT" ? "changed" : "rolled back" },
      }),
    })
    renderDesigner({ api })
    const user = userEvent.setup()
    await screen.findByLabelText("强调色")
    fireEvent.change(screen.getByLabelText("强调色"), { target: { value: "#112233" } })
    await user.click(screen.getByRole("button", { name: "一键应用" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(expected)
    expect(screen.getByRole("alert")).toHaveTextContent(action)
    expect(screen.getByText("有未应用的更改")).toBeVisible()
  })

  it("resets defaults as draft-only and reloads the snapshot returned by undo", async () => {
    const { api, onChanged } = renderDesigner()
    const user = userEvent.setup()
    await screen.findByRole("button", { name: "恢复默认" })

    await user.click(screen.getByRole("button", { name: "恢复默认" }))
    expect(screen.getByLabelText("强调色")).toHaveValue(DEFAULT_APPEARANCE.colors.accent)
    expect(api.apply).not.toHaveBeenCalled()
    expect(screen.getByText("有未应用的更改")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "撤销上次应用" }))
    expect(api.undo).toHaveBeenCalledWith({ baselineHash: HASH_A })
    expect(await screen.findByText(/已撤销上次应用/)).toHaveAttribute("role", "status")
    expect(screen.getByLabelText("强调色")).toHaveValue(APPEARANCE_PRESETS.paper.colors.accent)
    expect(screen.getByRole("button", { name: "撤销上次应用" })).toBeDisabled()
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it("declares the approved independent scrolling, sticky actions, and narrow layout", async () => {
    renderDesigner()
    await screen.findByRole("dialog", { name: "外观设置" })
    expect(document.querySelector(".appearance-body")).toBeInTheDocument()
    expect(document.querySelector(".appearance-controls")).toBeInTheDocument()
    expect(document.querySelector(".appearance-preview")).toBeInTheDocument()
    expect(document.querySelector(".appearance-actions")).toBeInTheDocument()

    const css = readFileSync("src/renderer/src/app.css", "utf8")
    expect(css).toMatch(
      /\.appearance-body\s*{[^}]*grid-template-columns:\s*minmax\(300px, 34%\) 1fr/s,
    )
    expect(css).toMatch(/\.appearance-(?:controls|preview)[^{]*{[^}]*overflow:\s*auto/s)
    expect(css).toMatch(/\.appearance-actions\s*{[^}]*position:\s*sticky/s)
    expect(css).toMatch(
      /@media\s*\(max-width:\s*1000px\)[\s\S]*\.appearance-body\s*{[^}]*grid-template-columns:\s*1fr/,
    )
  })

  it("retains component color draft and selected preview target across component switches and preview navigation", async () => {
    const api = appearanceApi()
    const { rerender } = render(
      <AppearanceDesigner
        api={api}
        previewUrl={PREVIEW_URL}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    )
    const user = userEvent.setup()
    await screen.findByRole("dialog", { name: "外观设置" })

    await user.click(screen.getByRole("tab", { name: "悬停" }))
    await user.click(screen.getByRole("button", { name: "设置卡片背景覆盖" }))

    await waitFor(() =>
      expect(api.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          target: { componentId: "domainCard", state: "hover" },
          settings: expect.objectContaining({
            componentColors: {
              domainCard: {
                hover: {
                  surface: APPEARANCE_PRESETS.paper.colors.surface.toUpperCase(),
                },
              },
            },
          }),
        }),
      ),
    )

    await user.click(screen.getByRole("button", { name: "标签" }))
    expect(screen.getByRole("tab", { name: "悬停" })).toHaveAttribute("aria-selected", "true")

    rerender(
      <AppearanceDesigner
        api={api}
        previewUrl="http://127.0.0.1:8080/technology/css-grid"
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(api.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("http://127.0.0.1:8080/technology/css-grid"),
          target: { componentId: "tag", state: "hover" },
          settings: expect.objectContaining({
            componentColors: {
              domainCard: {
                hover: {
                  surface: APPEARANCE_PRESETS.paper.colors.surface.toUpperCase(),
                },
              },
            },
          }),
        }),
      ),
    )
  })
})
