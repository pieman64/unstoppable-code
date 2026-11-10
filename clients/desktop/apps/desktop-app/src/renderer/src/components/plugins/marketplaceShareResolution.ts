import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  createMarketplaceShareResolver,
  type MarketplaceShareResolver,
} from '@canopy/desktop-shared/lib/marketplace-share-resolution';
import {
  computePluginShareableRef,
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import {
  CURATED_PLUGIN_MARKETPLACE_ID,
  type MarketplaceInfo,
} from '@canopy/execution-engine/types/plugins';
import {
  MARKETPLACE_SHARE_BLOCKED_REASONS,
  type MarketplaceEntryShareResolution,
  type MarketplaceEntryShareState,
} from '@canopy/protocol/sharing';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import type { SharedSkillSummary } from '@canopy/protocol/skills';
import {
  collectionShareBlockedState,
  pluginDisplayName,
} from '@canopy/ui-shared/lib';
import type { UnifiedPluginEntry } from '@/lib/unifiedPluginEntries';
import {
  ownedShareTargetForEntry,
  type OwnedShareSources,
  type OwnedShareTarget,
} from './useMarketplaceOwnedShare';

/**
 * Marketplace Share resolution for the desktop (CAN-3704).
 *
 * Every plugin, MCP and skill entry gets a state, whether or not it is
 * installed: an enabled Share whose target was resolved from the current
 * inventory, or a disabled one with the reason. Plugin and MCP targets use
 * the same resolver the Portal projection uses, so both hosts reach the same
 * outcome for the same inventory. Pipelines, automations, collections and
 * local agents keep their existing rule: Share only for an entry the user owns. Provider
 * connectors and other out-of-scope entries get no Share.
 */

/** What the existing plugin share dialog needs. */
export interface PluginShareTarget {
  pluginRef: ShareablePluginRef;
  name: string;
  description?: string | null;
}

/** The existing dialog an enabled Share opens. */
export type MarketplaceShareActivation =
  | { kind: 'plugin'; target: PluginShareTarget }
  | { kind: 'owned'; target: OwnedShareTarget };

/** State and target travel together, so the UI and the click cannot disagree. */
export type MarketplaceShareResolution =
  | { status: 'shareable'; activation: MarketplaceShareActivation }
  | { status: 'blocked'; reason: string };

export interface MarketplaceShareSources extends OwnedShareSources {
  marketplaces: readonly MarketplaceInfo[];
  /** Team-shared skills, whose `canUpdate` is the explicit ownership fact. */
  sharedSkills: readonly SharedSkillSummary[];
  sharedPlugins?: readonly SharedPluginSummary[];
}

export type MarketplaceEntryShareResolver = (
  entry: Pick<UnifiedPluginEntry, 'ref' | 'kind' | 'components'>,
) => MarketplaceShareResolution | null;

const REASONS = MARKETPLACE_SHARE_BLOCKED_REASONS;

function blocked(reason: string): MarketplaceShareResolution {
  return { status: 'blocked', reason };
}

/**
 * The curated marketplace a `curated-plugin` key names: the same first match
 * `curatedCatalogFromMarketplaces` uses when it builds the entry.
 */
function curatedMarketplaceId(
  marketplaces: readonly MarketplaceInfo[],
): string | undefined {
  return marketplaces.find(
    (marketplace) =>
      marketplace.curated === true ||
      marketplace.id === CURATED_PLUGIN_MARKETPLACE_ID,
  )?.id;
}

function pluginActivation(
  sharing: MarketplaceEntryShareResolution,
  marketplaces: MarketplaceShareResolver,
): MarketplaceShareResolution {
  if (sharing.status === 'blocked') return sharing;
  const target = sharing.target;
  if (target.kind !== 'plugin') return blocked(REASONS.unavailable);
  const found = marketplaces.findPlugin(
    target.marketplaceId,
    target.pluginName,
  );
  if (found.status !== 'resolved') return blocked(REASONS.unavailable);
  const pluginRef = computePluginShareableRef(
    found.match.plugin,
    found.match.marketplace,
  );
  if (!pluginRef) return blocked(REASONS.noPublicSource);
  return {
    status: 'shareable',
    activation: {
      kind: 'plugin',
      target: {
        pluginRef,
        name: target.displayName,
        description: found.match.plugin.description,
      },
    },
  };
}

/** Builds a resolver over one inventory snapshot. Rebuild when it changes. */
export function createMarketplaceEntryShareResolver(
  sources: MarketplaceShareSources,
): MarketplaceEntryShareResolver {
  const plugins = createMarketplaceShareResolver(
    sources.marketplaces,
    pluginDisplayName,
  );
  const curatedId = curatedMarketplaceId(sources.marketplaces);

  const owned = (
    entry: Pick<UnifiedPluginEntry, 'ref'>,
  ): MarketplaceShareResolution | null => {
    const target = ownedShareTargetForEntry(entry, sources);
    return target
      ? { status: 'shareable', activation: { kind: 'owned', target } }
      : null;
  };

  const skills = new Map<string, (typeof sources.skills)[number][]>();
  const remoteSkills = new Map<string, (typeof sources.skills)[number][]>();
  for (const skill of sources.skills) {
    const key = JSON.stringify([skill.sourceId, skill.name]);
    skills.set(key, [...(skills.get(key) ?? []), skill]);
    if (skill.remote)
      remoteSkills.set(skill.remote.remoteId, [
        ...(remoteSkills.get(skill.remote.remoteId) ?? []),
        skill,
      ]);
  }
  const sharedSkills = new Map(
    sources.sharedSkills.map((skill) => [skill.id, skill]),
  );
  const sharedPlugins = new Map(
    (sources.sharedPlugins ?? []).map((plugin) => [plugin.externalId, plugin]),
  );
  const pluginRefs = new Map<string, MarketplaceEntryShareResolution[]>();
  for (const marketplace of sources.marketplaces)
    for (const plugin of marketplace.plugins) {
      const ref = computePluginShareableRef(plugin, marketplace);
      if (!ref) continue;
      const key = getShareablePluginRefKey(ref);
      pluginRefs.set(key, [
        ...(pluginRefs.get(key) ?? []),
        plugins.plugin(marketplace.id, plugin.name),
      ]);
    }
  const skillTarget = (
    matches: readonly (typeof sources.skills)[number][],
  ): MarketplaceShareResolution => {
    if (matches.length !== 1) return blocked(REASONS.unavailable);
    const skill = matches[0];
    if (!skill) return blocked(REASONS.unavailable);
    const target = ownedShareTargetForEntry(
      {
        ref: { type: 'skill', sourceId: skill.sourceId, skillName: skill.name },
      },
      { ...sources, skills: [skill] },
    );
    return target
      ? { status: 'shareable', activation: { kind: 'owned', target } }
      : blocked(REASONS.unavailable);
  };

  return (entry) => {
    const ref = entry.ref;
    switch (ref.type) {
      case 'curated-plugin':
        return curatedId === undefined
          ? blocked(REASONS.unavailable)
          : pluginActivation(plugins.plugin(curatedId, ref.key), plugins);
      case 'marketplace-plugin':
        return pluginActivation(
          plugins.plugin(ref.marketplaceId, ref.pluginName),
          plugins,
        );
      // An MCP card shares the plugin folded into it; a standalone server
      // connection cannot be shared.
      case 'curated-mcp':
        return pluginActivation(plugins.mcp(ref.key), plugins);
      case 'local-mcp':
        return pluginActivation(plugins.mcp(ref.curatedKey), plugins);
      case 'mcp-server':
        return blocked(REASONS.standaloneMcp);
      case 'skill':
        return skillTarget(
          skills.get(JSON.stringify([ref.sourceId, ref.skillName])) ?? [],
        );
      case 'shared-skill': {
        const summary = sharedSkills.get(ref.skillId);
        if (summary?.canUpdate === false) return blocked(REASONS.skillOwner);
        return summary?.canUpdate === true
          ? skillTarget(remoteSkills.get(ref.skillId) ?? [])
          : blocked(REASONS.unavailable);
      }
      case 'shared-plugin': {
        const summary = sharedPlugins.get(ref.pluginId);
        if (summary?.canUpdate === false) return blocked(REASONS.pluginOwner);
        const matches =
          summary?.canUpdate === true
            ? (pluginRefs.get(summary.refKey) ?? [])
            : [];
        return matches.length === 1 && matches[0]
          ? pluginActivation(matches[0], plugins)
          : blocked(REASONS.unavailable);
      }
      case 'public-share':
        return ref.shareKind === 'skill' || ref.shareKind === 'plugin'
          ? blocked(REASONS.alreadyPublic)
          : null;
      case 'local-collection':
      case 'shared-collection':
      case 'pipeline':
      case 'automation':
      case 'local-agent':
        return owned(entry);
      default:
        return null;
    }
  };
}

/** The share key a resolution's plugin target publishes under, when it has one. */
export function pluginShareRefKey(
  resolution: MarketplaceShareResolution | null,
): string | undefined {
  return resolution?.status === 'shareable' &&
    resolution.activation.kind === 'plugin'
    ? getShareablePluginRefKey(resolution.activation.target.pluginRef)
    : undefined;
}

/** The display state a card shows for a resolution. */
export function marketplaceEntryShareState(
  entry: Pick<UnifiedPluginEntry, 'kind' | 'components'>,
  resolution: MarketplaceShareResolution | null,
): MarketplaceEntryShareState | undefined {
  // The collection restriction is unchanged: a card for a collection with MCP
  // server configs shows a disabled Share; its detail explains it in place.
  const collection = collectionShareBlockedState(entry);
  if (collection) return collection;
  if (!resolution) return undefined;
  return resolution.status === 'shareable'
    ? { status: 'shareable' }
    : { status: 'blocked', reason: resolution.reason };
}

/** Read the current cache/author inventory immediately before opening a flow. */
export async function refreshMarketplaceEntryShareResolution(
  entry: Pick<UnifiedPluginEntry, 'ref' | 'kind' | 'components'>,
  sources: MarketplaceShareSources,
): Promise<MarketplaceShareResolution | null> {
  const ref = entry.ref;
  const pluginEntry =
    ref.type === 'curated-plugin' ||
    ref.type === 'marketplace-plugin' ||
    ref.type === 'curated-mcp' ||
    ref.type === 'local-mcp' ||
    ref.type === 'shared-plugin';
  const skillEntry = ref.type === 'skill' || ref.type === 'shared-skill';
  if (!pluginEntry && !skillEntry)
    return createMarketplaceEntryShareResolver(sources)(entry);
  try {
    const cache = pluginEntry
      ? await window.plugins.loadMarketplacesCacheOnly()
      : null;
    const skills = skillEntry ? await window.skills.loadSkills() : null;
    if (pluginEntry && (!cache?.success || !cache.data))
      return blocked(REASONS.unavailable);
    if (skillEntry && (!skills?.success || !skills.data))
      return blocked(REASONS.unavailable);
    const sharedSkills =
      ref.type === 'shared-skill'
        ? [await window.skills.getShared(ref.skillId)]
        : sources.sharedSkills;
    const remotePlugin =
      ref.type === 'shared-plugin'
        ? await window.plugins.getShared({
            serverId: CANOPY_CLOUD_SERVER_ID,
            remoteId: ref.pluginId,
          })
        : null;
    if (
      ref.type === 'shared-plugin' &&
      (!remotePlugin?.success || !remotePlugin.data)
    )
      return blocked(REASONS.unavailable);
    const sharedPlugins = remotePlugin?.data
      ? [remotePlugin.data]
      : sources.sharedPlugins;
    return createMarketplaceEntryShareResolver({
      ...sources,
      marketplaces: cache?.data?.marketplaces ?? sources.marketplaces,
      skills: skills?.data ?? sources.skills,
      sharedSkills,
      sharedPlugins,
    })(entry);
  } catch {
    return blocked(REASONS.unavailable);
  }
}
