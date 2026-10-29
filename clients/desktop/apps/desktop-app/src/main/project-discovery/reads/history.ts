import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import type {
  HistoryResult,
  VisibleMessage,
} from '@canopy/desktop-shared/lib/project-reads';
import {
  isVisibleReadMessage,
  serializeVisibleReadMessage,
  visibleMessageRawText,
} from '@canopy/desktop-shared/lib/chat-history-serialization';
import type { ChatReadAddress, ChatReadContext } from '../chat-target';
import { DiscoveryError } from '../errors';
import type { ReadCursor, ReadLocator } from './cursor-store';
import {
  RAW_PAGE_BUDGET,
  turnLookup,
  type TranscriptReader,
} from './transcript';

interface LocatedMessage {
  message: VisibleMessage;
  source: TranscriptPage['messages'][number];
  ordinal: number;
  locator: ReadLocator;
}
export type ChatHistoryResult<TAddress extends ChatReadAddress> = Omit<
  HistoryResult,
  'address'
> & { address: TAddress };

export interface HistoryScan<TAddress extends ChatReadAddress> {
  result: Omit<ChatHistoryResult<TAddress>, 'nextCursor'>;
  next: ReadLocator | null;
}

type HistoryReadAction = {
  query?: string;
  roles?: VisibleMessage['role'][];
  pageSize: number;
  order: 'asc' | 'desc';
};

/** Walk exclusive raw ordinals; sticky human supplements are never messages. */
export async function readHistory<TContext extends ChatReadContext>(
  action: HistoryReadAction,
  reader: TranscriptReader,
  context: TContext,
  cursor?: ReadCursor,
): Promise<HistoryScan<TContext['address']>> {
  let before = action.order === 'desc' ? cursor?.locator.before : undefined;
  let offset = action.order === 'desc' ? (cursor?.locator.offset ?? 0) : 0;
  const fromBeginning = before === undefined && offset === 0;
  const turnIdAt = turnLookup(reader, before);
  const items: VisibleMessage[] = [];
  const oldestCandidates: LocatedMessage[] = [];
  let visibleCount = 0;
  let matchCount = 0;
  let exhausted = false;
  let next: ReadLocator | null = null;
  const query = action.query?.toLowerCase();
  let ascendingBoundary: number | undefined;

  for (let reads = 0; reads < RAW_PAGE_BUDGET; reads += 1) {
    const page = await reader.readPage({ before });
    const end = before ?? page.totalMessages;
    const start = page.before ?? 0;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > end ||
      (page.before !== undefined && start >= end) ||
      page.messages.length !== end - start ||
      offset > page.messages.length
    ) {
      throw new DiscoveryError(
        'execution_failed',
        'Transcript page could not be read or did not advance.',
      );
    }
    if (action.order === 'asc' && cursor && ascendingBoundary === undefined) {
      ascendingBoundary =
        (cursor.locator.before ?? page.totalMessages) -
        1 -
        cursor.locator.offset;
    }
    const descending = [...page.messages].reverse();
    for (let index = offset; index < descending.length; index += 1) {
      const source = descending[index];
      if (!source) continue;
      const ordinal =
        page.messageOrdinals?.[source.id] ??
        (before ?? page.totalMessages) - 1 - index;
      if (!isVisibleReadMessage(source)) continue;
      const rawText = visibleMessageRawText(source);
      if (!rawText) continue;
      visibleCount += 1;
      if (action.roles && !action.roles.includes(source.role)) continue;
      if (query && !rawText.toLowerCase().includes(query)) continue;
      matchCount += 1;
      if (action.order === 'asc') {
        const message = serializeVisibleReadMessage(source);
        if (!message) continue;
        if (ascendingBoundary !== undefined && ordinal < ascendingBoundary)
          continue;
        oldestCandidates.push({
          message,
          source,
          ordinal,
          locator: { before, offset: index },
        });
        // Only retain the oldest page plus one lookahead; no whole-history cache.
        if (oldestCandidates.length > action.pageSize + 1)
          oldestCandidates.shift();
      } else {
        const message = serializeVisibleReadMessage(
          source,
          await turnIdAt(ordinal),
        );
        if (!message) continue;
        items.push(message);
        if (items.length === action.pageSize) {
          if (index + 1 < descending.length)
            next = { before, offset: index + 1 };
          else if (page.before !== undefined)
            next = { before: page.before, offset: 0 };
          else {
            exhausted = true;
            next = null;
          }
          return assemble();
        }
      }
    }
    if (page.before === undefined) {
      exhausted = true;
      break;
    }
    before = page.before;
    offset = 0;
    next = { before, offset };
  }

  if (action.order === 'asc') {
    if (!exhausted)
      throw new DiscoveryError(
        'scan_budget_exceeded',
        'Ascending history exceeded the scan budget. Use descending order or narrow the history.',
      );
    // Candidates are newest-first, as the monotonic turn lookup requires.
    const page = oldestCandidates.slice(-action.pageSize);
    const resolveTurn = turnLookup(reader, (page[0]?.ordinal ?? 0) + 1);
    for (const entry of page) {
      entry.message =
        serializeVisibleReadMessage(
          entry.source,
          await resolveTurn(entry.ordinal),
        ) ?? entry.message;
    }
    items.push(...page.reverse().map((entry) => entry.message));
    next =
      oldestCandidates.length > action.pageSize
        ? (oldestCandidates[0]?.locator ?? null)
        : null;
  } else if (exhausted) next = null;
  return assemble();

  function assemble(): HistoryScan<TContext['address']> {
    const countsExact = exhausted && fromBeginning;
    return {
      next,
      result: {
        address: context.address,
        items,
        returned: items.length,
        totalMessages: countsExact ? visibleCount : null,
        totalMatches: countsExact ? matchCount : null,
        countsExact,
        generatedAt: new Date().toISOString(),
        revision: String(reader.revision),
        ...(action.query !== undefined ? { query: action.query } : {}),
        ...(context.row.session ? { session: context.row.session } : {}),
      },
    };
  }
}
