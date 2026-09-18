import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { App } from "../../src/renderer/src/App"

describe("App", () => {
  it("renders the garden identity and three primary panes", () => {
    render(<App />)

    expect(screen.getByText("~/Knowledge Garden")).toBeVisible()
    expect(screen.getByRole("navigation", { name: "笔记" })).toBeVisible()
    expect(screen.getByRole("region", { name: "Markdown 编辑器" })).toBeVisible()
    expect(screen.getByRole("region", { name: "本地预览" })).toBeVisible()
  })
})
