import { inspectWorkspaceSafety } from "./workspace"

export type BlogAvailabilityInspection =
  { readonly available: true; readonly canonicalPath: string } | { readonly available: false }

export async function inspectBlogAvailability(path: string): Promise<BlogAvailabilityInspection> {
  const inspection = await inspectWorkspaceSafety(path)
  return inspection.ok ? { available: true, canonicalPath: inspection.root } : { available: false }
}
