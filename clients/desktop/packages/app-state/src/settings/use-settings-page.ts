'use client';

import { useEffect } from 'react';
import type { SettingsRoute } from '@canopy/protocol/settings';
import {
  selectSettingsBootstrap,
  settingsRouteKey,
  type SettingsBootstrapEntry,
  type SettingsPageEntry,
} from './create-settings-store';
import {
  useSettingsStore,
  useSettingsStoreApi,
} from './settings-store-context';

const IDLE_PAGE: SettingsPageEntry = {
  status: 'idle',
  data: null,
  error: null,
  revision: 0,
};

/**
 * A route's first-screen data from the shared store, loading it on mount and
 * whenever the route changes. Cached data stays visible during refetches.
 */
export function useSettingsPage(
  route: SettingsRoute | null,
): SettingsPageEntry {
  const store = useSettingsStoreApi();
  const key = route === null ? null : settingsRouteKey(route);
  const entry = useSettingsStore((state) =>
    key === null ? IDLE_PAGE : (state.pages[key] ?? IDLE_PAGE),
  );
  useEffect(() => {
    if (route === null) return;
    void store.getState().loadPage(route);
    // `key` is the canonical identity of `route`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key]);
  return entry;
}

/**
 * The bootstrap for an organization (or none), loading it on mount. Pass
 * `enabled: false` to read without fetching (for example while Settings is
 * closed).
 */
export function useSettingsBootstrap(
  organizationId: string | null,
  options: { enabled?: boolean } = {},
): SettingsBootstrapEntry {
  const { enabled = true } = options;
  const store = useSettingsStoreApi();
  const entry = useSettingsStore((state) =>
    selectSettingsBootstrap(state, organizationId),
  );
  useEffect(() => {
    if (!enabled) return;
    void store.getState().loadBootstrap(organizationId);
  }, [store, organizationId, enabled]);
  return entry;
}
