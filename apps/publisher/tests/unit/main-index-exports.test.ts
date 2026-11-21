import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import type { clearAppearancePreview, previewAppearance } from "../../src/main/index"
import type {
  AppearanceFrameClearRequest,
  AppearanceFramePreviewRequest,
} from "../../src/main/previewAppearance"

type PreviewAppearanceExport = (request: AppearanceFramePreviewRequest) => Promise<boolean>
type ClearAppearancePreviewExport = (request: AppearanceFrameClearRequest) => Promise<boolean>

const previewAppearanceExport: PreviewAppearanceExport = null as unknown as typeof previewAppearance
const clearAppearancePreviewExport: ClearAppearancePreviewExport =
  null as unknown as typeof clearAppearancePreview
void previewAppearanceExport
void clearAppearancePreviewExport

describe("main-process compatibility exports", () => {
  it("keeps the legacy appearance preview entry points on index.ts", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../../src/main/index.ts"), "utf8")

    expect(source).toMatch(/export function previewAppearance\s*\(/)
    expect(source).toMatch(/export function clearAppearancePreview\s*\(/)
  })
})
