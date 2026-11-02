import {
  mergePlanModeHintRecords,
  type PlanModeHintRecord,
} from '@canopy/protocol/onboarding';
import { createStore, type StoreApi } from 'zustand';

/**
 * Shared client state for the composer's plan-mode lesson (CAN-4008). One
 * store per persistence scope: desktop preferences, or one web account in
 * one browser. Hosts supply the scope's storage; the store owns ordering.
 */

export interface PlanModeHintLoadResult {
  record: PlanModeHintRecord;
  /**
   * False when the record was derived (defaulted or migrated from legacy
   * checklist progress) and is not yet stored. Hydration saves it before
   * treating migration as durable.
   */
  persisted: boolean;
}

export interface PlanModeHintPersistence {
  /** Reject on a degraded or corrupt read: the hint then stays hidden. */
  load(): Promise<PlanModeHintLoadResult>;
  /**
   * Write through the scope's authoritative writer, merging with the stored
   * record, and resolve with the stored result.
   */
  save(record: PlanModeHintRecord): Promise<PlanModeHintRecord>;
  /** Existing diagnostics. Never blocks sending or reverts plan mode. */
  onError?: (error: unknown, operation: PlanModeHintOperation) => void;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export type PlanModeHintOperation =
  | 'hydrate'
  | 'shown'
  | 'dismissed'
  | 'tried'
  | 'reset';

export type PlanModeHintStatus = 'loading' | 'ready' | 'error';

type Timestamped = 'shown' | 'dismissed' | 'tried';

interface PendingWrite {
  kind: Timestamped;
  at: string;
  /** The acknowledged generation of the first attempt, once it has run. */
  generation: number | null;
}

export interface PlanModeHintState {
  status: PlanModeHintStatus;
  /** The last acknowledged (stored) record. Null until hydrated. */
  record: PlanModeHintRecord | null;
  /**
   * Retired locally (dismissed or accepted) before or without a successful
   * save. Keeps the hint hidden in this runtime while persistence retries.
   */
  suppressed: boolean;
  hydrate: () => Promise<void>;
  markShown: () => Promise<boolean>;
  markDismissed: () => Promise<boolean>;
  markTried: () => Promise<boolean>;
  /** Restart checklist: clear retirement for a new generation. */
  reset: () => Promise<boolean>;
  /** Apply a record written elsewhere (another tab or window). */
  reconcile: (record: PlanModeHintRecord) => void;
}

export type PlanModeHintStore = StoreApi<PlanModeHintState>;

/** Whether the lesson is retired: dismissed or plan mode tried. */
export function isPlanModeHintRetired(state: PlanModeHintState): boolean {
  return (
    state.suppressed ||
    state.record?.dismissedAt !== undefined ||
    state.record?.triedAt !== undefined
  );
}

/** Whether the hint may show: trustworthy hydration and not retired. */
export function isPlanModeHintAvailable(state: PlanModeHintState): boolean {
  return state.status === 'ready' && !isPlanModeHintRetired(state);
}

const FIELD: Record<Timestamped, 'shownAt' | 'dismissedAt' | 'triedAt'> = {
  shown: 'shownAt',
  dismissed: 'dismissedAt',
  tried: 'triedAt',
};

export function createPlanModeHintStore(
  persistence: PlanModeHintPersistence,
): PlanModeHintStore {
  const now = persistence.now ?? ((): Date => new Date());
  let queue: Promise<unknown> = Promise.resolve();
  let pending: PendingWrite[] = [];

  /** Serialize every read/write against the latest state. */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  function report(error: unknown, operation: PlanModeHintOperation): void {
    persistence.onError?.(error, operation);
  }

  const store = createStore<PlanModeHintState>()((
    set,
    get,
  ): PlanModeHintState => {
    function acknowledge(
      stored: PlanModeHintRecord,
      status?: PlanModeHintStatus,
    ): void {
      const current = get().record;
      set({
        ...(status === undefined ? {} : { status }),
        record:
          current === null ? stored : mergePlanModeHintRecords(current, stored),
        // A reply or re-read may reveal a reset before its broadcast arrives.
        // Runtime suppression from the acknowledged older epoch must clear too.
        ...(current !== null && stored.generation > current.generation
          ? { suppressed: false }
          : {}),
      });
    }

    /** Write one pending action. Resolves whether it was acknowledged. */
    async function write(entry: PendingWrite): Promise<boolean> {
      const record = get().record;
      if (get().status !== 'ready' || record === null) {
        pending.push(entry);
        return false;
      }
      // Retry with the original generation: a reset since then wins.
      const generation = entry.generation ?? record.generation;
      if (generation < record.generation) return false;
      try {
        const stored = await persistence.save({
          version: 1,
          generation,
          [FIELD[entry.kind]]: entry.at,
        });
        acknowledge(stored);
        return stored.generation === generation;
      } catch (error) {
        pending.push({ ...entry, generation });
        report(error, entry.kind);
        return false;
      }
    }

    async function flushPending(): Promise<void> {
      const retry = pending;
      pending = [];
      for (const entry of retry) await write(entry);
    }

    function action(kind: Timestamped): Promise<boolean> {
      const at = now().toISOString();
      if (kind !== 'shown') set({ suppressed: true });
      // Bind to the acknowledged generation when the action occurs. An
      // external reset before the queue runs must not adopt this old action.
      const entry: PendingWrite = {
        kind,
        at,
        generation: get().record?.generation ?? null,
      };
      return enqueue(async () => {
        await flushPending();
        return write(entry);
      });
    }

    return {
      status: 'loading',
      record: null,
      suppressed: false,
      hydrate: (): Promise<void> =>
        enqueue(async () => {
          let loaded: PlanModeHintLoadResult;
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
      markShown: (): Promise<boolean> => action('shown'),
      markDismissed: (): Promise<boolean> => action('dismissed'),
      markTried: (): Promise<boolean> => action('tried'),
      reset: (): Promise<boolean> =>
        enqueue(async () => {
          const record = get().record;
          if (get().status !== 'ready' || record === null) return false;
          try {
            const stored = await persistence.save({
              version: 1,
              generation: record.generation + 1,
            });
            // Older-generation writes can no longer apply.
            pending = [];
            const current = get().record;
            set({
              record:
                current === null
                  ? stored
                  : mergePlanModeHintRecords(current, stored),
              suppressed: false,
            });
            return true;
          } catch (error) {
            report(error, 'reset');
            return false;
          }
        }),
      reconcile: (incoming): void => {
        const current = get().record;
        if (current === null) {
          set({ record: { ...incoming } });
          return;
        }
        if (incoming.generation > current.generation) {
          // Reset elsewhere: local retirement belongs to the old generation.
          pending = [];
          set({ record: { ...incoming }, suppressed: false });
          return;
        }
        set({ record: mergePlanModeHintRecords(current, incoming) });
      },
    };
  });

  return store;
}
