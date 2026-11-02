// Early access: the Minimal Side Panel is never tabless. It starts with a New
// tab that lists what can be opened; choosing a surface replaces the New tab,
// closing the Side Panel's last tab hides it (with a New tab back inside),
// and the Side Panel's `+` opens another. With early access off, the Minimal
// Side Panel starts with Activity and File explorer; filled tabs can close.
//
// Run after building the implementation:
//   pnpm run test:electron:built side-panel-new-tab.spec.mjs --reporter=line
//
// Determinism: the worktree and its chat are seeded on disk with no messages;
// no provider or network request runs.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SIDE_PANEL = 'group-extras';

function seed({ earlyAccess }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-side-panel-new-tab-'),
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
  writeFileSync(
    path.join(dataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'minimal' }),
  );
  if (earlyAccess) seedEarlyAccess({ userDataDir });
  return userDataDir;
}

async function sidePanelKinds(window) {
  const layout = await getLayout(window);
  const leaf = layout
    ? collectLeaves(layout.root).find((entry) => entry.groupId === SIDE_PANEL)
    : undefined;
  return leaf ? leaf.panels.map((panel) => panel.kind) : null;
}

async function openSidePanel({ earlyAccess }) {
  const userDataDir = seed({ earlyAccess });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
  // Minimal opens with the Side Panel hidden until asked for. (The toggle's
  // pressed state means visible with early access and collapsed without.)
  const group = window.getByTestId(`panel-group-${SIDE_PANEL}`);
  await expect(group).toBeHidden();
  await window.getByTestId('workspace-layout-side-panel-toggle').click();
  await expect(group).toBeVisible();
  return { launched, userDataDir, window, group };
}

test('early access fills the Minimal Side Panel with a New tab that lists what to open', async () => {
  const { launched, userDataDir, window, group } = await openSidePanel({
    earlyAccess: true,
  });
  try {
    await expect.poll(() => sidePanelKinds(window)).toEqual(['new-tab']);
    const picker = group.getByTestId('new-tab-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Open…');
    const automationsIcon = picker
      .getByTestId('side-panel-empty-item-automations')
      .locator('svg');
    await expect(automationsIcon).toHaveCSS('width', '14px');
    await expect(automationsIcon).toHaveCSS('height', '14px');

    // Choosing a surface replaces the New tab.
    await picker.getByTestId('side-panel-empty-item-file-explorer').click();
    await expect.poll(() => sidePanelKinds(window)).toEqual(['file-explorer']);
    await expect(group.getByTestId('new-tab-picker')).toHaveCount(0);

    // The Side Panel's tabs close like any other; closing the last one hides
    // the Side Panel, which holds a New tab for when it is shown again
    // instead of being tabless.
    const layout = await getLayout(window);
    const explorerId = collectLeaves(layout.root)
      .find((entry) => entry.groupId === SIDE_PANEL)
      ?.panels.find((panel) => panel.kind === 'file-explorer')?.panelId;
    expect(explorerId).toBeTruthy();
    const tab = window.getByTestId(`panel-tab-${explorerId}`);
    await tab.hover();
    await window.getByTestId(`panel-tab-close-${explorerId}`).click();
    await expect.poll(() => sidePanelKinds(window)).toEqual(['new-tab']);
    await expect(group).toBeHidden();
    await window.getByTestId('workspace-layout-side-panel-toggle').click();
    await expect(group).toBeVisible();
    await expect(group.getByTestId('new-tab-picker')).toBeVisible();

    // `+` opens another New tab.
    await window.getByTestId(`panel-add-tab-${SIDE_PANEL}`).click();
    await expect
      .poll(() => sidePanelKinds(window))
      .toEqual(['new-tab', 'new-tab']);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('the graduated Minimal Side Panel starts empty without early access', async () => {
  const { launched, userDataDir, window, group } = await openSidePanel({
    earlyAccess: false,
  });
  try {
    await expect.poll(() => sidePanelKinds(window)).toEqual(['new-tab']);
    const picker = group.getByTestId('new-tab-picker');
    await expect(picker).toBeVisible();
    await picker.getByTestId('side-panel-empty-item-file-explorer').click();
    await expect.poll(() => sidePanelKinds(window)).toEqual(['file-explorer']);
    await expect(picker).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
