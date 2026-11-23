# Component Color Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, inheritable component-level color controls for Publisher-supported Quartz components, including normal, hover, and selected preview states.

**Architecture:** Upgrade the normalized appearance model to schema v2, introduce a shared component registry, and compile component variables and selectors from that registry. Keep drafts in the Renderer, validate all component IDs and slots at the IPC boundary, persist through the existing Quartz adapter transaction, and force preview states through a validated loopback-frame attribute bridge.

**Tech Stack:** Electron 44, React 19, TypeScript 7, Zod 4, Vitest, Testing Library, Quartz SCSS, `react-colorful` 5.8.1.

---

## File map

- Create `apps/publisher/src/shared/appearanceComponents.ts`: component groups, IDs, slots, supported states, fallback tokens, normalization and override helpers.
- Create `apps/publisher/src/shared/appearanceComponentCss.ts`: deterministic component variable and selector CSS generation.
- Modify `apps/publisher/src/shared/appearance.ts`: schema v2 model, presets, cloning, migration entry point, and integration with component CSS.
- Modify `apps/publisher/src/shared/ipcSchemas.ts`: strict v2 request/response validation and validated preview targets.
- Modify `apps/publisher/src/shared/contracts.ts`: preview-target contract types.
- Modify `apps/publisher/src/main/services/appearance/quartzAppearanceAdapter.ts`: v1 manifest migration, unknown-field preservation and v2 persistence.
- Modify `apps/publisher/src/main/previewAppearance.ts`: safe frame attributes for forced state preview and cleanup.
- Modify `apps/publisher/src/main/services/appearance/appearanceService.ts`: pass preview targets into the existing frame boundary.
- Create `apps/publisher/src/renderer/src/components/AppearanceColorPicker.tsx`: opaque and alpha-aware color input using `react-colorful`.
- Create `apps/publisher/src/renderer/src/components/ComponentColorEditor.tsx`: component search, grouping, state tabs, slot editor and resets.
- Modify `apps/publisher/src/renderer/src/components/AppearanceControls.tsx`: integrate global and component colors.
- Modify `apps/publisher/src/renderer/src/components/AppearanceDesigner.tsx`: retain editor selection and include the forced preview target in debounced preview calls.
- Modify `apps/publisher/src/renderer/src/components/AppearancePreview.tsx`: expose the current forced-state description accessibly.
- Modify `apps/publisher/src/renderer/src/app.css`: responsive three-column editor, picker, state tabs and component list.
- Modify `quartz/styles/custom.scss`: route domain-card hardcoded colors through managed component variables.
- Modify `README.md` and `apps/publisher/README.md`: document inheritance, local apply, separate publish and Quartz-only scope.
- Modify existing appearance tests and create focused component-registry/picker tests as listed below.

### Task 1: Pin the reusable color picker

**Files:**
- Modify: `apps/publisher/package.json`
- Modify: `apps/publisher/package-lock.json`

- [ ] **Step 1: Record the current dependency baseline**

Run:

```powershell
npm --prefix apps/publisher view react-colorful version license repository.url --json
```

Expected: version `5.8.1`, license `MIT`, and repository `omgovich/react-colorful`.

- [ ] **Step 2: Install the exact dependency version**

Run:

```powershell
npm --prefix apps/publisher install --save-exact react-colorful@5.8.1
```

Expected: `apps/publisher/package.json` contains `"react-colorful": "5.8.1"` and the package lock changes only for this dependency.

- [ ] **Step 3: Verify the existing project still typechecks**

Run:

```powershell
npm --prefix apps/publisher run typecheck
```

Expected: exit code 0.

- [ ] **Step 4: Commit the dependency boundary**

```powershell
git add apps/publisher/package.json apps/publisher/package-lock.json
git commit -m "build: add component color picker dependency"
```

### Task 2: Define schema v2 and the component registry

**Files:**
- Create: `apps/publisher/src/shared/appearanceComponents.ts`
- Modify: `apps/publisher/src/shared/appearance.ts`
- Create: `apps/publisher/tests/unit/appearance-components.test.ts`
- Modify: `apps/publisher/tests/unit/appearance-model.test.ts`

- [ ] **Step 1: Write failing registry and inheritance tests**

Add tests that assert the stable IDs, state support, alpha policy and fallback order:

```ts
import { describe, expect, it } from "vitest"
import {
  APPEARANCE_COMPONENTS,
  normalizeComponentColors,
  resolveComponentColor,
} from "../../src/shared/appearanceComponents"

describe("appearance component registry", () => {
  it("registers every approved Quartz component group with stable slot metadata", () => {
    expect(Object.keys(APPEARANCE_COMPONENTS)).toEqual([
      "domainCard", "homeSearch", "homeStats", "explorer", "mobileMenu",
      "breadcrumb", "tableOfContents", "searchOverlay", "searchDialog",
      "searchInput", "searchResult", "link", "button", "tag", "icon",
      "codeBlock", "inlineCode", "blockquote", "table", "callout", "divider",
      "popover", "tooltip", "graph", "footer",
    ])
    expect(APPEARANCE_COMPONENTS.domainCard.states).toEqual(["normal", "hover", "selected"])
    expect(APPEARANCE_COMPONENTS.divider.states).toEqual(["normal"])
    expect(APPEARANCE_COMPONENTS.domainCard.slots.surface.allowAlpha).toBe(true)
    expect(APPEARANCE_COMPONENTS.domainCard.slots.title.allowAlpha).toBe(false)
  })

  it("falls back from selected to normal to the global semantic token", () => {
    const overrides = normalizeComponentColors({
      domainCard: { normal: { surface: "#10203080" }, selected: { title: "#FFFFFF" } },
    })
    expect(resolveComponentColor(overrides, "domainCard", "selected", "surface")).toEqual({
      source: "normal", value: "#10203080",
    })
    expect(resolveComponentColor(overrides, "domainCard", "hover", "title")).toEqual({
      source: "global", token: "heading",
    })
  })

  it("drops empty nodes and rejects alpha in opaque slots", () => {
    expect(normalizeComponentColors({ domainCard: { hover: {} } })).toEqual({})
    expect(() => normalizeComponentColors({
      domainCard: { normal: { title: "#FFFFFF80" } },
    })).toThrow(/opaque/i)
  })
})
```

Extend `appearance-model.test.ts` to assert presets now have `schemaVersion: 2`, empty `componentColors`, and deep cloning of component overrides.

- [ ] **Step 2: Run tests and verify they fail for missing v2 APIs**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-components.test.ts tests/unit/appearance-model.test.ts
```

Expected: FAIL because `appearanceComponents.ts` and schema v2 do not exist.

- [ ] **Step 3: Implement the shared registry and override helpers**

Define these public types and values in `appearanceComponents.ts`:

```ts
export const APPEARANCE_STATES = ["normal", "hover", "selected"] as const
export type AppearanceState = (typeof APPEARANCE_STATES)[number]
export type AppearanceGlobalColor =
  | "page" | "surface" | "text" | "heading" | "accent" | "secondary" | "border" | "code"
export type AppearanceSlotKind = "surface" | "border" | "text" | "icon"

export interface AppearanceSlotDefinition {
  readonly label: string
  readonly kind: AppearanceSlotKind
  readonly allowAlpha: boolean
  readonly fallback: AppearanceGlobalColor
}

export const APPEARANCE_COMPONENTS = {
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
} as const
```

Implement `normalizeComponentColors`, `resolveComponentColor`, `setComponentColor`, `clearComponentColor`, and `clearComponentOverrides`. The normalizer must uppercase hex, accept only `#RRGGBB` or allowed `#RRGGBBAA`, reject unknown IDs/states/slots, and remove empty nodes.

- [ ] **Step 4: Upgrade the normalized settings model**

Change `AppearanceSettings` in `appearance.ts` to:

```ts
export interface AppearanceSettings {
  readonly schemaVersion: 2
  readonly preset: "knowledge-garden" | "paper" | "minimal" | "custom"
  readonly background: AppearanceBackground
  readonly colors: GlobalAppearanceColors
  readonly componentColors: ComponentColorOverrides
  readonly typography: AppearanceTypography
  readonly layout: AppearanceLayout
  readonly customCss: string
}
```

Set `componentColors: {}` in every preset, deep-freeze and deep-clone it, and normalize it through `normalizeComponentColors`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-components.test.ts tests/unit/appearance-model.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the model boundary**

```powershell
git add apps/publisher/src/shared/appearance.ts apps/publisher/src/shared/appearanceComponents.ts apps/publisher/tests/unit/appearance-components.test.ts apps/publisher/tests/unit/appearance-model.test.ts
git commit -m "feat: add component appearance model"
```

### Task 3: Add strict IPC validation and v1 manifest migration

**Files:**
- Modify: `apps/publisher/src/shared/ipcSchemas.ts`
- Modify: `apps/publisher/src/main/services/appearance/quartzAppearanceAdapter.ts`
- Modify: `apps/publisher/tests/unit/appearance-contracts.test.ts`
- Modify: `apps/publisher/tests/unit/ipc-schemas.test.ts`
- Modify: `apps/publisher/tests/unit/quartz-appearance-adapter.test.ts`

- [ ] **Step 1: Write failing contract and migration tests**

Add cases that prove requests accept only registered v2 leaves while persisted v1 settings migrate:

```ts
it("accepts registered v2 component overrides and rejects unknown leaves", () => {
  const valid = { ...DEFAULT_APPEARANCE, componentColors: {
    domainCard: { hover: { surface: "#334455CC", title: "#FFFFFF" } },
  }}
  expect(appearanceSettingsSchema.safeParse(valid).success).toBe(true)
  expect(appearanceSettingsSchema.safeParse({
    ...valid,
    componentColors: { domainCard: { hover: { script: "red" } } },
  }).success).toBe(false)
})

it("migrates a v1 manifest without changing its visual defaults", async () => {
  const v1 = fixtureAppearanceV1()
  await writeAppearanceManifest(root, { settings: v1, extensionField: { keep: true } })
  const snapshot = await adapter.read(root)
  expect(snapshot.settings.schemaVersion).toBe(2)
  expect(snapshot.settings.componentColors).toEqual({})
  const plan = await adapter.plan(root, snapshot, snapshot.settings)
  applyPlan(root, plan)
  expect(readAppearanceManifest(root)).toMatchObject({
    settings: { schemaVersion: 2, componentColors: {} },
    extensionField: { keep: true },
  })
})
```

- [ ] **Step 2: Run tests and confirm the expected schema-version failures**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-contracts.test.ts tests/unit/ipc-schemas.test.ts tests/unit/quartz-appearance-adapter.test.ts
```

Expected: FAIL because schemas still require version 1.

- [ ] **Step 3: Split strict request validation from persisted migration**

In `ipcSchemas.ts`, export a strict v2 `appearanceSettingsSchema` and build `componentColors` from the registry:

```ts
const opaqueColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/)
const alphaColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/)

export const appearanceSettingsSchema: z.ZodType<AppearanceSettings> = z.object({
  schemaVersion: z.literal(2),
  preset: z.enum(["knowledge-garden", "paper", "minimal", "custom"]),
  background: appearanceBackgroundSchema,
  colors: appearanceColorsSchema,
  componentColors: componentColorsSchema,
  typography: appearanceTypographySchema,
  layout: appearanceLayoutSchema,
  customCss: appearanceCustomCssSchema,
}).strict()
```

Generate `componentColorsSchema` from `APPEARANCE_COMPONENTS`; use `alphaColorSchema` only where `allowAlpha` is true. Keep response schemas stripping transport-only unknown values.

Use `alphaColorSchema` for global `page`, `surface`, `border`, `code`, solid-background colors and gradient endpoints. Keep `text`, `heading`, `accent`, `secondary` and the image-overlay RGB value on `opaqueColorSchema`; the existing image-overlay `opacity` number remains its single transparency control.

- [ ] **Step 4: Migrate persisted v1 manifests without losing unknown manifest fields**

Add a v1 parse shape local to the Quartz adapter and normalize it through:

```ts
export function migrateAppearanceV1(settings: AppearanceSettingsV1): AppearanceSettings {
  return normalizeAppearanceSettings({
    ...settings,
    schemaVersion: 2,
    componentColors: {},
  })
}
```

Parse the manifest wrapper and settings with `.passthrough()`. When planning a rewrite, merge normalized known settings over the existing raw settings object, preserve unknown sibling fields and unknown manifest fields, and never copy unknown values into compiled CSS or IPC responses. Enforce the existing manifest size limit before parsing and before writing.

- [ ] **Step 5: Run migration and contract tests**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-contracts.test.ts tests/unit/ipc-schemas.test.ts tests/unit/quartz-appearance-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the validated migration**

```powershell
git add apps/publisher/src/shared/ipcSchemas.ts apps/publisher/src/main/services/appearance/quartzAppearanceAdapter.ts apps/publisher/tests/unit/appearance-contracts.test.ts apps/publisher/tests/unit/ipc-schemas.test.ts apps/publisher/tests/unit/quartz-appearance-adapter.test.ts
git commit -m "feat: migrate appearance settings to schema v2"
```

### Task 4: Compile component variables and Quartz selectors

**Files:**
- Create: `apps/publisher/src/shared/appearanceComponentCss.ts`
- Modify: `apps/publisher/src/shared/appearance.ts`
- Modify: `quartz/styles/custom.scss`
- Modify: `apps/publisher/tests/unit/appearance-model.test.ts`
- Create: `apps/publisher/tests/unit/appearance-component-css.test.ts`

- [ ] **Step 1: Write failing deterministic CSS tests**

Test the domain-card contract and representative built-in groups:

```ts
it("emits inherited and overridden variables for every supported state", () => {
  const css = compileAppearanceCss({
    ...DEFAULT_APPEARANCE,
    componentColors: {
      domainCard: {
        normal: { surface: "#20252DD1" },
        hover: { surface: "#303741E6" },
        selected: { border: "#8BD8CE" },
      },
    },
  })
  expect(css).toContain("--publisher-component-domain-card-normal-surface: #20252DD1;")
  expect(css).toContain("--publisher-component-domain-card-hover-surface: #303741E6;")
  expect(css).toContain("--publisher-component-domain-card-selected-title: var(--publisher-component-domain-card-normal-title);")
  expect(css).toContain(".domain-card:hover")
  expect(css).toContain('[data-publisher-appearance-state="selected"] .domain-card')
})

it("covers one selector contract for every registered component", () => {
  const css = compileAppearanceCss(DEFAULT_APPEARANCE)
  for (const id of Object.keys(APPEARANCE_COMPONENTS)) {
    expect(css).toContain(`/* publisher-component:${id} */`)
  }
})
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-component-css.test.ts tests/unit/appearance-model.test.ts
```

Expected: FAIL because no component CSS compiler exists.

- [ ] **Step 3: Implement deterministic variable generation**

Create `compileAppearanceComponentCss(settings)` that iterates registry insertion order and emits:

```css
/* publisher-component:domainCard */
:root {
  --publisher-component-domain-card-normal-surface: var(--publisher-surface);
  --publisher-component-domain-card-hover-surface: var(--publisher-component-domain-card-normal-surface);
  --publisher-component-domain-card-selected-surface: var(--publisher-component-domain-card-normal-surface);
}
```

Use concrete values for overrides. Emit all state variables in stable registry/state/slot order so the output remains byte-for-byte deterministic.

- [ ] **Step 4: Implement the controlled selector rules**

Define exact selector families in `appearanceComponentCss.ts` rather than accepting selector text from settings. Include the 25 registered IDs and map their slots to existing Quartz classes. For the domain card, emit rules equivalent to:

```css
.domain-card {
  color: var(--publisher-component-domain-card-normal-title);
  background: var(--publisher-component-domain-card-normal-surface);
  border-color: var(--publisher-component-domain-card-normal-border);
}
.domain-card:hover {
  background: var(--publisher-component-domain-card-hover-surface);
  border-color: var(--publisher-component-domain-card-hover-border);
}
.domain-card[aria-current="page"],
[data-publisher-appearance-state="selected"] .domain-card,
.domain-card:focus-visible {
  background: var(--publisher-component-domain-card-selected-surface);
  border-color: var(--publisher-component-domain-card-selected-border);
}
```

Keep a non-removable focus outline using the global accent color. Emit analogous controlled rules for the registry selectors, with unsupported states omitted.

- [ ] **Step 5: Route the blog-specific card children through variables**

Replace only the hardcoded color declarations in `quartz/styles/custom.scss`:

```scss
.domain-card span { color: var(--publisher-component-domain-card-normal-number, var(--secondary)); }
.domain-card strong { color: var(--publisher-component-domain-card-normal-title, var(--dark)); }
.domain-card small { color: var(--publisher-component-domain-card-normal-description, var(--darkgray)); }
```

Add hover and selected child-variable rules while leaving spacing, radius, transitions and grid layout unchanged.

- [ ] **Step 6: Append component CSS before advanced custom CSS**

Call `compileAppearanceComponentCss(normalized)` from `compileAppearanceCss` after global Quartz token rules and before `normalized.customCss.trim()`. This preserves the documented advanced CSS escape hatch.

- [ ] **Step 7: Run CSS tests**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-component-css.test.ts tests/unit/appearance-model.test.ts
```

Expected: PASS, including deterministic output and custom CSS last.

- [ ] **Step 8: Commit the compiler**

```powershell
git add apps/publisher/src/shared/appearance.ts apps/publisher/src/shared/appearanceComponentCss.ts apps/publisher/tests/unit/appearance-component-css.test.ts apps/publisher/tests/unit/appearance-model.test.ts quartz/styles/custom.scss
git commit -m "feat: compile component appearance CSS"
```

### Task 5: Add validated forced-state preview

**Files:**
- Modify: `apps/publisher/src/shared/contracts.ts`
- Modify: `apps/publisher/src/shared/ipcSchemas.ts`
- Modify: `apps/publisher/src/main/previewAppearance.ts`
- Modify: `apps/publisher/src/main/services/appearance/appearanceService.ts`
- Modify: `apps/publisher/tests/unit/appearance-contracts.test.ts`
- Modify: `apps/publisher/tests/unit/preview-appearance.test.ts`
- Modify: `apps/publisher/tests/unit/appearance-service.test.ts`

- [ ] **Step 1: Write failing preview-target boundary tests**

Add valid and invalid request cases:

```ts
expect(appearancePreviewRequestSchema.safeParse({
  url: "http://127.0.0.1:8080/?kgpAppearance=session",
  sessionId,
  settings: DEFAULT_APPEARANCE,
  target: { componentId: "domainCard", state: "hover" },
}).success).toBe(true)

expect(appearancePreviewRequestSchema.safeParse({
  url: "http://127.0.0.1:8080/",
  sessionId,
  settings: DEFAULT_APPEARANCE,
  target: { componentId: "divider", state: "hover" },
}).success).toBe(false)
```

Extend `preview-appearance.test.ts` to assert the exact frame receives safe data attributes and clear removes them only for the matching session.

- [ ] **Step 2: Run tests and verify the new contract fails**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-contracts.test.ts tests/unit/preview-appearance.test.ts tests/unit/appearance-service.test.ts
```

Expected: FAIL because `AppearancePreviewRequest` has no target.

- [ ] **Step 3: Add the shared preview target**

Define:

```ts
export interface AppearancePreviewTarget {
  readonly componentId: AppearanceComponentId
  readonly state: AppearanceState
}
```

Add optional `target` to `AppearancePreviewRequest`. Build its Zod refinement from the registry so unsupported component-state pairs fail validation.

- [ ] **Step 4: Set and clear inert frame attributes**

Extend the existing exact-frame injection script to set only these validated values:

```ts
document.documentElement.dataset.publisherAppearanceSession = sessionId
document.documentElement.dataset.publisherAppearanceComponent = target.componentId
document.documentElement.dataset.publisherAppearanceState = target.state
```

When no target is supplied, remove the component and state attributes. During clear, first compare `publisherAppearanceSession` with the requested session, then remove the injected style and all three attributes. Do not add event listeners or evaluate selector text from Renderer input.

- [ ] **Step 5: Run preview boundary tests**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-contracts.test.ts tests/unit/preview-appearance.test.ts tests/unit/appearance-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the preview bridge**

```powershell
git add apps/publisher/src/shared/contracts.ts apps/publisher/src/shared/ipcSchemas.ts apps/publisher/src/main/previewAppearance.ts apps/publisher/src/main/services/appearance/appearanceService.ts apps/publisher/tests/unit/appearance-contracts.test.ts apps/publisher/tests/unit/preview-appearance.test.ts apps/publisher/tests/unit/appearance-service.test.ts
git commit -m "feat: preview component appearance states"
```

### Task 6: Build the alpha-aware color input

**Files:**
- Create: `apps/publisher/src/renderer/src/components/AppearanceColorPicker.tsx`
- Create: `apps/publisher/tests/unit/appearance-color-picker.test.tsx`

- [ ] **Step 1: Write failing picker behavior tests**

Cover opaque and alpha values:

```tsx
it("keeps text colors opaque and normalizes valid manual input", async () => {
  const onChange = vi.fn()
  render(<AppearanceColorPicker label="标题" value="#ffffff" allowAlpha={false} onChange={onChange} />)
  await userEvent.clear(screen.getByLabelText("标题颜色值"))
  await userEvent.type(screen.getByLabelText("标题颜色值"), "#12abef")
  await userEvent.tab()
  expect(onChange).toHaveBeenLastCalledWith("#12ABEF")
  expect(screen.queryByLabelText("标题透明度")).not.toBeInTheDocument()
})

it("edits alpha without changing RGB", async () => {
  const onChange = vi.fn()
  render(<AppearanceColorPicker label="背景" value="#10203080" allowAlpha onChange={onChange} />)
  await userEvent.clear(screen.getByLabelText("背景透明度"))
  await userEvent.type(screen.getByLabelText("背景透明度"), "100")
  expect(onChange).toHaveBeenLastCalledWith("#102030FF")
})
```

- [ ] **Step 2: Run the test and confirm the component is missing**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-color-picker.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the picker**

Use `HexColorPicker` for opaque values and `HexAlphaColorPicker` for alpha-capable values. Keep one local text draft so temporarily incomplete manual input does not update the appearance draft. Commit only a valid normalized hex value on blur or Enter. Provide visible labels, keyboard-reachable inputs, and a checkerboard swatch behind alpha colors.

The public props must be:

```ts
interface AppearanceColorPickerProps {
  readonly label: string
  readonly value: string
  readonly allowAlpha: boolean
  readonly disabled?: boolean
  readonly onChange: (value: string) => void
}
```

- [ ] **Step 4: Run picker tests**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-color-picker.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the reusable input**

```powershell
git add apps/publisher/src/renderer/src/components/AppearanceColorPicker.tsx apps/publisher/tests/unit/appearance-color-picker.test.tsx
git commit -m "feat: add alpha-aware appearance picker"
```

### Task 7: Build and integrate the component color editor

**Files:**
- Create: `apps/publisher/src/renderer/src/components/ComponentColorEditor.tsx`
- Modify: `apps/publisher/src/renderer/src/components/AppearanceControls.tsx`
- Modify: `apps/publisher/src/renderer/src/components/AppearanceDesigner.tsx`
- Modify: `apps/publisher/src/renderer/src/components/AppearancePreview.tsx`
- Modify: `apps/publisher/src/renderer/src/app.css`
- Modify: `apps/publisher/tests/unit/appearance-designer.test.tsx`
- Create: `apps/publisher/tests/unit/component-color-editor.test.tsx`

- [ ] **Step 1: Write failing editor tests**

Test search, states, inheritance, reset and draft retention:

```tsx
it("searches components, edits a hover slot, and restores inheritance", async () => {
  const onChange = vi.fn()
  const onTargetChange = vi.fn()
  render(<ComponentColorEditor
    settings={DEFAULT_APPEARANCE}
    disabled={false}
    onChange={onChange}
    onPreviewTargetChange={onTargetChange}
  />)
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索组件" }), "领域")
  await userEvent.click(screen.getByRole("button", { name: "领域卡片" }))
  await userEvent.click(screen.getByRole("tab", { name: "悬停" }))
  expect(onTargetChange).toHaveBeenLastCalledWith({ componentId: "domainCard", state: "hover" })
  await userEvent.click(screen.getByRole("button", { name: "设置卡片背景覆盖" }))
  expect(onChange).toHaveBeenCalled()
  await userEvent.click(screen.getByRole("button", { name: "卡片背景恢复继承" }))
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ componentColors: {} }))
})
```

Extend `appearance-designer.test.tsx` to switch components, navigate the preview iframe URL, and verify the same draft plus selected component/state remain active.

- [ ] **Step 2: Run the UI tests and confirm they fail**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/component-color-editor.test.tsx tests/unit/appearance-designer.test.tsx
```

Expected: FAIL because the editor is missing.

- [ ] **Step 3: Implement component grouping and state selection**

`ComponentColorEditor` must own only view state:

```ts
const [query, setQuery] = useState("")
const [componentId, setComponentId] = useState<AppearanceComponentId>("domainCard")
const [state, setState] = useState<AppearanceState>("normal")
```

Derive grouped entries from `APPEARANCE_COMPONENTS`, filter by localized label and ID, expose the list as buttons, and use a `role="tablist"` for supported states. If the selected component does not support the current state, switch to `normal` and notify `onPreviewTargetChange` once.

- [ ] **Step 4: Implement slot editing and reset behavior**

For every registered slot, show its resolved value and source. “设置覆盖” starts from the resolved global or inherited value. `AppearanceColorPicker` updates only the selected leaf through `setComponentColor`. “恢复继承” calls `clearComponentColor`; “恢复本组件全部继承” calls `clearComponentOverrides`.

Use these props:

```ts
interface ComponentColorEditorProps {
  readonly settings: AppearanceSettings
  readonly disabled: boolean
  readonly onChange: (settings: AppearanceSettings) => void
  readonly onPreviewTargetChange: (target: AppearancePreviewTarget) => void
}
```

- [ ] **Step 5: Integrate global and component colors without losing other controls**

Keep the existing background, global colors, typography, layout and advanced sections. Rename the existing “颜色” legend to “全局颜色”, render `AppearanceColorPicker` for the eight global colors, then render `ComponentColorEditor` in a “组件颜色” section. `page`, `surface`, `border` and `code` allow alpha; `text`, `heading`, `accent` and `secondary` remain opaque. Solid-background colors and gradient endpoints allow alpha, while the background-image overlay remains an opaque RGB color paired with its existing numeric opacity control.

- [ ] **Step 6: Include the selected target in debounced preview requests**

Store `AppearancePreviewTarget` in `AppearanceDesigner`, initialize it to `{ componentId: "domainCard", state: "normal" }`, and submit:

```ts
api.preview({
  url: sessionPreviewUrl,
  sessionId: sessionId.current,
  settings: draft,
  target: previewTarget,
})
```

Add `previewTarget` to the effect dependencies and monotonic request behavior. Do not reset it when the iframe navigates or when a preview request completes out of order.

- [ ] **Step 7: Implement the approved responsive layout**

Add CSS classes for a two-column settings workspace inside the existing controls column, producing component list + slot editor + preview on wide screens. At the existing narrow breakpoint, stack component list above slot editor and preview. Keep independent scrolling, sticky modal actions, focus visibility and a minimum 44px interactive target height.

- [ ] **Step 8: Run UI tests and accessibility assertions**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-color-picker.test.tsx tests/unit/component-color-editor.test.tsx tests/unit/appearance-designer.test.tsx tests/unit/modal-shell.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit the renderer feature**

```powershell
git add apps/publisher/src/renderer/src/components/AppearanceColorPicker.tsx apps/publisher/src/renderer/src/components/ComponentColorEditor.tsx apps/publisher/src/renderer/src/components/AppearanceControls.tsx apps/publisher/src/renderer/src/components/AppearanceDesigner.tsx apps/publisher/src/renderer/src/components/AppearancePreview.tsx apps/publisher/src/renderer/src/app.css apps/publisher/tests/unit/appearance-color-picker.test.tsx apps/publisher/tests/unit/component-color-editor.test.tsx apps/publisher/tests/unit/appearance-designer.test.tsx
git commit -m "feat: add component color editor"
```

### Task 8: Verify persistence, publication isolation and recovery

**Files:**
- Modify: `apps/publisher/tests/unit/appearance-service.test.ts`
- Modify: `apps/publisher/tests/unit/quartz-appearance-adapter.test.ts`
- Modify: `apps/publisher/tests/unit/changes.test.ts`
- Modify: `apps/publisher/tests/integration/runtime-boundaries.test.ts`

- [ ] **Step 1: Add a cross-boundary regression test**

Create a fixture with one public note, one private note, one image, schema v1 appearance and the screenshot domain-card SCSS. Apply a component override and assert:

```ts
expect(after.publicNote).toEqual(before.publicNote)
expect(after.privateNote).toEqual(before.privateNote)
expect(after.image).toEqual(before.image)
expect(after.manifest.settings.schemaVersion).toBe(2)
expect(after.manifest.settings.componentColors.domainCard.hover.surface).toBe("#303741E6")
expect(after.stylesheet).toContain("--publisher-component-domain-card-hover-surface: #303741E6;")
```

Add a build-failure rollback case and assert all appearance files are byte-equal to their pre-apply values while notes and images remain untouched. Also assert the returned error is the existing rolled-back transaction error rather than an uncertain-success result.

- [ ] **Step 2: Verify publication classification remains isolated**

Extend `changes.test.ts` so the changed manifest, managed stylesheet and `custom.scss` variable migration appear only in the `appearance` group. Assert no `modified`, `private`, `unpublish` or `config` group is created by appearance-only changes.

- [ ] **Step 3: Run the integration slice**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/appearance-service.test.ts tests/unit/quartz-appearance-adapter.test.ts tests/unit/changes.test.ts tests/integration/runtime-boundaries.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the complete unit and integration suite**

Run:

```powershell
npm --prefix apps/publisher run test:run
```

Expected: all tests pass with no unhandled rejection.

- [ ] **Step 5: Commit the regression shield**

```powershell
git add apps/publisher/tests/unit/appearance-service.test.ts apps/publisher/tests/unit/quartz-appearance-adapter.test.ts apps/publisher/tests/unit/changes.test.ts apps/publisher/tests/integration/runtime-boundaries.test.ts
git commit -m "test: protect component appearance boundaries"
```

### Task 9: Document, build and perform real application acceptance

**Files:**
- Modify: `README.md`
- Modify: `apps/publisher/README.md`
- Modify: `apps/publisher/package.json`
- Modify: `apps/publisher/package-lock.json`
- Test: `apps/publisher/tests/e2e/app.spec.ts`

- [ ] **Step 1: Update the user documentation**

Document the exact workflow:

```markdown
组件颜色以全局颜色为默认值。选择组件后，可以分别调整其正常、悬停和选中状态；背景和边框支持透明度。点击“恢复继承”会重新使用全局颜色。

颜色调整先进入本地实时预览。只有点击“应用到本地”才会修改博客文件；线上网站仍需单独执行“检查并发布”。该功能不会修改笔记、图片或公开/私密状态。
```

State that component controls cover registered Quartz built-ins and unknown third-party components require advanced custom CSS.

- [ ] **Step 2: Add or update an Electron smoke path**

In `app.spec.ts`, open the appearance designer, select “领域卡片”, choose “悬停”, change its background, verify the local preview frame receives the state attributes, cancel, reopen, and verify the unapplied value was not persisted.

- [ ] **Step 3: Bump the Publisher patch version**

Run from the worktree root:

```powershell
npm --prefix apps/publisher version patch --no-git-tag-version
```

Expected: version changes from `0.1.5` to `0.1.6` in both package files.

- [ ] **Step 4: Run static and focused end-to-end verification**

Run:

```powershell
npm --prefix apps/publisher run typecheck
npm --prefix apps/publisher run build
npm --prefix apps/publisher run test:e2e
```

Expected: all commands exit 0.

- [ ] **Step 5: Build the Windows installer**

Run:

```powershell
npm --prefix apps/publisher run package:win
```

Expected: `apps/publisher/release/Knowledge-Garden-Publisher-0.1.6-Setup.exe` exists and is non-empty.

- [ ] **Step 6: Perform manual acceptance in the packaged application**

Install `0.1.6`, open the configured Quartz blog, and verify this exact sequence:

1. Open “外观”.
2. Select “领域卡片”.
3. Change normal background, border, number, title and description colors.
4. Change hover background and selected/focus border.
5. Confirm all three states in local preview.
6. Switch to another component and back; confirm the draft remains.
7. Click “应用到本地”, restart the app, and confirm colors remain.
8. Confirm one public and one private note still preview and retain visibility.
9. Open “检查并发布” and confirm only “外观修改” is offered for the appearance-only change.

- [ ] **Step 7: Commit docs, version and acceptance test**

```powershell
git add README.md apps/publisher/README.md apps/publisher/package.json apps/publisher/package-lock.json apps/publisher/tests/e2e/app.spec.ts
git commit -m "release: document component color controls"
```

- [ ] **Step 8: Final repository verification**

Run:

```powershell
git status --short
git log --oneline -10
```

Expected: clean status and a sequence of focused commits for dependency, model, migration, CSS, preview, picker, editor, regression tests and release documentation.
