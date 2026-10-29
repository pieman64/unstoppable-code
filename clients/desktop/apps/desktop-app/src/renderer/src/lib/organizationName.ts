/**
 * Display name of the organization with `organizationId` (matched
 * case-insensitively), or `null` when it is not listed or has a blank name.
 */
export function findOrganizationName(
  organizations: readonly { id: string; name: string }[] | undefined,
  organizationId: string,
): string | null {
  const target = organizationId.toLowerCase();
  const name = organizations
    ?.find((candidate) => candidate.id.toLowerCase() === target)
    ?.name.trim();
  return name ? name : null;
}
