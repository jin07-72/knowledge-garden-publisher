import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"

import { patchQuartzGraphComponentColors } from "./patch-quartz-graph-component-colors.mjs"

const originalColorRead =
  'var Z=getComputedStyle(document.documentElement),Ie=h(Z.getPropertyValue("--secondary").trim(),"#c792ea"),Qu=h(Z.getPropertyValue("--tertiary").trim(),"#82aaff"),ue=h(Z.getPropertyValue("--gray").trim(),"#6c6c6c"),ee=h(Z.getPropertyValue("--lightgray").trim(),"#d4d4d4"),ze=h(Z.getPropertyValue("--dark").trim(),"#1a1a1a"),He=h(Z.getPropertyValue("--light").trim(),"#f5f5f5"),Ne=Z.getPropertyValue("--bodyFont").trim()||"inherit"'
const previousPatchedColorRead =
  'var publisherGraphStyle=getComputedStyle(_),Z=getComputedStyle(document.documentElement),publisherGraphNode=publisherGraphStyle.getPropertyValue("--publisher-graph-node").trim(),Ie=h(publisherGraphNode||Z.getPropertyValue("--secondary").trim(),"#c792ea"),Qu=h(publisherGraphNode||Z.getPropertyValue("--tertiary").trim(),"#82aaff"),ue=h(publisherGraphNode||Z.getPropertyValue("--gray").trim(),"#6c6c6c"),ee=h(publisherGraphStyle.getPropertyValue("--publisher-graph-border").trim()||Z.getPropertyValue("--lightgray").trim(),"#d4d4d4"),ze=h(publisherGraphStyle.getPropertyValue("--publisher-graph-text").trim()||Z.getPropertyValue("--dark").trim(),"#1a1a1a"),He=h(publisherGraphStyle.getPropertyValue("--publisher-graph-surface").trim()||Z.getPropertyValue("--light").trim(),"#f5f5f5"),Ne=Z.getPropertyValue("--bodyFont").trim()||"inherit"'
const originalRefreshAnchor = "function Au(){Ke(),Ve(),qe()}for(var k=0;k<ru.length;k++)"
const originalPointerAnchor =
  'for(var k=0;k<z.length;k++){var W=z[k],U=new a.Graphics;U.eventMode="none",te.addChild(U),I.push({simulationData:W,gfx:U,color:ee,alpha:1,active:!1})}if(fu)'
const originalCleanupAnchor =
  'return ou.on("tick",function(){}),ou.restart(),Au(),se(),function(){le=!0,ou.stop();try{Q.destroy(!0)}catch{}}}'
const verifiedRuntime = [
  originalColorRead,
  originalRefreshAnchor,
  originalPointerAnchor,
  originalCleanupAnchor,
].join(";")
const execFileAsync = promisify(execFile)

async function withGraphPackage({ version = "1.0.0", source = verifiedRuntime }, run) {
  const root = await mkdtemp(join(tmpdir(), "patch-quartz-graph-"))
  const packageRoot = join(root, "node_modules", "@quartz-community", "graph")
  const runtimePath = join(packageRoot, "dist", "index.js")
  const storePath = join(root, "shared-store-index.js")
  await mkdir(join(packageRoot, "dist"), { recursive: true })
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "5.0.0" }))
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version }))
  await writeFile(storePath, `before;${source};after`)
  await link(storePath, runtimePath)

  try {
    await run({ root, runtimePath, storePath })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("patches the Pixi runtime without mutating a shared package-store hardlink", async () => {
  await withGraphPackage({}, async ({ root, runtimePath, storePath }) => {
    const sharedSource = await readFile(storePath, "utf8")
    assert.equal(await patchQuartzGraphComponentColors(root), "patched")
    const patched = await readFile(runtimePath, "utf8")

    assert.equal(await readFile(storePath, "utf8"), sharedSource)

    assert.match(patched, /getComputedStyle\(_\)/)
    assert.match(patched, /--publisher-graph-surface/)
    assert.match(patched, /--publisher-graph-border/)
    assert.match(patched, /--publisher-graph-node/)
    assert.match(patched, /--publisher-graph-text/)
    assert.match(patched, /publisherGraphRefreshColors/)
    assert.match(patched, /addEventListener\("pointerenter",publisherGraphRefreshColors\)/)
    assert.match(patched, /removeEventListener\("pointerleave",publisherGraphRefreshColors\)/)
    assert.match(
      patched,
      /publisherGraphNode=publisherGraphStyle\.getPropertyValue\("--publisher-graph-node"\)\.trim\(\)/,
    )
    assert.match(patched, /publisherGraphNode\|\|Z\.getPropertyValue\("--secondary"\)/)
    assert.match(
      patched,
      /getPropertyValue\("--publisher-graph-text"\)\.trim\(\)\|\|Z\.getPropertyValue\("--dark"\)/,
    )
    assert.match(
      patched,
      /getPropertyValue\("--publisher-graph-border"\)\.trim\(\)\|\|Z\.getPropertyValue\("--lightgray"\)/,
    )
    assert.match(
      patched,
      /getPropertyValue\("--publisher-graph-surface"\)\.trim\(\)\|\|Z\.getPropertyValue\("--light"\)/,
    )
    assert.doesNotMatch(patched, /:is\(\.node, circle\)/)

    assert.equal(await patchQuartzGraphComponentColors(root), "already-patched")
    assert.equal(await readFile(runtimePath, "utf8"), patched)
  })
})

test("fails clearly when the graph package version drifts", async () => {
  await withGraphPackage({ version: "1.0.1" }, async ({ root }) => {
    await assert.rejects(
      () => patchQuartzGraphComponentColors(root),
      /expected.*1\.0\.0.*found.*1\.0\.1/i,
    )
  })
})

test("upgrades the earlier color-only patch without requiring a reinstall", async () => {
  const earlierRuntime = verifiedRuntime.replace(originalColorRead, previousPatchedColorRead)
  await withGraphPackage({ source: earlierRuntime }, async ({ root, runtimePath }) => {
    assert.equal(await patchQuartzGraphComponentColors(root), "patched")
    const patched = await readFile(runtimePath, "utf8")
    assert.match(patched, /publisherGraphReadColors/)
    assert.match(patched, /publisherGraphRefreshColors/)
  })
})

test("fails clearly when the verified runtime fragment drifts", async () => {
  await withGraphPackage({ source: "var changed=true" }, async ({ root }) => {
    await assert.rejects(
      () => patchQuartzGraphComponentColors(root),
      /verified Quartz graph color fragment was not found/,
    )
  })
})

test("runs the graph patch from the real Quartz CLI build path, including build help", async () => {
  await withGraphPackage({}, async ({ root, runtimePath }) => {
    const cliPath = fileURLToPath(new URL("../quartz/bootstrap-cli.mjs", import.meta.url))
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "build", "--help"], {
      cwd: root,
    })

    assert.match(stdout, /Build Quartz/i)
    assert.match(await readFile(runtimePath, "utf8"), /publisherGraphRefreshColors/)
  })
})

test("does not rely on an npm prebuild hook for the CLI patch", async () => {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url))
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"))
  assert.equal(packageJson.scripts.prebuild, undefined)
})

test("restores the runtime and cleans the temporary file when installation fails", async () => {
  await withGraphPackage({}, async ({ root, runtimePath }) => {
    const real = await import("node:fs/promises")
    let renameCalls = 0
    const ops = {
      ...real,
      rename: async (from, to) => {
        renameCalls += 1
        if (renameCalls === 2) throw new Error("injected install failure")
        return real.rename(from, to)
      },
    }

    await assert.rejects(
      () => patchQuartzGraphComponentColors(root, ops),
      /injected install failure/,
    )
    assert.equal(await readFile(runtimePath, "utf8"), `before;${verifiedRuntime};after`)
    const names = await real.readdir(
      join(root, "node_modules", "@quartz-community", "graph", "dist"),
    )
    assert.deepEqual(names, ["index.js"])
  })
})

test("preserves a recoverable backup path if rollback fails after the runtime moved", async () => {
  await withGraphPackage({}, async ({ root, runtimePath }) => {
    const real = await import("node:fs/promises")
    let renameCalls = 0
    const ops = {
      ...real,
      rename: async (from, to) => {
        renameCalls += 1
        if (renameCalls >= 2) throw new Error(`injected rename failure ${renameCalls}`)
        return real.rename(from, to)
      },
    }

    await assert.rejects(
      () => patchQuartzGraphComponentColors(root, ops),
      (error) => {
        assert.match(error.message, /runtime could not be restored/i)
        assert.match(error.message, /\.backup/)
        return true
      },
    )
    await assert.rejects(() => readFile(runtimePath, "utf8"), /ENOENT/)
    const names = await real.readdir(
      join(root, "node_modules", "@quartz-community", "graph", "dist"),
    )
    assert.equal(names.filter((name) => name.endsWith(".backup")).length, 1)
    assert.equal(names.filter((name) => name.endsWith(".tmp")).length, 0)
  })
})
