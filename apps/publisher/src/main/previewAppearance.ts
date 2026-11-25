import type { AppearancePreviewTarget } from "../shared/contracts"

export interface PreviewFramePort {
  readonly url: string
  executeJavaScript(source: string, userGesture?: boolean): Promise<unknown>
}

export interface AppearancePreviewFramePort extends PreviewFramePort {
  readonly frameTreeNodeId: number
  readonly detached: boolean
}

export type PreviewFrameSource = readonly PreviewFramePort[] | (() => readonly PreviewFramePort[])

export interface AppearanceFramePreviewRequest {
  readonly url: string
  readonly sessionId: string
  readonly css: string
  readonly target?: AppearancePreviewTarget
}

export interface AppearanceFrameClearRequest {
  readonly url: string
  readonly sessionId: string
}

type AppearancePreviewQueryMatch = "exact" | "ignore"

function normalizeAppearancePreviewUrl(
  value: string,
  queryMatch: AppearancePreviewQueryMatch,
): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
    url.hash = ""
    if (queryMatch === "ignore") url.search = ""
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    return url.toString()
  } catch {
    return undefined
  }
}

export function normalizedAppearancePreviewUrl(value: string): string | undefined {
  return normalizeAppearancePreviewUrl(value, "exact")
}

function normalizedLegacyAppearancePreviewUrl(value: string): string | undefined {
  return normalizeAppearancePreviewUrl(value, "ignore")
}

function installPreviewStyle(payload: {
  expectedUrl: string
  sessionId: string
  css: string
  target?: AppearancePreviewTarget
  exactQuery: boolean
}): boolean {
  const normalize = (value: string): string | undefined => {
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
      url.hash = ""
      if (!payload.exactQuery) url.search = ""
      url.pathname = url.pathname.replace(/\/+$/, "") || "/"
      return url.toString()
    } catch {
      return undefined
    }
  }
  if (normalize(location.href) !== payload.expectedUrl) return false
  document
    .querySelectorAll("style[data-publisher-appearance-preview]")
    .forEach((node) => node.remove())
  const style = document.createElement("style")
  style.dataset.publisherAppearancePreview = payload.sessionId
  style.textContent = payload.css
  document.head.append(style)

  const root = document.documentElement
  root.dataset.publisherAppearanceSession = payload.sessionId
  if (payload.target) {
    root.dataset.publisherAppearanceComponent = payload.target.componentId
    root.dataset.publisherAppearanceState = payload.target.state
  } else {
    delete root.dataset.publisherAppearanceComponent
    delete root.dataset.publisherAppearanceState
  }

  document
    .querySelectorAll("[data-publisher-appearance-focused]")
    .forEach((node) => node.removeAttribute("data-publisher-appearance-focused"))

  const activeComponentId = payload.target?.componentId
  document.querySelectorAll<HTMLElement>("[data-publisher-appearance-mock]").forEach((node) => {
    if (node.dataset.publisherAppearanceMock !== activeComponentId) node.remove()
  })

  const searchComponents = new Set(["searchOverlay", "searchDialog", "searchInput", "searchResult"])
  if (!activeComponentId || !searchComponents.has(activeComponentId)) {
    document
      .querySelectorAll<HTMLElement>(
        '.search-container[data-publisher-appearance-search-open="true"]',
      )
      .forEach((node) => {
        node.classList.remove("active")
        delete node.dataset.publisherAppearanceSearchOpen
      })
    document
      .querySelectorAll<HTMLElement>('.search-layout[data-publisher-appearance-search-open="true"]')
      .forEach((node) => {
        node.classList.remove("display-results")
        delete node.dataset.publisherAppearanceSearchOpen
      })
  }

  if (payload.target && typeof payload.target.focusSeq === "number") {
    let focusStyle = document.querySelector<HTMLStyleElement>(
      "style[data-publisher-appearance-focus-style]",
    )
    if (!focusStyle) {
      focusStyle = document.createElement("style")
      focusStyle.dataset.publisherAppearanceFocusStyle = "true"
      focusStyle.textContent = [
        "@keyframes publisher-appearance-focus-pulse {",
        "  0% { outline-color: #38bdf8; box-shadow: 0 0 0 8px rgba(56, 189, 248, 0.42); }",
        "  100% { outline-color: #38bdf8; box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.24); }",
        "}",
        '[data-publisher-appearance-focused="true"] {',
        "  outline: 3px solid #38bdf8 !important;",
        "  outline-offset: 4px !important;",
        "  box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.24) !important;",
        "  border-radius: 4px;",
        "  animation: publisher-appearance-focus-pulse 0.45s ease-out;",
        "}",
        '[data-publisher-appearance-focused="inset"] {',
        "  outline: 4px solid #38bdf8 !important;",
        "  outline-offset: -6px !important;",
        "  box-shadow: inset 0 0 0 8px rgba(56, 189, 248, 0.24) !important;",
        "}",
        'html[data-publisher-appearance-component="mobileMenu"] .explorer > button.mobile-explorer {',
        "  display: inline-flex !important;",
        "}",
      ].join("\n")
      document.head.append(focusStyle)
    }

    const componentId = payload.target.componentId
    if (searchComponents.has(componentId)) {
      const container = document.querySelector<HTMLElement>(".search > .search-container")
      if (container && !container.classList.contains("active")) {
        container.classList.add("active")
        container.dataset.publisherAppearanceSearchOpen = "true"
      }
      const layout = container?.querySelector<HTMLElement>(".search-layout")
      if (layout && !layout.classList.contains("display-results")) {
        layout.classList.add("display-results")
        layout.dataset.publisherAppearanceSearchOpen = "true"
      }
      if (componentId === "searchResult" && layout && !layout.querySelector(".result-card")) {
        const host = layout.querySelector<HTMLElement>(".results-container") ?? layout
        const sample = document.createElement("a")
        sample.className = "result-card"
        sample.href = "#preview-search-result"
        sample.dataset.publisherAppearanceMock = "searchResult"
        sample.addEventListener("click", (event) => event.preventDefault())
        const heading = document.createElement("h3")
        heading.textContent = "示例搜索结果"
        const summary = document.createElement("p")
        summary.textContent = "用于预览搜索结果的颜色样式"
        sample.append(heading, summary)
        host.append(sample)
      }
    } else if (componentId === "popover" && !document.querySelector(".popover > .popover-inner")) {
      const host =
        document.querySelector<HTMLElement>(".center article") ??
        document.querySelector<HTMLElement>(".center") ??
        document.querySelector<HTMLElement>("main") ??
        document.body
      if (host) {
        const popover = document.createElement("div")
        popover.className = "popover"
        popover.dataset.publisherAppearanceMock = "popover"
        popover.style.cssText =
          "position:relative;display:block;visibility:visible;opacity:1;margin:1rem 0;z-index:10;"
        const inner = document.createElement("div")
        inner.className = "popover-inner"
        const heading = document.createElement("h3")
        heading.textContent = "悬浮预览示例"
        const body = document.createElement("p")
        body.textContent = "用于预览悬浮卡片的背景、边框、标题与正文颜色。"
        inner.append(heading, body)
        popover.append(inner)
        host.prepend(popover)
      }
    } else if (componentId === "tooltip" && !document.querySelector('[role="tooltip"], .tooltip')) {
      const host =
        document.querySelector<HTMLElement>(".center article") ??
        document.querySelector<HTMLElement>(".center") ??
        document.querySelector<HTMLElement>("main") ??
        document.body
      if (host) {
        const tooltip = document.createElement("div")
        tooltip.className = "tooltip"
        tooltip.setAttribute("role", "tooltip")
        tooltip.dataset.publisherAppearanceMock = "tooltip"
        tooltip.style.cssText =
          "position:relative;display:inline-block;visibility:visible;opacity:1;padding:0.5rem 0.75rem;border:1px solid transparent;border-radius:6px;margin:1rem 0;"
        const heading = document.createElement("h4")
        heading.style.margin = "0 0 0.25rem"
        heading.textContent = "工具提示示例"
        const text = document.createElement("span")
        text.textContent = "用于预览工具提示颜色。"
        tooltip.append(heading, text)
        host.prepend(tooltip)
      }
    }

    const focusSelectors: Record<string, readonly string[]> = {
      domainCard: [".domain-card"],
      homeSearch: [".search > button.search-button"],
      homeStats: [".garden-stats", ".garden-kicker"],
      explorer: [".explorer .tree-item-self", ".explorer"],
      mobileMenu: [".explorer > button.mobile-explorer"],
      breadcrumb: [".breadcrumb-container a", ".breadcrumb-container"],
      tableOfContents: [".toc > .toc-content.overflow > li > a", ".toc > .toc-header", ".toc"],
      searchOverlay: [".search > .search-container"],
      searchDialog: [".search > .search-container > .search-space > .search-layout"],
      searchInput: [".search > .search-container > .search-space > .search-bar"],
      searchResult: [".search > .search-container > .search-space > .search-layout .result-card"],
      link: [".center article a:not(.tag-link):not(.domain-card)"],
      button: [".graph > .graph-outer > .global-graph-icon", ".darkmode", ".readermode"],
      tag: [".tag-link"],
      icon: [".graph > .graph-outer > .global-graph-icon", ".darkmode", ".readermode"],
      codeBlock: [".center article pre"],
      inlineCode: [".center article :not(pre) > code"],
      blockquote: [".center article blockquote"],
      table: [".center article table"],
      callout: [".callout"],
      divider: [".center article hr"],
      popover: [".popover > .popover-inner"],
      tooltip: ['[role="tooltip"]', ".tooltip"],
      graph: [".graph > .graph-outer"],
      footer: [".page > #quartz-body > footer"],
    }

    const selectors = focusSelectors[componentId]
    if (selectors && selectors.length > 0) {
      const combined = selectors.join(", ")
      const candidates = Array.from(document.querySelectorAll<Element>(combined))
      const isVisible = (element: Element): boolean => {
        if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
          return true
        }
        const computed = window.getComputedStyle(element)
        return computed.display !== "none" && computed.visibility !== "hidden"
      }
      const firstMatch = candidates.find(isVisible) ?? candidates[0]
      const seqText = String(payload.target.focusSeq)

      if (firstMatch) {
        firstMatch.setAttribute(
          "data-publisher-appearance-focused",
          componentId === "searchOverlay" ? "inset" : "true",
        )
        if (root.dataset.publisherAppearanceFocusedSeq !== seqText) {
          root.dataset.publisherAppearanceFocusedSeq = seqText
          if (typeof firstMatch.scrollIntoView === "function") {
            firstMatch.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" })
          }
        }
      } else if (
        root.dataset.publisherAppearanceFocusedSeq !== seqText &&
        root.dataset.publisherAppearanceTriedNavSeq !== seqText &&
        typeof location.assign === "function" &&
        typeof fetch === "function" &&
        typeof DOMParser === "function"
      ) {
        root.dataset.publisherAppearanceTriedNavSeq = seqText
        const expectedSession = payload.sessionId
        void (async () => {
          const stillCurrent = (): boolean =>
            root.dataset.publisherAppearanceSession === expectedSession &&
            root.dataset.publisherAppearanceComponent === componentId
          const currentUrl = new URL(location.href)
          if (currentUrl.protocol !== "http:" || currentUrl.hostname !== "127.0.0.1") return
          const prefixMatch = /^\/([a-f0-9]{32})(?:\/|$)/.exec(currentUrl.pathname)
          const rawBase = root.getAttribute("data-basepath") || ""
          const sitePrefix = prefixMatch ? `/${prefixMatch[1]}` : rawBase.replace(/\/+$/, "")
          const homeUrl = `${currentUrl.origin}${sitePrefix}/`
          const normalizePage = (href: string): string | undefined => {
            try {
              const parsed = new URL(href, currentUrl.origin)
              if (parsed.origin !== currentUrl.origin) return undefined
              parsed.hash = ""
              parsed.search = ""
              parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/"
              return parsed.toString()
            } catch {
              return undefined
            }
          }
          const currentNormalized = normalizePage(location.href)
          if (componentId === "domainCard" || componentId === "homeStats") {
            const homeNormalized = normalizePage(homeUrl)
            if (homeNormalized && homeNormalized !== currentNormalized && stillCurrent()) {
              location.assign(homeUrl)
            }
            return
          }

          const candidateUrls: string[] = []
          const seen = new Set<string>(currentNormalized ? [currentNormalized] : [])
          const pushCandidate = (href: string): void => {
            const normalizedCandidate = normalizePage(href)
            if (!normalizedCandidate || seen.has(normalizedCandidate)) return
            seen.add(normalizedCandidate)
            candidateUrls.push(href)
          }

          document
            .querySelectorAll<HTMLAnchorElement>(
              ".explorer a[href], .domain-card[href], a.internal[href]",
            )
            .forEach((anchor) => pushCandidate(anchor.href))

          try {
            const indexResponse = await fetch(
              `${currentUrl.origin}${sitePrefix}/static/contentIndex.json`,
            )
            if (indexResponse.ok) {
              const indexData = (await indexResponse.json()) as Record<string, unknown>
              for (const slug of Object.keys(indexData)) {
                const targetPath =
                  slug === "index"
                    ? `${sitePrefix}/`
                    : `${sitePrefix}/${slug.replace(/\/index$/, "/")}`
                pushCandidate(`${currentUrl.origin}${targetPath}`)
              }
            }
          } catch {
            // Best-effort discovery when contentIndex.json is unavailable.
          }

          for (const candidateUrl of candidateUrls.slice(0, 25)) {
            if (!stillCurrent()) return
            try {
              const response = await fetch(candidateUrl)
              if (!response.ok) continue
              const html = await response.text()
              const parsedDocument = new DOMParser().parseFromString(html, "text/html")
              if (parsedDocument.querySelector(combined)) {
                if (stillCurrent()) location.assign(candidateUrl)
                return
              }
            } catch {
              continue
            }
          }
        })().catch(() => undefined)
      }
    }
  }

  document.dispatchEvent(new Event("themechange"))
  return true
}

function clearPreviewStyle(payload: {
  expectedUrl: string
  sessionId: string
  exactQuery: boolean
}): boolean {
  const normalize = (value: string): string | undefined => {
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined
      url.hash = ""
      if (!payload.exactQuery) url.search = ""
      url.pathname = url.pathname.replace(/\/+$/, "") || "/"
      return url.toString()
    } catch {
      return undefined
    }
  }
  if (normalize(location.href) !== payload.expectedUrl) return false
  document
    .querySelectorAll<HTMLStyleElement>("style[data-publisher-appearance-preview]")
    .forEach((style) => {
      if (style.dataset.publisherAppearancePreview === payload.sessionId) style.remove()
    })
  const root = document.documentElement
  if (root.dataset.publisherAppearanceSession === payload.sessionId) {
    delete root.dataset.publisherAppearanceSession
    delete root.dataset.publisherAppearanceComponent
    delete root.dataset.publisherAppearanceState
    delete root.dataset.publisherAppearanceFocusedSeq
    delete root.dataset.publisherAppearanceTriedNavSeq
    document
      .querySelectorAll("style[data-publisher-appearance-focus-style]")
      .forEach((node) => node.remove())
    document
      .querySelectorAll("[data-publisher-appearance-focused]")
      .forEach((node) => node.removeAttribute("data-publisher-appearance-focused"))
    document.querySelectorAll("[data-publisher-appearance-mock]").forEach((node) => node.remove())
    document
      .querySelectorAll<HTMLElement>(
        '.search-container[data-publisher-appearance-search-open="true"]',
      )
      .forEach((node) => {
        node.classList.remove("active")
        delete node.dataset.publisherAppearanceSearchOpen
      })
    document
      .querySelectorAll<HTMLElement>('.search-layout[data-publisher-appearance-search-open="true"]')
      .forEach((node) => {
        node.classList.remove("display-results")
        delete node.dataset.publisherAppearanceSearchOpen
      })
  }
  document.dispatchEvent(new Event("themechange"))
  return true
}

function scriptFor<Payload>(operation: (payload: Payload) => boolean, payload: Payload): string {
  return `(${operation.toString()})(${JSON.stringify(payload)})`
}

async function executeInLegacyFrame(
  frameSource: PreviewFrameSource,
  url: string,
  execute: (frame: PreviewFramePort) => Promise<boolean>,
): Promise<boolean> {
  try {
    const requestedUrl = normalizedLegacyAppearancePreviewUrl(url)
    if (!requestedUrl) return false
    const frames = typeof frameSource === "function" ? frameSource() : frameSource
    const frame = frames.find(
      (candidate) => normalizedLegacyAppearancePreviewUrl(candidate.url) === requestedUrl,
    )
    if (!frame) return false
    return execute(frame)
  } catch {
    return false
  }
}

async function installAppearancePreviewInFrameMatchingQuery(
  frame: PreviewFramePort,
  request: AppearanceFramePreviewRequest,
  queryMatch: AppearancePreviewQueryMatch,
): Promise<boolean> {
  try {
    const expectedUrl = normalizeAppearancePreviewUrl(request.url, queryMatch)
    if (!expectedUrl || normalizeAppearancePreviewUrl(frame.url, queryMatch) !== expectedUrl) {
      return false
    }
    return (
      (await frame.executeJavaScript(
        scriptFor(installPreviewStyle, {
          expectedUrl,
          sessionId: request.sessionId,
          css: request.css,
          ...(request.target ? { target: request.target } : {}),
          exactQuery: queryMatch === "exact",
        }),
        true,
      )) === true
    )
  } catch {
    return false
  }
}

export function installAppearancePreviewInFrame(
  frame: PreviewFramePort,
  request: AppearanceFramePreviewRequest,
): Promise<boolean> {
  return installAppearancePreviewInFrameMatchingQuery(frame, request, "exact")
}

async function removeAppearancePreviewFromFrameMatchingQuery(
  frame: PreviewFramePort,
  request: AppearanceFrameClearRequest,
  queryMatch: AppearancePreviewQueryMatch,
): Promise<boolean> {
  try {
    const expectedUrl = normalizeAppearancePreviewUrl(request.url, queryMatch)
    if (!expectedUrl || normalizeAppearancePreviewUrl(frame.url, queryMatch) !== expectedUrl) {
      return false
    }
    return (
      (await frame.executeJavaScript(
        scriptFor(clearPreviewStyle, {
          expectedUrl,
          sessionId: request.sessionId,
          exactQuery: queryMatch === "exact",
        }),
        true,
      )) === true
    )
  } catch {
    return false
  }
}

export function removeAppearancePreviewFromFrame(
  frame: PreviewFramePort,
  request: AppearanceFrameClearRequest,
): Promise<boolean> {
  return removeAppearancePreviewFromFrameMatchingQuery(frame, request, "exact")
}

export function previewAppearance(
  frames: PreviewFrameSource,
  request: AppearanceFramePreviewRequest,
): Promise<boolean> {
  return executeInLegacyFrame(frames, request.url, (frame) =>
    installAppearancePreviewInFrameMatchingQuery(frame, request, "ignore"),
  )
}

export function clearAppearancePreview(
  frames: PreviewFrameSource,
  request: AppearanceFrameClearRequest,
): Promise<boolean> {
  return executeInLegacyFrame(frames, request.url, (frame) =>
    removeAppearancePreviewFromFrameMatchingQuery(frame, request, "ignore"),
  )
}
