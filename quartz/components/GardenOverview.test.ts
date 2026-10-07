import assert from "node:assert/strict"
import { test } from "node:test"
import { h } from "preact"
import renderToString from "preact-render-to-string"
import GardenOverview, { buildDomainOverview } from "./GardenOverview"

type TestFile = {
  slug: string
  frontmatter?: Record<string, unknown>
  unlisted?: unknown
  data?: { unlisted?: unknown }
}

const domainIndex = (
  slug: string,
  title: string,
  description: string,
  domainOrder?: unknown,
  extra: Record<string, unknown> = {},
): TestFile => ({
  slug,
  frontmatter: {
    gardenDomain: true,
    title,
    description,
    ...(domainOrder === undefined ? {} : { domainOrder }),
    ...extra,
  },
})

const note = (slug: string, frontmatter: Record<string, unknown> = {}): TestFile => ({
  slug,
  frontmatter,
})

test("discovers marked domain indexes, orders them, and counts visible notes", () => {
  const model = buildDomainOverview([
    domainIndex("artificial-intelligence/index", "人工智能", "模型与应用", 5),
    note("artificial-intelligence/transformers"),
    domainIndex("reading/index", "读书与思考", "书籍与观点", 1),
    note("reading/active-recall"),
    note("reading/hidden", { unlisted: true }),
  ])

  assert.deepEqual(model, {
    totalNotes: 2,
    domains: [
      { slug: "reading", title: "读书与思考", detail: "书籍与观点", order: 1, count: 1 },
      {
        slug: "artificial-intelligence",
        title: "人工智能",
        detail: "模型与应用",
        order: 5,
        count: 1,
      },
    ],
  })
})

test("sorts missing orders after explicit orders, then by slug", () => {
  const model = buildDomainOverview([
    domainIndex("zeta/index", "Zeta", "Z", undefined),
    domainIndex("alpha/index", "Alpha", "A", undefined),
    domainIndex("another-ordered/index", "Another ordered", "AO", 2),
    domainIndex("ordered/index", "Ordered", "O", 2),
  ])

  assert.deepEqual(
    model.domains.map(({ slug, order }) => ({ slug, order })),
    [
      { slug: "another-ordered", order: 2 },
      { slug: "ordered", order: 2 },
      { slug: "alpha", order: undefined },
      { slug: "zeta", order: undefined },
    ],
  )
})

test("ignores malformed marked pages, nested indexes, and duplicate slugs", () => {
  const model = buildDomainOverview([
    domainIndex("valid/index", "Valid", "Valid", 1),
    domainIndex("valid/index", "Conflicting duplicate", "Duplicate", 2),
    domainIndex("nested/child/index", "Nested", "Not a domain", 3),
    domainIndex("Unsafe_Slug/index", "Unsafe", "Not a domain", 4),
    domainIndex("missing-title/index", "", "Missing title", 5),
    domainIndex("missing-description/index", "Missing description", "   ", 6),
    {
      slug: "not-marked/index",
      frontmatter: { title: "No marker", description: "Ignored", gardenDomain: false },
    },
    note("valid/note"),
  ])

  assert.deepEqual(model, { totalNotes: 0, domains: [] })
})

test("uses slug fallback for malformed and missing domain orders", () => {
  const model = buildDomainOverview([
    domainIndex("negative/index", "Negative", "Fallback", -1),
    domainIndex("fractional/index", "Fractional", "Fallback", 1.5),
    domainIndex("string-order/index", "String", "Fallback", "2"),
    domainIndex("nan-order/index", "NaN", "Fallback", Number.NaN),
    domainIndex("infinite-order/index", "Infinite", "Fallback", Number.POSITIVE_INFINITY),
    domainIndex("missing-order/index", "Missing", "Fallback"),
    domainIndex("explicit/index", "Explicit", "Ordered", 1),
  ])

  assert.deepEqual(
    model.domains.map(({ slug, order }) => ({ slug, order })),
    [
      { slug: "explicit", order: 1 },
      { slug: "fractional", order: undefined },
      { slug: "infinite-order", order: undefined },
      { slug: "missing-order", order: undefined },
      { slug: "nan-order", order: undefined },
      { slug: "negative", order: undefined },
      { slug: "string-order", order: undefined },
    ],
  )
})

test("excludes unlisted domain landings and their notes", () => {
  const model = buildDomainOverview([
    domainIndex("visible/index", "Visible", "Shown", 1),
    domainIndex("frontmatter-hidden/index", "Hidden frontmatter", "Hidden", 2, {
      unlisted: true,
    }),
    {
      ...domainIndex("normalized-hidden/index", "Hidden normalized", "Hidden", 3),
      data: { unlisted: true },
    },
    note("visible/kept"),
    note("visible/hidden", { unlisted: true }),
    { slug: "visible/hidden-normalized", frontmatter: {}, unlisted: true },
    note("frontmatter-hidden/note"),
    note("normalized-hidden/note"),
  ])

  assert.deepEqual(model, {
    totalNotes: 1,
    domains: [{ slug: "visible", title: "Visible", detail: "Shown", order: 1, count: 1 }],
  })
})

test("excludes a slug when marked duplicate includes an unlisted landing", () => {
  const model = buildDomainOverview([
    domainIndex("reading/index", "Reading", "Visible landing", 1),
    domainIndex("reading/index", "Hidden duplicate", "Unlisted landing", 2, {
      unlisted: true,
    }),
    note("reading/visible-note"),
  ])

  assert.deepEqual(model, { totalNotes: 0, domains: [] })
})

test("ignores reserved and oversized domain slugs", () => {
  const reserved = ["index", "content", "private", "garden-publisher"]
  const oversized = "a".repeat(81)
  const model = buildDomainOverview([
    ...reserved.map((slug, index) => domainIndex(`${slug}/index`, slug, "Reserved", index)),
    domainIndex(`${oversized}/index`, "Oversized", "Too long", 10),
    ...reserved.map((slug) => note(`${slug}/note`)),
    note(`${oversized}/note`),
  ])

  assert.deepEqual(model, { totalNotes: 0, domains: [] })
})

test("counts only visible non-index files under discovered domains", () => {
  const model = buildDomainOverview([
    domainIndex("reading/index", "Reading", "Reading", 1),
    note("reading/visible"),
    note("reading/unlisted", { unlisted: true }),
    note("reading/topics/index"),
    note("reading/index"),
    note("reading/visible/image.png"),
    note("unlisted-domain/note"),
    note("outside/note"),
  ])

  assert.deepEqual(model, {
    totalNotes: 2,
    domains: [{ slug: "reading", title: "Reading", detail: "Reading", order: 1, count: 2 }],
  })
})

test("renders dynamic overview content with escaped text and relative links", () => {
  const allFiles = [
    domainIndex("reading/index", "<Reading>", "Books & ideas", 1),
    domainIndex("writing/index", "Writing", "Drafts", 2),
    domainIndex("hidden/index", "Hidden", "Not shown", 3, { unlisted: true }),
    note("reading/kept"),
    note("reading/also-kept"),
    note("reading/hidden", { unlisted: true }),
    note("writing/kept"),
    note("hidden/kept"),
  ]
  const renderOverview = (slug: string) =>
    renderToString(
      h(GardenOverview(), {
        fileData: { slug },
        allFiles,
      } as never),
    )

  const rootHtml = renderOverview("index")
  assert.match(rootHtml, /3 notes · 2 domains/)
  assert.match(rootHtml, /<span>01<\/span>/)
  assert.match(rootHtml, /<span>02<\/span>/)
  assert.match(rootHtml, /&lt;Reading>/)
  assert.match(rootHtml, /Books &amp; ideas/)
  assert.doesNotMatch(rootHtml, /<Reading>/)
  assert.match(rootHtml, /href="\.\/reading\/"/)
  assert.match(rootHtml, /href="\.\/writing\/"/)
  assert.doesNotMatch(rootHtml, /Hidden/)

  const nestedHtml = renderOverview("journal/note")
  assert.match(nestedHtml, /href="\.\.\/reading\/"/)
  assert.match(nestedHtml, /href="\.\.\/writing\/"/)
})
