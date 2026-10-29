import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

test('CAN-2828: exact command leads and Enter opens Settings', async () => {
  // Seed a chat whose title shares words with the command so a content
  // section competes with Commands; without it the assertion is vacuous.
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2828-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    activeTabId: 'can-2828-settings-notes',
    tabs: [
      {
        id: 'can-2828-settings-notes',
        title: 'Open settings notes',
        providerType: 'codex',
        createdAt: '2026-09-01T12:00:00.000Z',
        messages: [],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await window.keyboard.press(PALETTE_SHORTCUT);
    const palette = window.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    const input = palette.getByTestId('command-palette-input');
    await input.fill('open settings');
    // The chat catalog loads lazily; wait for the seeded chat row so the
    // content section is present before reading the first row.
    await expect(
      palette
        .getByTestId('command-palette-result')
        .filter({ hasText: 'Open settings notes' }),
    ).toBeVisible();
    const firstRow = palette.getByTestId('command-palette-result').first();
    await expect(firstRow).toContainText('Open settings');
    await expect(
      firstRow.getByTestId('command-palette-kind-command'),
    ).toBeVisible();
    await window.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('settings-overlay')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
