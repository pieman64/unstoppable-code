import type { SharedContainerAccess } from '@canopy/desktop-shared/types';

/**
 * Internal map key for a personal (user-owned) shared container.
 *
 * Several main-process maps are keyed by the owning organization id: the
 * publication-state file, the telemetry sync-map's shared-container anchors,
 * and the publish scheduler's in-flight keys. A personal container has no
 * organization, so it takes this key instead. It is deliberately not a UUID,
 * so it can never collide with a real organization id, and it never crosses
 * the wire: callers translate it back to an absent `organizationId`.
 */
export const PERSONAL_SHARED_CONTAINER_OWNER_KEY = 'personal';

/** Map key for an owning organization, or the personal key when absent. */
export function sharedContainerOwnerKey(
  organizationId: string | undefined,
): string {
  return organizationId ?? PERSONAL_SHARED_CONTAINER_OWNER_KEY;
}

/** Inverse of {@link sharedContainerOwnerKey}. */
export function organizationIdFromSharedContainerOwnerKey(
  key: string,
): string | undefined {
  return key === PERSONAL_SHARED_CONTAINER_OWNER_KEY ? undefined : key;
}

/**
 * Recipient-side listing scope for direct shares (grants made by email or
 * from outside the recipient's organizations). Organization listings keep
 * their organization id as the scope, so organization behavior is unchanged;
 * direct shares are one cross-organization listing with this key. Like the
 * owner key it is not a UUID and never reaches the server.
 */
export const DIRECT_SHARED_CONTAINER_SCOPE_KEY = 'direct';

/**
 * How a recipient reached a container. Absent `access` is the legacy
 * (pre-external-sharing) record shape and always means organization access,
 * except that a record with no organization at all can only be direct.
 */
export function resolveSharedContainerAccess(
  organizationId: string | undefined,
  access: SharedContainerAccess | undefined,
): SharedContainerAccess {
  if (access === 'direct' || access === 'organization') return access;
  return organizationId === undefined ? 'direct' : 'organization';
}

/**
 * The listing scope a recipient replica belongs to: its organization for
 * organization access, {@link DIRECT_SHARED_CONTAINER_SCOPE_KEY} for direct
 * access. An organization listing therefore never reconciles a direct share,
 * and the direct listing never reconciles an organization share.
 */
export function sharedContainerRecipientScopeKey(
  organizationId: string | undefined,
  access: SharedContainerAccess | undefined,
): string {
  const resolved = resolveSharedContainerAccess(organizationId, access);
  return resolved === 'direct' || organizationId === undefined
    ? DIRECT_SHARED_CONTAINER_SCOPE_KEY
    : organizationId;
}
