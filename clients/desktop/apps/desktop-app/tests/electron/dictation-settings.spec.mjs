import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('Dictation settings request access flow resolves and re-enables the button', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_VOICE_ACCESS_FLOW: 'grant-after-request',
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();

    // Stub before navigating to dictation; the panel has not mounted yet.
    await window.evaluate(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => ({
            getTracks: () => [
              {
                stop: () => {
                  window.__dictationTestTrackStopped = true;
                },
              },
            ],
          }),
        },
      });
    });

    await app.openSettings();
    await app.openSettingsSection('dictation');

    const requestAccess = window.getByTestId('dictation-request-access');
    await expect(requestAccess).toBeEnabled();
    await requestAccess.click();

    await expect(requestAccess).toHaveText(/Requesting/);
    await expect(window.getByTestId('dictation-mic-status-text')).toHaveText(
      /Checking/,
    );
    await expect(window.getByTestId('dictation-speech-status-text')).toHaveText(
      /Checking/,
    );
    await expect(requestAccess).toHaveText('Request access');
    await expect(requestAccess).toBeEnabled();
    await expect(window.getByTestId('dictation-mic-status-text')).toHaveText(
      /Granted/,
    );
    await expect(window.getByTestId('dictation-speech-status-text')).toHaveText(
      /Granted/,
    );
    await expect
      .poll(() => window.evaluate(() => window.__dictationTestTrackStopped))
      .toBe(true);

    await window.screenshot({
      path: testInfo.outputPath('dictation-settings-request-access.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
