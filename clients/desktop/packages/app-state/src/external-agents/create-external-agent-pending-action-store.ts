import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type {
  ExternalAgentsClient,
  ExternalAgentsFailure,
  ExternalAgentsResult,
} from '@canopy/app-core';
import type {
  ExternalAgentConnectionDetail,
  ExternalAgentPendingAction,
} from '@canopy/protocol/external-agents';

export type ExternalAgentDecision = 'confirm' | 'decline';

/** Why the last decision did not apply as asked. */
export type ExternalAgentDecisionOutcome =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unavailable'; readonly decision: ExternalAgentDecision };

export interface ExternalAgentPendingActionState {
  readonly pendingActionId: string;
  readonly status: 'idle' | 'loading' | 'ready' | 'not_found' | 'problem';
  readonly action: ExternalAgentPendingAction | null;
  /** Load failure other than not_found. */
  readonly problem: ExternalAgentsFailure | null;
  /** The decision request in flight. */
  readonly deciding: ExternalAgentDecision | null;
  /** The decision this page made successfully (drives the pause offer after decline). */
  readonly decided: ExternalAgentDecision | null;
  readonly decisionOutcome: ExternalAgentDecisionOutcome | null;
  /** 'polling' while a confirmed action's result is awaited (getPendingAction every 2 s); 'timed_out' after 60 s without a terminal state; 'idle' otherwise. */
  readonly resultPoll: 'idle' | 'polling' | 'timed_out';
  /** The offer to pause the connection after Decline. */
  readonly pauseOffer: 'idle' | 'pausing' | 'paused' | 'failed';
  readonly load: () => Promise<void>;
  readonly decide: (decision: ExternalAgentDecision) => Promise<boolean>;
  readonly pauseConnection: () => Promise<boolean>;
  readonly dispose: () => void;
}

export type ExternalAgentPendingActionStore = UseBoundStore<
  StoreApi<ExternalAgentPendingActionState>
>;

type PendingActionResult = ExternalAgentsResult<ExternalAgentPendingAction>;

export function createExternalAgentPendingActionStore(
  client: ExternalAgentsClient,
  pendingActionId: string,
): ExternalAgentPendingActionStore {
  let readGeneration = 0;
  let decisionGeneration = 0;
  let pollGeneration = 0;
  let pauseGeneration = 0;
  let lifecycleGeneration = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  return create<ExternalAgentPendingActionState>((set, get) => {
    const stopPolling = (setIdle: boolean): void => {
      pollGeneration += 1;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (setIdle && !disposed) set({ resultPoll: 'idle' });
    };

    const startPolling = (): void => {
      stopPolling(false);
      const generation = pollGeneration;
      let attempts = 0;

      const scheduleNext = (): void => {
        pollTimer = setTimeout(() => {
          pollTimer = null;
          void poll();
        }, 2_000);
      };

      const poll = async (): Promise<void> => {
        if (disposed || generation !== pollGeneration) return;
        attempts += 1;

        let result: PendingActionResult;
        try {
          result = await client.getPendingAction(pendingActionId);
        } catch {
          result = { ok: false, error: 'unavailable' };
        }

        if (disposed || generation !== pollGeneration) return;

        if (!result.ok) {
          if (result.error === 'not_found') {
            readGeneration += 1;
            set({
              status: 'not_found',
              action: null,
              problem: null,
              resultPoll: 'idle',
            });
            stopPolling(false);
            return;
          }

          if (attempts >= 30) {
            set({ resultPoll: 'timed_out' });
            return;
          }
          scheduleNext();
          return;
        }

        set({
          status: 'ready',
          action: result.value,
          problem: null,
        });
        if (result.value.status !== 'confirmed') {
          stopPolling(false);
          set({ resultPoll: 'idle' });
          return;
        }

        if (attempts >= 30) {
          set({ resultPoll: 'timed_out' });
          return;
        }
        scheduleNext();
      };

      set({ resultPoll: 'polling' });
      scheduleNext();
    };

    const applyReadResult = (
      result: PendingActionResult,
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

      if (result.ok) {
        set({
          status: 'ready',
          action: result.value,
          problem: null,
        });
        if (result.value.status === 'confirmed') {
          startPolling();
        } else {
          stopPolling(true);
        }
        return;
      }

      if (result.error === 'not_found') {
        stopPolling(false);
        set({
          status: 'not_found',
          action: null,
          problem: null,
          resultPoll: 'idle',
        });
        return;
      }

      const currentAction = get().action;
      set({
        status: currentAction === null ? 'problem' : 'ready',
        problem: result.error,
      });
      if (currentAction?.status === 'confirmed') {
        startPolling();
      } else {
        stopPolling(true);
      }
    };

    const load = async (): Promise<void> => {
      if (disposed) return;

      const generation = ++readGeneration;
      const lifecycle = lifecycleGeneration;
      stopPolling(true);
      set((state) => ({ status: 'loading', action: state.action }));

      let result: PendingActionResult;
      try {
        result = await client.getPendingAction(pendingActionId);
      } catch {
        result = { ok: false, error: 'unavailable' };
      }

      applyReadResult(result, generation, lifecycle);
    };

    const reloadAfterDecision = async (
      error: 'conflict' | 'expired',
      actionGeneration: number,
      lifecycle: number,
    ): Promise<void> => {
      const generation = ++readGeneration;
      set((state) => ({ status: 'loading', action: state.action }));

      let result: PendingActionResult;
      try {
        result = await client.getPendingAction(pendingActionId);
      } catch {
        result = { ok: false, error: 'unavailable' };
      }

      if (
        disposed ||
        lifecycle !== lifecycleGeneration ||
        actionGeneration !== decisionGeneration
      ) {
        return;
      }

      applyReadResult(result, generation, lifecycle);
      set({
        deciding: null,
        decisionOutcome: { kind: error },
      });
    };

    const decide = async (
      decision: ExternalAgentDecision,
    ): Promise<boolean> => {
      const current = get();
      if (
        disposed ||
        current.action?.status !== 'pending' ||
        current.deciding !== null
      ) {
        return false;
      }

      const generation = ++decisionGeneration;
      const lifecycle = lifecycleGeneration;
      readGeneration += 1;
      stopPolling(true);
      set({ deciding: decision, decisionOutcome: null });

      let result: PendingActionResult;
      try {
        result = await client.decidePendingAction(pendingActionId, decision);
      } catch {
        result = { ok: false, error: 'unavailable' };
      }

      if (
        disposed ||
        lifecycle !== lifecycleGeneration ||
        generation !== decisionGeneration
      ) {
        return false;
      }

      if (result.ok) {
        set({
          status: 'ready',
          action: result.value,
          problem: null,
          deciding: null,
          decided: decision,
          decisionOutcome: null,
        });
        if (result.value.status === 'confirmed') {
          startPolling();
        } else {
          stopPolling(true);
        }
        return true;
      }

      if (result.error === 'not_found') {
        readGeneration += 1;
        stopPolling(false);
        set({
          status: 'not_found',
          action: null,
          problem: null,
          deciding: null,
          decisionOutcome: null,
          resultPoll: 'idle',
        });
        return false;
      }

      if (result.error === 'conflict' || result.error === 'expired') {
        await reloadAfterDecision(result.error, generation, lifecycle);
        return false;
      }

      set({
        deciding: null,
        decisionOutcome: { kind: 'unavailable', decision },
      });
      return false;
    };

    const pauseConnection = async (): Promise<boolean> => {
      const current = get();
      if (
        disposed ||
        current.action === null ||
        (current.pauseOffer !== 'idle' && current.pauseOffer !== 'failed')
      ) {
        return false;
      }

      const generation = ++pauseGeneration;
      const lifecycle = lifecycleGeneration;
      const actionConnectionId = current.action.connectionId;
      set({ pauseOffer: 'pausing' });

      let detailResult: ExternalAgentsResult<ExternalAgentConnectionDetail>;
      try {
        detailResult = await client.getConnection(actionConnectionId);
      } catch {
        detailResult = { ok: false, error: 'unavailable' };
      }

      if (
        disposed ||
        lifecycle !== lifecycleGeneration ||
        generation !== pauseGeneration
      ) {
        return false;
      }

      if (!detailResult.ok || detailResult.value.status === 'expired') {
        set({ pauseOffer: 'failed' });
        return false;
      }

      if (detailResult.value.status === 'paused') {
        set({ pauseOffer: 'paused' });
        return true;
      }

      let pauseResult: ExternalAgentsResult<ExternalAgentConnectionDetail>;
      try {
        pauseResult = await client.pause(
          actionConnectionId,
          detailResult.value.revision,
        );
      } catch {
        pauseResult = { ok: false, error: 'unavailable' };
      }

      if (
        disposed ||
        lifecycle !== lifecycleGeneration ||
        generation !== pauseGeneration
      ) {
        return false;
      }

      if (!pauseResult.ok) {
        set({ pauseOffer: 'failed' });
        return false;
      }

      set({ pauseOffer: 'paused' });
      return true;
    };

    return {
      pendingActionId,
      status: 'idle',
      action: null,
      problem: null,
      deciding: null,
      decided: null,
      decisionOutcome: null,
      resultPoll: 'idle',
      pauseOffer: 'idle',
      load,
      decide,
      pauseConnection,
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        readGeneration += 1;
        decisionGeneration += 1;
        pauseGeneration += 1;
        lifecycleGeneration += 1;
        stopPolling(false);
      },
    };
  });
}
