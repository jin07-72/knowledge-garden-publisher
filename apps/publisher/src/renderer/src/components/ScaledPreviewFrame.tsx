import { useEffect, useLayoutEffect, useRef, useState } from "react"

export interface ScaledPreviewFrameProps {
  readonly title: string
  readonly src: string
  readonly sandbox: string
  readonly desktopWidth?: number
  readonly onLoad?: () => void
}

const DEFAULT_DESKTOP_PREVIEW_WIDTH = 1488

export function ScaledPreviewFrame({
  title,
  src,
  sandbox,
  desktopWidth = DEFAULT_DESKTOP_PREVIEW_WIDTH,
  onLoad,
}: ScaledPreviewFrameProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState<{ readonly width: number; readonly height: number }>({
    width: 0,
    height: 0,
  })

  useLayoutEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const measure = (): void => {
      const nextWidth = node.clientWidth
      const nextHeight = node.clientHeight
      setBounds((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight },
      )
    }
    measure()
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => measure())
      observer.observe(node)
      return () => observer.disconnect()
    }
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [])

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const nextWidth = node.clientWidth
    const nextHeight = node.clientHeight
    setBounds((current) =>
      current.width === nextWidth && current.height === nextHeight
        ? current
        : { width: nextWidth, height: nextHeight },
    )
  }, [desktopWidth, src])

  const targetWidth = Math.max(640, desktopWidth)
  const scale = bounds.width > 0 && bounds.width < targetWidth ? bounds.width / targetWidth : 1

  return (
    <div
      ref={viewportRef}
      className="scaled-preview-viewport"
      data-preview-scale={scale < 1 ? scale.toFixed(4) : "1"}
    >
      <iframe
        title={title}
        src={src}
        sandbox={sandbox}
        onLoad={onLoad}
        style={
          scale < 1
            ? {
                width: `${targetWidth}px`,
                height:
                  bounds.height > 0 ? `${Math.ceil(bounds.height / scale)}px` : `${100 / scale}%`,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }
            : undefined
        }
      />
    </div>
  )
}
