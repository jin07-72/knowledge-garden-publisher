import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const expectedVersion = "1.0.0"
const originalColorRead =
  'var Z=getComputedStyle(document.documentElement),Ie=h(Z.getPropertyValue("--secondary").trim(),"#c792ea"),Qu=h(Z.getPropertyValue("--tertiary").trim(),"#82aaff"),ue=h(Z.getPropertyValue("--gray").trim(),"#6c6c6c"),ee=h(Z.getPropertyValue("--lightgray").trim(),"#d4d4d4"),ze=h(Z.getPropertyValue("--dark").trim(),"#1a1a1a"),He=h(Z.getPropertyValue("--light").trim(),"#f5f5f5"),Ne=Z.getPropertyValue("--bodyFont").trim()||"inherit"'
const patchedColorRead =
  'var publisherGraphStyle,Z,publisherGraphNode,Ie,Qu,ue,ee,ze,He,Ne;function publisherGraphReadColors(){publisherGraphStyle=getComputedStyle(_),Z=getComputedStyle(document.documentElement),publisherGraphNode=publisherGraphStyle.getPropertyValue("--publisher-graph-node").trim(),Ie=h(publisherGraphNode||Z.getPropertyValue("--secondary").trim(),"#c792ea"),Qu=h(publisherGraphNode||Z.getPropertyValue("--tertiary").trim(),"#82aaff"),ue=h(publisherGraphNode||Z.getPropertyValue("--gray").trim(),"#6c6c6c"),ee=h(publisherGraphStyle.getPropertyValue("--publisher-graph-border").trim()||Z.getPropertyValue("--lightgray").trim(),"#d4d4d4"),ze=h(publisherGraphStyle.getPropertyValue("--publisher-graph-text").trim()||Z.getPropertyValue("--dark").trim(),"#1a1a1a"),He=h(publisherGraphStyle.getPropertyValue("--publisher-graph-surface").trim()||Z.getPropertyValue("--light").trim(),"#f5f5f5"),Ne=Z.getPropertyValue("--bodyFont").trim()||"inherit"}publisherGraphReadColors()'
const previousPatchedColorRead =
  'var publisherGraphStyle=getComputedStyle(_),Z=getComputedStyle(document.documentElement),publisherGraphNode=publisherGraphStyle.getPropertyValue("--publisher-graph-node").trim(),Ie=h(publisherGraphNode||Z.getPropertyValue("--secondary").trim(),"#c792ea"),Qu=h(publisherGraphNode||Z.getPropertyValue("--tertiary").trim(),"#82aaff"),ue=h(publisherGraphNode||Z.getPropertyValue("--gray").trim(),"#6c6c6c"),ee=h(publisherGraphStyle.getPropertyValue("--publisher-graph-border").trim()||Z.getPropertyValue("--lightgray").trim(),"#d4d4d4"),ze=h(publisherGraphStyle.getPropertyValue("--publisher-graph-text").trim()||Z.getPropertyValue("--dark").trim(),"#1a1a1a"),He=h(publisherGraphStyle.getPropertyValue("--publisher-graph-surface").trim()||Z.getPropertyValue("--light").trim(),"#f5f5f5"),Ne=Z.getPropertyValue("--bodyFont").trim()||"inherit"'
const originalRefreshAnchor = "function Au(){Ke(),Ve(),qe()}for(var k=0;k<ru.length;k++)"
const patchedRefreshAnchor =
  'function Au(){Ke(),Ve(),qe()}function publisherGraphRefreshColors(){publisherGraphReadColors();for(var publisherGraphIndex=0;publisherGraphIndex<P.length;publisherGraphIndex++){var publisherGraphItem=P[publisherGraphIndex],publisherGraphData=publisherGraphItem.simulationData,publisherGraphTag=publisherGraphData.id.startsWith("tags/");publisherGraphItem.color=$e(publisherGraphData),publisherGraphItem.label.style.fill=ze,publisherGraphItem.gfx.clear(),publisherGraphItem.gfx.circle(0,0,oe(publisherGraphData)),publisherGraphItem.gfx.fill({color:publisherGraphTag?He:publisherGraphItem.color}),publisherGraphTag&&publisherGraphItem.gfx.stroke({width:2,color:Qu})}for(var publisherGraphIndex=0;publisherGraphIndex<I.length;publisherGraphIndex++){var publisherGraphLink=I[publisherGraphIndex];publisherGraphLink.color=publisherGraphLink.active?ue:ee}Au()}for(var k=0;k<ru.length;k++)'
const originalPointerAnchor =
  'for(var k=0;k<z.length;k++){var W=z[k],U=new a.Graphics;U.eventMode="none",te.addChild(U),I.push({simulationData:W,gfx:U,color:ee,alpha:1,active:!1})}if(fu)'
const previousPatchedPointerAnchor =
  'for(var k=0;k<z.length;k++){var W=z[k],U=new a.Graphics;U.eventMode="none",te.addChild(U),I.push({simulationData:W,gfx:U,color:ee,alpha:1,active:!1})}_.addEventListener("pointerenter",publisherGraphRefreshColors),_.addEventListener("pointerleave",publisherGraphRefreshColors);if(fu)'
const patchedPointerAnchor =
  'for(var k=0;k<z.length;k++){var W=z[k],U=new a.Graphics;U.eventMode="none",te.addChild(U),I.push({simulationData:W,gfx:U,color:ee,alpha:1,active:!1})}var publisherGraphHoverTarget=_.closest(".graph-outer")||_;publisherGraphHoverTarget.addEventListener("pointerenter",publisherGraphRefreshColors),publisherGraphHoverTarget.addEventListener("pointerleave",publisherGraphRefreshColors);if(fu)'
const originalCleanupAnchor =
  'return ou.on("tick",function(){}),ou.restart(),Au(),se(),function(){le=!0,ou.stop();try{Q.destroy(!0)}catch{}}}'
const previousPatchedCleanupAnchor =
  'return ou.on("tick",function(){}),ou.restart(),Au(),se(),function(){le=!0,ou.stop(),_.removeEventListener("pointerenter",publisherGraphRefreshColors),_.removeEventListener("pointerleave",publisherGraphRefreshColors);try{Q.destroy(!0)}catch{}}}'
const patchedCleanupAnchor =
  'return ou.on("tick",function(){}),ou.restart(),Au(),se(),function(){le=!0,ou.stop(),publisherGraphHoverTarget.removeEventListener("pointerenter",publisherGraphRefreshColors),publisherGraphHoverTarget.removeEventListener("pointerleave",publisherGraphRefreshColors);try{Q.destroy(!0)}catch{}}}'

const defaultOperations = { readFile, rename, rm, writeFile }

export async function patchQuartzGraphComponentColors(
  root = process.cwd(),
  operations = defaultOperations,
) {
  const packageRoot = join(root, "node_modules", "@quartz-community", "graph")
  const packagePath = join(packageRoot, "package.json")
  const runtimePath = join(packageRoot, "dist", "index.js")
  const packageJson = JSON.parse(await operations.readFile(packagePath, "utf8"))

  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `Quartz graph component-color patch expected ${expectedVersion}, found ${String(packageJson.version)}`,
    )
  }

  const source = await operations.readFile(runtimePath, "utf8")
  if (
    source.includes(patchedColorRead) &&
    source.includes(patchedRefreshAnchor) &&
    source.includes(patchedPointerAnchor) &&
    source.includes(patchedCleanupAnchor)
  )
    return "already-patched"
  const colorAnchor = source.includes(originalColorRead)
    ? originalColorRead
    : source.includes(previousPatchedColorRead)
      ? previousPatchedColorRead
      : undefined
  const refreshAnchor = source.includes(patchedRefreshAnchor)
    ? undefined
    : source.includes(originalRefreshAnchor)
      ? originalRefreshAnchor
      : undefined
  const pointerAnchor = source.includes(previousPatchedPointerAnchor)
    ? previousPatchedPointerAnchor
    : source.includes(originalPointerAnchor)
      ? originalPointerAnchor
      : undefined
  const cleanupAnchor = source.includes(previousPatchedCleanupAnchor)
    ? previousPatchedCleanupAnchor
    : source.includes(originalCleanupAnchor)
      ? originalCleanupAnchor
      : undefined
  if (
    (!source.includes(patchedColorRead) && colorAnchor === undefined) ||
    (!source.includes(patchedRefreshAnchor) && refreshAnchor === undefined) ||
    pointerAnchor === undefined ||
    cleanupAnchor === undefined
  ) {
    throw new Error("The verified Quartz graph color fragment was not found; refusing to patch")
  }

  const suffix = randomUUID()
  const temporaryPath = join(dirname(runtimePath), `.publisher-graph-${suffix}.tmp`)
  const backupPath = join(dirname(runtimePath), `.publisher-graph-${suffix}.backup`)
  try {
    const patched = source
      .replace(colorAnchor ?? patchedColorRead, patchedColorRead)
      .replace(refreshAnchor ?? patchedRefreshAnchor, patchedRefreshAnchor)
      .replace(pointerAnchor, patchedPointerAnchor)
      .replace(cleanupAnchor, patchedCleanupAnchor)
    await operations.writeFile(temporaryPath, patched)
    await operations.rename(runtimePath, backupPath)
    try {
      await operations.rename(temporaryPath, runtimePath)
    } catch (error) {
      try {
        await operations.rename(backupPath, runtimePath)
      } catch (rollbackError) {
        throw new Error(
          `Quartz graph runtime could not be restored. Recover it from ${backupPath}. ` +
            `Install error: ${String(error)}; rollback error: ${String(rollbackError)}`,
          { cause: error },
        )
      }
      throw error
    }
    await operations.rm(backupPath)
  } catch (error) {
    await operations.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  return "patched"
}

const invokedPath = process.argv[1]
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const result = await patchQuartzGraphComponentColors()
  console.log(`Quartz graph component colors: ${result}`)
}
