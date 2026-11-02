import type { IncomingTeamInvitation } from '@canopy/protocol/settings/organization';

interface ListedOrganization {
  readonly id: string;
  readonly name: string;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The membership an accepted invitation joined, once refreshed memberships
 * list it, or `null` while it cannot be told apart (CAN-3672).
 *
 * An invitation that carries its `organizationId` resolves only to that
 * organization: anything else in `after` is someone else's change. An older
 * server's invitation names its organization only, so it resolves to the one
 * membership added since `before` (the snapshot taken just before the write)
 * with that name. No candidate, or two same-named ones, stays unresolved:
 * names cannot prove identity, and selecting the wrong organization is worse
 * than not selecting one.
 */
export function resolveJoinedOrganization<T extends ListedOrganization>({
  invite,
  before,
  after,
}: {
  readonly invite: Pick<
    IncomingTeamInvitation,
    'organizationId' | 'organizationName'
  >;
  readonly before: readonly ListedOrganization[];
  readonly after: readonly T[];
}): T | null {
  if (invite.organizationId !== undefined) {
    const wanted = normalized(invite.organizationId);
    return after.find((org) => normalized(org.id) === wanted) ?? null;
  }
  const known = new Set(before.map((org) => normalized(org.id)));
  const name = normalized(invite.organizationName);
  const candidates = after.filter(
    (org) => !known.has(normalized(org.id)) && normalized(org.name) === name,
  );
  const [only] = candidates;
  return candidates.length === 1 && only !== undefined ? only : null;
}
