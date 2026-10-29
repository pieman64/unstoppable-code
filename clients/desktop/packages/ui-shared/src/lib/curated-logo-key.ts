import type { UnifiedPluginEntry } from '@canopy/ui-shared';

/**
 * Catalog key a tile's brand mark lives under.
 *
 * Provider-routed connectors replace the curated entry they stand in for, so
 * without carrying its key they lose the bundled mark and fall back to a
 * monogram — several near-identical grey letters in one row. Shared by the
 * discovery grid and the installed row because a linked connector renders in
 * both, and a mark that resolves in one place and not the other reads as a
 * loading bug.
 *
 * An installed server projects as `local-mcp` whenever the curated catalog
 * does not currently list its key — the catalog is fetched, brand-scoped, and
 * degrades to empty offline — but the server still stores the key it was
 * installed under, and the mark for it ships with the app. Resolve it here so
 * the installed strip does not decay to monograms the moment the catalog is
 * unavailable while the cards beside it keep their marks.
 */
export function curatedLogoKey(entry: UnifiedPluginEntry): string | undefined {
  if (entry.ref.type === 'curated-mcp') return entry.ref.key;
  if (entry.ref.type === 'provider-connector') return entry.ref.curatedKey;
  if (entry.ref.type === 'local-mcp') return entry.ref.curatedKey;
  return undefined;
}
