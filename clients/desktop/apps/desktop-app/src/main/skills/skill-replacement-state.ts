import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { getSkillDir, CUSTOM_SOURCE_ID } from './paths';

export const SKILL_REPLACEMENT_JOURNAL = '.canopy-shared-update.json';

/** Even matching bytes may need receipt/subscription recovery after a crash. */
export async function hasPendingSkillReplacement(
  skillName: string,
): Promise<boolean> {
  try {
    await lstat(
      join(getSkillDir(CUSTOM_SOURCE_ID, skillName), SKILL_REPLACEMENT_JOURNAL),
    );
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    throw error;
  }
}
