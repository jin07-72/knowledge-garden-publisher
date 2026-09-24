const TRUSTED_RENDERER_ARGUMENT_PREFIX = "--garden-trusted-renderer-url="

function parseExactUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value)
    return parsed.href === value ? parsed : undefined
  } catch {
    return undefined
  }
}

export function normalizeStrictLoopbackRendererUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const canonical = url.href
  if (value !== canonical && `${value}/` !== canonical) return undefined
  return url.protocol === "http:" &&
    ["127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.port.length > 0 &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
    ? canonical
    : undefined
}

function isPackagedRendererUrl(value: string): boolean {
  const url = parseExactUrl(value)
  return (
    url !== undefined &&
    url.protocol === "file:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  )
}

export function trustedRendererArgument(url: string): string {
  return `${TRUSTED_RENDERER_ARGUMENT_PREFIX}${encodeURIComponent(url)}`
}

export function trustedRendererUrlFromArguments(argv: readonly string[]): string | undefined {
  const encoded = argv.filter((argument) => argument.startsWith(TRUSTED_RENDERER_ARGUMENT_PREFIX))
  if (encoded.length !== 1) return undefined
  try {
    const url = decodeURIComponent(encoded[0]!.slice(TRUSTED_RENDERER_ARGUMENT_PREFIX.length))
    return normalizeStrictLoopbackRendererUrl(url) ?? (isPackagedRendererUrl(url) ? url : undefined)
  } catch {
    return undefined
  }
}

export function shouldExposeGardenApi(currentUrl: string, argv: readonly string[]): boolean {
  const trustedUrl = trustedRendererUrlFromArguments(argv)
  return trustedUrl !== undefined && currentUrl === trustedUrl
}
