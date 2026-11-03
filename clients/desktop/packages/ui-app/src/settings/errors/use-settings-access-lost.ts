'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useSettingsRouter } from '../host/settings-host';
import {
  findKnownSettingsError,
  isSettingsAccessLost,
  type KnownSettingsError,
  type SettingsFailure,
} from './settings-error-copy';
import { useSettingsErrorCopy } from './use-settings-error-copy';

/**
 * The access-lost path for organization routes. The returned callback reports
 * whether a failure means the viewer lost the session or access (401/403) and,
 * the first time it does in this mount, calls `useSettingsRouter().refresh()`
 * so the host re-reads the bootstrap and shows its access-lost notice
 * (desktop returns to Organizations; web re-renders the protected route).
 *
 * It refreshes at most once per mount, so a read that keeps answering 403
 * while the bootstrap still grants the page cannot refresh in a loop. The
 * callback is stable across renders, so load effects can list it.
 */
export function useSettingsAccessLostRefresh(): (error: unknown) => boolean {
  const router = useSettingsRouter();
  // Hosts may return a new router object per render; read it through a ref so
  // the returned callback stays stable.
  const routerRef = useRef(router);
  const refreshedRef = useRef(false);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  return useCallback((error: unknown): boolean => {
    if (!isSettingsAccessLost(error)) return false;
    if (!refreshedRef.current) {
      refreshedRef.current = true;
      routerRef.current.refresh();
    }
    return true;
  }, []);
}

/**
 * A failed load for a section on an organization route: logs the failure and
 * returns its load copy with the raw reason beside it, like
 * `useSettingsErrorCopy(scope).loadFailure`. A 401/403 that matches none of
 * the `known` cases also goes through {@link useSettingsAccessLostRefresh}.
 * The copy stays as the fallback for a refresh that keeps the page, such as a
 * role change that still allows it.
 *
 * A known case wins over the refresh: a 403 the section has its own copy for
 * (a plan gate, a role that can't see usage) is a page state, not lost access.
 */
export function useSettingsLoadFailure(
  scope: string,
): (error: unknown, known?: readonly KnownSettingsError[]) => SettingsFailure {
  const errorCopy = useSettingsErrorCopy(scope);
  const refreshOnAccessLost = useSettingsAccessLostRefresh();
  return useCallback(
    (
      error: unknown,
      known?: readonly KnownSettingsError[],
    ): SettingsFailure => {
      const failure = errorCopy.loadFailure(error, known);
      if (findKnownSettingsError(error, known) === undefined)
        refreshOnAccessLost(error);
      return failure;
    },
    [errorCopy, refreshOnAccessLost],
  );
}
