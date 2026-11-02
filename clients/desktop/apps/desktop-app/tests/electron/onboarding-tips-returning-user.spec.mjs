// CAN-5005: returning users, including prior empty chats. The strict snapshot
// handler has an explicit completion counter so negative assertions cannot
// pass just because the history request has not returned yet.
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

for (const scenario of [
  'used target',
  'used sibling',
  'prior empty sibling',
  'old empty target',
  'history elsewhere',
]) {
  test(`${scenario} keeps the composer clear with fresh tips`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can5005-returning-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite', 'ts-npm-next'] });
    const reply = {
      blocks: [{ type: 'text', text: 'An earlier assistant reply.' }],
    };
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      activeTabId: 'current',
      tabs:
        scenario === 'history elsewhere'
          ? []
          : [
              {
                id: 'current',
                title: 'Current chat',
                ...(scenario === 'used target' ? reply : {}),
              },
              ...(scenario.includes('sibling')
                ? [
                    {
                      id: 'older',
                      title: 'Older chat',
                      ...(scenario === 'used sibling' ? reply : {}),
                    },
                  ]
                : []),
            ],
    });
    if (scenario === 'history elsewhere')
      seedWorktreeChat({
        userDataDir,
        workspaceId: 'demo-ts-npm-next',
        worktreeId: 'demo-main',
        tabs: [{ id: 'elsewhere', title: 'Earlier work', ...reply }],
      });
    const { electronApp } = await launchCanopy({
      userDataDir,
      freshOnboardingTips: true,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openWorkflowsTab('runs');
      await expect(
        window.getByTestId('workflows-onboarding-tip'),
      ).toBeVisible();
      await electronApp.evaluate(({ ipcMain }) => {
        const channel = 'desktop:session-snapshot';
        const original = ipcMain._invokeHandlers.get(channel);
        globalThis.__can5005HistoryReads = 0;
        globalThis.__can5005HistoryStarted = 0;
        const gate = new Promise((resolve) => {
          globalThis.__can5005ReleaseHistory = resolve;
        });
        ipcMain._invokeHandlers.set(channel, async (event, args) => {
          const snapshot = await original(event, args);
          if (args?.includeChatSummaries === true) {
            globalThis.__can5005HistoryStarted++;
            await gate;
            globalThis.__can5005HistoryReads++;
          }
          return snapshot;
        });
      });
      await app.openMainPage();
      await window
        .locator(
          '[data-project-id="demo-ts-pnpm-vite"][data-worktree-id="demo-main"]',
        )
        .first()
        .evaluate((element) => element.click());
      await expect(window.getByTestId('chat-input-plus-button')).toBeVisible();
      if (scenario !== 'used target') {
        await expect
          .poll(() =>
            electronApp.evaluate(() => globalThis.__can5005HistoryStarted),
          )
          .toBeGreaterThan(0);
        await expect(
          window.getByTestId('chat-input-onboarding-tip'),
        ).toHaveCount(0);
        await electronApp.evaluate(() => globalThis.__can5005ReleaseHistory());
        await expect
          .poll(() =>
            electronApp.evaluate(() => globalThis.__can5005HistoryReads),
          )
          .toBeGreaterThan(0);
      } else
        await electronApp.evaluate(() => globalThis.__can5005ReleaseHistory());
      // A round trip and a real leave/return flush the UI's snapshot delivery.
      await window.evaluate(() =>
        window.api.getDesktopSessionSnapshot({ includeChatSummaries: true }),
      );
      await app.openWorkflowsTab('runs');
      await app.openMainPage();
      await expect(window.getByTestId('chat-input-onboarding-tip')).toHaveCount(
        0,
      );
      const preferences = JSON.parse(
        readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
      );
      expect(
        preferences.preferences?.onboardingTipsDismissed?.['worktree-chat'],
      ).toBeUndefined();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
