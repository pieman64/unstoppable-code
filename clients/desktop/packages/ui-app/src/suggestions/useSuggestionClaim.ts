'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { SuggestionClaimStatus } from '@canopy/app-state';
import type { SuggestionId } from '@canopy/protocol/suggestions';
import {
  useSuggestionsClaimApi,
  type SuggestionsClaimApi,
} from './SuggestionsProvider';

export interface SuggestionClaim {
  /** False when the host has no claim API: the caller keeps its old behavior. */
  readonly gated: boolean;
  readonly token: string;
  /** `ungated` without a claim API. */
  readonly status: SuggestionClaimStatus | 'ungated';
  /**
   * The category could be granted: ungated, or ready, on and not dismissed.
   * Ignores the corner cap and other claims; lets a caller avoid reserving
   * other slots for a claim that would only be refused.
   */
  readonly eligible: boolean;
  /** The suggestion may be on screen now (active, or ungated). */
  readonly allowed: boolean;
  /** Synchronous re-check for event handlers and effects. */
  readonly isAllowed: () => boolean;
  /** The active activation, or null when this claim is not active. */
  readonly activation: number | null;
  /**
   * The suggestion is actually on screen. Confirms once per activation;
   * returns false for a repeat, a stale activation, or no claim API.
   */
  readonly confirmShown: () => boolean;
  /** Don't show again for the whole category, through the shared path. */
  readonly dismiss: () => void;
}

let tokens = 0;

function newToken(): string {
  tokens += 1;
  return `suggestion-claim-${tokens}-${Math.random().toString(36).slice(2)}`;
}

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

function subscribeTo(
  api: SuggestionsClaimApi | null,
): (listener: () => void) => () => void {
  return api === null ? NO_SUBSCRIPTION : api.subscribe;
}

/**
 * Whether a claim for this category could be granted: no claim API
 * (ungated), or ready, on and not dismissed. Ignores the corner cap and
 * other claims, so callers can avoid reserving other slots for a claim that
 * would only be refused.
 */
export function useSuggestionEligible(
  suggestionId: SuggestionId,
  apiOverride?: SuggestionsClaimApi | null,
): boolean {
  const contextApi = useSuggestionsClaimApi();
  const api = apiOverride === undefined ? contextApi : apiOverride;
  return useSyncExternalStore(
    subscribeTo(api),
    (): boolean => {
      const state = api?.getState();
      return (
        state === undefined ||
        (state.status === 'ready' &&
          state.enabled &&
          state.dismissed[suggestionId] === undefined)
      );
    },
    () => true,
  );
}

/**
 * Takes part in one-at-a-time suggestion arbitration (CAN-4343) while
 * `wants` is true. Claims are registered and released only in effects, so a
 * render, Strict Mode replay or unmount never leaves a stale claim behind.
 *
 * A refused claim is not queued. It is asked again when `retryKey` changes,
 * when `wants` turns on again, or when the shared state becomes ready or
 * enabled; producers pick the natural trigger.
 */
export function useSuggestionClaim(
  suggestionId: SuggestionId,
  wants: boolean,
  retryKey?: string | number,
  /** The specific offer; see the store's `claim`. */
  itemKey?: string,
  apiOverride?: SuggestionsClaimApi | null,
): SuggestionClaim {
  const contextApi = useSuggestionsClaimApi();
  const api = apiOverride === undefined ? contextApi : apiOverride;
  const [token] = useState(newToken);
  const subscribe = subscribeTo(api);
  const status = useSyncExternalStore<SuggestionClaimStatus | 'ungated'>(
    subscribe,
    (): SuggestionClaimStatus | 'ungated' =>
      api === null ? 'ungated' : (api.getState().claims[token] ?? 'none'),
    (): SuggestionClaimStatus | 'ungated' => 'ungated',
  );
  const activation = useSyncExternalStore(
    subscribe,
    (): number | null => {
      const active = api?.getState().active;
      return active?.token === token ? active.activation : null;
    },
    () => null,
  );
  // Readiness or the switch turning on makes a refused claim worth asking again.
  const open = useSyncExternalStore(
    subscribe,
    (): boolean => {
      const state = api?.getState();
      return state !== undefined && state.status === 'ready' && state.enabled;
    },
    () => false,
  );

  const eligible = useSuggestionEligible(suggestionId, api);

  useEffect(() => {
    if (api === null) return undefined;
    if (!wants) {
      api.getState().release(token);
      return undefined;
    }
    api.getState().claim(token, suggestionId, itemKey);
    return undefined;
  }, [api, token, suggestionId, wants, open, retryKey, itemKey]);

  useEffect(
    () => (): void => {
      api?.getState().release(token);
    },
    [api, token],
  );

  const isAllowed = useCallback(
    (): boolean =>
      api === null ||
      (api.getState().active?.token === token &&
        api.getState().active?.activation === activation),
    [api, token, activation],
  );
  const confirmShown = useCallback((): boolean => {
    if (api === null || activation === null) return false;
    return api.getState().confirmShown(token, activation);
  }, [api, token, activation]);
  const dismiss = useCallback((): void => {
    if (isAllowed()) void api?.getState().dismiss(suggestionId);
  }, [api, suggestionId, isAllowed]);

  return {
    gated: api !== null,
    token,
    status,
    eligible,
    allowed: api === null || status === 'active',
    isAllowed,
    activation,
    confirmShown,
    dismiss,
  };
}
