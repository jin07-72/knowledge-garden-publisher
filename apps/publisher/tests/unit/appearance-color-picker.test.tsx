import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AppearanceColorPicker } from "../../src/renderer/src/components/AppearanceColorPicker"

afterEach(() => {
  cleanup()
})

describe("AppearanceColorPicker", () => {
  it("keeps text colors opaque and normalizes valid manual input", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <AppearanceColorPicker label="标题" value="#ffffff" allowAlpha={false} onChange={onChange} />,
    )

    await user.clear(screen.getByLabelText("标题颜色值"))
    await user.type(screen.getByLabelText("标题颜色值"), "#12abef")
    expect(onChange).not.toHaveBeenCalled()
    await user.tab()

    expect(onChange).toHaveBeenLastCalledWith("#12ABEF")
    expect(screen.queryByLabelText("标题透明度")).not.toBeInTheDocument()
  })

  it("commits valid manual input on Enter and rejects alpha in opaque slots", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <AppearanceColorPicker label="正文" value="#112233" allowAlpha={false} onChange={onChange} />,
    )

    const input = screen.getByLabelText("正文颜色值")
    await user.clear(input)
    await user.type(input, "#11223380{Enter}")
    expect(onChange).not.toHaveBeenCalled()

    await user.clear(input)
    await user.type(input, "#abcdef{Enter}")
    expect(onChange).toHaveBeenLastCalledWith("#ABCDEF")
  })

  it("edits alpha without changing RGB", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<AppearanceColorPicker label="背景" value="#10203080" allowAlpha onChange={onChange} />)

    await user.clear(screen.getByLabelText("背景透明度"))
    await user.type(screen.getByLabelText("背景透明度"), "100")

    expect(onChange).toHaveBeenLastCalledWith("#102030FF")
  })

  it("ignores out-of-range alpha input and restores the valid value on blur", async () => {
    const onChange = vi.fn()
    render(<AppearanceColorPicker label="边框" value="#10203080" allowAlpha onChange={onChange} />)

    const alphaInput = screen.getByLabelText("边框透明度")
    expect(alphaInput).toHaveValue(50)
    fireEvent.change(alphaInput, { target: { value: "150" } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(alphaInput)
    expect(alphaInput).toHaveValue(50)
  })
})
