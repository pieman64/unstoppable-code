import type {
  TranscriptPage,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import type {
  LastMessageResult,
  VisibleMessage,
} from '@canopy/desktop-shared/lib/project-reads';
import { serializeVisibleReadMessage } from '@canopy/desktop-shared/lib/chat-history-serialization';
import { DiscoveryError } from '../errors';
import type { ChatReadAddress, ChatReadContext } from '../chat-target';
import { RAW_PAGE_BUDGET, turnLookup } from './transcript';
import type { TranscriptReader } from './transcript';

export type ChatLastMessageResult<TAddress extends ChatReadAddress> = Omit<
  LastMessageResult,
  'address'
> & { address: TAddress };

/** Select the newest visible user message using a bounded scan of raw pages. */
export async function getLastUserMessage<TContext extends ChatReadContext>(
  reader: TranscriptReader,
  context: TContext,
): Promise<ChatLastMessageResult<TContext['address']>> {
  let before: number | undefined;

  for (let pageIndex = 0; pageIndex < RAW_PAGE_BUDGET; pageIndex += 1) {
    const page = await reader.readPage({
      ...(before !== undefined ? { before } : {}),
    });
    const currentEnd = before ?? page.totalMessages;
    const start = page.before ?? 0;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > currentEnd ||
      (page.before !== undefined && start >= currentEnd) ||
      page.messages.length !== currentEnd - start
    )
      throw readFailed();

    for (
      let messageIndex = page.messages.length - 1;
      messageIndex >= 0;
      messageIndex -= 1
    ) {
      const message = page.messages[messageIndex];
      if (message === undefined) continue;
      if (serializeVisibleReadMessage(message)?.role !== 'user') continue;

      const ordinal = start + messageIndex;
      const visible = serializeVisibleReadMessage(
        message,
        await turnLookup(reader, ordinal + 1)(ordinal),
      );
      await reader.verifyRevision();
      return toLastMessageResult(context, visible);
    }

    if (page.before === undefined) {
      if (page.messages.length !== currentEnd) throw readFailed();
      await reader.verifyRevision();
      return toLastMessageResult(context, null);
    }
    before = nextBefore(page, before, currentEnd);
  }

  await reader.verifyRevision();
  throw scanBudgetExceeded();
}

/**
 * Select the newest completed canonical turn with a visible final assistant
 * message. Turn-view pages retain those final rows without raw-page scans.
 */
export async function getLastAgentResponse<TContext extends ChatReadContext>(
  reader: TranscriptReader,
  context: TContext,
): Promise<ChatLastMessageResult<TContext['address']>> {
  let before: number | undefined;

  for (let pageIndex = 0; pageIndex < RAW_PAGE_BUDGET; pageIndex += 1) {
    const page = await reader.readPage({
      ...(before !== undefined ? { before } : {}),
      view: 'turns',
    });
    const turns = page.turns ?? [];

    // The turn page can include the latest human message as a sticky context
    // row. It is older than `page.before` and must wait until that window is
    // actually reached by a later page.
    const windowStart = page.before ?? 0;
    const orderedTurns = [...turns].sort(
      (left, right) => right.start - left.start || right.end - left.end,
    );
    for (const turn of orderedTurns) {
      if (turn.start < windowStart || !turn.complete) continue;
      const message = finalVisibleAssistantMessage(page, turn);
      if (!message) continue;

      await reader.verifyRevision();
      return toLastMessageResult(
        context,
        message,
        terminalDisposition(context, turn.id),
      );
    }

    if (page.before === undefined) {
      await reader.verifyRevision();
      return toLastMessageResult(context, null);
    }
    before = nextBefore(page, before, before ?? page.totalMessages);
  }

  await reader.verifyRevision();
  throw scanBudgetExceeded();
}

/** Shared visible-output policy for latest-response and turn-correlated reads. */
export function finalVisibleAssistantMessage(
  page: TranscriptPage,
  turn: TranscriptTurnSummary,
): VisibleMessage | undefined {
  for (const id of turn.finalMessageIds) {
    if (!page.messages.some((message) => message.id === id)) throw readFailed();
  }
  for (let index = page.messages.length - 1; index >= 0; index -= 1) {
    const message = page.messages[index];
    if (!message || !turn.finalMessageIds.includes(message.id)) continue;
    const visible = serializeVisibleReadMessage(message, turn.id);
    if (visible?.role === 'assistant') return visible;
  }
  return undefined;
}

function nextBefore(
  page: TranscriptPage,
  currentBefore: number | undefined,
  currentEnd: number,
): number {
  const next = page.before;
  if (
    next === undefined ||
    !Number.isSafeInteger(next) ||
    next < 0 ||
    next >= currentEnd ||
    (currentBefore !== undefined && next >= currentBefore)
  ) {
    throw readFailed();
  }
  return next;
}

function terminalDisposition(
  context: ChatReadContext,
  turnId: string,
): string | undefined {
  let latest: { outcome: string; settledAt: number } | undefined;
  for (const row of context.tab.inputDelivery?.rows ?? []) {
    for (const attempt of row.attempts) {
      if (
        attempt.rootUserMessageId !== turnId ||
        attempt.turnOutcome === undefined
      ) {
        continue;
      }
      const settledAt = attempt.turnSettledAt ?? attempt.createdAt;
      if (latest === undefined || settledAt >= latest.settledAt) {
        latest = { outcome: attempt.turnOutcome, settledAt };
      }
    }
  }
  return latest?.outcome;
}

function toLastMessageResult<TContext extends ChatReadContext>(
  context: TContext,
  message: VisibleMessage | null,
  disposition?: string,
): ChatLastMessageResult<TContext['address']> {
  return {
    address: context.address,
    message,
    ...(context.row.session !== undefined
      ? { session: context.row.session }
      : {}),
    ...(disposition !== undefined ? { terminalDisposition: disposition } : {}),
    generatedAt: new Date().toISOString(),
  };
}

function readFailed(): DiscoveryError {
  return new DiscoveryError(
    'execution_failed',
    'Chat transcript could not be read.',
  );
}

function scanBudgetExceeded(): DiscoveryError {
  return new DiscoveryError(
    'scan_budget_exceeded',
    'Chat transcript scan reached its bounded page limit.',
  );
}
