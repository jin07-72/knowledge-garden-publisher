import { type CompletionContext, type CompletionResult } from "@codemirror/autocomplete"
import type { NoteSummary } from "../../../shared/contracts"

function completionDetail(note: NoteSummary): string {
  return `${note.domain}/${note.slug} · ${note.visibility === "public" ? "公开" : "私密"}`
}

/** Metadata-only completion: never copies descriptions, tags, or note bodies into the UI. */
export function wikiCompletion(notes: readonly NoteSummary[]) {
  const options = notes.map((note) => ({
    label: note.title,
    detail: completionDetail(note),
    apply: `${note.title}]]`,
    type: "text",
  }))

  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[[^\]\n]*$/)
    if (!match) return null
    return { from: match.from + 2, options, validFor: /^[^\]\n]*$/ }
  }
}
