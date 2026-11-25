import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const expectedVersion = "1.0.0"
const originalColorRead =
  'var Z=getComputedStyle(document.documentElement),Ie=h(Z.getPropertyValue("--secondary").trim(),"#c792ea"),Qu=h(Z.getPropertyValue("--tertiary").trim(),"#82aaff"),ue=h(Z.getPropertyValue("--gray").trim(),"#6c6c6c"),ee=h(Z.getPropertyValue("--lightgray").trim(),"#d4d4d4"),ze=h(Z.getPropertyValue("--dark").trim(),"#1a1a1a"),He=h(Z.getPropertyValue("--light").trim(),"#f5f5f5"),Ne=Z.getPropertyValue("--bodyFont").trim()||"inherit"'
const patchedColorRead =
  'var publisherGraphStyle=getComputedStyle(_),Z=getComputedStyle(document.documentElement),publisherGraphNode=publisherGraphStyle.getPropertyValue("--publisher-graph-node").trim(),Ie=h(publisherGraphNode||Z.getPropertyValue("--secondary").trim(),"#c792ea"),Qu=h(publisherGraphNode||Z.getPropertyValue("--tertiary").trim(),"#82aaff"),ue=h(publisherGraphNode||Z.getPropertyValue("--gray").trim(),"#6c6c6c"),ee=h(publisherGraphStyle.getPropertyValue("--publisher-graph-border").trim()||Z.getPropertyValue("--lightgray").trim(),"#d4d4d4"),ze=h(publisherGraphStyle.getPropertyValue("--publisher-graph-text").trim()||Z.getPropertyValue("--dark").trim(),"#1a1a1a"),He=h(publisherGraphStyle.getPropertyValue("--publisher-graph-surface").trim()||Z.getPropertyValue("--light").trim(),"#f5f5f5"),Ne=Z.getPropertyValue("--bodyFont").trim()||"inherit"'

export async function patchQuartzGraphComponentColors(root = process.cwd()) {
  const packageRoot = join(root, "node_modules", "@quartz-community", "graph")
  const packagePath = join(packageRoot, "package.json")
  const runtimePath = join(packageRoot, "dist", "index.js")
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"))

  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `Quartz graph component-color patch expected ${expectedVersion}, found ${String(packageJson.version)}`,
    )
  }

  const source = await readFile(runtimePath, "utf8")
  if (source.includes(patchedColorRead)) return "already-patched"
  if (!source.includes(originalColorRead)) {
    throw new Error("The verified Quartz graph color fragment was not found; refusing to patch")
  }

  const suffix = randomUUID()
  const temporaryPath = join(dirname(runtimePath), `.publisher-graph-${suffix}.tmp`)
  const backupPath = join(dirname(runtimePath), `.publisher-graph-${suffix}.backup`)
  await writeFile(temporaryPath, source.replace(originalColorRead, patchedColorRead))
  try {
    await rename(runtimePath, backupPath)
    try {
      await rename(temporaryPath, runtimePath)
    } catch (error) {
      await rename(backupPath, runtimePath)
      throw error
    }
    await rm(backupPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
  return "patched"
}

const invokedPath = process.argv[1]
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const result = await patchQuartzGraphComponentColors()
  console.log(`Quartz graph component colors: ${result}`)
}
