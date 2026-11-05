'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  useCapabilities,
  useOptionalCanopyClient,
  useSuggestionsStoreApi,
  type ClientStore,
  type SuggestionsStoreState,
} from '@canopy/app-state';
import type { SuggestionId } from '@canopy/protocol/suggestions';
import type { SuggestionCardProps } from '@canopy/ui-shared/components';

/**
 * The shared suggestions claim API: the provider-scoped suggestions store,
 * or null when the host does not support suggestions (cloud chats, Portal
 * sessions without `suggestions_v1`). Null keeps pre-CAN-4343 behavior: no
 * gating, persistence or arbitration.
 */
export type SuggestionsClaimApi = ClientStore<SuggestionsStoreState>;

const ClaimContext = createContext<SuggestionsClaimApi | null>(null);

/** A corner card's presentation, keyed by the claim token that owns it. */
export interface SuggestionCornerModel {
  readonly suggestionId: SuggestionId;
  /**
   * The specific offer (a share target, a repeated task). The item already
   * shown this session may come back after a brief hide without a new cap
   * window; omit when every display is new.
   */
  readonly itemKey?: string;
  /**
   * Whether the card can be on screen now. An unpresentable claim keeps its
   * slot (the notification offer while the window is blurred) but renders
   * and stamps nothing.
   */
  readonly presentable: boolean;
  /** OS offers may keep ownership while blurred/hidden, without displaying. */
  readonly retainWhenHidden?: boolean;
  readonly card: Omit<SuggestionCardProps, 'permanentDismiss'>;
  /**
   * Don't show again. The corner calls the shared `dismiss(id)` once, then
   * this producer cleanup; producers never call `dismiss` themselves.
   */
  readonly permanentDismiss?: {
    readonly label?: string;
    readonly testId?: string;
    readonly onDismissed?: () => void;
  };
  /** Called once per activation, after the card is actually on screen. */
  readonly onShown?: () => void;
}

/** Corner card models registered by producers, with mounted-corner tracking. */
export interface SuggestionCornerRegistry {
  readonly set: (token: string, model: SuggestionCornerModel | null) => void;
  readonly get: (token: string) => SuggestionCornerModel | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  /** A `SuggestionCorner` is mounted: producers only claim while one is. */
  readonly mountCorner: () => () => void;
  readonly cornerMounted: () => boolean;
}

function createCornerRegistry(): SuggestionCornerRegistry {
  const models = new Map<string, SuggestionCornerModel>();
  const listeners = new Set<() => void>();
  let corners = 0;
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    set: (token, model): void => {
      if (model === null) {
        if (!models.delete(token)) return;
      } else {
        models.set(token, model);
      }
      notify();
    },
    get: (token) => models.get(token),
    subscribe: (listener) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    mountCorner: () => {
      corners += 1;
      notify();
      return (): void => {
        corners -= 1;
        notify();
      };
    },
    cornerMounted: () => corners > 0,
  };
}

const CornerContext = createContext<SuggestionCornerRegistry | null>(null);

/**
 * Hosts that support suggestions mount this inside `CanopyClientProvider`.
 * It loads the shared state and hands the claim API to shared composers and
 * corner producers only when the client advertises `suggestions`.
 */
export function SuggestionsProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const store = useSuggestionsStoreApi();
  const supported = useCapabilities().suggestions === true;
  useEffect(() => {
    if (supported) store.getState().load();
  }, [store, supported]);
  const [registry] = useState(createCornerRegistry);
  const api = supported ? store : null;
  const value = useMemo(() => registry, [registry]);
  return (
    <ClaimContext.Provider value={api}>
      <CornerContext.Provider value={value}>{children}</CornerContext.Provider>
    </ClaimContext.Provider>
  );
}

/** Null outside a supporting host: callers then keep their old behavior. */
export function useSuggestionsClaimApi(
  targetId?: string,
): SuggestionsClaimApi | null {
  const api = useContext(ClaimContext);
  const client = useOptionalCanopyClient();
  if (targetId !== undefined) {
    const capabilities =
      client?.capabilitiesFor?.(targetId) ?? client?.capabilities;
    if (capabilities?.suggestions !== true) return null;
  }
  return api;
}

export function useSuggestionCornerRegistry(): SuggestionCornerRegistry | null {
  return useContext(CornerContext);
}
