import type { OrganizationRole } from './organization';

/**
 * Typed error for the team service layer. Mirrors `InviteServiceError`:
 * routes catch it and map `status`/`message` onto an HTTP response.
 *
 * Defined here (not in `team-service.ts`) so the pure permission helpers below
 * can throw it without creating a circular import back into the service.
 */
export class TeamServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'TeamServiceError';
  }
}

/**
 * Privilege ordering: higher rank = more authority. Used for "can this actor
 * act on that target" comparisons throughout the service.
 */
export function roleRank(role: OrganizationRole): number {
  switch (role) {
    case 'OWNER':
      return 3;
    case 'ADMIN':
      return 2;
    case 'MEMBER':
      return 1;
  }
}

/** Edit org name. OWNER + ADMIN. */
export function canEditOrg(role: OrganizationRole): boolean {
  return roleRank(role) >= roleRank('ADMIN');
}

/** Create / rename / delete sub-teams and manage their membership. OWNER + ADMIN. */
export function canManageSubTeams(role: OrganizationRole): boolean {
  return roleRank(role) >= roleRank('ADMIN');
}

/** Manage organization project definitions and access. OWNER + ADMIN. */
export function canManageProjects(role: OrganizationRole): boolean {
  return roleRank(role) >= roleRank('ADMIN');
}

/** Invite members / add existing by email. OWNER + ADMIN. */
export function canManageMembers(role: OrganizationRole): boolean {
  return roleRank(role) >= roleRank('ADMIN');
}

/**
 * View the team usage & cost dashboard. The threshold is org-configurable
 * (`OrganizationConfig.usageStatsMinRole`, default `ADMIN`); a viewer qualifies
 * when their rank meets or exceeds the configured minimum.
 */
export function canViewUsageStats(
  viewerRole: OrganizationRole,
  minRole: OrganizationRole,
): boolean {
  return roleRank(viewerRole) >= roleRank(minRole);
}

/** Edit the org usage-stats configuration. OWNER + ADMIN (same as org edit). */
export function canEditUsageStatsConfig(role: OrganizationRole): boolean {
  return canEditOrg(role);
}

/** Edit org-enforced member settings (e.g. required telemetry sync). OWNER + ADMIN. */
export function canEditOrgEnforcedSettings(role: OrganizationRole): boolean {
  return canEditOrg(role);
}

/** Edit per-member organization-memory participation. OWNER + ADMIN. */
export function canEditMemorySettings(role: OrganizationRole): boolean {
  return canEditOrg(role);
}

/**
 * Change a member's role / assign-transfer OWNER. OWNER only — admins cannot
 * grant or revoke roles. The target role must not exceed the actor's own rank
 * (always true for an OWNER actor, but kept explicit for safety).
 */
export function canAssignRole(
  actorRole: OrganizationRole,
  targetRole: OrganizationRole,
): boolean {
  return actorRole === 'OWNER' && roleRank(targetRole) <= roleRank(actorRole);
}

/**
 * Remove a member. The actor must be able to manage members and outrank the
 * target. This yields: ADMIN can remove MEMBER only; OWNER can remove ADMIN and
 * MEMBER; nobody can remove an OWNER via this path (demote/transfer first).
 */
export function canRemoveMember(
  actorRole: OrganizationRole,
  targetRole: OrganizationRole,
): boolean {
  return (
    canManageMembers(actorRole) && roleRank(actorRole) > roleRank(targetRole)
  );
}

/**
 * Guard the invariant that an org always retains at least one OWNER. Throws
 * `TeamServiceError(409)` when the operation would remove, demote, or let leave
 * the final remaining owner.
 */
export function assertNotLastOwner(params: {
  targetIsOwner: boolean;
  ownerCount: number;
}): void {
  if (params.targetIsOwner && params.ownerCount <= 1) {
    throw new TeamServiceError(
      409,
      'An organization must always have at least one owner',
    );
  }
}
