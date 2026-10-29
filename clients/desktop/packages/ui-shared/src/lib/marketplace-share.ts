import type { MarketplaceEntryShareState } from '@canopy/protocol/sharing';
import { MCP_SHARE_BLOCKED_MESSAGE } from '@canopy/protocol/collections';
import type { UnifiedPluginEntry } from './unified-plugin-entry';

export type { MarketplaceEntryShareState } from '@canopy/protocol/sharing';

/**
 * A detail surface's Share action on a host with sharing capability: an
 * enabled callback or the reason sharing is unavailable. Omitting the action
 * means the host cannot share at all, and no Share renders.
 */
export type MarketplaceShareAction =
  | { status: 'shareable'; onShare: () => void }
  | { status: 'blocked'; reason: string };

/** Entry states keyed by unified entry id, as the discovery list reads them. */
export type MarketplaceEntryShareStates = ReadonlyMap<
  string,
  MarketplaceEntryShareState
>;

/**
 * The existing collection restriction: a collection carrying MCP server
 * configs cannot be shared, and says so on a disabled Share.
 */
export function collectionShareBlockedState(
  entry: Pick<UnifiedPluginEntry, 'kind' | 'components'>,
): MarketplaceEntryShareState | undefined {
  return entry.kind === 'collection' && entry.components.mcpServers > 0
    ? { status: 'blocked', reason: MCP_SHARE_BLOCKED_MESSAGE }
    : undefined;
}

/** Builds a detail action from a state and the host's activation callback. */
export function marketplaceShareAction(
  state: MarketplaceEntryShareState | undefined,
  onShare: () => void,
): MarketplaceShareAction | undefined {
  if (!state) return undefined;
  return state.status === 'shareable'
    ? { status: 'shareable', onShare }
    : { status: 'blocked', reason: state.reason };
}
