import { useEffect } from 'react';
import { create } from 'zustand';
import type { InlineFailure } from '@/lib/inline-app-error';
import { useNavigationStore } from '@/stores/navigationStore';
import type { HostedSettingsAccount } from './desktop-settings-host-context';
import {
  hostedSettingsRouteKey,
  type HostedSettingsLocation,
} from './hosted-settings-location';

/**
 * A failed host action on a hosted settings page (opening a link, signing
 * in), held as host state and shown by the shared page below its header
 * through `SettingsPageNoticeProvider`, instead of a toast.
 *
 * A failure belongs to the page and account it started on. It shows only
 * there, clears when the person moves to another page or account, and a
 * newer action replaces it. A response that arrives after the person moved
 * on, or after a newer action started, is dropped.
 */

/** Where a host action started: the page, and the account it acted for. */
export interface HostedSettingsFailureScope {
  readonly routeKey: string;
  /** `null` for an action that changes the account, such as signing in. */
  readonly accountId: string | null;
}

interface HostedSettingsHostFailure {
  readonly attempt: number;
  readonly scope: HostedSettingsFailureScope;
  readonly failure: InlineFailure;
}

interface HostedSettingsHostFailureState {
  readonly current: HostedSettingsHostFailure | null;
}

const useHostedSettingsHostFailureStore =
  create<HostedSettingsHostFailureState>(() => ({ current: null }));

let latestAttempt = 0;

/** The scope of an action starting now on `location`. */
export function hostedSettingsFailureScope(
  location: HostedSettingsLocation | null,
  account: HostedSettingsAccount | null,
): HostedSettingsFailureScope | null {
  if (location === null) return null;
  return {
    routeKey: hostedSettingsRouteKey(location.route),
    accountId: account?.status === 'signed_in' ? account.accountId : null,
  };
}

/** The scope of an action starting now on the page Settings shows. */
export function currentHostedSettingsFailureScope(
  account: HostedSettingsAccount | null,
): HostedSettingsFailureScope | null {
  return hostedSettingsFailureScope(
    useNavigationStore.getState().settingsHostedLocation,
    account,
  );
}

/**
 * Starts a host action. Its failure replaces any earlier one, which clears
 * now so a stale failure never sits beside the new attempt.
 */
export function beginHostedSettingsAction(): number {
  latestAttempt += 1;
  useHostedSettingsHostFailureStore.setState({ current: null });
  return latestAttempt;
}

/**
 * Shows `failure` for the action `attempt`, unless a newer action started or
 * Settings no longer shows the page the action started on.
 */
export function raiseHostedSettingsFailure(
  attempt: number,
  scope: HostedSettingsFailureScope | null,
  failure: InlineFailure,
): void {
  if (attempt !== latestAttempt || scope === null) return;
  const showing = useNavigationStore.getState().settingsHostedLocation;
  if (
    showing === null ||
    hostedSettingsRouteKey(showing.route) !== scope.routeKey
  )
    return;
  useHostedSettingsHostFailureStore.setState({
    current: { attempt, scope, failure },
  });
}

/** Clears the failure of `attempt` once it succeeded or was dismissed. */
export function clearHostedSettingsFailure(attempt?: number): void {
  const { current } = useHostedSettingsHostFailureStore.getState();
  if (current === null) return;
  if (attempt !== undefined && current.attempt !== attempt) return;
  useHostedSettingsHostFailureStore.setState({ current: null });
}

function belongsTo(
  failure: HostedSettingsHostFailure,
  routeKey: string,
  account: HostedSettingsAccount,
): boolean {
  if (failure.scope.routeKey !== routeKey) return false;
  if (failure.scope.accountId === null) return true;
  return (
    account.status === 'signed_in' &&
    account.accountId === failure.scope.accountId
  );
}

/**
 * The host failure for the page Settings shows, or `null`. A failure from
 * another page or account clears.
 */
export function useHostedSettingsHostFailure(
  location: HostedSettingsLocation,
  account: HostedSettingsAccount,
): InlineFailure | null {
  const current = useHostedSettingsHostFailureStore((state) => state.current);
  const routeKey = hostedSettingsRouteKey(location.route);
  const visible = current !== null && belongsTo(current, routeKey, account);
  useEffect(() => {
    if (current !== null && !visible)
      clearHostedSettingsFailure(current.attempt);
  }, [current, visible]);
  return visible ? current.failure : null;
}
