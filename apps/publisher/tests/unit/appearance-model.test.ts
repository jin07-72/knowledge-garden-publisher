import { describe, expect, it } from "vitest"
import {
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE,
  cloneAppearancePreset,
  compileAppearanceCss,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from "../../src/shared/appearance"

function withSettings(overrides: Partial<AppearanceSettings>): AppearanceSettings {
  return {
    ...DEFAULT_APPEARANCE,
    ...overrides,
    colors: { ...DEFAULT_APPEARANCE.colors, ...overrides.colors },
    componentColors: overrides.componentColors ?? DEFAULT_APPEARANCE.componentColors,
    typography: { ...DEFAULT_APPEARANCE.typography, ...overrides.typography },
    layout: { ...DEFAULT_APPEARANCE.layout, ...overrides.layout },
  }
}

const imageSettings = withSettings({
  background: {
    kind: "image",
    asset: {
      source: "staged",
      token: "11111111-1111-4111-8111-111111111111",
      name: "renderer-private.webp",
    },
    overlay: "#102030",
    opacity: 0.4,
    position: "top",
    fixed: true,
  },
})

describe("appearance presets", () => {
  it("keeps templates immutable and clones every nested value", () => {
    const first = cloneAppearancePreset("paper")
    const second = cloneAppearancePreset("paper")

    for (const preset of Object.values(APPEARANCE_PRESETS)) {
      expect(Object.isFrozen(preset)).toBe(true)
      expect(Object.isFrozen(preset.colors)).toBe(true)
      expect(Object.isFrozen(preset.componentColors)).toBe(true)
      expect(preset.schemaVersion).toBe(2)
      expect(preset.componentColors).toEqual({})
    }
    expect(first).not.toBe(second)
    expect(first.colors).not.toBe(second.colors)
    expect(first.componentColors).not.toBe(second.componentColors)
    expect(first.typography).not.toBe(second.typography)
    expect(first.layout).not.toBe(second.layout)
    expect(first.background).not.toBe(second.background)

    ;(first.colors as { page: string }).page = "#abcdef"
    expect(second.colors.page).toBe(APPEARANCE_PRESETS.paper.colors.page)
    expect(APPEARANCE_PRESETS.paper.colors.page).not.toBe("#abcdef")
  })
})

describe("appearance normalization", () => {
  it("clamps every numeric control without mutating the source", () => {
    const source = withSettings({
      componentColors: {
        domainCard: { hover: { surface: "#aabbcc80" } },
      },
      background: {
        kind: "image",
        asset: { source: "managed", name: "background.webp" },
        overlay: "#000000",
        opacity: 4,
        position: "bottom",
        fixed: false,
      },
      typography: {
        ...DEFAULT_APPEARANCE.typography,
        baseSizePx: 2,
        lineHeight: Number.POSITIVE_INFINITY,
      },
      layout: {
        ...DEFAULT_APPEARANCE.layout,
        articleWidthCh: 1_000,
        pageWidthPx: 12,
        sidebarWidthPx: 1_000,
        gapPx: -10,
      },
    })

    const normalized = normalizeAppearanceSettings(source)

    expect(normalized.background).toMatchObject({ opacity: 1 })
    expect(normalized.typography).toMatchObject({ baseSizePx: 10, lineHeight: 1.7 })
    expect(normalized.layout).toMatchObject({
      articleWidthCh: 120,
      pageWidthPx: 640,
      sidebarWidthPx: 640,
      gapPx: 0,
    })
    expect(source.background).toMatchObject({ opacity: 4 })
    expect(source.typography.lineHeight).toBe(Number.POSITIVE_INFINITY)
    expect(normalized).not.toBe(source)
    expect(normalized.colors).not.toBe(source.colors)
    expect(normalized.componentColors).toEqual({
      domainCard: { hover: { surface: "#AABBCC80" } },
    })
    expect(normalized.componentColors).not.toBe(source.componentColors)
    expect(normalized.componentColors.domainCard).not.toBe(source.componentColors.domainCard)
    expect(normalized.componentColors.domainCard?.hover).not.toBe(
      source.componentColors.domainCard?.hover,
    )
  })

  it("normalizes gradient angles to the contract range", () => {
    const normalized = normalizeAppearanceSettings(
      withSettings({
        background: {
          kind: "gradient",
          start: "#000000",
          end: "#ffffff",
          angle: -45,
        },
      }),
    )

    expect(normalized.background).toEqual({
      kind: "gradient",
      start: "#000000",
      end: "#ffffff",
      angle: 0,
    })
  })
})

describe("managed appearance CSS", () => {
  it("emits all normalized color, typography, and layout controls", () => {
    const css = compileAppearanceCss(DEFAULT_APPEARANCE)

    for (const declaration of [
      "--publisher-page: #0b1120;",
      "--publisher-surface: #111827;",
      "--publisher-text: #d1d5db;",
      "--publisher-heading: #f9fafb;",
      "--publisher-accent: #22d3ee;",
      "--publisher-secondary: #94a3b8;",
      "--publisher-border: #334155;",
      "--publisher-code: #0f172a;",
      '--publisher-font-header: "Inter", system-ui, sans-serif;',
      '--publisher-font-body: "Inter", system-ui, sans-serif;',
      '--publisher-font-code: "JetBrains Mono", ui-monospace, monospace;',
      "--publisher-base-size: 16px;",
      "--publisher-line-height: 1.7;",
      "--publisher-article-width: 72ch;",
      "--publisher-page-width: 1440px;",
      "--publisher-sidebar-width: 280px;",
      "--publisher-gap: 32px;",
    ])
      expect(css).toContain(declaration)

    expect(css).toContain(
      ":where(.page > #quartz-body) .center article { max-width: var(--publisher-article-width);",
    )
    expect(css).toContain(
      ":where(.page > #quartz-body .center article) :is(pre, code) { font-family: var(--publisher-font-code);",
    )
  })

  it("maps appearance controls to real Quartz theme tokens and scoped consumers", () => {
    const css = compileAppearanceCss(
      withSettings({
        background: {
          kind: "gradient",
          start: "#010203",
          end: "#040506",
          angle: 45,
        },
        colors: {
          page: "#101010",
          surface: "#202020",
          text: "#303030",
          heading: "#404040",
          accent: "#505050",
          secondary: "#606060",
          border: "#707070",
          code: "#808080",
        },
        typography: {
          header: '"Header Face", serif',
          body: '"Body Face", sans-serif',
          code: '"Code Face", monospace',
          baseSizePx: 18,
          lineHeight: 1.9,
        },
      }),
    )

    expect(css).toContain('html:root,\nhtml:root[saved-theme="dark"] {')
    for (const mapping of [
      "--light: var(--publisher-page);",
      "--lightgray: var(--publisher-surface);",
      "--gray: var(--publisher-border);",
      "--darkgray: var(--publisher-text);",
      "--dark: var(--publisher-heading);",
      "--secondary: var(--publisher-accent);",
      "--tertiary: var(--publisher-secondary);",
      "--titleFont: var(--publisher-font-header);",
      "--headerFont: var(--publisher-font-header);",
      "--bodyFont: var(--publisher-font-body);",
      "--codeFont: var(--publisher-font-code);",
      "--background-primary: var(--publisher-page);",
      "--background-secondary: var(--publisher-surface);",
      "--background-modifier-border: var(--publisher-border);",
      "--text-normal: var(--publisher-text);",
      "--text-muted: var(--publisher-secondary);",
      "--text-accent: var(--publisher-accent);",
      "--nav-item-color: var(--publisher-secondary);",
      "--nav-item-color-active: var(--publisher-accent);",
      "--divider-color: var(--publisher-border);",
      "--link-color: var(--publisher-accent);",
    ])
      expect(css).toContain(mapping)

    expect(css).toContain(
      "background-color: var(--publisher-page); background-image: linear-gradient(45deg, #010203, #040506);",
    )
    expect(css).toContain(
      ":where(.page > #quartz-body) :is(.callout, .popover-inner) { background-color: var(--publisher-surface); border-color: var(--publisher-border); }",
    )
    expect(css).toContain(
      ".popover > .popover-inner { color: var(--publisher-text); font-family: var(--publisher-font-body); font-size: var(--publisher-base-size); line-height: var(--publisher-line-height); background-color: var(--publisher-surface); border-color: var(--publisher-border); }",
    )
    expect(css).toContain(
      ":where(.page > #quartz-body .center article) :is(p, ul, ol, li, table, tbody, tr, td, th) { font-family: inherit; font-size: inherit; line-height: inherit; }",
    )
    expect(css).toContain(
      ":where(.page > #quartz-body .center article) :is(h1, h2, h3, h4, h5, h6, thead) { color: var(--publisher-heading); font-family: var(--publisher-font-header); line-height: inherit; }",
    )
    expect(css).toContain(
      ":where(.page > #quartz-body .center article) :is(pre, code) { font-family: var(--publisher-font-code); line-height: inherit; background-color: var(--publisher-code); }",
    )
    expect(css).toContain(
      ":where(.page > #quartz-body) :is(.sidebar, .page-header, .page-footer) { font-family: var(--publisher-font-body); line-height: var(--publisher-line-height); }",
    )
  })

  it("applies managed typography and code colors to body-appended Quartz popovers", () => {
    const managed = compileAppearanceCss(DEFAULT_APPEARANCE)
    const style = document.createElement("style")
    style.textContent = `
      body { font-family: quartz-body; font-size: 13px; line-height: 1.2; }
      tbody, li, p { line-height: 1.6rem; }
      pre, code { font-family: quartz-code; background-color: rgb(8, 8, 8); }
      pre > code { background: none; }
      .popover > .popover-inner {
        color: rgb(1, 2, 3);
        font-family: quartz-body;
        font-size: initial;
        line-height: normal;
        background-color: rgb(4, 5, 6);
        border-color: rgb(7, 8, 9);
      }
      ${managed}
    `
    const popover = document.createElement("div")
    popover.className = "popover"
    popover.innerHTML = `
      <div class="popover-inner">
        <p>paragraph</p>
        <ul><li>list item</li></ul>
        <table><tbody><tr><td>cell</td></tr></tbody></table>
        <pre><code>code</code></pre>
      </div>
    `
    document.head.append(style)
    document.body.append(popover)

    try {
      const inner = popover.querySelector<HTMLElement>(".popover-inner")!
      const paragraph = popover.querySelector<HTMLElement>("p")!
      const listItem = popover.querySelector<HTMLElement>("li")!
      const cell = popover.querySelector<HTMLElement>("td")!
      const pre = popover.querySelector<HTMLElement>("pre")!
      const code = popover.querySelector<HTMLElement>("code")!

      expect(getComputedStyle(inner).fontFamily).toBe("var(--publisher-font-body)")
      expect(getComputedStyle(inner).fontSize).toBe("var(--publisher-base-size)")
      expect(getComputedStyle(inner).lineHeight).toBe("var(--publisher-line-height)")
      expect(getComputedStyle(inner).backgroundColor).toBe("var(--publisher-surface)")
      for (const element of [paragraph, listItem, cell]) {
        expect(getComputedStyle(element).fontFamily).toBe("var(--publisher-font-body)")
        expect(getComputedStyle(element).fontSize).toBe("var(--publisher-base-size)")
        expect(getComputedStyle(element).lineHeight).toBe("var(--publisher-line-height)")
      }
      for (const element of [pre, code]) {
        expect(getComputedStyle(element).fontFamily).toBe("var(--publisher-font-code)")
        expect(getComputedStyle(element).backgroundColor).toBe("var(--publisher-code)")
      }
    } finally {
      popover.remove()
      style.remove()
    }
  })

  it("lets appended class-based custom CSS override low-specificity managed defaults", () => {
    const customCss = `.article-copy { line-height: 2.5; }
.custom-code { font-family: custom-code; background-color: rgb(1, 2, 3); }
.sidebar { color: rgb(12, 13, 14); }
.popover > .popover-inner { background-color: rgb(4, 5, 6); }`
    const managed = compileAppearanceCss(withSettings({ customCss }))
    const style = document.createElement("style")
    style.textContent = `
      tbody, li, p { line-height: 1.6rem; }
      pre, code { font-family: quartz-code; background-color: rgb(8, 8, 8); }
      .popover > .popover-inner { background-color: rgb(9, 10, 11); }
      ${managed}
    `
    const page = document.createElement("div")
    page.className = "page"
    page.innerHTML = `<div id="quartz-body"><aside class="left sidebar">left</aside><div class="center"><article class="article-copy"><p>copy</p><code class="custom-code">code</code></article></div><aside class="right sidebar">right</aside></div>`
    const popover = document.createElement("div")
    popover.className = "popover"
    popover.innerHTML = `<div class="popover-inner">popover</div>`
    document.head.append(style)
    document.body.append(page, popover)

    try {
      const article = page.querySelector<HTMLElement>("article")!
      const paragraph = page.querySelector<HTMLElement>("p")!
      const code = page.querySelector<HTMLElement>("code")!
      const sidebars = page.querySelectorAll<HTMLElement>(".sidebar")
      const popoverInner = popover.querySelector<HTMLElement>(".popover-inner")!

      expect(getComputedStyle(article).lineHeight).toBe("2.5")
      expect(getComputedStyle(paragraph).lineHeight).toBe("2.5")
      expect(getComputedStyle(code).fontFamily).toBe("custom-code")
      expect(getComputedStyle(code).backgroundColor).toBe("rgb(1, 2, 3)")
      expect(sidebars).toHaveLength(2)
      for (const sidebar of sidebars) {
        expect(getComputedStyle(sidebar).color).toBe("rgb(12, 13, 14)")
      }
      expect(getComputedStyle(popoverInner).backgroundColor).toBe("rgb(4, 5, 6)")
      expect(managed.endsWith(customCss)).toBe(true)
      expect(customCss).not.toContain("!important")
    } finally {
      page.remove()
      popover.remove()
      style.remove()
    }
  })

  it("keeps managed tokens authoritative after later light and dark Quartz token rules", () => {
    const managed = compileAppearanceCss(DEFAULT_APPEARANCE)
    const style = document.createElement("style")
    style.textContent = `${managed}\n:root { --light: #ffffff; --bodyFont: fallback; }\n:root[saved-theme="dark"] { --light: #000000; --bodyFont: fallback-dark; }`
    document.head.append(style)
    document.documentElement.setAttribute("saved-theme", "dark")

    try {
      const computed = getComputedStyle(document.documentElement)
      expect(computed.getPropertyValue("--light").trim()).toBe("var(--publisher-page)")
      expect(computed.getPropertyValue("--bodyFont").trim()).toBe("var(--publisher-font-body)")
    } finally {
      style.remove()
      document.documentElement.removeAttribute("saved-theme")
    }
  })

  it("compiles solid and gradient backgrounds", () => {
    expect(
      compileAppearanceCss(withSettings({ background: { kind: "solid", color: "#123456" } })),
    ).toContain("background-color: #123456;")

    expect(
      compileAppearanceCss(
        withSettings({
          background: {
            kind: "gradient",
            start: "#112233",
            end: "#aabbcc",
            angle: 135,
          },
        }),
      ),
    ).toContain("background-image: linear-gradient(135deg, #112233, #aabbcc);")
  })

  it("uses only an adapter-provided public URL for image backgrounds", () => {
    const css = compileAppearanceCss(imageSettings, {
      imageUrl: "./publisher/background.webp",
    })

    expect(css).toContain('url("./publisher/background.webp")')
    expect(css).toContain("rgba(16, 32, 48, 0.4)")
    expect(css).toContain("background-position: top;")
    expect(css).toContain("background-attachment: fixed;")
    expect(css).not.toContain("renderer-private.webp")
    expect(css).not.toContain("11111111-1111-4111-8111-111111111111")
    expect(compileAppearanceCss(imageSettings, { imageUrl: undefined })).not.toContain("url(")
  })

  it("escapes quoted CSS URLs without changing safe public URLs", () => {
    const css = compileAppearanceCss(imageSettings, {
      imageUrl: './publisher/a"b\\c\nd</style>.webp',
    })

    expect(css).toContain('url("./publisher/a\\"b\\\\c\\a d\\3c /style\\3e .webp")')
    expect(css).not.toContain("</style>")
  })

  it("emits responsive Quartz grid rules for every sidebar mode", () => {
    const both = compileAppearanceCss(
      withSettings({ layout: { ...DEFAULT_APPEARANCE.layout, sidebars: "both" } }),
    )
    const left = compileAppearanceCss(
      withSettings({ layout: { ...DEFAULT_APPEARANCE.layout, sidebars: "left" } }),
    )
    const none = compileAppearanceCss(
      withSettings({ layout: { ...DEFAULT_APPEARANCE.layout, sidebars: "none" } }),
    )

    const ordinaryFrame =
      '.page:not([data-frame="full-width"]):not([data-frame="minimal"]) > #quartz-body'

    for (const css of [both, left, none]) {
      expect(css).toContain("@media all and (min-width: 1200px)")
      expect(css).toContain("@media all and (min-width: 800px) and (max-width: 1200px)")
      expect(css).toContain("@media all and (max-width: 800px)")
      expect(css).toContain(ordinaryFrame)
      expect(css).toContain("gap: var(--publisher-gap);")
    }

    expect(both).toContain(
      "grid-template-columns: var(--publisher-sidebar-width) minmax(0, 1fr) var(--publisher-sidebar-width);",
    )
    expect(both).toContain(
      '"grid-sidebar-left grid-header grid-sidebar-right"\n      "grid-sidebar-left grid-center grid-sidebar-right"\n      "grid-sidebar-left grid-footer grid-sidebar-right";',
    )
    expect(both).toContain(
      '"grid-sidebar-left"\n      "grid-header"\n      "grid-center"\n      "grid-sidebar-right"\n      "grid-footer";',
    )
    expect(both).not.toContain("display: none")

    expect(left).toContain("grid-template-columns: var(--publisher-sidebar-width) minmax(0, 1fr);")
    expect(left).toContain(
      '"grid-sidebar-left grid-header"\n      "grid-sidebar-left grid-center"\n      "grid-sidebar-left grid-footer";',
    )
    expect(left).not.toContain('"grid-sidebar-right')
    expect(left).toContain(".right.sidebar { display: none; }")
    expect(left).not.toContain(".left.sidebar { display: none; }")

    expect(none).toContain("grid-template-columns: minmax(0, 1fr);")
    expect(none).toContain('"grid-header"\n      "grid-center"\n      "grid-footer";')
    expect(none).not.toContain('"grid-sidebar-left')
    expect(none).not.toContain('"grid-sidebar-right')
    expect(none).toContain(
      `${ordinaryFrame} .left.sidebar, ${ordinaryFrame} .right.sidebar { display: none; }`,
    )
  })

  it("places trimmed custom CSS last while preserving its contents", () => {
    const customCss = '\n.custom {\n  content: "  exact  ";\n}\n'
    const css = compileAppearanceCss(withSettings({ customCss }))

    expect(css.endsWith('.custom {\n  content: "  exact  ";\n}')).toBe(true)
    expect(css.indexOf(".custom {")).toBeGreaterThan(css.indexOf(".center article"))
  })

  it("is byte-for-byte deterministic", () => {
    expect(compileAppearanceCss(DEFAULT_APPEARANCE)).toBe(compileAppearanceCss(DEFAULT_APPEARANCE))
  })
})
