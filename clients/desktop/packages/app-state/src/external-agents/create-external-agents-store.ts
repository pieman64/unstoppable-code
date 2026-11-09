import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type {
  ExternalAgentsClient,
  ExternalAgentsFailure,
  ExternalAgentsResult,
} from '@canopy/app-core';
import type {
  ExternalAgentAccess,
  ExternalAgentConnectionDetail,
  ExternalAgentConfirmationChange,
  ExternalAgentDesktop,
  ExternalAgentDesktopList,
  ExternalAgentExpiryChange,
  ExternalAgentsOverview,
} from '@canopy/protocol/external-agents';

export interface ExternalAgentsOverviewState {
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  readonly overview: ExternalAgentsOverview | null;
  readonly problem: ExternalAgentsFailure | null;
  readonly load: () => Promise<void>;
  readonly dispose: () => void;
}

export type ExternalAgentsOverviewStore = UseBoundStore<
  StoreApi<ExternalAgentsOverviewState>
>;

export function createExternalAgentsOverviewStore(
  client: ExternalAgentsClient,
): ExternalAgentsOverviewStore {
  let generation = 0;
  let disposed = false;

  return create<ExternalAgentsOverviewState>((set) => ({
    status: 'idle',
    overview: null,
    problem: null,
    load: async (): Promise<void> => {
      if (disposed) return;

      const currentGeneration = ++generation;
      set((state) => ({ status: 'loading', overview: state.overview }));

      let result: ExternalAgentsResult<ExternalAgentsOverview>;
      try {
        result = await client.getOverview();
      } catch {
        result = { ok: false, error: 'unavailable' };
      }

      if (disposed || currentGeneration !== generation) return;

      if (result.ok) {
        set({
          status: 'ready',
          overview: result.value,
          problem: null,
        });
        return;
      }

      set((state) => ({
        status: state.overview === null ? 'problem' : 'ready',
        problem: result.error,
      }));
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      generation += 1;
    },
  }));
}

export type ExternalAgentAction = 'save' | 'pause' | 'resume' | 'remove';

export type ExternalAgentOutcome =
  | { readonly kind: 'saved' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'resumed' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid_policy' }
  | { readonly kind: 'unavailable'; readonly action: ExternalAgentAction };

export interface ExternalAgentDesktopsState {
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  readonly list: readonly ExternalAgentDesktop[] | null;
  readonly problem: ExternalAgentsFailure | null;
}

export interface ExternalAgentState {
  readonly connectionId: string;
  readonly status:
    | 'idle'
    | 'loading'
    | 'ready'
    | 'not_found'
    | 'problem'
    | 'removed';
  readonly detail: ExternalAgentConnectionDetail | null;
  readonly problem: ExternalAgentsFailure | null;
  readonly pending: ExternalAgentAction | null;
  readonly outcome: ExternalAgentOutcome | null;
  readonly detailVersion: number;
  readonly desktops: ExternalAgentDesktopsState;
  readonly load: () => Promise<void>;
  readonly loadDesktops: () => Promise<void>;
  readonly save: (change: {
    readonly access: ExternalAgentAccess;
    readonly expiry: ExternalAgentExpiryChange;
    readonly confirmation?: ExternalAgentConfirmationChange;
    readonly textContentCompatibility?: boolean;
    /** Omitted keeps the label; null removes it. */
    readonly label?: string | null;
  }) => Promise<boolean>;
  readonly pause: () => Promise<boolean>;
  readonly resume: () => Promise<boolean>;
  readonly remove: () => Promise<boolean>;
  readonly clearOutcome: () => void;
  readonly dispose: () => void;
}

export type ExternalAgentStore = UseBoundStore<StoreApi<ExternalAgentState>>;

type ConnectionResult = ExternalAgentsResult<ExternalAgentConnectionDetail>;
type DesktopListResult = ExternalAgentsResult<ExternalAgentDesktopList>;
type ActionResult = ExternalAgentsResult<ExternalAgentConnectionDetail | null>;
type SuccessfulActionOutcome = Extract<
  ExternalAgentOutcome,
  { readonly kind: 'saved' | 'paused' | 'resumed' }
>;
type ReloadOutcome = Extract<
  ExternalAgentOutcome,
  { readonly kind: 'conflict' | 'expired' }
>;

export function createExternalAgentStore(
  client: ExternalAgentsClient,
  connectionId: string,
): ExternalAgentStore {
  let readGeneration = 0;
  let actionGeneration = 0;
  let desktopsGeneration = 0;
  let lifecycleGeneration = 0;
  let disposed = false;

  return create<ExternalAgentState>((set, get) => {
    const applyReadFailure = (
      error: ExternalAgentsFailure,
      generation: number,
      lifecycle: number,
    ): void => {
      if (
        disposed ||
        lifecycle !== lifecycleGeneration ||
        generation !== readGeneration
      ) {
        return;
      }

      if (error === 'not_found') {
        set({
          status: 'not_found',
          detail: null,
          problem: null,
        });
        return;
      }

      set((state) => ({
        status: state.detail === null ? 'problem' : 'ready',
        problem: error,
      }));
    };

    const applyReadSuccess = (
      result: ConnectionResult,
      generation: number,
      lifecycle: number,
    ): void => {
      if (
        disposed ||
        lifecycle !== lifecycleGeneration ||
        generation !== readGeneration
      ) {
        return;
      }

      if (!result.ok) {
        applyReadFailure(result.error, generation, lifecycle);
        return;
      }

      set((state) => ({
        status: 'ready',
        detail: result.value,
        problem: null,
        detailVersion: state.detailVersion + 1,
      }));
    };

    const load = async (): Promise<void> => {
      if (disposed) return;

      const generation = ++readGeneration;
      const lifecycle = lifecycleGeneration;
      set((state) => ({
        status: 'loading',
        detail: state.detail,
      }));

      let result: ConnectionResult;
      try {
        result = await client.getConnection(connectionId);
      } catch {
        result = { ok: false, error: 'unavailable' };
      }

      applyReadSuccess(result, generation, lifecycle);
    };

    const loadDesktops = async (): Promise<void> => {
      if (disposed) return;

      const generation = ++desktopsGeneration;
      set((state) => ({
        desktops: { ...state.desktops, status: 'loading' },
      }));

      let result: DesktopListResult;
      try {
        result = await client.listDesktops();
      } catch {
        result = { ok: false, error: 'unavailable' };
      }

      if (disposed || generation !== desktopsGeneration) return;

      if (result.ok) {
        set({
          desktops: {
            status: 'ready',
            list: result.value.desktops,
            problem: null,
          },
        });
        return;
      }

      set((state) => ({
        desktops: {
          status: state.desktops.list === null ? 'problem' : 'ready',
          list: state.desktops.list,
          problem: result.error,
        },
      }));
    };

    const reloadAfterDecision = async (
      actionId: number,
      lifecycle: number,
      outcome: ReloadOutcome,
    ): Promise<void> => {
      const generation = ++readGeneration;
      let result: ConnectionResult;
      try {
        result = await client.getConnection(connectionId);
      } catch {
        result = { ok: false, error: 'unavailable' };
      }

      if (
        disposed ||
        lifecycle !== lifecycleGeneration ||
        actionId !== actionGeneration
      ) {
        return;
      }

      if (generation !== readGeneration) {
        set({ pending: null, outcome });
        return;
      }

      if (result.ok) {
        set((state) => ({
          status: 'ready',
          detail: result.value,
          detailVersion: state.detailVersion + 1,
          problem: null,
          pending: null,
          outcome,
        }));
        return;
      }

      if (result.error === 'not_found') {
        set({
          status: 'not_found',
          detail: null,
          problem: null,
          pending: null,
          outcome,
        });
        return;
      }

      set((state) => ({
        status: state.detail === null ? 'problem' : 'ready',
        problem: result.error,
        pending: null,
        outcome,
      }));
    };

    const runAction = async (
      action: ExternalAgentAction,
      execute: (revision: number) => Promise<ActionResult>,
      successOutcome: SuccessfulActionOutcome | null,
    ): Promise<boolean> => {
      const current = get();
      if (
        disposed ||
        current.detail === null ||
        current.pending !== null ||
        current.detail.status === 'expired'
      ) {
        return false;
      }

      const revision = current.detail.revision;
      const actionId = ++actionGeneration;
      const lifecycle = lifecycleGeneration;
      readGeneration += 1;
      set({ pending: action, outcome: null });

      let result: ActionResult;
      try {
        result = await execute(revision);
      } catch {
        result = { ok: false, error: 'unavailable' };
      }

      if (
        disposed ||
        lifecycle !== lifecycleGeneration ||
        actionId !== actionGeneration
      ) {
        return false;
      }

      if (!result.ok) {
        if (result.error === 'not_found') {
          readGeneration += 1;
          set({
            status: 'not_found',
            detail: null,
            problem: null,
            pending: null,
            outcome: null,
          });
          return false;
        }

        if (result.error === 'conflict' || result.error === 'expired') {
          await reloadAfterDecision(actionId, lifecycle, {
            kind: result.error,
          });
          return false;
        }

        if (result.error === 'invalid_policy') {
          set({
            pending: null,
            outcome: { kind: 'invalid_policy' },
          });
          return false;
        }

        set({
          pending: null,
          outcome: { kind: 'unavailable', action },
        });
        return false;
      }

      readGeneration += 1;
      if (action === 'remove') {
        set({
          status: 'removed',
          detail: null,
          problem: null,
          pending: null,
          outcome: null,
        });
        return true;
      }

      if (result.value === null || successOutcome === null) {
        set({
          pending: null,
          outcome: { kind: 'unavailable', action },
        });
        return false;
      }

      set((state) => ({
        status: 'ready',
        detail: result.value,
        detailVersion: state.detailVersion + 1,
        problem: null,
        pending: null,
        outcome: successOutcome,
      }));
      return true;
    };

    return {
      connectionId,
      status: 'idle',
      detail: null,
      problem: null,
      pending: null,
      outcome: null,
      detailVersion: 0,
      desktops: { status: 'idle', list: null, problem: null },
      load,
      loadDesktops,
      save: (change) =>
        runAction(
          'save',
          (revision) =>
            client.updateAccess(connectionId, {
              revision,
              access: change.access,
              expiry: change.expiry,
              ...(change.confirmation !== undefined &&
              Object.keys(change.confirmation).length > 0
                ? { confirmation: change.confirmation }
                : {}),
              ...(change.textContentCompatibility === undefined
                ? {}
                : {
                    textContentCompatibility: change.textContentCompatibility,
                  }),
              ...(change.label === undefined ? {} : { label: change.label }),
            }),
          { kind: 'saved' },
        ),
      pause: () =>
        runAction('pause', (revision) => client.pause(connectionId, revision), {
          kind: 'paused',
        }),
      resume: () =>
        runAction(
          'resume',
          (revision) => client.resume(connectionId, revision),
          { kind: 'resumed' },
        ),
      remove: () =>
        runAction('remove', () => client.remove(connectionId), null),
      clearOutcome: () => set({ outcome: null }),
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        readGeneration += 1;
        actionGeneration += 1;
        desktopsGeneration += 1;
        lifecycleGeneration += 1;
      },
    };
  });
}
