import { createHash, createHmac, randomUUID } from "node:crypto"
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import type { AppearancePlan } from "../../src/main/services/appearance/appearanceAdapter"
import { internalRecoveryKey } from "../../src/main/services/noteFiles"
import {
  executeAppearancePlan as executeAppearancePlanPublic,
  recoverAppearanceTransactions as recoverAppearanceTransactionsPublic,
  undoAppearanceTransaction as undoAppearanceTransactionPublic,
} from "../../src/main/services/appearance/appearanceTransaction"

const TRANSACTION_ROOT = ".garden-publisher/appearance-transactions"
const HISTORY_ROOT = ".garden-publisher/appearance-history"
const TRANSACTION_ID_PATTERN = /^[a-f0-9-]{36}$/i
const roots: string[] = []
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const TEST_RUNTIME_SYMBOL = Symbol.for("garden-publisher.appearance-transaction.test-runtime")

interface TestOperation {
  readonly kind: string
  readonly index?: number
  readonly revision?: number
}

interface TestOptions {
  readonly beforeOperation?: (operation: TestOperation) => Promise<void> | void
  readonly createId?: () => string
  readonly readBaselineHash?: () => Promise<string>
  readonly emulateDirectorySync?: boolean
  readonly filesystem?: {
    run<T>(instruction: string, operation: () => Promise<T>, event?: TestFsEvent): Promise<T>
  }
}

interface TestFsEvent {
  readonly instruction: string
  readonly ordinal: number
  readonly pathRole?: string
  readonly fileIndex?: number
  readonly transactionPhase?:
    "prepared" | "published" | "verified" | "bootstrap" | "cleanup" | "recovery"
}

function withTestRuntime<T>(options: TestOptions, action: () => Promise<T>): Promise<T> {
  const globals = globalThis as Record<PropertyKey, unknown>
  const previous = globals[TEST_RUNTIME_SYMBOL]
  const { filesystem, emulateDirectorySync = true, ...operationOptions } = options
  globals[TEST_RUNTIME_SYMBOL] = {
    options: operationOptions,
    filesystem,
    emulateDirectorySync,
  }
  return action().finally(() => {
    if (previous === undefined) delete globals[TEST_RUNTIME_SYMBOL]
    else globals[TEST_RUNTIME_SYMBOL] = previous
  })
}

function failInstruction(
  expected: string,
  timing: "before" | "after" = "before",
  ordinal = 0,
  crash = false,
): TestOptions["filesystem"] {
  let seen = 0
  return {
    async run<T>(instruction: string, operation: () => Promise<T>): Promise<T> {
      if (instruction !== expected || seen++ !== ordinal) return operation()
      if (timing === "before") {
        const error = new Error(`injected ${instruction}`) as Error & { simulateCrash?: boolean }
        if (crash) error.simulateCrash = true
        throw error
      }
      const result = await operation()
      const error = new Error(`injected ${instruction}`) as Error & { simulateCrash?: boolean }
      const close = (result as { close?: () => Promise<void> } | null)?.close
      if (typeof close === "function") await close.call(result)
      if (crash) {
        error.simulateCrash = true
      }
      throw error
    },
  }
}

function failFsEvent(
  expected: Pick<TestFsEvent, "instruction"> & Partial<Omit<TestFsEvent, "instruction">>,
  timing: "before" | "after" = "before",
  crash = false,
  hit?: { count: number },
): NonNullable<TestOptions["filesystem"]> {
  return {
    async run<T>(
      instruction: string,
      operation: () => Promise<T>,
      event?: TestFsEvent,
    ): Promise<T> {
      const matches =
        instruction === expected.instruction &&
        event !== undefined &&
        (expected.ordinal === undefined || event.ordinal === expected.ordinal) &&
        (expected.pathRole === undefined || event.pathRole === expected.pathRole) &&
        (expected.fileIndex === undefined || event.fileIndex === expected.fileIndex) &&
        (expected.transactionPhase === undefined ||
          event.transactionPhase === expected.transactionPhase)
      if (!matches) return operation()
      if (hit !== undefined) hit.count += 1
      const error = new Error(`injected ${instruction}`) as Error & { simulateCrash?: boolean }
      if (crash) error.simulateCrash = true
      if (timing === "before") throw error
      const result = await operation()
      const close = (result as { close?: () => Promise<void> } | null)?.close
      if (typeof close === "function") await close.call(result)
      if (crash) {
        error.simulateCrash = true
      }
      throw error
    },
  }
}

function growTargetAfterOpenedStat(
  path: string,
  phase: TestFsEvent["transactionPhase"],
  observation: { readFileCalled: boolean },
): NonNullable<TestOptions["filesystem"]> {
  let armed = true
  return {
    async run<T>(
      instruction: string,
      operation: () => Promise<T>,
      event?: TestFsEvent,
    ): Promise<T> {
      const result = await operation()
      if (
        !armed ||
        instruction !== "fs-open" ||
        event?.pathRole !== "target" ||
        event.transactionPhase !== phase ||
        typeof result !== "object" ||
        result === null
      )
        return result
      armed = false
      let grown = false
      const handle = result as object
      return new Proxy(handle, {
        get(target, property) {
          const value = Reflect.get(target, property)
          if (property === "stat")
            return async (...args: unknown[]) => {
              const details = await Reflect.apply(
                value as (...values: unknown[]) => unknown,
                target,
                args,
              )
              if (!grown) {
                grown = true
                await writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 1, 0x64))
              }
              return details
            }
          if (property === "readFile")
            return (...args: unknown[]) => {
              observation.readFileCalled = true
              return Reflect.apply(value as (...values: unknown[]) => unknown, target, args)
            }
          return typeof value === "function" ? value.bind(target) : value
        },
      }) as T
    },
  }
}

function executeAppearancePlan(
  workspace: string,
  plan: AppearancePlan,
  verifyBuild: () => Promise<void>,
  options: TestOptions = {},
) {
  return withTestRuntime(options, () => executeAppearancePlanPublic(workspace, plan, verifyBuild))
}

function recoverAppearanceTransactions(
  workspace: string,
  verifyBuild?: () => Promise<void>,
  options: TestOptions = {},
) {
  return withTestRuntime(options, () => recoverAppearanceTransactionsPublic(workspace, verifyBuild))
}

function undoAppearanceTransaction(
  workspace: string,
  baselineHash: string,
  verifyBuild: () => Promise<void>,
  options: TestOptions = {},
) {
  return withTestRuntime(options, () =>
    undoAppearanceTransactionPublic(workspace, baselineHash, verifyBuild),
  )
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "appearance-transaction-"))
  roots.push(root)
  await mkdir(join(root, "quartz", "styles"), { recursive: true })
  await mkdir(join(root, "content"), { recursive: true })
  await writeFile(join(root, "quartz.config.yaml"), "theme: old\n")
  await writeFile(join(root, "quartz", "styles", "custom.scss"), "old css\n")
  await writeFile(join(root, "content", "untouched.md"), Buffer.from([0, 1, 2, 255]))
  return root
}

function standardPlan(): AppearancePlan {
  return {
    baselineHash: digest("baseline"),
    settings: {} as AppearancePlan["settings"],
    writes: [
      {
        path: "quartz.config.yaml",
        expectedHash: digest("theme: old\n"),
        bytes: Buffer.from("theme: new\n"),
      },
      {
        path: "quartz/styles/custom.scss",
        expectedHash: digest("old css\n"),
        bytes: Buffer.from("new css\n"),
      },
      { path: "quartz/static/appearance.png", expectedHash: null, bytes: Buffer.from("image") },
    ],
    deletes: [],
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function failAt(operation: string, ordinal = 0) {
  let seen = 0
  return async (value: TestOperation): Promise<void> => {
    if (value.kind === operation && seen++ === ordinal) throw new Error(`injected ${operation}`)
  }
}

function failRevision(
  operation: "journal-file-fsync" | "journal-rename" | "journal-directory-fsync",
  revision: number,
) {
  return async (value: TestOperation): Promise<void> => {
    if (value.kind === operation && value.revision === revision)
      throw new Error(`injected ${operation} revision ${revision}`)
  }
}

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  await expect(action).rejects.toMatchObject({ code })
  try {
    await action
  } catch (error) {
    expect(JSON.stringify(error)).not.toMatch(/[A-Z]:\\|appearance-transaction-|quartz[\\/]/i)
  }
}

async function assertOriginal(root: string): Promise<void> {
  expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: old\n")
  expect(await readFile(join(root, "quartz", "styles", "custom.scss"), "utf8")).toBe("old css\n")
  await expect(lstat(join(root, "quartz", "static", "appearance.png"))).rejects.toMatchObject({
    code: "ENOENT",
  })
}

async function assertNoPublishTemps(root: string): Promise<void> {
  const names = await readdir(root, { recursive: true })
  expect(names.filter((name) => name.includes(".appearance-") && name.endsWith(".tmp"))).toEqual([])
}

async function activeTransactionName(transactionRoot: string): Promise<string> {
  return (await readdir(transactionRoot)).find((name) => TRANSACTION_ID_PATTERN.test(name))!
}

async function expectForeignPreserved(root: string, target: string): Promise<void> {
  const expected = target.endsWith("obsolete.png") ? "foreign" : "foreign\n"
  try {
    if ((await readFile(join(root, ...target.split("/")), "utf8")) === expected) return
  } catch {
    // An interrupted move may retain the concurrent bytes in authenticated quarantine evidence.
  }
  const transactions = await readdir(join(root, TRANSACTION_ROOT))
  const evidence: string[] = []
  for (const id of transactions) {
    const directory = join(root, TRANSACTION_ROOT, id, "quarantine")
    for (const name of await readdir(directory).catch(() => []))
      evidence.push(await readFile(join(directory, name), "utf8"))
  }
  expect(evidence).toContain(expected)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("appearance transactions", () => {
  it.runIf(process.platform === "win32")(
    "commits on Windows with file fsyncs and a recoverable directory barrier",
    async () => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })

      const receipt = await executeAppearancePlanPublic(root, standardPlan(), async () => undefined)

      expect(receipt.status).toBe("verified")
      expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
      expect(
        (await readdir(root, { recursive: true })).filter((name) =>
          String(name).includes("durability-barrier"),
        ),
      ).toEqual([])
    },
  )

  it
    .runIf(process.platform === "win32")
    .each([
      "directory-barrier-open",
      "directory-barrier-write",
      "directory-barrier-fsync",
      "directory-barrier-unlink",
    ])(
    "recovers a Windows directory barrier crash at %s",
    async (instruction) => {
      for (const timing of ["before", "after"] as const) {
        const root = await workspace()
        await mkdir(join(root, "quartz", "static"), { recursive: true })
        const hit = { count: 0 }
        await expect(
          executeAppearancePlan(root, standardPlan(), async () => undefined, {
            emulateDirectorySync: false,
            filesystem: failFsEvent(
              {
                instruction,
                pathRole: "identity-capability",
                transactionPhase: "recovery",
              },
              timing,
              true,
              hit,
            ),
          }),
        ).rejects.toThrow(`injected ${instruction}`)
        expect(hit.count).toBe(1)
        if (
          (instruction === "directory-barrier-open" && timing === "after") ||
          (instruction === "directory-barrier-write" && timing === "before")
        ) {
          await expectCode(
            recoverAppearanceTransactions(root, undefined, { emulateDirectorySync: false }),
            "APPEARANCE_TRANSACTION_UNCERTAIN",
          )
          expect(
            (await readdir(join(root, TRANSACTION_ROOT))).some((name) =>
              name.startsWith(".durability-barrier-"),
            ),
          ).toBe(true)
          continue
        }
        await recoverAppearanceTransactions(root)
        expect(
          (await readdir(root, { recursive: true })).filter((name) =>
            String(name).includes("durability-barrier"),
          ),
        ).toEqual([])
      }
    },
    60_000,
  )

  it.runIf(process.platform === "win32")(
    "retains every incomplete or unauthenticated Windows directory barrier",
    async () => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expect(
        executeAppearancePlan(root, standardPlan(), async () => undefined, {
          emulateDirectorySync: false,
          filesystem: failFsEvent(
            {
              instruction: "directory-barrier-write",
              pathRole: "identity-capability",
              transactionPhase: "recovery",
            },
            "after",
            true,
          ),
        }),
      ).rejects.toThrow("injected directory-barrier-write")
      const transactionRoot = join(root, TRANSACTION_ROOT)
      const barrierName = (await readdir(transactionRoot)).find((name) =>
        name.startsWith(".durability-barrier-"),
      )!
      const barrier = join(transactionRoot, barrierName)
      const complete = await readFile(barrier)

      for (let boundary = 0; boundary < complete.length; boundary += 1) {
        const prefix = complete.subarray(0, boundary)
        await writeFile(barrier, prefix)
        await expectCode(
          recoverAppearanceTransactions(root, undefined, { emulateDirectorySync: false }),
          "APPEARANCE_TRANSACTION_UNCERTAIN",
        )
        expect(await readFile(barrier)).toEqual(prefix)
      }

      for (const foreign of [
        Buffer.from("{"),
        Buffer.from("{}"),
        Buffer.concat([complete, Buffer.from("\n")]),
        Buffer.from("foreign evidence"),
      ]) {
        await writeFile(barrier, foreign)
        await expectCode(
          recoverAppearanceTransactions(root, undefined, { emulateDirectorySync: false }),
          "APPEARANCE_TRANSACTION_UNCERTAIN",
        )
        expect(await readFile(barrier)).toEqual(foreign)
      }

      const envelope = JSON.parse(complete.toString("utf8"))
      envelope.authentication = "0".repeat(64)
      const wrongAuthentication = Buffer.from(JSON.stringify(envelope))
      await writeFile(barrier, wrongAuthentication)
      await expectCode(
        recoverAppearanceTransactions(root, undefined, { emulateDirectorySync: false }),
        "APPEARANCE_TRANSACTION_UNCERTAIN",
      )
      expect(await readFile(barrier)).toEqual(wrongAuthentication)

      await writeFile(barrier, complete)
      await recoverAppearanceTransactions(root, undefined, { emulateDirectorySync: false })
      await expect(lstat(barrier)).rejects.toMatchObject({ code: "ENOENT" })
    },
    120_000,
  )

  it.runIf(process.platform === "win32")(
    "fails safely when a real file fsync reports an I/O error",
    async () => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expectCode(
        executeAppearancePlan(root, standardPlan(), async () => undefined, {
          emulateDirectorySync: false,
          filesystem: {
            async run<T>(instruction: string, operation: () => Promise<T>, event?: TestFsEvent) {
              if (instruction === "fs-fsync" && event?.pathRole === "staged-evidence")
                throw Object.assign(new Error("injected file fsync EIO"), { code: "EIO" })
              return operation()
            },
          },
        }),
        "APPEARANCE_TRANSACTION_FAILED",
      )
      await assertOriginal(root)
    },
    30_000,
  )

  it.each(["EPERM", "ENOTSUP", "EINVAL"])(
    "never treats directory barrier failure %s as durable success",
    async (code) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expectCode(
        executeAppearancePlan(root, standardPlan(), async () => undefined, {
          filesystem: {
            async run<T>(instruction: string, operation: () => Promise<T>): Promise<T> {
              if (instruction !== "directory-barrier") return operation()
              throw Object.assign(new Error(code), { code })
            },
          },
        }),
        "APPEARANCE_TRANSACTION_FAILED",
      )
      await assertOriginal(root)
    },
  )

  it("verifies persisted identities without creating per-load hard-link probes", async () => {
    const observed: string[] = []
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })

    await executeAppearancePlan(root, standardPlan(), async () => undefined, {
      filesystem: {
        async run<T>(instruction: string, operation: () => Promise<T>): Promise<T> {
          if (instruction.startsWith("identity-probe-")) observed.push(instruction)
          return operation()
        },
      },
    })

    expect(observed).toEqual([])
  })

  it("converges after a restart at every identity-capability probe operation", async () => {
    const captureRoot = await workspace()
    await mkdir(join(captureRoot, "quartz", "static"), { recursive: true })
    const events = new Map<string, TestFsEvent>()
    await executeAppearancePlan(captureRoot, standardPlan(), async () => undefined, {
      filesystem: {
        async run<T>(instruction: string, operation: () => Promise<T>, event?: TestFsEvent) {
          if (
            event !== undefined &&
            (instruction.startsWith("identity-capability-") ||
              event.pathRole?.startsWith("identity-capability"))
          )
            events.set(JSON.stringify(event), { ...event })
          return operation()
        },
      },
    })
    expect(events.size).toBeGreaterThan(0)

    for (const event of events.values()) {
      for (const timing of ["before", "after"] as const) {
        const root = await workspace()
        await mkdir(join(root, "quartz", "static"), { recursive: true })
        const hit = { count: 0 }
        await expect(
          executeAppearancePlan(root, standardPlan(), async () => undefined, {
            filesystem: failFsEvent(event, timing, true, hit),
          }),
        ).rejects.toThrow(`injected ${event.instruction}`)
        expect(hit.count).toBe(1)
        const unauthenticatedClaim =
          (event.instruction === "identity-capability-claim-open" && timing === "after") ||
          (event.pathRole === "identity-capability-claim" &&
            ((event.instruction === "fs-open" && timing === "after") ||
              (event.instruction === "fs-write" && timing === "before")))
        if (unauthenticatedClaim) {
          await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
          const retained = await readdir(join(root, TRANSACTION_ROOT))
          expect(retained.some((name) => name.endsWith(".claim"))).toBe(true)
          continue
        }
        await recoverAppearanceTransactions(root).catch(async (error) => {
          throw new Error(
            `recovery failed for ${JSON.stringify(event)} ${timing}; retained=${JSON.stringify(await readdir(join(root, TRANSACTION_ROOT)).catch(() => []))}`,
            {
              cause: error,
            },
          )
        })
        const retained = await readdir(join(root, TRANSACTION_ROOT)).catch(() => [])
        expect(retained.filter((name) => name.startsWith(".identity-capability-"))).toEqual([])
      }
    }
  }, 120_000)

  it("retains every incomplete authenticated identity claim byte prefix", async () => {
    const token = "10000000-0000-4000-8000-000000000098"
    const outcomes: Array<{ boundary: number; code?: string; retained: boolean }> = []
    let claimLength = 0

    for (let boundary = 0; boundary < claimLength || boundary === 0; boundary += 1) {
      const root = await workspace()
      const transactionRoot = join(root, TRANSACTION_ROOT)
      await mkdir(transactionRoot, { recursive: true })
      const key = await internalRecoveryKey(root, true)
      const authentication = createHmac("sha256", key)
        .update("garden-publisher/appearance-transaction/identity-capability/v1\0")
        .update(token)
        .digest("hex")
      const complete = Buffer.from(JSON.stringify({ version: 1, token, authentication }))
      claimLength = complete.length
      const claim = join(transactionRoot, `.identity-capability-${token}.claim`)
      const prefix = complete.subarray(0, boundary)
      await writeFile(claim, prefix)

      let code: string | undefined
      try {
        await recoverAppearanceTransactionsPublic(root)
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error)
          code = String(error.code)
      }
      outcomes.push({
        boundary,
        code,
        retained: await readFile(claim)
          .then((bytes) => bytes.equals(prefix))
          .catch(() => false),
      })
    }

    expect(outcomes).toEqual(
      Array.from({ length: claimLength }, (_, boundary) => ({
        boundary,
        code: "APPEARANCE_TRANSACTION_UNCERTAIN",
        retained: true,
      })),
    )
  }, 120_000)

  it.each([
    ["malformed JSON", () => Buffer.from("{")],
    ["valid JSON without fields", () => Buffer.from("{}")],
    [
      "valid JSON without authentication",
      (token: string) => Buffer.from(JSON.stringify({ version: 1, token })),
    ],
    [
      "wrong authentication",
      (token: string) =>
        Buffer.from(JSON.stringify({ version: 1, token, authentication: "0".repeat(64) })),
    ],
    [
      "wrong version",
      (token: string, authentication: string) =>
        Buffer.from(JSON.stringify({ version: 2, token, authentication })),
    ],
    [
      "wrong claim identity",
      (_token: string, authentication: string) =>
        Buffer.from(
          JSON.stringify({
            version: 1,
            token: "10000000-0000-4000-8000-000000000096",
            authentication,
          }),
        ),
    ],
    [
      "extra key",
      (token: string, authentication: string) =>
        Buffer.from(JSON.stringify({ version: 1, token, authentication, extra: true })),
    ],
    [
      "appended bytes",
      (token: string, authentication: string) =>
        Buffer.from(`${JSON.stringify({ version: 1, token, authentication })}\n`),
    ],
  ] as const)("retains an identity claim containing %s", async (_label, claimBytes) => {
    const root = await workspace()
    const transactionRoot = join(root, TRANSACTION_ROOT)
    const token = "10000000-0000-4000-8000-000000000097"
    const claim = join(transactionRoot, `.identity-capability-${token}.claim`)
    await mkdir(transactionRoot, { recursive: true })
    const key = await internalRecoveryKey(root, true)
    const authentication = createHmac("sha256", key)
      .update("garden-publisher/appearance-transaction/identity-capability/v1\0")
      .update(token)
      .digest("hex")
    const bytes = claimBytes(token, authentication)
    await writeFile(claim, bytes)

    await expectCode(recoverAppearanceTransactionsPublic(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect(await readFile(claim)).toEqual(bytes)
  })

  it.runIf(process.platform !== "win32")(
    "retains an identity claim replaced by a symbolic link",
    async () => {
      const root = await workspace()
      const transactionRoot = join(root, TRANSACTION_ROOT)
      const token = "10000000-0000-4000-8000-000000000095"
      const claim = join(transactionRoot, `.identity-capability-${token}.claim`)
      const foreign = join(root, "foreign-claim")
      await mkdir(transactionRoot, { recursive: true })
      await internalRecoveryKey(root, true)
      await writeFile(foreign, "foreign")
      await symlink(foreign, claim)

      await expectCode(
        recoverAppearanceTransactionsPublic(root),
        "APPEARANCE_TRANSACTION_UNCERTAIN",
      )
      expect((await lstat(claim)).isSymbolicLink()).toBe(true)
      expect(await readFile(foreign, "utf8")).toBe("foreign")
    },
  )

  it.runIf(process.platform === "win32")(
    "retains an identity claim replaced by a junction",
    async () => {
      const root = await workspace()
      const transactionRoot = join(root, TRANSACTION_ROOT)
      const token = "10000000-0000-4000-8000-000000000095"
      const claim = join(transactionRoot, `.identity-capability-${token}.claim`)
      const foreign = join(root, "foreign-claim")
      await mkdir(transactionRoot, { recursive: true })
      await mkdir(foreign)
      await internalRecoveryKey(root, true)
      await writeFile(join(foreign, "evidence"), "foreign")
      await symlink(foreign, claim, "junction")

      await expectCode(
        recoverAppearanceTransactionsPublic(root),
        "APPEARANCE_TRANSACTION_UNCERTAIN",
      )
      expect((await lstat(claim)).isSymbolicLink()).toBe(true)
      expect(await readFile(join(foreign, "evidence"), "utf8")).toBe("foreign")
    },
  )

  it("cleans capability artifacts after an ordinary partial-open failure", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction("identity-capability-open", "after", 0),
      }),
      "APPEARANCE_TRANSACTION_FAILED",
    )

    await expect(recoverAppearanceTransactions(root)).resolves.toEqual([])
    expect(
      (await readdir(join(root, TRANSACTION_ROOT))).filter((name) =>
        name.startsWith(".identity-capability-"),
      ),
    ).toEqual([])
  })

  it("serializes overlapping execute operations and retains one-step undo history", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const gate = deferred()
    const firstVerified = deferred()
    const first = executeAppearancePlanPublic(root, standardPlan(), async () => {
      firstVerified.resolve()
      await gate.promise
    })
    await firstVerified.promise
    let secondVerified = false
    const secondPlan: AppearancePlan = {
      ...standardPlan(),
      writes: standardPlan().writes.map((write) =>
        write.path === "quartz.config.yaml"
          ? {
              ...write,
              expectedHash: digest("theme: new\n"),
              bytes: Buffer.from("theme: newest\n"),
            }
          : write.path === "quartz/styles/custom.scss"
            ? { ...write, expectedHash: digest("new css\n"), bytes: Buffer.from("newest css\n") }
            : { ...write, expectedHash: digest("image") },
      ),
    }
    const second = executeAppearancePlanPublic(root, secondPlan, async () => {
      secondVerified = true
    })
    await new Promise((done) => setTimeout(done, 25))
    expect(secondVerified).toBe(false)
    gate.resolve()
    await Promise.all([first, second])
    await undoAppearanceTransactionPublic(root, digest("current"), async () => undefined)
    expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
  })

  it("serializes recovery behind an in-flight execute", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const gate = deferred()
    const entered = deferred()
    const execute = executeAppearancePlanPublic(root, standardPlan(), async () => {
      entered.resolve()
      await gate.promise
    })
    await entered.promise
    let recovered = false
    const recovery = recoverAppearanceTransactionsPublic(root).then((receipts) => {
      recovered = true
      return receipts
    })
    await new Promise((done) => setTimeout(done, 25))
    expect(recovered).toBe(false)
    gate.resolve()
    await execute
    expect(await recovery).toEqual([])
    expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
  })

  it("serializes undo behind an in-flight execute and undoes only the latest change", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await executeAppearancePlanPublic(root, standardPlan(), async () => undefined)
    const gate = deferred()
    const entered = deferred()
    const secondPlan: AppearancePlan = {
      ...standardPlan(),
      writes: standardPlan().writes.map((write) =>
        write.path === "quartz.config.yaml"
          ? {
              ...write,
              expectedHash: digest("theme: new\n"),
              bytes: Buffer.from("theme: newest\n"),
            }
          : write.path === "quartz/styles/custom.scss"
            ? { ...write, expectedHash: digest("new css\n"), bytes: Buffer.from("newest css\n") }
            : { ...write, expectedHash: digest("image") },
      ),
    }
    const execute = executeAppearancePlanPublic(root, secondPlan, async () => {
      entered.resolve()
      await gate.promise
    })
    await entered.promise
    let undone = false
    const undo = undoAppearanceTransactionPublic(
      root,
      digest("current"),
      async () => undefined,
    ).then((receipt) => {
      undone = true
      return receipt
    })
    await new Promise((done) => setTimeout(done, 25))
    expect(undone).toBe(false)
    gate.resolve()
    await execute
    expect((await undo).status).toBe("undone")
    expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
  }, 30_000)

  it("rejects execute reentry from verifyBuild without poisoning the workspace queue", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    let nestedOutcome: string | undefined

    await executeAppearancePlanPublic(root, standardPlan(), async () => {
      nestedOutcome = await Promise.race([
        executeAppearancePlanPublic(root, standardPlan(), async () => undefined).then(
          () => "resolved",
          (error: { code?: string }) => error.code ?? "unknown-error",
        ),
        new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 100)),
      ])
    })

    expect(nestedOutcome).toBe("APPEARANCE_TRANSACTION_FAILED")
    await expect(recoverAppearanceTransactionsPublic(root)).resolves.toEqual([])
  })

  it("rejects recovery reentry from verifyBuild without waiting on itself", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    let nestedOutcome: string | undefined

    await executeAppearancePlanPublic(root, standardPlan(), async () => {
      nestedOutcome = await Promise.race([
        recoverAppearanceTransactionsPublic(root).then(
          () => "resolved",
          (error: { code?: string }) => error.code ?? "unknown-error",
        ),
        new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 100)),
      ])
    })

    expect(nestedOutcome).toBe("APPEARANCE_TRANSACTION_FAILED")
  })

  it("rejects undo reentry from verifyBuild without waiting on itself", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await executeAppearancePlanPublic(root, standardPlan(), async () => undefined)
    let nestedOutcome: string | undefined

    await undoAppearanceTransactionPublic(root, digest("undo-baseline"), async () => {
      nestedOutcome = await Promise.race([
        undoAppearanceTransactionPublic(root, digest("nested-undo"), async () => undefined).then(
          () => "resolved",
          (error: { code?: string }) => error.code ?? "unknown-error",
        ),
        new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 100)),
      ])
    })

    expect(nestedOutcome).toBe("APPEARANCE_TRANSACTION_FAILED")
  })

  it("allows verifyBuild to operate on a different canonical workspace", async () => {
    const first = await workspace()
    const second = await workspace()
    await mkdir(join(first, "quartz", "static"), { recursive: true })
    await mkdir(join(second, "quartz", "static"), { recursive: true })

    await executeAppearancePlanPublic(first, standardPlan(), async () => {
      await executeAppearancePlanPublic(second, standardPlan(), async () => undefined)
    })

    expect(await readFile(join(first, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
    expect(await readFile(join(second, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
  })

  it("allows a detached verifyBuild resource to use the workspace after its operation completes", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const gate = deferred()
    let detached!: Promise<string>

    await executeAppearancePlanPublic(root, standardPlan(), async () => {
      detached = (async () => {
        await gate.promise
        return recoverAppearanceTransactionsPublic(root).then(
          () => "resolved",
          (error: { code?: string }) => error.code ?? "unknown-error",
        )
      })()
    })
    gate.resolve()

    await expect(detached).resolves.toBe("resolved")
  })

  it("rejects a detached verifyBuild resource while its operation token remains active", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const gate = deferred()
    let detached!: Promise<string>

    await executeAppearancePlanPublic(root, standardPlan(), async () => {
      detached = (async () => {
        await gate.promise
        return recoverAppearanceTransactionsPublic(root).then(
          () => "resolved",
          (error: { code?: string }) => error.code ?? "unknown-error",
        )
      })()
      gate.resolve()
      await expect(
        Promise.race([
          detached,
          new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 100)),
        ]),
      ).resolves.toBe("APPEARANCE_TRANSACTION_FAILED")
    })
  })

  it("deactivates a detached operation token when verifyBuild throws", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const gate = deferred()
    let detached!: Promise<string>

    await expectCode(
      executeAppearancePlanPublic(root, standardPlan(), async () => {
        detached = (async () => {
          await gate.promise
          return recoverAppearanceTransactionsPublic(root).then(
            () => "resolved",
            (error: { code?: string }) => error.code ?? "unknown-error",
          )
        })()
        throw new Error("verify failed")
      }),
      "APPEARANCE_TRANSACTION_FAILED",
    )
    gate.resolve()

    await expect(detached).resolves.toBe("resolved")
  })

  it("keeps a 128-entry transaction and its recovery cleanup comfortably bounded", async () => {
    const root = await workspace()
    const directory = join(root, "content", "benchmark")
    await mkdir(directory, { recursive: true })
    const writes: Array<AppearancePlan["writes"][number]> = []
    for (let index = 0; index < 128; index += 1) {
      const name = `${index.toString().padStart(3, "0")}.md`
      const before = `before ${index}\n`
      await writeFile(join(directory, name), before)
      writes.push({
        path: `content/benchmark/${name}`,
        expectedHash: digest(before),
        bytes: Buffer.from(`after ${index}\n`),
      })
    }
    const plan: AppearancePlan = {
      baselineHash: digest("benchmark-baseline"),
      settings: {} as AppearancePlan["settings"],
      writes,
      deletes: [],
    }
    const stop = new Error("retain verified benchmark") as Error & { simulateCrash?: boolean }
    stop.simulateCrash = true
    let journalFsyncs = 0
    const executeStarted = performance.now()
    await expect(
      executeAppearancePlan(root, plan, async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === "journal-file-fsync") journalFsyncs += 1
          if (operation.kind === "history-promote") throw stop
        },
      }),
    ).rejects.toThrow("retain verified benchmark")
    const executeMs = performance.now() - executeStarted
    const transactionRoot = join(root, TRANSACTION_ROOT)
    const active = join(transactionRoot, await activeTransactionName(transactionRoot))
    const journalNames = (await readdir(active)).filter((name) =>
      /^journal\.\d{8}\.json$/.test(name),
    )
    const journalRevisions = journalNames.length
    const journalBytes = (
      await Promise.all(journalNames.map((name) => readFile(join(active, name))))
    ).reduce((total, bytes) => total + bytes.length, 0)

    await expect(
      recoverAppearanceTransactions(root, undefined, {
        filesystem: failInstruction("cleanup-marker-link", "after", 0, true),
      }),
    ).rejects.toThrow("injected cleanup-marker-link")
    const cleanupMarkers = (
      await readdir(join(root, ".garden-publisher"), {
        recursive: true,
      })
    ).filter((name) => String(name).endsWith("cleanup.json"))
    expect(cleanupMarkers.length).toBeGreaterThan(0)
    const cleanupBytes = await Promise.all(
      cleanupMarkers.map((name) => readFile(join(root, ".garden-publisher", String(name)))),
    )
    const cleanupEntries = cleanupBytes.reduce((total, bytes) => {
      const parsed = JSON.parse(bytes.toString()) as { cleanup: { entries: unknown[] } }
      return total + parsed.cleanup.entries.length
    }, 0)
    const cleanupManifestBytes = cleanupBytes.reduce((total, bytes) => total + bytes.length, 0)
    const recoveryStarted = performance.now()
    await recoverAppearanceTransactions(root)
    const recoveryMs = performance.now() - recoveryStarted

    console.info("appearance-transaction-128", {
      executeMs: Math.round(executeMs),
      journalRevisions,
      journalFsyncs,
      journalBytes,
      cleanupEntries,
      cleanupManifestBytes,
      recoveryMs: Math.round(recoveryMs),
    })
    expect(journalRevisions).toBe(2 * writes.length + 4)
    expect(journalFsyncs).toBe(journalRevisions)
    expect(journalBytes).toBeLessThan(32 * 1_024 * 1_024)
    expect(cleanupEntries).toBe(journalRevisions + 2 * writes.length + 5)
    expect(cleanupManifestBytes).toBeLessThan(512 * 1_024)
    expect(executeMs).toBeLessThan(120_000)
    expect(recoveryMs).toBeLessThan(120_000)
  }, 300_000)

  it.each([
    ["one non-positive identity", 0n, 1n],
    ["one shared positive identity", 1n, 1n],
  ] as const)(
    "fails before target mutation when distinct files report %s",
    async (_label, dev, ino) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      const filesystem: NonNullable<TestOptions["filesystem"]> = {
        async run<T>(instruction: string, operation: () => Promise<T>): Promise<T> {
          const result = await operation()
          if (instruction !== "identity-capability-open" || typeof result !== "object")
            return result
          const handle = result as object
          return new Proxy(handle, {
            get(target, property) {
              if (property === "stat")
                return async (...args: unknown[]) => {
                  const stat = await Reflect.apply(
                    Reflect.get(target, property) as (...values: unknown[]) => unknown,
                    target,
                    args,
                  )
                  return new Proxy(stat as object, {
                    get(details, field) {
                      if (field === "dev") return dev
                      if (field === "ino") return ino
                      const value = Reflect.get(details, field)
                      return typeof value === "function" ? value.bind(details) : value
                    },
                  })
                }
              const value = Reflect.get(target, property)
              return typeof value === "function" ? value.bind(target) : value
            },
          }) as T
        },
      }

      await expectCode(
        executeAppearancePlan(root, standardPlan(), async () => undefined, { filesystem }),
        "APPEARANCE_TRANSACTION_FAILED",
      )
      await assertOriginal(root)
    },
  )

  it("routes every mutating filesystem primitive through the internal durability port", async () => {
    const observed = new Set<string>()
    const primitiveEvents: TestFsEvent[] = []
    const filesystem: NonNullable<TestOptions["filesystem"]> = {
      async run<T>(
        instruction: string,
        operation: () => Promise<T>,
        event?: TestFsEvent,
      ): Promise<T> {
        observed.add(instruction)
        if (instruction.startsWith("fs-")) {
          expect(event).toBeDefined()
          primitiveEvents.push(event!)
        }
        return operation()
      },
    }
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await executeAppearancePlan(root, standardPlan(), async () => undefined, { filesystem })
    await undoAppearanceTransaction(root, digest("current"), async () => undefined, {
      filesystem,
      readBaselineHash: async () => digest("current"),
    })
    const recoveryRoot = await workspace()
    await mkdir(join(recoveryRoot, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(recoveryRoot, standardPlan(), async () => undefined, {
        filesystem,
        beforeOperation: async (operation) => {
          if (operation.kind !== "replace") return
          const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
          error.simulateCrash = true
          throw error
        },
      }),
    ).rejects.toThrow("simulated crash")
    await recoverAppearanceTransactions(recoveryRoot, undefined, { filesystem })

    expect([...observed]).toEqual(
      expect.arrayContaining([
        "fs-open",
        "fs-write",
        "fs-fsync",
        "fs-mkdir",
        "fs-link",
        "fs-unlink",
        "fs-rmdir",
      ]),
    )
    expect(primitiveEvents.length).toBeGreaterThan(0)
    expect(primitiveEvents.every((event) => event.pathRole !== undefined)).toBe(true)
    expect(primitiveEvents.every((event) => event.transactionPhase !== undefined)).toBe(true)
    expect(
      primitiveEvents
        .filter(
          (event) =>
            ["fs-write", "fs-link", "fs-unlink"].includes(event.instruction) &&
            [
              "target",
              "publish-temp",
              "backup-evidence",
              "staged-evidence",
              "installed-evidence",
              "quarantine-evidence",
              "history-evidence",
            ].includes(event.pathRole ?? ""),
        )
        .every((event) => event.fileIndex !== undefined),
    ).toBe(true)
    for (const instruction of new Set(primitiveEvents.map((event) => event.instruction))) {
      const ordinals = primitiveEvents
        .filter((event) => event.instruction === instruction)
        .map((event) => event.ordinal)
      expect(
        ordinals.every((ordinal, index) =>
          index === 0 || ordinal === 0 ? ordinal === 0 : ordinal === ordinals[index - 1]! + 1,
        ),
      ).toBe(true)
    }
  })

  it("replays exact observed primitive boundaries for representative transaction flows", async () => {
    const plan: AppearancePlan = {
      baselineHash: digest("matrix"),
      settings: {} as AppearancePlan["settings"],
      writes: [
        {
          path: "quartz.config.yaml",
          expectedHash: digest("theme: old\n"),
          bytes: Buffer.from("theme: new\n"),
        },
      ],
      deletes: [],
    }
    const nextPlan: AppearancePlan = {
      ...plan,
      baselineHash: digest("matrix-next"),
      writes: [
        {
          path: "quartz.config.yaml",
          expectedHash: digest("theme: new\n"),
          bytes: Buffer.from("theme: next\n"),
        },
      ],
    }
    type MatrixScenario = {
      readonly name: string
      readonly prepare: (root: string) => Promise<void>
      readonly run: (
        root: string,
        filesystem: NonNullable<TestOptions["filesystem"]>,
      ) => Promise<unknown>
      readonly allowed: readonly string[]
    }
    const crashAt = (kind: string) => async (operation: TestOperation) => {
      if (operation.kind !== kind) return
      const error = new Error(`matrix ${kind}`) as Error & { simulateCrash?: boolean }
      error.simulateCrash = true
      throw error
    }
    const scenarios: readonly MatrixScenario[] = [
      {
        name: "apply-rollback-cleanup",
        prepare: async () => undefined,
        run: (root, filesystem) =>
          executeAppearancePlan(
            root,
            plan,
            async () => {
              throw new Error("build")
            },
            { filesystem },
          ),
        allowed: ["theme: old\n", "theme: new\n"],
      },
      {
        name: "apply-verify-history",
        prepare: async (root) => {
          await executeAppearancePlan(root, plan, async () => undefined)
        },
        run: (root, filesystem) =>
          executeAppearancePlan(root, nextPlan, async () => undefined, { filesystem }),
        allowed: ["theme: new\n", "theme: next\n"],
      },
      {
        name: "undo",
        prepare: async (root) => {
          await executeAppearancePlan(root, plan, async () => undefined)
        },
        run: (root, filesystem) =>
          undoAppearanceTransaction(root, digest("undo"), async () => undefined, {
            filesystem,
            readBaselineHash: async () => digest("undo"),
          }),
        allowed: ["theme: old\n", "theme: new\n"],
      },
      ...(["replace", "verify", "history-promote"] as const).map((boundary): MatrixScenario => ({
        name: `${boundary}-recovery`,
        prepare: async (root) => {
          await expect(
            executeAppearancePlan(root, plan, async () => undefined, {
              beforeOperation: crashAt(boundary),
            }),
          ).rejects.toThrow(`matrix ${boundary}`)
        },
        run: (root, filesystem) =>
          recoverAppearanceTransactions(
            root,
            boundary === "verify" ? async () => undefined : undefined,
            { filesystem },
          ),
        allowed: boundary === "replace" ? ["theme: old\n"] : ["theme: new\n", "theme: old\n"],
      })),
    ]
    const discardWorkspace = async (root: string) => {
      const index = roots.indexOf(root)
      if (index >= 0) roots.splice(index, 1)
      await rm(root, { recursive: true, force: true })
    }

    const semanticTuples = new Set<string>()
    const boundaryEvents = new Map<
      string,
      {
        readonly scenario: MatrixScenario
        readonly event: TestFsEvent
        readonly timings: Set<"before" | "after">
      }
    >()
    for (const scenario of scenarios) {
      const observed = new Map<
        string,
        { readonly event: TestFsEvent; readonly timings: Set<"before" | "after"> }
      >()
      const capture: NonNullable<TestOptions["filesystem"]> = {
        async run<T>(instruction: string, operation: () => Promise<T>, event?: TestFsEvent) {
          let key: string | undefined
          if (
            instruction.startsWith("fs-") ||
            instruction === "directory-barrier" ||
            instruction === "identity-probe-link" ||
            instruction === "identity-probe-unlink"
          ) {
            key = JSON.stringify([
              event!.instruction,
              event!.ordinal,
              event!.pathRole,
              event!.fileIndex ?? null,
              event!.transactionPhase,
            ])
            observed.set(key, { event: { ...event! }, timings: new Set(["before"]) })
          }
          const result = await operation()
          if (key !== undefined) observed.get(key)!.timings.add("after")
          return result
        },
      }
      const captureRoot = await workspace()
      await mkdir(join(captureRoot, "quartz", "static"), { recursive: true })
      await scenario.prepare(captureRoot)
      await scenario.run(captureRoot, capture).catch(() => undefined)
      expect(observed.size, scenario.name).toBeGreaterThan(0)
      expect(
        [...observed.values()].every(
          ({ event }) => event.pathRole !== undefined && event.transactionPhase !== undefined,
        ),
        scenario.name,
      ).toBe(true)
      for (const { event, timings } of observed.values()) {
        for (const timing of timings) {
          const hit = { count: 0 }
          await expect(
            failFsEvent(event, timing, true, hit).run(
              event.instruction,
              async () => undefined,
              event,
            ),
          ).rejects.toThrow(`injected ${event.instruction}`)
          expect(hit.count).toBe(1)
        }
      }
      for (const value of observed.values()) {
        const key = JSON.stringify([
          value.event.instruction,
          value.event.pathRole,
          value.event.fileIndex ?? null,
          value.event.transactionPhase,
        ])
        semanticTuples.add(
          [
            value.event.instruction,
            value.event.pathRole,
            value.event.fileIndex ?? "-",
            value.event.transactionPhase,
          ].join("|"),
        )
        const existing = boundaryEvents.get(key)
        if (existing === undefined) boundaryEvents.set(key, { scenario, ...value })
        else for (const timing of value.timings) existing.timings.add(timing)
      }
      await discardWorkspace(captureRoot)
    }
    for (const { scenario, event, timings } of boundaryEvents.values()) {
      for (const timing of timings) {
        const root = await workspace()
        await mkdir(join(root, "quartz", "static"), { recursive: true })
        await scenario.prepare(root)
        const hit = { count: 0 }
        let caught: unknown
        try {
          await scenario.run(root, failFsEvent(event, timing, true, hit))
        } catch (error) {
          caught = error
        }
        expect(hit.count, `${scenario.name} did not reach ${JSON.stringify(event)} ${timing}`).toBe(
          1,
        )
        const current = await readFile(join(root, "quartz.config.yaml"), "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null
            throw error
          },
        )
        expect(await readFile(join(root, "content", "untouched.md"))).toEqual(
          Buffer.from([0, 1, 2, 255]),
        )
        const retained = [
          ...(await readdir(join(root, TRANSACTION_ROOT)).catch(() => [])),
          ...(await readdir(join(root, HISTORY_ROOT)).catch(() => [])),
        ]
        if (caught === undefined) {
          expect(scenario.allowed, `${scenario.name} ${JSON.stringify(event)} ${timing}`).toContain(
            current,
          )
          await discardWorkspace(root)
          continue
        }
        if (current === null) {
          expect(retained.length).toBeGreaterThan(0)
          await discardWorkspace(root)
          continue
        }
        if (
          typeof caught === "object" &&
          caught !== null &&
          "code" in caught &&
          caught.code === "APPEARANCE_TRANSACTION_UNCERTAIN"
        ) {
          expect(retained.length).toBeGreaterThan(0)
        }
        expect(scenario.allowed, `${scenario.name} ${JSON.stringify(event)} ${timing}`).toContain(
          current,
        )
        await discardWorkspace(root)
      }
    }
    expect([...semanticTuples]).toEqual(
      expect.arrayContaining([
        "fs-fsync|staged-evidence|0|prepared",
        "fs-fsync|backup-evidence|0|prepared",
        "fs-fsync|publish-temp|0|prepared",
        "fs-fsync|target|0|prepared",
        "directory-barrier|quarantine-evidence|0|prepared",
        "fs-fsync|journal-temp|-|prepared",
        "fs-fsync|cleanup-claim|-|cleanup",
        "fs-rmdir|cleanup-root|-|cleanup",
        "fs-link|history-evidence|0|verified",
        "fs-fsync|history-claim|-|verified",
        "fs-open|journal|-|recovery",
        "fs-open|target|0|bootstrap",
        "fs-open|target|0|prepared",
        "fs-fsync|identity-capability-claim|-|bootstrap",
        "fs-link|identity-capability|-|bootstrap",
        "fs-unlink|identity-capability|-|recovery",
      ]),
    )
  }, 600_000)

  it("commits deterministic writes and deletes and preserves unrelated bytes", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await writeFile(join(root, "quartz", "static", "obsolete.png"), "obsolete")
    const untouched = await readFile(join(root, "content", "untouched.md"))
    const plan = {
      ...standardPlan(),
      deletes: [{ path: "quartz/static/obsolete.png", expectedHash: digest("obsolete") }],
    }

    const receipt = await executeAppearancePlan(root, plan, async () => undefined, {
      createId: () => "10000000-0000-4000-8000-000000000001",
      readBaselineHash: async () => plan.baselineHash,
    })

    expect(receipt).toEqual({
      id: "10000000-0000-4000-8000-000000000001",
      status: "verified",
      canUndo: true,
    })
    expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
    expect(await readFile(join(root, "quartz", "styles", "custom.scss"), "utf8")).toBe("new css\n")
    expect(await readFile(join(root, "quartz", "static", "appearance.png"), "utf8")).toBe("image")
    await expect(lstat(join(root, "quartz", "static", "obsolete.png"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await readFile(join(root, "content", "untouched.md"))).toEqual(untouched)
    expect(await readdir(join(root, HISTORY_ROOT))).toEqual(["current"])
  })

  it("rejects expected-hash, baseline, and new-file collisions before mutation", async () => {
    for (const mode of ["hash", "baseline", "collision"] as const) {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      let plan = standardPlan()
      if (mode === "hash")
        plan = { ...plan, writes: [{ ...plan.writes[0]!, expectedHash: digest("stale") }] }
      if (mode === "collision")
        await writeFile(join(root, "quartz", "static", "appearance.png"), "foreign")
      await expectCode(
        executeAppearancePlan(root, plan, async () => undefined, {
          readBaselineHash: async () => (mode === "baseline" ? digest("stale") : plan.baselineHash),
        }),
        "APPEARANCE_CONFLICT",
      )
      expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: old\n")
    }
  })

  it("rejects root escapes, target symlinks, symlink parents, and unsafe ids", async () => {
    const outside = await workspace()
    for (const mode of ["escape", "target", "parent", "state", "id"] as const) {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      let plan = standardPlan()
      if (mode === "escape")
        plan = {
          ...plan,
          writes: [{ path: "../escape", expectedHash: null, bytes: Buffer.from("x") }],
        }
      if (mode === "target") {
        await mkdir(join(outside, "target"))
        await rm(join(root, "quartz", "styles", "custom.scss"))
        await symlink(
          join(outside, "target"),
          join(root, "quartz", "styles", "custom.scss"),
          "junction",
        )
      }
      if (mode === "parent") {
        await rm(join(root, "quartz", "static"), { recursive: true })
        await symlink(outside, join(root, "quartz", "static"), "junction")
      }
      if (mode === "state") {
        await symlink(outside, join(root, ".garden-publisher"), "junction")
      }
      await expectCode(
        executeAppearancePlan(root, plan, async () => undefined, {
          createId: () => (mode === "id" ? "../unsafe" : randomUUID()),
        }),
        mode === "id" || mode === "state" ? "APPEARANCE_TRANSACTION_FAILED" : "APPEARANCE_CONFLICT",
      )
      if (mode === "state") {
        await expect(lstat(join(outside, "appearance-transactions"))).rejects.toMatchObject({
          code: "ENOENT",
        })
      }
    }
  })

  it.each([
    "quartz.config.yaml:stream",
    "CON.txt",
    "CONIN$",
    "CONOUT$.txt",
    "CLOCK$",
    "COM¹.log",
    "LPT³.txt",
    "quartz/aux.scss",
    "quartz/styles/custom.scss. ",
    "quartz//styles/custom.scss",
    "quartz/./styles/custom.scss",
    "quartz\\styles\\custom.scss",
    "C:/quartz.config.yaml",
    "//server/share/file",
    "quartz/styles/control\u0001.scss",
  ])("rejects Windows path alias %j", async (path) => {
    const root = await workspace()
    const plan: AppearancePlan = {
      ...standardPlan(),
      writes: [{ path, expectedHash: null, bytes: Buffer.from("x") }],
    }
    await expectCode(
      executeAppearancePlan(root, plan, async () => undefined),
      "APPEARANCE_CONFLICT",
    )
    await assertOriginal(root)
  })

  it("accepts a write at the documented single-file byte limit", async () => {
    const root = await workspace()
    const bytes = Buffer.alloc(16 * 1024 * 1024, 0x61)
    const plan: AppearancePlan = {
      baselineHash: digest("size-boundary"),
      settings: {} as AppearancePlan["settings"],
      writes: [{ path: "content/boundary.bin", expectedHash: null, bytes }],
      deletes: [],
    }

    await expect(
      executeAppearancePlanPublic(root, plan, async () => undefined),
    ).resolves.toMatchObject({ status: "verified" })
    expect((await lstat(join(root, "content", "boundary.bin"), { bigint: true })).size).toBe(
      BigInt(bytes.length),
    )
  }, 30_000)

  it("rejects oversized new bytes before creating transaction state", async () => {
    const root = await workspace()
    const plan: AppearancePlan = {
      baselineHash: digest("oversized-new"),
      settings: {} as AppearancePlan["settings"],
      writes: [
        {
          path: "content/oversized.bin",
          expectedHash: null,
          bytes: Buffer.alloc(16 * 1024 * 1024 + 1),
        },
      ],
      deletes: [],
    }

    await expectCode(
      executeAppearancePlanPublic(root, plan, async () => undefined),
      "APPEARANCE_CONFLICT",
    )
    await expect(lstat(join(root, ".garden-publisher"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects an oversized existing target before creating transaction state", async () => {
    const root = await workspace()
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0x62)
    await writeFile(join(root, "content", "oversized-existing.bin"), bytes)
    const plan: AppearancePlan = {
      baselineHash: digest("oversized-existing"),
      settings: {} as AppearancePlan["settings"],
      writes: [],
      deletes: [{ path: "content/oversized-existing.bin", expectedHash: digest(bytes) }],
    }

    await expectCode(
      executeAppearancePlanPublic(root, plan, async () => undefined),
      "APPEARANCE_CONFLICT",
    )
    await expect(lstat(join(root, ".garden-publisher"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects a plan over the documented aggregate byte limit without state changes", async () => {
    const root = await workspace()
    const bytes = Buffer.alloc(16 * 1024 * 1024)
    const plan: AppearancePlan = {
      baselineHash: digest("oversized-total"),
      settings: {} as AppearancePlan["settings"],
      writes: Array.from({ length: 5 }, (_, index) => ({
        path: `content/aggregate-${index}.bin`,
        expectedHash: null,
        bytes,
      })),
      deletes: [],
    }

    await expectCode(
      executeAppearancePlanPublic(root, plan, async () => undefined),
      "APPEARANCE_CONFLICT",
    )
    await expect(lstat(join(root, ".garden-publisher"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("accepts a plan at the documented aggregate byte limit", async () => {
    const root = await workspace()
    const bytes = Buffer.alloc(16 * 1024 * 1024, 0x63)
    const plan: AppearancePlan = {
      baselineHash: digest("aggregate-boundary"),
      settings: {} as AppearancePlan["settings"],
      writes: Array.from({ length: 4 }, (_, index) => ({
        path: `content/boundary-${index}.bin`,
        expectedHash: null,
        bytes,
      })),
      deletes: [],
    }

    await expect(
      executeAppearancePlanPublic(root, plan, async () => undefined),
    ).resolves.toMatchObject({ status: "verified" })
  }, 60_000)

  it("bounds a target that grows after the prepared-state stat without reading it in full", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const observation = { readFileCalled: false }

    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: growTargetAfterOpenedStat(
          join(root, "quartz.config.yaml"),
          "prepared",
          observation,
        ),
      }),
      "APPEARANCE_CONFLICT",
    )

    expect(observation.readFileCalled).toBe(false)
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
  })

  it("bounds a target that grows during rollback and retains recovery evidence", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const observation = { readFileCalled: false }

    await expectCode(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("verification failed")
        },
        {
          filesystem: growTargetAfterOpenedStat(
            join(root, "quartz.config.yaml"),
            "published",
            observation,
          ),
        },
      ),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )

    expect(observation.readFileCalled).toBe(false)
    expect((await readdir(join(root, TRANSACTION_ROOT))).length).toBeGreaterThan(0)
  })

  it("bounds a target that grows during recovery and retains authenticated evidence", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const crash = new Error("simulated recovery crash") as Error & { simulateCrash?: boolean }
    crash.simulateCrash = true
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === "verify") throw crash
        },
      }),
    ).rejects.toThrow("simulated recovery crash")
    const observation = { readFileCalled: false }

    await expectCode(
      recoverAppearanceTransactions(root, undefined, {
        filesystem: growTargetAfterOpenedStat(
          join(root, "quartz.config.yaml"),
          "published",
          observation,
        ),
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )

    expect(observation.readFileCalled).toBe(false)
    expect((await readdir(join(root, TRANSACTION_ROOT))).length).toBeGreaterThan(0)
  })

  it("fails before mutation when transaction-root fsync fails", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction("transaction-root-fsync"),
      }),
      "APPEARANCE_TRANSACTION_FAILED",
    )
    await assertOriginal(root)
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
  })

  it("does not claim an unauthenticated foreign empty transaction directory", async () => {
    const root = await workspace()
    const foreign = join(root, TRANSACTION_ROOT, "10000000-0000-4000-8000-000000000099")
    await mkdir(foreign, { recursive: true })

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(foreign)).isDirectory()).toBe(true)
  })

  it("does not claim a replaced pre-journal transaction directory", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction("transaction-directory-mkdir", "after", 0, true),
      }),
    ).rejects.toThrow("injected transaction-directory-mkdir")

    const transactionRoot = join(root, TRANSACTION_ROOT)
    const [id] = await readdir(transactionRoot)
    const directory = join(transactionRoot, id!)
    await rename(directory, `${directory}.original`)
    await mkdir(directory)
    const foreignInode = (await lstat(directory, { bigint: true })).ino

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(directory, { bigint: true })).ino).toBe(foreignInode)
    expect(await readdir(directory)).toEqual([])
  })

  it.each([
    ["journal-temp-open", "before"],
    ["journal-temp-write", "after"],
    ["journal-temp-fsync", "after"],
    ["journal-rename", "after"],
  ] as const)("recovers a crash at the first journal %s boundary", async (instruction, timing) => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction(instruction, timing, 0, true),
      }),
    ).rejects.toThrow(`injected ${instruction}`)

    await recoverAppearanceTransactions(root)
    await assertOriginal(root)
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
  })

  it.each([
    ["evidence-open", "before", 0],
    ["evidence-write", "after", 0],
    ["evidence-fsync", "after", 0],
    ["evidence-fsync", "after", 4],
  ] as const)(
    "recovers a crash at the real %s filesystem boundary",
    async (instruction, timing, ordinal) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expect(
        executeAppearancePlan(root, standardPlan(), async () => undefined, {
          filesystem: failInstruction(instruction, timing, ordinal, true),
        }),
      ).rejects.toThrow(`injected ${instruction}`)

      await recoverAppearanceTransactions(root)
      await assertOriginal(root)
      const transactionRoot = join(root, TRANSACTION_ROOT)
      expect(await readdir(transactionRoot).catch(() => [])).toEqual([])
    },
  )

  it.each([
    ["transaction-directory-mkdir", 0],
    ["evidence-directory-mkdir", 0],
    ["evidence-directory-mkdir", 3],
  ] as const)(
    "retains unauthenticated evidence after a crash at the real %s boundary",
    async (instruction, ordinal) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expect(
        executeAppearancePlan(root, standardPlan(), async () => undefined, {
          filesystem: failInstruction(instruction, "after", ordinal, true),
        }),
      ).rejects.toThrow(`injected ${instruction}`)

      await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
      await assertOriginal(root)
      expect((await readdir(join(root, TRANSACTION_ROOT))).length).toBe(1)
    },
  )

  it.each([
    "quarantine-rename",
    "quarantine-fsync",
    "target-parent-after-quarantine-fsync",
    "installed-evidence-link",
    "installed-evidence-fsync",
    "install-link",
    "install-file-fsync",
    "install-parent-fsync",
    "quarantine-unlink",
  ])("recovers a real crash after %s", async (instruction) => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction(instruction, "after", 0, true),
      }),
    ).rejects.toThrow(`injected ${instruction}`)

    await recoverAppearanceTransactions(root)
    await assertOriginal(root)
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
  })

  it.each(["publish-temp-open", "publish-temp-write", "publish-temp-fsync"])(
    "recovers a real crash after %s without unauthenticated publish evidence",
    async (instruction) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expect(
        executeAppearancePlan(root, standardPlan(), async () => undefined, {
          filesystem: failInstruction(instruction, "after", 0, true),
        }),
      ).rejects.toThrow(`injected ${instruction}`)

      await recoverAppearanceTransactions(root)
      await assertOriginal(root)
      await assertNoPublishTemps(root)
      expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
    },
  )

  it("rejects case-insensitive duplicate target aliases", async () => {
    const root = await workspace()
    const plan: AppearancePlan = {
      ...standardPlan(),
      writes: [
        { path: "quartz/New.scss", expectedHash: null, bytes: Buffer.from("a") },
        { path: "QUARTZ/new.scss", expectedHash: null, bytes: Buffer.from("b") },
      ],
    }
    await expectCode(
      executeAppearancePlan(root, plan, async () => undefined),
      "APPEARANCE_CONFLICT",
    )
  })

  it.each([
    ["publish-temp-write", 0],
    ["publish-temp-write", 1],
    ["publish-temp-write", 2],
    ["stage-write", 0],
    ["stage-write", 1],
    ["stage-write", 2],
    ["stage-fsync", 0],
    ["stage-fsync", 1],
    ["stage-fsync", 2],
    ["backup-write", 0],
    ["backup-write", 1],
    ["backup-fsync", 0],
    ["backup-fsync", 1],
    ["publish-file-fsync", 0],
    ["publish-file-fsync", 1],
    ["publish-file-fsync", 2],
  ] as const)("rolls back or cleans evidence after %s failure %i", async (kind, ordinal) => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: failAt(kind, ordinal),
      }),
      "APPEARANCE_TRANSACTION_FAILED",
    )
    await assertOriginal(root)
    await assertNoPublishTemps(root)
  })

  it("retains foreign evidence when the transaction directory is replaced", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const id = "10000000-0000-4000-8000-000000000009"
    const directory = join(root, TRANSACTION_ROOT, id)

    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        createId: () => id,
        beforeOperation: async (operation) => {
          if (operation.kind === "journal-directory-fsync" && operation.revision === 1) {
            await rm(directory, { recursive: true, force: true })
            await mkdir(directory, { recursive: true })
            await writeFile(join(directory, "foreign.txt"), "foreign evidence")
            throw new Error("replaced transaction directory")
          }
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )

    expect(await readFile(join(directory, "foreign.txt"), "utf8")).toBe("foreign evidence")
    await assertOriginal(root)
  })

  it.each([
    ["journal-write", 1],
    ["journal-write", 2],
    ["journal-write", 3],
    ["journal-file-fsync", 1],
    ["journal-file-fsync", 2],
    ["journal-file-fsync", 3],
    ["journal-rename", 1],
    ["journal-rename", 2],
    ["journal-rename", 3],
    ["journal-directory-fsync", 1],
    ["journal-directory-fsync", 2],
    ["journal-directory-fsync", 3],
  ] as const)("fails safely after %s failure at revision %i", async (kind, revision) => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation:
          kind === "journal-write"
            ? async (operation) => {
                if (operation.kind === kind && operation.revision === revision)
                  throw new Error(`injected ${kind} revision ${revision}`)
              }
            : failRevision(kind, revision),
      }),
      revision === 3 ? "APPEARANCE_TRANSACTION_UNCERTAIN" : "APPEARANCE_TRANSACTION_FAILED",
    )
    await assertOriginal(root)
    if (revision === 3)
      expect((await readdir(join(root, TRANSACTION_ROOT))).length).toBeGreaterThan(0)
  })

  it.each([0, 1, 2])("rolls back replacement failure at file index %i", async (index) => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: failAt("replace", index),
      }),
      "APPEARANCE_TRANSACTION_FAILED",
    )
    await assertOriginal(root)
  })

  it("rolls back delete and target-directory fsync failures", async () => {
    for (const kind of ["delete", "publish-directory-fsync"] as const) {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await writeFile(join(root, "quartz", "static", "obsolete.png"), "obsolete")
      const plan = {
        ...standardPlan(),
        deletes: [{ path: "quartz/static/obsolete.png", expectedHash: digest("obsolete") }],
      }
      await expectCode(
        executeAppearancePlan(root, plan, async () => undefined, {
          beforeOperation: failAt(kind, kind === "publish-directory-fsync" ? 3 : 0),
        }),
        "APPEARANCE_TRANSACTION_FAILED",
      )
      expect(await readFile(join(root, "quartz", "static", "obsolete.png"), "utf8")).toBe(
        "obsolete",
      )
      expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: old\n")
    }
  })

  it("never overwrites a target changed at the replacement boundary", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })

    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === "replace" && operation.index === 0)
            await writeFile(join(root, "quartz.config.yaml"), "foreign\n")
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )

    await expectForeignPreserved(root, "quartz.config.yaml")
    expect((await readdir(join(root, TRANSACTION_ROOT))).length).toBe(1)
  })

  it("never deletes a target changed at the deletion boundary", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await writeFile(join(root, "quartz", "static", "obsolete.png"), "obsolete")
    const plan = {
      ...standardPlan(),
      writes: [],
      deletes: [{ path: "quartz/static/obsolete.png", expectedHash: digest("obsolete") }],
    }

    await expectCode(
      executeAppearancePlan(root, plan, async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === "delete")
            await writeFile(join(root, "quartz", "static", "obsolete.png"), "foreign")
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )

    await expectForeignPreserved(root, "quartz/static/obsolete.png")
  })

  it.each(["replace", "delete"] as const)(
    "never destroys a target created after %s quarantine",
    async (kind) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      if (kind === "delete")
        await writeFile(join(root, "quartz", "static", "obsolete.png"), "obsolete")
      const plan: AppearancePlan =
        kind === "replace"
          ? standardPlan()
          : {
              ...standardPlan(),
              writes: [],
              deletes: [{ path: "quartz/static/obsolete.png", expectedHash: digest("obsolete") }],
            }
      await expectCode(
        executeAppearancePlan(root, plan, async () => undefined, {
          beforeOperation: async (operation) => {
            if (operation.kind === "after-quarantine" && operation.index === 0)
              await writeFile(
                kind === "replace"
                  ? join(root, "quartz.config.yaml")
                  : join(root, "quartz", "static", "obsolete.png"),
                kind === "replace" ? "foreign\n" : "foreign",
              )
          },
        }),
        "APPEARANCE_TRANSACTION_UNCERTAIN",
      )
      await expectForeignPreserved(
        root,
        kind === "replace" ? "quartz.config.yaml" : "quartz/static/obsolete.png",
      )
    },
  )

  it("fully rolls back a verifyBuild failure", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => {
        throw new Error("C:\\secret\\build.cmd failed")
      }),
      "APPEARANCE_TRANSACTION_FAILED",
    )
    await assertOriginal(root)
  })

  it("retains authenticated evidence when rollback cannot prove restoration", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expectCode(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        { beforeOperation: failAt("rollback-replace") },
      ),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )
    expect((await readdir(join(root, TRANSACTION_ROOT))).length).toBe(1)
  })

  it("never overwrites a target changed at the rollback boundary", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })

    await expectCode(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        {
          beforeOperation: async (operation) => {
            if (operation.kind === "rollback-replace" && operation.index === 0)
              await writeFile(join(root, "quartz.config.yaml"), "foreign\n")
          },
        },
      ),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )

    await expectForeignPreserved(root, "quartz.config.yaml")
    expect((await readdir(join(root, TRANSACTION_ROOT))).length).toBe(1)
  })

  it.each([
    ["overwritten file", "quartz.config.yaml", "theme: new\n"],
    ["new file", "quartz/static/appearance.png", "image"],
  ] as const)(
    "retains a byte-identical foreign inode during rollback for %s",
    async (_label, path, bytes) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      let foreignInode = 0n
      await expectCode(
        executeAppearancePlan(
          root,
          standardPlan(),
          async () => {
            throw new Error("build")
          },
          {
            beforeOperation: async (operation) => {
              if (operation.kind !== "verify") return
              const target = join(root, ...path.split("/"))
              const foreign = `${target}.foreign`
              await mkdir(join(target, ".."), { recursive: true })
              await writeFile(foreign, bytes)
              foreignInode = (await lstat(foreign, { bigint: true })).ino
              await rename(foreign, target)
            },
          },
        ),
        "APPEARANCE_TRANSACTION_UNCERTAIN",
      )
      expect((await lstat(join(root, ...path.split("/")), { bigint: true })).ino).toBe(foreignInode)
      expect(await readFile(join(root, ...path.split("/")), "utf8")).toBe(bytes)
    },
  )

  it("retains a byte-identical foreign inode during recovery", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    let foreignInode = 0n
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind !== "verify") return
          const target = join(root, "quartz.config.yaml")
          const foreign = `${target}.foreign`
          await writeFile(foreign, "theme: new\n")
          foreignInode = (await lstat(foreign, { bigint: true })).ino
          await rename(foreign, target)
          const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
          error.simulateCrash = true
          throw error
        },
      }),
    ).rejects.toThrow("simulated crash")

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(join(root, "quartz.config.yaml"), { bigint: true })).ino).toBe(foreignInode)
  })

  it("rejects a byte-identical foreign staged inode after restart", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind !== "replace" || operation.index !== 0) return
          const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
          error.simulateCrash = true
          throw error
        },
      }),
    ).rejects.toThrow("simulated crash")

    const transactionRoot = join(root, TRANSACTION_ROOT)
    const [id] = await readdir(transactionRoot)
    const staged = join(transactionRoot, id!, "staged", "00000000.bin")
    const foreign = `${staged}.foreign`
    const bytes = await readFile(staged)
    await writeFile(foreign, bytes)
    const foreignInode = (await lstat(foreign, { bigint: true })).ino
    await rename(foreign, staged)

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(staged, { bigint: true })).ino).toBe(foreignInode)
    expect(await readFile(staged)).toEqual(bytes)
    expect(await readdir(transactionRoot)).toEqual([id])
  })

  it("retains a byte-identical foreign installed inode during live rollback", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    let installed = ""
    let foreignInode = 0n

    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind !== "publish-temp-write" || operation.index !== 0) return
          const [id] = await readdir(join(root, TRANSACTION_ROOT))
          installed = join(root, TRANSACTION_ROOT, id!, "installed", "00000000.bin")
          const replacement = `${installed}.foreign`
          await writeFile(replacement, await readFile(installed))
          foreignInode = (await lstat(replacement, { bigint: true })).ino
          await rename(replacement, installed)
          throw new Error("abort after foreign installed replacement")
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )

    expect((await lstat(installed, { bigint: true })).ino).toBe(foreignInode)
    expect(await readFile(installed, "utf8")).toBe("theme: new\n")
    expect((await readdir(join(root, TRANSACTION_ROOT))).length).toBe(1)
    await assertOriginal(root)
  })

  it("retains a byte-identical foreign latest journal inode after restart", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind !== "verify") return
          const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
          error.simulateCrash = true
          throw error
        },
      }),
    ).rejects.toThrow("simulated crash")

    const transactionRoot = join(root, TRANSACTION_ROOT)
    const [id] = await readdir(transactionRoot)
    const directory = join(transactionRoot, id!)
    const journalName = (await readdir(directory))
      .filter((name) => /^journal\.\d+\.json$/.test(name))
      .sort()
      .at(-1)!
    const journal = join(directory, journalName)
    const replacement = `${journal}.foreign`
    const bytes = await readFile(journal)
    await writeFile(replacement, bytes)
    const foreignInode = (await lstat(replacement, { bigint: true })).ino
    await rename(replacement, journal)

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(journal, { bigint: true })).ino).toBe(foreignInode)
    expect(await readFile(journal)).toEqual(bytes)
    expect(await readdir(transactionRoot)).toEqual([id])
  })

  it("does not install a byte-identical foreign quarantine inode during recovery", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind !== "after-quarantine" || operation.index !== 0) return
          const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
          error.simulateCrash = true
          throw error
        },
      }),
    ).rejects.toThrow("simulated crash")

    const transactionRoot = join(root, TRANSACTION_ROOT)
    const [id] = await readdir(transactionRoot)
    const quarantine = join(transactionRoot, id!, "quarantine", "00000000.bin")
    const replacement = `${quarantine}.foreign`
    const bytes = await readFile(quarantine)
    await writeFile(replacement, bytes)
    const foreignInode = (await lstat(replacement, { bigint: true })).ino
    await rename(replacement, quarantine)

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(quarantine, { bigint: true })).ino).toBe(foreignInode)
    expect(await readFile(quarantine)).toEqual(bytes)
    await expect(lstat(join(root, "quartz.config.yaml"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(transactionRoot)).toEqual([id])
  })

  it("recovers prepared, published, verified, and exact partial journals", async () => {
    for (const phase of ["prepared", "published", "verified", "partial"] as const) {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      const plan = standardPlan()
      const stop =
        phase === "prepared"
          ? "replace"
          : phase === "partial"
            ? "replace"
            : phase === "published"
              ? "verify"
              : "history-promote"
      await expect(
        executeAppearancePlan(
          root,
          plan,
          async () => {
            if (stop === "verify") throw new Error("crash")
          },
          {
            beforeOperation: async (operation) => {
              if (
                operation.kind === stop ||
                (phase === "partial" && operation.kind === "replace" && operation.index === 1)
              ) {
                const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
                error.simulateCrash = true
                throw error
              }
            },
          },
        ),
      ).rejects.toThrow("simulated crash")

      const receipts = await recoverAppearanceTransactions(
        root,
        phase === "published" ? async () => undefined : undefined,
      )
      if (phase === "verified" || phase === "published") {
        expect(receipts[0]?.canUndo).toBe(true)
        expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
      } else {
        await assertOriginal(root)
      }
    }
  }, 10_000)

  it("conservatively rolls back a published journal without a verifier", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === "verify") {
            const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
            error.simulateCrash = true
            throw error
          }
        },
      }),
    ).rejects.toThrow("simulated crash")

    const receipts = await recoverAppearanceTransactions(root)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.canUndo).toBe(false)
    await assertOriginal(root)
  })

  it.each([
    ["replacement quarantined", "after-quarantine", false],
    ["replacement installed", "after-install", false],
    ["deletion quarantined", "after-quarantine", true],
  ] as const)("recovers a prepared crash after %s", async (_label, boundary, deletion) => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    if (deletion) await writeFile(join(root, "quartz", "static", "obsolete.png"), "obsolete")
    const plan: AppearancePlan = deletion
      ? {
          ...standardPlan(),
          writes: [],
          deletes: [{ path: "quartz/static/obsolete.png", expectedHash: digest("obsolete") }],
        }
      : standardPlan()

    await expect(
      executeAppearancePlan(root, plan, async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === boundary && operation.index === 0) {
            const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
            error.simulateCrash = true
            throw error
          }
        },
      }),
    ).rejects.toThrow("simulated crash")

    const receipts = await recoverAppearanceTransactions(root)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.canUndo).toBe(false)
    await assertOriginal(root)
    if (deletion)
      expect(await readFile(join(root, "quartz", "static", "obsolete.png"), "utf8")).toBe(
        "obsolete",
      )
  })

  it("finishes cleanup after a restart finds an authenticated cleanup tombstone", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        { filesystem: failInstruction("cleanup-rename", "after", 0, true) },
      ),
    ).rejects.toThrow("injected cleanup-rename")
    const transactionRoot = join(root, TRANSACTION_ROOT)

    expect(await recoverAppearanceTransactions(root)).toEqual([])
    expect(await readdir(transactionRoot)).toEqual([])
    await assertOriginal(root)
  })

  it.each(["before", "after"] as const)(
    "recovers the sibling cleanup claim across the final root rmdir %s boundary",
    async (timing) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expect(
        executeAppearancePlan(
          root,
          standardPlan(),
          async () => {
            throw new Error("build")
          },
          {
            filesystem: failFsEvent(
              {
                instruction: "fs-rmdir",
                pathRole: "cleanup-root",
                transactionPhase: "cleanup",
              },
              timing,
              true,
            ),
          },
        ),
      ).rejects.toThrow("injected fs-rmdir")
      const transactionRoot = join(root, TRANSACTION_ROOT)
      expect(
        (await readdir(transactionRoot)).some((name) => name.startsWith(".cleanup-root-")),
      ).toBe(true)

      expect(await recoverAppearanceTransactions(root)).toEqual([])
      expect(await recoverAppearanceTransactions(root)).toEqual([])
      expect(await readdir(transactionRoot)).toEqual([])
      await assertOriginal(root)
    },
  )

  it("retains a replaced sibling cleanup claim and all remaining evidence", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        {
          filesystem: failFsEvent(
            {
              instruction: "fs-rmdir",
              pathRole: "cleanup-root",
              transactionPhase: "cleanup",
            },
            "before",
            true,
          ),
        },
      ),
    ).rejects.toThrow("injected fs-rmdir")
    const transactionRoot = join(root, TRANSACTION_ROOT)
    const claimName = (await readdir(transactionRoot)).find((name) =>
      name.startsWith(".cleanup-root-"),
    )!
    const claimPath = join(transactionRoot, claimName)
    const bytes = await readFile(claimPath)
    const replacement = `${claimPath}.foreign`
    await writeFile(replacement, bytes)
    const foreign = await lstat(replacement, { bigint: true })
    await rename(replacement, claimPath)

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(claimPath, { bigint: true })).ino).toBe(foreign.ino)
    expect(await readFile(claimPath)).toEqual(bytes)
  })

  it("retains a foreign replacement root when a sibling cleanup claim survives", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        {
          filesystem: failFsEvent(
            {
              instruction: "fs-unlink",
              pathRole: "cleanup-entry",
              transactionPhase: "cleanup",
            },
            "before",
            true,
          ),
        },
      ),
    ).rejects.toThrow("injected fs-unlink")
    const transactionRoot = join(root, TRANSACTION_ROOT)
    const directoryName = await activeTransactionName(transactionRoot)
    const directory = join(transactionRoot, directoryName)
    const displaced = join(transactionRoot, `${directoryName}.owned`)
    await rename(directory, displaced)
    await mkdir(directory)
    await writeFile(join(directory, "foreign.txt"), "foreign")

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect(await readFile(join(directory, "foreign.txt"), "utf8")).toBe("foreign")
    expect((await readdir(displaced)).length).toBeGreaterThan(0)
  })

  it("preflights the complete cleanup manifest before removing any evidence", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        { filesystem: failInstruction("cleanup-rename", "after", 0, true) },
      ),
    ).rejects.toThrow("injected cleanup-rename")

    const transactionRoot = join(root, TRANSACTION_ROOT)
    const tombstone = await activeTransactionName(transactionRoot)
    const directory = join(transactionRoot, tombstone)
    const staged = join(directory, "staged", "00000000.bin")
    const stagedBytes = await readFile(staged)
    await writeFile(join(directory, "foreign.txt"), "foreign")

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect(await readFile(staged)).toEqual(stagedBytes)
    expect(await readFile(join(directory, "foreign.txt"), "utf8")).toBe("foreign")
  })

  it("retains a byte-identical foreign cleanup marker inode", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        { filesystem: failInstruction("cleanup-rename", "after", 0, true) },
      ),
    ).rejects.toThrow("injected cleanup-rename")

    const transactionRoot = join(root, TRANSACTION_ROOT)
    const directory = join(transactionRoot, await activeTransactionName(transactionRoot))
    const marker = join(directory, "cleanup.json")
    const bytes = await readFile(marker)
    const replacement = join(directory, "replacement.bin")
    await writeFile(replacement, bytes)
    const foreignInode = (await lstat(replacement, { bigint: true })).ino
    await rename(replacement, marker)

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(marker, { bigint: true })).ino).toBe(foreignInode)
    expect(await readFile(marker)).toEqual(bytes)
  })

  it("retains an unauthenticated cleanup marker hard-link alias", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        { filesystem: failInstruction("cleanup-rename", "after", 0, true) },
      ),
    ).rejects.toThrow("injected cleanup-rename")

    const transactionRoot = join(root, TRANSACTION_ROOT)
    const directory = join(transactionRoot, await activeTransactionName(transactionRoot))
    const marker = join(directory, "cleanup.json")
    const alias = join(directory, `.cleanup.${randomUUID()}.tmp`)
    await link(marker, alias)

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect(await readFile(alias)).toEqual(await readFile(marker))
    expect((await lstat(alias, { bigint: true })).ino).toBe(
      (await lstat(marker, { bigint: true })).ino,
    )
  })

  it("does not authenticate a swapped same-hash evidence inode during cleanup", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    let foreignInode = 0n
    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => {
        const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!
        const staged = join(root, TRANSACTION_ROOT, id, "staged", "00000000.bin")
        const replacement = `${staged}.foreign`
        await writeFile(replacement, await readFile(staged))
        foreignInode = (await lstat(replacement, { bigint: true })).ino
        await rename(replacement, staged)
        throw new Error("build")
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!
    const staged = join(root, TRANSACTION_ROOT, id, "staged", "00000000.bin")
    expect((await lstat(staged, { bigint: true })).ino).toBe(foreignInode)
  })

  it("recovers when cleanup crashes before publishing its authenticated marker", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        { filesystem: failInstruction("cleanup-marker-link", "after", 0, true) },
      ),
    ).rejects.toThrow("injected cleanup-marker-link")
    const transactionRoot = join(root, TRANSACTION_ROOT)
    const id = (await readdir(transactionRoot))[0]!

    expect(await recoverAppearanceTransactions(root)).toEqual([
      { id, status: "recovered", canUndo: false },
    ])
    expect(await readdir(transactionRoot)).toEqual([])
    await assertOriginal(root)
  })

  it("does not trust a pathname-only cleanup tombstone for live recovery evidence", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === "replace" && operation.index === 1) {
            const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
            error.simulateCrash = true
            throw error
          }
        },
      }),
    ).rejects.toThrow("simulated crash")
    const transactionRoot = join(root, TRANSACTION_ROOT)
    const id = (await readdir(transactionRoot))[0]!
    const tombstone = `.${id}.cleanup-${randomUUID()}`
    await rename(join(transactionRoot, id), join(transactionRoot, tombstone))

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect(await readdir(transactionRoot)).toEqual([tombstone])
    expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
  })

  it("retains evidence for an ambiguous partially published journal", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === "replace" && operation.index === 1) {
            const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
            error.simulateCrash = true
            throw error
          }
        },
      }),
    ).rejects.toThrow("simulated crash")
    await writeFile(join(root, "quartz", "styles", "custom.scss"), "foreign\n")

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await readdir(join(root, TRANSACTION_ROOT))).length).toBe(1)
    expect(await readFile(join(root, "quartz", "styles", "custom.scss"), "utf8")).toBe("foreign\n")
  })

  it("rejects and retains tampered, unauthenticated, stale, downgraded, and invalid journals", async () => {
    for (const mode of [
      "tampered",
      "unauthenticated",
      "stale",
      "downgraded",
      "version",
      "evidence-path",
      "zero-identity",
    ] as const) {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expect(
        executeAppearancePlan(root, standardPlan(), async () => undefined, {
          beforeOperation: async (operation) => {
            if (operation.kind === "replace" && operation.index === 0) {
              const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
              error.simulateCrash = true
              throw error
            }
          },
        }),
      ).rejects.toThrow("simulated crash")
      const transaction = (await readdir(join(root, TRANSACTION_ROOT)))[0]!
      const directory = join(root, TRANSACTION_ROOT, transaction)
      const slot = (await readdir(directory)).find((name) => name.startsWith("journal."))!
      const path = join(directory, slot)
      const parsed = JSON.parse(await readFile(path, "utf8"))
      if (mode === "tampered") parsed.journal.entries[0].path = "content/untouched.md"
      if (mode === "unauthenticated") parsed.authentication = "0".repeat(64)
      if (mode === "stale") parsed.journal.revision = 9
      if (mode === "version") parsed.journal.version = 2
      if (mode === "evidence-path") parsed.journal.entries[0].backup = "../foreign"
      if (mode === "zero-identity") {
        parsed.journal.ownership.transaction.dev = "0"
        parsed.journal.ownership.transaction.ino = "0"
      }
      let destination = path
      if (mode === "downgraded") {
        parsed.journal.revision = 2
        parsed.journal.phase = "prepared"
        destination = join(directory, "journal.00000002.json")
      }
      if (
        mode === "stale" ||
        mode === "downgraded" ||
        mode === "version" ||
        mode === "evidence-path" ||
        mode === "zero-identity"
      ) {
        const key = await internalRecoveryKey(root, false)
        parsed.authentication = createHmac("sha256", key)
          .update("garden-publisher/appearance-transaction/journal/v1\0")
          .update(JSON.stringify(parsed.journal))
          .digest("hex")
      }
      await writeFile(destination, JSON.stringify(parsed))
      await expectCode(
        recoverAppearanceTransactions(root),
        "APPEARANCE_TRANSACTION_UNCERTAIN",
      ).catch((error) => {
        throw new Error(`journal rejection mode failed: ${mode}`, { cause: error })
      })
      expect(await lstat(directory)).toBeDefined()
    }
  })

  it("retains one authenticated undo snapshot after consecutive applies", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await executeAppearancePlan(root, standardPlan(), async () => undefined)
    const second = standardPlan()
    const secondPlan: AppearancePlan = {
      ...second,
      baselineHash: digest("second baseline"),
      writes: second.writes.map((entry) => ({
        ...entry,
        expectedHash: digest(
          entry.path === "quartz.config.yaml"
            ? "theme: new\n"
            : entry.path === "quartz/styles/custom.scss"
              ? "new css\n"
              : "image",
        ),
        bytes: Buffer.from(`second:${entry.path}`),
      })),
    }
    await executeAppearancePlan(root, secondPlan, async () => undefined)

    expect(await readdir(join(root, HISTORY_ROOT))).toEqual(["current"])
    const receipt = await undoAppearanceTransaction(root, digest("current"), async () => undefined)
    expect(receipt.canUndo).toBe(false)
    expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
  }, 10_000)

  it("uses one ordinal path order for non-ASCII journals, history, and undo", async () => {
    const root = await workspace()
    const plan: AppearancePlan = {
      baselineHash: digest("unicode-order"),
      settings: {} as AppearancePlan["settings"],
      writes: [
        { path: "content/z.md", expectedHash: null, bytes: Buffer.from("z") },
        { path: "content/ä.md", expectedHash: null, bytes: Buffer.from("a-umlaut") },
      ],
      deletes: [],
    }

    await executeAppearancePlan(root, plan, async () => undefined)
    expect(await readFile(join(root, "content", "z.md"), "utf8")).toBe("z")
    expect(await readFile(join(root, "content", "ä.md"), "utf8")).toBe("a-umlaut")
    await undoAppearanceTransaction(root, digest("unicode-current"), async () => undefined)
    await expect(lstat(join(root, "content", "z.md"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(join(root, "content", "ä.md"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects plans above the journal entry limit before creating state", async () => {
    const root = await workspace()
    const plan: AppearancePlan = {
      baselineHash: digest("too-many"),
      settings: {} as AppearancePlan["settings"],
      writes: Array.from({ length: 129 }, (_, index) => ({
        path: `content/generated-${index.toString().padStart(3, "0")}.md`,
        expectedHash: null,
        bytes: Buffer.from(String(index)),
      })),
      deletes: [],
    }

    await expectCode(
      executeAppearancePlan(root, plan, async () => undefined),
      "APPEARANCE_CONFLICT",
    )
    await expect(lstat(join(root, TRANSACTION_ROOT))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await readdir(join(root, "content"))).sort()).toEqual(["untouched.md"])
  })

  it("rejects a zero-entry plan before verification or creating publisher state", async () => {
    const root = await workspace()
    let verifyBuildCalls = 0
    const verifyBuild = async () => {
      verifyBuildCalls += 1
    }
    const plan: AppearancePlan = {
      baselineHash: digest("empty-plan"),
      settings: {} as AppearancePlan["settings"],
      writes: [],
      deletes: [],
    }

    await expect(executeAppearancePlan(root, plan, verifyBuild)).rejects.toEqual({
      code: "APPEARANCE_CONFLICT",
      message: "Appearance files changed before the update could be applied.",
    })
    expect(verifyBuildCalls).toBe(0)
    await expect(lstat(join(root, ".garden-publisher"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await readdir(join(root, "content"))).sort()).toEqual(["untouched.md"])
  })

  it.each(["empty", "partial", "missing"] as const)(
    "recovers authenticated %s evidence interrupted before its first write",
    async (mode) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expect(
        executeAppearancePlan(root, standardPlan(), async () => undefined, {
          filesystem: failInstruction("journal-parent-fsync", "after", 1, true),
        }),
      ).rejects.toThrow("injected journal-parent-fsync")
      const transactionRoot = join(root, TRANSACTION_ROOT)
      const id = (await readdir(transactionRoot))[0]!
      const staged = join(transactionRoot, id, "staged", "00000000.bin")
      if (mode === "partial") await writeFile(staged, "partial")
      if (mode === "missing") await rm(staged)

      expect(await recoverAppearanceTransactions(root)).toEqual([
        { id, status: "recovered", canUndo: false },
      ])
      await assertOriginal(root)
      expect(await readdir(transactionRoot)).toEqual([])
    },
  )

  it("cleans an authenticated history tombstone while finishing recovered undo", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await executeAppearancePlan(root, standardPlan(), async () => undefined)
    await expect(
      undoAppearanceTransaction(root, digest("undo"), async () => undefined, {
        filesystem: failInstruction("cleanup-rename", "after", 0, true),
      }),
    ).rejects.toThrow("injected cleanup-rename")
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!

    expect(await recoverAppearanceTransactions(root)).toEqual([
      { id, status: "recovered", canUndo: false },
    ])
    expect(await readdir(join(root, HISTORY_ROOT))).toEqual([])
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
    await assertOriginal(root)
  })

  it("retains an unjournaled publication-temp hard-link alias", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction("installed-evidence-link", "before", 0, true),
      }),
    ).rejects.toThrow("injected installed-evidence-link")
    const transactionRoot = join(root, TRANSACTION_ROOT)
    const id = (await readdir(transactionRoot))[0]!
    const installed = join(transactionRoot, id, "installed", "00000000.bin")
    const alias = join(root, `.quartz.config.yaml.appearance-${id}-00000000.tmp`)
    await link(installed, alias)
    const aliasInode = (await lstat(alias, { bigint: true })).ino

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(alias, { bigint: true })).ino).toBe(aliasInode)
  })

  it("recovers a rollback interrupted after publishing its authenticated temp alias", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        { filesystem: failInstruction("publish-temp-link", "after", 0, true) },
      ),
    ).rejects.toThrow("injected publish-temp-link")
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!

    expect(await recoverAppearanceTransactions(root)).toEqual([
      { id, status: "recovered", canUndo: false },
    ])
    await assertOriginal(root)
    await assertNoPublishTemps(root)
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
  })

  it("recovers an interrupted rollback temp for a published deletion", async () => {
    const root = await workspace()
    const obsolete = join(root, "content", "obsolete.md")
    await writeFile(obsolete, "obsolete")
    const plan: AppearancePlan = {
      baselineHash: digest("delete"),
      settings: {} as AppearancePlan["settings"],
      writes: [],
      deletes: [{ path: "content/obsolete.md", expectedHash: digest("obsolete") }],
    }
    await expect(
      executeAppearancePlan(
        root,
        plan,
        async () => {
          throw new Error("build")
        },
        { filesystem: failInstruction("publish-temp-link", "after", 0, true) },
      ),
    ).rejects.toThrow("injected publish-temp-link")
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!

    expect(await recoverAppearanceTransactions(root)).toEqual([
      { id, status: "recovered", canUndo: false },
    ])
    expect(await readFile(obsolete, "utf8")).toBe("obsolete")
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
  })

  it("recovers a committed temp authorization interrupted before unlink", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction("publish-temp-unlink", "before", 0, true),
      }),
    ).rejects.toThrow("injected publish-temp-unlink")
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!

    expect(await recoverAppearanceTransactions(root)).toEqual([
      { id, status: "recovered", canUndo: false },
    ])
    await assertOriginal(root)
    await assertNoPublishTemps(root)
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
  })

  it("retains a publication-temp alias recreated after its authorization was consumed", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind !== "history-promote") return
          const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
          error.simulateCrash = true
          throw error
        },
      }),
    ).rejects.toThrow("simulated crash")
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!
    const target = join(root, "quartz.config.yaml")
    const alias = join(root, `.quartz.config.yaml.appearance-${id}-00000000.tmp`)
    await link(target, alias)
    const aliasInode = (await lstat(alias, { bigint: true })).ino

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(alias, { bigint: true })).ino).toBe(aliasInode)
  })

  it("promotes an authenticated later journal temp before recovery", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction("journal-temp-fsync", "after", 1, true),
      }),
    ).rejects.toThrow("injected journal-temp-fsync")
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!

    expect(await recoverAppearanceTransactions(root)).toEqual([
      { id, status: "recovered", canUndo: false },
    ])
    await assertOriginal(root)
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
  })

  it("keeps verified files recoverable when history promotion fails", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === "history-promote") throw new Error("history unavailable")
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!
    expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")

    expect(await recoverAppearanceTransactions(root)).toEqual([
      { id, status: "recovered", canUndo: true },
    ])
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
    expect(await readdir(join(root, HISTORY_ROOT))).toEqual(["current"])
  })

  it.each([
    ["previous", 0],
    ["installed", 1],
  ] as const)(
    "recovers a verified history promotion interrupted after %s rename",
    async (_phase, ordinal) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await executeAppearancePlan(root, standardPlan(), async () => undefined)
      const second = standardPlan()
      const secondPlan: AppearancePlan = {
        ...second,
        baselineHash: digest("second baseline"),
        writes: second.writes.map((entry) => ({
          ...entry,
          expectedHash: digest(
            entry.path === "quartz.config.yaml"
              ? "theme: new\n"
              : entry.path === "quartz/styles/custom.scss"
                ? "new css\n"
                : "image",
          ),
          bytes: Buffer.from(`second:${entry.path}`),
        })),
      }
      await expect(
        executeAppearancePlan(root, secondPlan, async () => undefined, {
          filesystem: failInstruction("history-switch-rename", "after", ordinal, true),
        }),
      ).rejects.toThrow("injected history-switch-rename")
      const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!
      const history = join(root, HISTORY_ROOT)

      const receipts = await recoverAppearanceTransactions(root)
      expect(receipts).toEqual([{ id, status: "recovered", canUndo: true }])
      expect(await readdir(history)).toEqual(["current"])
      expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
    },
  )

  it("resumes an interrupted verified history clone", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction("history-copy-link", "after", 0, true),
      }),
    ).rejects.toThrow("injected history-copy-link")
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!

    const receipts = await recoverAppearanceTransactions(root)
    expect(receipts).toEqual([{ id, status: "recovered", canUndo: true }])
    expect(await readdir(join(root, HISTORY_ROOT))).toEqual(["current"])
  })

  it.each([
    ["authenticated claim", "history-claim-fsync"],
    ["completed destination", "history-claim-unlink"],
  ] as const)(
    "resumes a history copy after crashing at the %s boundary",
    async (_label, instruction) => {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await expect(
        executeAppearancePlan(root, standardPlan(), async () => undefined, {
          filesystem: failInstruction(instruction, "after", 0, true),
        }),
      ).rejects.toThrow(`injected ${instruction}`)
      const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!

      expect(await recoverAppearanceTransactions(root)).toEqual([
        { id, status: "recovered", canUndo: true },
      ])
      expect(await readdir(join(root, HISTORY_ROOT))).toEqual(["current"])
    },
  )

  it("retains an unauthenticated history destination created after its claim", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction("history-directory-mkdir", "after", 0, true),
      }),
    ).rejects.toThrow("injected history-directory-mkdir")
    const historyRoot = join(root, HISTORY_ROOT)
    const names = await readdir(historyRoot)
    const candidate = names.find((name) => name.startsWith(".candidate-"))!
    const identity = await lstat(join(historyRoot, candidate), { bigint: true })

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(join(historyRoot, candidate), { bigint: true })).ino).toBe(identity.ino)
    expect(await readdir(join(historyRoot, candidate))).toEqual([])
    expect(names.some((name) => name.endsWith(".claim"))).toBe(true)
  })

  it("rejects a replaced authenticated history copy claim", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failInstruction("history-claim-fsync", "after", 0, true),
      }),
    ).rejects.toThrow("injected history-claim-fsync")
    const historyRoot = join(root, HISTORY_ROOT)
    const claim = (await readdir(historyRoot)).find((name) => name.endsWith(".claim"))!
    const claimPath = join(historyRoot, claim)
    const replacement = `${claimPath}.replacement`
    await writeFile(replacement, await readFile(claimPath))
    const foreignInode = (await lstat(replacement, { bigint: true })).ino
    await rename(replacement, claimPath)

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(claimPath, { bigint: true })).ino).toBe(foreignInode)
  })

  it("rechecks the history claim inside each child publication operation", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    let foreignInode = 0n
    let claimPath: string | undefined
    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: {
          async run<T>(instruction: string, operation: () => Promise<T>): Promise<T> {
            if (instruction === "history-copy-link" && claimPath === undefined) {
              const historyRoot = join(root, HISTORY_ROOT)
              const claim = (await readdir(historyRoot)).find((name) => name.endsWith(".claim"))!
              claimPath = join(historyRoot, claim)
              const replacement = `${claimPath}.replacement`
              await writeFile(replacement, await readFile(claimPath))
              foreignInode = (await lstat(replacement, { bigint: true })).ino
              await rename(replacement, claimPath)
            }
            return operation()
          },
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )

    expect(claimPath).toBeDefined()
    expect((await lstat(claimPath!, { bigint: true })).ino).toBe(foreignInode)
    const candidate = (await readdir(join(root, HISTORY_ROOT))).find((name) =>
      name.startsWith(".candidate-"),
    )!
    expect(await readdir(join(root, HISTORY_ROOT, candidate, "backups"))).toEqual([])
  })

  it("resumes authenticated cleanup after a crash between child deletion operations", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(
        root,
        standardPlan(),
        async () => {
          throw new Error("build")
        },
        {
          filesystem: failInstruction("cleanup-unlink", "after", 0, true),
        },
      ),
    ).rejects.toThrow("injected cleanup-unlink")

    expect(await recoverAppearanceTransactions(root)).toEqual([])
    await assertOriginal(root)
    expect(await readdir(join(root, TRANSACTION_ROOT))).toEqual([])
  })

  it("rejects a byte-identical foreign inode in a partial history candidate", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind !== "history-promote") return
          const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
          error.simulateCrash = true
          throw error
        },
      }),
    ).rejects.toThrow("simulated crash")
    const transactionRoot = join(root, TRANSACTION_ROOT)
    const id = (await readdir(transactionRoot))[0]!
    const transaction = join(transactionRoot, id)
    const journalName = (await readdir(transaction))
      .filter((name) => name.startsWith("journal."))
      .sort()
      .at(-1)!
    const envelope = JSON.parse(await readFile(join(transaction, journalName), "utf8"))
    const evidence = envelope.journal.entries.find(
      (entry: { backup: string | null }) => entry.backup !== null,
    ).backup as string
    const candidate = join(root, HISTORY_ROOT, `.candidate-${id}`)
    for (const name of ["backups", "staged", "quarantine", "installed"])
      await mkdir(join(candidate, name), { recursive: true })
    const foreign = join(candidate, ...evidence.split("/"))
    await writeFile(foreign, await readFile(join(transaction, ...evidence.split("/"))))
    const foreignInode = (await lstat(foreign, { bigint: true })).ino

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    expect((await lstat(foreign, { bigint: true })).ino).toBe(foreignInode)
  })

  it("never populates a pre-existing empty history candidate", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind !== "history-promote") return
          const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
          error.simulateCrash = true
          throw error
        },
      }),
    ).rejects.toThrow("simulated crash")
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!
    const candidate = join(root, HISTORY_ROOT, `.candidate-${id}`)
    await mkdir(candidate, { recursive: true })
    const identity = await lstat(candidate, { bigint: true })

    await expectCode(recoverAppearanceTransactions(root), "APPEARANCE_TRANSACTION_UNCERTAIN")
    const after = await lstat(candidate, { bigint: true })
    expect(after.ino).toBe(identity.ino)
    expect(await readdir(candidate)).toEqual([])
  })

  it("does not replace a foreign history destination racing exclusive creation", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    let foreign: string | undefined
    let foreignInode = 0n

    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: {
          async run<T>(
            instruction: string,
            operation: () => Promise<T>,
            event?: TestFsEvent,
          ): Promise<T> {
            if (instruction === "fs-mkdir" && event?.pathRole === "history-directory" && !foreign) {
              const historyRoot = join(root, HISTORY_ROOT)
              foreign = join(
                historyRoot,
                `.candidate-${(await readdir(join(root, TRANSACTION_ROOT)))[0]!}`,
              )
              await mkdir(foreign)
              foreignInode = (await lstat(foreign, { bigint: true })).ino
            }
            return operation()
          },
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )

    expect(foreign).toBeDefined()
    expect((await lstat(foreign!, { bigint: true })).ino).toBe(foreignInode)
    expect(await readdir(foreign!)).toEqual([])
  })

  it("does not populate a history child directory replaced after ownership authentication", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const id = "10000000-0000-4000-8000-000000000097"
    let replacement: Awaited<ReturnType<typeof lstat>> | undefined

    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        createId: () => id,
        filesystem: {
          async run<T>(instruction: string, operation: () => Promise<T>): Promise<T> {
            if (instruction === "history-copy-link" && replacement === undefined) {
              const backups = join(root, HISTORY_ROOT, `.candidate-${id}`, "backups")
              await rm(backups, { recursive: true })
              await mkdir(backups)
              replacement = await lstat(backups)
            }
            return operation()
          },
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )
    expect(replacement).toBeDefined()
    const backups = join(root, HISTORY_ROOT, `.candidate-${id}`, "backups")
    expect((await lstat(backups)).ino).toBe(replacement!.ino)
    expect(await readdir(backups)).toEqual([])
  })

  it("does not replace a foreign journal destination created at publication time", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const id = "10000000-0000-4000-8000-000000000099"
    const foreign = Buffer.from("foreign journal")
    let raced = false

    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        createId: () => id,
        filesystem: {
          async run<T>(
            instruction: string,
            operation: () => Promise<T>,
            event?: TestFsEvent,
          ): Promise<T> {
            if (instruction === "fs-link" && event?.pathRole === "journal" && !raced) {
              raced = true
              await writeFile(join(root, TRANSACTION_ROOT, id, "journal.00000001.json"), foreign)
            }
            return operation()
          },
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )
    expect(await readFile(join(root, TRANSACTION_ROOT, id, "journal.00000001.json"))).toEqual(
      foreign,
    )
    await assertOriginal(root)
  })

  it("recovers an authenticated journal hardlink published before temp unlink", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await expect(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        filesystem: failFsEvent({ instruction: "fs-link", pathRole: "journal" }, "after", true),
      }),
    ).rejects.toThrow("injected fs-link")
    const id = (await readdir(join(root, TRANSACTION_ROOT)))[0]!

    expect(await recoverAppearanceTransactions(root)).toEqual([
      { id, status: "recovered", canUndo: false },
    ])
    await assertOriginal(root)
    expect(await recoverAppearanceTransactions(root)).toEqual([])
  })

  it("rechecks authenticated identity inside the destructive unlink port", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const id = "10000000-0000-4000-8000-000000000098"
    let foreignPath: string | undefined
    let raced = false

    await expectCode(
      executeAppearancePlan(root, standardPlan(), async () => undefined, {
        createId: () => id,
        filesystem: {
          async run<T>(
            instruction: string,
            operation: () => Promise<T>,
            event?: TestFsEvent,
          ): Promise<T> {
            if (instruction === "fs-unlink" && event?.pathRole === "journal" && !raced) {
              const directory = join(root, TRANSACTION_ROOT, id)
              const name = (await readdir(directory)).find((candidate) =>
                candidate.startsWith(".journal.00000001."),
              )
              if (name !== undefined) {
                raced = true
                foreignPath = join(directory, name)
                const bytes = await readFile(foreignPath)
                await rm(foreignPath)
                await writeFile(foreignPath, bytes)
              }
            }
            return operation()
          },
        },
      }),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )
    expect(raced).toBe(true)
    expect(foreignPath).toBeDefined()
    await expect(lstat(foreignPath!)).resolves.toBeDefined()
    await assertOriginal(root)
  })

  it("supports exactly one undo and rejects undo conflicts before mutation", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    const plan = standardPlan()
    await executeAppearancePlan(root, plan, async () => undefined)
    await writeFile(join(root, "quartz.config.yaml"), "foreign\n")
    await expectCode(
      undoAppearanceTransaction(root, digest("current"), async () => undefined, {
        readBaselineHash: async () => digest("current"),
      }),
      "APPEARANCE_CONFLICT",
    )
    expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("foreign\n")
    await writeFile(join(root, "quartz.config.yaml"), "theme: new\n")
    const receipt = await undoAppearanceTransaction(
      root,
      digest("current"),
      async () => undefined,
      {
        readBaselineHash: async () => digest("current"),
      },
    )
    expect(receipt.status).toBe("undone")
    expect(receipt.canUndo).toBe(false)
    await assertOriginal(root)
    await expectCode(
      undoAppearanceTransaction(root, digest("old"), async () => undefined),
      "APPEARANCE_CONFLICT",
    )
  })

  it("rolls back a failed undo and keeps the single history snapshot", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await executeAppearancePlan(root, standardPlan(), async () => undefined)
    await expectCode(
      undoAppearanceTransaction(root, digest("current"), async () => {
        throw new Error("undo build")
      }),
      "APPEARANCE_TRANSACTION_FAILED",
    )
    expect(await readFile(join(root, "quartz.config.yaml"), "utf8")).toBe("theme: new\n")
    expect(await readdir(join(root, HISTORY_ROOT))).toEqual(["current"])
  })

  it("retains a byte-identical foreign inode instead of undoing through it", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await executeAppearancePlan(root, standardPlan(), async () => undefined)
    const target = join(root, "quartz.config.yaml")
    const foreign = `${target}.foreign`
    await writeFile(foreign, "theme: new\n")
    const foreignInode = (await lstat(foreign, { bigint: true })).ino
    await rename(foreign, target)

    await expectCode(
      undoAppearanceTransaction(root, digest("current"), async () => undefined),
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    )
    expect((await lstat(target, { bigint: true })).ino).toBe(foreignInode)
    expect(await readFile(target, "utf8")).toBe("theme: new\n")
  })

  it("keeps undo callback and evidence failures path-free", async () => {
    for (const mode of ["baseline", "cleanup", "evidence"] as const) {
      const root = await workspace()
      await mkdir(join(root, "quartz", "static"), { recursive: true })
      await executeAppearancePlan(root, standardPlan(), async () => undefined)
      if (mode === "evidence") {
        const backup = join(root, HISTORY_ROOT, "current", "backups", "00000000.bin")
        await rm(backup)
      }
      await expectCode(
        undoAppearanceTransaction(root, digest("current"), async () => undefined, {
          readBaselineHash:
            mode === "baseline"
              ? async () => {
                  throw new Error("C:\\secret\\baseline.txt")
                }
              : async () => digest("current"),
          beforeOperation:
            mode === "cleanup"
              ? async (operation) => {
                  if (operation.kind === "undo-history-remove")
                    throw new Error("C:\\secret\\cleanup.txt")
                }
              : undefined,
        }),
        mode === "baseline" ? "APPEARANCE_TRANSACTION_FAILED" : "APPEARANCE_TRANSACTION_UNCERTAIN",
      )
    }
  }, 15_000)

  it("recovers a verified undo crash without creating redo history", async () => {
    const root = await workspace()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    await executeAppearancePlan(root, standardPlan(), async () => undefined)
    await expect(
      undoAppearanceTransaction(root, digest("current"), async () => undefined, {
        beforeOperation: async (operation) => {
          if (operation.kind === "undo-history-remove") {
            const error = new Error("simulated crash") as Error & { simulateCrash?: boolean }
            error.simulateCrash = true
            throw error
          }
        },
      }),
    ).rejects.toThrow("simulated crash")

    const receipts = await recoverAppearanceTransactions(root)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.canUndo).toBe(false)
    await assertOriginal(root)
    await expect(lstat(join(root, HISTORY_ROOT, "current"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
