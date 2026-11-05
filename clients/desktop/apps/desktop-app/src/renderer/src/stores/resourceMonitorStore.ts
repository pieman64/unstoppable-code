import { create } from 'zustand';
import type { ResourceMonitorSnapshot } from '@canopy/desktop-shared/types';
import { extractIpcErrorMessage } from '@/lib/errors';

interface ResourceMonitorState {
  /** True after the first snapshot has been applied (success or error). */
  initialized: boolean;
  /** True until the first snapshot is applied. */
  loading: boolean;
  /** Most recent snapshot value, or null if none has ever been received. */
  snapshot: ResourceMonitorSnapshot | null;
  /** Most recent renderer-side error message, or null. */
  error: string | null;
  /**
   * Idempotently subscribes to live resource-monitor snapshots and pulls the
   * latest cached snapshot. Safe to call from multiple components — repeated
   * invocations return the in-flight initialization promise.
   */
  initialize: () => Promise<void>;
  /** Releases the live snapshot subscription and resets cached state. */
  dispose: () => void;
}

let initializePromise: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let lifecycleVersion = 0;

function disposeResourceMonitorSubscription(): void {
  lifecycleVersion += 1;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  initializePromise = null;
}

export const useResourceMonitorStore = create<ResourceMonitorState>(
  (set, get) => ({
    initialized: false,
    loading: true,
    snapshot: null,
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
        if (!unsubscribe) {
          unsubscribe = window.api.onResourceMonitorSnapshot(
            (snapshot: ResourceMonitorSnapshot): void => {
              if (version !== lifecycleVersion) {
                return;
              }
              set(() => ({
                initialized: true,
                loading: false,
                snapshot,
                error: snapshot.error ?? null,
              }));
            },
          );
        }

        try {
          const snapshot = await window.api.getResourceMonitorSnapshot();
          if (version !== lifecycleVersion) {
            return;
          }
          set(() => ({
            initialized: true,
            loading: false,
            snapshot,
            error: snapshot.error ?? null,
          }));
        } catch (error: unknown) {
          if (version !== lifecycleVersion) {
            return;
          }
          // Keep any previously delivered snapshot so the popover does not
          // blank on a transient one-shot fetch failure. Mark as initialized
          // so consumers can render either the live data or the error tone.
          set((prev) => ({
            initialized: true,
            loading: false,
            snapshot: prev.snapshot,
            error: extractIpcErrorMessage(error),
          }));
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
    dispose: (): void => {
      disposeResourceMonitorSubscription();
      set(() => ({
        initialized: false,
        loading: true,
        snapshot: null,
        error: null,
      }));
    },
  }),
);
