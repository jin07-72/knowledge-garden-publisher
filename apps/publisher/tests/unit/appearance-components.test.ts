import { describe, expect, it } from "vitest"
import {
  APPEARANCE_COMPONENTS,
  clearComponentColor,
  clearComponentOverrides,
  normalizeComponentColors,
  resolveComponentColor,
  setComponentColor,
} from "../../src/shared/appearanceComponents"

describe("appearance component registry", () => {
  it("registers every approved Quartz component in stable order", () => {
    expect(Object.keys(APPEARANCE_COMPONENTS)).toEqual([
      "domainCard",
      "homeSearch",
      "homeStats",
      "explorer",
      "mobileMenu",
      "breadcrumb",
      "tableOfContents",
      "searchOverlay",
      "searchDialog",
      "searchInput",
      "searchResult",
      "link",
      "button",
      "tag",
      "icon",
      "codeBlock",
      "inlineCode",
      "blockquote",
      "table",
      "callout",
      "divider",
      "popover",
      "tooltip",
      "graph",
      "footer",
    ])
  })

  it("declares stable states, domain-card slots, and alpha policy", () => {
    expect(APPEARANCE_COMPONENTS.domainCard.states).toEqual(["normal", "hover", "selected"])
    expect(APPEARANCE_COMPONENTS.divider.states).toEqual(["normal"])
    expect(APPEARANCE_COMPONENTS.domainCard.slots).toEqual({
      surface: { label: "卡片背景", kind: "surface", allowAlpha: true, fallback: "surface" },
      border: { label: "边框", kind: "border", allowAlpha: true, fallback: "accent" },
      number: { label: "编号", kind: "text", allowAlpha: false, fallback: "accent" },
      title: { label: "标题", kind: "text", allowAlpha: false, fallback: "heading" },
      description: {
        label: "描述与数量",
        kind: "text",
        allowAlpha: false,
        fallback: "secondary",
      },
    })

    for (const component of Object.values(APPEARANCE_COMPONENTS)) {
      for (const slot of Object.values(component.slots)) {
        expect(slot.allowAlpha).toBe(slot.kind === "surface" || slot.kind === "border")
      }
    }
  })
})

describe("component color overrides", () => {
  it("falls back from the selected state to normal and then to the global token", () => {
    const overrides = normalizeComponentColors({
      domainCard: {
        normal: { surface: "#10203080" },
        selected: { title: "#ffffff" },
      },
    })

    expect(resolveComponentColor(overrides, "domainCard", "selected", "title")).toEqual({
      source: "state",
      value: "#FFFFFF",
    })
    expect(resolveComponentColor(overrides, "domainCard", "selected", "surface")).toEqual({
      source: "normal",
      value: "#10203080",
    })
    expect(resolveComponentColor(overrides, "domainCard", "hover", "title")).toEqual({
      source: "global",
      token: "heading",
    })
  })

  it("cleans empty nodes and rejects unsupported paths and alpha in opaque slots", () => {
    expect(normalizeComponentColors({ domainCard: { hover: {} } })).toEqual({})
    expect(() =>
      normalizeComponentColors({ domainCard: { normal: { title: "#FFFFFF80" } } }),
    ).toThrow(/opaque/i)
    expect(() => normalizeComponentColors({ unknown: { normal: { text: "#FFFFFF" } } })).toThrow(
      /component/i,
    )
    expect(() => normalizeComponentColors({ divider: { hover: { border: "#FFFFFF" } } })).toThrow(
      /state/i,
    )
    expect(() =>
      normalizeComponentColors({ domainCard: { normal: { unknown: "#FFFFFF" } } }),
    ).toThrow(/slot/i)
  })

  it("sets and clears leaves immutably while pruning empty ancestors", () => {
    const original = normalizeComponentColors({
      domainCard: { normal: { title: "#112233" } },
      divider: { normal: { border: "#44556680" } },
    })
    const changed = setComponentColor(original, "domainCard", "hover", "surface", "#aabbcc80")

    expect(changed).toEqual({
      domainCard: {
        normal: { title: "#112233" },
        hover: { surface: "#AABBCC80" },
      },
      divider: { normal: { border: "#44556680" } },
    })
    expect(original).toEqual({
      domainCard: { normal: { title: "#112233" } },
      divider: { normal: { border: "#44556680" } },
    })

    const withoutHover = clearComponentColor(changed, "domainCard", "hover", "surface")
    expect(withoutHover).toEqual(original)
    expect(clearComponentOverrides(withoutHover, "domainCard")).toEqual({
      divider: { normal: { border: "#44556680" } },
    })
  })
})
