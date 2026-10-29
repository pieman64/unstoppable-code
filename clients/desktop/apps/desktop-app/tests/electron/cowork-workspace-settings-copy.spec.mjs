// CAN-2711: Guard workspace terminology across every cowork workspace settings
// tab, including the description placeholder and destructive-action heading.
import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCoworkWorkspace } from './seeders/index.mjs';

test('cowork project settings use project copy on every tab', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-settings-copy-'),
  );
  const workspaceId = 'cowork-settings-copy';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'Cowork Settings',
    collapsed: false,
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openChatPage();

    const rowTestId = `sidebar-cowork-project-${workspaceId}`;
    await window.getByTestId(`${rowTestId}-header`).hover();
    await window.getByTestId(`${rowTestId}-settings`).click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#chat-project-description')).toHaveAttribute(
      'placeholder',
      'Optional project description',
    );

    // The guard covers the dialog's own copy. Picker rows (tbody) are catalog
    // content — bundled plugin/skill descriptions legitimately say
    // "single-repo projects" — so they are excluded from the sweep.
    const settingsCopy = () =>
      dialog.evaluate((root) => {
        const clone = root.cloneNode(true);
        for (const rows of clone.querySelectorAll('tbody')) rows.remove();
        return clone.textContent ?? '';
      });
    for (const name of [
      'General',
      'Instructions',
      'Plugins',
      'Environment',
      'Danger',
    ]) {
      await dialog.getByRole('tab', { name, exact: true }).click();
      await expect.poll(settingsCopy).not.toMatch(/\bworkspaces?\b/i);
    }
    await expect(
      dialog.getByRole('heading', { name: 'Delete project', exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
