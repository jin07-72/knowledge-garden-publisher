import { type CompletionContext, type CompletionResult } from "@codemirror/autocomplete"
import type { DomainSummary, NoteSummary } from "../../../shared/contracts"

function completionDetail(note: NoteSummary, domains: readonly DomainSummary[]): string {
  const domainName = domains.find((domain) => domain.slug === note.domain)?.name ?? note.domain
  return `${domainName} · ${note.visibility === "public" ? "公开" : "私密"} · ${note.path}`
}

/** Metadata-only completion: never copies descriptions, tags, or note bodies into the UI. */
export function wikiCompletion(
  notes: readonly NoteSummary[],
  currentDomain?: NoteSummary["domain"],
  domains: readonly DomainSummary[] = [],
) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[[^\]\n]*$/)
    if (!match) return null
    const query = match.text.slice(2).toLocaleLowerCase()
    const ranked = notes
      .map((note, index) => {
        const title = note.title.toLocaleLowerCase()
        const matchRank =
          title === query ? 0 : title.startsWith(query) ? 1 : title.includes(query) ? 2 : 3
        return { note, index, matchRank }
      })
      .filter(({ matchRank }) => query === "" || matchRank < 3)
      .sort(
        (left, right) =>
          left.matchRank - right.matchRank ||
          Number(right.note.domain === currentDomain) -
            Number(left.note.domain === currentDomain) ||
          left.note.title.localeCompare(right.note.title) ||
          left.note.path.localeCompare(right.note.path) ||
          left.index - right.index,
      )
      .slice(0, 50)
    return {
      from: match.from + 2,
      options: ranked.map(({ note }) => ({
        label: note.title,
        detail: completionDetail(note, domains),
        apply: `${note.title}]]`,
        type: "text",
      })),
      validFor: /^[^\]\n]*$/,
      filter: false,
    }
  }
}
