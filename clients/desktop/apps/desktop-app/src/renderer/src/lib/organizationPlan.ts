import { organizationBillingPath } from '@canopy/protocol/billing';
import { orgsWithoutActivePlanClause } from '@canopy/ui-shared/lib/org-lapse-sentence';
import {
  openSettingsPathOrWeb,
  type SettingsOpenResult,
} from './navigation/settings-destinations';

/**
 * Copy and action for a selected organization with no active plan, shared by
 * the sidebar empty state and the Home composer notice so the same fact reads
 * the same way on both. Cause-neutral like every lapse surface: the desktop
 * cannot tell a trial that ended from an org that never subscribed.
 */
export const CHOOSE_ORG_PLAN_LABEL = 'Choose a plan';

/** "{Org} has no active plan" (no terminal punctuation). */
export function orgWithoutPlanTitle(organizationName: string): string {
  return orgsWithoutActivePlanClause([organizationName]);
}

/** For an owner, who can fix it from the organization's billing page. */
export const CHOOSE_ORG_PLAN_COPY =
  'Choose a plan to use projects and chats here.';

/** For an admin or member: only an owner can buy. */
export function askOwnerToChoosePlanCopy(organizationName: string): string {
  return `Ask an owner of ${organizationName} to choose a plan.`;
}

/**
 * Open the organization's own billing page: Settings → Billing in-app when
 * hosted settings are openable here, otherwise on the web, signed in.
 */
export function openOrganizationBillingPage(
  organizationId: string,
): SettingsOpenResult {
  return openSettingsPathOrWeb(organizationBillingPath(organizationId));
}
