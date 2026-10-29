import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readMainWindowZoomFactor } from './uiScale.mjs';

/**
 * Interface-scale shortcuts (View → Zoom In / Zoom Out / Actual Size).
 *
 * Covers the whole loop the feature depends on: the View menu carries the
 * items from first launch with no setting to turn on, and they step the
 * persisted `uiScale` rather than moving `webContents` zoom directly. The
 * assertions deliberately check BOTH the live zoom factor and the saved
 * preference after every command — Electron's built-in
 * `zoomIn`/`zoomOut`/`resetZoom` roles would satisfy the first and silently
 * fail the second, which is the regression this guards.
 *
 * A headless run cannot press a native accelerator, so the items are invoked
 * through `Menu.getApplicationMenu()` → `item.click()`, which is the same
 * code path the accelerator reaches. Real OS key delivery stays a manual
 * check.
 */

const EXPECTED_ZOOM_MENU = [
  'Zoom In|CommandOrControl+Plus',
  'Zoom In|CommandOrControl+=',
  'Zoom Out|CommandOrControl+-',
  'Actual Size|CommandOrControl+0',
];

function readPreferencesFile(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences;
}

/** Lists the View menu's items as `label|accelerator` in the live menu. */
function readZoomMenuLabels(electronApp) {
  return electronApp.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const view = menu?.items.find((item) => item.label === 'View');
    if (!view?.submenu) return [];
    return view.submenu.items
      .filter((item) => item.type !== 'separator')
      .map((item) => `${item.label}|${item.accelerator ?? ''}`);
  });
}

/**
 * Clicks a View-menu item by label, taking the first match so the visible
 * `CommandOrControl+Plus` Zoom In is used rather than its hidden `=` twin.
 * Returns false when no such item exists.
 */
function clickZoomMenuItem(electronApp, label) {
  return electronApp.evaluate(({ Menu }, wanted) => {
    const menu = Menu.getApplicationMenu();
    const view = menu?.items.find((item) => item.label === 'View');
    const target = view?.submenu?.items.find((item) => item.label === wanted);
    if (!target) return false;
    target.click();
    return true;
  }, label);
}

function readSavedUiScale(window) {
  return window.evaluate(() =>
    window.api.loadPreferences().then((prefs) => prefs.uiScale),
  );
}

/** Polls until the persisted scale, the live zoom and the DOM all agree. */
async function expectScaleEverywhere(window, electronApp, scale) {
  await expect
    .poll(() => readSavedUiScale(window), {
      message: `uiScale did not persist as ${scale}`,
    })
    .toBe(scale);
  await expect
    .poll(() => readMainWindowZoomFactor(electronApp), {
      message: `window zoom did not follow uiScale ${scale}`,
    })
    .toBeCloseTo(scale / 100, 5);
  await expect
    .poll(() =>
      window.evaluate(() =>
        document.documentElement.getAttribute('data-ui-scale'),
      ),
    )
    .toBe(String(scale));
}

async function chooseInterfaceScale(window, scale) {
  await window.getByTestId('settings-ui-scale-select').click();
  await window.getByTestId(`settings-ui-scale-option-${scale}`).click();
}

test('View-menu zoom items step the saved interface scale from a fresh profile', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-interface-scale-fresh-'),
  );
  let launched = await launchCanopy({ userDataDir });
  try {
    let window = await launched.electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();

    // --- Present from first launch, before Settings is ever opened -------
    expect(await readZoomMenuLabels(launched.electronApp)).toEqual(
      expect.arrayContaining(EXPECTED_ZOOM_MENU),
    );
    await expectScaleEverywhere(window, launched.electronApp, 100);

    // --- Two Zoom In steps -----------------------------------------------
    expect(await clickZoomMenuItem(launched.electronApp, 'Zoom In')).toBe(true);
    await expectScaleEverywhere(window, launched.electronApp, 105);
    expect(await clickZoomMenuItem(launched.electronApp, 'Zoom In')).toBe(true);
    await expectScaleEverywhere(window, launched.electronApp, 110);

    // The Display dropdown is the other writer of the same preference, so it
    // must show what the shortcuts did.
    await app.openSettings();
    await app.openSettingsSection('display');
    const scaleSelect = window.getByTestId('settings-ui-scale-select');
    await expect(scaleSelect).toContainText('110%');
    await scaleSelect.click();
    const menu = window.getByRole('listbox', { name: 'Interface scale' });
    await expect(menu.getByRole('option')).toHaveCount(31);
    await expect(window.getByTestId('settings-ui-scale-option-50')).toHaveText(
      '50%',
    );
    await expect(window.getByTestId('settings-ui-scale-option-200')).toHaveText(
      '200%',
    );
    await window.keyboard.press('Escape');

    // --- Zoom Out and Actual Size ----------------------------------------
    expect(await clickZoomMenuItem(launched.electronApp, 'Zoom Out')).toBe(
      true,
    );
    await expectScaleEverywhere(window, launched.electronApp, 105);
    await expect(scaleSelect).toContainText('105%');
    expect(await clickZoomMenuItem(launched.electronApp, 'Actual Size')).toBe(
      true,
    );
    await expectScaleEverywhere(window, launched.electronApp, 100);
    await expect(scaleSelect).toContainText('100%');

    // --- Both ends of the range clamp instead of overshooting ------------
    await chooseInterfaceScale(window, 195);
    await expectScaleEverywhere(window, launched.electronApp, 195);
    expect(await clickZoomMenuItem(launched.electronApp, 'Zoom In')).toBe(true);
    await expectScaleEverywhere(window, launched.electronApp, 200);
    expect(await clickZoomMenuItem(launched.electronApp, 'Zoom In')).toBe(true);
    await expectScaleEverywhere(window, launched.electronApp, 200);
    await expect(scaleSelect).toContainText('200%');

    await chooseInterfaceScale(window, 55);
    await expectScaleEverywhere(window, launched.electronApp, 55);
    expect(await clickZoomMenuItem(launched.electronApp, 'Zoom Out')).toBe(
      true,
    );
    await expectScaleEverywhere(window, launched.electronApp, 50);
    expect(await clickZoomMenuItem(launched.electronApp, 'Zoom Out')).toBe(
      true,
    );
    await expectScaleEverywhere(window, launched.electronApp, 50);
    await expect(scaleSelect).toContainText('50%');

    expect(await clickZoomMenuItem(launched.electronApp, 'Actual Size')).toBe(
      true,
    );
    await expectScaleEverywhere(window, launched.electronApp, 100);

    // --- The retired Experiments switch is gone --------------------------
    await app.openSettingsSection('experiments');
    await expect(
      window.getByTestId('settings-renderer-code-cache'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-interface-scale-shortcuts'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('interface-scale-shortcuts-toggle'),
    ).toHaveCount(0);
    await window.getByTestId('settings-renderer-code-cache').screenshot({
      path: testInfo.outputPath('experiments-retained-section.png'),
      animations: 'disabled',
    });

    // --- A stepped scale survives a relaunch -----------------------------
    expect(await clickZoomMenuItem(launched.electronApp, 'Zoom In')).toBe(true);
    await expectScaleEverywhere(window, launched.electronApp, 105);
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });

    launched = await launchCanopy({ userDataDir });
    window = await launched.electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    expect(await readZoomMenuLabels(launched.electronApp)).toEqual(
      expect.arrayContaining(EXPECTED_ZOOM_MENU),
    );
    await expectScaleEverywhere(window, launched.electronApp, 105);
    expect(await clickZoomMenuItem(launched.electronApp, 'Actual Size')).toBe(
      true,
    );
    await expectScaleEverywhere(window, launched.electronApp, 100);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

// Profiles that turned the retired experiment off (or never touched it, which
// saved `false`) are the population whose behavior changes on upgrade.
test('an upgraded profile that had the experiment off gets the zoom items', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-interface-scale-legacy-'),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          uiScale: 150,
          interfaceScaleShortcutsEnabled: false,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    expect(await readZoomMenuLabels(launched.electronApp)).toEqual(
      expect.arrayContaining(EXPECTED_ZOOM_MENU),
    );
    await expectScaleEverywhere(window, launched.electronApp, 150);
    const loaded = await window.evaluate(() => window.api.loadPreferences());
    expect(loaded).not.toHaveProperty('interfaceScaleShortcutsEnabled');

    expect(await clickZoomMenuItem(launched.electronApp, 'Zoom Out')).toBe(
      true,
    );
    await expectScaleEverywhere(window, launched.electronApp, 145);
    // The save that persisted the new scale went through normalization, so
    // the retired field is no longer on disk.
    await expect
      .poll(() => readPreferencesFile(userDataDir))
      .toMatchObject({ uiScale: 145 });
    expect(readPreferencesFile(userDataDir)).not.toHaveProperty(
      'interfaceScaleShortcutsEnabled',
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
