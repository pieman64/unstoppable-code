import { create } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import {
  isCornerSuggestionAllowed,
  SUGGESTION_IDS,
  SUGGESTION_PLACEMENTS,
  type SuggestionId,
  type SuggestionPlacement,
  type SuggestionsState,
  type SuggestionsUpdate,
} from '@canopy/protocol/suggestions';
import { useCanopyClientStore } from '../CanopyClientProvider';
import {
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../client-store-lifecycle';

/**
 * `unavailable`: the host keeps no suggestion preferences (`suggestions`
 * capability unset), so callers keep their pre-CAN-4343 behavior. `loading`
 * and `failed` (no confirmed state yet) refuse every claim.
 */
export type SuggestionsStatus = 'unavailable' | 'loading' | 'ready' | 'failed';

/**
 * A claim's place in arbitration. `refused` claims are not queued: the
 * producer retries on its own next trigger. `none` means the token holds no
 * claim (never claimed, or released).
 */
export type SuggestionClaimStatus = 'active' | 'waiting' | 'refused' | 'none';

/** The one suggestion allowed on screen in this UI runtime. */
export interface ActiveSuggestionClaim {
  readonly token: string;
  readonly suggestionId: SuggestionId;
  readonly placement: SuggestionPlacement;
  /** Advances on every activation; display confirmation is keyed by it. */
  readonly activation: number;
}

export interface SuggestionsStoreState {
  readonly status: SuggestionsStatus;
  /** The host's last committed state, or null before the first read. */
  readonly committed: SuggestionsState | null;
  /** Effective master switch, including an in-flight optimistic change. */
  readonly enabled: boolean;
  /** Effective dismissals, including dismissals the host has not confirmed. */
  readonly dismissed: Readonly<Partial<Record<SuggestionId, string>>>;
  /** Effective corner stamp, including a display whose save failed. */
  readonly lastCornerShownAt: string | undefined;
  /** A master-switch change is being saved. */
  readonly saving: boolean;
  /** The last master-switch save failed and was rolled back. */
  readonly saveFailed: boolean;
  /** Dismissals that are hidden this session but could not be saved. */
  readonly failedDismissals: readonly SuggestionId[];
  readonly active: ActiveSuggestionClaim | null;
  readonly claims: Readonly<Record<string, SuggestionClaimStatus>>;
  /**
   * Reads the state once per client and again on focus, visibility and
   * source changes. Repeated calls only retry an unavailable/failed read.
   */
  readonly load: () => void;
  /** Takes committed state the host pushed after a change elsewhere. */
  readonly sync: (state: SuggestionsState) => void;
  /**
   * Asks for the one suggestion slot. Idempotent per token: a waiting or
   * active claim keeps its place, a refused claim is re-evaluated.
   *
   * `itemKey` names the specific offer (a skill-share target, a repeated
   * task). The corner card already shown this session for the same item is
   * not a newly displayed card, so it may come back after a brief hide even
   * though its own display closed the cap.
   */
  readonly claim: (
    token: string,
    suggestionId: SuggestionId,
    itemKey?: string,
  ) => SuggestionClaimStatus;
  /** Gives up the slot or a waiting place; the next eligible claim activates. */
  readonly updateClaim: (
    token: string,
    suggestionId: SuggestionId,
    itemKey?: string,
  ) => SuggestionClaimStatus;
  readonly release: (token: string) => void;
  readonly getClaimStatus: (token: string) => SuggestionClaimStatus;
  /**
   * The active claim's UI became visible. True only for the first
   * confirmation of that activation; a corner display closes the cap for
   * every other corner claim, including ones already waiting.
   */
  readonly confirmShown: (token: string, activation: number) => boolean;
  /** Settings master switch. Resolves false when the save failed. */
  readonly setEnabled: (enabled: boolean) => Promise<boolean>;
  /** Don't show again for a whole category. Hidden at once, saved after. */
  readonly dismiss: (suggestionId: SuggestionId) => Promise<void>;
}

export interface SuggestionsStoreOptions {
  readonly now?: () => Date;
}

interface ClaimRecord {
  readonly suggestionId: SuggestionId;
  readonly itemKey: string | undefined;
  status: Exclude<SuggestionClaimStatus, 'none'>;
  /** Arrival order among waiting claims; ties in priority go to the oldest. */
  arrival: number;
}

function priority(id: SuggestionId): number {
  return SUGGESTION_IDS.indexOf(id);
}

function laterStamp(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * Suggestion preferences and one-at-a-time arbitration (CAN-4343).
 *
 * Arbitration scope is this UI runtime (one provider/client store): one
 * React root (including its pulled-out panel portals), or one Portal tab.
 * It does not coordinate independent renderer roots or simultaneous Portal sessions; the persisted corner
 * stamp is a display report, not an atomic cross-client grant. See
 * `docs/in-app-suggestions.md`.
 */
export function createSuggestionsStore(
  client: CanopyClient,
  options: SuggestionsStoreOptions = {},
): ClientStore<SuggestionsStoreState> {
  const now = options.now ?? ((): Date => new Date());
  let disposed = false;
  // Advances on every source change; stale reads, pushes and mutation
  // completions from an earlier source are dropped.
  let sourceGeneration = 0;
  // Advances on every read and every mutation start, so a read that raced a
  // mutation never overwrites the mutation's newer state.
  let readGeneration = 0;
  let pushGeneration = 0;
  let mutationsInFlight = 0;
  let mutationQueue: Promise<unknown> = Promise.resolve();
  // Latest master-switch change; an older failure never rolls back a newer one.
  let enableOperation = 0;
  let pendingEnabled: boolean | undefined;
  // Dismissals hidden here that the host has not confirmed.
  let sessionDismissed: Partial<Record<SuggestionId, string>> = {};
  // A corner display this session, kept when its save failed.
  let localCornerShownAt: string | undefined;
  const claims = new Map<string, ClaimRecord>();
  let arrivals = 0;
  let activations = 0;
  const confirmedActivations = new Set<number>();
  // The corner item displayed this session, which may re-show under the cap.
  let shownCornerItem: string | null = null;
  const itemIdentity = (
    suggestionId: SuggestionId,
    itemKey: string | undefined,
    token: string,
  ): string => JSON.stringify([suggestionId, itemKey ?? token]);
  let stopWatchingFocus: (() => void) | null = null;
  let stopWatchingSource: (() => void) | null = null;

  const store: ClientStore<SuggestionsStoreState> =
    create<SuggestionsStoreState>()((set, get) => {
      const effective = (): Pick<
        SuggestionsStoreState,
        'enabled' | 'dismissed' | 'lastCornerShownAt'
      > => {
        const committed = get().committed;
        return {
          enabled: pendingEnabled ?? committed?.enabled ?? false,
          dismissed: { ...committed?.dismissed, ...sessionDismissed },
          lastCornerShownAt: laterStamp(
            committed?.lastCornerShownAt,
            localCornerShownAt,
          ),
        };
      };

      const isEligible = (
        suggestionId: SuggestionId,
        itemKey: string | undefined,
        token: string,
      ): boolean => {
        const state = get();
        if (state.status !== 'ready') return false;
        if (!state.enabled) return false;
        if (state.dismissed[suggestionId] !== undefined) return false;
        if (SUGGESTION_PLACEMENTS[suggestionId] === 'corner') {
          const item = itemIdentity(suggestionId, itemKey, token);
          if (item === shownCornerItem) return true;
          return isCornerSuggestionAllowed(
            {
              enabled: state.enabled,
              dismissed: state.dismissed,
              ...(state.lastCornerShownAt === undefined
                ? {}
                : { lastCornerShownAt: state.lastCornerShownAt }),
            },
            now(),
          );
        }
        return true;
      };

      const publishClaims = (active: ActiveSuggestionClaim | null): void => {
        const statuses: Record<string, SuggestionClaimStatus> = {};
        for (const [token, record] of claims) statuses[token] = record.status;
        set({ claims: statuses, active });
      };

      /**
       * Refuses waiting claims that are no longer eligible, drops an active
       * claim that became ineligible through disable or dismissal, and fills
       * an empty slot with the highest-priority eligible waiting claim.
       */
      const arbitrate = (): void => {
        let active = get().active;
        if (active !== null) {
          const record = claims.get(active.token);
          const state = get();
          // A displayed corner card is never evicted by its own cap; only
          // disable, dismissal or loss of readiness takes it down.
          const stillAllowed =
            record !== undefined &&
            state.status === 'ready' &&
            state.enabled &&
            state.dismissed[active.suggestionId] === undefined;
          if (!stillAllowed) {
            if (record !== undefined) record.status = 'refused';
            active = null;
          }
        }
        let next: [string, ClaimRecord] | null = null;
        for (const entry of claims) {
          const [, record] = entry;
          if (record.status !== 'waiting') continue;
          if (!isEligible(record.suggestionId, record.itemKey, entry[0])) {
            record.status = 'refused';
            continue;
          }
          if (
            next === null ||
            priority(record.suggestionId) < priority(next[1].suggestionId) ||
            (priority(record.suggestionId) === priority(next[1].suggestionId) &&
              record.arrival < next[1].arrival)
          ) {
            next = entry;
          }
        }
        if (active === null && next !== null) {
          const [token, record] = next;
          record.status = 'active';
          activations += 1;
          active = {
            token,
            suggestionId: record.suggestionId,
            placement: SUGGESTION_PLACEMENTS[record.suggestionId],
            activation: activations,
          };
        }
        publishClaims(active);
      };

      const refuseAll = (): void => {
        for (const record of claims.values()) record.status = 'refused';
        publishClaims(null);
      };

      const applyEffective = (): void => {
        set(effective());
        arbitrate();
      };

      const accept = (state: SuggestionsState): void => {
        for (const id of SUGGESTION_IDS) {
          if (state.dismissed[id] !== undefined) delete sessionDismissed[id];
        }
        set({ committed: state, status: 'ready' });
        applyEffective();
      };

      const read = (): void => {
        if (client.capabilities.suggestions !== true) {
          set({ status: 'unavailable' });
          refuseAll();
          return;
        }
        readGeneration += 1;
        const request = readGeneration;
        const source = sourceGeneration;
        if (get().committed === null) set({ status: 'loading' });
        client
          .query('suggestions.get', {})
          .then((state) => {
            if (disposed || source !== sourceGeneration) return;
            if (request !== readGeneration || mutationsInFlight > 0) return;
            accept(state);
          })
          .catch(() => {
            if (disposed || source !== sourceGeneration) return;
            if (request !== readGeneration) return;
            // A later failure keeps the last confirmed state for this source.
            if (get().committed === null) {
              set({ status: 'failed' });
              refuseAll();
            }
          });
      };

      /** Serialized so a mutation's result is never older than an earlier one's. */
      const mutate = (
        update: SuggestionsUpdate,
      ): Promise<SuggestionsState | null> => {
        const source = sourceGeneration;
        mutationsInFlight += 1;
        readGeneration += 1;
        const run = mutationQueue.then(async () => {
          try {
            if (disposed || source !== sourceGeneration) return null;
            const pushed = pushGeneration;
            const state = await client.command('suggestions.update', update);
            if (disposed || source !== sourceGeneration) return null;
            // Broadcasts are emitted at commit time, before the IPC response.
            // A later writer may have committed by the time this older response
            // arrives. Keep the newest pushed state rather than undoing it.
            return pushed === pushGeneration
              ? state
              : (get().committed ?? state);
          } catch (error) {
            if (disposed || source !== sourceGeneration) return null;
            throw error;
          } finally {
            if (source === sourceGeneration) mutationsInFlight -= 1;
          }
        });
        mutationQueue = run.catch(() => undefined);
        return run;
      };

      const resetForSource = (): void => {
        sourceGeneration += 1;
        readGeneration += 1;
        mutationsInFlight = 0;
        mutationQueue = Promise.resolve();
        enableOperation += 1;
        pendingEnabled = undefined;
        sessionDismissed = {};
        localCornerShownAt = undefined;
        shownCornerItem = null;
        confirmedActivations.clear();
        for (const record of claims.values()) record.status = 'refused';
        set({
          status: 'loading',
          committed: null,
          enabled: false,
          dismissed: {},
          lastCornerShownAt: undefined,
          saving: false,
          saveFailed: false,
          failedDismissals: [],
        });
        publishClaims(null);
      };

      return {
        status:
          client.capabilities.suggestions === true ? 'loading' : 'unavailable',
        committed: null,
        enabled: false,
        dismissed: {},
        lastCornerShownAt: undefined,
        saving: false,
        saveFailed: false,
        failedDismissals: [],
        active: null,
        claims: {},
        load: (): void => {
          if (disposed) return;
          if (client.capabilities.suggestions !== true) {
            set({ status: 'unavailable' });
            return;
          }
          if (stopWatchingSource === null) {
            stopWatchingSource =
              client.subscribeSuggestionsSourceChange?.(() => {
                // Another desktop's preferences never show for this one.
                resetForSource();
                read();
              }) ?? null;
          }
          if (stopWatchingFocus !== null) {
            if (get().committed === null) read();
            return;
          }
          read();
          if (typeof window === 'undefined') return;
          const onFocus = (): void => {
            read();
          };
          const onVisibility = (): void => {
            if (document.visibilityState === 'visible') read();
          };
          window.addEventListener('focus', onFocus);
          document.addEventListener('visibilitychange', onVisibility);
          stopWatchingFocus = (): void => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibility);
          };
        },
        sync: (state): void => {
          if (disposed || get().status === 'unavailable') return;
          pushGeneration += 1;
          readGeneration += 1;
          accept(state);
        },
        claim: (token, suggestionId, itemKey): SuggestionClaimStatus => {
          if (disposed) return 'refused';
          const existing = claims.get(token);
          if (
            existing !== undefined &&
            existing.suggestionId === suggestionId &&
            existing.itemKey === itemKey
          ) {
            if (existing.status !== 'refused') return existing.status;
          } else if (existing !== undefined) {
            claims.delete(token);
            if (get().active?.token === token) publishClaims(null);
          }
          if (!isEligible(suggestionId, itemKey, token)) {
            claims.set(token, {
              suggestionId,
              itemKey,
              status: 'refused',
              arrival: arrivals,
            });
            arbitrate();
            return 'refused';
          }
          arrivals += 1;
          claims.set(token, {
            suggestionId,
            itemKey,
            status: 'waiting',
            arrival: arrivals,
          });
          arbitrate();
          return claims.get(token)?.status ?? 'refused';
        },
        updateClaim: (token, suggestionId, itemKey): SuggestionClaimStatus =>
          get().claim(token, suggestionId, itemKey),
        release: (token): void => {
          if (!claims.delete(token)) return;
          const active = get().active;
          if (active?.token === token) publishClaims(null);
          arbitrate();
        },
        getClaimStatus: (token): SuggestionClaimStatus =>
          claims.get(token)?.status ?? 'none',
        confirmShown: (token, activation): boolean => {
          const active = get().active;
          if (
            disposed ||
            active === null ||
            active.token !== token ||
            active.activation !== activation ||
            confirmedActivations.has(activation)
          )
            return false;
          confirmedActivations.add(activation);
          if (active.placement !== 'corner') return true;
          const item = itemIdentity(
            active.suggestionId,
            claims.get(token)?.itemKey,
            token,
          );
          if (shownCornerItem === item) return false;
          shownCornerItem = item;
          // Stamp locally first: the cap holds this session even when the
          // save fails, but is only durable once the host confirms it.
          localCornerShownAt = laterStamp(
            localCornerShownAt,
            now().toISOString(),
          );
          applyEffective();
          void mutate({
            action: 'corner-shown',
            suggestionId: active.suggestionId,
          })
            .then((state) => {
              if (state !== null && mutationsInFlight === 0) accept(state);
            })
            .catch(() => undefined);
          return true;
        },
        setEnabled: async (enabled): Promise<boolean> => {
          if (disposed || get().status !== 'ready') return false;
          enableOperation += 1;
          const operation = enableOperation;
          pendingEnabled = enabled;
          set({ saving: true, saveFailed: false });
          applyEffective();
          try {
            const state = await mutate({ action: 'set-enabled', enabled });
            if (state === null) return false;
            if (operation === enableOperation) {
              pendingEnabled = undefined;
              set({ saving: false });
            }
            if (mutationsInFlight === 0) accept(state);
            else {
              set({ committed: state });
              applyEffective();
            }
            return true;
          } catch {
            if (operation === enableOperation) {
              pendingEnabled = undefined;
              set({ saving: false, saveFailed: true });
              applyEffective();
            }
            return false;
          }
        },
        dismiss: async (suggestionId): Promise<void> => {
          if (disposed || get().status === 'unavailable') return;
          if (sessionDismissed[suggestionId] === undefined) {
            sessionDismissed = {
              ...sessionDismissed,
              [suggestionId]: now().toISOString(),
            };
          }
          for (const record of claims.values()) {
            if (record.suggestionId === suggestionId) record.status = 'refused';
          }
          set({
            failedDismissals: get().failedDismissals.filter(
              (id) => id !== suggestionId,
            ),
          });
          applyEffective();
          try {
            const state = await mutate({ action: 'dismiss', suggestionId });
            if (state === null) return;
            if (mutationsInFlight === 0) accept(state);
            else {
              set({ committed: state });
              applyEffective();
            }
          } catch {
            // Stays hidden this session; Settings can surface the retry.
            if (!get().failedDismissals.includes(suggestionId)) {
              set({
                failedDismissals: [...get().failedDismissals, suggestionId],
              });
            }
          }
        },
      };
    });

  store[CLIENT_STORE_DISPOSE] = (): void => {
    disposed = true;
    stopWatchingFocus?.();
    stopWatchingFocus = null;
    stopWatchingSource?.();
    stopWatchingSource = null;
    claims.clear();
  };
  return store;
}

const SUGGESTIONS_STORE_KEY = Symbol('suggestions-store');

/**
 * The provider-scoped store itself, for hosts that hand it to shared UI as a
 * claim API (subscribe/getState outside React render).
 */
export function useSuggestionsStoreApi(): ClientStore<SuggestionsStoreState> {
  return useCanopyClientStore(SUGGESTIONS_STORE_KEY, createSuggestionsStore);
}

export function useSuggestionsStore<TSelected>(
  selector: (state: SuggestionsStoreState) => TSelected,
): TSelected {
  return useSuggestionsStoreApi()(selector);
}
