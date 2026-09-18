import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { Script } from "node:vm"
import { beforeAll, describe, expect, it } from "vitest"

const publisherRoot = process.cwd()
const electronVite = "node_modules/electron-vite/bin/electron-vite.js"

describe("production runtime boundaries", () => {
  let mainOutput: string
  let preloadOutput: string

  beforeAll(() => {
    execFileSync(process.execPath, [electronVite, "build"], {
      cwd: publisherRoot,
      stdio: "pipe"
    })

    mainOutput = readFileSync(`${publisherRoot}/out/main/index.js`, "utf8")
    preloadOutput = readFileSync(`${publisherRoot}/out/preload/index.js`, "utf8")
  })

  it("keeps Electron external in the generated main entry", () => {
    expect(mainOutput).toMatch(/(?:from|require)\s*\(?\s*["']electron["']/)
  })

  it("emits the sandbox preload as a CommonJS script", () => {
    expect(preloadOutput).not.toMatch(/\b(?:import|export)\b/)
    expect(preloadOutput).toMatch(/\b(?:module\.exports|exports\.)/)
    expect(() =>
      new Script(preloadOutput).runInNewContext({ module: { exports: {} }, exports: {} })
    ).not.toThrow()
  })
})
