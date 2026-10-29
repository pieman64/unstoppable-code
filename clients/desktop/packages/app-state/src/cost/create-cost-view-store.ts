import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { CostClient } from '@canopy/app-core';
import { costScopeKey } from '@canopy/protocol/cost-view';
import type {
  CostAttributedItem,
  CostChatRow,
  CostErrorReason,
  CostRefreshReceipt,
  CostRefreshTrigger,
  CostScopeRef,
  CostScopeView,
  CostViewResult,
  CostViewUnavailableReason,
  CostUpdatedEvent,
  PipelineRunCostView,
  SessionBreakdownView,
} from '@canopy/protocol/cost-view';

export type CostViewProblem =
  | { readonly kind: 'unavailable'; readonly reason: CostViewUnavailableReason }
  | {
      readonly kind: 'error';
      readonly reason: CostErrorReason;
      readonly message: string;
    };

export interface CostRefreshState {
  readonly status: 'idle' | 'refreshing' | 'failed';
  /** Why the last refresh failed; null otherwise. */
  readonly problem: CostViewProblem | null;
  /** Manual refreshes that finished successfully (each increase lets a view announce `Cost updated`). */
  readonly completedManual: number;
}

export interface CostViewState<Value> {
  readonly scope: CostScopeRef;
  /** `idle` before the first read; `loading` while a read runs and nothing has been read yet OR a re-read is in flight; `ready` after a successful read; `problem` after a failed read with no value to keep. */
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  /** The last successful value. Kept on screen while a later read runs and after a later read fails; never replaced by an empty value on error. */
  readonly value: Value | null;
  /** The last read's failure, null after a successful read. May be set while `value` is still non-null. */
  readonly problem: CostViewProblem | null;
  /** True while any read is in flight (lets a view keep the last view and show nothing blank). */
  readonly reading: boolean;
  /** The latest of value.updatedAt and the last successful refresh receipt's updatedAt (ISO compare), so a refresh that changed nothing still reads `Updated just now`. */
  readonly updatedAt: string | null;
  readonly refresh: CostRefreshState;
  /** Reads the value. A newer read supersedes older ones (their results are dropped). */
  readonly load: () => Promise<void>;
  /** Asks the client to refresh the scope, then re-reads on success. A retained scope never calls client.refresh (resolves immediately, no state change). */
  readonly requestRefresh: (trigger: CostRefreshTrigger) => Promise<void>;
  /** Called by a mounted view. First attach: subscribes to client.subscribeUpdates, calls client.watchScope(scope) (entry scopes only), loads, and requests an `open` refresh (entry scopes only). Ref-counted: nested attaches share one subscription; the returned release undoes it when the last attacher releases. */
  readonly attach: () => () => void;
  /** Releases everything (subscription, watch) and drops in-flight results. Safe to call twice. */
  readonly dispose: () => void;
}

export type CostViewStore<Value> = UseBoundStore<
  StoreApi<CostViewState<Value>>
>;

/** Generic factory; `read` turns a client result into the value or a problem. */
export function createCostViewStore<Value>(options: {
  readonly client: CostClient;
  readonly scope: CostScopeRef;
  readonly read: (client: CostClient) => Promise<CostViewResult<Value>>;
  /** Value's own updatedAt, for the `updatedAt` field. */
  readonly updatedAtOf: (value: Value) => string | null;
}): CostViewStore<Value> {
  let readGeneration = 0;
  let refreshGeneration = 0;
  let lifecycleGeneration = 0;
  const activeReads = new Set<number>();
  let attachedCount = 0;
  let disposed = false;
  let latestRefreshUpdatedAt: string | null = null;
  let unsubscribeUpdates: (() => void) | null = null;
  let unwatchScope: (() => void) | null = null;
  const refreshingByTrigger = new Map<CostRefreshTrigger, Promise<void>>();
  const refreshGenerationByTrigger = new Map<CostRefreshTrigger, number>();

  function latestIsoDate(
    first: string | null,
    second: string | null,
  ): string | null {
    if (first === null) return second;
    if (second === null) return first;
    return first >= second ? first : second;
  }

  function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return 'The cost request failed.';
  }

  function problemOf<ValueType>(
    result: Exclude<CostViewResult<ValueType>, { readonly status: 'ok' }>,
  ): CostViewProblem {
    if (result.status === 'unavailable') {
      return { kind: 'unavailable', reason: result.reason };
    }
    return {
      kind: 'error',
      reason: result.reason,
      message: result.message,
    };
  }

  function releaseResources(): void {
    const unsubscribe = unsubscribeUpdates;
    unsubscribeUpdates = null;
    unsubscribe?.();

    const unwatch = unwatchScope;
    unwatchScope = null;
    unwatch?.();
  }

  return create<CostViewState<Value>>((set) => {
    const load = async (): Promise<void> => {
      if (disposed) return;

      const generation = ++readGeneration;
      activeReads.add(generation);
      set((state) => ({
        status: 'loading',
        reading: true,
        value: state.value,
      }));

      try {
        let result: CostViewResult<Value>;
        try {
          result = await options.read(options.client);
        } catch (error) {
          result = {
            status: 'error',
            reason: 'UNKNOWN',
            message: errorMessage(error),
          };
        }

        if (disposed || generation !== readGeneration) return;

        if (result.status === 'ok') {
          set({
            status: 'ready',
            value: result.value,
            problem: null,
            updatedAt: latestIsoDate(
              options.updatedAtOf(result.value),
              latestRefreshUpdatedAt,
            ),
          });
        } else {
          set((state) => ({
            status: state.value === null ? 'problem' : 'ready',
            problem: problemOf(result),
          }));
        }
      } finally {
        activeReads.delete(generation);
        if (!disposed) {
          set({ reading: activeReads.size > 0 });
        }
      }
    };

    const requestRefresh = async (
      trigger: CostRefreshTrigger,
    ): Promise<void> => {
      if (disposed || options.scope.kind === 'retained') return;

      const existing = refreshingByTrigger.get(trigger);
      if (existing !== undefined) return existing;

      const generation = ++refreshGeneration;
      const lifecycle = lifecycleGeneration;
      set((state) => ({
        refresh: { ...state.refresh, status: 'refreshing', problem: null },
      }));

      const operation = async (): Promise<void> => {
        try {
          let result: CostViewResult<CostRefreshReceipt>;
          try {
            result = await options.client.refresh({
              scope: options.scope,
              trigger,
            });
          } catch (error) {
            result = {
              status: 'error',
              reason: 'UNKNOWN',
              message: errorMessage(error),
            };
          }

          if (disposed || lifecycle !== lifecycleGeneration) return;

          if (result.status !== 'ok') {
            if (generation === refreshGeneration) {
              set((state) => ({
                refresh: {
                  ...state.refresh,
                  status: 'failed',
                  problem: problemOf(result),
                },
              }));
            }
            return;
          }

          latestRefreshUpdatedAt = latestIsoDate(
            latestRefreshUpdatedAt,
            result.value.updatedAt,
          );
          set((state) => ({
            updatedAt: latestIsoDate(
              state.value === null ? null : options.updatedAtOf(state.value),
              latestRefreshUpdatedAt,
            ),
          }));

          await load();
          if (disposed || lifecycle !== lifecycleGeneration) return;

          set((state) => ({
            refresh: {
              ...state.refresh,
              ...(generation === refreshGeneration
                ? { status: 'idle' as const, problem: null }
                : {}),
              completedManual:
                state.refresh.completedManual + (trigger === 'manual' ? 1 : 0),
            },
          }));
        } finally {
          void Promise.resolve().then(() => {
            if (refreshGenerationByTrigger.get(trigger) === generation) {
              refreshingByTrigger.delete(trigger);
              refreshGenerationByTrigger.delete(trigger);
            }
          });
        }
      };

      const inFlight = operation();
      refreshGenerationByTrigger.set(trigger, generation);
      refreshingByTrigger.set(trigger, inFlight);
      return inFlight;
    };

    const attach = (): (() => void) => {
      if (disposed) {
        disposed = false;
        activeReads.clear();
      }

      attachedCount += 1;
      if (attachedCount === 1) {
        unsubscribeUpdates = options.client.subscribeUpdates(
          (event: CostUpdatedEvent): void => {
            if (
              disposed ||
              attachedCount === 0 ||
              !event.scopes.some(
                (scope) => costScopeKey(scope) === costScopeKey(options.scope),
              )
            ) {
              return;
            }
            void load();
          },
        );

        if (options.scope.kind === 'entry') {
          unwatchScope = options.client.watchScope(options.scope);
        }

        void load();
        if (options.scope.kind === 'entry') {
          void requestRefresh('open');
        }
      }

      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        if (disposed) return;

        attachedCount -= 1;
        if (attachedCount === 0) releaseResources();
      };
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      readGeneration += 1;
      refreshGeneration += 1;
      lifecycleGeneration += 1;
      activeReads.clear();
      refreshingByTrigger.clear();
      refreshGenerationByTrigger.clear();
      attachedCount = 0;
      releaseResources();
    };

    return {
      scope: options.scope,
      status: 'idle',
      value: null,
      problem: null,
      reading: false,
      updatedAt: null,
      refresh: { status: 'idle', problem: null, completedManual: 0 },
      load,
      requestRefresh,
      attach,
      dispose,
    };
  });
}

export type CostScopeStore = CostViewStore<CostScopeView>;

export function createCostScopeStore(
  client: CostClient,
  scope: CostScopeRef,
): CostScopeStore {
  return createCostViewStore({
    client,
    scope,
    read: (costClient) => costClient.getScope({ scope }),
    updatedAtOf: (value) => value.updatedAt,
  });
}

export type SessionBreakdownStore = CostViewStore<SessionBreakdownView>;

export function createSessionBreakdownStore(
  client: CostClient,
  scope: CostScopeRef,
  chatId: string,
): SessionBreakdownStore {
  return createCostViewStore({
    client,
    scope,
    read: async (costClient) => {
      const result = await costClient.getChat({
        scope,
        chatId,
        detail: 'full',
      });
      if (result.status !== 'ok') return result;
      if (result.value.kind !== 'full') {
        return {
          status: 'error',
          reason: 'UNKNOWN',
          message: 'Expected a full cost chat view.',
        };
      }
      return { status: 'ok', value: result.value.breakdown };
    },
    updatedAtOf: (value) => value.updatedAt,
  });
}

export type PipelineRunCostStore = CostViewStore<PipelineRunCostView>;

export function createPipelineRunCostStore(
  client: CostClient,
  scope: CostScopeRef,
  executionId: string,
): PipelineRunCostStore {
  return createCostViewStore({
    client,
    scope,
    read: (costClient) => costClient.getPipelineRun({ scope, executionId }),
    updatedAtOf: (value) => value.updatedAt,
  });
}

export type CostChatSummaryStore = CostViewStore<CostChatRow>;

export function createCostChatSummaryStore(
  client: CostClient,
  scope: CostScopeRef,
  chatId: string,
): CostChatSummaryStore {
  return createCostViewStore({
    client,
    scope,
    read: async (costClient) => {
      const result = await costClient.getChat({
        scope,
        chatId,
        detail: 'summary',
      });
      if (result.status !== 'ok') return result;
      if (result.value.kind !== 'summary') {
        return {
          status: 'error',
          reason: 'UNKNOWN',
          message: 'Expected a cost chat summary.',
        };
      }
      return { status: 'ok', value: result.value.chat };
    },
    updatedAtOf: () => null,
  });
}

export interface CostSubagentValue {
  readonly chat: CostChatRow;
  readonly item: CostAttributedItem;
}

export type CostSubagentStore = CostViewStore<CostSubagentValue>;

export function createCostSubagentStore(
  client: CostClient,
  scope: CostScopeRef,
  chatId: string,
  subagentId: string,
): CostSubagentStore {
  return createCostViewStore({
    client,
    scope,
    read: async (costClient) => {
      const result = await costClient.getChat({ scope, chatId, subagentId });
      if (result.status !== 'ok') return result;
      if (result.value.kind !== 'subagent') {
        return {
          status: 'error',
          reason: 'UNKNOWN',
          message: 'Expected a cost subagent view.',
        };
      }
      return {
        status: 'ok',
        value: { chat: result.value.chat, item: result.value.item },
      };
    },
    updatedAtOf: () => null,
  });
}
