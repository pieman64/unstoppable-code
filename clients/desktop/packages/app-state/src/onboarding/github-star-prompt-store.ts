import {
  GITHUB_STAR_PROMPT_THRESHOLD,
  isGitHubStarPromptRecordRetired,
  mergeGitHubStarPromptRecords,
  type GitHubStarPromptRecord,
} from '@canopy/protocol/onboarding';
import { createStore, type StoreApi } from 'zustand';

/**
 * Shared client state for the one-time GitHub star nudge (CAN-5604). One
 * store per persistence scope: desktop preferences, or one web account in
 * one browser. Hosts supply the scope's storage; the store owns ordering.
 * Hosts whose brand has no source repository supply no store at all, so
 * nothing counts or shows there.
 */

export interface GitHubStarPromptLoadResult {
  record: GitHubStarPromptRecord;
  /**
   * False when the record was defaulted and is not yet stored. Hydration
   * saves it before relying on it.
   */
  persisted: boolean;
}

export interface GitHubStarPromptPersistence {
  /** Reject on a degraded or corrupt read: the prompt then stays hidden. */
  load(): Promise<GitHubStarPromptLoadResult>;
  /**
   * Write through the scope's authoritative writer, merging with the stored
   * record, and resolve with the stored result.
   */
  save(record: GitHubStarPromptRecord): Promise<GitHubStarPromptRecord>;
  /** Existing diagnostics. Never blocks sending. */
  onError?: (error: unknown, operation: GitHubStarPromptOperation) => void;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export type GitHubStarPromptOperation =
  | 'hydrate'
  | 'sent'
  | 'shown'
  | 'dismissed'
  | 'starred';

export type GitHubStarPromptStatus = 'loading' | 'ready' | 'error';

type Timestamped = 'shown' | 'dismissed' | 'starred';

type PendingWrite =
  | {
      kind: 'sent';
      /** The count to store, or null to derive it once hydrated. */
      promptsSent: number | null;
    }
  | { kind: Timestamped; at: string };

export interface GitHubStarPromptState {
  status: GitHubStarPromptStatus;
  /** The last acknowledged (stored) record. Null until hydrated. */
  record: GitHubStarPromptRecord | null;
  /**
   * Retired locally (dismissed or starred) before or without a successful
   * save. Keeps the prompt hidden in this runtime while persistence retries.
   */
  suppressed: boolean;
  hydrate: () => Promise<void>;
  /**
   * Count one accepted chat send. Resolves whether a count was stored;
   * writes stop once the threshold is reached or the prompt retires.
   */
  noteTurnSent: () => Promise<boolean>;
  /** Record the first impression. Resolves false when already recorded. */
  markShown: () => Promise<boolean>;
  markDismissed: () => Promise<boolean>;
  markStarred: () => Promise<boolean>;
  /** Apply a record written elsewhere (another tab or window). */
  reconcile: (record: GitHubStarPromptRecord) => void;
}

export type GitHubStarPromptStore = StoreApi<GitHubStarPromptState>;

/** Whether the prompt is retired: dismissed or starred. */
export function isGitHubStarPromptRetired(
  state: GitHubStarPromptState,
): boolean {
  return (
    state.suppressed ||
    (state.record !== null && isGitHubStarPromptRecordRetired(state.record))
  );
}

/** Whether the prompt may show: hydrated, threshold reached, not retired. */
export function isGitHubStarPromptAvailable(
  state: GitHubStarPromptState,
): boolean {
  return (
    state.status === 'ready' &&
    state.record !== null &&
    state.record.promptsSent >= GITHUB_STAR_PROMPT_THRESHOLD &&
    !isGitHubStarPromptRetired(state)
  );
}

const FIELD: Record<Timestamped, 'shownAt' | 'dismissedAt' | 'starredAt'> = {
  shown: 'shownAt',
  dismissed: 'dismissedAt',
  starred: 'starredAt',
};

export function createGitHubStarPromptStore(
  persistence: GitHubStarPromptPersistence,
): GitHubStarPromptStore {
  const now = persistence.now ?? ((): Date => new Date());
  let queue: Promise<unknown> = Promise.resolve();
  let pending: PendingWrite[] = [];

  /** Serialize every read/write against the latest state. */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  function report(error: unknown, operation: GitHubStarPromptOperation): void {
    persistence.onError?.(error, operation);
  }

  /** The highest count still waiting on a retry. */
  function pendingCount(): number {
    let count = 0;
    for (const entry of pending) {
      if (entry.kind === 'sent' && entry.promptsSent !== null) {
        count = Math.max(count, entry.promptsSent);
      }
    }
    return count;
  }

  const store = createStore<GitHubStarPromptState>()((
    set,
    get,
  ): GitHubStarPromptState => {
    function acknowledge(
      stored: GitHubStarPromptRecord,
      status?: GitHubStarPromptStatus,
    ): void {
      const current = get().record;
      set({
        ...(status === undefined ? {} : { status }),
        record:
          current === null
            ? stored
            : mergeGitHubStarPromptRecords(current, stored),
      });
    }

    async function save(
      entry: PendingWrite,
      record: GitHubStarPromptRecord,
    ): Promise<boolean> {
      try {
        acknowledge(await persistence.save(record));
        return true;
      } catch (error) {
        pending.push(entry);
        report(error, entry.kind);
        return false;
      }
    }

    /** Write one pending action. Resolves whether it was acknowledged. */
    async function write(entry: PendingWrite): Promise<boolean> {
      const { status, record } = get();
      // An unreadable record takes no new counts, but a retirement or a count
      // already taken waits for the next successful read, so neither is lost.
      if (
        status === 'error' &&
        entry.kind === 'sent' &&
        entry.promptsSent === null
      )
        return false;
      if (status !== 'ready' || record === null) {
        pending.push(entry);
        return false;
      }
      if (entry.kind === 'sent') {
        if (entry.promptsSent !== null) {
          // A retry: drop it once another write already stored the count.
          if (record.promptsSent >= entry.promptsSent) return false;
          return save(entry, { ...record, promptsSent: entry.promptsSent });
        }
        const counted = Math.max(record.promptsSent, pendingCount());
        if (
          get().suppressed ||
          isGitHubStarPromptRecordRetired(record) ||
          counted >= GITHUB_STAR_PROMPT_THRESHOLD
        ) {
          return false;
        }
        return save(
          { kind: 'sent', promptsSent: counted + 1 },
          // Spread, so stored timestamps survive the write.
          { ...record, promptsSent: counted + 1 },
        );
      }
      const field = FIELD[entry.kind];
      if (entry.kind === 'shown' && record[field] !== undefined) return false;
      return save(entry, { ...record, [field]: entry.at });
    }

    async function flushPending(): Promise<void> {
      const retry = pending;
      pending = [];
      for (const entry of retry) await write(entry);
    }

    function run(entry: PendingWrite): Promise<boolean> {
      return enqueue(async () => {
        await flushPending();
        return write(entry);
      });
    }

    function retire(kind: 'dismissed' | 'starred'): Promise<boolean> {
      // Hide at once, so retirement holds even if the save rejects.
      set({ suppressed: true });
      return run({ kind, at: now().toISOString() });
    }

    return {
      status: 'loading',
      record: null,
      suppressed: false,
      hydrate: (): Promise<void> =>
        enqueue(async () => {
          let loaded: GitHubStarPromptLoadResult;
          try {
            loaded = await persistence.load();
          } catch (error) {
            // Never write defaults over a degraded read.
            set({ status: 'error' });
            report(error, 'hydrate');
            return;
          }
          acknowledge(loaded.record, 'ready');
          if (!loaded.persisted) {
            try {
              acknowledge(await persistence.save(loaded.record));
            } catch (error) {
              report(error, 'hydrate');
            }
          }
          await flushPending();
        }),
      noteTurnSent: (): Promise<boolean> =>
        run({ kind: 'sent', promptsSent: null }),
      markShown: (): Promise<boolean> => {
        if (get().record?.shownAt !== undefined) return Promise.resolve(false);
        return run({ kind: 'shown', at: now().toISOString() });
      },
      markDismissed: (): Promise<boolean> => retire('dismissed'),
      markStarred: (): Promise<boolean> => retire('starred'),
      reconcile: (incoming): void => {
        const current = get().record;
        set({
          record:
            current === null
              ? { ...incoming }
              : mergeGitHubStarPromptRecords(current, incoming),
        });
      },
    };
  });

  return store;
}
