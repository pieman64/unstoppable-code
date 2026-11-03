import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';

/**
 * Stable identity for a readiness issue within one workspace, shared by the
 * Getting started advanced queue and the Overview table
 * (`WorkspaceReadinessOverview`) so their derivations cannot drift. Not unique
 * across workspaces — callers tracking cross-workspace state must prefix it
 * with the workspace id.
 *
 * Launched-fix records (`workspaceReadinessLaunches`) and the launcher's
 * in-flight guard scope this identity by workspace and audit target, so every
 * surface finds the same launch. Recovery evidence also shares it with the
 * settings surface, whose own in-flight `launchingKey` keeps its fallback
 * semantics for ordinary recommendations.
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
