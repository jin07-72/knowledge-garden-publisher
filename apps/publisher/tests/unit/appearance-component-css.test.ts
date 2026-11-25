import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_APPEARANCE, compileAppearanceCss } from "../../src/shared/appearance"
import {
  APPEARANCE_COMPONENT_SELECTORS,
  compileAppearanceComponentCss,
} from "../../src/shared/appearanceComponentCss"
import { APPEARANCE_COMPONENTS } from "../../src/shared/appearanceComponents"

const settingsWithComponentOverrides = {
  ...DEFAULT_APPEARANCE,
  componentColors: {
    domainCard: {
      normal: {
        surface: "#112233CC",
        border: "#223344",
        number: "#334455",
        title: "#445566",
        description: "#556677",
      },
      hover: {
        surface: "#667788DD",
        border: "#778899",
        number: "#8899AA",
        title: "#99AABB",
        description: "#AABBCC",
      },
    },
  },
} as const

const forcedHover = (selector: string) => `[data-publisher-appearance-state="hover"] ${selector}`
const forcedSelected = (selector: string) =>
  `[data-publisher-appearance-state="selected"] ${selector}`

const EXPECTED_SELECTORS = {
  domainCard: {
    normal: [".domain-card"],
    hover: [".domain-card:hover", forcedHover(".domain-card")],
    selected: [
      '.domain-card[aria-current="page"]',
      ".domain-card:focus-visible",
      forcedSelected(".domain-card"),
    ],
  },
  homeSearch: {
    normal: [".search > button.search-button"],
    hover: [".search > button.search-button:hover", forcedHover(".search > button.search-button")],
    selected: [
      '.search > button.search-button[aria-expanded="true"]',
      forcedSelected(".search > button.search-button"),
    ],
  },
  homeStats: { normal: [".garden-stats", ".garden-kicker"] },
  explorer: {
    normal: [".explorer .tree-item-self"],
    hover: [".explorer .tree-item-self:hover", forcedHover(".explorer .tree-item-self")],
    selected: [
      ".explorer .tree-item-self.active.is-active",
      forcedSelected(".explorer .tree-item-self"),
    ],
  },
  mobileMenu: {
    normal: [".explorer > button.mobile-explorer"],
    hover: [
      ".explorer > button.mobile-explorer:hover",
      forcedHover(".explorer > button.mobile-explorer"),
    ],
    selected: [
      '.explorer[aria-expanded="true"] > button.mobile-explorer',
      forcedSelected(".explorer > button.mobile-explorer"),
    ],
  },
  breadcrumb: {
    normal: [".breadcrumb-container a"],
    hover: [".breadcrumb-container a:hover", forcedHover(".breadcrumb-container a")],
    selected: [
      ".breadcrumb-container .breadcrumb-element:last-child a",
      forcedSelected(".breadcrumb-container a"),
    ],
  },
  tableOfContents: {
    normal: [".toc > .toc-header", ".toc > .toc-content.overflow > li > a"],
    hover: [
      ".toc > .toc-header:hover",
      ".toc > .toc-content.overflow > li > a:hover",
      forcedHover(".toc > .toc-content.overflow > li > a"),
    ],
    selected: [
      ".toc > .toc-content.overflow > li > a.in-view",
      '.toc > .toc-header[aria-expanded="true"]',
      forcedSelected(".toc > .toc-content.overflow > li > a"),
    ],
  },
  searchOverlay: { normal: [".search > .search-container"] },
  searchDialog: {
    normal: [".search > .search-container > .search-space > .search-layout"],
  },
  searchInput: {
    normal: [".search > .search-container > .search-space > .search-bar"],
    hover: [
      ".search > .search-container > .search-space > .search-bar:hover",
      forcedHover(".search > .search-container > .search-space > .search-bar"),
    ],
    selected: [
      ".search > .search-container > .search-space > .search-bar:focus",
      forcedSelected(".search > .search-container > .search-space > .search-bar"),
    ],
  },
  searchResult: {
    normal: [".search > .search-container > .search-space > .search-layout .result-card"],
    hover: [
      ".search > .search-container > .search-space > .search-layout .result-card:hover",
      forcedHover(".search > .search-container > .search-space > .search-layout .result-card"),
    ],
    selected: [
      ".search > .search-container > .search-space > .search-layout .result-card.focus",
      ".search > .search-container > .search-space > .search-layout .result-card:focus",
      forcedSelected(".search > .search-container > .search-space > .search-layout .result-card"),
    ],
  },
  link: {
    normal: [".center article a:not(.tag-link):not(.domain-card)"],
    hover: [
      ".center article a:not(.tag-link):not(.domain-card):hover",
      forcedHover(".center article a:not(.tag-link):not(.domain-card)"),
    ],
    selected: [
      '.center article a:not(.tag-link):not(.domain-card)[aria-current="page"]',
      ".center article a:not(.tag-link):not(.domain-card):focus-visible",
      forcedSelected(".center article a:not(.tag-link):not(.domain-card)"),
    ],
  },
  button: {
    normal: [".graph > .graph-outer > .global-graph-icon", ".darkmode", ".readermode"],
    hover: [
      ".graph > .graph-outer > .global-graph-icon:hover",
      ".darkmode:hover",
      ".readermode:hover",
      forcedHover(".graph > .graph-outer > .global-graph-icon"),
      forcedHover(".darkmode"),
      forcedHover(".readermode"),
    ],
    selected: [
      ".graph:has(> .global-graph-outer.active) > .graph-outer > .global-graph-icon",
      'html[saved-theme="dark"] .darkmode',
      'html[reader-mode="on"] .readermode',
      forcedSelected(".graph > .graph-outer > .global-graph-icon"),
      forcedSelected(".darkmode"),
      forcedSelected(".readermode"),
    ],
  },
  tag: {
    normal: [".tag-link"],
    hover: [".tag-link:hover", forcedHover(".tag-link")],
    selected: [
      '.tag-link[aria-current="page"]',
      ".tag-link:focus-visible",
      forcedSelected(".tag-link"),
    ],
  },
  icon: {
    normal: [".graph > .graph-outer > .global-graph-icon svg", ".darkmode svg", ".readermode svg"],
    hover: [
      ".graph > .graph-outer > .global-graph-icon:hover svg",
      ".darkmode:hover svg",
      ".readermode:hover svg",
      forcedHover(".graph > .graph-outer > .global-graph-icon svg"),
      forcedHover(".darkmode svg"),
      forcedHover(".readermode svg"),
    ],
    selected: [
      ".graph:has(> .global-graph-outer.active) > .graph-outer > .global-graph-icon svg",
      'html[saved-theme="dark"] .darkmode svg',
      'html[reader-mode="on"] .readermode svg',
      forcedSelected(".graph > .graph-outer > .global-graph-icon svg"),
      forcedSelected(".darkmode svg"),
      forcedSelected(".readermode svg"),
    ],
  },
  codeBlock: { normal: [".center article pre"] },
  inlineCode: { normal: [".center article :not(pre) > code"] },
  blockquote: { normal: [".center article blockquote"] },
  table: {
    normal: [".center article table"],
    hover: [".center article tbody tr:hover", forcedHover(".center article tbody tr")],
    selected: [".center article tbody tr:focus-within", forcedSelected(".center article tbody tr")],
  },
  callout: { normal: [".callout"] },
  divider: { normal: [".center article hr"] },
  popover: { normal: [".popover > .popover-inner"] },
  tooltip: { normal: ['[role="tooltip"]', ".tooltip"] },
  graph: {
    normal: [".graph > .graph-outer"],
    hover: [".graph > .graph-outer:hover", forcedHover(".graph > .graph-outer")],
    selected: [
      ".graph > .global-graph-outer.active > .global-graph-container",
      forcedSelected(".graph > .graph-outer"),
    ],
  },
  footer: {
    normal: [".page > #quartz-body > footer"],
    hover: [".page > #quartz-body > footer a:hover", forcedHover(".page > #quartz-body > footer")],
    selected: [
      '.page > #quartz-body > footer a[aria-current="page"]',
      ".page > #quartz-body > footer a:focus-visible",
      forcedSelected(".page > #quartz-body > footer"),
    ],
  },
} as const

describe("component appearance CSS", () => {
  it("wins the real Quartz cascade for specialized controls and content panels", () => {
    const managed = compileAppearanceComponentCss({
      componentColors: {
        homeSearch: { normal: { text: "#112233" } },
        tableOfContents: { normal: { text: "#223344" } },
        graph: { normal: { text: "#334455" } },
        callout: { normal: { text: "#445566" } },
        table: { normal: { text: "#556677" } },
      },
    })
    const style = document.createElement("style")
    style.textContent = `
      .search-button, .toc-header, .graph-outer, .callout, article table {
        color: rgb(1, 2, 3);
      }
      .search > .search-button > p,
      ul.toc-content.overflow > li > a {
        color: rgb(1, 2, 3);
      }
      .search > .search-button svg .search-path {
        stroke: rgb(1, 2, 3);
      }
      ${managed}
    `
    const fixture = document.createElement("div")
    fixture.innerHTML = `
      <div class="search"><button class="search-button"><svg><path class="search-path"></path></svg><p>search</p></button></div>
      <div class="toc"><button class="toc-header">toc</button><ul class="toc-content overflow"><li><a>section</a></li></ul></div>
      <div class="graph"><div class="graph-outer">graph</div></div>
      <div class="callout">callout</div>
      <div class="center"><article><table><tbody><tr><td>table</td></tr></tbody></table></article></div>
    `
    document.head.append(style)
    document.body.append(fixture)

    try {
      for (const selector of [
        ".search-button",
        ".toc-header",
        ".graph-outer",
        ".callout",
        "table",
      ]) {
        expect(
          getComputedStyle(fixture.querySelector<HTMLElement>(selector)!).color,
          selector,
        ).toMatch(/^var\(--publisher-component-/)
      }
      expect(getComputedStyle(fixture.querySelector(".search-path")!).stroke).toMatch(
        /^var\(--publisher-component-home-search-/,
      )
      expect(managed).toContain(
        ".search > button.search-button > p {\n  color: var(--publisher-component-home-search-normal-text);",
      )
      expect(managed).toContain(
        ".toc > .toc-content.overflow > li > a {\n  background-color: var(--publisher-component-table-of-contents-normal-surface);",
      )
    } finally {
      fixture.remove()
      style.remove()
    }
  })

  it("keeps specialized controls authoritative when generic colors differ", () => {
    const managed = compileAppearanceComponentCss({
      componentColors: {
        homeSearch: { normal: { text: "#112233", icon: "#223344" } },
        mobileMenu: { normal: { text: "#334455", icon: "#445566" } },
        tableOfContents: { normal: { text: "#556677", icon: "#667788" } },
        button: { normal: { text: "#AABBCC" } },
        icon: { normal: { icon: "#DDEEFF" } },
      },
    })
    const style = document.createElement("style")
    style.textContent = `
      .explorer .mobile-explorer .lucide-menu { stroke: rgb(1, 2, 3); }
      ${managed}
    `
    const fixture = document.createElement("div")
    fixture.innerHTML = `
      <div class="search"><button class="search-button"><svg></svg></button></div>
      <div class="explorer"><button class="explorer-toggle mobile-explorer"><svg class="lucide-menu"></svg></button></div>
      <div class="toc"><button class="toc-header"><svg></svg></button></div>
    `
    document.head.append(style)
    document.body.append(fixture)

    try {
      const expectations = [
        [".search-button", "home-search"],
        [".mobile-explorer", "mobile-menu"],
        [".toc-header", "table-of-contents"],
      ] as const
      for (const [selector, owner] of expectations) {
        const control = fixture.querySelector<HTMLElement>(selector)!
        expect(getComputedStyle(control).color).toBe(
          `var(--publisher-component-${owner}-normal-text)`,
        )
        expect(getComputedStyle(control.querySelector("svg")!).color).toBe(
          `var(--publisher-component-${owner}-normal-icon)`,
        )
      }
      expect(getComputedStyle(fixture.querySelector(".lucide-menu")!).stroke).toBe(
        "var(--publisher-component-mobile-menu-normal-icon)",
      )
    } finally {
      fixture.remove()
      style.remove()
    }
  })

  it("publishes graph colors for the Pixi container without fake DOM nodes", () => {
    const css = compileAppearanceComponentCss({
      componentColors: {
        graph: {
          normal: { surface: "#112233CC", border: "#223344", node: "#334455", text: "#445566" },
          selected: {
            surface: "#556677CC",
            border: "#667788",
            node: "#778899",
            text: "#8899AA",
          },
        },
      },
    })

    expect(css).toContain(".graph > .graph-outer {")
    expect(css).toContain(".graph > .global-graph-outer.active > .global-graph-container")
    expect(css).toContain(
      "--publisher-graph-surface: var(--publisher-component-graph-normal-surface);",
    )
    expect(css).toContain(
      "--publisher-graph-border: var(--publisher-component-graph-normal-border);",
    )
    expect(css).toContain("--publisher-graph-node: var(--publisher-component-graph-normal-node);")
    expect(css).toContain("--publisher-graph-text: var(--publisher-component-graph-normal-text);")
    expect(css).not.toMatch(/:is\(\.node, circle\)|\s\.node(?:\W|$)|\scircle(?:\W|$)/)
  })

  it("resolves concrete domain-card overrides and state fallbacks in registry order", () => {
    const css = compileAppearanceComponentCss(settingsWithComponentOverrides)

    expect(css).toContain("/* publisher-component:domainCard */")
    expect(css).toContain("--publisher-component-domain-card-normal-surface: #112233CC;")
    expect(css).toContain("--publisher-component-domain-card-hover-surface: #667788DD;")
    expect(css).toContain(
      "--publisher-component-domain-card-selected-title: var(--publisher-component-domain-card-normal-title);",
    )
    expect(css).toContain(
      ".domain-card {\n  background-color: var(--publisher-component-domain-card-normal-surface);\n  border-color: var(--publisher-component-domain-card-normal-border);\n  color: var(--publisher-component-domain-card-normal-title);",
    )
    expect(css).toContain(
      '.domain-card:hover, [data-publisher-appearance-state="hover"] .domain-card {\n  background-color: var(--publisher-component-domain-card-hover-surface);\n  border-color: var(--publisher-component-domain-card-hover-border);\n  color: var(--publisher-component-domain-card-hover-title);',
    )

    const normal = css.indexOf("--publisher-component-domain-card-normal-surface:")
    const hover = css.indexOf("--publisher-component-domain-card-hover-surface:")
    const selected = css.indexOf("--publisher-component-domain-card-selected-surface:")
    expect(normal).toBeLessThan(hover)
    expect(hover).toBeLessThan(selected)
  })

  it("emits markers and concrete or inherited variables in deterministic order", () => {
    const first = compileAppearanceComponentCss(DEFAULT_APPEARANCE)
    const second = compileAppearanceComponentCss(DEFAULT_APPEARANCE)

    expect(first).toBe(second)
    const markers = [...first.matchAll(/\/\* publisher-component:([^ ]+) \*\//g)].map(
      (match) => match[1],
    )
    expect(markers).toEqual(Object.keys(APPEARANCE_COMPONENTS))
    expect(markers).toHaveLength(25)
    expect(first).not.toMatch(/^  --publisher-component-/m)

    const overridden = compileAppearanceComponentCss(settingsWithComponentOverrides)
    const variableNames = [...overridden.matchAll(/^  (--publisher-component-[^:]+):/gm)].map(
      (match) => match[1],
    )
    const domainSlots = Object.keys(APPEARANCE_COMPONENTS.domainCard.slots)
    const expectedVariableNames = APPEARANCE_COMPONENTS.domainCard.states.flatMap((state) =>
      domainSlots.map((slot) => `--publisher-component-domain-card-${state}-${slot}`),
    )
    expect(variableNames).toEqual(expectedVariableNames)
  })

  it.each(Object.entries(EXPECTED_SELECTORS))(
    "publishes exact real-DOM selectors and supported states for %s",
    (componentId, expectedSelectors) => {
      const definition = APPEARANCE_COMPONENTS[componentId as keyof typeof APPEARANCE_COMPONENTS]
      const actual =
        APPEARANCE_COMPONENT_SELECTORS[componentId as keyof typeof APPEARANCE_COMPONENT_SELECTORS]

      expect(actual).toEqual(expectedSelectors)
      expect(Object.keys(actual)).toEqual(definition.states)
      for (const state of ["normal", "hover", "selected"]) {
        expect(Object.hasOwn(actual, state)).toBe(
          (definition.states as readonly string[]).includes(state),
        )
      }
    },
  )

  it("registers exact selectors for all 25 components", () => {
    expect(Object.keys(APPEARANCE_COMPONENT_SELECTORS)).toEqual(Object.keys(APPEARANCE_COMPONENTS))
    expect(Object.keys(APPEARANCE_COMPONENT_SELECTORS)).toHaveLength(25)
  })

  it("uses controlled domain-card hover, selected, preview, and focus-visible selectors", () => {
    const css = compileAppearanceComponentCss(settingsWithComponentOverrides)

    expect(css).toContain(
      '.domain-card:hover, [data-publisher-appearance-state="hover"] .domain-card',
    )
    expect(css).toContain('.domain-card[aria-current="page"]')
    expect(css).toContain('[data-publisher-appearance-state="selected"] .domain-card')
    expect(css).toContain(".domain-card:focus-visible")
    expect(css).toContain("outline: 2px solid var(--publisher-accent) !important;")
    expect(css).toContain("outline-offset: 3px !important;")
    expect(css).toContain("color: var(--publisher-component-domain-card-selected-title);")
    for (const state of ["normal", "hover", "selected"]) {
      expect(css).toMatch(
        new RegExp(
          `(?:^|\\n)[^}]+ \\{\\n  background-color: var\\(--publisher-component-domain-card-${state}-surface\\);\\n  border-color: var\\(--publisher-component-domain-card-${state}-border\\);\\n  color: var\\(--publisher-component-domain-card-${state}-title\\);`,
        ),
      )
      expect(css).toMatch(
        new RegExp(
          `(?:^|\\n)[^}]+strong[^}]* \\{\\n  color: var\\(--publisher-component-domain-card-${state}-title\\);`,
        ),
      )
    }
  })

  it("never emits unscoped generic button or svg rules", () => {
    const css = compileAppearanceComponentCss(DEFAULT_APPEARANCE)

    expect(css).not.toMatch(/(?:^|[,(]\s*)(?:button|svg)(?=\s*(?:[,):]|$))/gm)
  })

  it("keeps component rules before appended custom CSS with equal specificity", () => {
    const customCss = ".domain-card { background-color: rgb(255, 105, 180); }"
    const css = compileAppearanceCss({ ...settingsWithComponentOverrides, customCss })
    const style = document.createElement("style")
    const card = document.createElement("a")
    card.className = "domain-card"
    style.textContent = css
    document.head.append(style)
    document.body.append(card)

    try {
      expect(css).toContain("/* publisher-component:domainCard */")
      expect(css.indexOf("/* publisher-component:domainCard */")).toBeLessThan(
        css.indexOf(customCss),
      )
      expect(css.endsWith(customCss)).toBe(true)
      expect(getComputedStyle(card).backgroundColor).toBe("rgb(255, 105, 180)")
    } finally {
      card.remove()
      style.remove()
    }
  })

  it("preserves legacy domain-card values when no component override exists", () => {
    const css = compileAppearanceComponentCss(DEFAULT_APPEARANCE)
    const customScss = readFileSync(
      resolve(process.cwd(), "../../quartz/styles/custom.scss"),
      "utf8",
    )

    expect(css).not.toContain("--publisher-component-domain-card-normal-surface:")
    expect(css).not.toContain("--publisher-component-domain-card-hover-surface:")
    expect(customScss).toContain(
      "var(--publisher-component-domain-card-normal-surface, rgba(24, 29, 36, 0.82))",
    )
    expect(customScss).toContain(
      "var(--publisher-component-domain-card-normal-border, var(--lightgray))",
    )
    expect(customScss).toContain(
      "var(--publisher-component-domain-card-hover-surface, rgba(37, 43, 52, 0.9))",
    )
    expect(customScss).toContain(
      "var(--publisher-component-domain-card-hover-border, var(--secondary))",
    )
    expect(customScss).not.toContain('.domain-card[aria-current="page"]')
    expect(customScss).not.toContain('[data-publisher-appearance-state="selected"] .domain-card')
    expect(customScss).not.toContain(".domain-card:focus-visible span")

    const overrideCss = compileAppearanceComponentCss(settingsWithComponentOverrides)
    expect(overrideCss).toContain("--publisher-component-domain-card-normal-surface: #112233CC;")
    expect(overrideCss).toContain("--publisher-component-domain-card-hover-surface: #667788DD;")
  })
})
