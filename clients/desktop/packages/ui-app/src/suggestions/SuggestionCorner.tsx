'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type JSX,
} from 'react';
import type { SuggestionId } from '@canopy/protocol/suggestions';
import {
  SuggestionCard,
  type SuggestionCardAction,
} from '@canopy/ui-shared/components';
import {
  useSuggestionCornerRegistry,
  useSuggestionsClaimApi,
  type SuggestionCornerModel,
} from './SuggestionsProvider';
import { useSuggestionClaim, type SuggestionClaim } from './useSuggestionClaim';

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return (): void => document.removeEventListener('visibilitychange', listener);
}
function documentIsVisible(): boolean {
  return document.visibilityState !== 'hidden';
}
function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    documentIsVisible,
    () => false,
  );
}

/**
 * Offers one event-driven suggestion to the shared corner (CAN-4343). While
 * `model` is non-null and a corner is mounted, the producer claims the slot;
 * the corner renders the model only while the claim is active and the model
 * is presentable. Without a claim API or a corner, nothing is offered.
 */
export function useSuggestionCornerOffer(
  suggestionId: SuggestionId,
  model: SuggestionCornerModel | null,
  retryKey?: string | number,
): SuggestionClaim {
  const registry = useSuggestionCornerRegistry();
  const documentVisible = useDocumentVisible();
  const cornerMounted = useSyncExternalStore(
    registry?.subscribe ?? NO_SUBSCRIPTION,
    () => registry?.cornerMounted() ?? false,
    () => false,
  );
  const claim = useSuggestionClaim(
    suggestionId,
    model !== null &&
      cornerMounted &&
      (model.retainWhenHidden === true ||
        (documentVisible && model.presentable)),
    retryKey,
    model?.itemKey,
  );
  useLayoutEffect(() => {
    if (registry === null) return undefined;
    registry.set(claim.token, model);
    return undefined;
  }, [registry, claim.token, model]);
  useEffect(
    () => (): void => {
      registry?.set(claim.token, null);
    },
    [registry, claim.token],
  );
  return claim;
}

/**
 * The one suggestion corner. Renders the active corner claim's card while it
 * is presentable, confirms its display once per activation (which stamps the
 * 24-hour cap), and owns the single shared Don't show again call.
 */
export function SuggestionCorner(): JSX.Element | null {
  const api = useSuggestionsClaimApi();
  const documentVisible = useDocumentVisible();
  const registry = useSuggestionCornerRegistry();
  useEffect(() => registry?.mountCorner(), [registry]);
  const active = useSyncExternalStore(
    api?.subscribe ?? NO_SUBSCRIPTION,
    () => {
      const current = api?.getState().active ?? null;
      return current?.placement === 'corner' ? current : null;
    },
    () => null,
  );
  const model = useSyncExternalStore(
    registry?.subscribe ?? NO_SUBSCRIPTION,
    () => (active === null ? undefined : registry?.get(active.token)),
    () => undefined,
  );
  const visible =
    documentVisible &&
    active !== null &&
    model !== undefined &&
    model.suggestionId === active.suggestionId &&
    model.presentable;
  const shownActivation = useRef<number | null>(null);
  useEffect(() => {
    if (!visible || api === null || active === null) return;
    if (shownActivation.current === active.activation) return;
    if (!api.getState().confirmShown(active.token, active.activation)) return;
    shownActivation.current = active.activation;
    model?.onShown?.();
  }, [visible, api, active, model]);

  if (!visible || api === null || active === null) return null;
  const { permanentDismiss } = model;
  const isCurrent = (): boolean => {
    const current = api.getState().active;
    return (
      current?.token === active.token &&
      current.activation === active.activation
    );
  };
  const guardAction = (action: SuggestionCardAction): SuggestionCardAction => ({
    ...action,
    onClick: (event): void => {
      if (isCurrent()) action.onClick(event);
    },
  });
  return (
    <SuggestionCard
      {...model.card}
      primaryAction={guardAction(model.card.primaryAction)}
      secondaryAction={guardAction(model.card.secondaryAction)}
      {...(permanentDismiss
        ? {
            permanentDismiss: {
              label: permanentDismiss.label ?? 'Don’t show again',
              testId:
                permanentDismiss.testId ??
                `${model.card.testId}-dismiss-forever`,
              onClick: (): void => {
                if (!isCurrent()) return;
                void api.getState().dismiss(active.suggestionId);
                permanentDismiss.onDismissed?.();
              },
            },
          }
        : {})}
    />
  );
}
