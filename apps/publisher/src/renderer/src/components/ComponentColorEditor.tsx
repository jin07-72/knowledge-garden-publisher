import { useEffect, useMemo, useRef, useState } from "react"
import type { AppearanceSettings } from "../../../shared/appearance"
import {
  APPEARANCE_COMPONENTS,
  APPEARANCE_STATES,
  clearComponentColor,
  clearComponentOverrides,
  resolveComponentColor,
  setComponentColor,
  type AppearanceComponentId,
  type AppearanceComponentSlot,
  type AppearanceGlobalColor,
  type AppearanceSlotDefinition,
  type AppearanceState,
  type ResolvedComponentColor,
} from "../../../shared/appearanceComponents"
import type { AppearancePreviewTarget } from "../../../shared/contracts"
import { AppearanceColorPicker } from "./AppearanceColorPicker"

export interface ComponentColorEditorProps {
  readonly settings: AppearanceSettings
  readonly disabled: boolean
  readonly onChange: (settings: AppearanceSettings) => void
  readonly onPreviewTargetChange: (target: AppearancePreviewTarget) => void
}

const stateLabels: Readonly<Record<AppearanceState, string>> = {
  normal: "正常",
  hover: "悬停",
  selected: "选中",
}

const stateDescriptions: Readonly<Record<AppearanceState, string>> = {
  normal: "正常：组件平时的默认静止显示颜色。",
  hover: "悬停：鼠标指针移到组件上方但尚未点击时的反馈颜色。",
  selected: "选中：当前所在页面项、已展开状态或键盘焦点激活时的颜色。",
}

const globalTokenLabels: Readonly<Record<AppearanceGlobalColor, string>> = {
  page: "页面背景色",
  surface: "表面颜色",
  text: "正文颜色",
  heading: "标题颜色",
  accent: "强调色",
  secondary: "辅助色",
  border: "边框颜色",
  code: "代码块颜色",
}

interface ComponentEntry {
  readonly id: AppearanceComponentId
  readonly group: string
  readonly label: string
}

const ALL_COMPONENT_ENTRIES: readonly ComponentEntry[] = (
  Object.entries(APPEARANCE_COMPONENTS) as [
    AppearanceComponentId,
    (typeof APPEARANCE_COMPONENTS)[AppearanceComponentId],
  ][]
).map(([id, definition]) => ({
  id,
  group: definition.group,
  label: definition.label,
}))

export function ComponentColorEditor({
  settings,
  disabled,
  onChange,
  onPreviewTargetChange,
}: ComponentColorEditorProps): React.JSX.Element {
  const [query, setQuery] = useState("")
  const [componentId, setComponentId] = useState<AppearanceComponentId>("domainCard")
  const [state, setState] = useState<AppearanceState>("normal")
  const [expandedSlot, setExpandedSlot] = useState<string>()
  const focusSeqRef = useRef(0)

  const currentComponent = APPEARANCE_COMPONENTS[componentId]
  const supportedStates = currentComponent.states as readonly AppearanceState[]
  const activeState: AppearanceState = supportedStates.includes(state) ? state : "normal"

  useEffect(() => {
    if (!supportedStates.includes(state)) {
      setState("normal")
      onPreviewTargetChange({
        componentId,
        state: "normal",
        ...(focusSeqRef.current > 0 ? { focusSeq: focusSeqRef.current } : {}),
      })
    }
  }, [componentId, onPreviewTargetChange, state, supportedStates])

  const groupedEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const filtered =
      normalizedQuery.length === 0
        ? ALL_COMPONENT_ENTRIES
        : ALL_COMPONENT_ENTRIES.filter(
            (entry) =>
              entry.label.toLowerCase().includes(normalizedQuery) ||
              entry.group.toLowerCase().includes(normalizedQuery) ||
              entry.id.toLowerCase().includes(normalizedQuery),
          )
    const groups = new Map<string, ComponentEntry[]>()
    for (const entry of filtered) {
      const list = groups.get(entry.group) ?? []
      list.push(entry)
      groups.set(entry.group, list)
    }
    return [...groups.entries()]
  }, [query])

  const selectComponent = (nextId: AppearanceComponentId): void => {
    const nextSupported = APPEARANCE_COMPONENTS[nextId].states as readonly AppearanceState[]
    const nextState: AppearanceState = nextSupported.includes(activeState) ? activeState : "normal"
    const nextFocusSeq = ++focusSeqRef.current
    setExpandedSlot(undefined)
    setComponentId(nextId)
    setState(nextState)
    onPreviewTargetChange({ componentId: nextId, state: nextState, focusSeq: nextFocusSeq })
  }

  const updateSlotColor = (slotName: string, nextColor: string): void => {
    onChange({
      ...settings,
      preset: "custom",
      componentColors: setComponentColor(
        settings.componentColors,
        componentId,
        activeState as never,
        slotName as never,
        nextColor,
      ),
    })
  }

  const resetSlotColor = (slotName: string): void => {
    onChange({
      ...settings,
      preset: "custom",
      componentColors: clearComponentColor(
        settings.componentColors,
        componentId,
        activeState as never,
        slotName as never,
      ),
    })
  }

  const resetComponentAll = (): void => {
    setExpandedSlot(undefined)
    onChange({
      ...settings,
      preset: "custom",
      componentColors: clearComponentOverrides(settings.componentColors, componentId),
    })
  }

  const slots = Object.entries(currentComponent.slots) as [string, AppearanceSlotDefinition][]

  return (
    <div className="component-color-editor">
      <div className="component-color-sidebar">
        <label className="component-color-search">
          <span>搜索组件</span>
          <input
            type="search"
            aria-label="搜索组件"
            placeholder="搜索组件…"
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="component-color-groups" role="navigation" aria-label="组件列表">
          {groupedEntries.length === 0 ? (
            <p className="component-color-empty">未找到匹配的组件</p>
          ) : (
            groupedEntries.map(([groupName, entries]) => (
              <div key={groupName} className="component-color-group">
                <strong className="component-color-group-title">{groupName}</strong>
                <div className="component-color-group-items">
                  {entries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={
                        entry.id === componentId
                          ? "component-color-nav-item component-color-nav-item-active"
                          : "component-color-nav-item"
                      }
                      aria-pressed={entry.id === componentId}
                      disabled={disabled}
                      onClick={() => selectComponent(entry.id)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="component-color-main">
        <div className="component-color-header">
          <div>
            <strong>{currentComponent.label}</strong>
            <small>
              {currentComponent.group} · {stateLabels[activeState]}状态
            </small>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || !settings.componentColors[componentId]}
            onClick={resetComponentAll}
          >
            恢复本组件全部继承
          </button>
        </div>

        <div className="component-color-state-tabs" role="tablist" aria-label="组件状态">
          {APPEARANCE_STATES.map((candidate) => {
            const supported = supportedStates.includes(candidate)
            const selected = candidate === activeState
            return (
              <button
                key={candidate}
                type="button"
                role="tab"
                className={
                  selected
                    ? "component-color-state-tab component-color-state-tab-active"
                    : "component-color-state-tab"
                }
                aria-selected={selected}
                disabled={disabled || !supported}
                onClick={() => {
                  if (!supported) return
                  setState(candidate)
                  onPreviewTargetChange({
                    componentId,
                    state: candidate,
                    ...(focusSeqRef.current > 0 ? { focusSeq: focusSeqRef.current } : {}),
                  })
                }}
              >
                {stateLabels[candidate]}
              </button>
            )
          })}
        </div>
        <small className="component-color-state-hint">{stateDescriptions[activeState]}</small>

        <div className="component-color-slots">
          {slots.map(([slotName, slotDefinition]) => {
            const resolved: ResolvedComponentColor = resolveComponentColor(
              settings.componentColors,
              componentId,
              activeState as never,
              slotName as AppearanceComponentSlot,
            )
            const resolvedValue =
              resolved.source === "global"
                ? settings.colors[resolved.token].toUpperCase()
                : resolved.value
            const sourceText =
              resolved.source === "global"
                ? `继承全局（${globalTokenLabels[resolved.token]}）`
                : resolved.source === "state"
                  ? "已覆盖"
                  : "继承正常状态"

            return (
              <div key={slotName} className="component-color-slot-card">
                <div className="component-color-slot-header">
                  <div>
                    <strong>{slotDefinition.label}</strong>
                    <small>{sourceText}</small>
                  </div>
                  <div className="component-color-slot-actions">
                    <button
                      type="button"
                      className="secondary-button component-slot-action-btn"
                      aria-label={`设置${slotDefinition.label}覆盖`}
                      disabled={disabled}
                      onClick={() => {
                        updateSlotColor(slotName, resolvedValue)
                        setExpandedSlot(slotName)
                      }}
                    >
                      设置覆盖
                    </button>
                    <button
                      type="button"
                      className="secondary-button component-slot-action-btn"
                      aria-label={`${slotDefinition.label}恢复继承`}
                      disabled={disabled}
                      onClick={() => {
                        resetSlotColor(slotName)
                        if (expandedSlot === slotName) setExpandedSlot(undefined)
                      }}
                    >
                      恢复继承
                    </button>
                  </div>
                </div>
                <AppearanceColorPicker
                  label={slotDefinition.label}
                  value={resolvedValue}
                  allowAlpha={slotDefinition.allowAlpha}
                  disabled={disabled}
                  expanded={expandedSlot === slotName}
                  onExpandedChange={(open) => setExpandedSlot(open ? slotName : undefined)}
                  onChange={(nextColor) => updateSlotColor(slotName, nextColor)}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
