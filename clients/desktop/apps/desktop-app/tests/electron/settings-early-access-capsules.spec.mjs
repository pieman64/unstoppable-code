import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/** Appearance dropdowns keep their capsule geometry across Labs changes. */

function setEarlyAccess(window, enabled) {
  return window.evaluate(
    (value) =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: value,
      }),
    enabled,
  );
}

test('Appearance dropdowns stay capsules across early access changes, in place', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('display');

    const track = window.getByTestId('settings-color-mode-select');
    await expect(track).toBeVisible();
    await expect(track).toHaveClass(/\brounded-full\b/);
    const trackHandle = await track.elementHandle();

    await setEarlyAccess(window, true);
    await expect(track).toHaveClass(/\brounded-full\b/);
    await expect(track).not.toHaveClass(/\brounded-md\b/);
    // Same node: the page's rows were not remounted by the toggle.
    expect(await trackHandle.evaluate((node) => node.isConnected)).toBe(true);

    await setEarlyAccess(window, false);
    await expect(track).toHaveClass(/\brounded-full\b/);
    expect(await trackHandle.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Settings dropdowns share capsules and preserve the scrollbar preference', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('display');
    const scrollbars = window.getByTestId('settings-scrollbar-behavior');
    await expect(scrollbars).toHaveClass(/\brounded-full\b/);
    await scrollbars.selectOption('always');
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('display');
    await expect(scrollbars).toHaveValue('always');
    await expect(scrollbars).toHaveCSS('height', '28px');
    const selects = window
      .getByTestId('settings-tab-display')
      .locator('select');
    expect(await selects.count()).toBeGreaterThanOrEqual(3);
    for (const select of await selects.all())
      await expect(select).toHaveClass(/\brounded-full\b/);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
