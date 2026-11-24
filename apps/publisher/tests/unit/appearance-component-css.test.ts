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
    normal: [".search > .search-button"],
    hover: [".search > .search-button:hover", forcedHover(".search > .search-button")],
    selected: [
      '.search > .search-button[aria-expanded="true"]',
      forcedSelected(".search > .search-button"),
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
    normal: [".explorer > .mobile-explorer"],
    hover: [".explorer > .mobile-explorer:hover", forcedHover(".explorer > .mobile-explorer")],
    selected: [
      '.explorer[aria-expanded="true"] > .mobile-explorer',
      forcedSelected(".explorer > .mobile-explorer"),
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
    normal: [".toc > .toc-header", ".toc > .toc-content a"],
    hover: [
      ".toc > .toc-header:hover",
      ".toc > .toc-content a:hover",
      forcedHover(".toc > .toc-content a"),
    ],
    selected: [
      ".toc > .toc-content a.in-view",
      '.toc > .toc-header[aria-expanded="true"]',
      forcedSelected(".toc > .toc-content a"),
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
    normal: [
      ".search > .search-button",
      ".explorer .explorer-toggle",
      ".explorer .folder-button",
      ".toc > .toc-header",
      ".graph > .graph-outer > .global-graph-icon",
      ".darkmode",
      ".readermode",
    ],
    hover: [
      ".search > .search-button:hover",
      ".explorer .explorer-toggle:hover",
      ".explorer .folder-button:hover",
      ".toc > .toc-header:hover",
      ".graph > .graph-outer > .global-graph-icon:hover",
      ".darkmode:hover",
      ".readermode:hover",
      forcedHover(".search > .search-button"),
      forcedHover(".explorer .explorer-toggle"),
      forcedHover(".explorer .folder-button"),
      forcedHover(".toc > .toc-header"),
      forcedHover(".graph > .graph-outer > .global-graph-icon"),
      forcedHover(".darkmode"),
      forcedHover(".readermode"),
    ],
    selected: [
      '.search > .search-button[aria-expanded="true"]',
      '.explorer[aria-expanded="true"] .explorer-toggle',
      ".explorer .folder-container:has(+ .folder-outer.open) .folder-button",
      '.toc > .toc-header[aria-expanded="true"]',
      ".graph:has(> .global-graph-outer.active) > .graph-outer > .global-graph-icon",
      'html[saved-theme="dark"] .darkmode',
      'html[reader-mode="on"] .readermode',
      forcedSelected(".search > .search-button"),
      forcedSelected(".explorer .explorer-toggle"),
      forcedSelected(".explorer .folder-button"),
      forcedSelected(".toc > .toc-header"),
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
    normal: [
      ".search > .search-button svg",
      ".explorer .explorer-toggle svg",
      ".explorer .folder-icon",
      ".toc > .toc-header svg",
      ".graph > .graph-outer > .global-graph-icon svg",
      ".darkmode svg",
      ".readermode svg",
    ],
    hover: [
      ".search > .search-button:hover svg",
      ".explorer .explorer-toggle:hover svg",
      ".explorer .folder-icon:hover",
      ".toc > .toc-header:hover svg",
      ".graph > .graph-outer > .global-graph-icon:hover svg",
      ".darkmode:hover svg",
      ".readermode:hover svg",
      forcedHover(".search > .search-button svg"),
      forcedHover(".explorer .explorer-toggle svg"),
      forcedHover(".explorer .folder-icon"),
      forcedHover(".toc > .toc-header svg"),
      forcedHover(".graph > .graph-outer > .global-graph-icon svg"),
      forcedHover(".darkmode svg"),
      forcedHover(".readermode svg"),
    ],
    selected: [
      '.search > .search-button[aria-expanded="true"] svg',
      '.explorer[aria-expanded="true"] .explorer-toggle svg',
      ".explorer .folder-container:has(+ .folder-outer.open) .folder-icon",
      '.toc > .toc-header[aria-expanded="true"] svg',
      ".graph:has(> .global-graph-outer.active) > .graph-outer > .global-graph-icon svg",
      'html[saved-theme="dark"] .darkmode svg',
      'html[reader-mode="on"] .readermode svg',
      forcedSelected(".search > .search-button svg"),
      forcedSelected(".explorer .explorer-toggle svg"),
      forcedSelected(".explorer .folder-icon"),
      forcedSelected(".toc > .toc-header svg"),
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
    selected: [".graph > .global-graph-outer.active", forcedSelected(".graph > .graph-outer")],
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
  it("resolves concrete domain-card overrides and state fallbacks in registry order", () => {
    const css = compileAppearanceComponentCss(settingsWithComponentOverrides)

    expect(css).toContain("/* publisher-component:domainCard */")
    expect(css).toContain("--publisher-component-domain-card-normal-surface: #112233CC;")
    expect(css).toContain("--publisher-component-domain-card-hover-surface: #667788DD;")
    expect(css).toContain(
      "--publisher-component-domain-card-selected-title: var(--publisher-component-domain-card-normal-title);",
    )
    expect(css).toContain(
      "--publisher-component-home-search-normal-surface: var(--publisher-surface);",
    )
    expect(css).toContain(
      ":where(.domain-card) {\n  background-color: var(--publisher-component-domain-card-normal-surface);\n  border-color: var(--publisher-component-domain-card-normal-border);\n  color: var(--publisher-component-domain-card-normal-title);",
    )
    expect(css).toContain(
      ':where(.domain-card:hover, [data-publisher-appearance-state="hover"] .domain-card) {\n  background-color: var(--publisher-component-domain-card-hover-surface);\n  border-color: var(--publisher-component-domain-card-hover-border);\n  color: var(--publisher-component-domain-card-hover-title);',
    )

    const normal = css.indexOf("--publisher-component-domain-card-normal-surface:")
    const hover = css.indexOf("--publisher-component-domain-card-hover-surface:")
    const selected = css.indexOf("--publisher-component-domain-card-selected-surface:")
    expect(normal).toBeLessThan(hover)
    expect(hover).toBeLessThan(selected)
  })

  it("emits markers and variables in exact registry, state, and slot order", () => {
    const first = compileAppearanceComponentCss(DEFAULT_APPEARANCE)
    const second = compileAppearanceComponentCss(DEFAULT_APPEARANCE)

    expect(first).toBe(second)
    const markers = [...first.matchAll(/\/\* publisher-component:([^ ]+) \*\//g)].map(
      (match) => match[1],
    )
    expect(markers).toEqual(Object.keys(APPEARANCE_COMPONENTS))
    expect(markers).toHaveLength(25)
    const variableNames = [...first.matchAll(/^  (--publisher-component-[^:]+):/gm)].map(
      (match) => match[1],
    )
    const expectedVariableNames = Object.entries(APPEARANCE_COMPONENTS).flatMap(
      ([componentId, definition]) => {
        const kebabId = componentId.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
        return definition.states.flatMap((state) =>
          Object.keys(definition.slots).map(
            (slot) => `--publisher-component-${kebabId}-${state}-${slot}`,
          ),
        )
      },
    )
    expect(variableNames).toEqual(expectedVariableNames)
    expect(variableNames).toHaveLength(expectedVariableNames.length)
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
      ':where(.domain-card:hover, [data-publisher-appearance-state="hover"] .domain-card)',
    )
    expect(css).toContain('.domain-card[aria-current="page"]')
    expect(css).toContain('[data-publisher-appearance-state="selected"] .domain-card')
    expect(css).toContain(".domain-card:focus-visible")
    expect(css).toContain("outline: 2px solid var(--publisher-accent) !important;")
    expect(css).toContain("outline-offset: 3px !important;")
    expect(css).toContain("color: var(--publisher-component-domain-card-selected-title);")
    expect(css).toContain(".explorer .tree-item-self.active.is-active")
    for (const state of ["normal", "hover", "selected"]) {
      expect(css).toMatch(
        new RegExp(
          `:where\\([^}]+\\) \\{\\n  background-color: var\\(--publisher-component-domain-card-${state}-surface\\);\\n  border-color: var\\(--publisher-component-domain-card-${state}-border\\);\\n  color: var\\(--publisher-component-domain-card-${state}-title\\);`,
        ),
      )
      expect(css).toMatch(
        new RegExp(
          `:where\\([^}]+strong[^}]*\\) \\{\\n  color: var\\(--publisher-component-domain-card-${state}-title\\);`,
        ),
      )
    }
  })

  it("never emits unscoped generic button or svg rules", () => {
    const css = compileAppearanceComponentCss(DEFAULT_APPEARANCE)

    expect(css).not.toMatch(/(?:^|[,(]\s*)(?:button|svg)(?=\s*(?:[,):]|$))/gm)
  })

  it("keeps component rules before appended custom CSS", () => {
    const customCss = ".domain-card { background: hotpink; }"
    const css = compileAppearanceCss({ ...DEFAULT_APPEARANCE, customCss })

    expect(css).toContain("/* publisher-component:domainCard */")
    expect(css.indexOf("/* publisher-component:domainCard */")).toBeLessThan(css.indexOf(customCss))
    expect(css.endsWith(customCss)).toBe(true)
    expect(css).toContain(":where(.domain-card)")
  })

  it("uses managed variables in custom.scss without the old domain-card rgba literals", () => {
    const customScss = readFileSync(
      resolve(process.cwd(), "../../quartz/styles/custom.scss"),
      "utf8",
    )

    expect(customScss).not.toContain("rgba(24, 29, 36, 0.82)")
    expect(customScss).not.toContain("rgba(37, 43, 52, 0.9)")
    expect(customScss).toContain(
      "var(--publisher-component-domain-card-normal-surface, var(--lightgray))",
    )
    expect(customScss).toContain(
      "var(--publisher-component-domain-card-hover-surface, var(--highlight))",
    )
    expect(customScss).toContain("--publisher-component-domain-card-selected-title")
  })
})
