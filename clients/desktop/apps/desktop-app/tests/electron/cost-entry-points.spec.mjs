// Observed-cost links from Activity and subagent surfaces. Audit files and the
// chat/pipeline records are seeded before launch; the app builds its real cost
// read model on first open.

import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { expandCoworkWorkspace } from './coworkWorkEntryDoneFixture.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import { seedCostInsights } from './seeders/index.mjs';
import {
  CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
  seedChatsSectionFixture,
} from './seeders/seedChatsSectionFixture.mjs';
import { SUBAGENT_VIEWER_TREE_IDS } from './seeders/subagentViewerCapture.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SIDE_PANEL = 'group-extras';

function seedLayout(userDataDir, mode) {
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeJson(path.join(worktreeDataDir, 'panel-layout-mode.json'), {
    version: 1,
    mode,
  });
}

async function sidePanelKinds(window) {
  const layout = await getLayout(window);
  const leaf = layout
    ? collectLeaves(layout.root).find((entry) => entry.groupId === SIDE_PANEL)
    : undefined;
  return leaf?.panels.map((panel) => panel.kind) ?? null;
}

async function launchWorktree({
  earlyAccess = true,
  mode = 'minimal',
  beforeSelect,
} = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-cost-entry-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const cost = seedCostInsights({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    earlyAccess,
  });
  // `null` keeps the default layout, whose Activity rail lists its sections.
  if (mode !== null) seedLayout(userDataDir, mode);
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await beforeSelect?.(window);
  await app.selectWorktree(WORKTREE_ID);
  return { userDataDir, cost, launched, window };
}

const RAIL_SUMMARY_SECTION =
  '[data-testid="panel-content-activity-section"] [data-testid="activity-summary-section"]';

/**
 * Records every element that serves as the rail's Summary section from now
 * on, so a test can tell one mounted rail from a rail that was replaced.
 */
async function recordRailSummarySections(window) {
  await window.evaluate((selector) => {
    const seen = [];
    const record = () => {
      const element = document.querySelector(selector);
      if (element && !seen.includes(element)) seen.push(element);
    };
    new MutationObserver(record).observe(document.body, {
      childList: true,
      subtree: true,
    });
    record();
    globalThis.__canopyE2eRailSummarySections = seen;
  }, RAIL_SUMMARY_SECTION);
}

async function railSummarySections(window) {
  return window.evaluate(() => {
    const seen = globalThis.__canopyE2eRailSummarySections ?? [];
    return { count: seen.length, connected: seen.at(-1)?.isConnected === true };
  });
}

/**
 * Opens the seeded subagent tree's root chat. The subagent viewer reads a
 * root chat's loaded transcript, and the seed makes another chat active.
 */
async function openRootChat(window, cost) {
  const tab = window.getByTestId(`panel-tab-panel-chat-${cost.ids.rootChat}`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function openCostCard(window, expectedTotal) {
  const toggle = window.getByTestId('worktree-activity-card-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  const card = window.getByTestId('activity-card');
  await expect(card).toBeVisible();
  const costRow = card.getByTestId('activity-card-row-cost');
  await expect(costRow).toBeVisible();
  await expect(costRow).toContainText(expectedTotal);
  return { card, costRow };
}

test('the Activity card Cost row opens Side Panel in Minimal and expands in Advanced', async () => {
  test.setTimeout(150_000);
  const minimal = await launchWorktree({ earlyAccess: true, mode: 'minimal' });
  try {
    const { costRow } = await openCostCard(
      minimal.window,
      minimal.cost.expected.scopeTotal,
    );
    await costRow.click();
    await expect.poll(() => sidePanelKinds(minimal.window)).toContain('cost');
    await expect(
      minimal.window.getByTestId('panel-content-cost'),
    ).toBeVisible();
    await expect(
      minimal.window.getByTestId('activity-card-cost-expanded'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(minimal.launched.electronApp, minimal.userDataDir);
  }

  const advanced = await launchWorktree({
    earlyAccess: true,
    mode: 'advanced',
  });
  try {
    const { costRow } = await openCostCard(
      advanced.window,
      advanced.cost.expected.scopeTotal,
    );
    await costRow.click();
    await expect(
      advanced.window.getByTestId('activity-card-cost-expanded'),
    ).toBeVisible();
    await expect(advanced.window.getByTestId('panel-content-cost')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(advanced.launched.electronApp, advanced.userDataDir);
  }
});

test('a subagent chat shows Cost in Details instead of the Usage row in Setup', async () => {
  const { userDataDir, launched, window, cost } = await launchWorktree({
    earlyAccess: true,
    mode: null,
  });
  try {
    await openRootChat(window, cost);
    // With Early access on, the group's plus button opens the add-tab menu.
    await window.getByTestId('panel-add-tab-group-chat').click();
    const menu = window.getByTestId('panel-add-menu');
    await expect(menu).toBeVisible();
    await menu.getByTestId('panel-add-menu-item-subagents').click();
    const panel = window.getByTestId('panel-content-subagents');
    await expect(panel.getByTestId('subagents-panel')).toBeVisible();
    await panel.getByTestId('subagents-root-picker').click();
    await window
      .getByTestId('subagents-root-option-subagent-viewer-root-chat')
      .click();
    await panel.getByTestId('subagents-view-list').click();
    await panel
      .getByTestId(`subagents-list-open-${SUBAGENT_VIEWER_TREE_IDS.idleParent}`)
      .click();
    const subagent = window.getByTestId('subagent-chat-panel');
    await expect(subagent).toBeVisible();
    await subagent.getByTestId('subagent-chat-details-toggle').click();
    const setup = subagent.getByTestId('subagent-chat-details-setup');
    await expect(setup).toBeVisible();
    await expect(
      subagent.getByTestId('subagent-chat-details-cost'),
    ).toBeVisible();
    await expect(setup.getByText('Usage', { exact: true })).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('Early access off has no Activity card, and a subagent chat still shows Cost in Details', async () => {
  const { userDataDir, launched, window, cost } = await launchWorktree({
    earlyAccess: false,
  });
  try {
    // The Activity card itself is part of Early access; cost is not.
    await expect(
      window.getByTestId('worktree-activity-card-toggle'),
    ).toHaveCount(0);
    await expect(window.getByTestId('chat-activity-card-layout')).toHaveCount(
      0,
    );
    await openRootChat(window, cost);
    // With Early access off, the add-panel control opens the add-tab menu.
    await window.locator('[data-testid^="panel-add-panel-"]').first().click();
    const menu = window.getByTestId('panel-add-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('panel-add-menu-item-cost')).toBeVisible();
    await menu.getByTestId('panel-add-menu-item-subagents').click();
    const panel = window.getByTestId('panel-content-subagents');
    await expect(panel.getByTestId('subagents-panel')).toBeVisible();
    await panel.getByTestId('subagents-root-picker').click();
    await window
      .getByTestId('subagents-root-option-subagent-viewer-root-chat')
      .click();
    await panel.getByTestId('subagents-view-list').click();
    await panel
      .getByTestId(`subagents-list-open-${SUBAGENT_VIEWER_TREE_IDS.idleParent}`)
      .click();
    const subagent = window.getByTestId('subagent-chat-panel');
    await expect(subagent).toBeVisible();
    await subagent.getByTestId('subagent-chat-details-toggle').click();
    const setup = subagent.getByTestId('subagent-chat-details-setup');
    await expect(setup).toBeVisible();
    await expect(
      subagent.getByTestId('subagent-chat-details-cost'),
    ).toBeVisible();
    await expect(setup.getByText('Usage', { exact: true })).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('the Activity rail Cost section shows the total and opens the Cost panel, with Early access off', async () => {
  const on = await launchWorktree({ earlyAccess: false, mode: null });
  try {
    const section = on.window.getByTestId('activity-section-cost');
    await expect(section).toBeVisible();
    await expect(section).toContainText(on.cost.expected.scopeTotal);
    await expect(
      section.getByTestId(`cost-chat-row-${on.cost.ids.rootChat}`),
    ).toBeVisible();
    await section.getByTestId('cost-open-panel').click();
    await expect(on.window.getByTestId('panel-content-cost')).toBeVisible();
  } finally {
    await closeCanopy(on.launched.electronApp, on.userDataDir);
  }
});

test('the Activity rail stays mounted while its Cost section loads, so a dialog opened first stays open', async () => {
  const on = await launchWorktree({
    earlyAccess: false,
    mode: null,
    beforeSelect: recordRailSummarySections,
  });
  try {
    const { window } = on;
    // Open a rail dialog before the lazily loaded cost code has arrived.
    await window.getByTestId('pipeline-dispatch-open').click();
    const dialog = window.getByTestId('pipeline-trigger-modal-body');
    await expect(dialog).toBeVisible();

    // The Cost section's total only renders once that code has loaded.
    const section = window.getByTestId('activity-section-cost');
    await expect(section).toContainText(on.cost.expected.scopeTotal);

    // One rail, never replaced: its state, like this dialog, survives.
    expect(await railSummarySections(window)).toEqual({
      count: 1,
      connected: true,
    });
    await expect(dialog).toBeVisible();
  } finally {
    await closeCanopy(on.launched.electronApp, on.userDataDir);
  }
});

test('the Cost panel also opens for a Cowork Work Entry', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cost-cowork-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 0, chatEntryCount: 0 });
  const cost = seedCostInsights({
    userDataDir,
    workspaceId: CHATS_SECTION_NAMED_COWORK_ID,
    worktreeId: CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
    earlyAccess: true,
  });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openChatPage();
    await expandCoworkWorkspace(window, CHATS_SECTION_NAMED_COWORK_ID);
    await window
      .getByTestId(`sidebar-work-entry-${CHATS_SECTION_NAMED_COWORK_ENTRY_ID}`)
      .click();
    await expect(
      window.getByTestId('panel-content-chat').first(),
    ).toBeVisible();
    // Group ids differ by layout; any group's add-panel control opens the menu.
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window
      .getByTestId('panel-add-menu')
      .getByTestId('panel-add-menu-item-cost')
      .click();
    await expect(window.getByTestId('panel-content-cost')).toBeVisible();
    await expect(
      window.getByTestId('panel-content-cost').getByTestId('cost-total'),
    ).toContainText(cost.expected.scopeTotal);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
