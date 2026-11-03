import { writeWorkspaceApprovals } from '../../lib/approvals-persistence';
import {
  flushPreferencesWrites,
  updatePreferencesFile,
} from '../../lib/preferences-store';

/**
 * Writes empty approval rule tiers for these workspaces and the profile, so
 * a fresh test data root reads like a profile without rules rather than as
 * an unreadable one, which approval sessions treat as asking for everything.
 *
 * Resolves only once the preferences last-good backup has landed too. That
 * file is a protected policy path, and the save refreshes it in the
 * background: when its first write lands between `resolveExistingAncestorPath`'s
 * `realpath` and `lstat`, that function reads it as a dangling symlink and the
 * policy leaves it out, so two policies the test compares would protect
 * different files.
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
  await flushPreferencesWrites();
}
