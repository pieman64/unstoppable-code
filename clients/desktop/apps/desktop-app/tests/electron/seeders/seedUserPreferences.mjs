import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/** Normal user setup; legacy checklist fixtures are isolated in seedWelcomeChecklist. */
export function seedUserPreferences({
  roles = ['software-engineer'],
  enabledPlugins = [],
  preferences = {},
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-user-preferences-'),
  );
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      ...(roles.length > 0
        ? { profileRole: roles[0], profileRoles: roles }
        : {}),
      globalPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: enabledPlugins.map((pluginName) => ({
          marketplaceId: 'curated',
          pluginName,
        })),
      },
      ...preferences,
    },
  });
  return userDataDir;
}
