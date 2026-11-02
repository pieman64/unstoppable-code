import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { cursorRuntimeFixture } from './fixtures/cursor-runtime.mjs';
import { expectCursorConnected } from './fixtures/cursor-tile.mjs';

for (const { name, reported, failedFile, followUpFailure, earlierFork } of [
  {
    name: 'remains unknown when the runtime sends no counters',
    reported: false,
  },
  { name: 'shows native response counters', reported: true },
  {
    name: 'clears counters when the next turn fails initialization',
    reported: true,
    followUpFailure: true,
  },
  {
    name: 'omits future response counters from an earlier fork',
    reported: true,
    earlierFork: true,
  },
  ...['usage-hook.cjs', 'usage-connection.json'].map((failedFile) => ({
    name: `does not interrupt a reply when ${failedFile} cannot be written`,
    reported: false,
    failedFile,
  })),
]) {
  test(`Cursor usage ${name}`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-usage-e2e-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'cursor',
      tabs: [
        {
          id: 'cursor-usage',
          title: 'Cursor usage',
          model: 'cursor-default',
          hasStartedSession: true,
        },
      ],
    });
    const managed = await cursorRuntimeFixture();
    let launched = await launchCanopy({ userDataDir, env: managed.env });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
      await driver.closeSettings();
      await driver.openMainPage();
      await driver.selectWorktree('demo-main');
      const panel = window.locator(
        '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-usage"]',
      );
      if (earlierFork) {
        await panel
          .getByRole('textbox')
          .first()
          .fill('CURSOR_CHAT_E2E_CONTEXT_SET: ORCHID-62');
        await panel
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
        await expect(
          panel.getByText('Context code: ORCHID-62.', { exact: true }),
        ).toBeVisible();
        await expect(
          panel.getByRole('button', { name: 'Stop generation', exact: true }),
        ).toHaveCount(0);
      }
      if (failedFile) {
        await launched.electronApp.evaluate((_, filename) => {
          const fs = process.getBuiltinModule('fs/promises');
          const { syncBuiltinESMExports } = process.getBuiltinModule('module');
          const write = fs.writeFile;
          globalThis.cursorUsageWriteFault = false;
          // Fault only the optional usage file in the actual main-process
          // setup. Keep approval and transcript persistence on real I/O.
          fs.writeFile = async (file, ...args) => {
            if (String(file).endsWith(`/${filename}`)) {
              fs.writeFile = write;
              syncBuiltinESMExports();
              globalThis.cursorUsageWriteFault = true;
              throw Object.assign(new Error('Usage fixture write denied'), {
                code: 'EACCES',
              });
            }
            return write(file, ...args);
          };
          syncBuiltinESMExports();
        }, failedFile);
      }
      await panel
        .getByRole('textbox')
        .first()
        .fill(
          reported
            ? earlierFork
              ? 'CURSOR_CHAT_E2E_USAGE_ACTIVE'
              : 'CURSOR_CHAT_E2E_USAGE'
            : 'CURSOR_CHAT_E2E_CONTEXT_SET: ORCHID-62',
        );
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      if (failedFile) {
        await expect
          .poll(() =>
            launched.electronApp.evaluate(
              () => globalThis.cursorUsageWriteFault,
            ),
          )
          .toBe(true);
      }
      await expect(
        panel.getByText(
          reported ? 'Usage response complete.' : 'Context code: ORCHID-62.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(earlierFork ? 1 : 0);
      await panel.getByTestId('usage-indicator').click();
      const usage = window.getByTestId('usage-indicator-popover');
      if (reported) {
        await expect(usage).toContainText('12.0k');
        await expect(usage).toContainText('800');
        await expect(usage).toContainText('9.0k');
        await expect(usage).toContainText('500');
        await expect(usage).toContainText('Latest reported response');
      } else {
        await expect(usage).toContainText(
          'Cursor has not reported token usage.',
        );
        await expect(usage).not.toContainText('Cache read');
      }
      await expect(usage).not.toContainText('$0.0000');
      await expect(usage).not.toContainText('200.0k');
      await expect(usage).not.toContainText(
        'Usage appears after the first reply.',
      );
      if (followUpFailure || earlierFork) {
        await panel.getByTestId('usage-indicator').click();
        let targetPanel = panel;
        if (followUpFailure) {
          await launched.electronApp.evaluate(() => {
            const fs = process.getBuiltinModule('fs/promises');
            const { syncBuiltinESMExports } =
              process.getBuiltinModule('module');
            const original = fs.mkdtemp;
            fs.mkdtemp = async (prefix, ...args) => {
              if (String(prefix).includes('cursor-chat-hook-')) {
                fs.mkdtemp = original;
                syncBuiltinESMExports();
                throw new Error('Cursor startup fixture failure');
              }
              return original(prefix, ...args);
            };
            syncBuiltinESMExports();
          });
          await panel
            .getByRole('textbox')
            .first()
            .fill('Follow up after a reported response');
          await panel
            .getByRole('button', { name: 'Send message', exact: true })
            .click();
          await expect(
            panel.getByText('Error: Cursor startup fixture failure', {
              exact: true,
            }),
          ).toBeVisible();
        } else {
          // The completed first turn and active second turn each expose a
          // fork control. Choose the completed turn, before these counters.
          await expect(
            panel.getByRole('button', { name: 'Fork chat', exact: true }),
          ).toHaveCount(2);
          await panel
            .getByRole('button', { name: 'Fork chat', exact: true })
            .first()
            .click();
          const saved = await window.evaluate(() =>
            window.api.chat.loadTabs({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            }),
          );
          const fork = saved.tabs.find(
            (tab) => tab.forkedFrom?.chatId === 'cursor-usage',
          );
          expect(fork).toBeTruthy();
          targetPanel = window.locator(
            `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${fork.id}"]`,
          );
          await expect(
            targetPanel.getByText('Context code: ORCHID-62.', { exact: true }),
          ).toBeVisible();
          await expect(
            targetPanel.getByText('Usage response complete.', { exact: true }),
          ).toHaveCount(0);
        }
        await targetPanel.getByTestId('usage-indicator').click();
        await expect(usage).toContainText(
          'Cursor has not reported token usage.',
        );
        await expect(usage).not.toContainText('12.0k');
        return;
      }
      if (reported) {
        await closeCanopy(launched.electronApp, launched.userDataDir, {
          keepUserData: true,
        });
        launched = await launchCanopy({ userDataDir, env: managed.env });
        const restoredWindow = await launched.electronApp.firstWindow();
        const restoredDriver = new CanopyAppDriver(restoredWindow);
        await restoredDriver.waitForShell();
        await restoredDriver.openMainPage();
        await restoredDriver.selectWorktree('demo-main');
        const restoredPanel = restoredWindow.locator(
          '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-usage"]',
        );
        await restoredPanel.getByTestId('usage-indicator').click();
        const restoredUsage = restoredWindow.getByTestId(
          'usage-indicator-popover',
        );
        await expect(restoredUsage).toContainText('12.0k');
        await expect(restoredUsage).not.toContainText('200.0k');
        await restoredPanel.getByTestId('usage-indicator').click();
        await restoredPanel
          .getByRole('textbox')
          .first()
          .fill('CURSOR_CHAT_E2E_CONTEXT_SET: ORCHID-62');
        await restoredPanel
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
        await expect(
          restoredPanel.getByText('Context code: ORCHID-62.', { exact: true }),
        ).toBeVisible();
        await expect(
          restoredPanel.getByRole('button', {
            name: 'Stop generation',
            exact: true,
          }),
        ).toHaveCount(0);
        await restoredPanel.getByTestId('usage-indicator').click();
        await expect(restoredUsage).toContainText(
          'Cursor has not reported token usage.',
        );
        await expect(restoredUsage).not.toContainText('12.0k');
      }
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}
