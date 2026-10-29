// CAN-4455: use real renderer replacement and real persisted project/chat reads.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedPreferences } from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const workspaceId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';
const chatId = 'renderer-recovery-chat';
const transcript = 'Existing work survives renderer replacement.';

async function closeRecoveryApp(launched, userDataDir) {
  try {
    // Observe the actual child terminal events as well as context closure.
    const child = launched.electronApp.process();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close', {
        signal: AbortSignal.timeout(15_000),
      });
      await Promise.all([launched.electronApp.close(), closed]);
    }
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
}

for (const schemeEnabled of [false, true]) {
  for (const recovery of ['reload', 'crash']) {
    test(`${recovery} preserves projects and chat over ${schemeEnabled ? 'scheme' : 'file'}`, async () => {
      test.setTimeout(120_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-ipc-recovery-'),
      );
      seedPreferences(userDataDir);
      const preferencesPath = path.join(userDataDir, 'preferences.json');
      const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'));
      preferences.preferences.rendererCodeCacheSchemeEnabled = schemeEnabled;
      writeFileSync(preferencesPath, JSON.stringify(preferences));
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId,
        worktreeId,
        activeTabId: chatId,
        tabs: [
          {
            id: chatId,
            title: 'Recovered chat',
            providerType: 'codex',
            model: 'gpt-6-sol',
            blocks: [{ type: 'text', text: transcript }],
          },
        ],
      });
      const launched = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_RENDERER_CODE_CACHE_SCHEME: schemeEnabled ? '1' : '0',
        },
      });
      let recoveryError;
      try {
        const page = await launched.electronApp.firstWindow();
        const driver = new CanopyAppDriver(page);
        const mainPid = await launched.electronApp.evaluate(() => process.pid);
        async function expectExistingWork() {
          await driver.waitForShell({ timeout: 30_000 });
          await driver.openMainPage();
          await driver.selectWorktree(worktreeId, {
            expandDefaultActivityRail: false,
          });
          await expect(
            page.getByTestId(`panel-tab-panel-chat-${chatId}`),
          ).toBeVisible();
          await expect(
            page.getByText(transcript, { exact: true }),
          ).toBeVisible();
          const loaded = await page.evaluate(
            async ({ workspaceId, worktreeId, chatId }) => {
              const projects = await window.api.loadProjects();
              const chat = await window.api.chat.getState({
                projectId: workspaceId,
                worktreeId,
              });
              return {
                project: projects.items.some((item) => item.id === workspaceId),
                chat: chat.tabsFile.tabs.some((tab) => tab.id === chatId),
              };
            },
            { workspaceId, worktreeId, chatId },
          );
          expect(loaded).toEqual({ project: true, chat: true });
          expect(await launched.electronApp.evaluate(() => process.pid)).toBe(
            mainPid,
          );
        }
        await expectExistingWork();
        expect(new URL(page.url()).protocol).toBe(
          schemeEnabled ? 'app-renderer:' : 'file:',
        );
        for (let round = 0; round < 3; round++) {
          await launched.electronApp.evaluate(
            async ({ BrowserWindow }, recovery) => {
              const window = BrowserWindow.getAllWindows().find((candidate) =>
                /(?:index\.html)(?:[?#]|$)/.test(
                  candidate.webContents.getURL(),
                ),
              );
              if (!window) throw new Error('Expected the application window');
              // Playwright's page.waitForEvent rejects on the intentional crash.
              // Observe the surviving WebContents in main through its recovery.
              await new Promise((resolve) => {
                window.webContents.once('did-finish-load', resolve);
                if (recovery === 'crash')
                  window.webContents.forcefullyCrashRenderer();
                else window.webContents.reload();
              });
              // Return to the workspace page just as the driver does before a
              // reload; the last navigation may not have persisted at a crash.
              if (recovery === 'crash') {
                const modifiers = [
                  process.platform === 'darwin' ? 'meta' : 'control',
                ];
                window.webContents.sendInputEvent({
                  type: 'keyDown',
                  keyCode: '2',
                  modifiers,
                });
                window.webContents.sendInputEvent({
                  type: 'keyUp',
                  keyCode: '2',
                  modifiers,
                });
              }
            },
            recovery,
          );
          if (recovery === 'reload') {
            await expectExistingWork();
          } else {
            // Playwright permanently retires a crashed Page. Use Electron's
            // surviving main connection to read the recovered DOM and real IPC.
            await expect
              .poll(
                () =>
                  launched.electronApp.evaluate(
                    async ({ BrowserWindow }, ids) => {
                      const window = BrowserWindow.getAllWindows().find(
                        (candidate) =>
                          /(?:index\.html)(?:[?#]|$)/.test(
                            candidate.webContents.getURL(),
                          ),
                      );
                      if (!window)
                        throw new Error(
                          'Expected the recovered application window',
                        );
                      const result = await window.webContents
                        .executeJavaScript(`(async () => {
                const ids = ${JSON.stringify(ids)};
                const projects = await window.api.loadProjects();
                const chat = await window.api.chat.getState({ projectId: ids.workspaceId, worktreeId: ids.worktreeId });
                if (!document.body.innerText.includes(ids.transcript)) {
                  document.querySelector('[data-testid="worktree-row"][data-worktree-id="' + ids.worktreeId + '"]')?.click();
                  document.querySelector('[data-testid="panel-tab-panel-chat-' + ids.chatId + '"]')?.click();
                }
                return {
                  project: projects.items.some(item => item.id === ids.workspaceId),
                  chat: chat.tabsFile.tabs.some(tab => tab.id === ids.chatId),
                  transcriptVisible: document.body.innerText.includes(ids.transcript),
                };
              })()`);
                      return { ...result, mainPid: process.pid };
                    },
                    { workspaceId, worktreeId, chatId, transcript },
                  ),
                { timeout: 30_000 },
              )
              .toEqual({
                project: true,
                chat: true,
                transcriptVisible: true,
                mainPid,
              });
          }
        }
      } catch (error) {
        recoveryError = error;
      }
      try {
        await closeRecoveryApp(launched, userDataDir);
      } catch (error) {
        if (recoveryError)
          throw new AggregateError(
            [recoveryError, error],
            `Recovery failed: ${String(recoveryError)}; cleanup failed: ${String(error)}`,
          );
        throw error;
      }
      if (recoveryError) throw recoveryError;
    });
  }
}
