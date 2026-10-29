import type {
  SharedContainerAcceptedIdentity,
  SharedContainerAccess,
} from '@canopy/desktop-shared/types';
import {
  PERSONAL_WORKSPACE_CONTEXT,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';

/**
 * How the latest listing round (or an open viewer, which carries the same two
 * fields) classifies a share. This is the server-derived access path. It can
 * change from one round to the next: when an organization's listing rejects
 * while the organization-free listing still returns the container, the round
 * classifies an organization share as `direct`.
 */
export interface SharedContainerListingIdentity {
  readonly access?: SharedContainerAccess;
  readonly organizationId?: string;
}

/**
 * The workspace context that lists a share: its home. Navigation only; the
 * access path sent to main for open, retry, dismiss and fork is unaffected.
 *
 * An accepted share is anchored to the device-local acceptance record, so it
 * stays in the context it was accepted in however a later round classifies
 * it. An invitation has no record and follows the listing.
 *
 * `organizations` is the account's current memberships, or `undefined` while
 * they have not loaded. Not loaded is not the same as none: a record is
 * trusted until memberships say otherwise, so a share does not move to
 * Personal during startup. An organization the account has left no longer
 * anchors the share, which then follows the listing again.
 *
 * `null` means no context lists the share: a non-direct row with no
 * organization.
 */
export function sharedContainerHomeContext(
  listed: SharedContainerListingIdentity,
  record: SharedContainerAcceptedIdentity | undefined,
  organizations: readonly { readonly id: string }[] | undefined,
): WorkspaceContext | null {
  if (record !== undefined) {
    const recordedOrganizationId = record.organizationId;
    if (record.access === 'direct' || !recordedOrganizationId) {
      return PERSONAL_WORKSPACE_CONTEXT;
    }
    if (organizations === undefined) {
      return { kind: 'organization', organizationId: recordedOrganizationId };
    }
    const membership = organizations.find(
      (organization) =>
        organization.id.toLowerCase() === recordedOrganizationId.toLowerCase(),
    );
    if (membership !== undefined) {
      // The membership's id, so the result shares a namespace with the active
      // context it is compared against and switched to.
      return { kind: 'organization', organizationId: membership.id };
    }
  }
  if (listed.access === 'direct') {
    return PERSONAL_WORKSPACE_CONTEXT;
  }
  return listed.organizationId
    ? { kind: 'organization', organizationId: listed.organizationId }
    : null;
}
