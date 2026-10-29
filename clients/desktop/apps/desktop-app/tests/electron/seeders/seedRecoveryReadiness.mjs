import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedWelcomeChecklist } from './seedWelcomeChecklist.mjs';

/** Seeded workspace and deterministic recovery evidence; no Git effects are resumed. */
export function seedRecoveryReadiness() {
  const userDataDir = seedWelcomeChecklist();
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspaceId = seeded.workspaces[0].id;
  const issues = ['alpha', 'beta'].map((name) => ({
    code: 'recovery-required',
    title: 'Recover interrupted worktree creation',
    message: `recovery/${name}: /fixture-checkouts/${name}. Review this retained checkout.`,
    repoName: '/fixture-repositories/app',
    fixPrompt: null,
    recovery: {
      workspaceId,
      phase: 'orphan-checkout',
      repositoryPath: '/fixture-repositories/app',
      checkoutPath: `/fixture-checkouts/${name}`,
      branchName: `recovery/${name}`,
    },
  }));
  issues.push({
    code: 'configure-hooks',
    title: 'Add repository hooks',
    message: 'The repository has no effective hooks.',
    repoName: 'ts-pnpm-vite',
    fixPrompt: 'Configure repository hooks.',
  });
  return { userDataDir, workspaceId, issues };
}

/** Keep the real IPC bridge and all renderer consumers; replace only readiness evidence. */
export async function installRecoveryReadiness(electronApp, issues) {
  await electronApp.evaluate(({ ipcMain }, seededIssues) => {
    ipcMain.removeHandler('workspace:read-readiness');
    ipcMain.handle('workspace:read-readiness', () => ({
      issues: seededIssues,
    }));
    ipcMain.removeHandler('settings:github-cli-status');
    ipcMain.handle('settings:github-cli-status', () => ({
      authenticated: true,
      username: 'onboarding-fixture',
      error: null,
      tokenSource: 'gh',
      envOverride: false,
      envOverrideName: null,
      hasCredentialStoreLogin: true,
    }));
  }, issues);
}
