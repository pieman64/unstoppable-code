import { useCallback, useEffect, useRef } from 'react';
import type {
  SharedContainerBlockedReason,
  SharedContainerEligibilityResponse,
  SharedContainerInviteAudience,
} from '@canopy/desktop-shared/types';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import {
  hydrateSharedContainersAccount,
  useSharedContainersStore,
} from '@/stores/sharedContainersStore';
import { CLOUD_ACCOUNT_NAME, TITLE, containerNoun } from './shareCopy';
import type { ShareRequestScope } from './shareRequestScope';

export interface UseShareEligibilityOptions {
  projectId: string;
  worktreeId: string;
  /** Selected organization, or `''` when the account has none to pick. */
  organizationId: string;
  /** An empty selection while eligible organizations are available is a form state, not a refusal. */
  organizationPickRequired: boolean;
  audience: SharedContainerInviteAudience;
  containerType: SharedContainerType;
  newInvitesEnabled: boolean;
  /**
   * External (email) sharing is on. An account with no organization can then
   * still share Public, so the probe runs instead of refusing locally.
   */
  externalSharingEnabled: boolean;
  scope: ShareRequestScope;
  eligibility: SharedContainerEligibilityResponse | null;
  setEligibility: (
    eligibility: SharedContainerEligibilityResponse | null,
  ) => void;
  setEligibilityLoading: (loading: boolean) => void;
  onManageExistingOnly: () => void;
}

export interface UseShareEligibilityResult {
  blockedReason: SharedContainerBlockedReason | undefined;
  blockedOrgNames: string[];
  /** True when the account read itself failed and cannot answer either way. */
  accountReadUnavailable: boolean;
  retryAccountRead: () => void;
  /**
   * Re-run the eligibility probe now.
   *
   * Exposed so a repair performed from inside the modal - pushing the branch
   * to GitHub - can continue the flow in place instead of leaving the user to
   * close and reopen Share. Bumping the request id invalidates any probe still
   * in flight, so the newest answer always wins.
   */
  refreshEligibility: () => void;
  /**
   * Drop every probe in flight, synchronously. Called at the click that
   * changes the selected organization, before React re-keys the probe.
   */
  invalidateEligibility: () => void;
}

/**
 * Owns the eligibility probe and everything derived from it.
 *
 * The probe fails open in both directions on purpose: a probe error resolves
 * to `eligible: true` so the user can try and let the real POST produce the
 * real refusal, and a degraded account read is reported as inconclusive rather
 * than as a lockout.
 */
export function useShareEligibility({
  projectId,
  worktreeId,
  organizationId,
  organizationPickRequired,
  audience,
  containerType,
  newInvitesEnabled,
  externalSharingEnabled,
  scope,
  eligibility,
  setEligibility,
  setEligibilityLoading,
  onManageExistingOnly,
}: UseShareEligibilityOptions): UseShareEligibilityResult {
  const accountKind = useSharedContainersStore((s) => s.accountKind);
  const accountHydrationFailed = useSharedContainersStore(
    (s) => s.accountHydrationFailed,
  );
  const requestConnect = useCloudConnectGateStore((s) => s.requestConnect);

  const eligibilityRequestRef = useRef(0);
  const initialAccountRetryRef = useRef(false);

  const blockedReason = eligibility?.eligible ? undefined : eligibility?.reason;
  const blockedOrgNames = eligibility?.blockedByOrganizationNames ?? [];

  const runEligibility = useCallback((): void => {
    const requestId = ++eligibilityRequestRef.current;
    const requestOrganizationId = organizationId;
    if (!newInvitesEnabled) {
      setEligibilityLoading(false);
      setEligibility(null);
      onManageExistingOnly();
      return;
    }
    if (organizationPickRequired) {
      setEligibilityLoading(false);
      setEligibility(null);
      return;
    }
    // Staleness is this probe's own business: the modal's request scope is
    // keyed by the container's owner, which this probe is what decides.
    const isStale = (): boolean =>
      scope.cancelledRef.current || eligibilityRequestRef.current !== requestId;
    if (
      !organizationId &&
      !(externalSharingEnabled && accountKind === 'connected')
    ) {
      if (accountKind === 'unknown') {
        setEligibilityLoading(false);
        setEligibility(null);
        return;
      }
      setEligibilityLoading(false);
      setEligibility({
        eligible: false,
        reason:
          accountKind === 'guest'
            ? 'guest-account'
            : accountKind === 'disconnected'
              ? 'no-cloud-account'
              : 'no-organization',
      });
      return;
    }
    setEligibilityLoading(true);
    void (async (): Promise<void> => {
      try {
        const response = await window.api.sharedContainers.checkEligibility({
          projectId,
          worktreeId,
          ...(requestOrganizationId
            ? { organizationId: requestOrganizationId }
            : {}),
          audience,
          containerType,
        });
        if (isStale()) return;
        setEligibility(response);
      } catch {
        // Fail open: a probe failure must never invent a lockout. Let the user
        // try, and let the real POST produce the real refusal.
        if (isStale()) return;
        setEligibility({ eligible: true });
      } finally {
        if (!isStale()) {
          setEligibilityLoading(false);
        }
      }
    })();
  }, [
    projectId,
    worktreeId,
    organizationId,
    organizationPickRequired,
    audience,
    containerType,
    accountKind,
    newInvitesEnabled,
    externalSharingEnabled,
    scope,
    setEligibility,
    setEligibilityLoading,
    onManageExistingOnly,
  ]);

  useEffect(() => {
    runEligibility();
  }, [runEligibility]);

  // Startup can fail to read secure storage while the entry point remains
  // deliberately fail-open. Retry once when the user opens the modal, then
  // show an explicit retry surface if the read is still inconclusive.
  useEffect(() => {
    if (
      accountKind !== 'unknown' ||
      !accountHydrationFailed ||
      initialAccountRetryRef.current
    ) {
      return;
    }
    initialAccountRetryRef.current = true;
    hydrateSharedContainersAccount({ refreshAfterCurrent: true });
  }, [accountHydrationFailed, accountKind]);

  // Live re-read: connecting an account (or switching one) from inside the
  // modal has to re-answer the whole eligibility question, not just the
  // account-present part.
  useEffect(() => {
    const onAccountChanged = (): void => {
      hydrateSharedContainersAccount({ refreshAfterCurrent: true });
    };
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    return (): void => {
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        onAccountChanged,
      );
    };
  }, []);

  // Guest and disconnected accounts route to the single app-level connect gate
  // rather than rendering a second sign-in surface here.
  useEffect(() => {
    if (
      !newInvitesEnabled ||
      (blockedReason !== 'no-cloud-account' &&
        blockedReason !== 'guest-account')
    ) {
      return;
    }
    requestConnect(
      {
        title: TITLE,
        subtitle: null,
        description: `Connect a ${CLOUD_ACCOUNT_NAME} account to invite a teammate to this ${containerNoun()}.`,
        guestBenefits: blockedReason === 'guest-account',
      },
      // Re-answer the whole eligibility question once connected; the account
      // that just landed may still be org-less or sync-disabled.
      () => hydrateSharedContainersAccount({ refreshAfterCurrent: true }),
    );
  }, [blockedReason, requestConnect, containerType, newInvitesEnabled]);

  const retryAccountRead = useCallback((): void => {
    hydrateSharedContainersAccount({ refreshAfterCurrent: true });
  }, []);

  const invalidateEligibility = useCallback((): void => {
    eligibilityRequestRef.current += 1;
  }, []);

  return {
    blockedReason,
    blockedOrgNames,
    accountReadUnavailable: accountKind === 'unknown' && accountHydrationFailed,
    retryAccountRead,
    refreshEligibility: runEligibility,
    invalidateEligibility,
  };
}
