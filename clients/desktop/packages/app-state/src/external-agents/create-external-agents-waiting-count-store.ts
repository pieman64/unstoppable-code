import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type {
  ExternalAgentsClient,
  ExternalAgentsResult,
} from '@canopy/app-core';

export interface ExternalAgentsWaitingCountState {
  /** Requests waiting across the person's connections; null until loaded or after a failure. */
  readonly count: number | null;
  readonly load: () => Promise<void>;
  readonly dispose: () => void;
}

export type ExternalAgentsWaitingCountStore = UseBoundStore<
  StoreApi<ExternalAgentsWaitingCountState>
>;

export function createExternalAgentsWaitingCountStore(
  client: ExternalAgentsClient,
): ExternalAgentsWaitingCountStore {
  let generation = 0;
  let disposed = false;

  return create<ExternalAgentsWaitingCountState>((set) => ({
    count: null,
    load: async (): Promise<void> => {
      if (disposed) return;

      const currentGeneration = ++generation;
      let result: ExternalAgentsResult<number>;
      try {
        result = await client.getWaitingCount();
      } catch {
        result = { ok: false, error: 'unavailable' };
      }

      if (disposed || currentGeneration !== generation) return;
      set({ count: result.ok ? result.value : null });
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      generation += 1;
    },
  }));
}
