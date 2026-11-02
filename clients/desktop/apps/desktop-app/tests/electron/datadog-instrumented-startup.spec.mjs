import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * CAN-5049: every preload blocks in the Datadog SDK's sync
 * `datadog:bridge-config` request. internal-433 put a callback in that reply,
 * Electron could not clone it, no reply was sent, and every window stayed
 * blank. Datadog is compiled in, so this needs a build made with
 * CANOPY_DATADOG_ENABLED=true (the UI automation internal-variant job).
 */
test('a Datadog-enabled build mounts the app with the renderer bridge installed', async () => {
  test.skip(
    process.env.CANOPY_DATADOG_ENABLED !== 'true',
    'Needs a Datadog-enabled build',
  );
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await expect
      .poll(() =>
        window.evaluate(() => window.DatadogEventBridge?.getPrivacyLevel()),
      )
      .toBe('mask');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
