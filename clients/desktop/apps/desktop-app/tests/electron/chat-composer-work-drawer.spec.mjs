// Grouped composer work: queued and background rows share one anchored list.
// Completed runs retain their job inspector in the shared dialog.
//
// Deterministic: backgroundDrawerScenario seeds the chat's background work,
// and a slow mock turn holds the queue.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { expectDrawerSummaryFits } from './backgroundDrawer.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';
import {
  DRAWER_SCENARIO,
  seedBackgroundDrawerChat,
  startBackgroundDrawerWork,
} from './seeders/backgroundDrawerScenario.mjs';

const { projectId, worktreeId, chatId } = DRAWER_SCENARIO;
// Mock-server scenario markers must match /\[(Canopy-C[A-Za-z0-9_-]+)\]/.
const MARKER = 'Canopy-CWORKDRAWER';

/** The composer box's top, which opening a list must not move. */
function composerTop(window) {
  return window
    .locator('[data-chat-composer-root] [data-composer-layout]')
    .last()
    .evaluate((element) => element.getBoundingClientRect().top);
}

async function sendQueued(window, userMessageId, text) {
  await window.evaluate(
    async (request) => {
      await window.api.chat.sendMessage(request);
    },
    {
      projectId,
      worktreeId,
      chatId,
      userMessageId,
      text,
      providerType: 'claude',
    },
  );
}

test('the grouped work drawer keeps the composer anchored and confirms delegate stops', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'work-drawer-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedBackgroundDrawerChat(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: {
      steps: [
        { text: 'slow active turn', streamMs: 90_000 },
        { text: 'next reply', stopReason: 'end_turn' },
        { text: 'last reply', stopReason: 'end_turn' },
      ],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir, freshOnboardingTips: true }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();
    await startBackgroundDrawerWork(electronApp);

    const drawer = panel.getByTestId('composer-work-drawer');
    const toggle = drawer.getByTestId('composer-work-drawer-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false', {
      timeout: 60000,
    });
    await expect(toggle).toContainText('Needs you');
    const before = await composerTop(window);
    await toggle.click();
    const list = drawer.getByTestId('composer-work-drawer-list');
    await expect(list).toBeVisible();
    expect(await composerTop(window)).toBeCloseTo(before, 0);
    await expect(drawer.locator('[data-work-group]').first()).toHaveAttribute(
      'data-work-group',
      'Needs you',
    );
    const release = drawer
      .locator('[data-tray-row]')
      .filter({ hasText: 'Release checks' });
    const watchers = release.getByRole('button', {
      name: 'Manage pipeline watchers',
      exact: true,
    });
    await expect(watchers).toContainText('Watchers');
    expect(
      await watchers.evaluate(
        (element) => element.parentElement.closest('button') !== null,
      ),
    ).toBe(false);
    await release.getByTestId('background-tray-row-toggle').click();
    await expect(watchers).toBeVisible();
    await watchers.click();
    const watcherDialog = window.getByRole('dialog');
    await expect(watcherDialog).toContainText('Pipeline watchers');
    await watcherDialog
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await release.getByTestId('background-tray-row-toggle').click();
    await expect(watchers).toBeVisible();
    const plan = drawer
      .locator('[data-tray-row]')
      .filter({ hasText: 'Plan review' });
    await plan.getByTestId('background-tray-row-toggle').click();
    await expect(plan.getByTestId('background-tray-run-jobs')).toBeVisible();
    await expect(plan.getByTestId('background-tray-run-question')).toHaveText(
      'The plan touches checkout and billing.',
    );
    const stop = drawer.getByTestId('background-tray-agent-stop').first();
    await stop.scrollIntoViewIfNeeded();
    const square = stop.locator('svg');
    await expect(square).toHaveAttribute('width', '10px');
    await expect(square).toHaveAttribute('height', '10px');
    const stopAll = drawer.getByTestId('background-tray-stop-all');
    await stopAll.scrollIntoViewIfNeeded();
    await stopAll.click();
    const confirmation = window.getByRole('dialog');
    await expect(confirmation).toBeVisible();
    await expect(stopAll).toHaveText('Stop all delegates');
    await confirmation.getByTestId('background-tray-stop-all-cancel').click();
    await expect(confirmation).toHaveCount(0);
    const docs = drawer
      .locator('[data-tray-row]')
      .filter({ hasText: 'Docs link check' });
    const stopDocs = docs.getByRole('button', {
      name: 'Stop run',
      exact: true,
    });
    await stopDocs.scrollIntoViewIfNeeded();
    await stopDocs.click();
    const completed = drawer.getByTestId('background-tray-completed');
    await completed.scrollIntoViewIfNeeded();
    await completed.click();
    const completedDialog = window.getByTestId('completed-work-dialog');
    await expect(completedDialog).toBeVisible();
    await completedDialog.getByTestId('background-tray-row-toggle').click();
    await expect(
      completedDialog.getByTestId('background-tray-run-jobs'),
    ).toBeVisible();
    await completedDialog
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(completedDialog).toHaveCount(0);
    const composer = window.getByRole('textbox').last();
    await composer.fill(`[${MARKER}] first`);
    await composer.press('Enter');
    await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30000,
    });
    await sendQueued(window, 'work-queued-a', 'queued alpha');
    await sendQueued(window, 'work-queued-b', 'queued bravo');
    await expect(toggle).toContainText('Queued2', { timeout: 30000 });
    await expectDrawerSummaryFits(drawer);
    const queued = drawer.getByRole('list', { name: 'Queued messages' });
    await expect(queued.getByTestId('queued-message-preview')).toHaveText([
      'queued alpha',
      'queued bravo',
    ]);
    await queued.getByTestId('queued-message-more').first().click();
    await window.getByTestId('queued-message-interrupt').click();
    await expect(toggle).toContainText('Queued1', { timeout: 60000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await composerTop(window)).toBeCloseTo(before, 0);
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await queued.getByTestId('queued-message-more').first().press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pipeline watcher management uses the shared centered modal and returns focus', async () => {
  test.setTimeout(90000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'drawer-watchers-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedBackgroundDrawerChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    await startBackgroundDrawerWork(electronApp);
    const drawer = window.getByTestId('composer-work-drawer');
    await drawer.getByTestId('composer-work-drawer-toggle').click();
    const release = drawer
      .locator('[data-tray-row]')
      .filter({ hasText: 'Release checks' });
    const watchers = release.getByRole('button', {
      name: 'Manage pipeline watchers',
      exact: true,
    });
    await watchers.click();
    const modal = window.getByTestId('watcher-management-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAccessibleName('Pipeline watchers');
    expect(
      await modal.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    const box = await modal.boundingBox();
    const viewport = await window.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    expect(box?.width).toBeLessThanOrEqual(448);
    expect((box?.x ?? NaN) + (box?.width ?? 0) / 2).toBeCloseTo(
      viewport.width / 2,
      0,
    );
    expect((box?.y ?? NaN) + (box?.height ?? 0) / 2).toBeCloseTo(
      viewport.height / 2,
      0,
    );
    await window.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(watchers).toBeFocused();
    await expect(
      drawer.getByTestId('composer-work-drawer-toggle'),
    ).toHaveAttribute('aria-expanded', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
