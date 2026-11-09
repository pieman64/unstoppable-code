import type {
  CloudProjectLifecycleEvent,
  CloudProjectLifecycleEventsPage,
} from '@canopy/protocol/memory-sync';

/** The most pages one read of a project's feed requests, so main is never held long. */
export const EVENT_PAGES_MAX = 10;

/** How far a fold has read, which the next read goes on from. */
export interface FeedFoldPosition<State> {
  state: State;
  /** The feed position after the last event folded. */
  cursor: string | null;
}

export interface FeedFold<State> extends FeedFoldPosition<State> {
  /** Whether the fold reached the feed's end; otherwise the next one goes on. */
  complete: boolean;
}

export interface FeedFoldRead<State> {
  /** One page of the feed after `after` (null: from its first event). */
  page(after: string | null): Promise<CloudProjectLifecycleEventsPage>;
  step(state: State, event: CloudProjectLifecycleEvent): State;
  /** Whether the server refused the position (`invalid_cursor`). */
  refused(error: unknown): boolean;
}

/**
 * Folds at most `EVENT_PAGES_MAX` more pages of a project's feed, going on
 * from `from` (null: from the first event, with `initial`). A position the
 * server refuses, as after a restore, starts the fold over from the first
 * event. `onPage` sees the fold after each page, so a read that fails part
 * way keeps what it read.
 */
export async function foldFeed<State>(
  initial: State,
  from: FeedFoldPosition<State> | null,
  read: FeedFoldRead<State>,
  onPage: (position: FeedFoldPosition<State>) => void = (): void => {},
): Promise<FeedFold<State>> {
  let state = from?.state ?? initial;
  let cursor = from?.cursor ?? null;
  for (let page = 0; page < EVENT_PAGES_MAX; page++) {
    let events: CloudProjectLifecycleEventsPage;
    try {
      events = await read.page(cursor);
    } catch (error) {
      if (cursor === null || !read.refused(error)) throw error;
      state = initial;
      cursor = null;
      continue;
    }
    for (const { event } of events.events) state = read.step(state, event);
    cursor = events.nextCursor;
    onPage({ state, cursor });
    if (!events.hasMore) return { state, cursor, complete: true };
  }
  return { state, cursor, complete: false };
}

/**
 * Folds over whole project feeds, from their first event, carried in memory
 * from one read to the next under a key (CAN-5190). Each read folds at most
 * `EVENT_PAGES_MAX` more pages from where the last read of its key stopped,
 * so a feed of any length reaches its end within a bounded number of reads
 * and is never read again from its start.
 */
export class FeedFolds<State> {
  private readonly folds = new Map<string, FeedFoldPosition<State>>();

  constructor(private readonly initial: State) {}

  fold(key: string, read: FeedFoldRead<State>): Promise<FeedFold<State>> {
    return foldFeed(
      this.initial,
      this.folds.get(key) ?? null,
      read,
      (position) => {
        this.folds.set(key, position);
      },
    );
  }
}
