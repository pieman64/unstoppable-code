import { create } from 'zustand';
import type {
  WorkerCardData,
  WorkerExitedEvent,
  WorkerStartedEvent,
  WorkerStatus,
  WorkerUpdatedEvent,
} from '@canopy/desktop-shared/types';

/**
 * Renderer store for the Claude Workers page. It is a pure projection of the
 * transport contract: hydrate once via `window.api.workers.list()`, then track
 * the live set of worker cards by subscribing to the three lifecycle events
 * (`workerStarted` → insert, `workerUpdated` → merge patch, `workerExited` →
 * remove). Per-card actions (`cancel`/`retry`) forward to the matching IPC
 * request channels. Modeled on `observabilityStore`'s singleton-`initialize`
 * pattern so the subscriptions are wired exactly once for the app lifetime.
 */

let initializePromise: Promise<void> | null = null;
let unsubscribeStarted: (() => void) | null = null;
let unsubscribeUpdated: (() => void) | null = null;
let unsubscribeExited: (() => void) | null = null;

/**
 * Worker statuses that are still "unsettled" — the only states in which the
 * Cancel/Retry actions are offered. Settled workers (`success`/`failure`/
 * `cancelled`/`interrupted`) have their cards removed on `workerExited`, so
 * these never need a visible action. Exported so the grid card can drive action
 * visibility off the same source of truth as the store.
 */
const UNSETTLED_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  'queued',
  'starting',
  'running',
]);

export function isWorkerUnsettled(status: WorkerStatus): boolean {
  return UNSETTLED_STATUSES.has(status);
}

interface WorkersState {
  initialized: boolean;
  /** Active worker cards keyed by `workerId`, insertion-ordered. */
  workers: Map<string, WorkerCardData>;
  initialize: () => Promise<void>;
  cancel: (workerId: string) => Promise<void>;
  retry: (workerId: string) => Promise<void>;
}

export interface WorkersStoreE2eControls {
  setWorkers: (workers: WorkerCardData[]) => void;
  patchWorker: (workerId: string, patch: Partial<WorkerCardData>) => void;
  removeWorker: (workerId: string) => void;
}

declare global {
  interface Window {
    __CANOPY_E2E_WORKER_ACTIONS__?: {
      cancel: string[];
      retry: string[];
    };
  }
}

function insertWorker(
  workers: Map<string, WorkerCardData>,
  worker: WorkerCardData,
): Map<string, WorkerCardData> {
  const next = new Map(workers);
  next.set(worker.workerId, worker);
  return next;
}

function patchWorker(
  workers: Map<string, WorkerCardData>,
  workerId: string,
  patch: Partial<WorkerCardData>,
): Map<string, WorkerCardData> {
  const existing = workers.get(workerId);
  if (!existing) {
    // A patch can arrive before/without a `started` event only if the contract
    // is violated; ignore rather than synthesize a half-populated card.
    return workers;
  }
  const next = new Map(workers);
  next.set(workerId, { ...existing, ...patch, workerId });
  return next;
}

function removeWorker(
  workers: Map<string, WorkerCardData>,
  workerId: string,
): Map<string, WorkerCardData> {
  if (!workers.has(workerId)) {
    return workers;
  }
  const next = new Map(workers);
  next.delete(workerId);
  return next;
}

export const useWorkersStore = create<WorkersState>((set, get) => ({
  initialized: false,
  workers: new Map<string, WorkerCardData>(),

  initialize: async (): Promise<void> => {
    if (get().initialized) {
      return;
    }
    if (initializePromise) {
      return initializePromise;
    }

    set({ initialized: true });
    initializePromise = (async (): Promise<void> => {
      try {
        const cards = await window.api.workers.list();
        const hydrated = new Map<string, WorkerCardData>();
        for (const card of cards) {
          hydrated.set(card.workerId, card);
        }
        set({ workers: hydrated });

        if (!unsubscribeStarted) {
          unsubscribeStarted = window.api.workers.onStarted(
            (event: WorkerStartedEvent) => {
              set((state) => ({
                workers: insertWorker(state.workers, event.worker),
              }));
            },
          );
        }
        if (!unsubscribeUpdated) {
          unsubscribeUpdated = window.api.workers.onUpdated(
            (event: WorkerUpdatedEvent) => {
              set((state) => ({
                workers: patchWorker(
                  state.workers,
                  event.workerId,
                  event.patch,
                ),
              }));
            },
          );
        }
        if (!unsubscribeExited) {
          unsubscribeExited = window.api.workers.onExited(
            (event: WorkerExitedEvent) => {
              set((state) => ({
                workers: removeWorker(state.workers, event.workerId),
              }));
            },
          );
        }
      } catch (error) {
        set({ initialized: false });
        throw error;
      } finally {
        initializePromise = null;
      }
    })();

    return initializePromise;
  },

  cancel: async (workerId: string): Promise<void> => {
    if (__CANOPY_E2E__) {
      window.__CANOPY_E2E_WORKER_ACTIONS__?.cancel.push(workerId);
    }
    await window.api.workers.cancel(workerId);
  },

  retry: async (workerId: string): Promise<void> => {
    if (__CANOPY_E2E__) {
      window.__CANOPY_E2E_WORKER_ACTIONS__?.retry.push(workerId);
    }
    await window.api.workers.retry(workerId);
  },
}));

export function createWorkersStoreE2eControls(): WorkersStoreE2eControls {
  return {
    setWorkers: (workers: WorkerCardData[]): void => {
      useWorkersStore.setState({
        workers: new Map(workers.map((worker) => [worker.workerId, worker])),
      });
    },
    patchWorker: (workerId: string, patch: Partial<WorkerCardData>): void => {
      useWorkersStore.setState((state) => ({
        workers: patchWorker(state.workers, workerId, patch),
      }));
    },
    removeWorker: (workerId: string): void => {
      useWorkersStore.setState((state) => ({
        workers: removeWorker(state.workers, workerId),
      }));
    },
  };
}
