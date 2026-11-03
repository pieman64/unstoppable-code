import type { ChatRuntimeState } from '@canopy/desktop-shared/types';
import { startingTurnUserMessageId } from './provisional-first-send';
import { canonicalTurnStateFor } from './turn-confirmation';
import type { ChatTab } from './types';

export type ComposerTurnActivity = 'active' | 'sending' | 'idle';

/**
 * What the composer shows for a chat: canonical runtime decides, a pending
 * sending lease covers the gap until main acknowledges a send, and a scope
 * with no canonical runtime entry falls back to the tab's own status.
 */
export function composerTurnActivity(
  tab: Pick<ChatTab, 'status' | 'sendingLease'>,
  runtime: ChatRuntimeState | undefined,
  now: number,
): ComposerTurnActivity {
  if (runtime) {
    if (canonicalTurnStateFor(runtime) === 'active') return 'active';
  } else if (tab.status === 'streaming') {
    return 'active';
  }
  const lease = tab.sendingLease;
  return lease?.state === 'pending' && now < lease.deadline
    ? 'sending'
    : 'idle';
}

/**
 * The tab's turn as its renderer-local queue rows see it (CAN-5031):
 * `streaming` and `dispatching` are a turn in flight, `recoverable` is a
 * failed or uncertain dispatch, and `idle` is neither.
 */
export type LocalTurnActivity =
  | 'streaming'
  | 'dispatching'
  | 'recoverable'
  | 'idle';

/** Canonical errors and failed-send transcript messages already carry time. */
function localDispatchFailureAt(
  tab: ChatTab,
  runtime: ChatRuntimeState | undefined,
): number | undefined {
  if (tab.status !== 'error') return undefined;
  const error =
    runtime?.status === 'failed' && runtime.error?.message === tab.error
      ? runtime.error
      : undefined;
  const occurredAt = error ? Date.parse(error.occurredAt) : undefined;
  const canonicalFailureAt =
    occurredAt !== undefined && Number.isFinite(occurredAt)
      ? occurredAt
      : undefined;
  for (let index = tab.messages.length - 1; index >= 0; index -= 1) {
    const message = tab.messages[index];
    if (
      message.role === 'system' &&
      message.blocks.some(
        (block) => block.type === 'text' && block.text === tab.error,
      )
    ) {
      return canonicalFailureAt === undefined
        ? message.timestamp
        : Math.max(message.timestamp, canonicalFailureAt);
    }
  }
  return canonicalFailureAt;
}

/**
 * Classifies the tab's current dispatch, most specific evidence first:
 *
 * 1. Streaming wins, so stale expiry or error evidence never hides Interrupt.
 * 2. An unexpired pending lease is dispatching unless its dispatch failed;
 *    an earlier error does not end a newer lease.
 * 3. Expiry is uncertain delivery for that dispatch, not a newer bridge.
 * 4. An error ends the matching bridge. A later bridge can supersede an
 *    identifiable historical error; otherwise failure remains recoverable.
 * 5. A pending turn or provisional Starting… bridge is dispatching: main may
 *    have acknowledged it without streaming yet. Queued echoes are excluded.
 * 6. Otherwise the tab is idle, which is not failure evidence.
 */
export function localTurnActivity(
  tab: ChatTab,
  now: number,
  runtime?: ChatRuntimeState,
): LocalTurnActivity {
  if (tab.status === 'streaming') return 'streaming';
  const lease = tab.sendingLease;
  const failureAt = localDispatchFailureAt(tab, runtime);
  if (
    lease?.state === 'pending' &&
    now < lease.deadline &&
    (failureAt === undefined || failureAt < lease.issuedAt)
  ) {
    return 'dispatching';
  }
  const provisional = tab.provisionalFirstSend;
  const pending = !(
    provisional?.phase === 'queued' &&
    provisional.userMessageId === tab.pendingTurn?.userMessageId
  )
    ? tab.pendingTurn
    : undefined;
  // Let terminal evidence below decide whether an error ends this bridge.
  const startingId = startingTurnUserMessageId(
    tab.status === 'error' ? { ...tab, status: 'idle' } : tab,
  );
  const bridgeId = pending?.userMessageId ?? startingId;
  const bridgeAt = pending?.timerMessage.timestamp ?? provisional?.submittedAt;
  if (lease?.state === 'expired' || lease?.state === 'pending') {
    const newerBridge =
      bridgeId !== undefined &&
      bridgeId !== lease.userMessageId &&
      bridgeAt !== undefined &&
      bridgeAt > lease.issuedAt;
    if (!newerBridge) return 'recoverable';
  }
  if (tab.status === 'error') {
    if (
      bridgeId === undefined ||
      failureAt === undefined ||
      bridgeAt === undefined ||
      bridgeAt <= failureAt
    ) {
      return 'recoverable';
    }
  }
  return bridgeId !== undefined ? 'dispatching' : 'idle';
}
