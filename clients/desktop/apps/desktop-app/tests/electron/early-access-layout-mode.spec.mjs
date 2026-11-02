import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * Early access never changes a worktree's layout mode: a worktree saved as
 * Advanced opens in Advanced with early access on, and the header menu changes
 * only that worktree. Settings → Display sets the layout for new worktrees and
 * leaves the open one alone. Turning early access off changes no mode either.
 */

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

function seed() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-early-access-layout-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'seed-chat', title: 'Chat' }],
  });
  const dataDir = path.join(
    userDataDir,
    'workspaces',
    PROJECT_ID,
    'worktree-data',
    WORKTREE_ID,
  );
  mkdirSync(dataDir, { recursive: true });
  const modeFile = path.join(dataDir, 'panel-layout-mode.json');
  writeFileSync(modeFile, JSON.stringify({ version: 1, mode: 'advanced' }));
  seedEarlyAccess({ userDataDir });
  return { userDataDir, modeFile };
}

function readOwnMode(modeFile) {
  return JSON.parse(readFileSync(modeFile, 'utf8')).mode;
}

function readDefaultMode(window) {
  return window.evaluate(() =>
    window.api
      .loadPreferences()
      .then((prefs) => prefs.workspaceDefaultLayoutMode),
  );
}

function surfaceOf(locator) {
  return locator.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
}

async function expectMode(window, mode) {
  await expect(
    window.getByTestId('workspace-layout-toggle-reveal'),
  ).toHaveAttribute('data-open', mode === 'minimal' ? 'true' : 'false');
}

test('early access keeps each worktree layout mode', async () => {
  const { userDataDir, modeFile } = seed();
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();

    // Early access on: the worktree keeps its own Advanced mode.
    await expectMode(window, 'advanced');
    expect(readOwnMode(modeFile)).toBe('advanced');

    // The header menu changes this worktree's mode.
    await window.getByTestId('worktree-top-save-layout-default').click();
    await window.getByRole('menuitemradio', { name: 'minimal' }).click();
    await window.keyboard.press('Escape');
    await expectMode(window, 'minimal');
    await expect.poll(() => readOwnMode(modeFile)).toBe('minimal');

    // Early access's Minimal opens on Chat alone: Side Panel and Bottom
    // Drawer wait to be asked for.
    const sideToggle = window.getByTestId('workspace-layout-side-panel-toggle');
    const bottomToggle = window.getByTestId('workspace-layout-terminal-toggle');
    // A toggle is pressed, and keeps the hover surface, while its panel is
    // visible.
    await expect(sideToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(bottomToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(sideToggle).toHaveAttribute('aria-label', 'Toggle side panel');
    await expect(bottomToggle).toHaveAttribute(
      'aria-label',
      'Toggle bottom drawer',
    );
    await expect(window.getByTestId('panel-group-group-extras')).toBeHidden();
    const subtleSurface = await window.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--bg-subtle)';
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    await window.mouse.move(0, 0);
    await expect.poll(() => surfaceOf(sideToggle)).not.toBe(subtleSurface);
    await sideToggle.click();
    await expect(sideToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('panel-group-group-extras')).toBeVisible();
    await window.mouse.move(0, 0);
    await expect.poll(() => surfaceOf(sideToggle)).toBe(subtleSurface);

    await window.getByTestId('worktree-top-save-layout-default').click();
    await window.getByRole('menuitemradio', { name: 'advanced' }).click();
    await window.keyboard.press('Escape');
    await expectMode(window, 'advanced');
    await expect.poll(() => readOwnMode(modeFile)).toBe('advanced');

    // Settings → Display sets the layout for new worktrees only.
    await app.openSettings();
    await app.openSettingsSection('display');
    await expect(window.getByTestId('settings-tab-display')).toContainText(
      'Used for new worktrees and work entries.',
    );
    await window.getByTestId('workspace-layout-default-minimal').click();
    await expect.poll(() => readDefaultMode(window)).toBe('minimal');
    await app.closeSettings();
    await app.openMainPage();
    await expectMode(window, 'advanced');
    expect(readOwnMode(modeFile)).toBe('advanced');

    // Early access off: the worktree stays as it is.
    await app.openSettings();
    await app.openSettingsSection('experiments');
    const toggle = window.getByTestId('labs-experiment-toggle-minimal-layout');
    await expect(toggle).toHaveCount(0);
    await app.closeSettings();
    await app.openMainPage();
    await expectMode(window, 'advanced');
    expect(readOwnMode(modeFile)).toBe('advanced');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
