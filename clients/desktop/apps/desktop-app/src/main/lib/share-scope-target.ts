export interface ShareScopeTarget {
  shareScope?: 'private' | 'team' | 'organization';
  teamId?: string;
  organizationId?: string;
}

/** Reject scoped shares that would otherwise silently drop their target id. */
export function assertShareScopeTarget(
  target: ShareScopeTarget,
  noun: string,
): void {
  if (target.shareScope === 'team' && !target.teamId) {
    throw new Error(`Cannot share ${noun} to team scope without a teamId.`);
  }
  if (target.shareScope === 'organization' && !target.organizationId) {
    throw new Error(
      `Cannot share ${noun} to organization scope without an organizationId.`,
    );
  }
}
