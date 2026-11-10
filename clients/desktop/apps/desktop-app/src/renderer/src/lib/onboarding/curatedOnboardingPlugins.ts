import { pluginDisplayName } from '@canopy/ui-shared';
// ---------------------------------------------------------------------------
// Pure selection helpers behind the onboarding wizard's curated-plugins step.
//
// The step's whole mutation is `PreferencesData.globalPluginSelections`:
// `global-plugin-overlay.ts` resolves every chat as
// `local ∪ (global − project tombstones − chat tombstones)` at read time, so
// a plugin selected here is enabled in workspaces and worktrees the user has
// not created yet, and any one of them can still turn it off from its plugin
// picker. Curated plugins are materialized locally by the curated sync engine
// and carry no `externalSource`, so nothing needs installing first.
//
// Kept free of React and IPC so the selection/merge rules are testable as
// plain data transforms.
// ---------------------------------------------------------------------------

import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  MarketplaceInfo,
  PluginInfo,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import {
  isBuiltInPluginMarketplaceId,
  isCuratedPluginMarketplaceId,
} from '@canopy/execution-engine/types/plugins';
import type { ShareablePluginRef } from '@canopy/protocol';
import { normalizeGitHubRepoRef } from '@canopy/protocol/plugins';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';

/** Codex's locally bundled catalog, available even without Canopy Cloud. */
const CODEX_BUNDLED_MARKETPLACE_ID = 'openai-curated';

/** One curated plugin row as rendered by the onboarding step. */
export interface CuratedOnboardingPlugin {
  /** Selection key: case-folded `${marketplaceId}/${name}`. */
  key: string;
  marketplaceId: string;
  /** Stable provider/install key — what gets written into `pluginRefs`. */
  name: string;
  /** Label shown to the user. */
  displayName: string;
  description: string;
  /** Server-computed match against the user's onboarding role. */
  recommended: boolean;
}

/**
 * Case-folded selection key for a plugin ref. Plugin resolution and the global
 * overlay both match plugin names case-insensitively, so comparisons here do
 * the same; the original `name` is preserved separately for what is persisted.
 */
export function curatedPluginKey(
  marketplaceId: string,
  pluginName: string,
): string {
  return `${marketplaceId}/${pluginName}`.toLowerCase();
}

/**
 * Curated plugins from a marketplace cache, ordered the way the step presents
 * them: recommended first (mirroring `PluginsPage`), then by display name so
 * the list is stable across reloads.
 */
export function selectCuratedOnboardingPlugins(
  cache: PluginsCache | null,
): CuratedOnboardingPlugin[] {
  return selectOnboardingPlugins(cache, (marketplaceId) =>
    isCuratedPluginMarketplaceId(marketplaceId),
  );
}

/**
 * Plugin recommendations may use both the Canopy-curated catalog and the
 * Codex catalog bundled with the desktop app. Keeping this broader selector
 * separate prevents the onboarding wizard's curated-cloud mutation rules
 * from accidentally treating every Codex bundle as cloud-curated.
 */
export function selectBundledOnboardingPlugins(
  cache: PluginsCache | null,
): CuratedOnboardingPlugin[] {
  return selectOnboardingPlugins(
    cache,
    (marketplaceId) =>
      isCuratedPluginMarketplaceId(marketplaceId) ||
      marketplaceId === CODEX_BUNDLED_MARKETPLACE_ID,
  );
}

/**
 * The plugins a curated project template bundles (CAN-3032), resolved the
 * way the seed resolves them: each ref against the marketplaces its own
 * source names, taking the first that carries the plugin, never a
 * same-named plugin from somewhere else. Rows keep template order. Refs
 * whose marketplace or plugin is not cached are dropped: an item nothing
 * can enable is not actionable.
 */
export function selectBlueprintOnboardingPlugins(
  cache: PluginsCache | null,
  refs: readonly ShareablePluginRef[],
): CuratedOnboardingPlugin[] {
  if (!cache || refs.length === 0) return [];
  const rows: CuratedOnboardingPlugin[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.type === 'skill') continue;
    const wanted = ref.plugin_name.trim().toLowerCase();
    let plugin: PluginInfo | undefined;
    for (const marketplace of marketplacesForTemplateRef(cache, ref)) {
      plugin = marketplace.plugins.find(
        (entry) =>
          entry.name.trim().toLowerCase() === wanted &&
          (ref.marketplace.type !== 'github' || seedWouldEnable(entry)),
      );
      if (plugin) break;
    }
    if (!plugin) continue;
    const key = curatedPluginKey(plugin.marketplaceId, plugin.name);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      marketplaceId: plugin.marketplaceId,
      name: plugin.name,
      displayName: pluginDisplayName(plugin),
      description: plugin.description ?? '',
      recommended: plugin.recommended === true,
    });
  }
  return rows;
}

/**
 * The cached marketplaces a template ref's source names, in cache order,
 * mirroring the main process's seed-time resolution
 * (`shareable-plugin-resolution.ts`): every built-in marketplace for a
 * built-in ref, every marketplace whose source URL is the ref's GitHub repo,
 * and the Codex marketplace with the ref's id.
 */
function marketplacesForTemplateRef(
  cache: PluginsCache,
  ref: Exclude<ShareablePluginRef, { type: 'skill' }>,
): MarketplaceInfo[] {
  if (ref.type === 'codex_plugin') {
    const id = ref.marketplace.id.trim().toLowerCase();
    return cache.marketplaces.filter(
      (marketplace) => marketplace.id.trim().toLowerCase() === id,
    );
  }
  if (ref.marketplace.type === 'builtin') {
    return cache.marketplaces.filter(
      (marketplace) =>
        isBuiltInPluginMarketplaceId(marketplace.id) ||
        marketplace.builtIn === true,
    );
  }
  let repo: string;
  try {
    repo = normalizeGitHubRepoRef(ref.marketplace.repo);
  } catch {
    return [];
  }
  return cache.marketplaces.filter(
    (marketplace) => gitHubRepoFromSourceUrl(marketplace.sourceUrl) === repo,
  );
}

/**
 * The seed skips an external GitHub plugin that is not cached locally
 * unless it has a native Codex facet, and moves on to the next marketplace
 * for the same repo; so does this, so a row never names a copy the seed
 * never enabled. An approximation: the seed also stats `cachePath`, which
 * the renderer cannot, so a copy whose cache directory was deleted since
 * the cache was written still reads as cached here.
 */
function seedWouldEnable(plugin: PluginInfo): boolean {
  if (!plugin.externalSource || plugin.cachePath) return true;
  return (
    plugin.facets.codex?.provider === 'codex' &&
    plugin.facets.codex.mode === 'native'
  );
}

/**
 * `owner/repo` for a GitHub-backed marketplace source URL, accepting the
 * same forms the main process's GitHub source parser does: a github.com
 * URL, `github.com/owner/repo`, or bare `owner/repo`, each with an optional
 * `.git` suffix.
 */
function gitHubRepoFromSourceUrl(sourceUrl: string): string | undefined {
  const trimmed = sourceUrl.trim();
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/[^/]+(?:\/.+)?)?\/?$/i.exec(
      trimmed,
    ) ??
    /^(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed) ??
    /^([^/\s]+)\/([^/\s@]+)$/.exec(trimmed);
  if (!match) return undefined;
  try {
    return normalizeGitHubRepoRef(`${match[1]}/${match[2]}`);
  } catch {
    return undefined;
  }
}

function selectOnboardingPlugins(
  cache: PluginsCache | null,
  includesMarketplace: (marketplaceId: string) => boolean,
): CuratedOnboardingPlugin[] {
  if (!cache) return [];
  const rows: CuratedOnboardingPlugin[] = [];
  for (const marketplace of cache.marketplaces) {
    if (!includesMarketplace(marketplace.id)) continue;
    for (const plugin of marketplace.plugins) {
      rows.push({
        key: curatedPluginKey(plugin.marketplaceId, plugin.name),
        marketplaceId: plugin.marketplaceId,
        name: plugin.name,
        displayName: pluginDisplayName(plugin),
        description: plugin.description ?? '',
        recommended: plugin.recommended === true,
      });
    }
  }
  return rows.sort((left, right) => {
    if (left.recommended !== right.recommended) {
      return left.recommended ? -1 : 1;
    }
    return left.displayName.localeCompare(right.displayName);
  });
}

/**
 * Keys checked when the step opens: everything the catalog recommends, plus
 * anything the user already enabled globally, so a replay from Settings surfaces
 * what is currently on rather than only the defaults.
 *
 * Note the asymmetry: an *addition* the user made persists (it comes back
 * through `globalSelections`), but a recommendation they explicitly unchecked
 * is not recorded anywhere, so it is offered pre-checked again on a later
 * replay. Suppressing re-offers would need a persisted "declined" set, which
 * this step deliberately does not introduce.
 */
export function initialCuratedPluginSelection(
  plugins: readonly CuratedOnboardingPlugin[],
  globalSelections: ChatTabPluginSelections,
): string[] {
  const alreadyEnabled = new Set(
    normalizePluginSelections(globalSelections).pluginRefs.map((ref) =>
      curatedPluginKey(ref.marketplaceId, ref.pluginName),
    ),
  );
  return plugins
    .filter((plugin) => plugin.recommended || alreadyEnabled.has(plugin.key))
    .map((plugin) => plugin.key);
}

/**
 * Applies the step's answer to the global selections. The step is authoritative
 * over exactly the rows it displayed: a curated plugin the user unchecked is
 * removed, while every other selection is preserved untouched — collections,
 * skills, MCP servers, other marketplaces' plugins, *and* curated refs that
 * were not in the catalog this step rendered.
 *
 * That last case matters. The catalog is read from the plugins cache, so any
 * cache-versus-disk drift (or a catalog that shrank between runs) yields a
 * short list; treating the curated marketplace as authoritative wholesale would
 * then globally disable curated plugins the user was never shown and never
 * declined. Scoping authority to displayed rows keeps the intended "uncheck to
 * remove" behavior while making the merge safe against a partial read.
 */
export function mergeCuratedPluginSelections(
  globalSelections: ChatTabPluginSelections,
  plugins: readonly CuratedOnboardingPlugin[],
  checkedKeys: readonly string[],
): ChatTabPluginSelections {
  const normalized = normalizePluginSelections(globalSelections);
  const checked = new Set(checkedKeys);
  const displayed = new Set(plugins.map((plugin) => plugin.key));
  const preserved = normalized.pluginRefs.filter(
    (ref) =>
      !displayed.has(curatedPluginKey(ref.marketplaceId, ref.pluginName)),
  );
  const selected = plugins
    .filter((plugin) => checked.has(plugin.key))
    .map((plugin) => ({
      marketplaceId: plugin.marketplaceId,
      pluginName: plugin.name,
    }));
  return { ...normalized, pluginRefs: [...preserved, ...selected] };
}
