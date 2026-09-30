import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export function resolveMainRuntimeFiles(moduleUrl: string): {
  readonly rendererFile: string
  readonly preloadFile: string
} {
  const bundleDirectory = dirname(fileURLToPath(moduleUrl))
  return {
    rendererFile: join(bundleDirectory, "../renderer/index.html"),
    preloadFile: join(bundleDirectory, "../preload/index.js"),
  }
}
