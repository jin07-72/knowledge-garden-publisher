import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_APPEARANCE, compileAppearanceCss } from "../../src/shared/appearance"
import { compileAppearanceComponentCss } from "../../src/shared/appearanceComponentCss"
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

    const normal = css.indexOf("--publisher-component-domain-card-normal-surface:")
    const hover = css.indexOf("--publisher-component-domain-card-hover-surface:")
    const selected = css.indexOf("--publisher-component-domain-card-selected-surface:")
    expect(normal).toBeLessThan(hover)
    expect(hover).toBeLessThan(selected)
  })

  it("emits every component marker and deterministic output", () => {
    const first = compileAppearanceComponentCss(DEFAULT_APPEARANCE)
    const second = compileAppearanceComponentCss(DEFAULT_APPEARANCE)

    expect(first).toBe(second)
    for (const componentId of Object.keys(APPEARANCE_COMPONENTS)) {
      expect(first).toContain(`/* publisher-component:${componentId} */`)
    }
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
    expect(css).toContain("color: var(--publisher-component-domain-card-selected-title);")
  })

  it("covers representative real Quartz selector families", () => {
    const css = compileAppearanceComponentCss(DEFAULT_APPEARANCE)

    for (const selector of [
      ".domain-card",
      ".search-button",
      ".explorer",
      ".breadcrumb-container",
      ".toc",
      ".search-container",
      ".search-space",
      ".result-card",
      ".darkmode",
      ".center article",
      ".popover-inner",
      ".graph",
      ".page-footer",
    ]) {
      expect(css).toContain(selector)
    }
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
