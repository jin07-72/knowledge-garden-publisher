import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
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
const MAX_EXTRACTION_STDERR_BYTES = 16 * 1024
const MAX_RUNTIME_FILES = 20_000
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const EXTRACT_ARCHIVE_SCRIPT =
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:KGP_NODE_ARCHIVE_PATH, $env:KGP_NODE_EXTRACT_PATH)"

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

export function createExtractionRequest(archive, destination, environment = process.env) {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR ?? String.raw`C:\Windows`
  const env = { SystemRoot: systemRoot }
  for (const name of ["WINDIR", "TEMP", "TMP"]) {
    if (environment[name] !== undefined) env[name] = environment[name]
  }
  env.KGP_NODE_ARCHIVE_PATH = archive
  env.KGP_NODE_EXTRACT_PATH = destination

  return {
    executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", EXTRACT_ARCHIVE_SCRIPT],
    options: {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  }
}

async function extractZip(archive, destination) {
  const request = createExtractionRequest(archive, destination)
  await new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(request.executable, request.args, request.options)
    } catch (error) {
      rejectPromise(new Error("Could not start Node runtime extraction.", { cause: error }))
      return
    }

    let settled = false
    let stderrBytes = 0
    const stderrChunks = []
    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) rejectPromise(error)
      else resolvePromise()
    }

    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const remaining = MAX_EXTRACTION_STDERR_BYTES - stderrBytes
      if (remaining <= 0) return
      const captured = bytes.subarray(0, remaining)
      stderrChunks.push(captured)
      stderrBytes += captured.byteLength
    })
    child.once("error", (error) => {
      finish(new Error("Could not start Node runtime extraction.", { cause: error }))
    })
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish()
        return
      }
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8").trim()
      const status =
        code === null
          ? signal
            ? ` after signal ${signal}`
            : " without an exit code"
          : ` with exit code ${code}`
      finish(new Error(`Node runtime extraction failed${status}.${stderr ? ` ${stderr}` : ""}`))
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

async function runtimeFileIdentities(root) {
  const files = Object.create(null)
  const pending = [{ absolute: root, relative: "" }]
  let count = 0
  let totalBytes = 0
  while (pending.length > 0) {
    const directory = pending.pop()
    const entries = await readdir(directory.absolute, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name
      if (relative === RUNTIME_MANIFEST) continue
      const absolute = join(directory.absolute, entry.name)
      const details = await lstat(absolute)
      if (details.isSymbolicLink()) throw new Error("unsafe runtime component")
      if (details.isDirectory()) {
        pending.push({ absolute, relative })
        continue
      }
      if (!details.isFile()) throw new Error("unsafe runtime component")
      count += 1
      totalBytes += details.size
      if (count > MAX_RUNTIME_FILES || totalBytes > MAX_RUNTIME_BYTES) {
        throw new Error("runtime tree is too large")
      }
      files[relative] = await fileIdentity(absolute)
    }
  }
  return files
}

function identitiesMatch(expected, actual) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false
  const expectedKeys = Object.keys(expected).sort()
  const actualKeys = Object.keys(actual).sort()
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((path, index) => path !== actualKeys[index])
  ) {
    return false
  }
  return expectedKeys.every((path) => {
    const identity = expected[path]
    return (
      identity !== null &&
      typeof identity === "object" &&
      !Array.isArray(identity) &&
      identity.size === actual[path].size &&
      identity.sha256 === actual[path].sha256
    )
  })
}

export async function isVerifiedRuntime(root) {
  try {
    const rootDetails = await lstat(root)
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) return false
    const manifestPath = join(root, RUNTIME_MANIFEST)
    const manifestDetails = await lstat(manifestPath)
    if (
      !manifestDetails.isFile() ||
      manifestDetails.isSymbolicLink() ||
      manifestDetails.size > MAX_MANIFEST_BYTES
    ) {
      return false
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    const files = await runtimeFileIdentities(root)
    return (
      manifest?.schemaVersion === 2 &&
      manifest?.nodeVersion === NODE_VERSION &&
      manifest?.archive === NODE_ARCHIVE &&
      manifest?.archiveSha256 === EXPECTED_NODE_ARCHIVE_SHA256 &&
      Object.hasOwn(files, "node.exe") &&
      Object.hasOwn(files, "node_modules/npm/bin/npm-cli.js") &&
      identitiesMatch(manifest?.files, files)
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
  const token = randomUUID().replaceAll("-", "")
  // Keep this prefix compact: Windows PowerShell 5 still applies MAX_PATH while
  // extracting Node's deeply nested npm files.
  const stage = join(vendor, `.n-${token}`)
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
    const extracted = join(stage, "x")
    await writeFile(archive, archiveBytes, { flag: "wx" })
    await mkdir(extracted)
    await extractImpl(archive, extracted)
    const prepared = join(extracted, archiveRoot)
    const files = await runtimeFileIdentities(prepared).catch(() => undefined)
    if (
      !files ||
      !Object.hasOwn(files, "node.exe") ||
      !Object.hasOwn(files, "node_modules/npm/bin/npm-cli.js")
    ) {
      throw new Error("The extracted Node runtime is incomplete.")
    }
    await writeFile(
      join(prepared, RUNTIME_MANIFEST),
      `${JSON.stringify({
        schemaVersion: 2,
        nodeVersion: NODE_VERSION,
        archive: NODE_ARCHIVE,
        archiveSha256: expected,
        files,
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
