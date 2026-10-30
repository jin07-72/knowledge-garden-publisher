import { describe, expect, it } from "vitest"
import { DEFAULT_APPEARANCE } from "../../src/shared/appearance"
import { APP_ERROR_CODES, IPC_CHANNELS } from "../../src/shared/contracts"
import {
  IPC_SUCCESS_SCHEMAS,
  appearanceApplyRequestSchema,
  appearancePreviewRequestSchema,
  appearanceSettingsSchema,
  appearanceUndoRequestSchema,
} from "../../src/shared/ipcSchemas"

const sessionId = "11111111-1111-4111-8111-111111111111"
const baselineHash = "a".repeat(64)

describe("appearance bridge contracts", () => {
  it("accepts a bounded Quartz appearance snapshot and strips response-only extras", () => {
    const settings = {
      ...DEFAULT_APPEARANCE,
      background: {
        kind: "image" as const,
        asset: {
          source: "staged" as const,
          token: sessionId,
          name: "background.webp",
          privateSource: "asset-must-not-cross",
        },
        overlay: "#000000",
        opacity: 0.35,
        position: "center" as const,
        fixed: false,
        privateSource: "background-must-not-cross",
      },
      colors: { ...DEFAULT_APPEARANCE.colors, privateSource: "colors-must-not-cross" },
      typography: {
        ...DEFAULT_APPEARANCE.typography,
        privateSource: "typography-must-not-cross",
      },
      layout: { ...DEFAULT_APPEARANCE.layout, privateSource: "layout-must-not-cross" },
      privateSource: "settings-must-not-cross",
    }
    const snapshot = {
      framework: "quartz",
      supported: true,
      settings,
      baselineHash,
      canUndo: false,
      message: "Appearance is ready.",
      privateSource: "snapshot-must-not-cross",
    }

    const parsed = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.appearanceRead].parse(snapshot)

    expect(parsed).toEqual({
      framework: "quartz",
      supported: true,
      settings: {
        ...DEFAULT_APPEARANCE,
        background: {
          kind: "image",
          asset: { source: "staged", token: sessionId, name: "background.webp" },
          overlay: "#000000",
          opacity: 0.35,
          position: "center",
          fixed: false,
        },
      },
      baselineHash,
      canUndo: false,
      message: "Appearance is ready.",
    })
    expect(JSON.stringify(parsed)).not.toContain("must-not-cross")
  })

  it("rejects unknown appearance setting keys", () => {
    expect(
      appearanceSettingsSchema.safeParse({ ...DEFAULT_APPEARANCE, workspacePath: "C:/garden" })
        .success,
    ).toBe(false)
  })

  it("rejects invalid colors and unsafe font tokens", () => {
    expect(
      appearanceSettingsSchema.safeParse({
        ...DEFAULT_APPEARANCE,
        colors: { ...DEFAULT_APPEARANCE.colors, accent: "red" },
      }).success,
    ).toBe(false)
    expect(
      appearanceSettingsSchema.safeParse({
        ...DEFAULT_APPEARANCE,
        typography: {
          ...DEFAULT_APPEARANCE.typography,
          body: "Inter; background: url(https://example.com/tracker)",
        },
      }).success,
    ).toBe(false)
  })

  it("bounds custom CSS at 64 KiB", () => {
    expect(
      appearanceSettingsSchema.safeParse({
        ...DEFAULT_APPEARANCE,
        customCss: "x".repeat(64 * 1024),
      }).success,
    ).toBe(true)
    expect(
      appearanceSettingsSchema.safeParse({
        ...DEFAULT_APPEARANCE,
        customCss: "x".repeat(64 * 1024 + 1),
      }).success,
    ).toBe(false)
  })

  it("rejects custom CSS that could break the managed style context", () => {
    for (const customCss of [
      "body { color: red; }\u0000",
      "body::after { content: '</style>'; }",
      "</StYlE media=all>",
    ])
      expect(
        appearanceSettingsSchema.safeParse({ ...DEFAULT_APPEARANCE, customCss }).success,
        JSON.stringify(customCss),
      ).toBe(false)

    expect(
      appearanceSettingsSchema.safeParse({
        ...DEFAULT_APPEARANCE,
        customCss: "body::after { content: '<style>'; }",
      }).success,
    ).toBe(true)
  })

  it("rejects a staged background whose token is not a UUID", () => {
    expect(
      appearanceSettingsSchema.safeParse({
        ...DEFAULT_APPEARANCE,
        background: {
          kind: "image",
          asset: { source: "staged", token: "not-a-token", name: "background.webp" },
          overlay: "#000000",
          opacity: 0.35,
          position: "center",
          fixed: false,
        },
      }).success,
    ).toBe(false)
  })

  it("allows only bounded, Windows-safe bitmap background names", () => {
    const withImage = (name: string, source: "managed" | "staged") => ({
      ...DEFAULT_APPEARANCE,
      background: {
        kind: "image" as const,
        asset:
          source === "managed"
            ? { source, name }
            : { source, token: sessionId, name },
        overlay: "#000000",
        opacity: 0.35,
        position: "center" as const,
        fixed: false,
      },
    })

    for (const name of [
      "background.png",
      "background.JPG",
      "background.JpEg",
      "background.gif",
      "background.webp",
      "background.AVIF",
      `${"a".repeat(251)}.png`,
    ])
      expect(appearanceSettingsSchema.safeParse(withImage(name, "managed")).success, name).toBe(
        true,
      )

    for (const name of [
      ".png",
      "CON.webp",
      "con.backup.png",
      "NUL.png",
      "com1.avif",
      "LPT¹.jpeg",
      "payload.svg",
      "theme.scss",
      "background.png.exe",
      `${"a".repeat(252)}.png`,
    ]) {
      expect.soft(
        appearanceSettingsSchema.safeParse(withImage(name, "managed")).success,
        `managed:${name}`,
      ).toBe(false)
      expect.soft(
        appearanceSettingsSchema.safeParse(withImage(name, "staged")).success,
        `staged:${name}`,
      ).toBe(false)
    }
  })

  it("rejects an appearance preview outside the exact loopback boundary", () => {
    for (const url of [
      "http://user:pass@127.0.0.1/",
      "http://2130706433/",
      "http://127.1/",
      "http://127.0.0.1./",
      "http://localhost/",
      "http://[::1]/",
      "https://127.0.0.1/",
      "http://192.168.1.2/",
    ]) {
      expect.soft(
        appearancePreviewRequestSchema.safeParse({
          url,
          sessionId,
          settings: DEFAULT_APPEARANCE,
        }).success,
        url,
      ).toBe(false)
    }
  })

  it("accepts a literal loopback authority with a valid port and URL suffix", () => {
    expect(
      appearancePreviewRequestSchema.safeParse({
        url: "http://127.0.0.1:8080/notes/current?mode=appearance#preview",
        sessionId,
        settings: DEFAULT_APPEARANCE,
      }).success,
    ).toBe(true)
  })

  it("bounds appearance preview URLs at 2048 UTF-8 bytes", () => {
    const prefix = "http://127.0.0.1/"
    const exact = prefix + "x".repeat(2_048 - prefix.length)
    const oversized = `${exact}x`

    expect(
      appearancePreviewRequestSchema.safeParse({
        url: exact,
        sessionId,
        settings: DEFAULT_APPEARANCE,
      }).success,
    ).toBe(true)
    expect(
      appearancePreviewRequestSchema.safeParse({
        url: oversized,
        sessionId,
        settings: DEFAULT_APPEARANCE,
      }).success,
    ).toBe(false)
  })

  it("requires exact baseline hashes for apply and undo", () => {
    expect(
      appearanceApplyRequestSchema.safeParse({ settings: DEFAULT_APPEARANCE }).success,
    ).toBe(false)
    expect(
      appearanceApplyRequestSchema.safeParse({
        settings: DEFAULT_APPEARANCE,
        baselineHash: "a".repeat(63),
      }).success,
    ).toBe(false)
    expect(appearanceUndoRequestSchema.safeParse({ baselineHash }).success).toBe(true)
  })

  it("publishes the appearance error codes and request channels", () => {
    for (const code of [
      "APPEARANCE_UNSUPPORTED",
      "APPEARANCE_INVALID",
      "APPEARANCE_CHANGED",
      "APPEARANCE_CONFLICT",
      "APPEARANCE_PREVIEW_UNAVAILABLE",
      "APPEARANCE_TRANSACTION_FAILED",
      "APPEARANCE_TRANSACTION_UNCERTAIN",
    ] as const)
      expect(APP_ERROR_CODES).toContain(code)

    expect(IPC_CHANNELS.requests.appearanceRead).toBe("garden:appearance:read")
    expect(IPC_CHANNELS.requests.appearanceChooseBackground).toBe(
      "garden:appearance:choose-background",
    )
    expect(IPC_CHANNELS.requests.appearancePreview).toBe("garden:appearance:preview")
    expect(IPC_CHANNELS.requests.appearanceClearPreview).toBe("garden:appearance:clear-preview")
    expect(IPC_CHANNELS.requests.appearanceApply).toBe("garden:appearance:apply")
    expect(IPC_CHANNELS.requests.appearanceUndo).toBe("garden:appearance:undo")
  })
})
