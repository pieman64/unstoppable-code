import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';

/**
 * Stable identity for a readiness issue within one workspace, shared by the
 * Getting started advanced queue and the Overview table
 * (`WorkspaceReadinessOverview`) so their derivations cannot drift. Not unique
 * across workspaces — callers tracking cross-workspace state must prefix it
 * with the workspace id.
 *
 * Recovery evidence also shares this identity with the settings surface.
 * Ordinary recommendations are deliberately NOT shared with the settings surface
 * (`WorkspaceReadinessRecommendations`) or the launcher's own in-flight
 * `launchKey`: both key by launch target with their own fallback semantics,
 * and folding them in would change behavior for a cleanup.
 *
 * Lives in its own store-free leaf module so component tests that mock the
 * launcher wholesale still exercise the real derivation.
 */
export function workspaceReadinessIssueKey(
  issue: WorkspaceReadinessIssue,
): string {
  if (issue.code === 'recovery-required' && issue.recovery) {
    return JSON.stringify([
      issue.code,
      issue.recovery.repositoryPath,
      issue.recovery.checkoutPath,
    ]);
  }
  return `${issue.repoId ?? issue.repoName}:${issue.code}`;
}
