import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import {
  isPluginServerResult,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import { listedAsItsPlugin } from './marketplaceBrowse';
import { unifiedEntryIdForRef } from './unified-entry-id';

const NO_ENTRY_IDS: ReadonlySet<string> = new Set();

/**
 * The plugin shares an MCP card represents: their `refKey` is the exact share
 * target of a card listed as an MCP server. Hosts resolve each card's target.
 * Never mutate the result: every empty join returns the same set.
 */
export function mcpSharedPluginEntryIds(
  entries: readonly UnifiedPluginEntry[],
  sharedPlugins: readonly Pick<SharedPluginSummary, 'externalId' | 'refKey'>[],
  refKeyOf: (entry: UnifiedPluginEntry) => string | undefined,
): ReadonlySet<string> {
  if (sharedPlugins.length === 0) return NO_ENTRY_IDS;
  const cardKeys = new Set<string>();
  for (const entry of entries) {
    if (
      entry.kind !== 'app' ||
      listedAsItsPlugin(entry) ||
      isPluginServerResult(entry)
    )
      continue;
    const key = refKeyOf(entry);
    if (key) cardKeys.add(key);
  }
  const ids = new Set<string>();
  for (const share of sharedPlugins) {
    if (!share.refKey || !cardKeys.has(share.refKey)) continue;
    const id = unifiedEntryIdForRef({
      type: 'shared-plugin',
      pluginId: share.externalId,
    });
    if (id !== null) ids.add(id);
  }
  return ids.size > 0 ? ids : NO_ENTRY_IDS;
}
