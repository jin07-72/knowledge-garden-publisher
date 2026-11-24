export const APPEARANCE_STATES = ["normal", "hover", "selected"] as const

export type AppearanceState = (typeof APPEARANCE_STATES)[number]
export type AppearanceGlobalColor =
  "page" | "surface" | "text" | "heading" | "accent" | "secondary" | "border" | "code"
export type AppearanceSlotKind = "surface" | "border" | "text" | "icon"

export interface AppearanceSlotDefinition {
  readonly label: string
  readonly kind: AppearanceSlotKind
  readonly allowAlpha: boolean
  readonly fallback: AppearanceGlobalColor
}

function slot(
  label: string,
  kind: AppearanceSlotKind,
  allowAlpha: boolean,
  fallback: AppearanceGlobalColor,
): AppearanceSlotDefinition {
  return Object.freeze({ label, kind, allowAlpha, fallback })
}

function component<
  const States extends readonly AppearanceState[],
  const Slots extends Readonly<Record<string, AppearanceSlotDefinition>>,
>(group: string, label: string, states: States, slots: Slots) {
  return Object.freeze({
    group,
    label,
    states: Object.freeze(states),
    slots: Object.freeze(slots),
  })
}

const commonControlSlots = {
  surface: slot("背景", "surface", true, "surface"),
  border: slot("边框", "border", true, "border"),
  text: slot("文字", "text", false, "text"),
  icon: slot("图标", "icon", false, "accent"),
} as const

const commonTextSlots = {
  text: slot("文字", "text", false, "text"),
  accent: slot("强调文字", "text", false, "accent"),
} as const

const navigationSlots = {
  surface: slot("背景", "surface", true, "surface"),
  border: slot("边框", "border", true, "border"),
  text: slot("文字", "text", false, "secondary"),
  icon: slot("图标", "icon", false, "secondary"),
} as const

const overlaySlots = {
  surface: slot("遮罩", "surface", true, "page"),
} as const

const panelSlots = {
  surface: slot("背景", "surface", true, "surface"),
  border: slot("边框", "border", true, "border"),
  text: slot("正文", "text", false, "text"),
  heading: slot("标题", "text", false, "heading"),
} as const

const iconSlots = {
  icon: slot("图标", "icon", false, "text"),
} as const

const codeSlots = {
  surface: slot("代码背景", "surface", true, "code"),
  border: slot("边框", "border", true, "border"),
  text: slot("代码文字", "text", false, "text"),
} as const

const tableSlots = {
  surface: slot("单元格背景", "surface", true, "surface"),
  border: slot("表格边框", "border", true, "border"),
  text: slot("正文", "text", false, "text"),
  heading: slot("表头", "text", false, "heading"),
} as const

const borderSlots = {
  border: slot("分隔线", "border", true, "border"),
} as const

const graphSlots = {
  surface: slot("背景", "surface", true, "surface"),
  border: slot("边框与连线", "border", true, "border"),
  node: slot("节点", "icon", false, "accent"),
  text: slot("标签", "text", false, "text"),
} as const

export const APPEARANCE_COMPONENTS = Object.freeze({
  domainCard: component("首页", "领域卡片", ["normal", "hover", "selected"], {
    surface: slot("卡片背景", "surface", true, "surface"),
    border: slot("边框", "border", true, "accent"),
    number: slot("编号", "text", false, "accent"),
    title: slot("标题", "text", false, "heading"),
    description: slot("描述与数量", "text", false, "secondary"),
  }),
  homeSearch: component("首页", "搜索入口", ["normal", "hover", "selected"], commonControlSlots),
  homeStats: component("首页", "首页统计", ["normal"], commonTextSlots),
  explorer: component("导航", "左侧目录", ["normal", "hover", "selected"], navigationSlots),
  mobileMenu: component("导航", "移动菜单", ["normal", "hover", "selected"], navigationSlots),
  breadcrumb: component("导航", "面包屑", ["normal", "hover", "selected"], commonTextSlots),
  tableOfContents: component("导航", "文章目录", ["normal", "hover", "selected"], navigationSlots),
  searchOverlay: component("搜索", "搜索遮罩", ["normal"], overlaySlots),
  searchDialog: component("搜索", "搜索对话框", ["normal"], panelSlots),
  searchInput: component("搜索", "搜索输入框", ["normal", "hover", "selected"], commonControlSlots),
  searchResult: component("搜索", "搜索结果", ["normal", "hover", "selected"], navigationSlots),
  link: component("控件", "链接", ["normal", "hover", "selected"], commonTextSlots),
  button: component("控件", "按钮", ["normal", "hover", "selected"], commonControlSlots),
  tag: component("控件", "标签", ["normal", "hover", "selected"], commonControlSlots),
  icon: component("控件", "图标", ["normal", "hover", "selected"], iconSlots),
  codeBlock: component("正文", "代码块", ["normal"], codeSlots),
  inlineCode: component("正文", "行内代码", ["normal"], codeSlots),
  blockquote: component("正文", "引用块", ["normal"], panelSlots),
  table: component("正文", "表格", ["normal", "hover", "selected"], tableSlots),
  callout: component("正文", "提示块", ["normal"], panelSlots),
  divider: component("正文", "分隔线", ["normal"], borderSlots),
  popover: component("浮层", "悬浮预览", ["normal"], panelSlots),
  tooltip: component("浮层", "工具提示", ["normal"], panelSlots),
  graph: component("浮层", "关系图谱", ["normal", "hover", "selected"], graphSlots),
  footer: component("页脚", "页脚", ["normal", "hover", "selected"], commonTextSlots),
})

export type AppearanceComponentId = keyof typeof APPEARANCE_COMPONENTS
export type AppearanceComponentState<C extends AppearanceComponentId = AppearanceComponentId> =
  C extends AppearanceComponentId ? (typeof APPEARANCE_COMPONENTS)[C]["states"][number] : never
export type AppearanceComponentSlot<C extends AppearanceComponentId = AppearanceComponentId> =
  C extends AppearanceComponentId
    ? keyof (typeof APPEARANCE_COMPONENTS)[C]["slots"] & string
    : never

type ComponentStateOverrides<C extends AppearanceComponentId> = Readonly<
  Partial<{
    [S in AppearanceComponentState<C>]: Readonly<
      Partial<Record<AppearanceComponentSlot<C>, string>>
    >
  }>
>

export type ComponentColorOverrides = Readonly<
  Partial<{ [C in AppearanceComponentId]: ComponentStateOverrides<C> }>
>

export type ResolvedComponentColor =
  | { readonly source: "state" | "normal"; readonly value: string }
  | { readonly source: "global"; readonly token: AppearanceGlobalColor }

type UnknownRecord = Record<string, unknown>
type MutableComponentColors = Record<string, Record<string, Record<string, string>>>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function componentDefinition(componentId: string) {
  if (!Object.prototype.hasOwnProperty.call(APPEARANCE_COMPONENTS, componentId)) {
    throw new Error(`Unknown appearance component: ${componentId}`)
  }
  return APPEARANCE_COMPONENTS[componentId as AppearanceComponentId]
}

function slotDefinition(
  componentId: string,
  state: string,
  slotName: string,
): AppearanceSlotDefinition {
  const definition = componentDefinition(componentId)
  if (!(definition.states as readonly string[]).includes(state)) {
    throw new Error(`Unsupported appearance state: ${componentId}.${state}`)
  }
  if (!Object.prototype.hasOwnProperty.call(definition.slots, slotName)) {
    throw new Error(`Unknown appearance slot: ${componentId}.${state}.${slotName}`)
  }
  return definition.slots[slotName as keyof typeof definition.slots] as AppearanceSlotDefinition
}

function normalizeColor(value: unknown, allowAlpha: boolean, path: string): string {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) {
    throw new Error(`Invalid hex color at ${path}`)
  }
  if (!allowAlpha && value.length === 9) {
    throw new Error(`Alpha is not allowed for opaque slot ${path}`)
  }
  return value.toUpperCase()
}

export function normalizeComponentColors(value: unknown): ComponentColorOverrides {
  if (!isRecord(value)) throw new Error("Component colors must be an object")

  const normalized: MutableComponentColors = {}
  for (const [componentId, statesValue] of Object.entries(value)) {
    const definition = componentDefinition(componentId)
    if (!isRecord(statesValue)) {
      throw new Error(`Component override must be an object: ${componentId}`)
    }

    const normalizedStates: Record<string, Record<string, string>> = {}
    for (const [state, slotsValue] of Object.entries(statesValue)) {
      if (!(definition.states as readonly string[]).includes(state)) {
        throw new Error(`Unsupported appearance state: ${componentId}.${state}`)
      }
      if (!isRecord(slotsValue)) {
        throw new Error(`State override must be an object: ${componentId}.${state}`)
      }

      const normalizedSlots: Record<string, string> = {}
      for (const [slotName, color] of Object.entries(slotsValue)) {
        const definitionForSlot = slotDefinition(componentId, state, slotName)
        normalizedSlots[slotName] = normalizeColor(
          color,
          definitionForSlot.allowAlpha,
          `${componentId}.${state}.${slotName}`,
        )
      }
      if (Object.keys(normalizedSlots).length > 0) normalizedStates[state] = normalizedSlots
    }
    if (Object.keys(normalizedStates).length > 0) normalized[componentId] = normalizedStates
  }

  return normalized as ComponentColorOverrides
}

export function resolveComponentColor<
  C extends AppearanceComponentId,
  S extends AppearanceComponentState<C>,
  L extends AppearanceComponentSlot<C>,
>(
  overrides: ComponentColorOverrides,
  componentId: C,
  state: S,
  slotName: L,
): ResolvedComponentColor {
  const definition = slotDefinition(componentId, state, slotName)
  const mutable = overrides as MutableComponentColors
  const stateValue = mutable[componentId]?.[state]?.[slotName]
  if (stateValue !== undefined) return { source: "state", value: stateValue }

  if (state !== "normal") {
    const normalValue = mutable[componentId]?.normal?.[slotName]
    if (normalValue !== undefined) return { source: "normal", value: normalValue }
  }
  return { source: "global", token: definition.fallback }
}

export function setComponentColor<
  C extends AppearanceComponentId,
  S extends AppearanceComponentState<C>,
  L extends AppearanceComponentSlot<C>,
>(
  overrides: ComponentColorOverrides,
  componentId: C,
  state: S,
  slotName: L,
  color: string,
): ComponentColorOverrides {
  const definition = slotDefinition(componentId, state, slotName)
  const normalizedColor = normalizeColor(
    color,
    definition.allowAlpha,
    `${componentId}.${state}.${slotName}`,
  )
  const current = normalizeComponentColors(overrides) as MutableComponentColors
  return {
    ...current,
    [componentId]: {
      ...current[componentId],
      [state]: {
        ...current[componentId]?.[state],
        [slotName]: normalizedColor,
      },
    },
  } as ComponentColorOverrides
}

export function clearComponentColor<
  C extends AppearanceComponentId,
  S extends AppearanceComponentState<C>,
  L extends AppearanceComponentSlot<C>,
>(
  overrides: ComponentColorOverrides,
  componentId: C,
  state: S,
  slotName: L,
): ComponentColorOverrides {
  slotDefinition(componentId, state, slotName)
  const next = normalizeComponentColors(overrides) as MutableComponentColors
  const slots = next[componentId]?.[state]
  if (slots === undefined || slots[slotName] === undefined) return next as ComponentColorOverrides

  delete slots[slotName]
  if (Object.keys(slots).length === 0) delete next[componentId][state]
  if (Object.keys(next[componentId]).length === 0) delete next[componentId]
  return next as ComponentColorOverrides
}

export function clearComponentOverrides(
  overrides: ComponentColorOverrides,
  componentId: AppearanceComponentId,
): ComponentColorOverrides {
  componentDefinition(componentId)
  const next = normalizeComponentColors(overrides) as MutableComponentColors
  delete next[componentId]
  return next as ComponentColorOverrides
}
