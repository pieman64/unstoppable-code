import { useCallback, useEffect, useRef, useState } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { IncomingTeamInvitation } from '@canopy/protocol/settings/organization';
import type { WorkspaceContextOrganization } from '@canopy/protocol/workspace-context';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import {
  ACCEPTED_FOLLOW_UP_FALLBACK_COPY,
  resolveJoinedOrganization,
  usePendingOrganizationInvitations,
  type AcceptedInvitationFollowUp,
  type SidebarContextInvitations,
} from '@canopy/ui-app';
import { useHostedSettingsClient } from '@/components/settings/hosted/hosted-settings-availability';
import { refreshAndAnnounceCanopyCloudAccount } from '@/lib/canopyCloudAccountChange';
import { openSettingsPathOrWeb } from '@/lib/navigation/settings-destinations';
import { selectOrganizationWhenListed } from '@/lib/selectOrganizationWhenListed';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/** How long an accepted invitation waits for main to list its membership. */
const MEMBERSHIP_TIMEOUT_MS = 15_000;

function currentMemberships(): readonly WorkspaceContextOrganization[] {
  return useWorkspaceContextStore.getState().state.organizations;
}

/**
 * The joined membership once main lists it, or `null` on timeout or abort.
 * An invitation without an organization id resolves only to the one
 * same-named membership added since `before`.
 */
function waitForJoinedMembership(
  invitation: IncomingTeamInvitation,
  before: readonly WorkspaceContextOrganization[],
  signal: AbortSignal,
): Promise<WorkspaceContextOrganization | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = (): void => {};
    const finish = (value: WorkspaceContextOrganization | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      unsubscribe();
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = (): void => finish(null);
    const check = (): void => {
      const { hydrated, state } = useWorkspaceContextStore.getState();
      if (!hydrated) return;
      const joined = resolveJoinedOrganization({
        invite: invitation,
        before,
        after: state.organizations,
      });
      if (joined !== null) finish(joined);
    };
    const timeoutId = setTimeout(abort, MEMBERSHIP_TIMEOUT_MS);
    signal.addEventListener('abort', abort);
    unsubscribe = useWorkspaceContextStore.subscribe(check);
    if (signal.aborted) abort();
    else check();
  });
}

function selectJoined(
  organizationId: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    selectOrganizationWhenListed(organizationId, resolve, signal);
  });
}

/**
 * Re-reads main's account, waits for the joined membership, selects it, and
 * only then opens its Projects inside Settings (or on the web without hosted
 * settings), so the page never opens on an organization main has not listed.
 */
async function openJoinedOrganization(
  { invitation, before, signal }: AcceptedInvitationFollowUp,
  onSelecting: (organizationId: string) => void,
): Promise<string | null> {
  await refreshAndAnnounceCanopyCloudAccount().catch(() => undefined);
  if (signal.aborted) return null;
  const joined = await waitForJoinedMembership(invitation, before, signal);
  if (signal.aborted) return null;
  if (joined === null) return ACCEPTED_FOLLOW_UP_FALLBACK_COPY;
  onSelecting(joined.id);
  const selected = await selectJoined(joined.id, signal);
  if (signal.aborted) return null;
  if (!selected) return ACCEPTED_FOLLOW_UP_FALLBACK_COPY;
  const { context } = useWorkspaceContextStore.getState().state;
  // A newer choice in the switcher wins over this destination.
  if (context.kind !== 'organization' || context.organizationId !== joined.id)
    return null;
  openSettingsPathOrWeb(
    settingsRouteToPath({
      scope: 'organization',
      organizationId: joined.id,
      page: 'projects',
    }),
  );
  return null;
}

const openOrganizations = (): void => {
  openSettingsPathOrWeb(settingsRouteToPath({ scope: 'organizations' }));
};

/**
 * The desktop switcher's pending organization invitations (CAN-3672). Reads
 * only through the hosted settings client this window may use (rollout flag,
 * capability, a local window) and only for a signed-in, non-guest
 * `accountKey`. Completed account notifications, including same-account
 * refreshes, trigger list reads. Membership broadcasts drive the destination
 * observer above, so a broadcast followed by its refresh-complete event does
 * not issue two invitation reads.
 */
export function useDesktopPendingInvitations(
  accountKey: string | null,
): SidebarContextInvitations {
  const client = useHostedSettingsClient();
  const selecting = useRef<{
    readonly signal: AbortSignal;
    readonly organizationId: string;
  } | null>(null);
  const onAccepted = useCallback(
    async (followUp: AcceptedInvitationFollowUp): Promise<string | null> => {
      try {
        return await openJoinedOrganization(followUp, (id): void => {
          selecting.current = { signal: followUp.signal, organizationId: id };
        });
      } finally {
        if (selecting.current?.signal === followUp.signal)
          selecting.current = null;
      }
    },
    [],
  );
  const [refreshSignal, setRefreshSignal] = useState(0);
  const bump = useCallback((): void => {
    setRefreshSignal((value) => value + 1);
  }, []);
  useEffect(() => {
    if (client === null || accountKey === null) return undefined;
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, bump);
    return (): void => {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, bump);
    };
  }, [accountKey, bump, client]);
  const invitations = usePendingOrganizationInvitations({
    client,
    accountKey,
    refreshSignal,
    readMemberships: currentMemberships,
    onAccepted,
    onReview: openOrganizations,
    reconcileAccount: refreshAndAnnounceCanopyCloudAccount,
  });
  const cancelFollowUp = invitations.cancelFollowUp;
  useEffect(
    () =>
      useWorkspaceContextStore.subscribe((next, previous): void => {
        if (
          next.appliedGeneration === previous.appliedGeneration ||
          next.lastChangeReason !== 'switch'
        )
          return;
        const context = next.state.context;
        // A switch from another entry point (including the command palette) also
        // wins, even if it chose Personal again while acceptance was in flight.
        if (
          context.kind !== 'organization' ||
          context.organizationId !== selecting.current?.organizationId
        )
          cancelFollowUp?.();
      }),
    [cancelFollowUp],
  );
  return invitations;
}
