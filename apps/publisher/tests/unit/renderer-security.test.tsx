import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { PreviewPane } from "../../src/renderer/src/components/PreviewPane"
import type { NoteSummary, PreviewStatus } from "../../src/shared/contracts"

const note: NoteSummary = {
  path: "content/technology/css-grid.md",
  domain: "technology",
  slug: "css-grid",
  title: "CSS Grid",
  date: "2026-09-18",
  description: "layout",
  visibility: "public",
  updatedAt: "2026-09-18T00:00:00.000Z",
  tags: ["css"],
}

const preview: PreviewStatus = {
  state: "ready",
  generation: 1,
  url: "http://127.0.0.1:8080/",
  lastSuccessfulUrl: "http://127.0.0.1:8080/",
}

describe("renderer security", () => {
  it("sandboxes both local Quartz frames without navigation, popup, or download capabilities", async () => {
    render(
      <PreviewPane
        note={note}
        preview={preview}
        onLoadHistory={async () => ({
          commits: [],
          deployments: {
            runs: [],
            actionsUrl: "https://github.com/octocat/garden/actions/workflows/deploy.yml",
            liveSiteUrl: "https://octocat.github.io/garden/",
          },
        })}
        onCancelHistory={async () => undefined}
        onOpenHistoryLink={async () => undefined}
      />,
    )
    expect(screen.getByTitle("CSS Grid的 Quartz 精确预览")).toHaveAttribute(
      "sandbox",
      "allow-same-origin allow-scripts",
    )

    fireEvent.click(screen.getByRole("tab", { name: "全站本地" }))
    expect(screen.getByTitle("Quartz 本地全站预览")).toHaveAttribute(
      "sandbox",
      "allow-same-origin allow-scripts",
    )
  })

  it("declares a strict renderer CSP for local dev and production frame targets", async () => {
    const html = await readFile(resolve("src/renderer/index.html"), "utf8")
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("default-src 'self'")
    expect(html).toContain("script-src 'self'")
    expect(html).toContain("frame-src http://127.0.0.1:* https://jin07-72.github.io")
    expect(html).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(html).not.toContain("unsafe-eval")
  })
})
