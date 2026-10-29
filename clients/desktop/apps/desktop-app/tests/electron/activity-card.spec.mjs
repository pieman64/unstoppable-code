// Early access moves Activity out of the panels into a card in the main chat
// surface, toggled from the chat tab row. The card lists each section as one
// row; a row opens its section as a Side Panel tab, and an empty Side Panel
// then opens at its minimum width in place of its New tab. Each worktree
// remembers whether its card is shown. The toggle shows only while the main
// chat group shows a chat, not a browser or other tab. With early access off
// nothing of this shows and Minimal keeps develop's Activity tab.
//
// Run after building the implementation:
//   pnpm run test:electron:built activity-card.spec.mjs --reporter=line
//
// Determinism: the worktree, its chat, and one changed file are seeded on
// disk; no provider or network request runs.

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
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getLayout,
  seedVisibleBrowserPanel,
} from './panelHarness.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SIDE_PANEL = 'group-extras';
/** The Side Panel's minimum width (`DEFAULT_PANEL_LEAF_MINIMUM_WIDTH`). */
const SIDE_PANEL_MINIMUM_WIDTH = 320;

function seed({ earlyAccess, layoutMode = 'minimal' }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-activity-card-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seeded.workspaces?.[0]?.worktreePath;
  if (!worktreePath) throw new Error('Seeded worktree path missing');
  // One dirty file, so the Changed files section has a row.
  writeFileSync(
    path.join(worktreePath, 'ACTIVITY_CARD.txt'),
    'activity card fixture\n',
    'utf8',
  );
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
    JSON.stringify({ version: 1, mode: layoutMode }),
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

async function launch({ earlyAccess, layoutMode }) {
  const userDataDir = seed({ earlyAccess, layoutMode });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
  return { launched, userDataDir, window };
}

test('early access shows Activity as a card whose rows open Side Panel tabs', async () => {
  test.setTimeout(120_000);
  const { launched, userDataDir, window } = await launch({
    earlyAccess: true,
  });
  try {
    // Activity is not a panel here.
    await expect
      .poll(async () => {
        const layout = await getLayout(window);
        return layout
          ? collectLeaves(layout.root).flatMap((leaf) =>
              leaf.panels.map((panel) => panel.kind),
            )
          : null;
      })
      .not.toContain('activity-section');

    const toggle = window.getByTestId('worktree-activity-card-toggle');
    const card = window.getByTestId('activity-card');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(card).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card).toBeVisible();
    const changes = card.getByTestId('activity-card-row-changed-files');
    await expect(changes).toBeVisible({ timeout: 20_000 });
    await expect(changes).toContainText('Changes');

    // The Side Panel held only its New tab: the section takes its place, and
    // the Side Panel opens at its minimum width.
    await changes.click();
    await expect.poll(() => sidePanelKinds(window)).toEqual(['activity-card']);
    const sidePanel = window.getByTestId(`panel-group-${SIDE_PANEL}`);
    await expect(sidePanel).toBeVisible();
    await expect
      .poll(async () => (await sidePanel.boundingBox())?.width ?? 0)
      .toBeLessThanOrEqual(SIDE_PANEL_MINIMUM_WIDTH + 2);

    // The add menu no longer offers Activity.
    await window.getByTestId(`panel-add-tab-${SIDE_PANEL}`).click();
    await expect.poll(() => sidePanelKinds(window)).toContain('new-tab');
    await expect(
      window.getByTestId('side-panel-empty-item-activity-section'),
    ).toHaveCount(0);

    // Hiding the card is remembered for the worktree across a reload.
    await toggle.click();
    await expect(card).toBeHidden();
    await toggle.click();
    await expect(card).toBeVisible();
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('activity-card')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      window.getByTestId('worktree-activity-card-toggle'),
    ).toHaveAttribute('aria-expanded', 'true');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('the Activity toggle shows only while the main chat group shows a chat', async () => {
  test.setTimeout(120_000);
  const { launched, userDataDir, window } = await launch({
    earlyAccess: true,
    layoutMode: 'advanced',
  });
  try {
    const toggle = window.getByTestId('worktree-activity-card-toggle');
    await expect(toggle).toBeVisible();

    // Opening the card leaves the chat's centered column where it is when
    // the margin beside it fits the card, and otherwise moves it only clear
    // of the card.
    // The composer's status row spans the column (the seeded chat has no
    // messages yet).
    const column = window.getByTestId('chat-composer-status-row');
    await expect(column).toBeVisible();
    const closed = await column.boundingBox();
    await toggle.click();
    await expect(window.getByTestId('activity-card')).toBeVisible();
    const opened = await column.boundingBox();
    const layout = await window
      .getByTestId('chat-activity-card-layout')
      .boundingBox();
    const slot = await window.getByTestId('activity-card-slot').boundingBox();
    expect(closed && opened && layout && slot).toBeTruthy();
    if (
      (await window
        .getByTestId('activity-card-slot')
        .getAttribute('data-placement')) === 'beside'
    ) {
      expect(opened.x + opened.width).toBeLessThanOrEqual(slot.x);
      if (closed.x + closed.width <= slot.x) {
        expect(Math.abs(opened.x - closed.x)).toBeLessThanOrEqual(1);
      }
    }
    await toggle.click();

    // A browser shown in the main chat group hides the toggle.
    const { panelId } = await seedVisibleBrowserPanel(
      window,
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID, url: 'about:blank' },
      { moveToGroupId: DEFAULT_GROUP_IDS.chat },
    );
    await expect(window.getByTestId(`panel-tab-${panelId}`)).toBeVisible();
    await expect(toggle).toHaveCount(0);

    // Back on the chat, it shows again.
    await window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`).click();
    await expect(toggle).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('with early access off there is no Activity card and Minimal keeps its Activity tab', async () => {
  test.setTimeout(120_000);
  const { launched, userDataDir, window } = await launch({
    earlyAccess: false,
  });
  try {
    await expect(window.getByTestId('chat-activity-card-layout')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('worktree-activity-card-toggle'),
    ).toHaveCount(0);
    await expect
      .poll(() => sidePanelKinds(window))
      .toEqual(['activity-section', 'file-explorer']);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
