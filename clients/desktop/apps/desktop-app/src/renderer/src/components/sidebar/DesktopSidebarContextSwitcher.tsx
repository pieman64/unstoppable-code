import type { JSX, ReactNode } from 'react';
import { SidebarContextHeader } from '@canopy/ui-app/sidebar';
import {
  SidebarContextRow,
  resolveSidebarContextActions,
} from '@canopy/ui-app';
import {
  useDesktopWorkspaceContextSwitcher,
  type DesktopWorkspaceContextSwitcher,
  type DesktopWorkspaceContextAvailability,
} from '@/hooks/useDesktopWorkspaceContextSwitcher';
import { useOrgCreditPoolBalance } from '@/hooks/useOrgCreditPoolBalance';
import { useSubscriptionStatus } from '@/hooks/useSubscriptionStatus';
import { openSettingsPathOrWeb } from '@/lib/navigation/settings-destinations';
import { useDesktopTeamDialogs } from './useDesktopTeamDialogs';

/**
 * Feed, Statistics, the AI Credits pool and Organization settings open inside
 * Settings when hosted settings are openable here, otherwise on the web.
 */
const openSettingsPath = (path: string): void => {
  openSettingsPathOrWeb(path);
};

/**
 * The sidebar's top-of-rail Personal/organization switcher (CAN-4053): the
 * shared `SidebarContextRow` with the organization actions, as on the web
 * (`WebSidebarContextSwitcher`). Rendered only while the org-projects flag is
 * on and the account is signed in, not a guest, including an account with no
 * organizations (it then shows Personal); otherwise the top of the sidebar is
 * unchanged.
 */
export function DesktopSidebarContextSwitcher({
  availability,
  action,
}: {
  readonly availability: DesktopWorkspaceContextAvailability;
  readonly action?: ReactNode;
}): JSX.Element | null {
  const switcher = useDesktopWorkspaceContextSwitcher(availability);
  if (!switcher.available) return null;
  return <AvailableContextSwitcher switcher={switcher} action={action} />;
}

/**
 * The switcher's body, mounted separately so its billing and pool reads run
 * only while the switcher shows.
 */
function AvailableContextSwitcher({
  switcher,
  action,
}: {
  readonly action?: ReactNode;
  readonly switcher: DesktopWorkspaceContextSwitcher;
}): JSX.Element {
  const { account, authenticated } = switcher;
  const subscription = useSubscriptionStatus();
  const accountId = authenticated ? (account?.account?.id ?? null) : null;
  const personalOrganizationId = authenticated
    ? (account?.personalOrganizationId ?? null)
    : null;
  const freeAccess = authenticated && subscription.aiCreditsVisible;
  const teamDialogs = useDesktopTeamDialogs({
    accountId,
    personalOrganizationId,
  });
  // The same policy the menu renders from, so the pool read is for the pool
  // the row opens and no pool is read for anyone else.
  const { creditsOrganizationId } = resolveSidebarContextActions({
    context: switcher.context,
    organizations: switcher.organizations,
    authenticated,
    personalOrganizationId,
    freeAccess,
  });
  const pool = useOrgCreditPoolBalance(
    creditsOrganizationId === null
      ? { kind: 'personal' }
      : { kind: 'organization', organizationId: creditsOrganizationId },
    accountId,
  );

  return (
    <>
      <SidebarContextHeader testId="sidebar-top-context-row" action={action}>
        <SidebarContextRow
          context={switcher.context}
          organizations={switcher.organizations}
          disabled={switcher.switching}
          contextsWithUpdates={switcher.contextsWithUpdates}
          menuInstantInteractions
          onSelect={switcher.select}
          placement="top"
          orgScoped={{
            authenticated,
            personalOrganizationId,
            freeAccess,
            onOpenPath: openSettingsPath,
            onCreateTeam: teamDialogs.openCreateTeam,
            onInviteToTeam: teamDialogs.openInvite,
            ...(creditsOrganizationId === null
              ? {}
              : {
                  credits: {
                    organizationId: creditsOrganizationId,
                    balanceCredits: pool.balanceCredits,
                    refresh: pool.refresh,
                  },
                }),
          }}
        />
      </SidebarContextHeader>
      {teamDialogs.dialog}
    </>
  );
}
