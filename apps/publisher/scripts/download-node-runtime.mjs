import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const NODE_VERSION = "22.16.0"
export const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`
export const EXPECTED_NODE_ARCHIVE_SHA256 =
  "21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd"
export const RUNTIME_MANIFEST = ".garden-publisher-node-runtime.json"
const NODE_BASE_URL = `https://nodejs.org/dist/v${NODE_VERSION}`
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_CHECKSUM_BYTES = 4 * 1024 * 1024

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function parseExpectedChecksum(contents, filename) {
  const exact = new RegExp(`^([a-fA-F0-9]{64}) {2}${escapeRegExp(filename)}$`)
  const matches = contents
    .split(/\r?\n/)
    .map((line) => exact.exec(line))
    .filter(Boolean)
  if (matches.length !== 1) {
    if (matches.length === 0 && contents.split(/\r?\n/).some((line) => line.includes(filename))) {
      throw new Error("SHASUMS256.txt did not contain the exact archive filename.")
    }
    throw new Error("SHASUMS256.txt must contain exactly one archive checksum.")
  }
  return matches[0][1].toLowerCase()
}

export function verifySha256(bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Node runtime checksum mismatch for ${NODE_ARCHIVE}.`)
  }
}

export function assertSafeArchiveEntries(entries) {
  if (entries.length === 0) throw new Error("The Node archive is empty.")
  for (const entry of entries) {
    const parts = entry.split("/")
    if (
      entry.length === 0 ||
      entry.includes("\0") ||
      entry.includes("\\") ||
      entry.startsWith("/") ||
      /^[a-zA-Z]:/.test(entry) ||
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe archive entry: ${JSON.stringify(entry)}`)
    }
  }
}

export function readZipEntries(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const minimumEocd = 22
  const searchStart = Math.max(0, buffer.length - 65_557)
  let eocd = -1
  for (let offset = buffer.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error("The Node runtime archive has no valid ZIP directory.")
  const entries = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not accepted for the Node runtime.")
  }
  if (directoryOffset + directorySize > eocd) {
    throw new Error("The Node runtime ZIP directory is truncated.")
  }
  const names = []
  let offset = directoryOffset
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("The Node runtime ZIP directory is invalid.")
    }
    const flags = buffer.readUInt16LE(offset + 8)
    if ((flags & 1) !== 0) throw new Error("Encrypted Node runtime archives are not accepted.")
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > buffer.length) throw new Error("The Node runtime ZIP directory is truncated.")
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8")
    names.push(name.endsWith("/") ? name.slice(0, -1) : name)
    offset = end
  }
  assertSafeArchiveEntries(names)
  return names
}

async function responseBytes(response, maximumBytes, label) {
  if (!response.ok) throw new Error(`${label} download failed with HTTP ${response.status}.`)
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximumBytes)
    throw new Error(`${label} is too large.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} is too large.`)
  return bytes
}

async function extractZip(archive, destination) {
  const powershell = join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  const script =
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($args[0], $args[1])"
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, archive, destination],
      {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    )
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += String(chunk)
    })
    child.on("error", rejectPromise)
    child.on("close", (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`Node runtime extraction failed. ${stderr.trim()}`))
    })
  })
}

async function fileIdentity(path) {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("unsafe runtime file")
  const bytes = await readFile(path)
  return {
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

export async function isVerifiedRuntime(root) {
  try {
    const rootDetails = await lstat(root)
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) return false
    const manifestPath = join(root, RUNTIME_MANIFEST)
    const [manifestDetails, node, npm] = await Promise.all([
      lstat(manifestPath),
      fileIdentity(join(root, "node.exe")),
      fileIdentity(join(root, "node_modules", "npm", "bin", "npm-cli.js")),
    ])
    if (
      !manifestDetails.isFile() ||
      manifestDetails.isSymbolicLink() ||
      manifestDetails.size > 16_384
    ) {
      return false
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    return (
      manifest?.schemaVersion === 1 &&
      manifest?.nodeVersion === NODE_VERSION &&
      manifest?.archive === NODE_ARCHIVE &&
      manifest?.archiveSha256 === EXPECTED_NODE_ARCHIVE_SHA256 &&
      manifest?.files?.["node.exe"]?.size === node.size &&
      manifest?.files?.["node.exe"]?.sha256 === node.sha256 &&
      manifest?.files?.["node_modules/npm/bin/npm-cli.js"]?.size === npm.size &&
      manifest?.files?.["node_modules/npm/bin/npm-cli.js"]?.sha256 === npm.sha256
    )
  } catch {
    return false
  }
}

async function acquireLock(path) {
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      await mkdir(path)
      return
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error("Another Node runtime installation is already in progress.")
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
  }
}

export async function downloadNodeRuntime({
  fetchImpl = fetch,
  platform = process.platform,
  publisherRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  extractImpl = extractZip,
} = {}) {
  if (platform !== "win32") {
    throw new Error("The bundled Node runtime downloader only supports Windows packaging.")
  }
  const vendor = join(publisherRoot, "vendor")
  const target = join(vendor, "node")
  await mkdir(vendor, { recursive: true })
  if (await isVerifiedRuntime(target)) return target

  const lock = join(vendor, ".node-install.lock")
  await acquireLock(lock)
  const token = randomUUID()
  const stage = join(vendor, `.node-stage-${token}`)
  const stale = join(vendor, `.node-stale-${token}`)
  try {
    if (await isVerifiedRuntime(target)) return target
    await mkdir(stage)
    const [archiveResponse, checksumsResponse] = await Promise.all([
      fetchImpl(`${NODE_BASE_URL}/${NODE_ARCHIVE}`),
      fetchImpl(`${NODE_BASE_URL}/SHASUMS256.txt`),
    ])
    const [archiveBytes, checksumBytes] = await Promise.all([
      responseBytes(archiveResponse, MAX_ARCHIVE_BYTES, "Node runtime"),
      responseBytes(checksumsResponse, MAX_CHECKSUM_BYTES, "Node checksums"),
    ])
    const expected = parseExpectedChecksum(checksumBytes.toString("utf8"), NODE_ARCHIVE)
    if (expected !== EXPECTED_NODE_ARCHIVE_SHA256) {
      throw new Error("SHASUMS256.txt does not match the pinned checksum for this Node archive.")
    }
    verifySha256(archiveBytes, expected)
    const entries = readZipEntries(archiveBytes)
    const archiveRoot = `node-v${NODE_VERSION}-win-x64`
    if (entries.some((entry) => entry !== archiveRoot && !entry.startsWith(`${archiveRoot}/`))) {
      throw new Error("The Node runtime archive contains an unexpected top-level path.")
    }
    const archive = join(stage, NODE_ARCHIVE)
    const extracted = join(stage, "extracted")
    await writeFile(archive, archiveBytes, { flag: "wx" })
    await mkdir(extracted)
    await extractImpl(archive, extracted)
    const prepared = join(extracted, archiveRoot)
    const [nodeIdentity, npmIdentity] = await Promise.all([
      fileIdentity(join(prepared, "node.exe")),
      fileIdentity(join(prepared, "node_modules", "npm", "bin", "npm-cli.js")),
    ]).catch(() => [])
    if (!nodeIdentity || !npmIdentity) {
      throw new Error("The extracted Node runtime is incomplete.")
    }
    await writeFile(
      join(prepared, RUNTIME_MANIFEST),
      `${JSON.stringify({
        schemaVersion: 1,
        nodeVersion: NODE_VERSION,
        archive: NODE_ARCHIVE,
        archiveSha256: expected,
        files: {
          "node.exe": nodeIdentity,
          "node_modules/npm/bin/npm-cli.js": npmIdentity,
        },
      })}\n`,
      { flag: "wx" },
    )
    if (!(await isVerifiedRuntime(prepared)))
      throw new Error("The extracted Node runtime is incomplete.")
    let movedStale = false
    try {
      await access(target, constants.F_OK)
      await rename(target, stale)
      movedStale = true
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    try {
      await rename(prepared, target)
    } catch (error) {
      if (movedStale) await rename(stale, target).catch(() => undefined)
      throw error
    }
    if (movedStale) await rm(stale, { recursive: true, force: true })
    return target
  } finally {
    await rm(stage, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (invokedPath === import.meta.url) {
  downloadNodeRuntime()
    .then((target) => console.log(`Bundled Node ${NODE_VERSION} is ready at ${target}.`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
