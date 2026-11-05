/**
 * Turns this window's focused chats into a `ChatInterestDeclaration` and
 * sends it: recomputed when a source changes, coalesced to one send per
 * animation frame, and skipped when unchanged. The host supplies the sources
 * and transport, so this file has no store or IPC imports.
 */
import type {
  ChatInterestChatRef,
  ChatInterestDeclaration,
  ChatInterestRunRef,
} from '@canopy/desktop-shared/types';

/** Most focused chats one declaration carries (main rejects more). */
export const MAX_FOCUSED_CHATS = 32;
/** Most warm chats one declaration may carry (main rejects more). */
export const MAX_WARM_CHATS = 16;
/** Most expanded delegate runs one declaration may carry. */
export const MAX_FOCUSED_RUNS = 64;
/** Recently focused chats this window keeps warm, most recent first. */
export const WARM_CHAT_LIMIT = 4;
/** Chats warmed ahead of a likely switch (prefetch), most recent first. */
export const PREFETCH_WARM_LIMIT = 4;

/** The chats, expanded runs, and observability entries this window shows. */
export interface ChatInterest {
  readonly focused: readonly ChatInterestChatRef[];
  readonly warm: readonly ChatInterestChatRef[];
  readonly focusedRuns: readonly ChatInterestRunRef[];
  readonly observabilityEntries: boolean;
}

export type ChatInterestListener = (interest: ChatInterest) => void;

export interface ChatInterestTrackerHost {
  /** This window's focused chats now. */
  readonly readFocused: () => ChatInterestChatRef[];
  /** Expanded delegate runs whose cards are mounted in this renderer. */
  readonly readExpandedRuns: () => readonly ChatInterestRunRef[];
  /** Whether this renderer has a mounted audit or usage-detail consumer. */
  readonly readObservabilityEntries: () => boolean;
  /** Sends one declaration. A rejection is reported to `onSendFailed`. */
  readonly send: (declaration: ChatInterestDeclaration) => Promise<void>;
  /** Runs `callback` on the next frame; returns a cancel. */
  readonly scheduleFrame: (callback: () => void) => () => void;
  readonly onSendFailed: (error: unknown) => void;
}

export interface ChatInterestTracker {
  /** A source changed: recompute, and declare on the next frame if changed. */
  readonly invalidate: () => void;
  /** Declare on the next frame even when unchanged. */
  readonly redeclare: () => void;
  /** The current interest, recomputed first when a source changed. */
  readonly current: () => ChatInterest;
  /** Called with the new interest whenever it changes. */
  readonly subscribe: (listener: ChatInterestListener) => () => void;
  /** Send now (or join the current send), resolving only after main acknowledges it. */
  readonly flushNow: () => Promise<void>;
  /**
   * Warm `ref` ahead of a likely switch without focusing it, and declare now.
   * Prefetched chats follow the recently focused ones and never evict them.
   */
  readonly warmUp: (ref: ChatInterestChatRef) => Promise<void>;
  readonly dispose: () => void;
}

export function chatInterestRefKey(ref: ChatInterestChatRef): string {
  return `${ref.projectId}/${ref.worktreeId}/${ref.chatId}`;
}

function sameRefs(
  a: readonly ChatInterestChatRef[],
  b: readonly ChatInterestChatRef[],
): boolean {
  return (
    a.length === b.length &&
    a.every((ref, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        ref.projectId === other.projectId &&
        ref.worktreeId === other.worktreeId &&
        ref.chatId === other.chatId
      );
    })
  );
}

function sameRunRefs(
  a: readonly ChatInterestRunRef[],
  b: readonly ChatInterestRunRef[],
): boolean {
  return (
    a.length === b.length &&
    a.every((ref, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        ref.projectId === other.projectId &&
        ref.worktreeId === other.worktreeId &&
        ref.chatId === other.chatId &&
        ref.delegationId === other.delegationId &&
        ref.runGeneration === other.runGeneration
      );
    })
  );
}

function runIdentity(ref: ChatInterestRunRef): string {
  return JSON.stringify([
    ref.projectId,
    ref.worktreeId,
    ref.chatId,
    ref.delegationId,
    ref.runGeneration,
  ]);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function focusedRunRefs(
  expandedRuns: readonly ChatInterestRunRef[],
  focused: readonly ChatInterestChatRef[],
): ChatInterestRunRef[] {
  const focusedOrder = new Map<string, number>();
  focused.forEach((ref, index) => {
    focusedOrder.set(chatInterestRefKey(ref), index);
  });

  const seen = new Set<string>();
  return expandedRuns
    .map((ref) => ({
      ref,
      focusIndex: focusedOrder.get(chatInterestRefKey(ref)),
    }))
    .filter((entry) => {
      if (entry.focusIndex === undefined) return false;
      const key = runIdentity(entry.ref);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        (left.focusIndex ?? 0) - (right.focusIndex ?? 0) ||
        compareStrings(left.ref.delegationId, right.ref.delegationId) ||
        left.ref.runGeneration - right.ref.runGeneration,
    )
    .slice(0, MAX_FOCUSED_RUNS)
    .map(({ ref }) => ({ ...ref }));
}

function uniqueRefs(
  refs: readonly ChatInterestChatRef[],
  excluded: ReadonlySet<string>,
): ChatInterestChatRef[] {
  const seen = new Set(excluded);
  return refs.filter((ref) => {
    const key = chatInterestRefKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The warm list after focus moves from `previousFocused` to `focused`: chats
 * that just left focus go first, then the earlier warm chats; focused chats
 * are excluded and the list is bounded.
 */
export function nextWarmChats(
  previousFocused: readonly ChatInterestChatRef[],
  focused: readonly ChatInterestChatRef[],
  previousWarm: readonly ChatInterestChatRef[],
): ChatInterestChatRef[] {
  const focusedKeys = new Set(focused.map(chatInterestRefKey));
  return uniqueRefs([...previousFocused, ...previousWarm], focusedKeys).slice(
    0,
    Math.min(WARM_CHAT_LIMIT, MAX_WARM_CHATS),
  );
}

export function createChatInterestTracker(
  host: ChatInterestTrackerHost,
): ChatInterestTracker {
  let interest: ChatInterest = {
    focused: [],
    warm: [],
    focusedRuns: [],
    observabilityEntries: false,
  };
  /** Recently focused, most recent first; the declared warm list adds prefetched. */
  let recent: ChatInterestChatRef[] = [];
  let prefetched: ChatInterestChatRef[] = [];
  let dirty = true;
  let forceSend = false;
  let lastSent: ChatInterest | null = null;
  let cancelFrame: (() => void) | null = null;
  let disposed = false;
  let pendingSend: Promise<void> = Promise.resolve();
  let sendFailed = false;
  const listeners = new Set<ChatInterestListener>();

  const recompute = (): void => {
    if (!dirty) return;
    dirty = false;
    const focused = uniqueRefs(host.readFocused(), new Set()).slice(
      0,
      MAX_FOCUSED_CHATS,
    );
    recent = nextWarmChats(interest.focused, focused, recent);
    const warm = uniqueRefs(
      [...recent, ...prefetched],
      new Set(focused.map(chatInterestRefKey)),
    ).slice(0, MAX_WARM_CHATS);
    const focusedRuns = focusedRunRefs(host.readExpandedRuns(), focused);
    const observabilityEntries = host.readObservabilityEntries();
    if (
      sameRefs(focused, interest.focused) &&
      sameRefs(warm, interest.warm) &&
      sameRunRefs(focusedRuns, interest.focusedRuns) &&
      observabilityEntries === interest.observabilityEntries
    ) {
      return;
    }
    interest = { focused, warm, focusedRuns, observabilityEntries };
    const next = interest;
    listeners.forEach((listener) => listener(next));
  };

  const flush = (): Promise<void> => {
    cancelFrame = null;
    if (disposed) return Promise.resolve();
    recompute();
    if (
      !forceSend &&
      lastSent !== null &&
      sameRefs(lastSent.focused, interest.focused) &&
      sameRefs(lastSent.warm, interest.warm) &&
      sameRunRefs(lastSent.focusedRuns, interest.focusedRuns) &&
      lastSent.observabilityEntries === interest.observabilityEntries
    ) {
      return pendingSend;
    }
    forceSend = false;
    // A failed send is not retried: the next change declares again.
    lastSent = interest;
    const sent = interest;
    sendFailed = false;
    pendingSend = host.send({
      focused: [...sent.focused],
      warm: [...sent.warm],
      focusedRuns: [...sent.focusedRuns],
      observabilityEntries: sent.observabilityEntries,
      // This renderer handles `messages.omitted` (stale-catch-up.ts).
      acceptsMessagesOmitted: true,
    });
    void pendingSend.catch((error: unknown): void => {
      if (lastSent === sent) sendFailed = true;
      host.onSendFailed(error);
    });
    return pendingSend;
  };

  const schedule = (): void => {
    if (disposed || cancelFrame !== null) return;
    cancelFrame = host.scheduleFrame(() => {
      void flush().catch(() => undefined);
    });
  };

  const flushNow = (): Promise<void> => {
    cancelFrame?.();
    cancelFrame = null;
    if (sendFailed) forceSend = true;
    return flush();
  };

  return {
    flushNow,
    warmUp: (ref): Promise<void> => {
      prefetched = uniqueRefs([ref, ...prefetched], new Set()).slice(
        0,
        PREFETCH_WARM_LIMIT,
      );
      dirty = true;
      return flushNow();
    },
    invalidate: (): void => {
      dirty = true;
      schedule();
    },
    redeclare: (): void => {
      forceSend = true;
      schedule();
    },
    current: (): ChatInterest => {
      if (!disposed) recompute();
      return interest;
    },
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    dispose: (): void => {
      disposed = true;
      cancelFrame?.();
      cancelFrame = null;
      listeners.clear();
    },
  };
}
