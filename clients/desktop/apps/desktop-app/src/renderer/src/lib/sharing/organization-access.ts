import {
  buildShareOrganizationAccess,
  type ShareOrganizationAccess,
} from '@canopy/protocol/sharing';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';

/**
 * Advisory per-organization share access from the stored account, built by
 * the same helper the Portal uses. An account carrying neither memberships
 * nor billing states (older deployments) leaves access unknown.
 */
export function desktopOrganizationAccess(
  account: Pick<
    CanopyCloudAccountPublicState,
    'organizations' | 'orgBillingStates'
  >,
): ShareOrganizationAccess[] | undefined {
  if (
    account.organizations === undefined &&
    account.orgBillingStates === undefined
  ) {
    return undefined;
  }
  return buildShareOrganizationAccess(
    account.organizations ?? [],
    account.orgBillingStates ?? [],
  );
}
