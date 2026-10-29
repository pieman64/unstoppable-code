// ---------------------------------------------------------------------------
// Attention tracker — the desktop half of the actionable-push signal.
//
// The desktop has always known the difference between "this turn ended" and
// "this turn ended because it needs YOU", but only the former ever reached the
// cloud: `TelemetryTurnStatus` has no value for "parked on an unanswered
// question", so a push could not tell the two apart. This tracker is the piece
// that closes that gap. Every genuinely human-blocking chokepoint in the app
// (tool approval, ask-user, plan review, pipeline input, usage limit, auth,
// non-retryable error) reports here, and the transition — not the lifecycle —
// is what earns a notification.
//
// Two behaviors carry the whole design:
//
//   1. A grace period before anything syncs. A transition arms
//      `ATTENTION_GRACE_MS` and only then reaches telemetry. Answer the prompt
//      at your desk inside that window and the block is dropped without ever
//      leaving the machine — "I was right there" self-suppresses, for free, with
//      no presence plumbing.
//   2. An explicit flush once it does. The telemetry debounce RE-ARMS on every
//      enqueue for a worktree, so its real rule is "60s of worktree quiet" — and
//      a worktree with a second active chat or a pipeline writing turns can
//      defer a block indefinitely. That is precisely the case where the user is
//      most blocked, so a blocking transition flushes its worktree directly
//      instead of trusting the debounce.
//
// The tracker holds no content: the copy is composed server-side from the
// category, and `detail` is scrubbed and capped before it is queued.
// ---------------------------------------------------------------------------

import type {
  TelemetryAttentionReason,
  TelemetryAttentionState,
} from '@canopy/protocol/telemetry';
// Static import despite closing a cycle (telemetry-sync-service -> observability
// -> ... -> approvals/prompt-bridge -> here). `getTelemetrySyncService` is a
// hoisted function declaration that this module only ever CALLS from a timer or
// event callback, never at module-evaluation time, so no init order can observe
// an unresolved binding. That is the same shape as the many existing cycles in
// this main-process graph; a dynamic import here would buy nothing and would
// hide the dependency from the bundler.
import { getTelemetrySyncService } from './telemetry-sync-service';

/**
 * How long a blocking transition is held locally before it syncs.
 *
 * Long enough that an approval handled at the desktop never becomes a push,
 * short enough that a genuine walk-away is noticed in well under a minute
 * (the previous floor was the 60s telemetry debounce, and only when the
 * worktree happened to go quiet).
 */
export const ATTENTION_GRACE_MS = 15_000;

/** A state that means a human is the blocker. */
export type BlockingAttentionState = Extract<
  TelemetryAttentionState,
  'needs_input' | 'blocked'
>;

export interface AttentionSignal {
  projectId: string;
  worktreeId: string;
  chatId: string;
  state: BlockingAttentionState;
  reason: TelemetryAttentionReason;
  /** Identifies the concrete blocker so one resolver cannot clear another. */
  sourceId?: string;
  /** Free text (the command, the question, the error). Scrubbed downstream. */
  detail?: string;
}

interface TrackedSource {
  signal: AttentionSignal;
  since: string;
  timer: NodeJS.Timeout | null;
  order: number;
}

interface TrackedAttention {
  sources: Map<string, TrackedSource>;
  effectiveSourceId: string;
  /** The state most recently handed to telemetry, independent of source. */
  published: Pick<AttentionSignal, 'state' | 'reason'> | null;
}

function trackKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}::${worktreeId}::${chatId}`;
}

export class AttentionTracker {
  private readonly tracked = new Map<string, TrackedAttention>();
  private readonly pendingOperations = new Set<Promise<void>>();
  private readonly operationChains = new Map<string, Promise<void>>();
  private nextOrder = 0;
  private disposed = false;

  /**
   * Report that a chat is now blocked on a human.
   *
   * Idempotent for a repeat of the same `(state, reason)` on a chat that is
   * already tracked: a prompt re-rendered, an approval re-requested for the
   * same reason, or a retry loop must not restart the clock or produce a second
   * push. A change of `reason` IS a new block (an approval that becomes a usage
   * limit is a different thing to tell the user about), so it replaces the
   * tracked entry and re-arms.
   */
  mark(signal: AttentionSignal): void {
    if (this.disposed) {
      return;
    }
    if (
      signal.projectId.length === 0 ||
      signal.worktreeId.length === 0 ||
      signal.chatId.length === 0
    ) {
      // Global/app-managed surfaces (App Advisor, plan-explore) have no
      // worktree identity on the telemetry wire and no deep link to route to,
      // so they are deliberately out of scope rather than sent with a blank id.
      return;
    }
    const key = trackKey(signal.projectId, signal.worktreeId, signal.chatId);
    const sourceId = signal.sourceId ?? `reason:${signal.reason}`;
    const chat = this.tracked.get(key);
    const existing = chat?.sources.get(sourceId);
    if (
      existing &&
      existing.signal.state === signal.state &&
      existing.signal.reason === signal.reason
    ) {
      // Detail is current copy context, not transition identity. Keep the
      // original `since` and timer while letting the eventual publication use
      // the freshest checkpoint/question text.
      existing.signal = signal;
      return;
    }
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    const source: TrackedSource = {
      signal,
      since: new Date().toISOString(),
      timer: null,
      order: ++this.nextOrder,
    };
    const next =
      chat ??
      ({
        sources: new Map<string, TrackedSource>(),
        effectiveSourceId: sourceId,
        published: null,
      } satisfies TrackedAttention);
    next.sources.set(sourceId, source);
    next.effectiveSourceId = sourceId;
    this.tracked.set(key, next);
    this.schedulePublish(key, next, sourceId, source);
  }

  /**
   * Report that a chat is no longer blocked on a human.
   *
   * Inside the grace window this simply discards the pending block — nothing
   * was ever sent, so nothing needs to be unsent. After the block has synced it
   * sends a `clear`, which is what allows a later re-block on the same reason
   * to notify again instead of being swallowed as a duplicate.
   */
  clear(
    projectId: string,
    worktreeId: string,
    chatId: string,
    sourceId?: string,
  ): void {
    if (this.disposed) {
      return;
    }
    const key = trackKey(projectId, worktreeId, chatId);
    const chat = this.tracked.get(key);
    if (!chat) {
      return;
    }
    if (sourceId === undefined) {
      this.clearChat(key, chat, projectId, worktreeId, chatId);
      return;
    }
    const source = chat.sources.get(sourceId);
    if (!source) {
      return;
    }
    if (source.timer) clearTimeout(source.timer);
    chat.sources.delete(sourceId);
    if (chat.sources.size === 0) {
      this.clearChat(key, chat, projectId, worktreeId, chatId);
      return;
    }
    if (chat.effectiveSourceId !== sourceId) return;

    const remaining = Array.from(chat.sources.entries()).sort(
      ([, left], [, right]) => right.order - left.order,
    )[0];
    if (!remaining) return;
    chat.effectiveSourceId = remaining[0];
    this.schedulePublish(key, chat, remaining[0], remaining[1]);
  }

  /** Test seam: whether a chat currently has a tracked block. */
  isTracked(projectId: string, worktreeId: string, chatId: string): boolean {
    return this.tracked.has(trackKey(projectId, worktreeId, chatId));
  }

  dispose(): void {
    this.disposed = true;
    for (const chat of Array.from(this.tracked.values())) {
      for (const source of Array.from(chat.sources.values())) {
        if (source.timer) clearTimeout(source.timer);
      }
    }
    this.tracked.clear();
  }

  /** Wait for already-started telemetry writes before app shutdown drains. */
  async drain(): Promise<void> {
    while (this.pendingOperations.size > 0) {
      await Promise.allSettled(Array.from(this.pendingOperations));
    }
  }

  private schedulePublish(
    key: string,
    chat: TrackedAttention,
    sourceId: string,
    source: TrackedSource,
  ): void {
    if (
      chat.published?.state === source.signal.state &&
      chat.published.reason === source.signal.reason
    ) {
      return;
    }
    const elapsed = Math.max(0, Date.now() - Date.parse(source.since));
    source.timer = setTimeout(
      () => {
        source.timer = null;
        this.trackOperation(key, () =>
          this.publish(key, chat, sourceId, source),
        );
      },
      Math.max(0, ATTENTION_GRACE_MS - elapsed),
    );
    source.timer.unref?.();
  }

  private clearChat(
    key: string,
    chat: TrackedAttention,
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): void {
    for (const source of Array.from(chat.sources.values())) {
      if (source.timer) clearTimeout(source.timer);
    }
    this.tracked.delete(key);
    if (!chat.published) return;
    const publishedReason = chat.published.reason;
    this.trackOperation(key, () =>
      this.publishClear(projectId, worktreeId, chatId, publishedReason),
    );
  }

  private trackOperation(key: string, operation: () => Promise<void>): void {
    // A stale publication may need to enqueue a compensating clear before a
    // replacement source writes. Keep those last-write-wins mutations ordered
    // per chat while allowing unrelated chats to publish independently.
    const predecessor = this.operationChains.get(key);
    const run = predecessor
      ? predecessor.then(operation, operation)
      : operation();
    this.operationChains.set(key, run);
    const finish = (): void => {
      this.pendingOperations.delete(run);
      if (this.operationChains.get(key) === run) {
        this.operationChains.delete(key);
      }
    };
    this.pendingOperations.add(run);
    void run.then(finish, finish);
  }

  private async publishClear(
    projectId: string,
    worktreeId: string,
    chatId: string,
    reason: TelemetryAttentionReason,
  ): Promise<void> {
    const service = getTelemetrySyncService();
    try {
      await service.recordAttention(
        projectId,
        worktreeId,
        chatId,
        'clear',
        reason,
        { since: new Date().toISOString() },
      );
      await service.flushWorktreeNow(projectId, worktreeId);
    } catch {
      // Match blocking-state publication: attention transport must never
      // interrupt the user action that resolves the blocker.
    }
  }

  private async publish(
    key: string,
    chat: TrackedAttention,
    sourceId: string,
    source: TrackedSource,
  ): Promise<void> {
    if (
      this.disposed ||
      this.tracked.get(key) !== chat ||
      chat.effectiveSourceId !== sourceId ||
      chat.sources.get(sourceId) !== source
    ) {
      return;
    }
    const { projectId, worktreeId, chatId, state, reason, detail } =
      source.signal;
    const service = getTelemetrySyncService();
    try {
      await service.recordAttention(
        projectId,
        worktreeId,
        chatId,
        state,
        reason,
        {
          since: source.since,
          ...(detail !== undefined ? { detail } : {}),
        },
      );
      if (
        this.disposed ||
        this.tracked.get(key) !== chat ||
        chat.effectiveSourceId !== sourceId ||
        chat.sources.get(sourceId) !== source
      ) {
        // The blocker resolved or was superseded while its telemetry write was
        // in flight. Replace that queued stale state before anything flushes.
        // If an older, already-eligible blocker became effective again, restore
        // it even when `chat.published` still describes that blocker: the stale
        // write just overwrote the server-side value behind that cache.
        const currentChat = this.tracked.get(key);
        const currentSourceId = currentChat?.effectiveSourceId;
        const currentSource = currentSourceId
          ? currentChat.sources.get(currentSourceId)
          : undefined;
        if (currentChat && currentSourceId && currentSource?.timer === null) {
          await this.publish(key, currentChat, currentSourceId, currentSource);
          return;
        }
        // A replacement still inside its grace window will publish on its own
        // timer; until then, clear the stale state that just reached telemetry.
        await this.publishClear(projectId, worktreeId, chatId, reason);
        return;
      }
      chat.published = { state, reason };
      // Explicit flush rather than the debounce: see the header note on
      // `scheduleFlush` re-arming under a busy worktree.
      await service.flushWorktreeNow(projectId, worktreeId);
    } catch {
      // Telemetry is best-effort. A failed attention sync must never surface to
      // the user or interrupt the flow that is already waiting on them.
    }
  }
}

let tracker: AttentionTracker | null = null;

export function getAttentionTracker(): AttentionTracker {
  if (!tracker) {
    tracker = new AttentionTracker();
  }
  return tracker;
}

/** Test seam: drop the singleton so each test starts from a clean tracker. */
export function resetAttentionTrackerForTests(): void {
  tracker?.dispose();
  tracker = null;
}
