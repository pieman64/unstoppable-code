/**
 * Per-window aggregation of this renderer's frame and delivery diagnostics,
 * sent to main as one `RendererDiagnosticsSummary` per window. Counts,
 * durations, row-count buckets and values from fixed vocabularies only: no
 * chat, path, URL, source or function name leaves this file. The host supplies
 * the clock, visibility and transport, so this file has no DOM, store or IPC
 * imports.
 *
 * The record methods are the hot path: a few counter increments and no
 * allocation per delivered message, plus fixed-ring writes and one pending
 * delivery-tail microtask.
 */
import type {
  ChatEvent,
  ChatInterestChatRef,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import {
  RENDERER_LONG_FRAME_CALLBACK_INVOKERS,
  RENDERER_LONG_FRAME_EVENT_INVOKERS,
  type RendererChatRowsBucket,
  type RendererDiagnosticsSummary,
  type RendererLongFrame,
  type RendererLongFrameScript,
} from '@canopy/desktop-shared/types/observability';

/** Length of one diagnostic window. */
export const RENDERER_DIAGNOSTICS_WINDOW_MS = 30_000;
/** Most frame durations one window keeps for its p95 (reservoir sample). */
export const FRAME_SAMPLE_LIMIT = 256;
/**
 * Main rejects a summary whose window is longer than this. A longer window
 * means the timer was suspended (for example the computer slept), so its
 * data is dropped instead of reported.
 */
export const MAX_WINDOW_MS = 120_000;
/** Long animation frames begin at one second. */
export const LONG_FRAME_MIN_MS = 1_000;
/** Longest animation frames retained for one window. */
export const LONG_FRAME_LIMIT = 3;
/** Longest Chromium-attributed scripts retained for one frame. */
export const LONG_FRAME_SCRIPT_LIMIT = 3;
/** Delivery history retained so delayed LoAF entries can find their deliveries. */
export const DELIVERY_RING_SIZE = 1_024;
/** Main's bound for every count. */
const MAX_COUNT = 10_000_000;

export interface RendererDiagnosticsInterest {
  readonly focused: readonly ChatInterestChatRef[];
  readonly warm: readonly ChatInterestChatRef[];
}

export interface RendererDiagnosticsHost {
  /** Monotonic milliseconds (`performance.now`). */
  readonly now: () => number;
  /** The document is hidden: the window's data is dropped, not sent. */
  readonly isHidden: () => boolean;
  /** This renderer shows another computer (a remote access window). */
  readonly remoteWindow: boolean;
  readonly send: (summary: RendererDiagnosticsSummary) => void;
  /** Uniform in [0, 1); for the frame sample. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Queues the delivery tail microtask. Defaults to the global `queueMicrotask`. */
  readonly queueMicrotask?: (callback: () => void) => void;
  /** Largest committed row count among focused chats, read only for retained long frames. */
  readonly focusedChatRowCount?: () => number | null;
}

export interface RendererDiagnosticsAggregator {
  /**
   * The window's focused and warm chats. `null` (no interest known yet)
   * counts every chat as on screen: main delivers everything to a window
   * that has not declared, and the window shows what it receives.
   */
  readonly setInterest: (interest: RendererDiagnosticsInterest | null) => void;
  /** One `chat:state-changed` message and the time its apply took. */
  readonly recordChatState: (
    event: ChatStateChangedEvent,
    startedAt: number,
    applyMs: number,
  ) => void;
  /** One `chat:event` and the time its apply took. */
  readonly recordChatEvent: (
    event: ChatEvent,
    startedAt: number,
    applyMs: number,
  ) => void;
  /**
   * One terminal output subscriber's handling of a delivery. Consecutive
   * calls for the same `terminalId` and `seq` are one delivery reaching
   * several subscribers: it counts once, and their apply times add up.
   */
  readonly recordTerminalOutput: (
    terminalId: string,
    seq: number,
    startedAt: number,
    applyMs: number,
  ) => void;
  /** `long-animation-frame` entries; anything else is ignored. */
  readonly recordFrameEntries: (entries: readonly unknown[]) => void;
  /**
   * End the current window and start the next. Sends and returns its
   * summary when it has something to report and the document is visible;
   * otherwise drops it and returns `null`.
   */
  readonly flush: () => RendererDiagnosticsSummary | null;
}

interface WindowCounts {
  frameCount: number;
  frameMaxMs: number;
  frameBlockingMs: number;
  userCallback: number;
  eventListener: number;
  promise: number;
  script: number;
  onScreenChanges: number;
  offScreenChanges: number;
  scopeChanges: number;
  onScreenMessages: number;
  offScreenMessages: number;
  mixedMessages: number;
  stateOnScreenApplyMs: number;
  stateOffScreenApplyMs: number;
  stateMixedApplyMs: number;
  onScreenEvents: number;
  offScreenEvents: number;
  delegationEvents: number;
  eventOnScreenApplyMs: number;
  eventOffScreenApplyMs: number;
  eventDelegationApplyMs: number;
  terminalDeliveries: number;
  terminalApplyMs: number;
}

function emptyCounts(): WindowCounts {
  return {
    frameCount: 0,
    frameMaxMs: 0,
    frameBlockingMs: 0,
    userCallback: 0,
    eventListener: 0,
    promise: 0,
    script: 0,
    onScreenChanges: 0,
    offScreenChanges: 0,
    scopeChanges: 0,
    onScreenMessages: 0,
    offScreenMessages: 0,
    mixedMessages: 0,
    stateOnScreenApplyMs: 0,
    stateOffScreenApplyMs: 0,
    stateMixedApplyMs: 0,
    onScreenEvents: 0,
    offScreenEvents: 0,
    delegationEvents: 0,
    eventOnScreenApplyMs: 0,
    eventOffScreenApplyMs: 0,
    eventDelegationApplyMs: 0,
    terminalDeliveries: 0,
    terminalApplyMs: 0,
  };
}

function hasData(counts: WindowCounts): boolean {
  return (
    counts.frameCount > 0 ||
    counts.onScreenChanges > 0 ||
    counts.offScreenChanges > 0 ||
    counts.scopeChanges > 0 ||
    counts.onScreenMessages > 0 ||
    counts.offScreenMessages > 0 ||
    counts.mixedMessages > 0 ||
    counts.onScreenEvents > 0 ||
    counts.offScreenEvents > 0 ||
    counts.delegationEvents > 0 ||
    counts.terminalDeliveries > 0
  );
}

/** Chat ids by project, then worktree: an O(1), allocation-free lookup. */
type OnScreenChats = Map<string, Map<string, Set<string>>>;

function buildOnScreenChats(
  interest: RendererDiagnosticsInterest,
): OnScreenChats {
  const chats: OnScreenChats = new Map();
  const add = (ref: ChatInterestChatRef): void => {
    let worktrees = chats.get(ref.projectId);
    if (worktrees === undefined) {
      worktrees = new Map();
      chats.set(ref.projectId, worktrees);
    }
    let ids = worktrees.get(ref.worktreeId);
    if (ids === undefined) {
      ids = new Set();
      worktrees.set(ref.worktreeId, ids);
    }
    ids.add(ref.chatId);
  };
  interest.focused.forEach(add);
  interest.warm.forEach(add);
  return chats;
}

function isDelegationEvent(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === 'canopy_delegation'
  );
}

function isEntryList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function roundMs(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(value * 1000) / 1000));
}

function count(value: number): number {
  return Math.min(MAX_COUNT, value);
}

/** A focused chat's committed row count as the lower bound of its bucket. */
export function chatRowsBucket(rows: number): RendererChatRowsBucket {
  if (rows < 1_000) return 0;
  if (rows < 5_000) return 1_000;
  if (rows < 20_000) return 5_000;
  if (rows < 50_000) return 20_000;
  return 50_000;
}

type LongFrameInvokerType = RendererLongFrameScript['invokerType'];

interface LongFrameRecord {
  readonly rawDuration: number;
  readonly frame: RendererLongFrame;
}

function longFrameInvokerType(value: unknown): LongFrameInvokerType | null {
  switch (value) {
    case 'user-callback':
    case 'event-listener':
      return value;
    case 'resolve-promise':
    case 'reject-promise':
      return 'promise';
    case 'classic-script':
    case 'module-script':
      return 'script';
    default:
      return null;
  }
}

function callbackInvoker(value: unknown): RendererLongFrameScript['invoker'] {
  if (typeof value !== 'string') return null;
  return (
    RENDERER_LONG_FRAME_CALLBACK_INVOKERS.find((item) => item === value) ?? null
  );
}

function eventInvoker(value: unknown): RendererLongFrameScript['invoker'] {
  if (typeof value !== 'string') return null;
  const separator = value.lastIndexOf('.');
  const eventName = separator < 0 ? value : value.slice(separator + 1);
  return (
    RENDERER_LONG_FRAME_EVENT_INVOKERS.find((item) => item === eventName) ??
    null
  );
}

function longFrameSourceKind(
  value: unknown,
): RendererLongFrameScript['sourceKind'] {
  if (typeof value !== 'string' || value === '') return 'none';
  try {
    const protocol = new URL(value).protocol;
    switch (protocol) {
      case 'http:':
      case 'https:':
        return 'http';
      case 'blob:':
        return 'blob';
      case 'data:':
        return 'data';
      default:
        return 'other';
    }
  } catch {
    return 'other';
  }
}

interface LongFrameScriptCandidate {
  readonly rawDuration: number;
  readonly order: number;
  readonly script: RendererLongFrameScript;
}

/** One Chromium script entry reduced to the fixed vocabularies, or `null`. */
function longFrameScript(
  candidate: unknown,
  order: number,
): LongFrameScriptCandidate | null {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('invokerType' in candidate)
  ) {
    return null;
  }
  const invokerType = longFrameInvokerType(candidate.invokerType);
  if (invokerType === null) return null;
  const durationValue = 'duration' in candidate ? candidate.duration : 0;
  const rawInvoker = 'invoker' in candidate ? candidate.invoker : undefined;
  let invoker: RendererLongFrameScript['invoker'] = null;
  if (invokerType === 'user-callback') invoker = callbackInvoker(rawInvoker);
  if (invokerType === 'event-listener') invoker = eventInvoker(rawInvoker);
  return {
    rawDuration: nonNegativeNumber(durationValue),
    order,
    script: {
      invokerType,
      invoker,
      sourceKind: longFrameSourceKind(
        'sourceURL' in candidate ? candidate.sourceURL : undefined,
      ),
      durationMs: roundMs(nonNegativeNumber(durationValue), MAX_WINDOW_MS),
    },
  };
}

/** The longest attributed scripts of one frame, longest first. */
function topLongFrameScripts(entryScripts: unknown): RendererLongFrameScript[] {
  if (!isEntryList(entryScripts)) return [];
  const candidates: LongFrameScriptCandidate[] = [];
  entryScripts.forEach((candidate, index) => {
    const script = longFrameScript(candidate, index);
    if (script !== null) candidates.push(script);
  });
  candidates.sort(
    (left, right) =>
      right.rawDuration - left.rawDuration || left.order - right.order,
  );
  return candidates
    .slice(0, LONG_FRAME_SCRIPT_LIMIT)
    .map((candidate) => candidate.script);
}

/** Nearest-rank 95th percentile of `samples[0..length)`. */
function percentile95(samples: Float64Array, length: number): number {
  if (length === 0) return 0;
  const sorted = Array.from(samples.subarray(0, length)).sort((a, b) => a - b);
  return sorted[Math.ceil(length * 0.95) - 1] ?? 0;
}

export function createRendererDiagnosticsAggregator(
  host: RendererDiagnosticsHost,
): RendererDiagnosticsAggregator {
  const random = host.random ?? Math.random;
  let counts = emptyCounts();
  let windowStart = host.now();
  let onScreenChats: OnScreenChats | null = null;
  let interestSource: RendererDiagnosticsInterest | null = null;
  const frameSamples = new Float64Array(FRAME_SAMPLE_LIMIT);
  let frameSampleLength = 0;
  let lastTerminalId: string | null = null;
  let lastTerminalSeq = 0;
  let lastTerminalSlot = -1;
  let longFrameRecords: LongFrameRecord[] = [];

  // LoAF entries arrive after their frame ends, often after the IPC burst
  // queued during a freeze. Keep 1,024 time-keyed deliveries; overflow
  // overwrites the oldest and undercounts that history.
  const deliveryStarts = new Float64Array(DELIVERY_RING_SIZE);
  deliveryStarts.fill(Number.NaN);
  const deliveryDurations = new Float64Array(DELIVERY_RING_SIZE);
  const deliveryClasses = new Uint8Array(DELIVERY_RING_SIZE);
  let deliveryWriteIndex = 0;
  let lastDeliverySlot = -1;
  let lastDeliveryEnd = 0;
  let deliveryTailPending = false;
  const enqueueMicrotask = host.queueMicrotask ?? queueMicrotask;

  const deliveryTail = (): void => {
    deliveryTailPending = false;
    if (lastDeliverySlot < 0) return;
    const tailMs = Math.max(0, host.now() - lastDeliveryEnd);
    deliveryDurations[lastDeliverySlot] += tailMs;
  };

  // The first delivery queues the tail; later deliveries' microtasks in the
  // same task follow it. React's immediate store render is queued by the first
  // update and batches later updates, so it is included. Streamed chat content
  // publishes on the next frame via stores/chat/frame-batched-store-view.ts
  // and stores/chat/render-cadence.ts, so its render belongs to renderMs.
  const ensureDeliveryTail = (): void => {
    if (deliveryTailPending) return;
    deliveryTailPending = true;
    enqueueMicrotask(deliveryTail);
  };

  const recordDelivery = (
    startedAt: number,
    applyMs: number,
    deliveryClass: 0 | 1 | 2,
  ): number => {
    const slot = deliveryWriteIndex;
    deliveryStarts[slot] = startedAt;
    deliveryDurations[slot] = applyMs;
    deliveryClasses[slot] = deliveryClass;
    deliveryWriteIndex = (slot + 1) % DELIVERY_RING_SIZE;
    lastDeliverySlot = slot;
    lastDeliveryEnd = startedAt + applyMs;
    ensureDeliveryTail();
    return slot;
  };

  const focusedChatRows = (): RendererChatRowsBucket | null => {
    try {
      const rowCount = host.focusedChatRowCount?.();
      if (
        typeof rowCount !== 'number' ||
        !Number.isFinite(rowCount) ||
        rowCount < 0
      ) {
        return null;
      }
      return chatRowsBucket(rowCount);
    } catch {
      return null;
    }
  };

  const countDeliveries = (
    startTime: number,
    end: number,
  ): RendererLongFrame['deliveries'] => {
    const classCounts = [0, 0, 0];
    let deliveryMs = 0;
    for (let index = 0; index < DELIVERY_RING_SIZE; index += 1) {
      const deliveryStart = deliveryStarts[index];
      if (!(deliveryStart >= startTime && deliveryStart <= end)) continue;
      const deliveryClass = deliveryClasses[index];
      classCounts[deliveryClass] = (classCounts[deliveryClass] ?? 0) + 1;
      deliveryMs += deliveryDurations[index];
    }
    return {
      chatState: count(classCounts[0] ?? 0),
      chatEvent: count(classCounts[1] ?? 0),
      terminal: count(classCounts[2] ?? 0),
      deliveryMs: roundMs(deliveryMs, MAX_WINDOW_MS),
    };
  };

  const buildLongFrame = (
    entry: object,
    duration: number,
  ): RendererLongFrame => {
    const startTime =
      'startTime' in entry ? nonNegativeNumber(entry.startTime) : 0;
    const end = startTime + duration;
    const renderStart =
      'renderStart' in entry ? nonNegativeNumber(entry.renderStart) : 0;
    const styleAndLayoutStart =
      'styleAndLayoutStart' in entry
        ? nonNegativeNumber(entry.styleAndLayoutStart)
        : 0;
    const scripts = topLongFrameScripts(
      'scripts' in entry ? entry.scripts : undefined,
    );
    const deliveries = countDeliveries(startTime, end);

    return {
      durationMs: roundMs(duration, MAX_WINDOW_MS),
      blockingMs: roundMs(
        'blockingDuration' in entry
          ? nonNegativeNumber(entry.blockingDuration)
          : 0,
        MAX_WINDOW_MS,
      ),
      scriptMs: roundMs(
        (renderStart > 0 ? renderStart : end) - startTime,
        MAX_WINDOW_MS,
      ),
      renderMs: roundMs(
        renderStart > 0
          ? (styleAndLayoutStart > 0 ? styleAndLayoutStart : end) - renderStart
          : 0,
        MAX_WINDOW_MS,
      ),
      layoutMs: roundMs(
        styleAndLayoutStart > 0 ? end - styleAndLayoutStart : 0,
        MAX_WINDOW_MS,
      ),
      deliveries,
      focusedChatRows: focusedChatRows(),
      scripts,
    };
  };

  const retainLongFrame = (entry: object, duration: number): void => {
    if (longFrameRecords.length === LONG_FRAME_LIMIT) {
      const shortest = longFrameRecords[LONG_FRAME_LIMIT - 1];
      if (shortest !== undefined && duration <= shortest.rawDuration) return;
    }
    let insertionIndex = longFrameRecords.length;
    while (insertionIndex > 0) {
      const previous = longFrameRecords[insertionIndex - 1];
      if (previous === undefined || duration <= previous.rawDuration) break;
      insertionIndex -= 1;
    }
    const record: LongFrameRecord = {
      rawDuration: duration,
      frame: buildLongFrame(entry, duration),
    };
    longFrameRecords.splice(insertionIndex, 0, record);
    if (longFrameRecords.length > LONG_FRAME_LIMIT) longFrameRecords.pop();
  };

  const isOnScreen = (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): boolean => {
    if (onScreenChats === null) return true;
    return onScreenChats.get(projectId)?.get(worktreeId)?.has(chatId) ?? false;
  };

  const recordFrame = (entry: object): void => {
    if (!('duration' in entry)) return;
    const duration = nonNegativeNumber(entry.duration);
    counts.frameCount += 1;
    if (duration > counts.frameMaxMs) counts.frameMaxMs = duration;
    if ('blockingDuration' in entry) {
      counts.frameBlockingMs += nonNegativeNumber(entry.blockingDuration);
    }
    // Reservoir sample: every frame of the window is equally likely to be
    // kept, so the p95 stays unbiased with a fixed buffer.
    if (frameSampleLength < FRAME_SAMPLE_LIMIT) {
      frameSamples[frameSampleLength] = duration;
      frameSampleLength += 1;
    } else {
      const slot = Math.floor(random() * counts.frameCount);
      if (slot < FRAME_SAMPLE_LIMIT) frameSamples[slot] = duration;
    }
    if ('scripts' in entry && isEntryList(entry.scripts)) {
      for (const script of entry.scripts) {
        if (
          typeof script !== 'object' ||
          script === null ||
          !('invokerType' in script)
        ) {
          continue;
        }
        switch (script.invokerType) {
          case 'user-callback':
            counts.userCallback += 1;
            break;
          case 'event-listener':
            counts.eventListener += 1;
            break;
          case 'resolve-promise':
          case 'reject-promise':
            counts.promise += 1;
            break;
          case 'classic-script':
          case 'module-script':
            counts.script += 1;
            break;
          default:
            break;
        }
      }
    }
    // Keep sub-second frames on the old path: no script sanitization or host
    // callback reads until a >=1 s frame is known to enter the top three.
    if (duration >= LONG_FRAME_MIN_MS) retainLongFrame(entry, duration);
  };

  return {
    setInterest: (interest): void => {
      if (interest === interestSource) return;
      interestSource = interest;
      onScreenChats = interest === null ? null : buildOnScreenChats(interest);
    },

    recordChatState: (event, startedAt, applyMs): void => {
      recordDelivery(startedAt, applyMs, 0);
      let onScreen = 0;
      let offScreen = 0;
      const changes = event.changes;
      for (let index = 0; index < changes.length; index += 1) {
        const change = changes[index];
        if (change === undefined) continue;
        if (!('chatId' in change)) {
          counts.scopeChanges += 1;
        } else if (
          isOnScreen(event.projectId, event.worktreeId, change.chatId)
        ) {
          onScreen += 1;
        } else {
          offScreen += 1;
        }
      }
      counts.onScreenChanges += onScreen;
      counts.offScreenChanges += offScreen;
      // A message with only scope-level changes (no chat) applies to what
      // the window shows, so it lands in the on-screen bucket.
      if (offScreen === 0) {
        counts.onScreenMessages += 1;
        counts.stateOnScreenApplyMs += applyMs;
      } else if (onScreen === 0) {
        counts.offScreenMessages += 1;
        counts.stateOffScreenApplyMs += applyMs;
      } else {
        counts.mixedMessages += 1;
        counts.stateMixedApplyMs += applyMs;
      }
    },

    recordChatEvent: (event, startedAt, applyMs): void => {
      recordDelivery(startedAt, applyMs, 1);
      // Delegate card events are their own class, whichever chat they are in.
      if (isDelegationEvent(event.data)) {
        counts.delegationEvents += 1;
        counts.eventDelegationApplyMs += applyMs;
      } else if (isOnScreen(event.projectId, event.worktreeId, event.chatId)) {
        counts.onScreenEvents += 1;
        counts.eventOnScreenApplyMs += applyMs;
      } else {
        counts.offScreenEvents += 1;
        counts.eventOffScreenApplyMs += applyMs;
      }
    },

    recordTerminalOutput: (terminalId, seq, startedAt, applyMs): void => {
      // Every subscriber's listener runs synchronously for one IPC delivery
      // before the next one arrives, so a repeat of the last delivery's
      // terminal and sequence is the same delivery.
      if (terminalId !== lastTerminalId || seq !== lastTerminalSeq) {
        lastTerminalId = terminalId;
        lastTerminalSeq = seq;
        counts.terminalDeliveries += 1;
        lastTerminalSlot = recordDelivery(startedAt, applyMs, 2);
      } else if (lastTerminalSlot >= 0) {
        deliveryDurations[lastTerminalSlot] += applyMs;
        lastDeliverySlot = lastTerminalSlot;
        lastDeliveryEnd = startedAt + applyMs;
        ensureDeliveryTail();
      } else {
        lastTerminalSlot = recordDelivery(startedAt, applyMs, 2);
      }
      counts.terminalApplyMs += applyMs;
    },

    recordFrameEntries: (entries): void => {
      for (const entry of entries) {
        if (typeof entry === 'object' && entry !== null) recordFrame(entry);
      }
    },

    flush: (): RendererDiagnosticsSummary | null => {
      const now = host.now();
      const windowMs = now - windowStart;
      const current = counts;
      const sampleLength = frameSampleLength;
      const currentLongFrames: RendererLongFrame[] = [];
      for (const record of longFrameRecords) {
        currentLongFrames.push(record.frame);
      }
      windowStart = now;
      counts = emptyCounts();
      frameSampleLength = 0;
      longFrameRecords = [];
      if (
        host.isHidden() ||
        windowMs <= 0 ||
        windowMs > MAX_WINDOW_MS ||
        !hasData(current)
      ) {
        return null;
      }
      const durationCap = windowMs * 10;
      const summary: RendererDiagnosticsSummary = {
        windowMs: roundMs(windowMs, MAX_WINDOW_MS),
        remoteWindow: host.remoteWindow,
        frames: {
          count: count(current.frameCount),
          p95Ms: roundMs(
            percentile95(frameSamples, sampleLength),
            MAX_WINDOW_MS,
          ),
          maxMs: roundMs(current.frameMaxMs, MAX_WINDOW_MS),
          blockingMs: roundMs(current.frameBlockingMs, durationCap),
          invokers: {
            userCallback: count(current.userCallback),
            eventListener: count(current.eventListener),
            promise: count(current.promise),
            script: count(current.script),
          },
          long: currentLongFrames,
        },
        chatState: {
          onScreenChanges: count(current.onScreenChanges),
          offScreenChanges: count(current.offScreenChanges),
          scopeChanges: count(current.scopeChanges),
          onScreenMessages: count(current.onScreenMessages),
          offScreenMessages: count(current.offScreenMessages),
          mixedMessages: count(current.mixedMessages),
          onScreenApplyMs: roundMs(current.stateOnScreenApplyMs, durationCap),
          offScreenApplyMs: roundMs(current.stateOffScreenApplyMs, durationCap),
          mixedApplyMs: roundMs(current.stateMixedApplyMs, durationCap),
        },
        chatEvent: {
          onScreenEvents: count(current.onScreenEvents),
          offScreenEvents: count(current.offScreenEvents),
          delegationEvents: count(current.delegationEvents),
          onScreenApplyMs: roundMs(current.eventOnScreenApplyMs, durationCap),
          offScreenApplyMs: roundMs(current.eventOffScreenApplyMs, durationCap),
          delegationApplyMs: roundMs(
            current.eventDelegationApplyMs,
            durationCap,
          ),
        },
        terminal: {
          deliveries: count(current.terminalDeliveries),
          applyMs: roundMs(current.terminalApplyMs, durationCap),
        },
      };
      host.send(summary);
      return summary;
    },
  };
}
