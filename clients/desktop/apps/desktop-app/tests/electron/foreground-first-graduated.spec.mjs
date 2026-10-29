import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * Foreground-first delivery graduated out of Settings → Labs: it is always
 * on. A profile that stored the retired `chatForegroundFirstDeliveryEnabled`
 * choice loads without it, Labs offers no toggle, and the next preferences
 * save drops the stored key. `foreground-first-raw-events.spec.mjs` shows
 * routing applies with a stored opt-out.
 *
 * Run: pnpm run build:e2e && pnpm run test:electron:built foreground-first-graduated.spec.mjs --reporter=line
 */

function readStoredPreferences(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences;
}

test('Labs no longer offers foreground-first delivery, and a stored choice is dropped', async () => {
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'canopy-foreground-first-graduated-'),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        chatForegroundFirstDeliveryEnabled: false,
      },
    }),
  );
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    expect(
      await window.evaluate(() =>
        window.api
          .loadPreferences()
          .then((prefs) => 'chatForegroundFirstDeliveryEnabled' in prefs),
      ),
    ).toBe(false);

    await app.openSettings();
    await app.openSettingsSection('experiments');
    // A retained section rendered, so the absence below is meaningful.
    await expect(
      window.getByTestId('settings-renderer-code-cache'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-foreground-first-delivery'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('foreground-first-delivery-toggle'),
    ).toHaveCount(0);
    await app.closeSettings();

    await window.evaluate(() => window.api.savePreferences({}));
    await expect
      .poll(() =>
        Object.hasOwn(
          readStoredPreferences(userDataDir),
          'chatForegroundFirstDeliveryEnabled',
        ),
      )
      .toBe(false);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
