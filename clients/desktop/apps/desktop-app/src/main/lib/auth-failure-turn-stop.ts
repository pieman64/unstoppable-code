import type { BrowserWindow } from 'electron';
import type {
  AuthDependencyFailure,
  CanopyAuthFailureEventData,
} from '@canopy/protocol/auth-recovery';
import type { UsageInitiationSource } from '@canopy/execution-engine/types/observability';
import {
  isAutoResumeSafeToolName,
  isBackgroundInitiationSource,
  isForegroundInitiationSource,
  selectRecoverableAuthFailures,
} from '@canopy/desktop-shared/lib/auth-failure-turn-policy';
import { cancelChatTurn } from './chat-turn-cancel';
import { showOsNotification } from '../ipc/os-notifications';
import { isSpaceNotificationDeliverable } from './space-notification-gate';
import { resolveSpaceNotificationScope } from './space-notification-scope';
import { getRuntimeAppName } from './app-identity';

/** The chat whose turn an authentication failure interrupted. */
export interface AuthFailureChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * A stopped turn waiting for its blocked dependency to be reconnected.
 *
 * Deliberately in-memory and never persisted: a resume is only meaningful
 * inside the same app run as the session it re-drives, and a record surviving
 * a restart would re-dispatch a prompt into a chat the user has long moved on
 * from.
 */
export interface PendingAuthResume {
  target: AuthFailureChatTarget;
  /** Dependency ids that stopped the turn, in checklist order. */
  dependencyIds: string[];
  /** The recoverable failures themselves, so a reconnect can match by identity. */
  failures: AuthDependencyFailure[];
  /**
   * May this turn be re-driven WITHOUT the user asking?
   *
   * False whenever the interrupted tool call might have completed an external
   * write — see `isAutoResumeSafeToolName` — and also whenever a SIBLING call
   * from the same parallel batch was still in flight when the session-wide
   * cancel landed. A duplicated write is far worse than one extra click.
   */
  autoResumeSafe: boolean;
  /** True when a human initiated this turn and is present to recover it. */
  foreground: boolean;
  /** Raw provider tool name the turn was interrupted on, when known. */
  toolName?: string;
  /**
   * Dependency ids whose recovery has already succeeded.
   *
   * A stopped turn can be blocked on SEVERAL servers. Claiming the record on
   * the first one to reconnect dispatched a resume that immediately failed on
   * the still-broken second, and — because claiming is destructive — the second
   * reconnect then had nothing left to resume (CAN-1814 review). Reconnects
   * accumulate here instead, and the record is only claimed once every
   * recoverable dependency it carries appears in this list.
   */
  satisfiedDependencyIds: string[];
  /**
   * The provider event whose pairings produced this record, when known.
   *
   * One event can yield several pairings — an MCP 401 plus an errored
   * Canopy-injected tool, say — and each used to `set()` over the last, so the
   * first pairing's dependencies were silently dropped and the turn was
   * cancelled twice. Records sharing a group MERGE (CAN-1814 review).
   */
  stopGroupId?: string;
  recordedAt: number;
}

/**
 * How long a stopped turn stays resumable.
 *
 * The gap being bounded is "user sees the card, completes a browser OAuth leg,
 * comes back" — minutes, not hours. Past that the transcript has scrolled and
 * silently re-driving the turn would be a surprise, so the record is dropped
 * and the user simply sends again.
 */
export const PENDING_AUTH_RESUME_TTL_MS = 15 * 60_000;

/**
 * Ceiling on remembered stopped turns.
 *
 * Records are normally consumed by the reconnect that follows, but a user who
 * abandons every reconnect would otherwise accumulate one per chat for the
 * process lifetime. `Map` preserves insertion order, so oldest-first eviction
 * drops the least likely to still be recovered.
 */
const MAX_PENDING_AUTH_RESUMES = 128;

const pendingByChat = new Map<string, PendingAuthResume>();
const claimedByChat = new Map<string, PendingAuthResume>();

function chatKey(target: AuthFailureChatTarget): string {
  return `${target.projectId}:${target.worktreeId}:${target.chatId}`;
}

function prune(now: number): void {
  for (const [key, entry] of Array.from(pendingByChat.entries())) {
    if (now - entry.recordedAt > PENDING_AUTH_RESUME_TTL_MS) {
      pendingByChat.delete(key);
    }
  }
  for (const [key, entry] of Array.from(claimedByChat.entries())) {
    if (now - entry.recordedAt > PENDING_AUTH_RESUME_TTL_MS)
      claimedByChat.delete(key);
  }
  while (pendingByChat.size > MAX_PENDING_AUTH_RESUMES) {
    const oldest = pendingByChat.keys().next();
    if (oldest.done) break;
    pendingByChat.delete(oldest.value);
  }
}

export interface StopTurnForAuthFailureInput {
  target: AuthFailureChatTarget;
  event: CanopyAuthFailureEventData;
  /** Raw provider tool name of the errored call this failure explains. */
  toolName?: string;
  /**
   * Did a sibling tool call from the same parallel batch never land a result?
   *
   * Forces {@link StopTurnForAuthFailureResult.autoResumeSafe} to false when
   * true, because {@link cancelChatTurn} aborts the SESSION-WIDE
   * AbortController, not just the one call the failure was paired with
   * (CAN-1814 review). Supplied by `pairPendingAuthFailuresWithTool`, which is the
   * only place that sees the whole batch.
   */
  batchHasUnresolvedToolCalls?: boolean;
  /**
   * Identifies the provider event this stop belongs to.
   *
   * Two calls sharing it describe ONE turn interruption, so the second merges
   * into the first record and does not cancel again. Omitted means "unrelated
   * to anything already recorded", which replaces and cancels — the behaviour
   * before this existed. See {@link PendingAuthResume.stopGroupId}.
   */
  stopGroupId?: string;
  initiationSource?: UsageInitiationSource;
  getWindow: () => BrowserWindow | null;
  now?: number;
}

export interface StopTurnForAuthFailureResult {
  stopped: boolean;
  autoResumeSafe: boolean;
  notified: boolean;
}

function buildNotificationBody(
  failures: readonly AuthDependencyFailure[],
): string {
  const names = failures.map((failure) => failure.displayName);
  // The product name is user-visible here, so it must come from the brand
  // runtime rather than a literal — a whitelabelled build would otherwise tell
  // its users to open "Canopy". `brand:check-user-facing` does not scan
  // arbitrary main-process strings, so nothing would have caught this.
  const appName = getRuntimeAppName();
  if (names.length === 1) {
    return `${names[0]} needs to be reconnected before this run can continue. Open ${appName} to reconnect it.`;
  }
  return `${names.join(', ')} need to be reconnected before this run can continue. Open ${appName} to reconnect them.`;
}

/**
 * Stop a turn that is blocked on a recoverable authentication failure, and
 * remember enough to resume it once the user reconnects (CAN-1814 PR 6).
 *
 * Gated on `recovery.kind`, never on `failureClass` alone: a `quota_exceeded`,
 * `provider_outage`, `network_error`, or `insufficient_scope` failure has no
 * button attached, so the agent is left running to route around it. Stopping
 * for one of those would strand the user in a dead transcript.
 *
 * Interactive login is never started here. A background turn (a hook or an
 * automation) gets an actionable OS notification and nothing else — CAN-492 is
 * the ticket where setup scripts opened surprise browser logins.
 */
export async function stopTurnForAuthFailure(
  input: StopTurnForAuthFailureInput,
): Promise<StopTurnForAuthFailureResult> {
  const failures = selectRecoverableAuthFailures(input.event);
  if (failures.length === 0) {
    return { stopped: false, autoResumeSafe: false, notified: false };
  }

  const now = input.now ?? Date.now();
  const foreground = isForegroundInitiationSource(input.initiationSource);
  // Three independent conditions, all required.
  //
  // The batch check is the one a name can never supply: `isAutoResumeSafeToolName`
  // judges the SINGLE tool this failure was paired with, while the cancel below
  // aborts the whole session. If the model issued `[list_issues, create_issue]`
  // in parallel and only the read's 401 came back, cancelling kills the write
  // in flight, its `tool_result` never lands, the resumed session replays a
  // `tool_use` with no result, and the model typically re-issues it — a
  // duplicated external write, the one unrecoverable outcome (CAN-1814 review).
  const autoResumeSafe =
    foreground &&
    isAutoResumeSafeToolName(input.toolName) &&
    input.batchHasUnresolvedToolCalls !== true;

  prune(now);
  const key = chatKey(input.target);
  claimedByChat.delete(key);
  const existing = pendingByChat.get(key);
  // Merge only within one provider event. A record from an EARLIER, unrecovered
  // turn must still be replaced and must still cancel, or a second auth failure
  // in a later turn would leave that turn running.
  const merging =
    existing !== undefined &&
    input.stopGroupId !== undefined &&
    existing.stopGroupId === input.stopGroupId;

  if (merging && existing !== undefined) {
    for (const failure of failures) {
      if (existing.dependencyIds.includes(failure.dependencyId)) continue;
      existing.dependencyIds.push(failure.dependencyId);
      existing.failures.push(failure);
    }
    // AND, never OR: the turn is one unit, so it is resumable without asking
    // only if EVERY source that stopped it was safe to repeat.
    existing.autoResumeSafe = existing.autoResumeSafe && autoResumeSafe;
  } else {
    pendingByChat.set(key, {
      target: input.target,
      dependencyIds: failures.map((failure) => failure.dependencyId),
      failures: [...failures],
      autoResumeSafe,
      foreground,
      satisfiedDependencyIds: [],
      ...(input.stopGroupId !== undefined
        ? { stopGroupId: input.stopGroupId }
        : {}),
      ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
      recordedAt: now,
    });
  }

  // The turn is already cancelled when merging, and `cancelChatTurn` aborts the
  // session-wide controller — calling it twice for one interruption is at best
  // redundant and at worst races the teardown of a session the first call
  // already tore down.
  if (!merging) {
    await cancelChatTurn(input.target, 'teardown', undefined, {
      preserveAuthRecovery: true,
    });
  }
  // The caller clears the active-turn marker on `stopped: true` — see the
  // wiring in `worktree-chat-turn.ts`. Deliberately NOT done here: reaching
  // back into `worktree-chat-turn` would make this module part of a cycle with
  // its own importer, and the marker is that module's private state.

  // Notified once per interruption, from the first source in the group. A
  // second banner for the same stopped turn is noise, and the in-app card
  // renders the full merged checklist regardless.
  let notified = false;
  // A connection needing the user is attention in the chat's space
  // (CAN-3615); the in-app card is recorded either way.
  const notificationScope =
    !merging && isBackgroundInitiationSource(input.initiationSource)
      ? await resolveSpaceNotificationScope(input.target)
      : null;
  if (
    !merging &&
    isBackgroundInitiationSource(input.initiationSource) &&
    (notificationScope === null ||
      isSpaceNotificationDeliverable(notificationScope, 'attention'))
  ) {
    const response = showOsNotification(
      {
        id: `auth-recovery:${chatKey(input.target)}`,
        title: 'A connection needs attention',
        body: buildNotificationBody(failures),
      },
      input.getWindow,
    );
    notified = response.shown;
  }

  return { stopped: true, autoResumeSafe, notified };
}

// Seed an eligible stopped turn through the real policy/claim boundary in
// Electron recovery tests. This seam is removed from production builds.
if (typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__) {
  Object.defineProperty(globalThis, '__CANOPY_E2E_STOP_AUTH_FAILURE__', {
    configurable: true,
    value: stopTurnForAuthFailure,
  });
}

/** Read the stopped turn recorded for a chat, if it is still resumable. */
export function readPendingAuthResume(
  target: AuthFailureChatTarget,
  now: number = Date.now(),
): PendingAuthResume | null {
  const entry = pendingByChat.get(chatKey(target));
  if (!entry) return null;
  if (now - entry.recordedAt > PENDING_AUTH_RESUME_TTL_MS) {
    pendingByChat.delete(chatKey(target));
    return null;
  }
  return entry;
}

/** Forget the stopped turn recorded for a chat. */
export function clearPendingAuthResume(target: AuthFailureChatTarget): void {
  pendingByChat.delete(chatKey(target));
  claimedByChat.delete(chatKey(target));
}

/** A user cancellation, newer authentication failure, or expiry invalidates even an in-flight claim. */
export function isAuthResumeClaimCurrent(pending: PendingAuthResume): boolean {
  return (
    claimedByChat.get(chatKey(pending.target)) === pending &&
    Date.now() - pending.recordedAt <= PENDING_AUTH_RESUME_TTL_MS
  );
}

export function finishAuthResumeClaim(pending: PendingAuthResume): void {
  if (claimedByChat.get(chatKey(pending.target)) === pending)
    claimedByChat.delete(chatKey(pending.target));
}

/**
 * Read and REMOVE every stopped turn blocked on a specific MCP server config.
 *
 * Destructive so one successful reconnect drives at most one resume per chat;
 * a second settle event for the same server (a retried login, a token refresh)
 * cannot re-dispatch a prompt into a chat that already resumed.
 */
export function takePendingAuthResumesForMcpServer(
  serverId: string,
  configId: string,
  now: number = Date.now(),
): PendingAuthResume[] {
  return takeSatisfiedAuthResumes(
    (failure) =>
      failure.recovery.kind === 'mcp_oauth' &&
      failure.recovery.serverId === serverId &&
      failure.recovery.configId === configId,
    now,
  );
}

/** The desktop token resolver covers this integration identity only. */
export function takePendingAuthResumesForGitHub(
  now: number = Date.now(),
): PendingAuthResume[] {
  return takeSatisfiedAuthResumes(
    (failure) =>
      failure.recovery.kind === 'github_login' &&
      failure.dependencyClass === 'integration' &&
      failure.dependencyId === 'integration:github',
    now,
  );
}

function takeSatisfiedAuthResumes(
  matches: (failure: AuthDependencyFailure) => boolean,
  now: number,
): PendingAuthResume[] {
  prune(now);
  const claimed: PendingAuthResume[] = [];
  for (const [key, entry] of Array.from(pendingByChat.entries())) {
    const satisfiedNow = entry.failures.filter(matches);
    if (satisfiedNow.length === 0) continue;
    for (const failure of satisfiedNow) {
      if (entry.satisfiedDependencyIds.includes(failure.dependencyId)) continue;
      entry.satisfiedDependencyIds.push(failure.dependencyId);
    }

    const outstanding = entry.failures.some(
      (failure) => !entry.satisfiedDependencyIds.includes(failure.dependencyId),
    );
    if (outstanding) continue;

    pendingByChat.delete(key);
    claimedByChat.set(key, entry);
    claimed.push(entry);
  }
  return claimed;
}
