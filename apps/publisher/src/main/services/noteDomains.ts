import {
  discoverDomainSnapshot,
  revalidateDomainSnapshot,
  type DiscoverDomainSnapshotOptions,
  type DomainDiscoverySnapshot,
} from "./domains"

export interface NoteDomainSnapshot {
  readonly workspace: string
  readonly orderedSlugs: readonly string[]
  readonly has: (slug: string) => boolean
  readonly discovery: DomainDiscoverySnapshot
}

export async function captureNoteDomainSnapshot(
  workspacePath: string,
  options: DiscoverDomainSnapshotOptions = {},
): Promise<NoteDomainSnapshot> {
  const discovery = await discoverDomainSnapshot(workspacePath, options)
  const membership = new Set(discovery.slugs)
  return Object.freeze({
    workspace: discovery.workspace,
    orderedSlugs: discovery.slugs,
    has: (slug: string) => membership.has(slug),
    discovery,
  })
}

export async function revalidateNoteDomains(
  snapshot: NoteDomainSnapshot,
  domains: Iterable<string> = snapshot.orderedSlugs,
): Promise<void> {
  await revalidateDomainSnapshot(snapshot.discovery, domains)
}

export function sameNoteDomainMembership(
  left: NoteDomainSnapshot,
  right: NoteDomainSnapshot,
): boolean {
  return (
    left.orderedSlugs.length === right.orderedSlugs.length &&
    left.orderedSlugs.every((slug, index) => slug === right.orderedSlugs[index])
  )
}
