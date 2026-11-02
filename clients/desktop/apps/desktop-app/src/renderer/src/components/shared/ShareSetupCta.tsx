import { type JSX } from 'react';
import type { SharedContainerBlockedReason } from '@canopy/desktop-shared/types';
import { formatOrgNameList } from '@canopy/ui-shared/lib/org-lapse-sentence';
import { brandText } from '@/lib/brand';
import { DesktopDataSharingOptIn } from '@/components/settings/DesktopDataSharingOptIn';
import { useNavigationStore } from '@/stores/navigationStore';
import { Button } from '@/components/shared/Button';

export interface ShareSetupCtaProps {
  reason: Extract<
    SharedContainerBlockedReason,
    'sync-disabled' | 'sync-blocked-by-org'
  >;
  blockedByOrganizationNames?: string[];
  /**
   * Organization that owns the work being shared, as eligibility evaluated it
   * (the picked organization only when external sharing is off, where every
   * share is organization-owned). `null` is personal work, which offers the
   * personal ("Just me") opt-in and keeps the Privacy settings recovery as its
   * fallback.
   */
  organizationId?: string | null;
  /** Re-asks eligibility after sharing was turned on in place. */
  onSharingEnabled?: () => void;
  onNavigate?: () => void;
}

const OPEN_SETTINGS_LABEL = 'Open privacy settings';
const CLOUD_ACCOUNT_NAME = `${brandText.appName} Cloud`;

/**
 * The two data-sharing refusals an owner can act on.
 *
 * They are separate states with separate copy on purpose. `sync-disabled` is
 * the user's own choice and they can undo it in one click, so it gets a
 * deep-link. `sync-blocked-by-org` is an admin-enforced prohibition no local
 * setting can clear, so promising a settings fix there would be false — it
 * names the orgs and stops.
 */
export function ShareSetupCta({
  reason,
  blockedByOrganizationNames,
  organizationId = null,
  onSharingEnabled,
  onNavigate,
}: ShareSetupCtaProps): JSX.Element {
  const orgNames = formatOrgNameList(blockedByOrganizationNames ?? []);

  if (reason === 'sync-blocked-by-org') {
    return (
      <div className="space-y-2" data-testid="shared-container-setup-cta">
        <p className="text-s font-medium fg-primary">
          Your organization has turned off project data sharing
        </p>
        <p className="text-xs fg-secondary">
          {orgNames
            ? `${orgNames} prohibits sharing project data with ${CLOUD_ACCOUNT_NAME}, so this project cannot be shared with a teammate. An organization admin can change that policy.`
            : `Your organization prohibits sharing project data with ${CLOUD_ACCOUNT_NAME}, so this project cannot be shared with a teammate. An organization admin can change that policy.`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="shared-container-setup-cta">
      <p className="text-s font-medium fg-primary">
        Turn on project data sharing to invite a teammate
      </p>
      {/* The invite is blocked, so this recovery is never dismissible. */}
      <DesktopDataSharingOptIn
        feature="shared-projects"
        organizationId={organizationId}
        dismissible={false}
        onEnabled={onSharingEnabled}
        fallback={
          <>
            <p className="text-xs fg-secondary">
              {`Inviting a teammate needs this project to be registered with ${CLOUD_ACCOUNT_NAME}. Turn project data sharing on and the invite becomes available, and you can keep transcripts, plans, and summaries off.`}
            </p>
            <Button
              variant="secondary"
              size="compact"
              data-testid="shared-container-setup-cta-open-settings"
              onClick={() => {
                useNavigationStore.getState().openSettings('privacy');
                onNavigate?.();
              }}
            >
              {OPEN_SETTINGS_LABEL}
            </Button>
          </>
        }
      />
    </div>
  );
}
