// The composer's existing Usage popover adds the observed Cost preview; its
// detailed link uses the normal Session breakdown panel opener and reuses an
// existing instance on the second use. Neither needs Early access.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCostInsights } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

async function launchUsage({ earlyAccess }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-cost-usage-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const cost = seedCostInsights({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    earlyAccess,
  });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  // Only the active chat's panel is shown; the others stay mounted.
  const chat = window
    .getByTestId('panel-content-chat')
    .filter({ visible: true })
    .first();
  await expect(chat).toBeVisible();
  return { launched, userDataDir, window, chat, cost };
}

test('the Cost row expands and See detailed breakdown opens or focuses Session breakdown', async () => {
  const { launched, userDataDir, window, chat, cost } = await launchUsage({
    earlyAccess: true,
  });
  try {
    const indicator = chat.getByTestId('usage-indicator');
    await indicator.click();
    const popover = window.getByTestId('usage-indicator-popover');
    await expect(popover).toBeVisible();
    const costRow = popover.getByTestId('usage-indicator-cost');
    await expect(costRow).toContainText(
      cost.expected.chats[cost.ids.twoModelChat],
    );
    await costRow.click();
    const sources = popover.getByTestId('usage-indicator-cost-breakdown');
    await expect(sources).toBeVisible();
    // The row lists sources with amounts and shares, not models.
    await expect(sources).toContainText('Chat turns');
    await expect(sources).toContainText('100%');
    await popover.getByTestId('usage-indicator-see-details').click();

    const breakdown = window.getByTestId('session-breakdown-view');
    await expect(breakdown).toBeVisible();
    await expect(breakdown.getByTestId('session-breakdown-meta')).toContainText(
      cost.expected.chats[cost.ids.twoModelChat],
    );
    await expect(
      breakdown.getByTestId('session-breakdown-observed-total'),
    ).toContainText(cost.expected.chats[cost.ids.twoModelChat]);
    await expect(
      window.getByTestId('panel-content-session-breakdown'),
    ).toHaveCount(1);

    // Reopen the popover and repeat the same action: the existing panel is
    // focused rather than duplicated in the panel layout. The breakdown now
    // covers the chat in its group, so bring the chat back first.
    await window
      .getByTestId(`panel-tab-panel-chat-${cost.ids.twoModelChat}`)
      .click();
    await indicator.click();
    const secondPopover = window.getByTestId('usage-indicator-popover');
    await expect(
      secondPopover.getByTestId('usage-indicator-cost'),
    ).toContainText(cost.expected.chats[cost.ids.twoModelChat]);
    await secondPopover.getByTestId('usage-indicator-cost').click();
    await secondPopover.getByTestId('usage-indicator-see-details').click();
    await expect(
      window.getByTestId('panel-content-session-breakdown'),
    ).toHaveCount(1);
    await expect(
      window.getByTestId('panel-content-session-breakdown'),
    ).toBeVisible();
    await expect(
      window.getByTestId('session-breakdown-observed-total'),
    ).toContainText(cost.expected.chats[cost.ids.twoModelChat]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('with Early access off the Usage popover shows the Cost row and opens Session breakdown', async () => {
  const { launched, userDataDir, window, chat, cost } = await launchUsage({
    earlyAccess: false,
  });
  try {
    await chat.getByTestId('usage-indicator').click();
    const popover = window.getByTestId('usage-indicator-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId('usage-indicator-cost')).toContainText(
      cost.expected.chats[cost.ids.twoModelChat],
    );
    await popover.getByTestId('usage-indicator-see-details').click();
    await expect(
      window.getByTestId('session-breakdown-observed-total'),
    ).toContainText(cost.expected.chats[cost.ids.twoModelChat]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
