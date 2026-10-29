import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * Settings → General → "Agents add to the Feed" (Agent Ledger phase 05, LD09).
 *
 * The switch persists `PreferencesData.ledgerAgentRecordingEnabled`, which
 * decides whether new chat sessions are offered the Ledger tools and the
 * recording prompt. It ships on and is shown only while the
 * `canopy-ledger-enabled` client flag is on.
 *
 * The E2E launcher seeds client flags from the LaunchDarkly-enabled-but-
 * unavailable map, where this flag is `false`, so each test states the flag
 * through the build-gated `CANOPY_E2E_CLIENT_FEATURE_FLAGS` override
 * (`launchCanopy` merges it over the suite defaults). The override produces a
 * `ready` snapshot, the same verdict a live LaunchDarkly evaluation gives.
 *
 * Determinism: no workspace seeding, no live agents, no network. Every write
 * goes through the real Settings UI and the main-process preferences store.
 */

function ledgerFlagEnv(enabled) {
  return {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-ledger-enabled': enabled,
    }),
  };
}

/** The value main hands the renderer (normalized, as agents will read it). */
function readLoadedRecording(window) {
  return window.evaluate(() =>
    window.api
      .loadPreferences()
      .then((preferences) => preferences.ledgerAgentRecordingEnabled),
  );
}

/** The value in `preferences.json` on disk, or undefined before a write. */
function readPersistedRecording(userDataDir) {
  try {
    return JSON.parse(
      readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
    ).preferences?.ledgerAgentRecordingEnabled;
  } catch {
    return undefined;
  }
}

async function openGeneralSettings(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openSettings();
  await app.openSettingsSection('canopy');
  // A neighbouring General section proves the tab rendered, so an absent
  // Ledger row below means the gate, not an empty tab.
  await expect(window.getByTestId('settings-navigation-mode')).toBeVisible();
}

test.describe('Settings General: Agents add to the Feed', () => {
  test('stays hidden while the Ledger flag is off', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      env: ledgerFlagEnv(false),
    });
    try {
      const window = await electronApp.firstWindow();
      await openGeneralSettings(window);

      await expect(
        window.getByTestId('settings-ledger-agent-recording'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('settings-ledger-agent-recording-toggle'),
      ).toHaveCount(0);
      // Hidden is not off: agents still record by default once rolled out.
      expect(await readLoadedRecording(window)).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('is on by default, turns off, and stays off after a relaunch', async () => {
    test.setTimeout(150_000);
    let { electronApp, userDataDir } = await launchCanopy({
      env: ledgerFlagEnv(true),
    });
    try {
      let window = await electronApp.firstWindow();
      await openGeneralSettings(window);

      await expect(
        window.getByRole('heading', { name: 'Feed', exact: true }),
      ).toBeVisible();
      const row = window.getByTestId('settings-ledger-agent-recording');
      await expect(row).toBeVisible();
      await expect(
        row.getByText('Agents add to the Feed', { exact: true }),
      ).toBeVisible();
      await expect(row).toContainText(
        'Agents add and update entries as they work. Turning this off stops them and keeps existing entries.',
      );

      let toggle = window.getByTestId('settings-ledger-agent-recording-toggle');
      await expect(toggle).toHaveAttribute('role', 'switch');
      await expect(toggle).toHaveAccessibleName('Agents add to the Feed');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(toggle).toBeEnabled();
      expect(await readLoadedRecording(window)).toBe(true);

      // Turn it off. The switch settles only after main commits the save.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(toggle).toBeEnabled();
      await expect.poll(() => readLoadedRecording(window)).toBe(false);
      await expect.poll(() => readPersistedRecording(userDataDir)).toBe(false);

      // Leaving and reopening Settings reads the saved choice back.
      await new CanopyAppDriver(window).closeSettings();
      await openGeneralSettings(window);
      toggle = window.getByTestId('settings-ledger-agent-recording-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: ledgerFlagEnv(true),
      }));
      window = await electronApp.firstWindow();
      await openGeneralSettings(window);

      toggle = window.getByTestId('settings-ledger-agent-recording-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(toggle).toBeEnabled();
      expect(await readLoadedRecording(window)).toBe(false);

      // The visible label is the switch's label: clicking it turns recording
      // back on.
      await window
        .getByTestId('settings-ledger-agent-recording')
        .locator('label')
        .click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect.poll(() => readLoadedRecording(window)).toBe(true);
      await expect.poll(() => readPersistedRecording(userDataDir)).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
