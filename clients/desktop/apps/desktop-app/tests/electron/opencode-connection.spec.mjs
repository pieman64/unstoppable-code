import { CanopyAppDriver } from './canopyApp.mjs';
import { expect, test } from '@playwright/test';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { openCodeConnectionFixture } from './fixtures/opencode-connection.mjs';

// Real main/preload persistence and real mounted availability hook; only the
// downloaded provider executable is a deterministic offline ACP fixture.
for (const initiallyConnected of [false, true]) {
  test(`mounted OpenCode availability follows ${initiallyConnected ? 'disconnect' : 'connect'}`, async () => {
    const fixture = await openCodeConnectionFixture();
    let launched;
    try {
      launched = await launchCanopy({ env: fixture.env });
      const window = await launched.electronApp.firstWindow();
      if (initiallyConnected)
        await window.evaluate(() => window.api.opencodeConnection.connect());
      await window.goto(fixture.url);
      await expect(window.getByTestId('availability')).toHaveText(
        initiallyConnected ? 'available' : 'unavailable',
      );
      const operation = initiallyConnected ? 'disconnect' : 'connect';
      await window.getByTestId(operation).click();
      await expect(window.getByTestId('operation')).toHaveText(operation, {
        timeout: 30_000,
      });
      await expect(window.getByTestId('availability')).toHaveText(
        initiallyConnected ? 'unavailable' : 'available',
      );
      expect(
        (await window.evaluate(() => window.api.loadPreferences()))
          .opencodeEnabled,
      ).toBe(!initiallyConnected);
    } finally {
      if (launched)
        await closeCanopy(launched.electronApp, launched.userDataDir);
      await fixture.close();
    }
  });
}

test('Advisor cancellation stops OpenCode download and cannot enable the provider later', async () => {
  const fixture = await openCodeConnectionFixture({ holdArchive: true });
  let launched;
  let response;
  try {
    launched = await launchCanopy({ env: fixture.env });
    const main = await launched.electronApp.firstWindow();
    await new CanopyAppDriver(main).waitForShell();
    response = launched.electronApp.evaluate(({ BrowserWindow, ipcMain }) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (window) =>
          !window.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window missing');
      ipcMain.removeHandler('app-advisor:tool-response');
      return new Promise((resolve) => {
        ipcMain.handleOnce('app-advisor:tool-response', (_event, result) =>
          resolve(result),
        );
        mainWindow.webContents.send('app-advisor:tool-request', {
          kind: 'dispatch_action',
          requestId: 'opencode-cancel-download',
          action: { type: 'opencode.connection', operation: 'connect' },
        });
      });
    });
    // Keep a rejection observed if app teardown follows a failed assertion.
    void response.catch(() => undefined);
    await expect.poll(fixture.archiveRequests).toBe(1);
    await launched.electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (window) =>
          !window.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window missing');
      mainWindow.webContents.send('app-advisor:tool-request-cancelled', {
        requestId: 'opencode-cancel-download',
      });
    });
    await expect.poll(fixture.abortedRequests).toBe(1);
    fixture.releaseArchive();
    expect((await response).ok).toBe(false);
    expect(
      (await main.evaluate(() => window.api.loadPreferences())).opencodeEnabled,
    ).toBe(false);
    expect(
      await main.evaluate(() => window.api.opencodeConnection.listModels()),
    ).toEqual([]);
  } finally {
    fixture.releaseArchive();
    if (launched) await closeCanopy(launched.electronApp, launched.userDataDir);
    await fixture.close();
  }
});
