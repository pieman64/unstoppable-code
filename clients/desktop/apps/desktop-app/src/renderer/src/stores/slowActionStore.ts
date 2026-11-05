import { create } from 'zustand';
import type {
  SlowActionEvent,
  SlowActionRecord,
} from '@canopy/desktop-shared/types';
import { extractIpcErrorMessage } from '@/lib/errors';

interface SlowActionState {
  initialized: boolean;
  loading: boolean;
  records: SlowActionRecord[];
  error: string | null;
  initialize: () => Promise<void>;
  clear: () => Promise<void>;
  dispose: () => void;
}

let initializePromise: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let lifecycleVersion = 0;

function sortRecords(records: SlowActionRecord[]): SlowActionRecord[] {
  return [...records].sort(
    (left, right) => right.startedAtMs - left.startedAtMs,
  );
}

function applySlowActionEvent(
  records: SlowActionRecord[],
  event: SlowActionEvent,
): SlowActionRecord[] {
  switch (event.type) {
    case 'added':
      return sortRecords([
        event.record,
        ...records.filter((record) => record.id !== event.record.id),
      ]);
    case 'resolved':
    case 'evicted':
      return records.filter((record) => record.id !== event.id);
    case 'cleared':
      return [];
  }
}

function disposeSlowActionSubscription(): void {
  lifecycleVersion += 1;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  initializePromise = null;
}

export const useSlowActionStore = create<SlowActionState>((set, get) => ({
  initialized: false,
  loading: true,
  records: [],
  error: null,
  initialize: async (): Promise<void> => {
    if (get().initialized) {
      return;
    }
    if (initializePromise) {
      return initializePromise;
    }

    const version = lifecycleVersion;
    const currentPromise = (async (): Promise<void> => {
      const bufferedEvents: SlowActionEvent[] = [];
      let snapshotLoaded = false;
      if (!unsubscribe) {
        unsubscribe = window.api.slowActions.onEvent(
          (event: SlowActionEvent): void => {
            if (version !== lifecycleVersion) {
              return;
            }
            if (!snapshotLoaded) {
              bufferedEvents.push(event);
              return;
            }
            set((state) => ({
              initialized: true,
              loading: false,
              error: null,
              records: applySlowActionEvent(state.records, event),
            }));
          },
        );
      }

      try {
        const snapshot = await window.api.slowActions.loadSnapshot();
        if (version !== lifecycleVersion) {
          return;
        }
        let records = sortRecords(snapshot.records);
        for (const event of bufferedEvents) {
          records = applySlowActionEvent(records, event);
        }
        snapshotLoaded = true;
        set(() => ({
          initialized: true,
          loading: false,
          error: null,
          records,
        }));
      } catch (error: unknown) {
        if (version !== lifecycleVersion) {
          return;
        }
        set((state) => {
          let records = state.records;
          for (const event of bufferedEvents) {
            records = applySlowActionEvent(records, event);
          }
          return {
            initialized: false,
            loading: false,
            error: extractIpcErrorMessage(error),
            records,
          };
        });
      } finally {
        snapshotLoaded = true;
      }
    })();
    initializePromise = currentPromise;

    try {
      await currentPromise;
    } finally {
      if (initializePromise === currentPromise) {
        initializePromise = null;
      }
    }
  },
  clear: async (): Promise<void> => {
    const previousRecords = get().records;
    set(() => ({ error: null, records: [] }));
    try {
      await window.api.slowActions.clear();
    } catch (error: unknown) {
      set(() => ({
        error: extractIpcErrorMessage(error),
        records: previousRecords,
      }));
      throw error;
    }
  },
  dispose: (): void => {
    disposeSlowActionSubscription();
    set(() => ({
      initialized: false,
      loading: true,
      records: [],
      error: null,
    }));
  },
}));
