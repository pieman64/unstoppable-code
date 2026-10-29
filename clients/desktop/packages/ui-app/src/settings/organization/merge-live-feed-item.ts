// ---------------------------------------------------------------------------
// Pure live-merge helpers for the realtime team feed (CAN-389).
//
// Extracted into a dependency-free module so the merge/dedupe/filter logic can
// be unit-tested directly (web jest is node-env / SSR — no DOM). The component
// owns the buffering ("N new") and pause/resume decisions; this module only
// answers "does this live item match the client-applicable filters?" and "how
// does it fold into the current list?".
// ---------------------------------------------------------------------------

import type { FeedItem } from '@canopy/protocol';
import type { TeamFeedFilters } from './team-api';

/**
 * Whether a live item matches the filters the client *can* apply locally:
 * activity type and actor (member). The free-text search (`q`) is server-side
 * only and is intentionally NOT evaluated here — when a search query is active
 * the consumer must fall back to the "N new" affordance instead of merging,
 * because the client cannot faithfully replicate the server's ILIKE matching.
 */
export function feedItemMatchesClientFilters(
  item: FeedItem,
  filters: TeamFeedFilters,
): boolean {
  if (
    filters.types &&
    filters.types.length > 0 &&
    !filters.types.includes(item.type)
  ) {
    return false;
  }
  if (filters.actorId && item.actor.userId !== filters.actorId) {
    return false;
  }
  return true;
}

/**
 * Compare two feed items by the server's deterministic listing order:
 * `occurred_at DESC, item_type ASC, source_id DESC` (see `feed-query.ts`).
 * Returns < 0 when `a` sorts before `b` (i.e. higher up the newest-first list).
 *
 * `occurredAt` is ISO-8601 in UTC (`…Z`), so a lexicographic string compare is
 * equivalent to a chronological one without parsing. The client does not carry
 * the numeric `source_id`, so the stable permalink `id` (`type:externalId`)
 * stands in as the final, deterministic tiebreak — it only matters when two
 * items share both an exact instant and a type, which is cosmetically
 * irrelevant but keeps insertion stable.
 */
function compareFeedListOrder(a: FeedItem, b: FeedItem): number {
  if (a.occurredAt !== b.occurredAt) {
    // Later instant first.
    return a.occurredAt < b.occurredAt ? 1 : -1;
  }
  if (a.type !== b.type) {
    // item_type ASC.
    return a.type < b.type ? -1 : 1;
  }
  if (a.id !== b.id) {
    // source_id DESC (approximated by id DESC).
    return a.id < b.id ? 1 : -1;
  }
  return 0;
}

/**
 * Fold a live feed item into the current list: dedupe by `item.id` (replacing
 * any existing copy so in-place "updated" types like `plan_updated` /
 * `worktree_updated` refresh their content) and splice the item into its
 * correct chronological position rather than blindly prepending.
 *
 * SSE frames can arrive out of order — a backfilled or slightly delayed item
 * may carry an `occurredAt` older than items already on screen. Prepending such
 * an item put it above newer ones and broke the newest-first invariant the
 * server establishes on first load (CAN-389 regression). We instead insert it
 * where the server's `(occurred_at DESC, item_type ASC, source_id DESC)`
 * ordering would place it, leaving the relative order of existing items intact.
 *
 * Items that fail the client-applicable filters are dropped (list returned
 * unchanged). Callers must NOT invoke this while a search query is active —
 * gate on that and buffer instead.
 */
export function mergeLiveFeedItem(
  items: FeedItem[],
  item: FeedItem,
  filters: TeamFeedFilters,
): FeedItem[] {
  if (!feedItemMatchesClientFilters(item, filters)) {
    return items;
  }
  const withoutDuplicate = items.filter((existing) => existing.id !== item.id);
  const insertAt = withoutDuplicate.findIndex(
    (existing) => compareFeedListOrder(item, existing) < 0,
  );
  if (insertAt === -1) {
    return [...withoutDuplicate, item];
  }
  return [
    ...withoutDuplicate.slice(0, insertAt),
    item,
    ...withoutDuplicate.slice(insertAt),
  ];
}
