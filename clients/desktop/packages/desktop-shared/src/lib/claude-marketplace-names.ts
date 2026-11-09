/**
 * The spellings Claude Code may key a marketplace's installs under, in
 * `plugin@<spelling>`, most authoritative first: the name Claude Code
 * registered it under, then Canopy's id, then its display name, each once.
 * A blank spelling names nothing.
 *
 * The registered name is the marketplace's Claude manifest `name`, which the
 * cache records in its Claude provider status (the desktop's `plugin-service.ts` and
 * `curated-plugin-marketplace.ts`): Claude Code registers a marketplace under
 * its manifest name, and keys every install in `installed_plugins.json` by
 * it. Within one entry it is tried first, so the entry's own display name
 * cannot shadow its registered name. Across entries, cache order decides
 * which entry resolves a shared spelling first (see `inheritedClaudePluginRefs`).
 */
export function claudeMarketplaceNames(marketplace: {
  readonly id: string;
  readonly name?: string;
  readonly providerStatus?: {
    readonly claude?: { readonly marketplaceName?: string };
  };
}): string[] {
  const names = [
    marketplace.providerStatus?.claude?.marketplaceName,
    marketplace.id,
    marketplace.name,
  ];
  return Array.from(
    new Set(names.filter((name): name is string => Boolean(name))),
  );
}
