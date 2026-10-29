/**
 * Per-window aggregation of this renderer's frame and delivery diagnostics,
 * sent to main as one `RendererDiagnosticsSummary` per window. Counts and
 * durations only: no chat, path, URL, function name or other identity leaves
 * this file. The host supplies the clock, visibility and transport, so this
 * file has no DOM, store or IPC imports.
 *
 * The record methods are the hot path: a few counter increments and no
 * allocation per delivered message.
 */
import type {
  ChatEvent,
  ChatInterestChatRef,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import type { RendererDiagnosticsSummary } from '@canopy/desktop-shared/types/observability';

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
    applyMs: number,
  ) => void;
  /** One `chat:event` and the time its apply took. */
  readonly recordChatEvent: (event: ChatEvent, applyMs: number) => void;
  /**
   * One terminal output subscriber's handling of a delivery. Consecutive
   * calls for the same `terminalId` and `seq` are one delivery reaching
   * several subscribers: it counts once, and their apply times add up.
   */
  readonly recordTerminalOutput: (
    terminalId: string,
    seq: number,
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
    if (!('scripts' in entry) || !isEntryList(entry.scripts)) return;
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
  };

  return {
    setInterest: (interest): void => {
      if (interest === interestSource) return;
      interestSource = interest;
      onScreenChats = interest === null ? null : buildOnScreenChats(interest);
    },

    recordChatState: (event, applyMs): void => {
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

    recordChatEvent: (event, applyMs): void => {
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

    recordTerminalOutput: (terminalId, seq, applyMs): void => {
      // Every subscriber's listener runs synchronously for one IPC delivery
      // before the next one arrives, so a repeat of the last delivery's
      // terminal and sequence is the same delivery.
      if (terminalId !== lastTerminalId || seq !== lastTerminalSeq) {
        lastTerminalId = terminalId;
        lastTerminalSeq = seq;
        counts.terminalDeliveries += 1;
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
      windowStart = now;
      counts = emptyCounts();
      frameSampleLength = 0;
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
