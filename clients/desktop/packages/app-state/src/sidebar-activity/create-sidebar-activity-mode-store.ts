import { create } from 'zustand';
import { createClientStore } from '../create-client-store';
import {
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../client-store-lifecycle';
import {
  buildSidebarActivitySnapshot,
  SIDEBAR_ACTIVITY_UNREPLIED_PAGE_SIZE,
  type SidebarActivityBuildInput,
  type SidebarActivitySnapshot,
} from './sidebar-activity-mode-model';

/** Resolves only with a complete inventory; rejects on a partial one. */
export type SidebarActivityLoader = () => Promise<SidebarActivityBuildInput>;

export type SidebarActivityStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SidebarActivityModeState {
  readonly enabled: boolean;
  readonly status: SidebarActivityStatus;
  /** Frozen build; `null` until a load succeeds. */
  readonly snapshot: SidebarActivitySnapshot | null;
  /** Unreplied rows currently shown. */
  readonly unrepliedVisible: number;
  /** Host session the current cycle belongs to; `null` while disabled. */
  readonly sessionKey: string | null;
  /**
   * Enter Activity and load. Idempotent while loading or ready for the same
   * session; from an error it retries with this loader.
   */
  readonly enable: (load: SidebarActivityLoader, sessionKey: string) => void;
  /** Leave Activity, dropping the snapshot and any pending load. */
  readonly disable: () => void;
  /** Off when enabled (including while loading), otherwise {@link enable}. */
  readonly toggle: (load: SidebarActivityLoader, sessionKey: string) => void;
  /** Retry a failed load with the loader the cycle started with. */
  readonly retry: () => void;
  /** Reveal up to one more page of Unreplied rows. */
  readonly showMore: () => void;
}

const DISABLED = {
  enabled: false,
  status: 'idle',
  snapshot: null,
  unrepliedVisible: 0,
  sessionKey: null,
} as const;

/**
 * Activity state for one client lifecycle. Each load carries a generation:
 * disabling, a newer load, or disposal advances it, so a late success or
 * failure can never overwrite a newer cycle.
 */
export function createSidebarActivityModeStore(): ClientStore<SidebarActivityModeState> {
  let generation = 0;
  let loader: SidebarActivityLoader | null = null;

  const store: ClientStore<SidebarActivityModeState> =
    create<SidebarActivityModeState>()((set, get) => {
      const start = (load: SidebarActivityLoader, sessionKey: string): void => {
        generation += 1;
        const request = generation;
        loader = load;
        set({
          enabled: true,
          status: 'loading',
          snapshot: null,
          unrepliedVisible: 0,
          sessionKey,
        });
        let pending: Promise<SidebarActivityBuildInput>;
        try {
          pending = load();
        } catch (error) {
          pending = Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        pending.then(
          (input) => {
            if (request !== generation) return;
            let snapshot: SidebarActivitySnapshot;
            try {
              snapshot = buildSidebarActivitySnapshot(input);
            } catch {
              set({ status: 'error' });
              return;
            }
            set({
              status: 'ready',
              snapshot,
              unrepliedVisible: Math.min(
                SIDEBAR_ACTIVITY_UNREPLIED_PAGE_SIZE,
                snapshot.unreplied.length,
              ),
            });
          },
          () => {
            if (request !== generation) return;
            set({ status: 'error' });
          },
        );
      };

      const disable = (): void => {
        generation += 1;
        loader = null;
        if (get().enabled || get().status !== 'idle') set(DISABLED);
      };

      return {
        ...DISABLED,
        enable: (load, sessionKey): void => {
          const state = get();
          if (
            state.enabled &&
            state.sessionKey === sessionKey &&
            state.status !== 'error'
          )
            return;
          start(load, sessionKey);
        },
        disable,
        toggle: (load, sessionKey): void => {
          if (get().enabled) {
            disable();
            return;
          }
          start(load, sessionKey);
        },
        retry: (): void => {
          const state = get();
          if (!state.enabled || state.status !== 'error') return;
          if (loader === null || state.sessionKey === null) return;
          start(loader, state.sessionKey);
        },
        showMore: (): void => {
          const state = get();
          if (state.status !== 'ready' || state.snapshot === null) return;
          const total = state.snapshot.unreplied.length;
          const next = Math.min(
            total,
            state.unrepliedVisible + SIDEBAR_ACTIVITY_UNREPLIED_PAGE_SIZE,
          );
          if (next !== state.unrepliedVisible) set({ unrepliedVisible: next });
        },
      };
    });
  store[CLIENT_STORE_DISPOSE] = (): void => {
    store.getState().disable();
  };
  return store;
}

/** Activity state scoped to the provider's client. */
export const useSidebarActivityModeStore = createClientStore(() =>
  createSidebarActivityModeStore(),
);
