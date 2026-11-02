import type {
  ChatStateChange,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

/** A reset reload counts endpoint requests, not messages or turn summaries. */
export const MAX_TRANSCRIPT_RESET_PAGES = 20;

const inFlightReloads = new Map<string, Promise<void>>();
const loadedPageCounts = new WeakMap<object, Map<string, number>>();

export function transcriptResetReloadKey(
  scopeKey: string,
  chatId: string,
  createdAt: string,
): string {
  return `${scopeKey}\u0000${chatId}\u0000${createdAt}`;
}

/** Unknown/hydrated windows conservatively count as their initial newest page. */
export function loadedTranscriptPageCount(store: object, key: string): number {
  return loadedPageCounts.get(store)?.get(key) ?? 1;
}

export function recordLoadedTranscriptPage(
  store: object,
  key: string,
  older: boolean,
): number {
  let counts = loadedPageCounts.get(store);
  if (!counts) {
    counts = new Map();
    loadedPageCounts.set(store, counts);
  }
  const count = older ? loadedTranscriptPageCount(store, key) + 1 : 1;
  counts.set(key, count);
  return count;
}

export function replaceLoadedTranscriptPageCount(
  store: object,
  key: string,
  count: number,
): void {
  let counts = loadedPageCounts.get(store);
  if (!counts) {
    counts = new Map();
    loadedPageCounts.set(store, counts);
  }
  counts.set(key, count);
}

export function hasPendingTranscriptReset(
  tab: Pick<PersistedChatTab, 'transcriptLoaded' | 'transcriptWindow'>,
): boolean {
  return tab.transcriptLoaded === false && tab.transcriptWindow !== undefined;
}

export function pendingTranscriptResetRevision(
  tab: Pick<PersistedChatTab, 'transcriptLoaded' | 'transcriptWindow'>,
): number | undefined {
  return hasPendingTranscriptReset(tab)
    ? tab.transcriptWindow?.transcriptRevision
    : undefined;
}

/** Keep concurrent callers on one reload; the loader itself observes newer reset revisions. */
export function coalesceTranscriptResetReload(
  key: string,
  reload: () => Promise<void>,
): Promise<void> {
  const existing = inFlightReloads.get(key);
  if (existing) return existing;

  let resolvePending: () => void = () => undefined;
  let rejectPending: (error: unknown) => void = () => undefined;
  const pending = new Promise<void>((resolve, reject) => {
    resolvePending = resolve;
    rejectPending = reject;
  });
  inFlightReloads.set(key, pending);
  const release = (): void => {
    if (inFlightReloads.get(key) === pending) inFlightReloads.delete(key);
  };
  try {
    void reload().then(
      () => {
        release();
        resolvePending();
      },
      (error: unknown) => {
        release();
        rejectPending(error);
      },
    );
  } catch (error) {
    release();
    rejectPending(error);
  }
  return pending;
}

const locallyRebasedWindows = new WeakSet<object>();

/** Older reads retain their original ranks even when a reset can be applied locally. */
export function isLocallyRebasedTranscriptWindow(
  window: object | undefined,
): boolean {
  return window !== undefined && locallyRebasedWindows.has(window);
}

/** Prove the loaded boundary is unaffected using only this commit's mutations. */
export function canKeepTranscriptWindowAfterReset(
  tab: Pick<
    PersistedChatTab,
    'id' | 'messages' | 'transcriptLoaded' | 'transcriptWindow'
  >,
  changes: readonly ChatStateChange[],
): boolean {
  if (
    tab.transcriptLoaded === false ||
    !tab.transcriptWindow ||
    !tab.messages.length
  )
    return false;
  const loadedIds = new Set(tab.messages.map((message) => message.id));
  const availableIds = new Set(loadedIds);
  const hasTurnFrames = (tab.transcriptWindow.turns?.length ?? 0) > 0;
  let hasRankChange = false;
  for (const change of changes) {
    if (!('chatId' in change) || change.chatId !== tab.id) continue;
    if (change.type === 'messages.replaced') return false;
    if (
      change.type === 'message.upserted' &&
      loadedIds.has(change.message.id) &&
      !availableIds.has(change.message.id)
    )
      return false;
    if (change.type === 'message.removed') {
      if (
        !loadedIds.has(change.messageId) ||
        tab.transcriptWindow.messageOrdinals?.[change.messageId] === undefined
      )
        return false;
      const removed = tab.messages.find(
        (message) => message.id === change.messageId,
      );
      // Rebuilding a root turn's final rows/summary needs its omitted interior.
      // Nested delegate rows do not alter the main-flow turn projection.
      if (hasTurnFrames && !removed?.parentBlockId && !removed?.parentToolUseId)
        return false;
      availableIds.delete(change.messageId);
      hasRankChange = true;
    }
    if (
      change.type === 'message.upserted' &&
      !loadedIds.has(change.message.id)
    ) {
      if (
        !change.afterMessageId ||
        !loadedIds.has(change.afterMessageId) ||
        !availableIds.has(change.afterMessageId) ||
        tab.transcriptWindow.messageOrdinals?.[change.afterMessageId] ===
          undefined
      )
        return false;
      if (
        hasTurnFrames &&
        !change.message.parentBlockId &&
        !change.message.parentToolUseId
      )
        return false;
      hasRankChange = true;
    }
  }
  // A bare reset could describe a replacement or rank shifts outside the window.
  return hasRankChange;
}

/** Rebase known ranks, including omitted turn interiors, without fetching bodies. */
export function rebaseTranscriptWindow(
  previous: Pick<PersistedChatTab, 'messages' | 'transcriptWindow'>,
  messages: PersistedChatTab['messages'],
): PersistedChatTab['transcriptWindow'] {
  const window = previous.transcriptWindow;
  if (!window) return undefined;
  const ordinals = { ...window.messageOrdinals };
  let turns = window.turns;
  let before = window.before;
  const nextIds = new Set(messages.map((message) => message.id));
  const previousIds = new Set(previous.messages.map((message) => message.id));
  const shift = (at: number, delta: number): void => {
    if (before !== undefined && before >= at) before += delta;
    for (const [id, ordinal] of Object.entries(ordinals)) {
      if (ordinal >= at) ordinals[id] = ordinal + delta;
    }
    turns = turns?.map((turn) => ({
      ...turn,
      start: turn.start >= at ? turn.start + delta : turn.start,
      end: turn.end >= at ? turn.end + delta : turn.end,
      ...(turn.before === undefined
        ? {}
        : { before: turn.before >= at ? turn.before + delta : turn.before }),
    }));
  };
  for (const message of previous.messages) {
    if (nextIds.has(message.id)) continue;
    const ordinal = ordinals[message.id];
    delete ordinals[message.id];
    if (ordinal !== undefined) shift(ordinal + 1, -1);
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (previousIds.has(message.id) || ordinals[message.id] !== undefined)
      continue;
    const predecessor = messages[index - 1];
    const predecessorOrdinal = predecessor
      ? ordinals[predecessor.id]
      : undefined;
    if (predecessorOrdinal === undefined) continue;
    const ordinal = predecessorOrdinal + 1;
    shift(ordinal, 1);
    ordinals[message.id] = ordinal;
  }
  const rebased = { ...window, before, messageOrdinals: ordinals, turns };
  locallyRebasedWindows.add(rebased);
  return rebased;
}
