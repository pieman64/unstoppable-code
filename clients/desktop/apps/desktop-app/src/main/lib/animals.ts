import { getCanopyRuntimeMode } from '@canopy/execution-engine/canopy-paths';
import { pickUniqueAnimalName } from '@canopy/protocol/worktree-branch-names';

export { ANIMAL_NAMES } from '@canopy/protocol/worktree-branch-names';

const DEV_WORKTREE_NAME_PREFIX = 'dev-';

export function generateUniqueAnimalName(existingNames: Set<string>): string {
  return pickUniqueAnimalName(existingNames, {
    prefix: getCanopyRuntimeMode() === 'dev' ? DEV_WORKTREE_NAME_PREFIX : '',
  });
}
