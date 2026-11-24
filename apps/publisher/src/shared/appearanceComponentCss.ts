import type { AppearanceSettings } from "./appearance"
import {
  APPEARANCE_COMPONENTS,
  normalizeComponentColors,
  type AppearanceComponentId,
  type AppearanceState,
} from "./appearanceComponents"

type ComponentCssSettings = Pick<AppearanceSettings, "componentColors">

interface SelectorRule {
  readonly selector: string
  readonly declarations: Readonly<Record<string, string>>
}

type StateRules = Readonly<Partial<Record<AppearanceState, readonly SelectorRule[]>>>

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
}

function variable(
  componentId: AppearanceComponentId,
  state: AppearanceState,
  slot: string,
): string {
  return `var(--publisher-component-${kebabCase(componentId)}-${state}-${slot})`
}

function rule(selector: string, declarations: Readonly<Record<string, string>>): SelectorRule {
  return { selector, declarations }
}

const COMPONENT_SELECTOR_RULES = {
  domainCard: {
    normal: [
      rule(":where(.domain-card)", {
        "background-color": variable("domainCard", "normal", "surface"),
        "border-color": variable("domainCard", "normal", "border"),
      }),
      rule(":where(.domain-card span)", {
        color: variable("domainCard", "normal", "number"),
      }),
      rule(":where(.domain-card strong)", {
        color: variable("domainCard", "normal", "title"),
      }),
      rule(":where(.domain-card small)", {
        color: variable("domainCard", "normal", "description"),
      }),
    ],
    hover: [
      rule(':where(.domain-card:hover, [data-publisher-appearance-state="hover"] .domain-card)', {
        "background-color": variable("domainCard", "hover", "surface"),
        "border-color": variable("domainCard", "hover", "border"),
      }),
      rule(
        ':where(.domain-card:hover span, [data-publisher-appearance-state="hover"] .domain-card span)',
        { color: variable("domainCard", "hover", "number") },
      ),
      rule(
        ':where(.domain-card:hover strong, [data-publisher-appearance-state="hover"] .domain-card strong)',
        { color: variable("domainCard", "hover", "title") },
      ),
      rule(
        ':where(.domain-card:hover small, [data-publisher-appearance-state="hover"] .domain-card small)',
        { color: variable("domainCard", "hover", "description") },
      ),
    ],
    selected: [
      rule(
        ':where(.domain-card[aria-current="page"], [data-publisher-appearance-state="selected"] .domain-card, .domain-card:focus-visible)',
        {
          "background-color": variable("domainCard", "selected", "surface"),
          "border-color": variable("domainCard", "selected", "border"),
        },
      ),
      rule(
        ':where(.domain-card[aria-current="page"] span, [data-publisher-appearance-state="selected"] .domain-card span, .domain-card:focus-visible span)',
        { color: variable("domainCard", "selected", "number") },
      ),
      rule(
        ':where(.domain-card[aria-current="page"] strong, [data-publisher-appearance-state="selected"] .domain-card strong, .domain-card:focus-visible strong)',
        { color: variable("domainCard", "selected", "title") },
      ),
      rule(
        ':where(.domain-card[aria-current="page"] small, [data-publisher-appearance-state="selected"] .domain-card small, .domain-card:focus-visible small)',
        { color: variable("domainCard", "selected", "description") },
      ),
      rule(":where(.domain-card:focus-visible)", {
        outline: "2px solid var(--publisher-accent) !important",
        "outline-offset": "3px !important",
      }),
    ],
  },
  homeSearch: controlRules("homeSearch", ".search-button"),
  homeStats: {
    normal: [
      rule(":where(.garden-stats)", { color: variable("homeStats", "normal", "text") }),
      rule(":where(.garden-kicker)", { color: variable("homeStats", "normal", "accent") }),
    ],
  },
  explorer: navigationRules("explorer", ".explorer"),
  mobileMenu: navigationRules("mobileMenu", ".mobile-explorer"),
  breadcrumb: textRules("breadcrumb", ".breadcrumb-container"),
  tableOfContents: navigationRules("tableOfContents", ".toc"),
  searchOverlay: {
    normal: [
      rule(":where(.search-container)", {
        "background-color": variable("searchOverlay", "normal", "surface"),
      }),
    ],
  },
  searchDialog: panelRules("searchDialog", ".search-space"),
  searchInput: controlRules("searchInput", ".search-space > input"),
  searchResult: navigationRules("searchResult", ".result-card"),
  link: textRules("link", ".page a"),
  button: controlRules("button", "button, .darkmode, .readermode"),
  tag: controlRules("tag", ".tag-link"),
  icon: iconRules("icon", "svg"),
  codeBlock: codeRules("codeBlock", ".center article pre"),
  inlineCode: codeRules("inlineCode", ".center article :not(pre) > code"),
  blockquote: panelRules("blockquote", ".center article blockquote"),
  table: tableRules(),
  callout: panelRules("callout", ".callout"),
  divider: {
    normal: [
      rule(":where(.center article hr)", {
        "background-color": variable("divider", "normal", "border"),
        "border-color": variable("divider", "normal", "border"),
      }),
    ],
  },
  popover: panelRules("popover", ".popover-inner"),
  tooltip: panelRules("tooltip", ".tooltip, [role=tooltip]"),
  graph: graphRules(),
  footer: textRules("footer", ".page-footer"),
} satisfies Readonly<Record<AppearanceComponentId, StateRules>>

function controlRules(componentId: AppearanceComponentId, selector: string): StateRules {
  const iconSelector = selector
    .split(",")
    .map((item) => `${item.trim()} svg`)
    .join(", ")
  return mergeStateRules(
    interactiveRules(componentId, selector, {
      surface: "background-color",
      border: "border-color",
      text: "color",
    }),
    interactiveRules(componentId, iconSelector, { icon: "color" }),
  )
}

function navigationRules(componentId: AppearanceComponentId, selector: string): StateRules {
  const iconSelector = selector
    .split(",")
    .map((item) => `${item.trim()} svg`)
    .join(", ")
  return mergeStateRules(
    interactiveRules(componentId, selector, {
      surface: "background-color",
      border: "border-color",
      text: "color",
    }),
    interactiveRules(componentId, iconSelector, { icon: "color" }),
  )
}

function mergeStateRules(...groups: readonly StateRules[]): StateRules {
  return {
    normal: groups.flatMap((group) => group.normal ?? []),
    hover: groups.flatMap((group) => group.hover ?? []),
    selected: groups.flatMap((group) => group.selected ?? []),
  }
}

function textRules(componentId: AppearanceComponentId, selector: string): StateRules {
  return interactiveRules(componentId, selector, { text: "color", accent: "text-decoration-color" })
}

function iconRules(componentId: AppearanceComponentId, selector: string): StateRules {
  return interactiveRules(componentId, selector, { icon: "color" })
}

function interactiveRules(
  componentId: AppearanceComponentId,
  selector: string,
  properties: Readonly<Record<string, string>>,
): StateRules {
  const selectors = selector.split(",").map((item) => item.trim())
  const declarations = (state: AppearanceState) =>
    Object.fromEntries(
      Object.entries(properties).map(([slot, property]) => [
        property,
        variable(componentId, state, slot),
      ]),
    )
  return {
    normal: [rule(`:where(${selectors.join(", ")})`, declarations("normal"))],
    hover: [
      rule(
        `:where(${[
          ...selectors.map((item) => `${item}:hover`),
          ...selectors.map((item) => `[data-publisher-appearance-state="hover"] ${item}`),
        ].join(", ")})`,
        declarations("hover"),
      ),
    ],
    selected: [
      rule(
        `:where(${[
          ...selectors.map((item) => `${item}[aria-current="page"]`),
          ...selectors.map((item) => `${item}[aria-selected="true"]`),
          ...selectors.map((item) => `[data-publisher-appearance-state="selected"] ${item}`),
        ].join(", ")})`,
        declarations("selected"),
      ),
    ],
  }
}

function panelRules(componentId: AppearanceComponentId, selector: string): StateRules {
  const selectors = selector.split(",").map((item) => item.trim())
  return {
    normal: [
      rule(`:where(${selectors.join(", ")})`, {
        "background-color": variable(componentId, "normal", "surface"),
        "border-color": variable(componentId, "normal", "border"),
        color: variable(componentId, "normal", "text"),
      }),
      rule(
        `:where(${selectors.flatMap((item) => ["h1", "h2", "h3", "h4"].map((heading) => `${item} ${heading}`)).join(", ")})`,
        {
          color: variable(componentId, "normal", "heading"),
        },
      ),
    ],
  }
}

function codeRules(componentId: AppearanceComponentId, selector: string): StateRules {
  return {
    normal: [
      rule(`:where(${selector})`, {
        "background-color": variable(componentId, "normal", "surface"),
        "border-color": variable(componentId, "normal", "border"),
        color: variable(componentId, "normal", "text"),
      }),
    ],
  }
}

function tableRules(): StateRules {
  return {
    normal: [
      rule(":where(.center article table, .center article th, .center article td)", {
        "background-color": variable("table", "normal", "surface"),
        "border-color": variable("table", "normal", "border"),
        color: variable("table", "normal", "text"),
      }),
      rule(":where(.center article th)", { color: variable("table", "normal", "heading") }),
    ],
    hover: [
      rule(
        ':where(.center article tr:hover, [data-publisher-appearance-state="hover"] .center article tr)',
        {
          "background-color": variable("table", "hover", "surface"),
          "border-color": variable("table", "hover", "border"),
          color: variable("table", "hover", "text"),
        },
      ),
    ],
    selected: [
      rule(
        ':where(.center article tr[aria-selected="true"], [data-publisher-appearance-state="selected"] .center article tr)',
        {
          "background-color": variable("table", "selected", "surface"),
          "border-color": variable("table", "selected", "border"),
          color: variable("table", "selected", "text"),
        },
      ),
    ],
  }
}

function graphRules(): StateRules {
  const declarations = (state: AppearanceState) => ({
    "background-color": variable("graph", state, "surface"),
    "border-color": variable("graph", state, "border"),
    color: variable("graph", state, "text"),
    "--graph-node-color": variable("graph", state, "node"),
  })
  return {
    normal: [
      rule(":where(.graph)", declarations("normal")),
      rule(":where(.graph .node, .graph circle)", {
        fill: variable("graph", "normal", "node"),
      }),
    ],
    hover: [
      rule(
        ':where(.graph:hover, [data-publisher-appearance-state="hover"] .graph)',
        declarations("hover"),
      ),
      rule(
        ':where(.graph:hover .node, .graph:hover circle, [data-publisher-appearance-state="hover"] .graph .node, [data-publisher-appearance-state="hover"] .graph circle)',
        { fill: variable("graph", "hover", "node") },
      ),
    ],
    selected: [
      rule(
        ':where(.graph[aria-selected="true"], [data-publisher-appearance-state="selected"] .graph)',
        declarations("selected"),
      ),
      rule(
        ':where(.graph[aria-selected="true"] .node, .graph[aria-selected="true"] circle, [data-publisher-appearance-state="selected"] .graph .node, [data-publisher-appearance-state="selected"] .graph circle)',
        { fill: variable("graph", "selected", "node") },
      ),
    ],
  }
}

function emitSelectorRule(selectorRule: SelectorRule): string {
  const declarations = Object.entries(selectorRule.declarations)
    .map(([property, value]) => `  ${property}: ${value};`)
    .join("\n")
  return `${selectorRule.selector} {\n${declarations}\n}`
}

export function compileAppearanceComponentCss(settings: ComponentCssSettings): string {
  const overrides = normalizeComponentColors(settings.componentColors) as Record<
    string,
    Record<string, Record<string, string>>
  >
  const output: string[] = []

  for (const [componentId, definition] of Object.entries(APPEARANCE_COMPONENTS) as [
    AppearanceComponentId,
    (typeof APPEARANCE_COMPONENTS)[AppearanceComponentId],
  ][]) {
    const kebabId = kebabCase(componentId)
    output.push(`/* publisher-component:${componentId} */`, ":root {")
    for (const state of definition.states) {
      for (const [slotName, slotDefinition] of Object.entries(definition.slots)) {
        const name = `--publisher-component-${kebabId}-${state}-${slotName}`
        const concrete = overrides[componentId]?.[state]?.[slotName]
        const value =
          concrete ??
          (state === "normal"
            ? `var(--publisher-${slotDefinition.fallback})`
            : `var(--publisher-component-${kebabId}-normal-${slotName})`)
        output.push(`  ${name}: ${value};`)
      }
    }
    output.push("}")

    const stateRules: StateRules = COMPONENT_SELECTOR_RULES[componentId]
    for (const state of definition.states) {
      for (const selectorRule of stateRules[state] ?? [])
        output.push(emitSelectorRule(selectorRule))
    }
  }

  return output.join("\n")
}
