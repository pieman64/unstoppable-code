import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Turn on early access (Settings → Experiments) before launch, merging into
 * the durable local choices already seeded. Early access shows the `fill` panel tabs.
 * It never changes a worktree's layout mode: seed `panel-layout-mode.json`
 * for the mode a spec needs.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @returns {{ filePath: string }}
 */
export function seedEarlyAccess(options) {
  const { userDataDir } = options ?? {};
  if (!userDataDir) {
    throw new Error('seedEarlyAccess requires userDataDir');
  }

  const filePath = path.join(userDataDir, 'labs-experiments', 'choices.json');
  const existing = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, 'utf8'))
    : { version: 1, accounts: {} };
  writeJson(filePath, {
    ...existing,
    version: 1,
    accounts: {
      ...existing.accounts,
      local: { ...existing.accounts?.local, 'early-access': true },
    },
  });
  return { filePath };
}
