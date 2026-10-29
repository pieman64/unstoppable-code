import { writeWorkspaceApprovals } from '../../lib/approvals-persistence';
import { updatePreferencesFile } from '../../lib/preferences-store';

/**
 * Writes empty approval rule tiers for these workspaces and the profile, so
 * a fresh test data root reads like a profile without rules rather than as
 * an unreadable one, which approval sessions treat as asking for everything.
 */
export async function seedEmptyApprovalRuleSources(
  workspaceIds: readonly string[],
): Promise<void> {
  await Promise.all(
    workspaceIds.map((workspaceId) =>
      writeWorkspaceApprovals(workspaceId, { version: 1, rules: [] }),
    ),
  );
  await updatePreferencesFile(() => ({ globalApprovalRules: [] }));
}
