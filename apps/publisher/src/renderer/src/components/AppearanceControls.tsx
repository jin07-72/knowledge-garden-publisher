import { APPEARANCE_PRESETS, cloneAppearancePreset } from "../../../shared/appearance"
import type { AppearanceBackground, AppearanceSettings } from "../../../shared/appearance"

interface AppearanceControlsProps {
  readonly settings: AppearanceSettings
  readonly disabled: boolean
  readonly onChange: (settings: AppearanceSettings) => void
  readonly onChooseBackground: () => void
}

const colorFields = [
  ["page", "页面背景色"],
  ["surface", "表面颜色"],
  ["text", "正文颜色"],
  ["heading", "标题颜色"],
  ["accent", "强调色"],
  ["secondary", "辅助色"],
  ["border", "边框颜色"],
  ["code", "代码块颜色"],
] as const

const presetLabels = {
  "knowledge-garden": "知识花园",
  paper: "纸张",
  minimal: "极简",
} as const

function numberValue(value: string): number {
  return Number.parseFloat(value)
}

function custom(settings: AppearanceSettings): AppearanceSettings {
  return settings.preset === "custom" ? settings : { ...settings, preset: "custom" }
}

function backgroundForKind(
  current: AppearanceBackground,
  kind: AppearanceBackground["kind"],
  pageColor: string,
): AppearanceBackground {
  if (current.kind === kind) return current
  if (kind === "solid") return { kind, color: pageColor }
  if (kind === "gradient") {
    const seed = current.kind === "solid" ? current.color : pageColor
    return { kind, start: seed, end: pageColor, angle: 135 }
  }
  return {
    kind,
    asset: { source: "staged", token: "", name: "" },
    overlay: "#000000",
    opacity: 0.25,
    position: "center",
    fixed: false,
  }
}

export function AppearanceControls({
  settings,
  disabled,
  onChange,
  onChooseBackground,
}: AppearanceControlsProps): React.JSX.Element {
  const update = (next: AppearanceSettings): void => onChange(custom(next))
  const updateBackground = (background: AppearanceBackground): void =>
    update({ ...settings, background })
  const updateGradient = (
    values: Partial<Extract<AppearanceBackground, { readonly kind: "gradient" }>>,
  ): void => {
    if (settings.background.kind === "gradient") {
      updateBackground({ ...settings.background, ...values })
    }
  }
  const updateImage = (
    values: Partial<Extract<AppearanceBackground, { readonly kind: "image" }>>,
  ): void => {
    if (settings.background.kind === "image") {
      updateBackground({ ...settings.background, ...values })
    }
  }

  return (
    <div className="appearance-controls">
      <fieldset className="appearance-section appearance-presets">
        <legend>快速主题</legend>
        <div className="appearance-preset-grid">
          {Object.entries(APPEARANCE_PRESETS).map(([name]) => {
            const preset = name as keyof typeof APPEARANCE_PRESETS
            return (
              <button
                key={preset}
                type="button"
                className={settings.preset === preset ? "primary-button" : "secondary-button"}
                aria-pressed={settings.preset === preset}
                disabled={disabled}
                onClick={() => onChange(cloneAppearancePreset(preset))}
              >
                {presetLabels[preset]}
              </button>
            )
          })}
        </div>
      </fieldset>

      <fieldset className="appearance-section">
        <legend>背景</legend>
        <label>
          <span>背景类型</span>
          <select
            value={settings.background.kind}
            disabled={disabled}
            onChange={(event) =>
              updateBackground(
                backgroundForKind(
                  settings.background,
                  event.target.value as AppearanceBackground["kind"],
                  settings.colors.page,
                ),
              )
            }
          >
            <option value="solid">纯色</option>
            <option value="gradient">渐变</option>
            <option value="image">图片</option>
          </select>
        </label>
        {settings.background.kind === "solid" ? (
          <label>
            <span>背景颜色</span>
            <input
              type="color"
              value={settings.background.color}
              disabled={disabled}
              onChange={(event) => updateBackground({ kind: "solid", color: event.target.value })}
            />
          </label>
        ) : null}
        {settings.background.kind === "gradient" ? (
          <>
            <label>
              <span>渐变起始色</span>
              <input
                type="color"
                value={settings.background.start}
                disabled={disabled}
                onChange={(event) => updateGradient({ start: event.target.value })}
              />
            </label>
            <label>
              <span>渐变结束色</span>
              <input
                type="color"
                value={settings.background.end}
                disabled={disabled}
                onChange={(event) => updateGradient({ end: event.target.value })}
              />
            </label>
            <label>
              <span>渐变角度</span>
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={settings.background.angle}
                disabled={disabled}
                onChange={(event) => updateGradient({ angle: numberValue(event.target.value) })}
              />
              <output>{settings.background.angle}°</output>
            </label>
          </>
        ) : null}
        {settings.background.kind === "image" ? (
          <>
            <div className="appearance-image-choice">
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                onClick={onChooseBackground}
              >
                选择背景图片
              </button>
              <span>{settings.background.asset.name || "尚未选择图片"}</span>
            </div>
            <label>
              <span>图片遮罩颜色</span>
              <input
                type="color"
                value={settings.background.overlay}
                disabled={disabled}
                onChange={(event) => updateImage({ overlay: event.target.value })}
              />
            </label>
            <label>
              <span>图片遮罩强度</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.background.opacity}
                disabled={disabled}
                onChange={(event) => updateImage({ opacity: numberValue(event.target.value) })}
              />
              <output>{Math.round(settings.background.opacity * 100)}%</output>
            </label>
            <label>
              <span>图片位置</span>
              <select
                value={settings.background.position}
                disabled={disabled}
                onChange={(event) =>
                  updateImage({
                    position: event.target.value as "center" | "top" | "bottom",
                  })
                }
              >
                <option value="center">居中</option>
                <option value="top">顶部</option>
                <option value="bottom">底部</option>
              </select>
            </label>
            <label className="appearance-check">
              <input
                type="checkbox"
                checked={settings.background.fixed}
                disabled={disabled}
                onChange={(event) => updateImage({ fixed: event.target.checked })}
              />
              <span>固定背景</span>
            </label>
          </>
        ) : null}
      </fieldset>

      <fieldset className="appearance-section">
        <legend>颜色</legend>
        <div className="appearance-color-grid">
          {colorFields.map(([key, label]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="color"
                value={settings.colors[key]}
                disabled={disabled}
                onChange={(event) =>
                  update({
                    ...settings,
                    colors: { ...settings.colors, [key]: event.target.value },
                  })
                }
              />
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="appearance-section">
        <legend>字体</legend>
        {(
          [
            ["header", "标题字体"],
            ["body", "正文字体"],
            ["code", "代码字体"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <input
              type="text"
              maxLength={128}
              value={settings.typography[key]}
              disabled={disabled}
              onChange={(event) =>
                update({
                  ...settings,
                  typography: { ...settings.typography, [key]: event.target.value },
                })
              }
            />
          </label>
        ))}
        <label>
          <span>基础字号</span>
          <input
            type="range"
            min={10}
            max={32}
            step={1}
            value={settings.typography.baseSizePx}
            disabled={disabled}
            onChange={(event) =>
              update({
                ...settings,
                typography: { ...settings.typography, baseSizePx: numberValue(event.target.value) },
              })
            }
          />
          <output>{settings.typography.baseSizePx}px</output>
        </label>
        <label>
          <span>行高</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={settings.typography.lineHeight}
            disabled={disabled}
            onChange={(event) =>
              update({
                ...settings,
                typography: { ...settings.typography, lineHeight: numberValue(event.target.value) },
              })
            }
          />
          <output>{settings.typography.lineHeight}</output>
        </label>
      </fieldset>

      <fieldset className="appearance-section">
        <legend>排版</legend>
        <label>
          <span>正文宽度</span>
          <input
            type="range"
            min={32}
            max={120}
            step={1}
            value={settings.layout.articleWidthCh}
            disabled={disabled}
            onChange={(event) =>
              update({
                ...settings,
                layout: { ...settings.layout, articleWidthCh: numberValue(event.target.value) },
              })
            }
          />
          <output>{settings.layout.articleWidthCh}ch</output>
        </label>
        <label>
          <span>页面最大宽度</span>
          <input
            type="range"
            min={640}
            max={2560}
            step={20}
            value={settings.layout.pageWidthPx}
            disabled={disabled}
            onChange={(event) =>
              update({
                ...settings,
                layout: { ...settings.layout, pageWidthPx: numberValue(event.target.value) },
              })
            }
          />
          <output>{settings.layout.pageWidthPx}px</output>
        </label>
        <label>
          <span>侧栏宽度</span>
          <input
            type="range"
            min={160}
            max={640}
            step={10}
            value={settings.layout.sidebarWidthPx}
            disabled={disabled}
            onChange={(event) =>
              update({
                ...settings,
                layout: { ...settings.layout, sidebarWidthPx: numberValue(event.target.value) },
              })
            }
          />
          <output>{settings.layout.sidebarWidthPx}px</output>
        </label>
        <label>
          <span>内容间距</span>
          <input
            type="range"
            min={0}
            max={128}
            step={2}
            value={settings.layout.gapPx}
            disabled={disabled}
            onChange={(event) =>
              update({
                ...settings,
                layout: { ...settings.layout, gapPx: numberValue(event.target.value) },
              })
            }
          />
          <output>{settings.layout.gapPx}px</output>
        </label>
        <label>
          <span>侧栏显示</span>
          <select
            value={settings.layout.sidebars}
            disabled={disabled}
            onChange={(event) =>
              update({
                ...settings,
                layout: {
                  ...settings.layout,
                  sidebars: event.target.value as AppearanceSettings["layout"]["sidebars"],
                },
              })
            }
          >
            <option value="both">左右侧栏</option>
            <option value="left">仅左侧栏</option>
            <option value="none">隐藏侧栏</option>
          </select>
        </label>
      </fieldset>

      <fieldset className="appearance-section">
        <legend>高级</legend>
        <label>
          <span>自定义 CSS</span>
          <textarea
            rows={9}
            value={settings.customCss}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => update({ ...settings, customCss: event.target.value })}
          />
        </label>
        <small>最多 64 KiB；只作用于博客，不会注入 Publisher 界面。</small>
      </fieldset>
    </div>
  )
}
