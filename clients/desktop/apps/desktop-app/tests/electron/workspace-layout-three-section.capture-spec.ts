/**
 * @capture-keep: reusable before/after proof for the three-section layout
 * @capture-reference: package.json
 * Workspace Minimal three-section and selected layout-card visual verification.
 * No ticket; PR #2888 follow-up.
 *
 * Run with `CANOPY_LAYOUT_THREE_SECTION_STAGE=after pnpm run test:electron:captures:built workspace-layout-three-section.capture-spec.ts`,
 * once normally and once with --dark-mode (use `before` for the baseline).
 * The worktree, chat, mode, panel layout, and display preferences are seeded
 * locally; no agent or network activity is involved.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const STAGE =
  process.env.CANOPY_LAYOUT_THREE_SECTION_STAGE === 'before'
    ? 'before'
    : 'after';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(
  repoRoot,
  '.playwright',
  'workspace-layout-three-section',
);

test('capture Minimal section topology and Add panel placement', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-layout-three-section-capture-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [{ id: 'seed-chat', title: 'Plan the release' }],
  });
  const dataDir = path.join(
    userDataDir,
    'workspaces',
    'demo-ts-pnpm-vite',
    'worktree-data',
    'demo-main',
  );
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'minimal' }),
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();
    mkdirSync(captureDir, { recursive: true });

    await window.getByTestId('worktree-part').screenshot({
      path: path.join(captureDir, `minimal-sections-${STAGE}.png`),
      animations: 'disabled',
    });

    if (STAGE === 'after') {
      await expect(window.getByTestId('panel-group-group-extras')).toBeHidden();
      await expect(
        window.getByTestId('panel-group-group-terminal'),
      ).toBeHidden();
      await window.getByTestId('workspace-layout-side-panel-toggle').click();
      await expect(
        window.getByTestId('panel-group-group-extras'),
      ).toBeVisible();
      const bottomToggle = window.getByTestId(
        'workspace-layout-terminal-toggle',
      );
      if (
        (await bottomToggle.getAttribute('aria-label')) !==
        'Collapse bottom drawer'
      ) {
        await bottomToggle.click();
      }
      await expect(
        window.getByTestId('panel-group-group-terminal'),
      ).toBeVisible();
    }
    await window.getByTestId('worktree-part').screenshot({
      path: path.join(captureDir, `minimal-sections-expanded-${STAGE}.png`),
      animations: 'disabled',
    });

    const addPanelGroupId = STAGE === 'after' ? 'group-extras' : 'group-chat';
    const addPanel = window.getByTestId(`panel-add-panel-${addPanelGroupId}`);
    await addPanel.click();
    await expect(window.getByTestId('panel-add-menu')).toBeVisible();
    await window.getByTestId('worktree-part').screenshot({
      path: path.join(captureDir, `add-panel-menu-${STAGE}.png`),
      animations: 'disabled',
    });
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('panel-add-menu')).toBeHidden();

    await app.openSettings();
    await app.openSettingsSection('display');
    const displaySection = window.getByTestId('settings-tab-display');
    const settingsCapture =
      STAGE === 'after'
        ? displaySection
            .getByRole('heading', { name: 'Project layout' })
            .locator('xpath=..')
        : displaySection;
    await expect(settingsCapture).toBeVisible();
    await settingsCapture.screenshot({
      path: path.join(captureDir, `settings-layout-selection-${STAGE}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
