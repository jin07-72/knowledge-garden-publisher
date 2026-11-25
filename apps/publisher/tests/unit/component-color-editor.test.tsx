import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_APPEARANCE } from "../../src/shared/appearance"
import { ComponentColorEditor } from "../../src/renderer/src/components/ComponentColorEditor"

afterEach(() => {
  cleanup()
})

describe("ComponentColorEditor", () => {
  it("searches components, edits a hover slot, and restores inheritance", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onTargetChange = vi.fn()
    render(
      <ComponentColorEditor
        settings={DEFAULT_APPEARANCE}
        disabled={false}
        onChange={onChange}
        onPreviewTargetChange={onTargetChange}
      />,
    )

    await user.type(screen.getByRole("searchbox", { name: "搜索组件" }), "领域")
    await user.click(screen.getByRole("button", { name: "领域卡片" }))
    await user.click(screen.getByRole("tab", { name: "悬停" }))
    expect(onTargetChange).toHaveBeenLastCalledWith({ componentId: "domainCard", state: "hover" })

    await user.click(screen.getByRole("button", { name: "设置卡片背景覆盖" }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "custom",
        componentColors: {
          domainCard: {
            hover: {
              surface: DEFAULT_APPEARANCE.colors.surface.toUpperCase(),
            },
          },
        },
      }),
    )

    await user.click(screen.getByRole("button", { name: "卡片背景恢复继承" }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ componentColors: {} }))
  })

  it("disables unsupported states and resets to normal when selecting a normal-only component", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onTargetChange = vi.fn()
    render(
      <ComponentColorEditor
        settings={DEFAULT_APPEARANCE}
        disabled={false}
        onChange={onChange}
        onPreviewTargetChange={onTargetChange}
      />,
    )

    await user.click(screen.getByRole("tab", { name: "悬停" }))
    expect(onTargetChange).toHaveBeenLastCalledWith({ componentId: "domainCard", state: "hover" })

    await user.click(screen.getByRole("button", { name: "分隔线" }))
    expect(onTargetChange).toHaveBeenLastCalledWith({ componentId: "divider", state: "normal" })
    expect(screen.getByRole("tab", { name: "正常" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "悬停" })).toBeDisabled()
    expect(screen.getByRole("tab", { name: "选中" })).toBeDisabled()
  })

  it("restores all overrides for the selected component", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <ComponentColorEditor
        settings={{
          ...DEFAULT_APPEARANCE,
          componentColors: {
            domainCard: {
              normal: { surface: "#112233CC" },
              hover: { title: "#FFFFFF" },
            },
            tag: {
              normal: { text: "#AABBCC" },
            },
          },
        }}
        disabled={false}
        onChange={onChange}
        onPreviewTargetChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole("button", { name: "恢复本组件全部继承" }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        componentColors: {
          tag: {
            normal: { text: "#AABBCC" },
          },
        },
      }),
    )
  })
})
