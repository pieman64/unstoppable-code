import { create } from 'zustand';
import type { CanopyPortalState } from '@canopy/desktop-shared/types';

/**
 * Renderer-side cache of the latest `CanopyPortalState` snapshot delivered
 * by the main-process portal worker.
 *
 * The main process is the source of truth for portal state; the renderer
 * receives copies via `window.api.canopyPortal.getState()` (initial fetch)
 * and `window.api.canopyPortal.onStateChanged()` (push updates).
 *
 * The renderer MUST NOT:
 * - persist the pairing code in any cache, store, or analytics surface;
 * - copy the pairing code to the clipboard automatically;
 * - log or trace the pairing code.
 *
 * The store keeps the state in zustand only so the modal can re-render. The
 * pairing code is treated like any other transient render-only field; it is
 * not written through to local storage, IndexedDB, or any other durable
 * surface.
 */
function defaultState(): CanopyPortalState {
  return {
    status: 'disabled',
    connectionStatus: 'inactive',
    sessionId: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    machineName: null,
    activatedAt: null,
    lastSeenAt: null,
    lastErrorAt: null,
    error: null,
  };
}

interface CanopyPortalStoreState {
  /** True once the renderer has done its initial fetch from the main process. */
  hydrated: boolean;
  /** Latest snapshot delivered by the main process. */
  state: CanopyPortalState;
  /**
   * Fetches the current state from the main process. Idempotent; safe to call
   * multiple times (e.g. on every modal open) without losing pushed updates.
   */
  hydrate: () => Promise<void>;
  /** Replaces the in-store state with a freshly broadcast snapshot. */
  setState: (next: CanopyPortalState) => void;
}

export const useCanopyPortalStore = create<CanopyPortalStoreState>((set) => ({
  hydrated: false,
  state: defaultState(),
  hydrate: async (): Promise<void> => {
    try {
      const snapshot = await window.api.canopyPortal.getState();
      set({ hydrated: true, state: snapshot });
    } catch {
      // Initial fetch failures are non-fatal: the hook keeps the listener
      // attached and the next pushed update will populate the store.
      set({ hydrated: true });
    }
  },
  setState: (next): void => {
    set({ hydrated: true, state: next });
  },
}));
