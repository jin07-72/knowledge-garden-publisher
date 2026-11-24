import {
  normalizeComponentColors,
  type ComponentColorOverrides,
} from "./appearanceComponents"

export type BlogFramework = "quartz" | "hugo" | "hexo" | "unknown"

export type AppearanceBackground =
  | { readonly kind: "solid"; readonly color: string }
  | {
      readonly kind: "gradient"
      readonly start: string
      readonly end: string
      readonly angle: number
    }
  | {
      readonly kind: "image"
      readonly asset:
        | { readonly source: "managed"; readonly name: string }
        | { readonly source: "staged"; readonly token: string; readonly name: string }
      readonly overlay: string
      readonly opacity: number
      readonly position: "center" | "top" | "bottom"
      readonly fixed: boolean
    }

export interface GlobalAppearanceColors {
  readonly page: string
  readonly surface: string
  readonly text: string
  readonly heading: string
  readonly accent: string
  readonly secondary: string
  readonly border: string
  readonly code: string
}

export interface AppearanceSettings {
  readonly schemaVersion: 2
  readonly preset: "knowledge-garden" | "paper" | "minimal" | "custom"
  readonly background: AppearanceBackground
  readonly colors: GlobalAppearanceColors
  readonly componentColors: ComponentColorOverrides
  readonly typography: {
    readonly header: string
    readonly body: string
    readonly code: string
    readonly baseSizePx: number
    readonly lineHeight: number
  }
  readonly layout: {
    readonly articleWidthCh: number
    readonly pageWidthPx: number
    readonly sidebarWidthPx: number
    readonly sidebars: "both" | "left" | "none"
    readonly gapPx: number
  }
  readonly customCss: string
}

export type AppearancePresetName = Exclude<AppearanceSettings["preset"], "custom">

const KNOWLEDGE_GARDEN_APPEARANCE = {
  schemaVersion: 2,
  preset: "knowledge-garden",
  background: { kind: "solid", color: "#0b1120" },
  colors: {
    page: "#0b1120",
    surface: "#111827",
    text: "#d1d5db",
    heading: "#f9fafb",
    accent: "#22d3ee",
    secondary: "#94a3b8",
    border: "#334155",
    code: "#0f172a",
  },
  componentColors: {},
  typography: {
    header: '"Inter", system-ui, sans-serif',
    body: '"Inter", system-ui, sans-serif',
    code: '"JetBrains Mono", ui-monospace, monospace',
    baseSizePx: 16,
    lineHeight: 1.7,
  },
  layout: {
    articleWidthCh: 72,
    pageWidthPx: 1440,
    sidebarWidthPx: 280,
    sidebars: "both",
    gapPx: 32,
  },
  customCss: "",
} as const satisfies AppearanceSettings

const PAPER_APPEARANCE = {
  schemaVersion: 2,
  preset: "paper",
  background: { kind: "solid", color: "#f4efe3" },
  colors: {
    page: "#f4efe3",
    surface: "#fffaf0",
    text: "#3f3a32",
    heading: "#201d18",
    accent: "#9f3d2e",
    secondary: "#746b5f",
    border: "#d8cdbb",
    code: "#ebe2d3",
  },
  componentColors: {},
  typography: {
    header: '"Iowan Old Style", Georgia, serif',
    body: '"Source Serif 4", Georgia, serif',
    code: '"JetBrains Mono", ui-monospace, monospace',
    baseSizePx: 17,
    lineHeight: 1.8,
  },
  layout: {
    articleWidthCh: 68,
    pageWidthPx: 1360,
    sidebarWidthPx: 260,
    sidebars: "left",
    gapPx: 36,
  },
  customCss: "",
} as const satisfies AppearanceSettings

const MINIMAL_APPEARANCE = {
  schemaVersion: 2,
  preset: "minimal",
  background: { kind: "solid", color: "#ffffff" },
  colors: {
    page: "#ffffff",
    surface: "#ffffff",
    text: "#27272a",
    heading: "#09090b",
    accent: "#2563eb",
    secondary: "#71717a",
    border: "#e4e4e7",
    code: "#f4f4f5",
  },
  componentColors: {},
  typography: {
    header: "Inter, system-ui, sans-serif",
    body: "Inter, system-ui, sans-serif",
    code: '"JetBrains Mono", ui-monospace, monospace',
    baseSizePx: 16,
    lineHeight: 1.65,
  },
  layout: {
    articleWidthCh: 68,
    pageWidthPx: 1120,
    sidebarWidthPx: 240,
    sidebars: "none",
    gapPx: 24,
  },
  customCss: "",
} as const satisfies AppearanceSettings

function freezeAppearance<T extends AppearanceSettings>(settings: T): T {
  if (settings.background.kind === "image") Object.freeze(settings.background.asset)
  Object.freeze(settings.background)
  Object.freeze(settings.colors)
  for (const states of Object.values(settings.componentColors)) {
    if (states === undefined) continue
    for (const slots of Object.values(states)) {
      if (slots !== undefined) Object.freeze(slots)
    }
    Object.freeze(states)
  }
  Object.freeze(settings.componentColors)
  Object.freeze(settings.typography)
  Object.freeze(settings.layout)
  return Object.freeze(settings)
}

export const APPEARANCE_PRESETS = Object.freeze({
  "knowledge-garden": freezeAppearance(KNOWLEDGE_GARDEN_APPEARANCE),
  paper: freezeAppearance(PAPER_APPEARANCE),
  minimal: freezeAppearance(MINIMAL_APPEARANCE),
}) satisfies Readonly<Record<AppearancePresetName, AppearanceSettings>>

export const DEFAULT_APPEARANCE = APPEARANCE_PRESETS["knowledge-garden"]

function cloneBackground(background: AppearanceBackground): AppearanceBackground {
  switch (background.kind) {
    case "solid":
      return { ...background }
    case "gradient":
      return { ...background }
    case "image":
      return { ...background, asset: { ...background.asset } }
  }
}

function cloneAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  return {
    ...settings,
    background: cloneBackground(settings.background),
    colors: { ...settings.colors },
    componentColors: normalizeComponentColors(settings.componentColors),
    typography: { ...settings.typography },
    layout: { ...settings.layout },
  }
}

export function cloneAppearancePreset(preset: AppearancePresetName): AppearanceSettings {
  return cloneAppearanceSettings(APPEARANCE_PRESETS[preset])
}

function normalizeNumber(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback
  const normalized = Math.min(maximum, Math.max(minimum, value))
  return Object.is(normalized, -0) ? 0 : normalized
}

function normalizeBackground(background: AppearanceBackground): AppearanceBackground {
  switch (background.kind) {
    case "solid":
      return { ...background }
    case "gradient":
      return {
        ...background,
        angle: normalizeNumber(background.angle, 0, 360, 0),
      }
    case "image":
      return {
        ...background,
        asset: { ...background.asset },
        opacity: normalizeNumber(background.opacity, 0, 1, 0),
      }
  }
}

export function normalizeAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  return {
    ...settings,
    background: normalizeBackground(settings.background),
    colors: { ...settings.colors },
    componentColors: normalizeComponentColors(settings.componentColors),
    typography: {
      ...settings.typography,
      baseSizePx: normalizeNumber(
        settings.typography.baseSizePx,
        10,
        32,
        DEFAULT_APPEARANCE.typography.baseSizePx,
      ),
      lineHeight: normalizeNumber(
        settings.typography.lineHeight,
        1,
        3,
        DEFAULT_APPEARANCE.typography.lineHeight,
      ),
    },
    layout: {
      ...settings.layout,
      articleWidthCh: normalizeNumber(
        settings.layout.articleWidthCh,
        32,
        120,
        DEFAULT_APPEARANCE.layout.articleWidthCh,
      ),
      pageWidthPx: normalizeNumber(
        settings.layout.pageWidthPx,
        640,
        2_560,
        DEFAULT_APPEARANCE.layout.pageWidthPx,
      ),
      sidebarWidthPx: normalizeNumber(
        settings.layout.sidebarWidthPx,
        160,
        640,
        DEFAULT_APPEARANCE.layout.sidebarWidthPx,
      ),
      gapPx: normalizeNumber(settings.layout.gapPx, 0, 128, DEFAULT_APPEARANCE.layout.gapPx),
    },
  }
}

function escapeCssString(value: string): string {
  let escaped = ""
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (character === '"' || character === "\\") {
      escaped += `\\${character}`
    } else if (codePoint === 0) {
      escaped += "\\fffd "
    } else if (codePoint < 0x20 || codePoint === 0x7f || character === "<" || character === ">") {
      escaped += `\\${codePoint.toString(16)} `
    } else {
      escaped += character
    }
  }
  return escaped
}

function rgba(color: string, opacity: number): string {
  const red = Number.parseInt(color.slice(1, 3), 16)
  const green = Number.parseInt(color.slice(3, 5), 16)
  const blue = Number.parseInt(color.slice(5, 7), 16)
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`
}

function backgroundCss(background: AppearanceBackground, imageUrl: string | undefined): string {
  switch (background.kind) {
    case "solid":
      return `background-color: ${background.color};`
    case "gradient":
      return `background-color: var(--publisher-page); background-image: linear-gradient(${background.angle}deg, ${background.start}, ${background.end});`
    case "image": {
      const overlay = rgba(background.overlay, background.opacity)
      const image =
        imageUrl === undefined
          ? `linear-gradient(${overlay}, ${overlay})`
          : `linear-gradient(${overlay}, ${overlay}), url("${escapeCssString(imageUrl)}")`
      return `background-color: var(--publisher-page); background-image: ${image}; background-position: ${background.position}; background-size: cover; background-repeat: no-repeat; background-attachment: ${background.fixed ? "fixed" : "scroll"};`
    }
  }
}

const ORDINARY_QUARTZ_GRID =
  '.page:not([data-frame="full-width"]):not([data-frame="minimal"]) > #quartz-body'

interface QuartzGridLayout {
  readonly columns: string
  readonly rows: string
  readonly areas: readonly string[]
}

function quartzGridRule(layout: QuartzGridLayout): string {
  return [
    `  ${ORDINARY_QUARTZ_GRID} {`,
    `    grid-template-columns: ${layout.columns};`,
    `    grid-template-rows: ${layout.rows};`,
    "    gap: var(--publisher-gap);",
    "    grid-template-areas:",
    ...layout.areas.map(
      (area, index) => `      "${area}"${index === layout.areas.length - 1 ? ";" : ""}`,
    ),
    "  }",
  ].join("\n")
}

function sidebarLayouts(sidebars: AppearanceSettings["layout"]["sidebars"]): {
  readonly desktop: QuartzGridLayout
  readonly tablet: QuartzGridLayout
  readonly mobile: QuartzGridLayout
} {
  switch (sidebars) {
    case "both":
      return {
        desktop: {
          columns: "var(--publisher-sidebar-width) minmax(0, 1fr) var(--publisher-sidebar-width)",
          rows: "auto auto auto",
          areas: [
            "grid-sidebar-left grid-header grid-sidebar-right",
            "grid-sidebar-left grid-center grid-sidebar-right",
            "grid-sidebar-left grid-footer grid-sidebar-right",
          ],
        },
        tablet: {
          columns: "var(--publisher-sidebar-width) minmax(0, 1fr)",
          rows: "auto auto auto auto",
          areas: [
            "grid-sidebar-left grid-header",
            "grid-sidebar-left grid-center",
            "grid-sidebar-left grid-sidebar-right",
            "grid-sidebar-left grid-footer",
          ],
        },
        mobile: {
          columns: "auto",
          rows: "auto auto auto auto auto",
          areas: [
            "grid-sidebar-left",
            "grid-header",
            "grid-center",
            "grid-sidebar-right",
            "grid-footer",
          ],
        },
      }
    case "left":
      return {
        desktop: {
          columns: "var(--publisher-sidebar-width) minmax(0, 1fr)",
          rows: "auto auto auto",
          areas: [
            "grid-sidebar-left grid-header",
            "grid-sidebar-left grid-center",
            "grid-sidebar-left grid-footer",
          ],
        },
        tablet: {
          columns: "var(--publisher-sidebar-width) minmax(0, 1fr)",
          rows: "auto auto auto",
          areas: [
            "grid-sidebar-left grid-header",
            "grid-sidebar-left grid-center",
            "grid-sidebar-left grid-footer",
          ],
        },
        mobile: {
          columns: "auto",
          rows: "auto auto auto auto",
          areas: ["grid-sidebar-left", "grid-header", "grid-center", "grid-footer"],
        },
      }
    case "none":
      return {
        desktop: {
          columns: "minmax(0, 1fr)",
          rows: "auto auto auto",
          areas: ["grid-header", "grid-center", "grid-footer"],
        },
        tablet: {
          columns: "minmax(0, 1fr)",
          rows: "auto auto auto",
          areas: ["grid-header", "grid-center", "grid-footer"],
        },
        mobile: {
          columns: "auto",
          rows: "auto auto auto",
          areas: ["grid-header", "grid-center", "grid-footer"],
        },
      }
  }
}

function sidebarCss(sidebars: AppearanceSettings["layout"]["sidebars"]): string {
  const layouts = sidebarLayouts(sidebars)
  const visibility =
    sidebars === "both"
      ? ""
      : sidebars === "left"
        ? `${ORDINARY_QUARTZ_GRID} .right.sidebar { display: none; }`
        : `${ORDINARY_QUARTZ_GRID} .left.sidebar, ${ORDINARY_QUARTZ_GRID} .right.sidebar { display: none; }`
  return [
    visibility,
    "@media all and (min-width: 1200px) {",
    quartzGridRule(layouts.desktop),
    "}",
    "@media all and (min-width: 800px) and (max-width: 1200px) {",
    quartzGridRule(layouts.tablet),
    "}",
    "@media all and (max-width: 800px) {",
    quartzGridRule(layouts.mobile),
    "}",
  ]
    .filter(Boolean)
    .join("\n")
}

export function compileAppearanceCss(
  settings: AppearanceSettings,
  resources: { readonly imageUrl?: string } = {},
): string {
  const normalized = normalizeAppearanceSettings(settings)
  const background = backgroundCss(normalized.background, resources.imageUrl)
  return [
    "/* Knowledge Garden Publisher managed appearance. */",
    ":root {",
    `  --publisher-page: ${normalized.colors.page};`,
    `  --publisher-surface: ${normalized.colors.surface};`,
    `  --publisher-text: ${normalized.colors.text};`,
    `  --publisher-heading: ${normalized.colors.heading};`,
    `  --publisher-accent: ${normalized.colors.accent};`,
    `  --publisher-secondary: ${normalized.colors.secondary};`,
    `  --publisher-border: ${normalized.colors.border};`,
    `  --publisher-code: ${normalized.colors.code};`,
    `  --publisher-font-header: ${normalized.typography.header};`,
    `  --publisher-font-body: ${normalized.typography.body};`,
    `  --publisher-font-code: ${normalized.typography.code};`,
    `  --publisher-base-size: ${normalized.typography.baseSizePx}px;`,
    `  --publisher-line-height: ${normalized.typography.lineHeight};`,
    `  --publisher-article-width: ${normalized.layout.articleWidthCh}ch;`,
    `  --publisher-page-width: ${normalized.layout.pageWidthPx}px;`,
    `  --publisher-sidebar-width: ${normalized.layout.sidebarWidthPx}px;`,
    `  --publisher-gap: ${normalized.layout.gapPx}px;`,
    "}",
    "html:root,",
    'html:root[saved-theme="dark"] {',
    "  --light: var(--publisher-page);",
    "  --lightgray: var(--publisher-surface);",
    "  --gray: var(--publisher-border);",
    "  --darkgray: var(--publisher-text);",
    "  --dark: var(--publisher-heading);",
    "  --secondary: var(--publisher-accent);",
    "  --tertiary: var(--publisher-secondary);",
    "  --highlight: var(--publisher-surface);",
    "  --textHighlight: var(--publisher-surface);",
    "  --titleFont: var(--publisher-font-header);",
    "  --headerFont: var(--publisher-font-header);",
    "  --bodyFont: var(--publisher-font-body);",
    "  --codeFont: var(--publisher-font-code);",
    "  --background-primary: var(--publisher-page);",
    "  --background-primary-alt: var(--publisher-page);",
    "  --background-secondary: var(--publisher-surface);",
    "  --background-secondary-alt: var(--publisher-surface);",
    "  --background-modifier-border: var(--publisher-border);",
    "  --background-modifier-border-hover: var(--publisher-secondary);",
    "  --background-modifier-border-focus: var(--publisher-accent);",
    "  --text-normal: var(--publisher-text);",
    "  --text-muted: var(--publisher-secondary);",
    "  --text-faint: var(--publisher-secondary);",
    "  --text-accent: var(--publisher-accent);",
    "  --text-accent-hover: var(--publisher-secondary);",
    "  --text-on-accent: var(--publisher-page);",
    "  --text-on-accent-inverted: var(--publisher-heading);",
    "  --interactive-normal: var(--publisher-page);",
    "  --interactive-hover: var(--publisher-surface);",
    "  --interactive-accent: var(--publisher-accent);",
    "  --interactive-accent-hover: var(--publisher-secondary);",
    "  --color-base-00: var(--publisher-page);",
    "  --color-base-05: var(--publisher-page);",
    "  --color-base-10: var(--publisher-page);",
    "  --color-base-20: var(--publisher-surface);",
    "  --color-base-25: var(--publisher-surface);",
    "  --color-base-30: var(--publisher-surface);",
    "  --color-base-35: var(--publisher-surface);",
    "  --color-base-40: var(--publisher-border);",
    "  --color-base-50: var(--publisher-border);",
    "  --color-base-60: var(--publisher-secondary);",
    "  --color-base-70: var(--publisher-text);",
    "  --color-base-100: var(--publisher-heading);",
    "  --font-text: var(--publisher-font-body);",
    "  --font-monospace: var(--publisher-font-code);",
    "  --font-interface: var(--publisher-font-body);",
    "  --nav-item-color: var(--publisher-secondary);",
    "  --nav-item-color-hover: var(--publisher-heading);",
    "  --nav-item-color-active: var(--publisher-accent);",
    "  --nav-item-background-hover: var(--publisher-surface);",
    "  --nav-item-background-active: var(--publisher-surface);",
    "  --tag-background: var(--publisher-surface);",
    "  --tag-color: var(--publisher-accent);",
    "  --tag-background-hover: var(--publisher-surface);",
    "  --icon-color: var(--publisher-secondary);",
    "  --icon-color-hover: var(--publisher-heading);",
    "  --icon-color-active: var(--publisher-accent);",
    "  --divider-color: var(--publisher-border);",
    "  --link-color: var(--publisher-accent);",
    "  --link-color-hover: var(--publisher-secondary);",
    "}",
    `body { ${background} color: var(--publisher-text); font-family: var(--publisher-font-body); font-size: var(--publisher-base-size); line-height: var(--publisher-line-height); }`,
    ".page { max-width: var(--publisher-page-width); }",
    ":where(.page > #quartz-body) .center article { max-width: var(--publisher-article-width); }",
    ":where(.page > #quartz-body .center) article { color: var(--publisher-text); font-family: var(--publisher-font-body); font-size: var(--publisher-base-size); line-height: var(--publisher-line-height); }",
    ":where(.page > #quartz-body .center article) :is(p, ul, ol, li, table, tbody, tr, td, th) { font-family: inherit; font-size: inherit; line-height: inherit; }",
    ":where(.page > #quartz-body .center article) :where(.math, .katex) { font-family: inherit; font-size: inherit; line-height: inherit; }",
    ":where(.page > #quartz-body .center article) :is(h1, h2, h3, h4, h5, h6, thead) { color: var(--publisher-heading); font-family: var(--publisher-font-header); line-height: inherit; }",
    ":where(.page > #quartz-body .center article) a { color: var(--publisher-accent); }",
    ":where(.page > #quartz-body .center article) blockquote { color: var(--publisher-secondary); border-color: var(--publisher-border); }",
    ":where(.page > #quartz-body .center article) :is(pre, code) { font-family: var(--publisher-font-code); line-height: inherit; background-color: var(--publisher-code); }",
    ":where(.page > #quartz-body .center article) pre > code { background-color: var(--publisher-code); }",
    ":where(.page > #quartz-body .center article) hr { background-color: var(--publisher-border); }",
    ":where(.page > #quartz-body) :is(.callout, .popover-inner) { background-color: var(--publisher-surface); border-color: var(--publisher-border); }",
    ".popover > .popover-inner { color: var(--publisher-text); font-family: var(--publisher-font-body); font-size: var(--publisher-base-size); line-height: var(--publisher-line-height); background-color: var(--publisher-surface); border-color: var(--publisher-border); }",
    ":where(.popover > .popover-inner) :is(p, ul, ol, li, table, tbody, tr, td, th) { font-family: inherit; font-size: inherit; line-height: inherit; }",
    ":where(.popover > .popover-inner) :where(.math, .katex) { font-family: inherit; font-size: inherit; line-height: inherit; }",
    ":where(.popover > .popover-inner) :is(pre, code) { font-family: var(--publisher-font-code); line-height: inherit; background-color: var(--publisher-code); }",
    ":where(.popover > .popover-inner) pre > code { background-color: var(--publisher-code); }",
    ":where(.page > #quartz-body) :is(.sidebar, .page-header, .page-footer) { font-family: var(--publisher-font-body); line-height: var(--publisher-line-height); }",
    ":where(.page > #quartz-body) .sidebar { color: var(--publisher-secondary); }",
    sidebarCss(normalized.layout.sidebars),
    normalized.customCss.trim(),
    "",
  ]
    .filter(Boolean)
    .join("\n")
}
