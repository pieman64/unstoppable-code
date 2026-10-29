'use client';

import { useEffect, useState } from 'react';
import {
  settingsRouteKey,
  useSettingsStore,
  useSettingsStoreApi,
  type SettingsPageEntry,
  type SettingsStore,
} from '@canopy/app-state/settings';
import type {
  SettingsErrorPayload,
  SettingsPageData,
  SettingsPageDataKind,
  SettingsRoute,
} from '@canopy/protocol/settings';
import {
  LOADING_PLACEHOLDER_DELAY_MS,
  useDelayedFlag,
} from '@canopy/ui-shared/lib';
import { HOSTED_SETTINGS_PAGES } from './registry';

/** What a hosted settings route shows right now. */
export type StalePageView =
  | {
      readonly status: 'page';
      /** The route whose page shows: the current one, or the held one. */
      readonly route: SettingsRoute;
      readonly data: SettingsPageData;
      readonly revision: number;
      /** The previous page, kept in place while the current one loads. */
      readonly held: boolean;
    }
  | {
      readonly status: 'loading';
      /**
       * The previous page was held for the whole loading delay, so the
       * loading state shows at once rather than waiting the delay again.
       */
      readonly waited: boolean;
    }
  | { readonly status: 'error'; readonly error: SettingsErrorPayload };

interface ShownPage {
  readonly key: string;
  readonly route: SettingsRoute;
  readonly data: SettingsPageData;
  readonly revision: number;
  /** The store (account and session) the page came from. */
  readonly store: SettingsStore;
  /** The store's refresh generation when this data first showed. */
  readonly generation: number;
}

/**
 * Pages hold only within one scope: one organization, or the account pages.
 * Another organization's (or the account's) page never shows under a route
 * it does not belong to.
 */
function holdScope(route: SettingsRoute): string {
  switch (route.scope) {
    case 'account':
      return 'account';
    case 'organizations':
      return 'organizations';
    case 'organization':
      return `organization:${route.organizationId}`;
  }
}

/**
 * Whether a page's chunk is ready to render. A chunk that has not loaded is
 * loaded here; once that settles (a failure included, which the page's error
 * boundary then reports) the page renders.
 */
function usePageChunkReady(kind: SettingsPageDataKind | null): boolean {
  const [settled, setSettled] = useState<SettingsPageDataKind | null>(null);
  const loaded = kind === null || HOSTED_SETTINGS_PAGES[kind].isLoaded();
  useEffect(() => {
    if (kind === null || HOSTED_SETTINGS_PAGES[kind].isLoaded())
      return undefined;
    let cancelled = false;
    const settle = (): void => {
      if (!cancelled) setSettled(kind);
    };
    HOSTED_SETTINGS_PAGES[kind].preload().then(settle, settle);
    return (): void => {
      cancelled = true;
    };
  }, [kind]);
  return loaded || settled === kind;
}

/**
 * Keeps the previous page on screen, inert, while the next route of the same
 * scope loads, for at most {@link LOADING_PLACEHOLDER_DELAY_MS}; then the
 * loading state shows. A route that is ready inside that window replaces the
 * previous page in one step, so a quick switch never shows a placeholder.
 *
 * A route counts as ready when its data and its page chunk are both there.
 * Nothing is held across scopes, after an error, after a refresh, or across
 * accounts and Settings sessions (each has its own store).
 */
export function useStalePage(
  route: SettingsRoute,
  entry: SettingsPageEntry,
): StalePageView {
  const store = useSettingsStoreApi();
  const generation = useSettingsStore((state) => state.refreshGeneration);
  const key = settingsRouteKey(route);
  const data = entry.data;
  const chunkReady = usePageChunkReady(data?.kind ?? null);
  const ready = data !== null && chunkReady;
  const error = data === null && entry.status === 'error' ? entry.error : null;

  // The last page that showed, adjusted during render rather than in an
  // effect so the hold never lags a render behind. A refresh does not
  // re-record the page on screen: until its fresh data arrives, it keeps the
  // generation it showed under and is not held.
  const [shown, setShown] = useState<ShownPage | null>(null);
  if (
    ready &&
    (shown === null ||
      shown.key !== key ||
      shown.data !== data ||
      shown.revision !== entry.revision ||
      shown.store !== store)
  )
    setShown({ key, route, data, revision: entry.revision, store, generation });
  if (error !== null && shown !== null) setShown(null);

  const held =
    !ready &&
    error === null &&
    shown !== null &&
    shown.key !== key &&
    shown.store === store &&
    shown.generation === generation &&
    holdScope(shown.route) === holdScope(route)
      ? shown
      : null;
  const holdExpired = useDelayedFlag(
    held !== null,
    LOADING_PLACEHOLDER_DELAY_MS,
  );

  if (ready)
    return {
      status: 'page',
      route,
      data,
      revision: entry.revision,
      held: false,
    };
  if (error !== null) return { status: 'error', error };
  if (held !== null && !holdExpired)
    return {
      status: 'page',
      route: held.route,
      data: held.data,
      revision: held.revision,
      held: true,
    };
  return { status: 'loading', waited: held !== null };
}
