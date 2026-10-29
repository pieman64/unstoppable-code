import type { OrgProjectSetupProgress } from '@canopy/protocol/org-projects';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { OrgProjectLocalStatus } from '@canopy/ui-app/settings/organization/organization-settings-slots';

// Where each organization project stands on this computer. The Add project
// dialog and the organization Projects page both read it, so "Added" there
// and "Ready" here cannot disagree.

export const ORG_PROJECT_SETTING_UP_MESSAGE = 'Setting up the project';
export const ORG_PROJECT_SETUP_FAILED_MESSAGE = 'Project setup failed';

export interface OrgProjectLocalStateInputs {
  readonly organizationId: string;
  /** The sidebar's projects; org-owned ones are checked out here. */
  readonly localProjects: readonly Pick<SidebarItem, 'owner'>[];
  /** Projects a Personal checkout here is linked to, once answered for this organization. */
  readonly linkedProjectIds: readonly string[];
  /** Projects a fresh check found linked before the sidebar caught up. */
  readonly linkedAfterListing?: readonly string[];
  readonly setupProgress: Readonly<Record<string, OrgProjectSetupProgress>>;
}

/**
 * Statuses by project id; an absent id is `not-set-up`. Setup in progress
 * wins, then a failed setup, then a checkout or link here. A cancelled or
 * finished setup says nothing on its own: the sidebar decides.
 */
export function deriveOrgProjectLocalStatuses({
  organizationId,
  localProjects,
  linkedProjectIds,
  linkedAfterListing = [],
  setupProgress,
}: OrgProjectLocalStateInputs): Map<string, OrgProjectLocalStatus> {
  const statuses = new Map<string, OrgProjectLocalStatus>();
  const ready: OrgProjectLocalStatus = { state: 'ready' };
  for (const local of localProjects) {
    if (local.owner?.organizationId === organizationId)
      statuses.set(local.owner.projectId, ready);
  }
  for (const projectId of [...linkedProjectIds, ...linkedAfterListing])
    statuses.set(projectId, ready);
  for (const progress of Object.values(setupProgress)) {
    if (progress.state === 'claiming' || progress.state === 'materializing')
      statuses.set(progress.projectId, {
        state: 'setting-up',
        message: progress.message ?? ORG_PROJECT_SETTING_UP_MESSAGE,
      });
    else if (progress.state === 'failed')
      statuses.set(progress.projectId, {
        state: 'failed',
        message: progress.message ?? ORG_PROJECT_SETUP_FAILED_MESSAGE,
      });
  }
  return statuses;
}
