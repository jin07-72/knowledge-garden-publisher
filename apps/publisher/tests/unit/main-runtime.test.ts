// @vitest-environment node
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { resolveMainRuntimeFiles } from "../../src/main/mainRuntime"

describe("main runtime paths", () => {
  it("resolves renderer and preload beside an ESM main bundle without __dirname", () => {
    const mainFile = join(process.cwd(), "out", "main", "index.js")
    const bundleDirectory = dirname(mainFile)

    expect(resolveMainRuntimeFiles(pathToFileURL(mainFile).href)).toEqual({
      rendererFile: join(bundleDirectory, "../renderer/index.html"),
      preloadFile: join(bundleDirectory, "../preload/index.js"),
    })
  })
})
