import type { JSX } from 'react';
import type { OrganizationPromotionDialogProps } from '@canopy/ui-app/settings/organization/organization-settings-slots';
import { useSettingsRouter } from '@canopy/ui-app/settings/host';
import { DesktopCreateTeamDialog } from '../../sidebar/DesktopCreateTeamDialog';

/**
 * The desktop promotion controller for the shared organization pages: the
 * Personal header's invite opens the same Create a team flow the sidebar
 * uses, over main's upgrade orchestration. A committed promotion re-reads
 * the hosted page, as web refreshes its route.
 */
export function DesktopSettingsPromotionDialog({
  accountKey,
  personalOrganizationId,
  inviteRequired = false,
  onClose,
}: OrganizationPromotionDialogProps): JSX.Element {
  const router = useSettingsRouter();
  return (
    <DesktopCreateTeamDialog
      accountId={accountKey}
      personalOrganizationId={personalOrganizationId}
      inviteRequired={inviteRequired}
      onPromoted={() => router.refresh()}
      onClose={onClose}
    />
  );
}
