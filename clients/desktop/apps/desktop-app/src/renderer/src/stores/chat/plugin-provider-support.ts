// Cached plugin-provider-support index used to sanitize chat plugin
// selections per provider. Owns a module-level TTL cache.
import type {
  PluginProviderSupport,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import type {
  AgentProviderType,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  PLUGIN_PROVIDER_SUPPORT_INDEX_MAX_FALLBACK_AGE_MS,
  PLUGIN_PROVIDER_SUPPORT_INDEX_TTL_MS,
} from './constants';

export type PluginProviderSupportIndex = Map<string, PluginProviderSupport>;

let cachedPluginProviderSupportIndex: PluginProviderSupportIndex | null = null;

let cachedPluginProviderSupportIndexLoadedAt = 0;

let loadingPluginProviderSupportIndex: Promise<PluginProviderSupportIndex | null> | null =
  null;

export function pluginProviderSupportKey(
  marketplaceId: string,
  pluginName: string,
): string {
  return `${marketplaceId}\u0000${pluginName.toLowerCase()}`;
}

export function buildPluginProviderSupportIndex(
  cache: PluginsCache,
): PluginProviderSupportIndex {
  const index: PluginProviderSupportIndex = new Map();
  for (const marketplace of cache.marketplaces) {
    for (const plugin of marketplace.plugins) {
      index.set(
        pluginProviderSupportKey(plugin.marketplaceId, plugin.name),
        plugin.providerSupport,
      );
    }
  }
  return index;
}

export function getCachedPluginProviderSupportIndex(): PluginProviderSupportIndex | null {
  return cachedPluginProviderSupportIndex;
}

/**
 * The cached index, but only while it is recent enough to still be worth
 * trusting when a refresh has failed.
 *
 * {@link getCachedPluginProviderSupportIndex} has no expiry: it returns
 * whatever the last successful load produced, however long ago that was. That
 * is fine for callers that treat the index as a hint, but a caller deciding
 * whether a plugin may cross a provider boundary needs an upper bound. Such a
 * caller should use this and treat `null` as "unknown", not as "allowed".
 *
 * The age measured is when THIS RENDERER loaded the index, not when the
 * marketplace inventory behind it was refreshed — `loadMarketplaces` serves a
 * v2 disk cache and keeps its own `lastRefreshed`. See
 * `PLUGIN_PROVIDER_SUPPORT_INDEX_MAX_FALLBACK_AGE_MS` for why that is the right
 * measure here rather than a weaker one.
 */
export function getFreshEnoughPluginProviderSupportIndex(): PluginProviderSupportIndex | null {
  if (!cachedPluginProviderSupportIndex) return null;
  const age = Date.now() - cachedPluginProviderSupportIndexLoadedAt;
  return age <= PLUGIN_PROVIDER_SUPPORT_INDEX_MAX_FALLBACK_AGE_MS
    ? cachedPluginProviderSupportIndex
    : null;
}

/**
 * Monotonic id for each load. A load may only publish its result or clear the
 * memo while it is still the current one, which is what makes an abandoned
 * request inert rather than merely un-awaited.
 */
let pluginProviderSupportLoadGeneration = 0;

/**
 * The current load generation, for a caller to capture BEFORE it awaits.
 *
 * Pair with {@link invalidatePluginProviderSupportIndexLoad} so a caller can
 * only retire the load it was actually waiting on.
 */
export function getPluginProviderSupportLoadGeneration(): number {
  return pluginProviderSupportLoadGeneration;
}

/**
 * Drop the in-flight load so the NEXT call starts a fresh request, and retire
 * it so its eventual settlement cannot affect anything.
 *
 * `loadPluginProviderSupportIndex` memoizes the pending promise and clears it
 * only in that promise's own `finally`. If the underlying bridge call never
 * settles, the memo is permanent and every later caller is handed the same hung
 * promise — so a caller that gave up on its own timeout can never actually
 * retry. Such a caller must invalidate here, or its retry is a no-op.
 *
 * Pass `expectedGeneration` (from {@link getPluginProviderSupportLoadGeneration},
 * captured before awaiting) so a caller can only retire the load it was actually
 * waiting on.
 *
 * Bumping the generation is the other half, and it is not cosmetic. Without it
 * an abandoned request that settles LATE would still run its `then`/`finally`
 * against live state: it could publish its (older) marketplace snapshot over a
 * newer one that already resolved, and its unconditional `finally` could evict
 * a newer caller's in-flight promise, silently costing the single-flight
 * dedup this module exists to provide.
 */
export function invalidatePluginProviderSupportIndexLoad(
  expectedGeneration?: number,
): void {
  // Scoped to the load the caller actually awaited.
  //
  // Without this an OLDER waiter can retire a NEWER request. Two staggered
  // continues share load A; the first times out, retires A and starts retry B;
  // the second then times out on its own (later) deadline and, unconditionally,
  // retires B — so B resolves to `null` and publishes nothing, and the retry the
  // failure message promised fails even though its marketplace call succeeded.
  if (
    expectedGeneration !== undefined &&
    expectedGeneration !== pluginProviderSupportLoadGeneration
  ) {
    return;
  }
  pluginProviderSupportLoadGeneration += 1;
  loadingPluginProviderSupportIndex = null;
}

export async function loadPluginProviderSupportIndex(): Promise<PluginProviderSupportIndex | null> {
  if (
    cachedPluginProviderSupportIndex &&
    Date.now() - cachedPluginProviderSupportIndexLoadedAt <
      PLUGIN_PROVIDER_SUPPORT_INDEX_TTL_MS
  ) {
    return cachedPluginProviderSupportIndex;
  }

  if (loadingPluginProviderSupportIndex) {
    return loadingPluginProviderSupportIndex;
  }

  if (
    typeof window === 'undefined' ||
    typeof window.plugins?.loadMarketplaces !== 'function'
  ) {
    return null;
  }

  const generation = pluginProviderSupportLoadGeneration;
  const isCurrent = (): boolean =>
    generation === pluginProviderSupportLoadGeneration;

  const load: Promise<PluginProviderSupportIndex | null> = window.plugins
    .loadMarketplaces()
    .then((result) => {
      if (!result.success || !result.data) {
        return null;
      }
      // A retired load resolves to `null`, not to its own (older) index.
      //
      // Callers already awaiting this shared promise when it was retired would
      // otherwise be handed a snapshot that a newer load has since superseded,
      // silently bypassing both the fresher cache and the bounded fallback.
      // Reachable with concurrent continues: one times out and invalidates
      // while another is still inside its own timeout on the same promise.
      // `null` routes those callers back through their own policy, which for
      // the continue path means the bounded cache or a fail-closed refusal.
      if (!isCurrent()) {
        return null;
      }
      const index = buildPluginProviderSupportIndex(result.data);
      cachedPluginProviderSupportIndex = index;
      cachedPluginProviderSupportIndexLoadedAt = Date.now();
      return index;
    })
    .catch(() => null)
    .finally(() => {
      if (loadingPluginProviderSupportIndex === load) {
        loadingPluginProviderSupportIndex = null;
      }
    });

  loadingPluginProviderSupportIndex = load;
  return load;
}

export function providerAllowsPluginSupport(
  support: PluginProviderSupport,
  providerType: AgentProviderType | undefined,
): boolean {
  // Without a resolved provider, filtering would silently reinterpret a stale
  // model as Claude and could discard selections before registry hydration.
  if (!providerType) return true;
  if (providerType === 'codex') {
    return support.codex !== 'none';
  }
  return support.claude === 'native';
}

export function sanitizePluginSelectionsForProvider(
  selections: ChatTabPluginSelections | undefined,
  providerType: AgentProviderType | undefined,
  supportIndex: PluginProviderSupportIndex | null,
): ChatTabPluginSelections | undefined {
  if (!selections || !supportIndex || selections.pluginRefs.length === 0) {
    return selections;
  }

  const removedPluginKeys = new Set<string>();
  const pluginRefs = selections.pluginRefs.filter((ref) => {
    const key = pluginProviderSupportKey(ref.marketplaceId, ref.pluginName);
    const support = supportIndex.get(key);
    if (!support || providerAllowsPluginSupport(support, providerType)) {
      return true;
    }
    removedPluginKeys.add(key);
    return false;
  });

  if (removedPluginKeys.size === 0) {
    return selections;
  }

  const mcpHttpAuthPreferences = selections.mcpHttpAuthPreferences?.filter(
    (preference) => {
      const { target } = preference;
      return (
        target.kind !== 'plugin' ||
        !removedPluginKeys.has(
          pluginProviderSupportKey(target.marketplaceId, target.pluginName),
        )
      );
    },
  );

  const nextSelections: ChatTabPluginSelections = {
    ...selections,
    pluginRefs,
  };
  if (mcpHttpAuthPreferences && mcpHttpAuthPreferences.length > 0) {
    nextSelections.mcpHttpAuthPreferences = mcpHttpAuthPreferences;
  } else {
    delete nextSelections.mcpHttpAuthPreferences;
  }
  return nextSelections;
}

export function sanitizePluginSelectionsWithCachedSupport(
  selections: ChatTabPluginSelections | undefined,
  providerType: AgentProviderType | undefined,
): ChatTabPluginSelections | undefined {
  return sanitizePluginSelectionsForProvider(
    selections,
    providerType,
    getCachedPluginProviderSupportIndex(),
  );
}
