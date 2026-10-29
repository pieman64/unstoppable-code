/**
 * Local outbox for turn ratings that could not reach Canopy Cloud (CAN-1521).
 *
 * Signed-out users can rate; the rating is queued here and flushed on sign-in.
 * Because nothing is uploaded with a rating — no screenshots, no diagnostics
 * bundle — a queued entry is complete on its own. There is no zip to hold open
 * and nothing to rebuild at flush time from misleading post-hoc state.
 *
 * Structured after `lib/usage-limited-chats-registry.ts`: `normalizeEntry`
 * returns null on a bad shape, the read never throws, and the serialized write
 * chain (`writeChain.then(attempt, attempt).catch(log)`) resolves even when a
 * write fails, so one bad write cannot poison every later one.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  TurnFeedbackOutboxEntry,
  TurnFeedbackOutboxFile,
} from '@canopy/desktop-shared/types';
import {
  MAX_TURN_FEEDBACK_COMMENT_LENGTH,
  isTurnFeedbackRating,
  isTurnFeedbackReason,
} from '@canopy/protocol/turn-feedback';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getTurnFeedbackOutboxFilePath } from '../lib/paths';
import { isRecord } from '../lib/type-guards';

/** Hard cap on queued entries. Oldest are dropped first. */
export const MAX_TURN_FEEDBACK_OUTBOX_ENTRIES = 200;

/** Queued ratings older than this are dropped unsent. */
export const MAX_TURN_FEEDBACK_OUTBOX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function readOptionalString(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return undefined;
  }
  return trimmed;
}

function normalizeEntry(value: unknown): TurnFeedbackOutboxEntry | null {
  if (!isRecord(value)) return null;
  const { clientUserMessageId, clientChatId, rating } = value;
  if (
    typeof clientUserMessageId !== 'string' ||
    clientUserMessageId.length === 0 ||
    typeof clientChatId !== 'string' ||
    clientChatId.length === 0 ||
    !isTurnFeedbackRating(rating)
  ) {
    return null;
  }
  const reason = isTurnFeedbackReason(value.reason) ? value.reason : undefined;
  const comment = readOptionalString(
    value.comment,
    MAX_TURN_FEEDBACK_COMMENT_LENGTH,
  );
  const accountId = readOptionalString(value.accountId, 128);
  const provider = readOptionalString(value.provider, 64);
  const model = readOptionalString(value.model, 256);
  const eventType = readOptionalString(value.eventType, 64);
  const chatMode = readOptionalString(value.chatMode, 64);
  const appVersion = readOptionalString(value.appVersion, 64);
  const workOwnerCandidate = readOptionalString(value.workOwner, 128);
  const workOwner =
    workOwnerCandidate !== undefined &&
    parseWorkspaceContext(workOwnerCandidate) !== null
      ? workOwnerCandidate
      : undefined;
  return {
    clientUserMessageId,
    clientChatId,
    rating,
    queuedAt: typeof value.queuedAt === 'number' ? value.queuedAt : 0,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(eventType === undefined ? {} : { eventType }),
    ...(chatMode === undefined ? {} : { chatMode }),
    ...(appVersion === undefined ? {} : { appVersion }),
    ...(workOwner === undefined ? {} : { workOwner }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(reason === undefined ? {} : { reason }),
    ...(comment === undefined ? {} : { comment }),
  };
}

function sameTurn(
  a: Pick<TurnFeedbackOutboxEntry, 'clientUserMessageId'>,
  b: Pick<TurnFeedbackOutboxEntry, 'clientUserMessageId'>,
): boolean {
  return a.clientUserMessageId === b.clientUserMessageId;
}

/** Reads the outbox. Malformed or missing JSON yields `[]`, never a throw. */
export async function readTurnFeedbackOutbox(): Promise<
  TurnFeedbackOutboxEntry[]
> {
  try {
    const raw = await readFile(getTurnFeedbackOutboxFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map(normalizeEntry)
      .filter((entry): entry is TurnFeedbackOutboxEntry => entry !== null);
  } catch {
    return [];
  }
}

function prune(
  entries: TurnFeedbackOutboxEntry[],
  now: number,
): TurnFeedbackOutboxEntry[] {
  const fresh = entries.filter(
    (entry) => now - entry.queuedAt <= MAX_TURN_FEEDBACK_OUTBOX_AGE_MS,
  );
  return fresh.length <= MAX_TURN_FEEDBACK_OUTBOX_ENTRIES
    ? fresh
    : fresh.slice(fresh.length - MAX_TURN_FEEDBACK_OUTBOX_ENTRIES);
}

// Serialize writes so concurrent rate/detail/flush calls do not clobber the
// file. Callers are invoked fire-and-forget, so the promise returned here must
// never reject — a failed write is logged and swallowed instead of poisoning
// the chain, so subsequent writes keep running.
let writeChain: Promise<void> = Promise.resolve();
function enqueueWrite(
  mutate: (entries: TurnFeedbackOutboxEntry[]) => TurnFeedbackOutboxEntry[],
): Promise<void> {
  const attempt = async (): Promise<void> => {
    const current = await readTurnFeedbackOutbox();
    const next: TurnFeedbackOutboxFile = {
      version: 1,
      entries: prune(mutate(current), Date.now()),
    };
    const filePath = getTurnFeedbackOutboxFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    // Owner-only (0600): a queued entry holds the user's free-text comment in
    // plaintext until it flushes. The server never stores a plaintext comment,
    // so the local queue should not be the weak link while it waits.
    await writeFile(filePath, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  };
  const next = writeChain.then(attempt, attempt).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Failed to persist turn feedback outbox:', error);
  });
  writeChain = next;
  return next;
}

/**
 * Queue a rating for later upload, replacing any earlier queued rating for the
 * same turn (the newest rating is the one the user means).
 */
export async function enqueueTurnFeedback(
  entry: TurnFeedbackOutboxEntry,
): Promise<void> {
  await enqueueWrite((entries) => [
    ...entries.filter((existing) => !sameTurn(existing, entry)),
    entry,
  ]);
}

/**
 * Amend a queued rating with the thumbs-down detail. No-ops when the rating has
 * already been flushed, in which case the caller sends the detail directly.
 */
export async function amendQueuedTurnFeedback(params: {
  clientUserMessageId: string;
  reason?: string;
  comment?: string;
}): Promise<boolean> {
  let amended = false;
  await enqueueWrite((entries) =>
    entries.map((entry) => {
      if (!sameTurn(entry, params)) {
        return entry;
      }
      amended = true;
      const reason = isTurnFeedbackReason(params.reason)
        ? params.reason
        : undefined;
      const comment = readOptionalString(
        params.comment,
        MAX_TURN_FEEDBACK_COMMENT_LENGTH,
      );
      return {
        ...entry,
        ...(reason === undefined ? {} : { reason }),
        ...(comment === undefined ? {} : { comment }),
      };
    }),
  );
  return amended;
}

/** Remove one queued rating (it uploaded, or was permanently rejected). */
export async function removeQueuedTurnFeedback(
  clientUserMessageId: string,
): Promise<void> {
  await removeQueuedTurnFeedbackBatch([clientUserMessageId]);
}

/**
 * Remove several queued ratings in a single write.
 *
 * A flush settles every entry it touches; removing them one at a time costs a
 * full read+write of the outbox file per entry (up to
 * {@link MAX_TURN_FEEDBACK_OUTBOX_ENTRIES} round trips on the Electron main
 * process). Settling the whole batch at the end is one write.
 */
export async function removeQueuedTurnFeedbackBatch(
  clientUserMessageIds: readonly string[],
): Promise<void> {
  if (clientUserMessageIds.length === 0) {
    return;
  }
  const removing = new Set(clientUserMessageIds);
  await enqueueWrite((entries) =>
    entries.filter((entry) => !removing.has(entry.clientUserMessageId)),
  );
}
