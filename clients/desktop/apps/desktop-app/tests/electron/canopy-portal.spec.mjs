import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// The Canopy Cloud mock now lives in the shared suite-wide mock server
// (apps/desktop-app/tests/electron/mock-server), started by the Playwright
// `webServer` config (Doc 4 §0). This spec just uses a per-test API key against
// it; the app targets the build-time-bundled CANOPY_CLOUD_BASE_URL (4011).
const TEST_API_KEY = 'csk_portal_e2e';

/**
 * CAN-3659: Remote Control has no sidebar nav row or More item on desktop;
 * the account menu lists it. Leaves the menu closed.
 */
async function expectRemoteControlOnlyInAccountMenu(window) {
  await expect(window.getByTestId('sidebar-nav-remote-control')).toHaveCount(0);
  await window.getByTestId('sidebar-more').click();
  await expect(
    window.getByTestId('sidebar-more-item-remote-control'),
  ).toHaveCount(0);
  await window.keyboard.press('Escape');
  await window.getByTestId('sidebar-account-row').click();
  await expect(
    window.getByTestId('sidebar-account-menu-item-remote-control'),
  ).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('sidebar-account-menu')).toHaveCount(0);
}

test('opens Canopy Portal from the sidebar and links to account settings', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    // CAN-3659: Remote Control opens from the account menu; the sidebar nav
    // no longer lists it.
    await expectRemoteControlOnlyInAccountMenu(window);

    await app.openCanopyPortal();
    const noAccount = window.getByTestId('canopy-portal-no-account');
    const loadError = window.getByRole('alert');

    await expect(noAccount.or(loadError)).toBeVisible();
    if (await noAccount.isVisible()) {
      await window.getByRole('button', { name: 'Open settings' }).click();
      // CAN-4421: the cloud account is the hosted Account page.
      await app.expectAccountSettingsPage('account');
    }

    await window.screenshot({
      path: testInfo.outputPath('canopy-portal-sidebar-modal.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-936 (WS3): the no-account state offers an inline "Sign in to enable
// Remote Control" CTA that routes through the shared cloud connect gate
// (CloudSyncModal) instead of kicking the user out to Settings. On connect the
// shared modal closes itself and fires a persistent "Sign in successful" toast,
// and the Portal — still mounted underneath — recomputes cloudReady on
// CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT and advances to the Enable state with no
// restart and no Settings trip.
test('signs in from the Portal no-account state via the shared cloud modal and advances to Enable', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openCanopyPortal();

    // No account connected yet: the inline sign-in CTA is present.
    await expect(window.getByTestId('canopy-portal-no-account')).toBeVisible();
    const signIn = window.getByTestId('canopy-portal-sign-in');
    await expect(signIn).toBeVisible();

    // Click it → the shared cloud connect gate opens the common CloudSyncModal.
    await signIn.click();
    await expect(window.getByTestId('cloud-sync-modal')).toBeVisible();

    // Connect a mock Canopy Cloud account, then broadcast the same change event
    // the account section fires so the Portal modal (still mounted underneath)
    // recomputes `cloudReady` live and advances past the no-account state.
    //
    // Harness note: the browser OAuth loopback cannot complete headlessly, so
    // save the account through the real IPC and broadcast the same change event
    // the account section emits. The auth hook's recovery effect observes the
    // now-real account, invokes `onReadyToContinue`, and lets the gate close
    // itself through the same resume path as the real OAuth completion.
    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      TEST_API_KEY,
    );
    expect(saveResult.status.authenticated).toBe(true);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    // The recovery effect closes the gate and runs `proceed` without a second
    // gesture. Pressing Escape here would race that close and could dismiss the
    // underlying Portal modal instead.
    await expect(window.getByTestId('cloud-sync-modal')).toHaveCount(0);

    // The Portal has advanced past the no-account state to the Enable CTA — no
    // restart, no Settings trip.
    await expect(window.getByTestId('canopy-portal-no-account')).toHaveCount(0);
    await expect(window.getByTestId('canopy-portal-enable')).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('canopy-portal-inline-sign-in.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('starts Portal without requiring a serverId argument', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();

    const saveResult = await window.evaluate(async (apiKey) => {
      return window.api.saveCanopyCloudApiKey({ apiKey });
    }, TEST_API_KEY);
    expect(saveResult.status.authenticated).toBe(true);
    expect(saveResult.status.missingCapabilities).toEqual([]);
    expect(saveResult.account.hasApiKey).toBe(true);
    expect(saveResult.account.account?.email).toBe('portal-e2e@example.test');

    const startResult = await window.evaluate(async () => {
      try {
        await window.api.canopyPortal.start();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    if (!startResult.ok) {
      throw new Error(startResult.error);
    }

    await app.openCanopyPortal();
    await expect(
      window.getByTestId('canopy-portal-pending-auth'),
    ).toBeVisible();

    // CAN-2938: the QR code is the primary path. It names this machine, and
    // the 6-digit code stays beneath it as the manual fallback.
    const qrImage = window.getByTestId('canopy-portal-pairing-qr-image');
    await expect(qrImage).toBeVisible();
    const pending = await window.evaluate(() =>
      window.api.canopyPortal.getState(),
    );
    expect(pending.machineName).toBeTruthy();
    await expect(
      window.getByTestId('canopy-portal-pairing-qr-instruction'),
    ).toHaveText(
      `Scan with your phone's camera to connect ${pending.machineName}.`,
    );
    await expect(qrImage).toHaveAttribute(
      'alt',
      `QR code to connect ${pending.machineName} to Remote Control`,
    );
    await expect(
      window.getByTestId('canopy-portal-pairing-code-value'),
    ).toHaveText(pending.pairingCode);
    await expect(
      window.getByTestId('canopy-portal-pairing-manual-fallback'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('canopy-portal-configured-cloud.png'),
    });

    // Regenerating the code regenerates the QR code with it.
    const firstQr = await qrImage.getAttribute('src');
    await window.getByTestId('canopy-portal-regenerate').click();
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.canopyPortal.getState()))
            .pairingCode,
      )
      .not.toBe(pending.pairingCode);
    await expect(
      window.getByTestId('canopy-portal-pending-auth'),
    ).toBeVisible();
    await expect(qrImage).toBeVisible();
    await expect(qrImage).not.toHaveAttribute('src', firstQr ?? '');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// PR 715 (Doc 2 Spec 12 / Doc 14): when the `canopy-portal-enabled` client
// feature flag resolves to `false`, the Portal sidebar entry must be absent.
// The two tests above assert it PRESENT under the suite default (the E2E
// override pins `canopy-portal-enabled: true`, matching the not-configured
// baseline); this test drives the LaunchDarkly enabled-but-unavailable path so
// the flag falls back to `false`.
//
// FAITHFULNESS NOTE: the original spec intent is to launch with
// `env: { LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID: 'bogus-e2e-id' }`. However, the
// shared `launchCanopy` helper unconditionally deletes
// `LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID` from the Electron env (launchCanopy.mjs:
// "Never honor an inherited LaunchDarkly client-side ID in tests"), and this
// spec owns only the two test files — not the launch helper. So instead we set
// the bogus client-side ID directly on the *main process* env and then trigger
// the REAL feature-flag service to (re)initialize through the production IPC
// path (`window.api.featureFlags.refreshContext()`). The suite-wide E2E
// override pins the baseline flag values, but a configured client-side ID takes
// precedence over that override in `initialize()`, so injecting the bogus ID
// makes the unpackaged build initialize the LaunchDarkly client, which fails to
// authenticate (HTTP 401), driving the documented enabled-but-unavailable
// fallback → `canopy-portal-enabled: false`. This is the genuine production
// code path (apps/desktop-app/src/main/feature-flags/service.ts), not a faked
// snapshot: the resulting snapshot is pushed to the renderer over the real
// `featureFlagsSnapshotChanged` IPC channel, which hides the sidebar entry.
// (The same fallback also resolves `canopy-cloud-sign-in-required: true`, so
// after the refresh the blocking Cloud sign-in gate takes over the shell — the
// Portal entry is gone either way, which is what the assertions below verify.)
test('hides the Canopy Portal sidebar entry when the feature flag resolves off', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();

    // Baseline: the suite-wide E2E override pins `canopy-portal-enabled: true`,
    // so the account menu lists Remote Control (CAN-3659, matching the tests
    // above).
    await expectRemoteControlOnlyInAccountMenu(window);

    // Inject a bogus LaunchDarkly client-side ID into the main process env so
    // the next initialize() reads it (the bundled value is empty in this
    // unpackaged build).
    await electronApp.evaluate(async () => {
      process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'bogus-e2e-id';
    });

    // Trigger the real feature-flag service to (re)initialize against the bogus
    // ID. The override snapshot leaves the service with a null LD client, so
    // refreshContext() routes through initialize(); a configured client-side ID
    // now takes precedence over the E2E override, so initialize() attempts a
    // live LaunchDarkly connection, fails on the bogus ID, and resolves to the
    // enabled-but-unavailable fallback (`canopy-portal-enabled: false`).
    const snapshot = await window.evaluate(async () =>
      window.api.featureFlags.refreshContext(),
    );
    expect(snapshot.values['canopy-portal-enabled']).toBe(false);

    // The flag-off snapshot is pushed to the renderer over the real IPC channel
    // and the account menu drops its Remote Control item (CAN-3659). The nav
    // never lists it. Open the "More" popover and the account menu (if the
    // shell still shows them) before checking their entries.
    // (The same fallback also flips on the Cloud sign-in gate, which may replace
    // the shell — in that case both triggers are absent too, so the items are
    // absent either way.)
    await expect(window.getByTestId('sidebar-nav-remote-control')).toHaveCount(
      0,
    );
    const moreTrigger = window.getByTestId('sidebar-more');
    if (await moreTrigger.isVisible().catch(() => false)) {
      await moreTrigger.click();
    }
    await expect(
      window.getByTestId('sidebar-more-item-remote-control'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    const accountRow = window.getByTestId('sidebar-account-row');
    if (await accountRow.isVisible().catch(() => false)) {
      await accountRow.click();
      await expect(
        window.getByTestId('sidebar-account-menu-item-remote-control'),
      ).toHaveCount(0);
    }

    await window.screenshot({
      path: testInfo.outputPath('canopy-portal-flag-off.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
