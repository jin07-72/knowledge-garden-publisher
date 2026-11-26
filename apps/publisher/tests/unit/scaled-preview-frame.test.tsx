import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ScaledPreviewFrame } from "../../src/renderer/src/components/ScaledPreviewFrame"

afterEach(() => {
  cleanup()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe("ScaledPreviewFrame", () => {
  it("scales down the desktop iframe to always show the full horizontal width", () => {
    let resizeCallback: (() => void) | undefined
    class MockResizeObserver {
      constructor(callback: () => void) {
        resizeCallback = callback
      }
      observe(): void {}
      disconnect(): void {}
    }
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver

    let mockWidth = 744
    let mockHeight = 500
    const widthSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")
    const heightSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => mockWidth,
    })
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => mockHeight,
    })

    try {
      render(
        <ScaledPreviewFrame
          title="缩放预览测试"
          src="http://127.0.0.1:8080/"
          sandbox="allow-same-origin allow-scripts"
          desktopWidth={1488}
        />,
      )

      const frame = screen.getByTitle("缩放预览测试")
      expect(frame).toHaveStyle({
        width: "1488px",
        height: "1000px",
        transform: "scale(0.5)",
        transformOrigin: "top left",
      })

      mockWidth = 1600
      mockHeight = 900
      act(() => resizeCallback?.())

      expect(frame.style.transform).toBe("")
      expect(frame.style.width).toBe("")
    } finally {
      if (widthSpy) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthSpy)
      if (heightSpy) Object.defineProperty(HTMLElement.prototype, "clientHeight", heightSpy)
    }
  })
})
