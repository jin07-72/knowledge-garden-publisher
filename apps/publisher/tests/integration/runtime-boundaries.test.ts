import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { Script } from "node:vm"
import { beforeAll, describe, expect, it } from "vitest"
import { trustedRendererArgument } from "../../src/main/rendererTrust"

const publisherRoot = process.cwd()
const electronVite = "node_modules/electron-vite/bin/electron-vite.js"

function maskStringsAndComments(source: string): string {
  let masked = ""
  for (let index = 0; index < source.length;) {
    const character = source[index]!
    const next = source[index + 1]
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        masked += " "
        index += 1
      }
      continue
    }
    if (character === "/" && next === "*") {
      masked += "  "
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        masked += source[index] === "\n" ? "\n" : " "
        index += 1
      }
      if (index < source.length) {
        masked += "  "
        index += 2
      }
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character
      masked += quote
      index += 1
      while (index < source.length) {
        const current = source[index]!
        masked += current === "\n" ? "\n" : " "
        index += 1
        if (current === "\\" && index < source.length) {
          masked += source[index] === "\n" ? "\n" : " "
          index += 1
        } else if (current === quote) break
      }
      continue
    }
    masked += character
    index += 1
  }
  return masked
}

function hasStaticEsmDeclaration(source: string): boolean {
  return /(?:^|[;}\n])\s*(?:import\s*(?:["']|[\w*$\s{},]+\bfrom\s*["'])|export\s*(?:default\b|(?:const|let|var|function|class|async\s+function)\b|\{|\*))/.test(
    maskStringsAndComments(source),
  )
}

describe("production runtime boundaries", () => {
  let mainOutput: string
  let preloadOutput: string

  beforeAll(() => {
    execFileSync(process.execPath, [electronVite, "build"], {
      cwd: publisherRoot,
      stdio: "pipe",
    })

    mainOutput = readFileSync(`${publisherRoot}/out/main/index.js`, "utf8")
    preloadOutput = readFileSync(`${publisherRoot}/out/preload/index.js`, "utf8")
  }, 30_000)

  it("keeps Electron external in the generated main entry", () => {
    expect(mainOutput).toMatch(/(?:from|require)\s*\(?\s*["']electron["']/)
  })

  it("detects static ESM declarations without matching channel strings, comments, or property names", () => {
    for (const source of [
      'const channel = "garden:blogs:cancel-import";',
      'const event = "garden:event:blogs-import-progress";',
      "// export is documentation only\nconst api = { import: false, export: false };",
      'const text = "export default false"; const value = { import: true };',
      "const text = `\nexport default false\n`;",
    ])
      expect(hasStaticEsmDeclaration(source), source).toBe(false)
    for (const source of [
      'import { api } from "garden";',
      'import"garden";const api=1;',
      "const api=1;export{api};",
      "export default function api() {}",
      "export async function run() {}",
    ])
      expect(hasStaticEsmDeclaration(source), source).toBe(true)
  })

  it("emits the sandbox preload as a CommonJS script", () => {
    expect(hasStaticEsmDeclaration(preloadOutput)).toBe(false)
    const required: string[] = []
    const exposed: Array<[string, unknown]> = []
    const electron = {
      contextBridge: {
        exposeInMainWorld: (name: string, value: unknown) => exposed.push([name, value]),
      },
      ipcRenderer: {
        invoke: () => undefined,
        on: () => undefined,
        removeListener: () => undefined,
      },
    }
    const trustedUrl = "http://127.0.0.1:5173/"
    expect(() =>
      new Script(preloadOutput).runInNewContext({
        module: { exports: {} },
        exports: {},
        location: { href: trustedUrl },
        process: { argv: ["electron", trustedRendererArgument(trustedUrl)] },
        URL,
        require: (id: string) => {
          required.push(id)
          if (id === "electron") return electron
          throw new Error(`Unexpected preload dependency: ${id}`)
        },
      }),
    ).not.toThrow()
    expect(required).toEqual(["electron"])
    expect(exposed).toHaveLength(1)
    const [name, api] = exposed[0]!
    expect(name).toBe("garden")
    expect(Object.isFrozen(api)).toBe(true)
    expect(api).not.toHaveProperty("ipcRenderer")
    expect(api).not.toHaveProperty("shell")
    expect(api).not.toHaveProperty("exec")

    const remoteExposures: Array<[string, unknown]> = []
    expect(() =>
      new Script(preloadOutput).runInNewContext({
        module: { exports: {} },
        exports: {},
        location: { href: "https://example.com/" },
        process: { argv: ["electron", trustedRendererArgument(trustedUrl)] },
        URL,
        require: (id: string) => {
          if (id === "electron") {
            return {
              ...electron,
              contextBridge: {
                exposeInMainWorld: (name: string, value: unknown) =>
                  remoteExposures.push([name, value]),
              },
            }
          }
          throw new Error(`Unexpected preload dependency: ${id}`)
        },
      }),
    ).not.toThrow()
    expect(remoteExposures).toEqual([])
  })
})
