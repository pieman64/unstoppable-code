import type { MarketplaceEntryShareResolution } from '@canopy/protocol/sharing';
import { MARKETPLACE_SHARE_BLOCKED_REASONS } from '@canopy/protocol/sharing';
import {
  isCuratedPluginMarketplaceId,
  type MarketplaceInfo,
  type PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import {
  computePluginShareableRef,
  getShareablePluginRefKey,
  shareablePluginSourceLabel,
} from '@canopy/execution-engine/plugin-refs';

type PluginMatch = { marketplace: MarketplaceInfo; plugin: PluginInfo };

export type MarketplacePluginLookup =
  | { status: 'resolved'; match: PluginMatch }
  | { status: 'missing' | 'ambiguous' };

export interface MarketplaceShareResolver {
  findPlugin: (
    marketplaceId: string,
    pluginName: string,
  ) => MarketplacePluginLookup;
  plugin: (
    marketplaceId: string,
    pluginName: string,
  ) => MarketplaceEntryShareResolution;
  mcp: (curatedKey: string | undefined) => MarketplaceEntryShareResolution;
  foldedMcp: (
    plugin: PluginInfo,
  ) => { key: string; sharing: MarketplaceEntryShareResolution } | undefined;
}

/**
 * Build once per cached snapshot; neither installation nor authentication is
 * eligibility. `displayName` names a plugin target the way the host's share
 * dialog does (the shared `pluginDisplayName`), injected because this
 * package does not depend on UI packages.
 */
export function createMarketplaceShareResolver(
  marketplaces: readonly MarketplaceInfo[],
  displayName: (plugin: PluginInfo) => string,
): MarketplaceShareResolver {
  const byMarketplace = new Map<string, MarketplaceInfo[]>();
  const byPlugin = new Map<string, PluginMatch[]>();
  const folded = new Map<string, PluginMatch[]>();
  const foldedKeys = new Map<PluginInfo, string>();
  for (const marketplace of marketplaces) {
    byMarketplace.set(marketplace.id, [
      ...(byMarketplace.get(marketplace.id) ?? []),
      marketplace,
    ]);
    for (const plugin of marketplace.plugins) {
      const match = { marketplace, plugin };
      const key = JSON.stringify([marketplace.id, plugin.name.toLowerCase()]);
      byPlugin.set(key, [...(byPlugin.get(key) ?? []), match]);
      if (!marketplace.curated && !isCuratedPluginMarketplaceId(marketplace.id))
        continue;
      // Same identity and single-key fold as curatedCatalogFromMarketplaces.
      const keys = Array.from(
        new Set(
          (plugin.details?.mcpServers ?? []).map((server) => server.name),
        ),
      );
      if (keys.length !== 1) continue;
      const mcpKey = keys[0];
      if (mcpKey === undefined) continue;
      foldedKeys.set(plugin, mcpKey);
      folded.set(mcpKey, [...(folded.get(mcpKey) ?? []), match]);
    }
  }

  function findPlugin(
    marketplaceId: string,
    pluginName: string,
  ): MarketplacePluginLookup {
    const sources = byMarketplace.get(marketplaceId) ?? [];
    if (sources.length === 0) return { status: 'missing' };
    if (sources.length !== 1) return { status: 'ambiguous' };
    const candidates =
      byPlugin.get(JSON.stringify([marketplaceId, pluginName.toLowerCase()])) ??
      [];
    const exact = candidates.filter(
      (candidate) => candidate.plugin.name === pluginName,
    );
    const matches = exact.length > 0 ? exact : candidates;
    const match = matches[0];
    if (!match) return { status: 'missing' };
    if (matches.length !== 1 || match.plugin.marketplaceId !== marketplaceId)
      return { status: 'ambiguous' };
    return { status: 'resolved', match };
  }

  function plugin(
    marketplaceId: string,
    pluginName: string,
  ): MarketplaceEntryShareResolution {
    const found = findPlugin(marketplaceId, pluginName);
    if (found.status !== 'resolved')
      return {
        status: 'blocked',
        reason: MARKETPLACE_SHARE_BLOCKED_REASONS.unavailable,
      };
    const ref = computePluginShareableRef(
      found.match.plugin,
      found.match.marketplace,
    );
    if (!ref)
      return {
        status: 'blocked',
        reason: MARKETPLACE_SHARE_BLOCKED_REASONS.noPublicSource,
      };
    return {
      status: 'shareable',
      target: {
        kind: 'plugin',
        marketplaceId: found.match.marketplace.id,
        pluginName: found.match.plugin.name,
        displayName: displayName(found.match.plugin),
        sourceLabel: shareablePluginSourceLabel(ref),
        refKey: getShareablePluginRefKey(ref),
      },
    };
  }

  function mcp(
    curatedKey: string | undefined,
  ): MarketplaceEntryShareResolution {
    const candidates =
      curatedKey === undefined ? [] : (folded.get(curatedKey) ?? []);
    if (candidates.length === 0)
      return {
        status: 'blocked',
        reason: MARKETPLACE_SHARE_BLOCKED_REASONS.standaloneMcp,
      };
    const match = candidates[0];
    if (candidates.length !== 1 || !match)
      return {
        status: 'blocked',
        reason: MARKETPLACE_SHARE_BLOCKED_REASONS.unavailable,
      };
    return plugin(match.marketplace.id, match.plugin.name);
  }

  function foldedMcp(
    plugin: PluginInfo,
  ): { key: string; sharing: MarketplaceEntryShareResolution } | undefined {
    const key = foldedKeys.get(plugin);
    return key === undefined ? undefined : { key, sharing: mcp(key) };
  }

  return { findPlugin, plugin, mcp, foldedMcp };
}
