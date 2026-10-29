/**
 * Claude Code plugins a Cursor chat inherits: installed in Claude Code and
 * not disabled there, minus what the chat already selects or has turned off.
 * They enter `resolvePlugins` as inherited plugin refs, so their skills,
 * commands, and MCP servers take the same path as a picked plugin (MCP
 * through the proxy and approvals); see
 * docs/planning/2026-10-05-cursor-inherited-capabilities/design.md § 3.
 *
 * The one signal is Claude Code's own report (`readClaudeEnabledPlugins`),
 * read fresh every turn from its `installed_plugins.json` and `settings.json`:
 * the `plugin@marketplace` keys it would load, each with the folder it
 * installed. That folder travels with the ref and is the only place the
 * plugin's files are read from; the marketplace cache contributes the
 * marketplace identity and ordering, never a substitute copy. Claude Code
 * keys an install by the name the marketplace was registered under: for a
 * third-party marketplace that is Canopy's `marketplace.id` (or `name`); for
 * the marketplaces Canopy manages (bundled, curated) it is the name Canopy
 * registered, which the cache records in the marketplace's Claude provider
 * status. When the report is unavailable (`null`), nothing is inherited:
 * Claude Code itself would load nothing.
 */
export interface PluginRefKey {
  marketplaceId: string;
  pluginName: string;
}

export interface InheritedPluginRef extends PluginRefKey {
  /** The folder Claude Code installed; its files are read from here alone. */
  installPath: string;
}

export interface InheritedPluginCandidate {
  name: string;
}

export interface InheritedPluginMarketplace {
  id: string;
  name?: string;
  providerStatus?: {
    claude?: {
      /** The name Claude Code registered the marketplace under, if known. */
      marketplaceName?: string;
    };
  };
  plugins: readonly InheritedPluginCandidate[];
}

function refKey(ref: PluginRefKey): string {
  return `${ref.marketplaceId}\u0000${ref.pluginName.toLowerCase()}`;
}

/**
 * The spellings Claude Code may key a marketplace's installs under, in
 * `plugin@<spelling>`, most authoritative first: the name Claude Code
 * registered it under, then Canopy's id, then its display name, each once.
 * A blank spelling names nothing.
 *
 * The registered name is the marketplace's Claude manifest `name`, which the
 * cache records in its Claude provider status (`plugin-service.ts`,
 * `curated-plugin-marketplace.ts`): Claude Code registers a marketplace under
 * its manifest name, and keys every install in `installed_plugins.json` by
 * it. Within one entry it is tried first, so the entry's own display name
 * cannot shadow its registered name. Across entries, cache order decides
 * which entry resolves a shared spelling first (see `inheritedClaudePluginRefs`).
 */
export function claudeMarketplaceNames(
  marketplace: InheritedPluginMarketplace,
): string[] {
  const names = [
    marketplace.providerStatus?.claude?.marketplaceName,
    marketplace.id,
    marketplace.name,
  ];
  return Array.from(
    new Set(names.filter((name): name is string => Boolean(name))),
  );
}

/** Claude Code's install of `pluginName` under one of the spellings, with its key. */
function claudeInstallOf(
  claudeEnabled: ReadonlyMap<string, string>,
  marketplaceNames: readonly string[],
  pluginName: string,
): { key: string; installPath: string } | undefined {
  for (const marketplaceName of marketplaceNames) {
    const key = `${pluginName}@${marketplaceName}`;
    const installPath = claudeEnabled.get(key);
    if (installPath !== undefined) return { key, installPath };
  }
  return undefined;
}

/**
 * The Claude Code installations a Cursor or Copilot chat inherits: every
 * enabled one, less the chat's own picks, tombstones and Disabled plugins.
 * Available installs are inherited on purpose: Claude Code loads them in
 * Claude chats too, so the providers see one set. Only Disabled, which turns
 * the Claude Code installation off, keeps a plugin out everywhere (see
 * "Installed item status and uninstall" in docs/agent-runtime-maintenance.md).
 */
export function inheritedClaudePluginRefs(
  marketplaces: readonly InheritedPluginMarketplace[],
  effective: { pluginRefs: readonly PluginRefKey[] },
  tombstones: { pluginRefs?: readonly PluginRefKey[] } | undefined,
  claudeEnabled: ReadonlyMap<string, string> | null,
  disabledPluginRefs: readonly PluginRefKey[] = [],
): InheritedPluginRef[] {
  if (!claudeEnabled) return [];
  const excluded = new Set<string>();
  for (const ref of effective.pluginRefs) excluded.add(refKey(ref));
  for (const ref of tombstones?.pluginRefs ?? []) excluded.add(refKey(ref));
  for (const ref of disabledPluginRefs) excluded.add(refKey(ref));
  const refs: InheritedPluginRef[] = [];
  // One Claude Code install is inherited at most once, under the first cached
  // marketplace that resolves it: two entries can share a spelling (one's
  // display name equal to another's id or registered name), and loading the
  // same folder under both ids would start its MCP servers twice. A plugin
  // in `effective.pluginRefs` (the refs the caller passes: a chat's direct
  // picks) or in the tombstones covers its install for every entry, earlier
  // or later in cache order: the resolver loads the picked copy itself, and
  // a turned-off plugin must not come back under another id. Refs a
  // Collection expands to are not passed here; the resolver drops an
  // inherited ref that matches one of those by exact marketplace id and name.
  const covered = new Set<string>();
  const namesById = new Map<string, readonly string[]>();
  for (const marketplace of marketplaces) {
    if (!namesById.has(marketplace.id))
      namesById.set(marketplace.id, claudeMarketplaceNames(marketplace));
  }
  for (const ref of [
    ...effective.pluginRefs,
    ...(tombstones?.pluginRefs ?? []),
    ...disabledPluginRefs,
  ]) {
    for (const name of namesById.get(ref.marketplaceId) ?? [
      ref.marketplaceId,
    ]) {
      for (const key of Array.from(claudeEnabled.keys())) {
        if (
          key.toLowerCase().startsWith(`${ref.pluginName.toLowerCase()}@`) &&
          key.slice(key.lastIndexOf('@') + 1) === name
        )
          covered.add(key);
      }
    }
  }
  for (const marketplace of marketplaces) {
    const marketplaceNames =
      namesById.get(marketplace.id) ?? claudeMarketplaceNames(marketplace);
    for (const plugin of marketplace.plugins) {
      const install = claudeInstallOf(
        claudeEnabled,
        marketplaceNames,
        plugin.name,
      );
      if (install === undefined || covered.has(install.key)) continue;
      covered.add(install.key);
      const ref = { marketplaceId: marketplace.id, pluginName: plugin.name };
      const key = refKey(ref);
      if (excluded.has(key)) continue;
      excluded.add(key);
      refs.push({ ...ref, installPath: install.installPath });
    }
  }
  return refs;
}
