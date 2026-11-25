import assert from "node:assert/strict"
import { link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { patchQuartzGraphComponentColors } from "./patch-quartz-graph-component-colors.mjs"

const originalColorRead =
  'var Z=getComputedStyle(document.documentElement),Ie=h(Z.getPropertyValue("--secondary").trim(),"#c792ea"),Qu=h(Z.getPropertyValue("--tertiary").trim(),"#82aaff"),ue=h(Z.getPropertyValue("--gray").trim(),"#6c6c6c"),ee=h(Z.getPropertyValue("--lightgray").trim(),"#d4d4d4"),ze=h(Z.getPropertyValue("--dark").trim(),"#1a1a1a"),He=h(Z.getPropertyValue("--light").trim(),"#f5f5f5"),Ne=Z.getPropertyValue("--bodyFont").trim()||"inherit"'

async function withGraphPackage({ version = "1.0.0", source = originalColorRead }, run) {
  const root = await mkdtemp(join(tmpdir(), "patch-quartz-graph-"))
  const packageRoot = join(root, "node_modules", "@quartz-community", "graph")
  const runtimePath = join(packageRoot, "dist", "index.js")
  const storePath = join(root, "shared-store-index.js")
  await mkdir(join(packageRoot, "dist"), { recursive: true })
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

test("fails clearly when the verified runtime fragment drifts", async () => {
  await withGraphPackage({ source: "var changed=true" }, async ({ root }) => {
    await assert.rejects(
      () => patchQuartzGraphComponentColors(root),
      /verified Quartz graph color fragment was not found/,
    )
  })
})

test("runs the graph patch after plugin installation on every build", async () => {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url))
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"))
  assert.equal(
    packageJson.scripts.prebuild,
    "npm run install-plugins && node scripts/patch-quartz-graph-component-colors.mjs",
  )
})
