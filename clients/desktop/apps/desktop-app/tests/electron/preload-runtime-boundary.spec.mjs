import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const UNSUPPORTED_VM_WARNING =
  "The vm module of Node.js is unsupported in Electron's renderer process";

test('desktop preload avoids renderer vm and still exposes the IPC bridge', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const rendererWarnings = await electronApp.evaluate(
      async ({ BrowserWindow }) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) => !candidate.isDestroyed(),
        );
        if (!mainWindow) {
          throw new Error('Expected the desktop window to exist');
        }

        return await new Promise((resolve, reject) => {
          const messages = [];
          const webContents = mainWindow.webContents;
          const timeout = setTimeout(() => {
            cleanup();
            reject(
              new Error('Timed out waiting for the desktop window reload'),
            );
          }, 15_000);
          const onConsoleMessage = (details) => {
            if (details.level === 'warning' || details.level === 'error') {
              messages.push(details.message);
            }
          };
          const cleanup = () => {
            clearTimeout(timeout);
            webContents.off('console-message', onConsoleMessage);
            webContents.off('did-finish-load', onDidFinishLoad);
          };
          const onDidFinishLoad = () => {
            setTimeout(() => {
              cleanup();
              resolve(messages);
            }, 250);
          };

          webContents.on('console-message', onConsoleMessage);
          webContents.once('did-finish-load', onDidFinishLoad);
          webContents.reload();
        });
      },
    );

    await expect
      .poll(() => window.evaluate(() => typeof window.api))
      .toBe('object');
    expect(
      rendererWarnings.filter((message) =>
        message.includes(UNSUPPORTED_VM_WARNING),
      ),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
