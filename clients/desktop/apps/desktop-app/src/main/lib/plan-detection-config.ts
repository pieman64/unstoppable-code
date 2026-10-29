import {
  resolvePlanDetectionRules,
  type ResolvedPlanDetectionRules,
} from '@canopy/desktop-shared/plan-detection';
import { readCanopyJson } from './canopy-json';
import { readPreferencesFile } from './preferences-store';
import { resolveWorktreeCwd } from './resolve-worktree';
import { readEffectiveWorkspaceConfig } from './workspace-source';

/**
 * Resolve the effective include/exclude rules for a worktree by combining
 * global preferences with the workspace's local + canopy.json config.
 */
export async function resolveWorktreePlanDetectionRules(
  workspaceId: string,
  worktreeId?: string,
): Promise<ResolvedPlanDetectionRules> {
  const preferences = await readPreferencesFile();
  const effective = await readEffectiveWorkspaceConfig(workspaceId).catch(
    () => null,
  );
  const worktreeManifest =
    effective?.manifest || !worktreeId
      ? null
      : await readCanopyJson(resolveWorktreeCwd(workspaceId, worktreeId)).catch(
          () => null,
        );
  return resolvePlanDetectionRules({
    global: preferences.planDetection,
    workspaceLocal: effective?.localConfig.planDetection,
    canopyJson:
      effective?.manifest?.planDetection ??
      worktreeManifest?.planDetection ??
      undefined,
  });
}
