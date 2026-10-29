import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Seed tracked plans for a worktree before launching Electron.
 *
 * Mirrors `getWorkspaceTrackedPlansFilePath()` because current single-repo and
 * workspace plan storage both resolve to `workspaces/<id>/plans/<worktree>.json`.
 *
 * @param {object} options
 * @param {string} options.userDataDir
 * @param {string} options.workspaceId
 * @param {string} options.worktreeId
 * @param {unknown[]} options.plans
 */
export function seedTrackedPlans({
  userDataDir,
  workspaceId,
  worktreeId,
  plans,
}) {
  if (!userDataDir) {
    throw new Error('seedTrackedPlans requires userDataDir');
  }
  if (!workspaceId) {
    throw new Error('seedTrackedPlans requires workspaceId');
  }
  if (!worktreeId) {
    throw new Error('seedTrackedPlans requires worktreeId');
  }
  if (!Array.isArray(plans)) {
    throw new Error('seedTrackedPlans requires plans');
  }

  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      workspaceId,
      'plans',
      `${worktreeId}.json`,
    ),
    { version: 1, plans },
  );
}
