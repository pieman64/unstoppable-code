import { create } from 'zustand';
import type {
  CanopyClient,
  DomainEventMap,
  Unsubscribe,
} from '@canopy/app-core';
import type {
  WorkspaceContext,
  WorkspaceContextOrganization,
  WorkspaceContextState,
} from '@canopy/protocol/workspace-context';
import {
  PERSONAL_WORKSPACE_CONTEXT,
  isSameWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  createClientStore,
  type ClientStore,
} from '../create-client-store';

export type WorkspaceContextStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The shared workspace-context store (CAN-2944). The host owns the context
 * (desktop main, or the web tab); this store mirrors it, forwards switches,
 * and folds in `workspace-context.changed` so every window converges on the
 * host's revision. Selecting a context is a navigation fact only: it grants
 * nothing, and the catalog store re-queries per context.
 */
export interface WorkspaceContextStoreState {
  readonly status: WorkspaceContextStatus;
  /** Bumped on account changes; replies from earlier accounts are discarded. */
  readonly accountEpoch: number;
  /** Bumped on applied events, including membership-only updates. */
  readonly appliedGeneration: number;
  /** The host's last-known state, or `null` before the first load. */
  readonly state: WorkspaceContextState | null;
  readonly error: string | null;
  /** Query the host and replace the mirrored state. */
  readonly load: () => Promise<void>;
  /**
   * Ask the host to switch. Resolves once the host confirmed; rejects (and
   * leaves the mirror untouched) when the host refused, e.g. a stale revision
   * from another window, in which case callers reload.
   */
  readonly setContext: (context: WorkspaceContext) => Promise<void>;
  /** Fold in host state; account changes may reset the revision to zero. */
  readonly applyState: (
    state: WorkspaceContextState,
    reason?: DomainEventMap['workspace-context.changed']['reason'],
  ) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkspaceContextStore(
  client: CanopyClient,
): ClientStore<WorkspaceContextStoreState> {
  let requestGeneration = 0;
  const store: ClientStore<WorkspaceContextStoreState> =
    create<WorkspaceContextStoreState>((set, get) => ({
      status: 'idle',
      accountEpoch: 0,
      appliedGeneration: 0,
      state: null,
      error: null,
      applyState: (state, reason): void => {
        const current = get().state;
        if (
          reason !== 'account-change' &&
          current !== null &&
          state.revision < current.revision
        ) {
          return;
        }
        set((current) => ({
          state,
          status: 'ready',
          error: null,
          accountEpoch:
            current.accountEpoch + (reason === 'account-change' ? 1 : 0),
          appliedGeneration:
            current.appliedGeneration + (reason === undefined ? 0 : 1),
        }));
      },
      load: async (): Promise<void> => {
        const request = ++requestGeneration;
        const epoch = get().accountEpoch;
        const generation = get().appliedGeneration;
        set({ status: 'loading' });
        try {
          const state = await client.query('workspaceContext.get', {});
          if (
            requestGeneration === request &&
            get().accountEpoch === epoch &&
            get().appliedGeneration === generation
          ) {
            get().applyState(state);
          }
        } catch (error) {
          if (
            requestGeneration === request &&
            get().accountEpoch === epoch &&
            get().appliedGeneration === generation
          ) {
            set({ status: 'error', error: errorMessage(error) });
          }
        }
      },
      setContext: async (context): Promise<void> => {
        const current = get().state;
        if (
          current !== null &&
          isSameWorkspaceContext(current.context, context)
        ) {
          return;
        }
        const epoch = get().accountEpoch;
        const generation = get().appliedGeneration;
        const next = await client.command('workspaceContext.set', {
          context,
          expectedRevision: current?.revision ?? 0,
        });
        if (get().accountEpoch !== epoch) {
          throw new Error(
            'The account changed while switching the workspace context.',
          );
        }
        if (
          get().appliedGeneration !== generation ||
          next.revision < (get().state?.revision ?? 0)
        ) {
          const latest = get().state;
          if (
            latest !== null &&
            isSameWorkspaceContext(latest.context, context)
          ) {
            return;
          }
          throw new Error(
            'The workspace context changed while the switch was in flight.',
          );
        }
        get().applyState(next);
      },
    }));

  let unsubscribe: Unsubscribe | null = null;
  store[CLIENT_STORE_ACTIVATE] = (): void => {
    unsubscribe?.();
    unsubscribe = client.subscribe('workspace-context.changed', (event) => {
      store.getState().applyState(event.state, event.reason);
    });
  };
  store[CLIENT_STORE_DISPOSE] = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };
  return store;
}

export const useWorkspaceContextStore = createClientStore(
  createWorkspaceContextStore,
);

/** The active context; Personal until the host has answered. */
export function selectCurrentWorkspaceContext(
  state: WorkspaceContextStoreState,
): WorkspaceContext {
  return state.state?.context ?? PERSONAL_WORKSPACE_CONTEXT;
}

/** Organizations the user may switch into (empty until loaded). */
export function selectSwitchableOrganizations(
  state: WorkspaceContextStoreState,
): readonly WorkspaceContextOrganization[] {
  return state.state?.organizations ?? [];
}
