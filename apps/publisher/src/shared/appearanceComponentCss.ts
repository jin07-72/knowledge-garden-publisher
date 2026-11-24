import type { AppearanceSettings } from "./appearance"
import {
  APPEARANCE_COMPONENTS,
  normalizeComponentColors,
  type AppearanceComponentId,
  type AppearanceState,
} from "./appearanceComponents"

type ComponentCssSettings = Pick<AppearanceSettings, "componentColors">
type SelectorContract = Readonly<
  Record<AppearanceComponentId, Readonly<Partial<Record<AppearanceState, readonly string[]>>>>
>

const forcedHover = (selector: string) => `[data-publisher-appearance-state="hover"] ${selector}`
const forcedSelected = (selector: string) =>
  `[data-publisher-appearance-state="selected"] ${selector}`

export const APPEARANCE_COMPONENT_SELECTORS = {
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
} as const satisfies SelectorContract

type DeclarationMap = Readonly<Record<string, string>>

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

function selectors(componentId: AppearanceComponentId, state: AppearanceState): readonly string[] {
  const contract = APPEARANCE_COMPONENT_SELECTORS[componentId] as Readonly<
    Partial<Record<AppearanceState, readonly string[]>>
  >
  return contract[state] ?? []
}

function cssRule(selectorList: readonly string[], declarations: DeclarationMap): string {
  const body = Object.entries(declarations)
    .map(([property, value]) => `  ${property}: ${value};`)
    .join("\n")
  return `:where(${selectorList.join(", ")}) {\n${body}\n}`
}

function stateRule(
  componentId: AppearanceComponentId,
  state: AppearanceState,
  declarations: DeclarationMap,
): string {
  return cssRule(selectors(componentId, state), declarations)
}

function descendantRule(
  componentId: AppearanceComponentId,
  state: AppearanceState,
  descendant: string,
  declarations: DeclarationMap,
): string {
  return cssRule(
    selectors(componentId, state).map((selector) => `${selector} ${descendant}`),
    declarations,
  )
}

function controlRules(componentId: AppearanceComponentId, includeIcons = true): string[] {
  return APPEARANCE_COMPONENTS[componentId].states.flatMap((state) => {
    const rules = [
      stateRule(componentId, state, {
        "background-color": variable(componentId, state, "surface"),
        "border-color": variable(componentId, state, "border"),
        color: variable(componentId, state, "text"),
      }),
    ]
    if (includeIcons) {
      rules.push(
        descendantRule(componentId, state, "svg", {
          color: variable(componentId, state, "icon"),
        }),
      )
    }
    return rules
  })
}

function textRules(componentId: AppearanceComponentId): string[] {
  return APPEARANCE_COMPONENTS[componentId].states.map((state) =>
    stateRule(componentId, state, {
      color: variable(componentId, state, "text"),
      "text-decoration-color": variable(componentId, state, "accent"),
    }),
  )
}

function panelRules(componentId: AppearanceComponentId): string[] {
  return [
    stateRule(componentId, "normal", {
      "background-color": variable(componentId, "normal", "surface"),
      "border-color": variable(componentId, "normal", "border"),
      color: variable(componentId, "normal", "text"),
    }),
    descendantRule(componentId, "normal", ":is(h1, h2, h3, h4)", {
      color: variable(componentId, "normal", "heading"),
    }),
  ]
}

function codeRules(componentId: AppearanceComponentId): string[] {
  return [
    stateRule(componentId, "normal", {
      "background-color": variable(componentId, "normal", "surface"),
      "border-color": variable(componentId, "normal", "border"),
      color: variable(componentId, "normal", "text"),
    }),
  ]
}

function domainCardRules(): string[] {
  const rules = APPEARANCE_COMPONENTS.domainCard.states.flatMap((state) => [
    stateRule("domainCard", state, {
      "background-color": variable("domainCard", state, "surface"),
      "border-color": variable("domainCard", state, "border"),
      color: variable("domainCard", state, "title"),
    }),
    descendantRule("domainCard", state, "span", {
      color: variable("domainCard", state, "number"),
    }),
    descendantRule("domainCard", state, "strong", {
      color: variable("domainCard", state, "title"),
    }),
    descendantRule("domainCard", state, "small", {
      color: variable("domainCard", state, "description"),
    }),
  ])
  rules.push(
    cssRule([".domain-card:focus-visible"], {
      outline: "2px solid var(--publisher-accent) !important",
      "outline-offset": "3px !important",
    }),
  )
  return rules
}

function homeStatsRules(): string[] {
  return [
    cssRule([".garden-stats"], { color: variable("homeStats", "normal", "text") }),
    cssRule([".garden-kicker"], { color: variable("homeStats", "normal", "accent") }),
  ]
}

function searchInputRules(): string[] {
  return APPEARANCE_COMPONENTS.searchInput.states.map((state) =>
    stateRule("searchInput", state, {
      "background-color": variable("searchInput", state, "surface"),
      "border-color": variable("searchInput", state, "border"),
      color: variable("searchInput", state, "text"),
      "caret-color": variable("searchInput", state, "icon"),
    }),
  )
}

function tableRules(): string[] {
  return APPEARANCE_COMPONENTS.table.states.flatMap((state) => [
    stateRule("table", state, {
      "background-color": variable("table", state, "surface"),
      "border-color": variable("table", state, "border"),
      color: variable("table", state, "text"),
    }),
    descendantRule("table", state, ":is(th, thead)", {
      color: variable("table", state, "heading"),
    }),
  ])
}

function iconRules(): string[] {
  return APPEARANCE_COMPONENTS.icon.states.map((state) =>
    stateRule("icon", state, { color: variable("icon", state, "icon") }),
  )
}

function graphRules(): string[] {
  return APPEARANCE_COMPONENTS.graph.states.flatMap((state) => [
    stateRule("graph", state, {
      "background-color": variable("graph", state, "surface"),
      "border-color": variable("graph", state, "border"),
      color: variable("graph", state, "text"),
      "--graph-node-color": variable("graph", state, "node"),
    }),
    descendantRule("graph", state, ":is(.node, circle)", {
      fill: variable("graph", state, "node"),
    }),
  ])
}

function componentRules(componentId: AppearanceComponentId): string[] {
  switch (componentId) {
    case "domainCard":
      return domainCardRules()
    case "homeStats":
      return homeStatsRules()
    case "breadcrumb":
    case "link":
    case "footer":
      return textRules(componentId)
    case "searchOverlay":
      return [
        stateRule(componentId, "normal", {
          "background-color": variable(componentId, "normal", "surface"),
        }),
      ]
    case "searchDialog":
    case "blockquote":
    case "callout":
    case "popover":
    case "tooltip":
      return panelRules(componentId)
    case "searchInput":
      return searchInputRules()
    case "codeBlock":
    case "inlineCode":
      return codeRules(componentId)
    case "table":
      return tableRules()
    case "divider":
      return [
        stateRule(componentId, "normal", {
          "background-color": variable(componentId, "normal", "border"),
          "border-color": variable(componentId, "normal", "border"),
        }),
      ]
    case "icon":
      return iconRules()
    case "graph":
      return graphRules()
    case "homeSearch":
    case "explorer":
    case "mobileMenu":
    case "tableOfContents":
    case "searchResult":
    case "button":
    case "tag":
      return controlRules(componentId)
  }
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
    output.push("}", ...componentRules(componentId))
  }

  return output.join("\n")
}
