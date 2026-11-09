import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearAppearancePreview,
  previewAppearance,
  type PreviewFramePort,
} from "../../src/main/previewAppearance"

function executableFrame(url: string, executionUrl = url): PreviewFramePort {
  return {
    url,
    executeJavaScript: vi.fn(async (source: string) =>
      Function("document", "location", `return ${source}`)(document, { href: executionUrl }),
    ),
  }
}

describe("appearance preview frame boundary", () => {
  beforeEach(() => {
    document.head.replaceChildren()
    delete (globalThis as { pwned?: boolean }).pwned
  })

  it("installs only in the exact normalized 127.0.0.1 frame", async () => {
    const unrelated = executableFrame("https://example.com/technology/css-grid/")
    const preview = executableFrame(
      "http://127.0.0.1:8080/technology/../technology/css-grid/?draft=1#heading",
    )

    await expect(
      previewAppearance([unrelated, preview], {
        url: "http://127.0.0.1:8080/technology/css-grid",
        sessionId: "session-1",
        css: "body { color: teal; }",
      }),
    ).resolves.toBe(true)

    expect(unrelated.executeJavaScript).not.toHaveBeenCalled()
    expect(preview.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("data-publisher-appearance-preview"),
      true,
    )
  })

  it.each([
    "http://localhost:8080/note",
    "https://127.0.0.1:8080/note",
    "https://example.com/note",
    "not a url",
  ])("rejects an untrusted requested URL: %s", async (url) => {
    const candidate = executableFrame(url)

    await expect(
      previewAppearance([candidate], {
        url,
        sessionId: "session-1",
        css: "body {}",
      }),
    ).resolves.toBe(false)
    expect(candidate.executeJavaScript).not.toHaveBeenCalled()
  })

  it("does not run code in a non-loopback frame even when its normalized URL text differs only by host", async () => {
    const localhost = executableFrame("http://localhost:8080/note/")
    const online = executableFrame("http://example.com:8080/note/")
    const malformed = executableFrame("not a frame url")

    await expect(
      previewAppearance([localhost, online, malformed], {
        url: "http://127.0.0.1:8080/note",
        sessionId: "session-1",
        css: "body {}",
      }),
    ).resolves.toBe(false)
    expect(localhost.executeJavaScript).not.toHaveBeenCalled()
    expect(online.executeJavaScript).not.toHaveBeenCalled()
    expect(malformed.executeJavaScript).not.toHaveBeenCalled()
  })

  it("fails closed for malformed results and frames that navigate during execution", async () => {
    const malformed: PreviewFramePort = {
      url: "http://127.0.0.1:8080/note",
      executeJavaScript: vi.fn(async () => "true"),
    }
    const navigated: PreviewFramePort = {
      url: "http://127.0.0.1:8080/other",
      executeJavaScript: vi.fn(async () => {
        throw new Error("frame navigated")
      }),
    }

    await expect(
      previewAppearance([malformed], {
        url: malformed.url,
        sessionId: "session-1",
        css: "body {}",
      }),
    ).resolves.toBe(false)
    await expect(
      previewAppearance([navigated], {
        url: navigated.url,
        sessionId: "session-1",
        css: "body {}",
      }),
    ).resolves.toBe(false)
  })

  it.each([
    "https://example.com/note",
    "http://localhost:8080/note",
    "http://127.0.0.1:8080/different",
    "not an execution url",
  ])("does not mutate the DOM after the selected frame navigates to %s", async (executionUrl) => {
    const preview = executableFrame("http://127.0.0.1:8080/note", executionUrl)
    const existing = document.createElement("style")
    existing.dataset.publisherAppearancePreview = "session-1"
    existing.textContent = "body { color: red; }"
    document.head.append(existing)

    await expect(
      previewAppearance([preview], {
        url: "http://127.0.0.1:8080/note",
        sessionId: "session-2",
        css: "body { color: teal; }",
      }),
    ).resolves.toBe(false)
    expect([...document.head.querySelectorAll("style[data-publisher-appearance-preview]")]).toEqual(
      [existing],
    )

    await expect(
      clearAppearancePreview([preview], {
        url: "http://127.0.0.1:8080/note",
        sessionId: "session-1",
      }),
    ).resolves.toBe(false)
    expect(existing.isConnected).toBe(true)
  })

  it("fails closed when reading a candidate URL throws", async () => {
    const executeJavaScript = vi.fn()
    const disposed = {
      get url(): string {
        throw new Error("frame disposed")
      },
      executeJavaScript,
    }

    await expect(
      previewAppearance([disposed], {
        url: "http://127.0.0.1:8080/note",
        sessionId: "session-1",
        css: "body {}",
      }),
    ).resolves.toBe(false)
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it("fails closed when enumerating the current frame subtree throws", async () => {
    const frames = (): readonly PreviewFramePort[] => {
      throw new Error("frame subtree detached")
    }

    await expect(
      previewAppearance(frames, {
        url: "http://127.0.0.1:8080/note",
        sessionId: "session-1",
        css: "body {}",
      }),
    ).resolves.toBe(false)
    await expect(
      clearAppearancePreview(frames, {
        url: "http://127.0.0.1:8080/note",
        sessionId: "session-1",
      }),
    ).resolves.toBe(false)
  })

  it("replaces an older Publisher style and serializes CSS as inert text", async () => {
    const preview = executableFrame("http://127.0.0.1:8080/note")
    const oldStyle = document.createElement("style")
    oldStyle.dataset.publisherAppearancePreview = "old-session"
    oldStyle.textContent = "body { color: red; }"
    document.head.append(oldStyle)
    const css = 'body::before { content: "` ${globalThis.pwned = true} \\n"; }'

    await expect(
      previewAppearance([preview], {
        url: preview.url,
        sessionId: "new-session",
        css,
      }),
    ).resolves.toBe(true)

    const styles = document.querySelectorAll("style[data-publisher-appearance-preview]")
    expect(styles).toHaveLength(1)
    expect(styles[0]?.getAttribute("data-publisher-appearance-preview")).toBe("new-session")
    expect(styles[0]?.textContent).toBe(css)
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined()
  })

  it("clears only the matching session in the exact frame", async () => {
    const unrelated = executableFrame("http://127.0.0.1:8080/other")
    const preview = executableFrame("http://127.0.0.1:8080/note/")
    for (const sessionId of ["session-1", "session-2"]) {
      const style = document.createElement("style")
      style.dataset.publisherAppearancePreview = sessionId
      document.head.append(style)
    }

    await expect(
      clearAppearancePreview([unrelated, preview], {
        url: "http://127.0.0.1:8080/note",
        sessionId: "session-1",
      }),
    ).resolves.toBe(true)

    expect(unrelated.executeJavaScript).not.toHaveBeenCalled()
    expect(
      document.querySelector('style[data-publisher-appearance-preview="session-1"]'),
    ).toBeNull()
    expect(
      document.querySelector('style[data-publisher-appearance-preview="session-2"]'),
    ).not.toBeNull()
  })
})
