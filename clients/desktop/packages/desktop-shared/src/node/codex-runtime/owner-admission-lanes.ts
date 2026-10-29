/**
 * Per-owner notification admission for one shared Codex app-server stdout.
 *
 * A pooled app-server multiplexes many owners (one per chat client or thread
 * handle) over a single ordered JSON-RPC stdout. An owner may return an
 * admission promise from a delivered notification (the desktop chat client
 * returns its durable canonical commit). Later frames for that owner must not
 * be delivered until the admission settles, but other owners' frames must not
 * wait for it.
 *
 * The connection reads and routes every frame in pipe order, then hands each
 * owner-bound frame to `dispatch()`:
 *
 * - An owner with no pending admission and nothing queued receives the frame
 *   synchronously, exactly as before.
 * - Otherwise the frame joins that owner's FIFO lane and is delivered after
 *   every earlier admission for the owner has settled. A frame fanned out to
 *   several owners is dispatched to each lane separately, so it keeps its
 *   position in every recipient's order.
 * - Retained frames are charged by their wire bytes. Above `highWaterBytes`
 *   the shared source is paused (global backpressure) until the retained
 *   total falls to `lowWaterBytes`. A frame that has already been read is
 *   always retained, so one oversized frame is admitted alone and then pauses
 *   the source until its lane drains it.
 * - A retired owner's lane stops holding and drains on a microtask; owners
 *   that are no longer live never hold a lane.
 * - `discardAll()` drops every queued frame when the worker goes away.
 *
 * Admissions that stay pending for `longHoldThresholdMs`, and source pauses
 * that last that long, produce one rate-limited warning line and one
 * content-free report: durations, frame counts and bytes only. An owner's
 * duration is that of one admission, never of the span over which the owner
 * had some admission pending: under an in-flight budget a busy owner's
 * admissions overlap, and it is reported only when one of them was slow.
 *
 * Per-owner in-flight budget (`ownerInFlight`, off by default). The desktop
 * app supplies one while its chat storage group-commits: several commits of
 * one chat can then be in flight together, so an owner's lane may deliver
 * further notifications while earlier admissions are pending, in pipe order,
 * up to a bound on the wire bytes and the frames whose admissions are
 * pending. Only frames marked `overlap` are delivered that way. A response,
 * a server request and a notification that is not marked still wait for
 * every pending admission, and nothing is delivered beside the admission of
 * a frame that is not marked. Bytes in flight count toward the global cap.
 * Without a budget, one admission is pending per owner at a time.
 */

export type OwnerLaneFrameKind = 'notification' | 'response' | 'server-request';

export interface OwnerLaneFrame {
  kind: OwnerLaneFrameKind;
  /**
   * A notification that may be delivered while earlier admissions of its
   * owner are pending, when a per-owner in-flight budget applies.
   */
  overlap?: boolean;
  /**
   * Wire size of the frame; only called when the frame is retained, or
   * while a per-owner in-flight budget applies.
   */
  measureBytes(): number;
  /**
   * Delivers the frame to its owner. A returned promise is that owner's
   * admission for the frame: later frames for the owner wait for it.
   */
  deliver(): void | Promise<void>;
}

export type StdoutHoldKind = 'owner-admission' | 'stdout-byte-cap';

/**
 * `released`: the admission settled or the byte cap drained. `detached`: the
 * owner was retired while its admission was pending. `failed`: the admission
 * rejected (connection-fatal). `discarded`: the worker went away.
 */
export type StdoutHoldOutcome =
  | 'released'
  | 'detached'
  | 'failed'
  | 'discarded';

export interface StdoutHoldReport {
  holdKind: StdoutHoldKind;
  holdOutcome: StdoutHoldOutcome;
  holdDurationMs: number;
  /** Peak retained frames during the hold (that owner, or all owners). */
  queuedFrameCount: number;
  /** Peak retained wire bytes during the hold (that owner, or all owners). */
  queuedFrameBytes: number;
  /** Whether a JSON-RPC response was retained during the hold. */
  responseQueued: boolean;
}

export interface OwnerAdmissionLanesHost<TOwner> {
  /** Owners that are not live (retired or unregistered) never hold a lane. */
  isLiveOwner(owner: TOwner): boolean;
  pauseSource(): void;
  resumeSource(): void;
  /** Called when the byte-cap pause starts (`true`) or ends (`false`). */
  onSourcePauseChange(paused: boolean): void;
  /** An owner admission rejected while it held its lane. */
  onAdmissionFailure(error: Error): void;
  /** Delivering a queued frame threw synchronously. */
  onDeliveryFailure(error: Error): void;
  reportLongHold(report: StdoutHoldReport): void;
  warnLongHold(message: string): void;
}

/** What one owner may have delivered and not yet admitted. */
export interface OwnerInFlightBudget {
  /** Wire bytes of the frames whose admissions are pending. */
  bytes: number;
  /** Frames whose admissions are pending. */
  frames: number;
}

export interface OwnerAdmissionLanesLimits {
  highWaterBytes: number;
  lowWaterBytes: number;
  longHoldThresholdMs: number;
  /**
   * The per-owner in-flight budget in force now, read at each delivery
   * decision. Absent or undefined: one pending admission per owner.
   */
  ownerInFlight?: () => OwnerInFlightBudget | undefined;
}

/**
 * 8 MiB comfortably covers a large `thread/resume` reply or a long burst of
 * streamed items for one slow owner, while bounding what a stalled durable
 * commit can pin in Electron main. Resuming at half leaves room for a burst
 * before the next pause, so the source does not flap around one frame size.
 */
export const DEFAULT_OWNER_LANE_HIGH_WATER_BYTES = 8 * 1024 * 1024;
export const DEFAULT_OWNER_LANE_LOW_WATER_BYTES = 4 * 1024 * 1024;
export const DEFAULT_LONG_STDOUT_HOLD_THRESHOLD_MS = 5_000;
const LONG_HOLD_WARNING_WINDOW_MS = 30_000;
const MAX_LONG_HOLD_WATCH_INTERVAL_MS = 1_000;
const QUEUE_COMPACTION_THRESHOLD = 1_024;

interface QueuedFrame {
  frame: OwnerLaneFrame;
  bytes: number;
}

interface HoldStats {
  startedAt: number;
  peakFrames: number;
  peakBytes: number;
  responseQueued: boolean;
  warned: boolean;
}

/** One delivered frame's admission, from its delivery until it settles. */
interface PendingAdmission {
  startedAt: number;
}

/**
 * One owner's hold: from its first pending admission to its last.
 * `startedAt` is when the oldest admission still pending was delivered.
 */
interface OwnerHold extends HoldStats {
  /** The pending admissions, oldest first. */
  admissions: Set<PendingAdmission>;
  /**
   * The longest an admission of this hold took to settle since the last
   * report; a long hold is one slow admission, not a busy owner.
   */
  longestSettledMs: number;
  /** Admissions pending for this hold; always 1 without a budget. */
  pending: number;
  /** Wire bytes of the frames those admissions belong to (budget only). */
  pendingBytes: number;
  /** A pending admission belongs to a frame that may not overlap. */
  exclusive: boolean;
}

interface Lane<TOwner> {
  owner: TOwner;
  queue: QueuedFrame[];
  head: number;
  queuedBytes: number;
  queuedResponses: number;
  hold: OwnerHold | null;
  retired: boolean;
  drainScheduled: boolean;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

export class OwnerAdmissionLanes<TOwner> {
  private readonly lanes = new Map<TOwner, Lane<TOwner>>();
  private queuedBytes = 0;
  /** Wire bytes delivered under a budget whose admissions are pending. */
  private inFlightBytes = 0;
  private queuedFrames = 0;
  private queuedResponses = 0;
  private sourcePause: HoldStats | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private warningWindowStartedAt = Number.NEGATIVE_INFINITY;
  private suppressedWarnings = 0;

  constructor(
    private readonly host: OwnerAdmissionLanesHost<TOwner>,
    private readonly limits: OwnerAdmissionLanesLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Delivers `frame` to `owner` now, or retains it behind the owner's pending
   * admission. Synchronous delivery errors propagate to the caller.
   */
  dispatch(owner: TOwner, frame: OwnerLaneFrame): void {
    const lane = this.lanes.get(owner);
    if (lane) {
      // Behind a retained frame every later frame keeps its place.
      if (lane.head < lane.queue.length || !this.mayOverlap(lane, frame)) {
        this.enqueue(lane, frame);
        return;
      }
      const overlapping = frame.deliver();
      if (overlapping) this.beginHold(owner, lane, overlapping, frame);
      this.updateSourcePressure();
      return;
    }
    const admission = frame.deliver();
    if (admission) {
      this.beginHold(owner, null, admission, frame);
      this.updateSourcePressure();
    }
  }

  /**
   * Whether `frame` may be delivered while the lane's earlier admissions
   * are pending: only under a budget, only a frame marked for it, only
   * beside admissions of frames marked for it, and within the budget.
   */
  private mayOverlap(
    lane: Lane<TOwner>,
    frame: OwnerLaneFrame,
    measuredBytes?: number,
  ): boolean {
    const hold = lane.hold;
    if (!hold || hold.exclusive || lane.retired) return false;
    if (frame.kind !== 'notification' || frame.overlap !== true) return false;
    const budget = this.limits.ownerInFlight?.();
    if (!budget || hold.pending >= budget.frames) return false;
    const bytes = measuredBytes ?? Math.max(0, frame.measureBytes());
    return hold.pendingBytes + bytes <= budget.bytes;
  }

  /** Whether a frame dispatched to `owner` now would be retained. */
  isBusy(owner: TOwner): boolean {
    return this.lanes.has(owner);
  }

  isSourcePaused(): boolean {
    return this.sourcePause !== null;
  }

  /** Whether frames already read for `owner` wait in its lane, undelivered. */
  hasQueuedFrames(owner: TOwner): boolean {
    const lane = this.lanes.get(owner);
    return lane !== undefined && lane.head < lane.queue.length;
  }

  /**
   * Stops waiting for a retired owner's admission. Frames already retained
   * for it are delivered on a microtask, in order, without holding again.
   */
  retire(owner: TOwner): void {
    const lane = this.lanes.get(owner);
    if (!lane) return;
    lane.retired = true;
    const hold = lane.hold;
    if (hold) {
      lane.hold = null;
      this.inFlightBytes -= hold.pendingBytes;
      this.finishOwnerHold('detached', hold);
    }
    this.scheduleDrain(lane);
  }

  /**
   * Drops every retained frame and pending hold (the worker is going away).
   * Returns whether any owner lane or source pause was active, in which case
   * the caller should stop reading the old source entirely.
   */
  discardAll(): boolean {
    const hadActiveLanes = this.lanes.size > 0;
    for (const lane of Array.from(this.lanes.values())) {
      const hold = lane.hold;
      lane.hold = null;
      if (hold) this.finishOwnerHold('discarded', hold);
    }
    this.lanes.clear();
    this.queuedBytes = 0;
    this.inFlightBytes = 0;
    this.queuedFrames = 0;
    this.queuedResponses = 0;
    const pause = this.sourcePause;
    this.sourcePause = null;
    if (pause) {
      this.host.onSourcePauseChange(false);
      this.finishHold('stdout-byte-cap', 'discarded', pause);
    }
    this.stopWatch();
    return hadActiveLanes || pause !== null;
  }

  private createLane(owner: TOwner): Lane<TOwner> {
    const lane: Lane<TOwner> = {
      owner,
      queue: [],
      head: 0,
      queuedBytes: 0,
      queuedResponses: 0,
      hold: null,
      retired: false,
      drainScheduled: false,
    };
    this.lanes.set(owner, lane);
    return lane;
  }

  private beginHold(
    owner: TOwner,
    existingLane: Lane<TOwner> | null,
    admission: Promise<void>,
    frame: OwnerLaneFrame,
    measuredBytes?: number,
  ): void {
    if (existingLane?.retired === true || !this.host.isLiveOwner(owner)) {
      // Matches a detached receipt: the owner is gone, so nothing waits for
      // it and a late rejection is not connection-fatal.
      void Promise.resolve(admission).catch(() => undefined);
      return;
    }
    const lane = existingLane ?? this.createLane(owner);
    // Frames in flight are charged only while a budget lets them overlap.
    const bytes = this.limits.ownerInFlight?.()
      ? (measuredBytes ?? Math.max(0, frame.measureBytes()))
      : 0;
    const pendingAdmission: PendingAdmission = { startedAt: this.now() };
    let hold = lane.hold;
    if (!hold) {
      hold = {
        startedAt: pendingAdmission.startedAt,
        peakFrames: lane.queue.length - lane.head,
        peakBytes: lane.queuedBytes,
        responseQueued: lane.queuedResponses > 0,
        warned: false,
        admissions: new Set(),
        longestSettledMs: 0,
        pending: 0,
        pendingBytes: 0,
        exclusive: false,
      };
      lane.hold = hold;
      this.ensureWatch();
    }
    const current = hold;
    current.admissions.add(pendingAdmission);
    current.pending += 1;
    current.pendingBytes += bytes;
    this.inFlightBytes += bytes;
    if (frame.kind !== 'notification' || frame.overlap !== true)
      current.exclusive = true;
    Promise.resolve(admission).then(
      () => {
        if (lane.hold !== current) return;
        current.pending -= 1;
        current.pendingBytes -= bytes;
        this.inFlightBytes -= bytes;
        this.settleAdmission(lane, current, pendingAdmission);
        if (this.lanes.get(owner) === lane) this.drain(lane);
        else this.updateSourcePressure();
      },
      (error: unknown) => {
        if (lane.hold !== current) return;
        lane.hold = null;
        this.inFlightBytes -= current.pendingBytes;
        this.finishOwnerHold('failed', current);
        if (this.lanes.get(owner) !== lane) return;
        this.host.onAdmissionFailure(toError(error));
      },
    );
  }

  /**
   * One admission of `hold` settled. The hold ends with its last admission.
   * While others stay pending, the hold is measured from the oldest of them,
   * and a slow admission is reported once nothing older than the threshold
   * remains, so admissions that stalled together produce one report.
   */
  private settleAdmission(
    lane: Lane<TOwner>,
    hold: OwnerHold,
    settled: PendingAdmission,
  ): void {
    const now = this.now();
    hold.admissions.delete(settled);
    hold.longestSettledMs = Math.max(
      hold.longestSettledMs,
      now - settled.startedAt,
    );
    const oldest = this.oldestAdmission(hold);
    if (!oldest) {
      lane.hold = null;
      this.finishHold(
        'owner-admission',
        'released',
        hold,
        hold.longestSettledMs,
      );
      return;
    }
    hold.startedAt = oldest.startedAt;
    const threshold = this.limits.longHoldThresholdMs;
    if (hold.longestSettledMs < threshold) return;
    if (now - oldest.startedAt >= threshold) return;
    this.finishHold('owner-admission', 'released', hold, hold.longestSettledMs);
    // The owner stays held: later admissions start a new measurement.
    hold.longestSettledMs = 0;
    hold.warned = false;
    hold.peakFrames = lane.queue.length - lane.head;
    hold.peakBytes = lane.queuedBytes;
    hold.responseQueued = lane.queuedResponses > 0;
  }

  private oldestAdmission(hold: OwnerHold): PendingAdmission | undefined {
    const first = hold.admissions.values().next();
    return first.done === true ? undefined : first.value;
  }

  /** Ends a hold whose admissions did not all settle. */
  private finishOwnerHold(
    holdOutcome: StdoutHoldOutcome,
    hold: OwnerHold,
  ): void {
    this.finishHold(
      'owner-admission',
      holdOutcome,
      hold,
      Math.max(hold.longestSettledMs, this.now() - hold.startedAt),
    );
  }

  private enqueue(lane: Lane<TOwner>, frame: OwnerLaneFrame): void {
    const bytes = Math.max(0, frame.measureBytes());
    lane.queue.push({ frame, bytes });
    lane.queuedBytes += bytes;
    this.queuedBytes += bytes;
    this.queuedFrames += 1;
    const isResponse = frame.kind === 'response';
    if (isResponse) {
      lane.queuedResponses += 1;
      this.queuedResponses += 1;
    }
    const hold = lane.hold;
    if (hold) {
      hold.peakFrames = Math.max(
        hold.peakFrames,
        lane.queue.length - lane.head,
      );
      hold.peakBytes = Math.max(hold.peakBytes, lane.queuedBytes);
      if (isResponse) hold.responseQueued = true;
    }
    const pause = this.sourcePause;
    if (pause) {
      pause.peakFrames = Math.max(pause.peakFrames, this.queuedFrames);
      pause.peakBytes = Math.max(pause.peakBytes, this.queuedBytes);
      if (isResponse) pause.responseQueued = true;
    }
    this.updateSourcePressure();
  }

  private shift(lane: Lane<TOwner>): QueuedFrame | undefined {
    if (lane.head >= lane.queue.length) return undefined;
    const next = lane.queue[lane.head];
    lane.head += 1;
    if (lane.head >= lane.queue.length) {
      lane.queue = [];
      lane.head = 0;
    } else if (
      lane.head >= QUEUE_COMPACTION_THRESHOLD &&
      lane.head * 2 >= lane.queue.length
    ) {
      lane.queue = lane.queue.slice(lane.head);
      lane.head = 0;
    }
    if (!next) return undefined;
    lane.queuedBytes -= next.bytes;
    this.queuedBytes -= next.bytes;
    this.queuedFrames -= 1;
    if (next.frame.kind === 'response') {
      lane.queuedResponses -= 1;
      this.queuedResponses -= 1;
    }
    return next;
  }

  private scheduleDrain(lane: Lane<TOwner>): void {
    if (lane.drainScheduled) return;
    lane.drainScheduled = true;
    queueMicrotask(() => {
      lane.drainScheduled = false;
      if (this.lanes.get(lane.owner) === lane) this.drain(lane);
    });
  }

  private drain(lane: Lane<TOwner>): void {
    while (this.lanes.get(lane.owner) === lane) {
      const head = lane.queue[lane.head];
      if (
        lane.hold !== null &&
        (!head || !this.mayOverlap(lane, head.frame, head.bytes))
      )
        break;
      const next = this.shift(lane);
      if (!next) {
        if (!lane.drainScheduled) this.lanes.delete(lane.owner);
        break;
      }
      let admission: void | Promise<void>;
      try {
        admission = next.frame.deliver();
      } catch (error) {
        this.host.onDeliveryFailure(toError(error));
        return;
      }
      if (admission)
        this.beginHold(lane.owner, lane, admission, next.frame, next.bytes);
    }
    this.updateSourcePressure();
  }

  private updateSourcePressure(): void {
    // Retained frames, plus frames delivered under a budget whose admissions
    // are pending.
    const heldBytes = this.queuedBytes + this.inFlightBytes;
    if (!this.sourcePause) {
      if (heldBytes > this.limits.highWaterBytes) {
        this.sourcePause = {
          startedAt: this.now(),
          peakFrames: this.queuedFrames,
          peakBytes: this.queuedBytes,
          responseQueued: this.queuedResponses > 0,
          warned: false,
        };
        this.host.pauseSource();
        this.host.onSourcePauseChange(true);
        this.ensureWatch();
      }
      return;
    }
    if (heldBytes <= this.limits.lowWaterBytes) {
      const pause = this.sourcePause;
      this.sourcePause = null;
      this.host.onSourcePauseChange(false);
      this.host.resumeSource();
      this.finishHold('stdout-byte-cap', 'released', pause);
    }
  }

  private finishHold(
    holdKind: StdoutHoldKind,
    holdOutcome: StdoutHoldOutcome,
    hold: HoldStats,
    durationMs: number = this.now() - hold.startedAt,
  ): void {
    const holdDurationMs = Math.max(0, durationMs);
    if (holdDurationMs < this.limits.longHoldThresholdMs) return;
    if (!hold.warned) {
      hold.warned = true;
      this.warn(holdKind, holdDurationMs, hold);
    }
    this.host.reportLongHold({
      holdKind,
      holdOutcome,
      holdDurationMs,
      queuedFrameCount: hold.peakFrames,
      queuedFrameBytes: hold.peakBytes,
      responseQueued: hold.responseQueued,
    });
  }

  private ensureWatch(): void {
    if (this.watchTimer !== null) return;
    const intervalMs = Math.max(
      1,
      Math.min(
        MAX_LONG_HOLD_WATCH_INTERVAL_MS,
        this.limits.longHoldThresholdMs,
      ),
    );
    this.watchTimer = setInterval(() => this.checkLongHolds(), intervalMs);
    this.watchTimer.unref?.();
  }

  private stopWatch(): void {
    if (this.watchTimer !== null) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /** Warns once, while still pending, about each hold past the threshold. */
  private checkLongHolds(): void {
    let active = false;
    const now = this.now();
    for (const lane of Array.from(this.lanes.values())) {
      const hold = lane.hold;
      if (!hold) continue;
      active = true;
      const elapsedMs = now - hold.startedAt;
      if (!hold.warned && elapsedMs >= this.limits.longHoldThresholdMs) {
        hold.warned = true;
        this.warn('owner-admission', elapsedMs, hold);
      }
    }
    const pause = this.sourcePause;
    if (pause) {
      active = true;
      const elapsedMs = now - pause.startedAt;
      if (!pause.warned && elapsedMs >= this.limits.longHoldThresholdMs) {
        pause.warned = true;
        this.warn('stdout-byte-cap', elapsedMs, pause);
      }
    }
    if (!active) this.stopWatch();
  }

  private warn(kind: StdoutHoldKind, elapsedMs: number, hold: HoldStats): void {
    const now = this.now();
    if (now - this.warningWindowStartedAt < LONG_HOLD_WARNING_WINDOW_MS) {
      this.suppressedWarnings += 1;
      return;
    }
    const suppressed = this.suppressedWarnings;
    this.suppressedWarnings = 0;
    this.warningWindowStartedAt = now;
    const queued = `${String(hold.peakFrames)} frame(s), ${String(
      hold.peakBytes,
    )} bytes${hold.responseQueued ? ', including a JSON-RPC response' : ''}`;
    const summary =
      suppressed > 0
        ? `; suppressed ${String(suppressed)} similar warning(s) in the previous ${String(
            LONG_HOLD_WARNING_WINDOW_MS / 1000,
          )}s`
        : '';
    this.host.warnLongHold(
      kind === 'owner-admission'
        ? `Codex app-server owner admission held for ${formatSeconds(
            elapsedMs,
          )}s (${queued} queued for that owner); other owners continue${summary}`
        : `Codex app-server stdout paused for ${formatSeconds(
            elapsedMs,
          )}s at the ${String(
            this.limits.highWaterBytes,
          )}-byte retained-frame cap (${queued} queued)${summary}`,
    );
  }
}
