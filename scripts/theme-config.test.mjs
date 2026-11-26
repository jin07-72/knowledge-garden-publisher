import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { parse } from "yaml"

const configPath = fileURLToPath(new URL("../quartz.config.yaml", import.meta.url))
const customStylesPath = fileURLToPath(new URL("../quartz/styles/custom.scss", import.meta.url))
const publisherManifestPath = fileURLToPath(
  new URL("../quartz/styles/publisher-appearance.json", import.meta.url),
)

const defaultPalette = {
  light: "#101318",
  lightgray: "#252b34",
  gray: "#566170",
  darkgray: "#c2ccd6",
  dark: "#f0f4f8",
  secondary: "#8bd5ca",
  tertiary: "#f5a97f",
  highlight: "rgba(139, 213, 202, 0.12)",
  textHighlight: "rgba(245, 169, 127, 0.26)",
}

async function readConfig() {
  return parse(await readFile(configPath, "utf8"))
}

async function readPublisherManifestIfPresent() {
  try {
    await access(publisherManifestPath)
  } catch {
    return null
  }
  return JSON.parse(await readFile(publisherManifestPath, "utf8"))
}

function plugin(config, source) {
  return config.plugins.find((entry) => entry.source === source)
}

test("keeps the configured theme palette and syntax theme authoritative", async () => {
  const [config, manifest, stylesheet] = await Promise.all([
    readConfig(),
    readPublisherManifestIfPresent(),
    readFile(customStylesPath, "utf8"),
  ])

  assert.equal(plugin(config, "@quartz-themes/core").enabled, false)
  assert.equal(plugin(config, "@quartz-community/darkmode").enabled, false)

  const { lightMode, darkMode } = config.configuration.theme.colors
  assert.deepEqual(lightMode, darkMode)

  if (manifest === null) {
    assert.deepEqual(lightMode, defaultPalette)
  } else {
    assert.ok(manifest.schemaVersion === 1 || manifest.schemaVersion === 2)
    assert.equal(manifest.settings?.schemaVersion, manifest.schemaVersion)
    const colors = manifest.settings.colors
    assert.equal(lightMode.light, colors.page)
    assert.equal(lightMode.lightgray, colors.surface)
    assert.equal(lightMode.gray, colors.border)
    assert.equal(lightMode.darkgray, colors.text)
    assert.equal(lightMode.dark, colors.heading)
    assert.equal(lightMode.secondary, colors.accent)
    assert.equal(lightMode.tertiary, colors.secondary)
    assert.equal(typeof lightMode.highlight, "string")
    assert.ok(lightMode.highlight.length > 0)
    assert.equal(typeof lightMode.textHighlight, "string")
    assert.ok(lightMode.textHighlight.length > 0)

    const typography = config.configuration.theme.typography
    assert.equal(typography.header, manifest.settings.typography.header)
    assert.equal(typography.body, manifest.settings.typography.body)
    assert.equal(typography.code, manifest.settings.typography.code)

    assert.match(
      stylesheet,
      /\/\* publisher-appearance:start \*\/\r?\n@use "\.\/publisher-appearance\.scss";\r?\n\/\* publisher-appearance:end \*\//,
    )
  }

  const syntaxTheme = plugin(config, "@quartz-community/syntax-highlighting").options.theme
  assert.equal(syntaxTheme.light, "github-dark")
  assert.equal(syntaxTheme.dark, "github-dark")
})

test("keeps a long desktop table of contents inside the visible right sidebar", async () => {
  const stylesheet = await readFile(customStylesPath, "utf8")

  assert.match(
    stylesheet,
    /@media all and \(\$desktop\)[\s\S]*?\.sidebar\.right\s*>\s*\.toc\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/,
  )
  assert.match(
    stylesheet,
    /\.sidebar\.right\s*>\s*\.toc\s*>\s*\.toc-content\.overflow\s*\{[^}]*min-height:\s*0;/,
  )
})
