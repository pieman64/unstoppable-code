import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';

export const HOOK_PAUSE_WORKSPACE_ID = 'demo-multi-repo-fullstack';
export const HOOK_PAUSE_WORKTREE_ID = 'demo-main';
export const HOOK_PAUSE_KEYS = [
  'workspace-repo:api:pr:create',
  'workspace-repo:web:pr:create',
  'workspace-root:pr:create',
];

export function seedHookPauseWorkspace(userDataDir) {
  seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
    checkRuntimes: false,
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    HOOK_PAUSE_WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const hooks = {
    'pr:create': [{ type: 'command', command: 'true' }],
    'worktree:precommit:failure': null,
  };
  config.hooks = hooks;
  for (const repo of config.repos) repo.hooks = hooks;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function readHookPauseKeys(window) {
  return window.evaluate(
    async ({ projectId, worktreeId }) => {
      const { items } = await window.api.loadProjects();
      const project = items.find((item) => item.id === projectId);
      const worktree = project?.worktrees.find(
        (item) => item.id === worktreeId,
      );
      if (!worktree) throw new Error('Hook pause fixture worktree not found');
      return [...(worktree.pausedHookKeys ?? [])].sort();
    },
    { projectId: HOOK_PAUSE_WORKSPACE_ID, worktreeId: HOOK_PAUSE_WORKTREE_ID },
  );
}
