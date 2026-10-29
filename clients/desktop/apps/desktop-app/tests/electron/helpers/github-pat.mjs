import { expect } from '@playwright/test';
import { CanopyAppDriver } from '../canopyApp.mjs';
import { closeCanopy, launchCanopy } from '../launchCanopy.mjs';

// Store an isolated mock PAT using the supported settings surface: the
// "GitHub on this computer" card on the hosted Integrations page (CAN-4421).
export async function saveGitHubPat(window, app, token) {
  await app.openSettings();
  await app.openAccountSettingsPage('integrations');
  const githubPanel = window.getByTestId('auth-panel-github');
  await githubPanel
    .getByRole('button', { name: 'Personal Access Token' })
    .click();
  const patInput = window.getByTestId('auth-panel-github-pat-input');
  await patInput.fill(token);
  await expect
    .poll(
      async () =>
        (await window.evaluate(() => window.api.loadGitHubPat())).length,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  await app.closeSettings();
}

export async function primeStoredPat(userDataDir, token) {
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  try {
    await saveGitHubPat(window, app, token);
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }
}
