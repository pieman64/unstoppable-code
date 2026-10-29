/**
 * Cadence and routing of the legacy `chat:state-changed` IPC projection.
 *
 * This is interface (projection) policy over the `core.chat.events` stream:
 * the stream and `ChatStateService` are unchanged, and other in-process
 * clients (Portal) keep receiving every committed event as before. Nothing
 * here imports Electron, so both classes are tested with plain objects.
 *
 * - {@link ChatStateSubscriptions} records which scopes each window's
 *   renderer tracks. A window that has not declared receives every scope.
 *   The shape (per subscriber, a scope filter, the subscriber responsible
 *   for reading a snapshot after it declares) maps onto the core-daemon
 *   plan's per-client subscriptions; it assumes nothing about how many
 *   windows exist.
 * - {@link ChatStateDelivery} merges consecutive streamed-content events of
 *   one scope (`@canopy/desktop-shared/lib/chat-state-cadence`) into one
 *   message per window per publication tick. Every other event, and every
 *   event that does not continue the pending run's revision, is delivered on
 *   its own after the window's pending runs. Callers flush a window before
 *   any other message or invoke reply reaches it, so a renderer never
 *   observes a reply or another channel's message ahead of a commit that was
 *   published before it.
 *
 *   A merged message never spans the revision of a snapshot its window
 *   reads (the renderer installs a snapshot at revision R and applies only
 *   events based on R, so a message from below R to above R would look like
 *   a gap). While a window's snapshot query for a scope runs, that scope's
 *   events to the window are not merged; once it returns revision R, no run
 *   is extended across R. Publication can lag a snapshot read, so the
 *   boundary outlives the reply until the scope's events pass it.
 */
import type {
  ChatGetStateRequest,
  ChatInterestDeclaration,
  ChatRuntimeState,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import {
  isStreamedChatStateEvent,
  mergeChatStateChangedEvents,
} from '@canopy/desktop-shared/lib/chat-state-cadence';

/** About one display frame: the longest a streamed commit waits for company. */
const CHAT_STATE_PUBLICATION_TICK_MS = 16;
/** Upper bound on events merged into one message. */
const MAX_CHAT_STATE_EVENTS_PER_MESSAGE = 64;
/** Runtime states remembered for classification before starting over. */
const MAX_TRACKED_RUNTIMES = 10_000;
/** Snapshot revisions remembered per window and scope; the oldest go first. */
const MAX_SNAPSHOT_BOUNDARIES = 16;

function scopeKey(projectId: string, worktreeId: string): string {
  return JSON.stringify([projectId, worktreeId]);
}

/** A window's declaration: every scope, or exactly these scopes. */
type ChatStateScopeDeclaration = 'all' | readonly ChatGetStateRequest[];

/** Which scopes each subscriber (a window's renderer) receives. */
export class ChatStateSubscriptions<Subscriber extends object> {
  private readonly declared = new WeakMap<Subscriber, ReadonlySet<string>>();
  private readonly interests = new Map<Subscriber, ChatInterestDeclaration>();

  /** Replace a subscriber's declaration. */
  declare(
    subscriber: Subscriber,
    declaration: ChatStateScopeDeclaration,
  ): void {
    if (declaration === 'all') {
      this.declared.delete(subscriber);
      return;
    }
    this.declared.set(
      subscriber,
      new Set(
        declaration.map((scope) => scopeKey(scope.projectId, scope.worktreeId)),
      ),
    );
  }

  /** Forget only the scope declaration after an invalid scope invoke. */
  resetScopes(subscriber: Subscriber): void {
    this.declared.delete(subscriber);
  }

  /** Forget both declarations when a subscriber is destroyed. */
  reset(subscriber: Subscriber): void {
    this.resetScopes(subscriber);
    this.resetInterest(subscriber);
  }

  /** Replace the receiver's inert interest declaration. */
  declareInterest(
    subscriber: Subscriber,
    interest: ChatInterestDeclaration,
  ): void {
    this.interests.set(subscriber, interest);
  }

  resetInterest(subscriber: Subscriber): void {
    this.interests.delete(subscriber);
  }

  interestOf(subscriber: Subscriber): ChatInterestDeclaration | undefined {
    return this.interests.get(subscriber);
  }

  interestEntries(): Array<[Subscriber, ChatInterestDeclaration]> {
    return Array.from(this.interests.entries());
  }

  wants(
    subscriber: Subscriber,
    projectId: string,
    worktreeId: string,
  ): boolean {
    const scopes = this.declared.get(subscriber);
    return scopes === undefined || scopes.has(scopeKey(projectId, worktreeId));
  }
}

interface ChatStateDeliveryOptions<Target extends object> {
  /** Deliver one message; must not throw. */
  deliver(target: Target, event: ChatStateChangedEvent): void;
  /** Project for one receiver before holding or merging its events. */
  transform?(
    target: Target,
    event: ChatStateChangedEvent,
  ): ChatStateChangedEvent;
  setTimer(callback: () => void, delayMs: number): () => void;
  now(): number;
  tickMs?: number;
  maxEventsPerMessage?: number;
}

interface PendingRun {
  events: [ChatStateChangedEvent, ...ChatStateChangedEvent[]];
  due: number;
}

interface TargetState<Target extends object> {
  target: Target;
  /** Pending runs by scope, in the order they started. */
  runs: Map<string, PendingRun>;
  /** When each scope last had a message sent to this target. */
  lastSentAt: Map<string, number>;
  /** Snapshot queries from this target that are running, by scope. */
  snapshotsInFlight: Map<string, number>;
  /** Snapshot revisions this target read that no run may span, by scope. */
  snapshotBoundaries: Map<string, Set<number>>;
}

export class ChatStateDelivery<Target extends object> {
  private readonly targets = new Map<Target, TargetState<Target>>();
  private readonly runtimes = new Map<string, ChatRuntimeState>();
  private readonly tickMs: number;
  private readonly maxEventsPerMessage: number;
  private cancelTimer: (() => void) | null = null;
  private timerDue = Number.POSITIVE_INFINITY;
  private disposed = false;
  /**
   * Targets a message is being sent to. Its renderer delivery barriers may
   * release another projection's held messages (terminal output), whose own
   * barriers call back into {@link flushTarget}. A nested flush of the same
   * target must not send its other runs ahead of the message being sent; a
   * nested flush of another target must still run, so that target receives
   * its held chat state before the output released into it.
   */
  private readonly delivering = new Set<object>();

  constructor(private readonly options: ChatStateDeliveryOptions<Target>) {
    this.tickMs = options.tickMs ?? CHAT_STATE_PUBLICATION_TICK_MS;
    this.maxEventsPerMessage = Math.max(
      1,
      options.maxEventsPerMessage ?? MAX_CHAT_STATE_EVENTS_PER_MESSAGE,
    );
  }

  /**
   * Deliver one committed event to `targets`, which are already filtered by
   * subscription. Streamed content may wait for up to one tick; anything else
   * is delivered now, after each target's pending runs.
   */
  publish(event: ChatStateChangedEvent, targets: readonly Target[]): void {
    const scope = scopeKey(event.projectId, event.worktreeId);
    const streamed =
      !this.disposed &&
      isStreamedChatStateEvent(event, (chatId) =>
        this.runtimes.get(`${scope}${JSON.stringify(chatId)}`),
      );
    this.track(scope, event);
    for (const target of targets) {
      const projected = this.options.transform?.(target, event) ?? event;
      if (!streamed) {
        this.flushTarget(target);
        this.deliver(this.stateFor(target), scope, projected);
        continue;
      }
      this.enqueue(this.stateFor(target), scope, projected);
    }
    for (const target of targets) {
      this.passBoundaries(this.stateFor(target), scope, event.revision);
    }
  }

  /**
   * A snapshot query for one scope from `target` starts. Until the returned
   * function runs, that scope's events to `target` are not merged; pass it
   * the snapshot's revision (when the query returned one) before the reply
   * is delivered, and no later run is merged across that revision.
   */
  beginSnapshot(
    target: Target,
    projectId: string,
    worktreeId: string,
  ): (revision: number | undefined) => void {
    const scope = scopeKey(projectId, worktreeId);
    const state = this.stateFor(target);
    state.snapshotsInFlight.set(
      scope,
      (state.snapshotsInFlight.get(scope) ?? 0) + 1,
    );
    let ended = false;
    return (revision): void => {
      if (ended) return;
      ended = true;
      const count = (state.snapshotsInFlight.get(scope) ?? 1) - 1;
      if (count > 0) state.snapshotsInFlight.set(scope, count);
      else state.snapshotsInFlight.delete(scope);
      if (revision === undefined) return;
      let boundaries = state.snapshotBoundaries.get(scope);
      if (!boundaries) {
        boundaries = new Set();
        state.snapshotBoundaries.set(scope, boundaries);
      }
      boundaries.add(revision);
      if (boundaries.size > MAX_SNAPSHOT_BOUNDARIES) {
        boundaries.delete(Math.min(...Array.from(boundaries)));
      }
    };
  }

  /**
   * Deliver every pending run of one target now. A no-op while one of this
   * projection's messages is being sent to that target: the caller is
   * sending held messages that were published before the runs still pending.
   */
  flushTarget(target: object): void {
    if (this.delivering.has(target)) return;
    const state = this.findState(target);
    if (!state || state.runs.size === 0) return;
    const runs = Array.from(state.runs.entries());
    state.runs.clear();
    for (const [scope, run] of runs) {
      this.deliver(state, scope, mergeChatStateChangedEvents(run.events));
    }
    this.rearm();
  }

  /** Deliver every pending run now. */
  flushAll(): void {
    for (const state of Array.from(this.targets.values())) {
      this.flushTarget(state.target);
    }
  }

  /** Drop a target that can no longer receive messages. */
  forgetTarget(target: object): void {
    const state = this.findState(target);
    if (!state) return;
    this.targets.delete(state.target);
    this.rearm();
  }

  /**
   * Forget remembered runtime states, for example after the stream reopened.
   * Until a chat's runtime is seen again its runtime patches are delivered at
   * once, as before coalescing.
   */
  resetClassification(): void {
    this.runtimes.clear();
  }

  /** Deliver everything pending and deliver later events at once. */
  dispose(): void {
    this.disposed = true;
    this.flushAll();
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerDue = Number.POSITIVE_INFINITY;
  }

  /** A target's state, by identity: barriers pass any `WebContents`. */
  private findState(target: object): TargetState<Target> | undefined {
    if (this.targets.size === 0) return undefined;
    return Array.from(this.targets.values()).find(
      (state) => state.target === target,
    );
  }

  private stateFor(target: Target): TargetState<Target> {
    let state = this.targets.get(target);
    if (!state) {
      state = {
        target,
        runs: new Map(),
        lastSentAt: new Map(),
        snapshotsInFlight: new Map(),
        snapshotBoundaries: new Map(),
      };
      this.targets.set(target, state);
    }
    return state;
  }

  private track(scope: string, event: ChatStateChangedEvent): void {
    for (const change of event.changes) {
      if (change.type === 'runtime.patched') {
        if (this.runtimes.size >= MAX_TRACKED_RUNTIMES) this.runtimes.clear();
        this.runtimes.set(
          `${scope}${JSON.stringify(change.chatId)}`,
          change.runtime,
        );
      } else if (change.type === 'tab.removed') {
        this.runtimes.delete(`${scope}${JSON.stringify(change.tabId)}`);
      }
    }
  }

  private enqueue(
    state: TargetState<Target>,
    scope: string,
    event: ChatStateChangedEvent,
  ): void {
    const run = state.runs.get(scope);
    if (run) {
      const last = run.events[run.events.length - 1] ?? run.events[0];
      if (
        event.baseRevision === last.revision &&
        run.events.length < this.maxEventsPerMessage &&
        !state.snapshotsInFlight.has(scope) &&
        state.snapshotBoundaries.get(scope)?.has(event.baseRevision) !== true
      ) {
        run.events.push(event);
        return;
      }
      // A gap, a duplicate, a full run or a snapshot's revision: never
      // merged across.
      state.runs.delete(scope);
      this.deliver(state, scope, mergeChatStateChangedEvents(run.events));
    }
    // Leading edge: a scope that sent nothing to this window within the last
    // tick gets the event at once, as before coalescing, so an isolated
    // commit never waits for a timer turn on a busy main process. Only the
    // events that follow within the tick are held and merged.
    const lastSentAt = state.lastSentAt.get(scope);
    if (
      lastSentAt === undefined ||
      this.options.now() - lastSentAt >= this.tickMs
    ) {
      this.deliver(state, scope, event);
      return;
    }
    state.runs.set(scope, { events: [event], due: lastSentAt + this.tickMs });
    this.rearm();
  }

  /**
   * Forget the snapshot boundaries below `revision`: a scope's later events
   * are based at or above the revision of its last published event.
   */
  private passBoundaries(
    state: TargetState<Target>,
    scope: string,
    revision: number,
  ): void {
    const boundaries = state.snapshotBoundaries.get(scope);
    if (!boundaries) return;
    boundaries.forEach((boundary) => {
      if (boundary < revision) boundaries.delete(boundary);
    });
    if (boundaries.size === 0) state.snapshotBoundaries.delete(scope);
  }

  private deliver(
    state: TargetState<Target>,
    scope: string,
    event: ChatStateChangedEvent,
  ): void {
    state.lastSentAt.set(scope, this.options.now());
    this.delivering.add(state.target);
    try {
      this.options.deliver(state.target, event);
    } finally {
      this.delivering.delete(state.target);
    }
  }

  private rearm(): void {
    let due = Number.POSITIVE_INFINITY;
    this.targets.forEach((state) => {
      state.runs.forEach((run) => {
        due = Math.min(due, run.due);
      });
    });
    if (due === this.timerDue) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerDue = due;
    if (due === Number.POSITIVE_INFINITY) return;
    this.cancelTimer = this.options.setTimer(
      () => {
        this.cancelTimer = null;
        this.timerDue = Number.POSITIVE_INFINITY;
        this.flushDue();
      },
      Math.max(0, due - this.options.now()),
    );
  }

  private flushDue(): void {
    const now = this.options.now();
    for (const state of Array.from(this.targets.values())) {
      for (const [scope, run] of Array.from(state.runs.entries())) {
        // Skip a run that an earlier delivery's barrier already sent.
        if (run.due > now || state.runs.get(scope) !== run) continue;
        state.runs.delete(scope);
        this.deliver(state, scope, mergeChatStateChangedEvents(run.events));
      }
    }
    this.rearm();
  }
}
