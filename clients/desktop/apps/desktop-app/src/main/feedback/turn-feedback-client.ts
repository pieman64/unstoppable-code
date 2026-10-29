/**
 * Canopy Cloud transport for turn-level feedback (CAN-1521).
 *
 * Every exported function resolves — none reject. A rating that cannot reach
 * the server is queued in the local outbox and the caller is told
 * `{ recorded: false, queued: true }` so the UI still shows the thumb.
 */

import { app } from 'electron';
import type {
  TurnFeedbackClearRequest,
  TurnFeedbackClearResponse,
  TurnFeedbackDetailRequestIpc,
  TurnFeedbackDetailResponse,
  TurnFeedbackListRequest,
  TurnFeedbackListResponseIpc,
  TurnFeedbackOutboxEntry,
  TurnFeedbackRateRequestIpc,
  TurnFeedbackRateResponse,
} from '@canopy/desktop-shared/types';
import type {
  TurnFeedbackListResponse,
  TurnFeedbackSummary,
} from '@canopy/protocol/turn-feedback';
import { AI_CREDITS_WORK_OWNER_HEADER } from '@canopy/protocol/llm-gateway';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
} from '../canopy-cloud/client';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  subscribeCanopyCloudAccountConfirmations,
} from '../lib/canopy-cloud-account-store';
import {
  amendQueuedTurnFeedback,
  enqueueTurnFeedback,
  readTurnFeedbackOutbox,
  removeQueuedTurnFeedback,
  removeQueuedTurnFeedbackBatch,
} from './turn-feedback-outbox';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';

const TURN_FEEDBACK_PATH = '/api/v1/feedback/turns';
const TURN_FEEDBACK_TIMEOUT_MS = 10_000;

/**
 * Should this failure be retried later from the outbox, or is the rating
 * permanently rejected?
 *
 * Queue on: not signed in, cloud not configured, offline — and, critically, on
 * an **HTTP 401**. A revoked or expired API key surfaces as an `http-error`
 * with status 401, not as `missing-api-key`; treating 401 as permanent would
 * silently drop every rating made after a key rotation.
 *
 * Drop on any other 4xx except 429 (rate limiting is transient). A 400 means
 * the payload will never be accepted, so retrying it forever just keeps a dead
 * entry in the outbox.
 */
function shouldQueue(error: unknown): boolean {
  if (!(error instanceof CanopyCloudClientError)) {
    return true;
  }
  switch (error.code) {
    case 'missing-api-key':
    case 'cloud-not-configured':
    case 'network-error':
      return true;
    case 'http-error': {
      const status = error.status;
      if (status === undefined) return true;
      if (status === 401 || status === 429) return true;
      return status < 400 || status >= 500;
    }
    default:
      return false;
  }
}

/**
 * Desktop build the turn was rated on. Stamped here rather than in the
 * renderer: the version is a main-process fact, and the row denormalizes it
 * (with `provider`/`model`/`eventType`/`chatMode`) precisely so the warehouse
 * can slice ratings without a `TranscriptTurn` join, which does not exist when
 * telemetry is disabled.
 */
function getAppVersion(): string | undefined {
  try {
    const version = app.getVersion();
    return version.length > 0 ? version : undefined;
  } catch {
    // `app` is unavailable outside a live Electron main process (unit tests).
    return undefined;
  }
}

/** The wire payload for `POST /api/v1/feedback/turns`. */
interface TurnFeedbackRatePayload {
  clientUserMessageId: string;
  clientChatId: string;
  rating: TurnFeedbackRateRequestIpc['rating'];
  provider?: string;
  model?: string;
  eventType?: string;
  chatMode?: string;
  appVersion?: string;
}

function toRatePayload(
  request: TurnFeedbackRateRequestIpc,
  appVersion: string | undefined,
): TurnFeedbackRatePayload {
  return {
    clientUserMessageId: request.clientUserMessageId,
    clientChatId: request.clientChatId,
    rating: request.rating,
    ...(request.provider === undefined ? {} : { provider: request.provider }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.eventType === undefined
      ? {}
      : { eventType: request.eventType }),
    ...(request.chatMode === undefined ? {} : { chatMode: request.chatMode }),
    ...(appVersion === undefined ? {} : { appVersion }),
  };
}

async function resolveWorkOwner(
  request: TurnFeedbackRateRequestIpc,
): Promise<string | undefined> {
  if (request.projectId === undefined) return undefined;
  try {
    const owner = await resolveAiCreditsScopeOwner({
      kind: 'work',
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.clientChatId,
    });
    return owner === undefined ? undefined : serializeWorkspaceContext(owner);
  } catch {
    return undefined;
  }
}

/**
 * Canopy Cloud account id to bind a queued rating to, or `undefined` when the
 * rating should stay unbound and flush to whichever account signs in next.
 *
 * **A minted guest is deliberately treated as unbound.** A "signed out"
 * desktop user normally still has a saved account entry: `mintGuest()` writes
 * `{ authMode: 'guest', account: <guest account with an id> }`. Binding to
 * that id would strand the feature's headline flow — rate while signed out,
 * flush on sign-in — because the id becomes the real user's on sign-in and the
 * guest row is then deleted by `mergeGuestIntoUser`, so the queued entry could
 * never match again and would sit until the 30-day prune silently dropped it.
 * It would also make the `TurnFeedback` branch of the guest merge unreachable
 * for exactly the offline path it exists to serve.
 *
 * Skipping the binding costs nothing here: a guest identity is device-scoped
 * and shared by everyone on the machine, so there is no cross-account
 * disclosure for it to prevent. The binding matters only for a *real*
 * signed-in account, which is the case it still covers.
 */
async function getCurrentAccountId(): Promise<string | undefined> {
  try {
    const entry = await loadCanopyCloudAccount();
    // `isGuestAccount` rather than a hand-written `authMode === 'guest'`: it is
    // the repo's canonical guest signal and ORs `credentialSource` with
    // `authMode`, because a normalized entry can carry one without the other.
    // Checking a single field here would let that entry bind and re-strand the
    // flow this guard exists to protect.
    if (entry === null || isGuestAccount(entry)) {
      return undefined;
    }
    return entry.account?.id;
  } catch {
    return undefined;
  }
}

/**
 * Is this queued entry usable by the account signed in right now?
 *
 * Unbound entries (queued signed out or as a guest) belong to whoever signs in
 * next — that is the rate-as-guest flow. A bound entry belongs only to the
 * account that queued it; entries bound to a *different* account are retained
 * rather than dropped, since that user may sign back in on this machine, and
 * uploading their ratings and free-text comments under someone else's account
 * would disclose them to the wrong person.
 */
export function belongsToAccount(
  entry: Pick<TurnFeedbackOutboxEntry, 'accountId'>,
  currentAccountId: string | undefined,
): boolean {
  return entry.accountId === undefined || entry.accountId === currentAccountId;
}

function toOutboxEntry(
  request: TurnFeedbackRateRequestIpc,
  appVersion: string | undefined,
  accountId: string | undefined,
  workOwner: string | undefined,
): TurnFeedbackOutboxEntry {
  return {
    clientUserMessageId: request.clientUserMessageId,
    clientChatId: request.clientChatId,
    rating: request.rating,
    queuedAt: Date.now(),
    ...(accountId === undefined ? {} : { accountId }),
    ...(workOwner === undefined ? {} : { workOwner }),
    ...(request.provider === undefined ? {} : { provider: request.provider }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.eventType === undefined
      ? {}
      : { eventType: request.eventType }),
    ...(request.chatMode === undefined ? {} : { chatMode: request.chatMode }),
    ...(appVersion === undefined ? {} : { appVersion }),
  };
}

async function postRating(
  request: TurnFeedbackRatePayload,
  workOwner?: string,
): Promise<TurnFeedbackSummary> {
  return requestCanopyCloudJson<TurnFeedbackSummary>(TURN_FEEDBACK_PATH, {
    method: 'POST',
    body: JSON.stringify(request),
    timeoutMs: TURN_FEEDBACK_TIMEOUT_MS,
    ...(workOwner === undefined
      ? {}
      : { headers: { [AI_CREDITS_WORK_OWNER_HEADER]: workOwner } }),
  });
}

/** Records a rating, queueing it locally when the server is unreachable. */
export async function rateTurnFeedback(
  request: TurnFeedbackRateRequestIpc,
): Promise<TurnFeedbackRateResponse> {
  const appVersion = getAppVersion();
  const workOwner = await resolveWorkOwner(request);
  try {
    const summary = await postRating(
      toRatePayload(request, appVersion),
      workOwner,
    );
    await removeQueuedTurnFeedback(request.clientUserMessageId);
    return { recorded: true, queued: false, feedbackId: summary.feedbackId };
  } catch (error) {
    if (shouldQueue(error)) {
      // Bind the entry to whoever is signed in right now (undefined when signed
      // out) so the sign-in flush cannot hand this rating to a different
      // account on a shared machine.
      const accountId = await getCurrentAccountId();
      await enqueueTurnFeedback(
        toOutboxEntry(request, appVersion, accountId, workOwner),
      );
      return { recorded: false, queued: true };
    }
    return { recorded: false, queued: false };
  }
}

/** Amends a rating with the thumbs-down reason and optional comment. */
export async function submitTurnFeedbackDetail(
  request: TurnFeedbackDetailRequestIpc,
): Promise<TurnFeedbackDetailResponse> {
  if (request.feedbackId === undefined) {
    // The rating never reached the server, so the detail rides along with the
    // queued entry and is sent as one unit at flush time.
    const amended = await amendQueuedTurnFeedback({
      clientUserMessageId: request.clientUserMessageId,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.comment === undefined ? {} : { comment: request.comment }),
    });
    return { recorded: false, queued: amended };
  }
  try {
    await requestCanopyCloudJson<TurnFeedbackSummary>(
      `${TURN_FEEDBACK_PATH}/${encodeURIComponent(request.feedbackId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.comment === undefined
            ? {}
            : { comment: request.comment }),
        }),
        timeoutMs: TURN_FEEDBACK_TIMEOUT_MS,
      },
    );
    return { recorded: true, queued: false };
  } catch (error) {
    if (shouldQueue(error)) {
      const amended = await amendQueuedTurnFeedback({
        clientUserMessageId: request.clientUserMessageId,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.comment === undefined ? {} : { comment: request.comment }),
      });
      return { recorded: false, queued: amended };
    }
    return { recorded: false, queued: false };
  }
}

/**
 * Retracts a rating the user cleared by clicking the selected thumb again.
 *
 * Both halves matter. Dropping the queued outbox entry stops a retracted
 * rating from uploading on the next sign-in flush; deleting the server row
 * stops the next `listTurnFeedback` from rehydrating the thumb the user just
 * cleared. A failed delete is swallowed — the local state is already cleared,
 * and there is nothing useful to tell the user about a rating they retracted.
 */
export async function clearTurnFeedback(
  request: TurnFeedbackClearRequest,
): Promise<TurnFeedbackClearResponse> {
  await removeQueuedTurnFeedback(request.clientUserMessageId);
  if (request.feedbackId === undefined || request.feedbackId.length === 0) {
    return { cleared: true };
  }
  try {
    await requestCanopyCloudJson<{ deleted: true }>(
      `${TURN_FEEDBACK_PATH}/${encodeURIComponent(request.feedbackId)}`,
      { method: 'DELETE', timeoutMs: TURN_FEEDBACK_TIMEOUT_MS },
    );
    return { cleared: true };
  } catch {
    return { cleared: false };
  }
}

/**
 * Lists ratings for one chat, merging server rows with still-pending outbox
 * entries so a queued thumb keeps rendering. Local pending entries win on
 * conflict — they are the newer intent.
 */
export async function listTurnFeedback(
  request: TurnFeedbackListRequest,
): Promise<TurnFeedbackListResponseIpc> {
  let serverRows: TurnFeedbackSummary[] = [];
  try {
    const response = await requestCanopyCloudJson<TurnFeedbackListResponse>(
      `${TURN_FEEDBACK_PATH}?clientChatId=${encodeURIComponent(request.clientChatId)}`,
      { method: 'GET', timeoutMs: TURN_FEEDBACK_TIMEOUT_MS },
    );
    serverRows = Array.isArray(response.feedback) ? response.feedback : [];
  } catch {
    serverRows = [];
  }

  // Same account predicate the flush uses. Without it, account B opening this
  // chat on a shared machine would see account A's queued rating (and its
  // `hasComment` flag) rendered as B's own — and clearing that thumb would
  // route through `removeQueuedTurnFeedback` and destroy A's pending feedback.
  const currentAccountId = await getCurrentAccountId();
  const queued = (await readTurnFeedbackOutbox()).filter(
    (entry) =>
      entry.clientChatId === request.clientChatId &&
      belongsToAccount(entry, currentAccountId),
  );
  const byMessageId = new Map<string, TurnFeedbackSummary>();
  for (const row of serverRows) {
    byMessageId.set(row.clientUserMessageId, row);
  }
  for (const entry of queued) {
    const queuedAt = new Date(entry.queuedAt).toISOString();
    byMessageId.set(entry.clientUserMessageId, {
      // A queued rating has no server id yet; the renderer keys on
      // `clientUserMessageId` and only needs `feedbackId` to send the detail.
      feedbackId: '',
      clientUserMessageId: entry.clientUserMessageId,
      rating: entry.rating,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      hasComment: entry.comment !== undefined,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });
  }
  return { feedback: Array.from(byMessageId.values()) };
}

let flushInFlight: Promise<void> | null = null;

/**
 * Best-effort upload of every queued rating. Entries that still fail with a
 * retryable error are left in place; permanently rejected ones are dropped.
 */
export async function flushTurnFeedbackOutbox(): Promise<void> {
  if (flushInFlight !== null) {
    return flushInFlight;
  }
  const run = async (): Promise<void> => {
    const all = await readTurnFeedbackOutbox();
    const currentAccountId = await getCurrentAccountId();
    // Only flush what belongs to this session: entries queued while signed out
    // (unbound — the rate-as-guest case), and entries queued under the account
    // that is signed in now. Entries bound to a different account are left in
    // place, not dropped: that user may sign back in on this machine, and
    // uploading their ratings and free-text comments under someone else's
    // account would disclose them to the wrong person.
    const entries = all.filter((entry) =>
      belongsToAccount(entry, currentAccountId),
    );
    // Removals are collected and applied as one write at the end instead of a
    // full read+write of the outbox file per settled entry.
    const settled: string[] = [];
    const settle = async (): Promise<void> => {
      await removeQueuedTurnFeedbackBatch(settled);
      settled.length = 0;
    };
    for (const entry of entries) {
      // The entry list was filtered against the account signed in when this run
      // started, but `requestCanopyCloudJson` resolves credentials per request.
      // If the user signs out and back in as someone else while a backlog is
      // draining, the remaining POSTs would go out under the new account's key
      // while carrying the old account's entries — the exact disclosure the
      // binding exists to prevent, through a narrower window. Re-check before
      // each upload and stop; the next flush re-filters from scratch.
      if ((await getCurrentAccountId()) !== currentAccountId) {
        await settle();
        return;
      }
      try {
        const summary = await postRating(
          {
            clientUserMessageId: entry.clientUserMessageId,
            clientChatId: entry.clientChatId,
            rating: entry.rating,
            ...(entry.provider === undefined
              ? {}
              : { provider: entry.provider }),
            ...(entry.model === undefined ? {} : { model: entry.model }),
            ...(entry.eventType === undefined
              ? {}
              : { eventType: entry.eventType }),
            ...(entry.chatMode === undefined
              ? {}
              : { chatMode: entry.chatMode }),
            // The version stamped when the rating was queued, not the version
            // running now — a queued rating describes the build the turn ran on.
            ...(entry.appVersion === undefined
              ? {}
              : { appVersion: entry.appVersion }),
          },
          entry.workOwner,
        );
        if (entry.reason !== undefined || entry.comment !== undefined) {
          await requestCanopyCloudJson<TurnFeedbackSummary>(
            `${TURN_FEEDBACK_PATH}/${encodeURIComponent(summary.feedbackId)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({
                ...(entry.reason === undefined ? {} : { reason: entry.reason }),
                ...(entry.comment === undefined
                  ? {}
                  : { comment: entry.comment }),
              }),
              timeoutMs: TURN_FEEDBACK_TIMEOUT_MS,
            },
          );
        }
        settled.push(entry.clientUserMessageId);
      } catch (error) {
        if (!shouldQueue(error)) {
          settled.push(entry.clientUserMessageId);
          continue;
        }
        // Still unreachable — stop here and retry on the next flush rather
        // than hammering a down/unauthenticated server for every entry.
        // Commit what did settle first so the successful uploads are not
        // replayed (and re-POSTed) on the next flush.
        await settle();
        return;
      }
    }
    await settle();
  };
  flushInFlight = run().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

/**
 * Flush queued ratings whenever the signed-in Canopy Cloud account changes or
 * a refresh confirms it.
 * This is the sign-in hook that makes "rate while signed out, then sign in"
 * work. Returns an unsubscribe closure.
 */
export function subscribeTurnFeedbackFlush(): () => void {
  const unsubscribeChanges = subscribeCanopyCloudAccountChanges(
    (account): void => {
      if (account === null) {
        return;
      }
      void flushTurnFeedbackOutbox();
    },
  );
  // A refresh that confirms the unchanged account means the server is
  // reachable again, so ratings queued while offline get another try.
  const unsubscribeConfirmations = subscribeCanopyCloudAccountConfirmations(
    (): void => {
      void flushTurnFeedbackOutbox();
    },
  );
  return (): void => {
    unsubscribeChanges();
    unsubscribeConfirmations();
  };
}
