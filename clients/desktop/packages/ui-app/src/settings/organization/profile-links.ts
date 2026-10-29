/**
 * Canonical link builder for the org-scoped member profile route. Centralizing
 * it keeps every discovery surface (members list, feed actor bylines, the
 * Statistics People table) pointed at the same path shape.
 *
 * `userExternalId` is the subject's `User.externalId` UUID — the same value
 * carried by `OrganizationMember.id`, feed `actor.userId`, and the usage
 * `byUser[].userId` rows.
 */
export function memberProfileHref(
  orgId: string,
  userExternalId: string,
): string {
  return `/organization/${encodeURIComponent(orgId)}/members/${encodeURIComponent(
    userExternalId,
  )}`;
}
