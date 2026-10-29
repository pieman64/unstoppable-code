import type { SidebarItem } from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import {
  getScriptDefinition,
  type ScriptOverrides,
} from '@canopy/desktop-shared/scripts';
import type { ScriptRunState } from '@/stores/scriptsStore';

export interface FileSetupRetryPlan {
  /** The last relevant script whose terminal event makes a final read useful. */
  completionScriptKey: string;
  /**
   * A failed workspace before-setup prevents repo/after-setup scripts from
   * starting. Treat that failure as terminal so a missing tab cannot spin
   * forever waiting for an event that will never arrive.
   */
  prerequisiteScriptKey?: string;
}

export type FileSetupRetryState = 'not-applicable' | 'waiting' | 'finished';

function hasRunnableScript(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): boolean {
  return Boolean(getScriptDefinition(scripts, scriptName)?.command.trim());
}

/**
 * Resolve the last automatic setup script that may create a restored file.
 * Worktree-specific effective scripts win because they include checked-out
 * canopy.json overrides; the workspace-level effective/configured maps are
 * fallbacks for legacy rows.
 */
export function resolveFileSetupRetryPlan(
  project: SidebarItem | undefined,
  worktreeId: string,
  fileRootLocalId: string | undefined,
): FileSetupRetryPlan | null {
  if (!project || project.type === 'cowork') return null;

  const worktreeEffective = project.worktreeEffective?.[worktreeId];
  if (project.type === 'single-repo') {
    const scripts =
      worktreeEffective?.effectiveScripts ??
      project.effectiveScripts ??
      project.scripts;
    return hasRunnableScript(scripts, 'setup')
      ? { completionScriptKey: 'project:setup' }
      : null;
  }

  const rootScripts =
    worktreeEffective?.effectiveScripts ??
    project.effectiveScripts ??
    project.scripts;
  const hasBeforeSetup = hasRunnableScript(rootScripts, 'before-setup');
  const hasAfterSetup = hasRunnableScript(rootScripts, 'after-setup');
  const beforeSetupKey = 'workspace-root:before-setup';

  if (!fileRootLocalId) return null;

  if (fileRootLocalId === WORKSPACE_ROOT_REPO_ID) {
    if (hasAfterSetup) {
      return {
        completionScriptKey: 'workspace-root:after-setup',
        ...(hasBeforeSetup ? { prerequisiteScriptKey: beforeSetupKey } : {}),
      };
    }
    return hasBeforeSetup ? { completionScriptKey: beforeSetupKey } : null;
  }

  const repo = project.repos.find(
    (candidate) => candidate.id === fileRootLocalId,
  );
  const repoScripts =
    worktreeEffective?.repos?.[fileRootLocalId]?.effectiveScripts ??
    repo?.effectiveScripts ??
    repo?.scripts;
  const repoSetupKey = `workspace-repo:${fileRootLocalId}:setup`;

  // after-setup is the final workspace setup stage and may generate files in
  // any checkout. Otherwise wait for this repo's own setup, then fall back to
  // the root before-setup when it is the only relevant configured stage.
  const completionScriptKey = hasAfterSetup
    ? 'workspace-root:after-setup'
    : hasRunnableScript(repoScripts, 'setup')
      ? repoSetupKey
      : hasBeforeSetup
        ? beforeSetupKey
        : null;
  if (!completionScriptKey) return null;

  return {
    completionScriptKey,
    ...(hasBeforeSetup && completionScriptKey !== beforeSetupKey
      ? { prerequisiteScriptKey: beforeSetupKey }
      : {}),
  };
}

/** Resolve whether the configured retry point is still running or pending. */
export function resolveFileSetupRetryState(
  plan: FileSetupRetryPlan | null,
  runs: Readonly<Record<string, ScriptRunState>> | undefined,
): FileSetupRetryState {
  if (!plan) return 'not-applicable';

  const prerequisite = plan.prerequisiteScriptKey
    ? runs?.[plan.prerequisiteScriptKey]
    : undefined;
  if (prerequisite?.status === 'failed') return 'finished';

  const completion = runs?.[plan.completionScriptKey];
  return completion?.status === 'success' || completion?.status === 'failed'
    ? 'finished'
    : 'waiting';
}
