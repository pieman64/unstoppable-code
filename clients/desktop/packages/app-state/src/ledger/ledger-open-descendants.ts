import type { LedgerClient } from '@canopy/app-core';
import type {
  LedgerEntriesSearchResult,
  LedgerEntrySearchItem,
  LedgerStatus,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerViewEntry,
  LedgerViewResult,
  LedgerViewScope,
  LedgerViewSearchRequest,
} from '@canopy/protocol/ledger-view';
import { thrownResult } from './ledger-view-results';

/** The statuses a task can still be worked in. */
export const LEDGER_OPEN_TASK_STATUSES: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
];

const PAGE_LIMIT = 100;
/** Pages of a nested entry's tree read before its count becomes a bound. */
const TREE_PAGE_LIMIT = 20;
/** Ancestors climbed to find a nested entry's top-level entry. */
const ANCESTOR_LIMIT = 20;

/** How many entries under an entry are still open, at any depth. */
export interface LedgerOpenDescendants {
  readonly count: number;
  /** More may be open than were counted. */
  readonly lowerBound: boolean;
}

const UNCHECKED = {
  status: 'error',
  reason: 'UNKNOWN',
  message: "Couldn't check this entry's open tasks.",
} as const;

/**
 * Counts the open entries under one entry, at any depth, including those under
 * closed tasks. A root search only matches the top of a tree, so a nested
 * entry (one with `parentEntryId`) first climbs to its top-level entry, then
 * reads that whole tree and counts below the entry.
 */
export async function readLedgerOpenDescendants(
  client: Pick<LedgerClient, 'searchEntries' | 'getEntry'>,
  scope: LedgerViewScope,
  entryId: string,
  parentEntryId: string | undefined,
): Promise<LedgerViewResult<LedgerOpenDescendants>> {
  const search = async (
    params: LedgerViewSearchRequest['params'],
  ): Promise<LedgerViewResult<LedgerEntriesSearchResult>> => {
    try {
      return await client.searchEntries({ scope, params });
    } catch (error) {
      return thrownResult(error);
    }
  };
  if (parentEntryId === undefined) {
    const result = await search({
      rootEntryId: entryId,
      statuses: [...LEDGER_OPEN_TASK_STATUSES],
      limit: PAGE_LIMIT,
    });
    if (result.status !== 'ok') return result;
    // A root search includes the root itself; a further page proves at least
    // one open entry beneath it.
    const counted = result.value.entries.filter(
      (entry) => entry.entryId !== entryId,
    ).length;
    return {
      status: 'ok',
      value: {
        count: Math.max(counted, result.value.hasMore ? 1 : 0),
        lowerBound: result.value.hasMore,
      },
    };
  }

  let rootEntryId: string | null = null;
  let ancestor = parentEntryId;
  for (let climbed = 0; climbed < ANCESTOR_LIMIT; climbed += 1) {
    let read: LedgerViewResult<LedgerViewEntry>;
    try {
      read = await client.getEntry({ scope, entryId: ancestor });
    } catch (error) {
      read = thrownResult(error);
    }
    if (read.status !== 'ok') return read;
    const next = read.value.entry.entry.parentEntryId;
    if (next === undefined) {
      rootEntryId = ancestor;
      break;
    }
    ancestor = next;
  }
  if (rootEntryId === null) return UNCHECKED;

  const tree: LedgerEntrySearchItem[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < TREE_PAGE_LIMIT; page += 1) {
    const result = await search({
      rootEntryId,
      limit: PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (result.status !== 'ok') return result;
    tree.push(...result.value.entries);
    if (!result.value.hasMore || result.value.nextCursor === null) {
      complete = true;
      break;
    }
    cursor = result.value.nextCursor;
  }

  const children = new Map<string, LedgerEntrySearchItem[]>();
  for (const entry of tree) {
    if (entry.parentEntryId === undefined) continue;
    const siblings = children.get(entry.parentEntryId) ?? [];
    siblings.push(entry);
    children.set(entry.parentEntryId, siblings);
  }
  let count = 0;
  const below = [entryId];
  for (let next = below.pop(); next !== undefined; next = below.pop()) {
    for (const child of children.get(next) ?? []) {
      if (LEDGER_OPEN_TASK_STATUSES.includes(child.status)) count += 1;
      below.push(child.entryId);
    }
  }
  // Never report "nothing open" for a tree that wasn't read to the end.
  if (!complete && count === 0) return UNCHECKED;
  return { status: 'ok', value: { count, lowerBound: !complete } };
}
