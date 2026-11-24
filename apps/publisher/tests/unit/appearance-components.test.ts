import { describe, expect, it } from "vitest"
import {
  APPEARANCE_COMPONENTS,
  clearComponentColor,
  clearComponentOverrides,
  normalizeComponentColors,
  resolveComponentColor,
  setComponentColor,
  type ComponentColorOverrides,
} from "../../src/shared/appearanceComponents"

describe("appearance component registry", () => {
  it("keeps the complete state and slot contract in stable order", () => {
    expect(
      Object.entries(APPEARANCE_COMPONENTS).map(([id, definition]) => ({
        id,
        states: [...definition.states],
        slots: Object.keys(definition.slots),
      })),
    ).toEqual([
      {
        id: "domainCard",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "number", "title", "description"],
      },
      {
        id: "homeSearch",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "text", "icon"],
      },
      { id: "homeStats", states: ["normal"], slots: ["text", "accent"] },
      {
        id: "explorer",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "text", "icon"],
      },
      {
        id: "mobileMenu",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "text", "icon"],
      },
      { id: "breadcrumb", states: ["normal", "hover", "selected"], slots: ["text", "accent"] },
      {
        id: "tableOfContents",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "text", "icon"],
      },
      { id: "searchOverlay", states: ["normal"], slots: ["surface"] },
      { id: "searchDialog", states: ["normal"], slots: ["surface", "border", "text", "heading"] },
      {
        id: "searchInput",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "text", "icon"],
      },
      {
        id: "searchResult",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "text", "icon"],
      },
      { id: "link", states: ["normal", "hover", "selected"], slots: ["text", "accent"] },
      {
        id: "button",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "text", "icon"],
      },
      {
        id: "tag",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "text", "icon"],
      },
      { id: "icon", states: ["normal", "hover", "selected"], slots: ["icon"] },
      { id: "codeBlock", states: ["normal"], slots: ["surface", "border", "text"] },
      { id: "inlineCode", states: ["normal"], slots: ["surface", "border", "text"] },
      { id: "blockquote", states: ["normal"], slots: ["surface", "border", "text", "heading"] },
      {
        id: "table",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "text", "heading"],
      },
      { id: "callout", states: ["normal"], slots: ["surface", "border", "text", "heading"] },
      { id: "divider", states: ["normal"], slots: ["border"] },
      { id: "popover", states: ["normal"], slots: ["surface", "border", "text", "heading"] },
      { id: "tooltip", states: ["normal"], slots: ["surface", "border", "text", "heading"] },
      {
        id: "graph",
        states: ["normal", "hover", "selected"],
        slots: ["surface", "border", "node", "text"],
      },
      { id: "footer", states: ["normal", "hover", "selected"], slots: ["text", "accent"] },
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
      expect(Object.isFrozen(component)).toBe(true)
      expect(Object.isFrozen(component.states)).toBe(true)
      expect(Object.isFrozen(component.slots)).toBe(true)
      for (const slot of Object.values(component.slots)) {
        expect(Object.isFrozen(slot)).toBe(true)
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
    for (const malformed of [
      null,
      [],
      "#FFFFFF",
      { domainCard: [] },
      { domainCard: { normal: [] } },
    ]) {
      expect(() => normalizeComponentColors(malformed)).toThrow(/object/i)
    }
    for (const malformedHex of ["#FFF", "#GGGGGG", "#123456789", "rgb(0,0,0)"]) {
      expect(() =>
        normalizeComponentColors({ domainCard: { normal: { surface: malformedHex } } }),
      ).toThrow(/hex/i)
    }
  })

  it("validates a new color before traversing existing overrides", () => {
    const unreadOverrides = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("existing overrides were traversed")
        },
      },
    ) as ComponentColorOverrides

    expect(() =>
      setComponentColor(unreadOverrides, "domainCard", "normal", "surface", "invalid"),
    ).toThrow(/hex/i)
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
