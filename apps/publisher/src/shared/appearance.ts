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

export interface AppearanceSettings {
  readonly schemaVersion: 1
  readonly preset: "knowledge-garden" | "paper" | "minimal" | "custom"
  readonly background: AppearanceBackground
  readonly colors: {
    readonly page: string
    readonly surface: string
    readonly text: string
    readonly heading: string
    readonly accent: string
    readonly secondary: string
    readonly border: string
    readonly code: string
  }
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

export const DEFAULT_APPEARANCE = {
  schemaVersion: 1,
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
