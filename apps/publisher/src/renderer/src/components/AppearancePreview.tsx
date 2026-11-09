interface AppearancePreviewProps {
  readonly previewUrl?: string
  readonly state: "idle" | "updating" | "ready" | "error"
}

export function AppearancePreview({
  previewUrl,
  state,
}: AppearancePreviewProps): React.JSX.Element {
  return (
    <section className="appearance-preview" aria-label="实时预览">
      <div className="appearance-preview-heading">
        <div>
          <strong>本地实时预览</strong>
          <small>草稿不会写入博客，应用后仍需单独发布。</small>
        </div>
        {previewUrl && state === "updating" ? <span role="status">正在更新预览…</span> : null}
        {previewUrl && state === "ready" ? <span role="status">实时预览已更新</span> : null}
        {previewUrl && state === "error" ? <span role="alert">实时预览暂时无法更新</span> : null}
      </div>
      {previewUrl ? (
        <iframe
          title="博客外观实时预览"
          sandbox="allow-same-origin allow-scripts"
          src={previewUrl}
        />
      ) : (
        <div className="appearance-preview-unavailable">
          <strong>本地预览不可用</strong>
          <span>请先启动并修复本地预览，再应用外观。</span>
        </div>
      )}
    </section>
  )
}
