import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('Copilot shows persisted cumulative token counts in the usage popup', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'copilot-usage-tokens-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'copilot',
    tabs: [
      {
        id: 'copilot-usage',
        title: 'Copilot usage',
        model: 'copilot:gpt-5',
        usage: {
          model: 'copilot:gpt-5',
          inputTokens: 12000,
          outputTokens: 800,
          cacheReadInputTokens: 9000,
          cacheCreationInputTokens: 500,
          contextTokens: 0,
          contextWindow: 0,
          maxOutputTokens: 0,
          totalCostUsd: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 2,
        },
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.locator(
      '[data-testid="panel-content-chat"][data-panel-id="panel-chat-copilot-usage"]',
    );
    await panel.getByTestId('usage-indicator').click();
    const popup = window.getByTestId('usage-indicator-popover');
    await expect(popup).toContainText('GitHub Copilot');
    for (const [label, value] of [
      ['Input', '12.0k'],
      ['Output', '800'],
      ['Cache read', '9.0k'],
      ['Cache write', '500'],
    ]) {
      await expect(
        popup.getByText(label, { exact: true }).locator('..'),
      ).toHaveText(`${label}${value}`);
    }
    await expect(popup).not.toContainText('Response tokens');
    await expect(popup).not.toContainText('$0.0000');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Copilot chat popup displays unlimited account allowance', async () => {
  const { launchCopilotSelectionFixture } =
    await import('./fixtures/copilot-selection.mjs');
  const f = await launchCopilotSelectionFixture();
  try {
    await f.managed.setQuotaSnapshots({
      premium_interactions: { isUnlimitedEntitlement: true },
    });
    await f.connect();
    await f.select();
    await f.send('Hello Copilot');
    await expect(
      f.panel.getByText('Copilot fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await f.panel.getByTestId('usage-indicator').click();
    const popup = f.window.getByTestId('usage-indicator-popover');
    await expect(popup).toContainText('Premium requests');
    await expect(popup).toContainText('Unlimited');
    await expect(popup).not.toContainText('0%');
  } finally {
    await f.close();
  }
});

test('Copilot account quotas appear on the Usage page and refresh after connection changes', async () => {
  const { launchCopilotSelectionFixture } =
    await import('./fixtures/copilot-selection.mjs');
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    await f.driver.openUsagePage();
    const card = f.window.getByTestId('usage-provider-card-copilot');
    await expect(card).toBeVisible();
    await expect(card).toContainText('copilot-fixture');
    await expect(card).toContainText('Premium requests');
    await expect(card).toContainText('25.0%');
    await card
      .getByRole('button', { name: 'Refresh GitHub Copilot usage' })
      .click();
    await expect(card).toContainText('25.0%');
    await card.getByTestId('usage-provider-copilot-manage').click();
    await expect(f.window.getByTestId('copilot-connection')).toBeVisible();
    await f.window.getByTestId('copilot-change-account').click();
    await f.approveDeviceCode('copilot-alternate');
    await expect(f.window.getByTestId('copilot-connection-account')).toHaveText(
      'Signed in as copilot-alternate',
    );
    await f.driver.closeSettings();
    await expect(card).toContainText('copilot-alternate');
    await expect(card).not.toContainText('copilot-fixture');
    await card.getByTestId('usage-provider-copilot-manage').click();
    await f.window.getByTestId('copilot-connect').click();
    await expect(f.window.getByTestId('copilot-connection-status')).toHaveText(
      'Ready to connect',
    );
    await f.driver.closeSettings();
    await expect(card).toHaveCount(0);
  } finally {
    await f.close();
  }
});

test('Copilot quotas follow the active chat and have a pinned Usage panel', async () => {
  const { launchCopilotSelectionFixture } =
    await import('./fixtures/copilot-selection.mjs');
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    await f.select();
    for (const variant of ['active-chat', 'copilot']) {
      await f.window.getByTestId('panel-add-panel-group-chat').click();
      await f.window.getByTestId('panel-add-menu-usage-submenu').click();
      await f.window
        .getByTestId(`panel-add-menu-item-usage-${variant}`)
        .click();
      const usage = f.window.locator(
        `[data-testid="usage-panel"][data-variant="${variant}"]`,
      );
      await expect(
        usage.getByTestId('usage-provider-card-copilot'),
      ).toContainText('25.0%');
      await expect(usage).toContainText('copilot-fixture');
    }
  } finally {
    await f.close();
  }
});
