import { useCallback, useEffect, useRef } from 'react';
import {
  localAgentEntryId,
  type UnifiedEntryRef,
} from '@canopy/protocol/unified-entry';
import {
  pendingLocalAgentEntry,
  type UnifiedPluginEntry,
} from './unifiedPluginEntries';

/**
 * An item the user just created from Customize > Add custom, named by what
 * its create dialog learns on success.
 */
export type CreatedCustomItem =
  | { readonly kind: 'skill'; readonly sourceId: string; readonly name: string }
  | {
      readonly kind: 'mcp-server';
      readonly serverId: string;
      /** The account configuration it was connected under, when it has one. */
      readonly configId?: string;
      /** The catalog key it was added under, whose card lists it. */
      readonly curatedKey?: string;
    }
  | { readonly kind: 'collection'; readonly collectionId: string }
  | { readonly kind: 'agent'; readonly agentId: string };

/**
 * How long a created item may take to list before its detail no longer
 * opens, so a slow refresh never pulls the user away from wherever they went
 * next.
 */
const CREATED_ITEM_OPEN_WINDOW_MS = 15_000;

function refNamesCreatedItem(
  ref: UnifiedEntryRef,
  item: CreatedCustomItem,
): boolean {
  switch (item.kind) {
    case 'skill':
      return (
        ref.type === 'skill' &&
        ref.sourceId === item.sourceId &&
        ref.skillName === item.name
      );
    case 'mcp-server':
      if (ref.type === 'curated-mcp') return ref.key === item.curatedKey;
      return (
        ref.type === 'local-mcp' &&
        ref.serverId === item.serverId &&
        (item.configId === undefined ||
          ref.configId === undefined ||
          ref.configId === item.configId)
      );
    case 'collection':
      return (
        ref.type === 'local-collection' &&
        ref.collectionId === item.collectionId
      );
    case 'agent':
      return ref.type === 'local-agent' && ref.agentId === item.agentId;
  }
}

/** The listed row whose detail shows a created item, once it is listed. */
export function findCreatedCustomEntry(
  entries: readonly UnifiedPluginEntry[],
  item: CreatedCustomItem,
): UnifiedPluginEntry | undefined {
  return entries.find((entry) => refNamesCreatedItem(entry.ref, item));
}

/**
 * After a successful create from Customize > Add custom, opens the new item's
 * detail the way clicking its row does, so the user
 * sees where it went. The host passes its row-click handler; the item opens
 * as soon as the host's list includes it, once, and never after
 * {@link CREATED_ITEM_OPEN_WINDOW_MS}.
 */
export function useOpenCreatedCustomItem(
  entries: readonly UnifiedPluginEntry[],
  openEntry: (entry: UnifiedPluginEntry) => void,
): (item: CreatedCustomItem) => void {
  const pendingRef = useRef<{
    item: CreatedCustomItem;
    expiresAt: number;
  } | null>(null);
  const latestRef = useRef({ entries, openEntry });
  useEffect(() => {
    latestRef.current = { entries, openEntry };
    const pending = pendingRef.current;
    if (pending === null) return;
    if (Date.now() > pending.expiresAt) {
      pendingRef.current = null;
      return;
    }
    const entry = findCreatedCustomEntry(entries, pending.item);
    if (!entry) return;
    pendingRef.current = null;
    openEntry(entry);
  }, [entries, openEntry]);

  return useCallback((item: CreatedCustomItem): void => {
    const latest = latestRef.current;
    // An agent's detail resolves its definition by id, the way a deep link
    // opens one, so it never waits on an agent list the host may not load.
    const entry =
      findCreatedCustomEntry(latest.entries, item) ??
      (item.kind === 'agent'
        ? pendingLocalAgentEntry(localAgentEntryId(item.agentId))
        : null);
    if (entry) {
      pendingRef.current = null;
      latest.openEntry(entry);
      return;
    }
    pendingRef.current = {
      item,
      expiresAt: Date.now() + CREATED_ITEM_OPEN_WINDOW_MS,
    };
  }, []);
}
