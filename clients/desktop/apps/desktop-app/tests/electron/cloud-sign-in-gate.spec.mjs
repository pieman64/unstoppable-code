import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Coverage for the blocking Canopy Cloud sign-in splash gated behind the
// `canopy-cloud-sign-in-required` feature flag (App.tsx + CloudSignInGate).
//
// The suite-wide launch harness disables the sign-in flag by default so other
// specs reach the shell without connecting an account. These tests opt back in
// via an explicit E2E flag override, and reuse the shared cloud mock (any
// `csk_`-prefixed key resolves to the canned authed account) to drive the
// connect transition.

const GATE_ENABLED_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-cloud-sign-in-required': true,
  }),
};

const TEST_CLOUD_API_KEY = 'csk_cloud_sign_in_gate_e2e';

test.describe('Canopy Cloud sign-in gate', () => {
  test('blocks the shell until API-key sign-in and privacy disclosure complete', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-cloud-gate-'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: GATE_ENABLED_ENV,
    });

    try {
      const win = await electronApp.firstWindow();

      // The blocking splash is up; the main shell never renders behind it.
      await expect(win.getByTestId('cloud-sign-in-gate')).toBeVisible({
        timeout: 30_000,
      });
      await expect(win.getByTestId('app-sidebar')).toHaveCount(0);

      await expect(win.getByTestId('cloud-sign-in-gate')).not.toContainText(
        /guest/i,
      );
      // This gate blocks a FRESH install, so it must not reassure the user
      // about work they have not done yet. The guest modal's lead ("nothing
      // you've built gets left behind") lands directly under this gate's own
      // "Connect your account to start building.", which would read as a
      // contradiction; the splash keeps only the half that is true here.
      await expect(win.getByTestId('cloud-sign-in-gate')).not.toContainText(
        /you've built/i,
      );
      await expect(win.getByTestId('cloud-sign-in-gate')).toContainText(
        'Free account, no card required.',
      );
      await win
        .getByTestId('settings-account-canopy-cloud-mode-api-key')
        .click();
      await win
        .getByTestId('settings-account-canopy-cloud-api-key-input')
        .fill(TEST_CLOUD_API_KEY);
      await win
        .getByTestId('settings-account-canopy-cloud-api-key-submit')
        .click();

      // Signing in shows no activity-sharing prompt: sharing is off by
      // default, so there is nothing to disclose.
      // The gate disappears and the shell renders without a restart.
      await expect(win.getByTestId('cloud-sign-in-gate')).toHaveCount(0, {
        timeout: 30_000,
      });
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await expect(win.getByTestId('telemetry-optin-modal')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('opens straight to the shell when the flag is off, even disconnected', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-cloud-gate-off-'),
    );
    // No env override → the harness default keeps the gate disabled.
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await expect(win.getByTestId('cloud-sign-in-gate')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
