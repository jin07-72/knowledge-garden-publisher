import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { FullSlug, resolveRelative } from "../util/path"

const DOMAIN_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED_DOMAIN_SLUGS = new Set(["index", "content", "private", "garden-publisher"])
const MAX_TITLE_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 2_000

type OverviewFile = {
  slug?: string
  unlisted?: unknown
  data?: {
    unlisted?: unknown
  }
  frontmatter?: {
    gardenDomain?: unknown
    title?: unknown
    description?: unknown
    domainOrder?: unknown
    unlisted?: unknown
  }
}

export type DomainOverview = {
  totalNotes: number
  domains: Array<{
    slug: string
    title: string
    detail: string
    order?: number
    count: number
  }>
}

type DomainCandidate = {
  slug: string
  title: string
  detail: string
  order?: number
  count: number
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
}

function isSafeDomainSlug(slug: string): boolean {
  return slug.length <= 80 && DOMAIN_SLUG_PATTERN.test(slug) && !RESERVED_DOMAIN_SLUGS.has(slug)
}

function isUnlisted(file: OverviewFile): boolean {
  return (
    file.frontmatter?.unlisted === true || file.unlisted === true || file.data?.unlisted === true
  )
}

function getMarkedDomainSlug(file: OverviewFile): string | undefined {
  const slug = file.slug
  if (
    file.frontmatter?.gardenDomain !== true ||
    typeof slug !== "string" ||
    !slug.endsWith("/index") ||
    slug.indexOf("/") !== slug.lastIndexOf("/")
  ) {
    return undefined
  }

  const domainSlug = slug.slice(0, -"/index".length)
  return isSafeDomainSlug(domainSlug) ? domainSlug : undefined
}

function parseDomainIndex(file: OverviewFile): DomainCandidate | undefined {
  const slug = getMarkedDomainSlug(file)
  const frontmatter = file.frontmatter
  if (
    slug === undefined ||
    frontmatter === undefined ||
    !validText(frontmatter.title, MAX_TITLE_LENGTH) ||
    !validText(frontmatter.description, MAX_DESCRIPTION_LENGTH)
  ) {
    return undefined
  }

  const rawOrder = frontmatter.domainOrder
  const order =
    typeof rawOrder === "number" && Number.isSafeInteger(rawOrder) && rawOrder >= 0
      ? rawOrder
      : undefined

  return {
    slug,
    title: frontmatter.title.trim(),
    detail: frontmatter.description.trim(),
    ...(order === undefined ? {} : { order }),
    count: 0,
  }
}

/** Build the public homepage's domain cards from the published file list. */
export function buildDomainOverview(files: OverviewFile[]): DomainOverview {
  const markedIndexes = files.filter((file) => getMarkedDomainSlug(file) !== undefined)
  const duplicateSlugs = new Set<string>()
  const occurrences = new Map<string, number>()
  for (const file of markedIndexes) {
    const slug = getMarkedDomainSlug(file)!
    occurrences.set(slug, (occurrences.get(slug) ?? 0) + 1)
  }
  for (const [slug, count] of occurrences) {
    if (count > 1) duplicateSlugs.add(slug)
  }

  const candidates = markedIndexes.filter((file) => !isUnlisted(file)).map(parseDomainIndex)
  const domains = candidates.filter(
    (candidate): candidate is DomainCandidate =>
      candidate !== undefined && !duplicateSlugs.has(candidate.slug),
  )
  const domainBySlug = new Map(domains.map((domain) => [domain.slug, domain]))

  for (const file of files) {
    const slug = file.slug
    if (typeof slug !== "string" || isUnlisted(file) || slug.endsWith("/index")) {
      continue
    }
    const separator = slug.indexOf("/")
    if (separator === -1) continue
    const domainSlug = slug.slice(0, separator)
    const domain = domainBySlug.get(domainSlug)
    if (domain !== undefined) domain.count += 1
  }

  domains.sort((left, right) => {
    if (left.order !== undefined && right.order !== undefined) {
      if (left.order !== right.order) return left.order - right.order
    }
    if (left.order !== undefined && right.order === undefined) return -1
    if (left.order === undefined && right.order !== undefined) return 1
    return left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0
  })

  return {
    totalNotes: domains.reduce((total, domain) => total + domain.count, 0),
    domains,
  }
}

const GardenOverview: QuartzComponent = ({ fileData, allFiles }: QuartzComponentProps) => {
  const model = buildDomainOverview(allFiles)
  return (
    <section class="garden-overview" aria-label="知识领域">
      <p class="garden-stats">
        {model.totalNotes} notes · {model.domains.length} domains
      </p>
      <div class="domain-grid">
        {model.domains.map((domain, index) => (
          <a
            class="domain-card"
            href={resolveRelative(fileData.slug!, `${domain.slug}/index` as FullSlug)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{domain.title}</strong>
            <small>
              {domain.detail} · {domain.count} notes
            </small>
          </a>
        ))}
      </div>
    </section>
  )
}

export default (() => GardenOverview) satisfies QuartzComponentConstructor
