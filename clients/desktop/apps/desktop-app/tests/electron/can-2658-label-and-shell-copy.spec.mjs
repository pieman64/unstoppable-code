// CAN-2658 — guard the platform-default shell copy in the pipeline editor.
// Reach the real editor settings using local demo seed data;
// no live agents, external network, or pipeline execution is needed.
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const defaultShell = process.platform === 'win32' ? 'PowerShell' : 'Bash';

test('run-defaults unset shell option names the platform default', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openPipelinesPage();
    // The manual builder is the New workflow menu's "When you start it, built
    // by hand" row (CAN-3981).
    await app.startNewWorkflow('build');
    await window.getByTestId('pipeline-editor-settings-toggle').click();

    const runDefaults = window.locator('section').filter({
      has: window.getByRole('heading', { name: 'Run defaults', exact: true }),
    });
    const shellSelect = runDefaults.getByRole('combobox');
    await shellSelect.scrollIntoViewIfNeeded();
    await expect(shellSelect).toBeVisible();
    await expect(shellSelect).toHaveAttribute('data-value', '');
    await shellSelect.click();
    const unsetOption = window.getByRole('option').first();
    await expect(unsetOption).toHaveAttribute('data-value', '');
    await expect(unsetOption).toHaveText(`Default (${defaultShell})`);
    await expect(unsetOption).toHaveAttribute('aria-selected', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
