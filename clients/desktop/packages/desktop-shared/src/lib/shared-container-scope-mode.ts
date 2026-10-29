import { MAX_SHARED_CONTAINER_RUN_COMMANDS } from '@canopy/protocol/shared-containers';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import { PROJECT_LIFECYCLE_SCRIPT_NAMES } from '../scripts';
import type { SharedContainerFileScope } from '../types';

/** Worktrees are always opt-out. Only Cowork preserves pre-opt-out allowlists. */
export function fileScopeIsAllowlist(
  containerType: SharedContainerType,
  scope: SharedContainerFileScope,
): boolean {
  return (
    containerType !== 'CODE_WORKTREE' &&
    (scope.legacyAllowlist === true ||
      (scope.includedPaths.length > 0 && scope.excludedPaths === undefined))
  );
}

/** Lifecycle scripts lead, followed by every other script alphabetically. */
export function orderRunScriptNames(names: readonly string[]): string[] {
  const lifecycleRank = new Map<string, number>();
  PROJECT_LIFECYCLE_SCRIPT_NAMES.forEach((name, index) => {
    lifecycleRank.set(name, index);
  });
  return Array.from(new Set(names)).sort((left, right) => {
    const leftRank =
      lifecycleRank.get(left) ?? PROJECT_LIFECYCLE_SCRIPT_NAMES.length;
    const rightRank =
      lifecycleRank.get(right) ?? PROJECT_LIFECYCLE_SCRIPT_NAMES.length;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });
}

/** Resolve the default-on worktree run-script selection. */
export function selectDefaultRunScripts(
  candidates: readonly string[],
  scope: SharedContainerFileScope,
): string[] {
  if (scope.runSharingDisabled === true) return [];
  const excluded = new Set(scope.excludedRunScripts ?? []);
  return orderRunScriptNames(candidates)
    .filter((name) => !excluded.has(name))
    .slice(0, MAX_SHARED_CONTAINER_RUN_COMMANDS);
}
