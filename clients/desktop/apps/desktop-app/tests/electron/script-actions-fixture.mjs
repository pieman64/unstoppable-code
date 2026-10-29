import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

export const SCRIPT_CONTEXT = {
  projectId: 'demo-script-actions',
  worktreeId: 'demo-main',
};
export async function openScriptActionsFixture(options = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-script-actions-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['script-actions'],
    checkRuntimes: false,
  });
  const config = JSON.parse(
    readFileSync(
      path.join(
        userDataDir,
        'workspaces',
        SCRIPT_CONTEXT.projectId,
        'workspace.json',
      ),
      'utf8',
    ),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: SCRIPT_CONTEXT.projectId,
    worktreeId: SCRIPT_CONTEXT.worktreeId,
    providerType: 'claude',
    tabs: [{ id: 'script-chat', title: 'Script actions' }],
  });
  const launched = await launchCanopy({
    userDataDir,
    ...options,
    env: {
      CANOPY_E2E_SCRIPT_ALIAS_HOME: path.join(config.sourceRepoPath, 'home'),
      ...options.env,
    },
  });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(SCRIPT_CONTEXT.worktreeId, {
    expandDefaultActivityRail: false,
  });
  return {
    ...launched,
    window,
    config,
    userDataDir,
    close: () => closeCanopy(launched.electronApp, userDataDir),
  };
}
