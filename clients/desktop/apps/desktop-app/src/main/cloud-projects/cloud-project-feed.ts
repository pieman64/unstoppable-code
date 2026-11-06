import type {
  CloudProjectLifecycleEvent,
  CloudProjectLifecycleEventsPage,
} from '@canopy/protocol/memory-sync';

/** The most pages one read of a project's feed requests, so main is never held long. */
export const EVENT_PAGES_MAX = 10;

export interface FeedFold<State> {
  state: State;
  /** The feed position after the last event folded. */
  cursor: string | null;
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
 * Folds over whole project feeds, from their first event, carried from one
 * read to the next under a key (CAN-5190). Each read folds at most
 * `EVENT_PAGES_MAX` more pages from where the last read of its key stopped,
 * so a feed of any length reaches its end within a bounded number of reads
 * and is never read again from its start. A position the server refuses, as
 * after a restore, starts that fold over.
 */
export class FeedFolds<State> {
  private readonly folds = new Map<
    string,
    { state: State; cursor: string | null }
  >();

  constructor(private readonly initial: State) {}

  async fold(key: string, read: FeedFoldRead<State>): Promise<FeedFold<State>> {
    let { state, cursor } = this.folds.get(key) ?? {
      state: this.initial,
      cursor: null,
    };
    for (let page = 0; page < EVENT_PAGES_MAX; page++) {
      let events: CloudProjectLifecycleEventsPage;
      try {
        events = await read.page(cursor);
      } catch (error) {
        if (cursor === null || !read.refused(error)) throw error;
        state = this.initial;
        cursor = null;
        this.folds.delete(key);
        continue;
      }
      for (const { event } of events.events) state = read.step(state, event);
      cursor = events.nextCursor;
      this.folds.set(key, { state, cursor });
      if (!events.hasMore) return { state, cursor, complete: true };
    }
    return { state, cursor, complete: false };
  }
}
