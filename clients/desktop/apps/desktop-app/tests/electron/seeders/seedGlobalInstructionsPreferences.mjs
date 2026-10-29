import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Seed the local preferences used by the Global Instructions capture spec.
 * Keeping this in the shared seeder layer makes both capture stages start from
 * the same explicit state instead of depending on defaults from the host.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @returns {{ filePath: string }}
 */
export function seedGlobalInstructionsPreferences(options) {
  const { userDataDir } = options ?? {};
  if (!userDataDir) {
    throw new Error('seedGlobalInstructionsPreferences requires userDataDir');
  }

  const filePath = path.join(userDataDir, 'preferences.json');
  writeJson(filePath, {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      globalInstructions: {
        chats: { overall: '', scoped: [] },
        pipelines: { overall: '', scoped: [] },
      },
    },
  });
  return { filePath };
}
