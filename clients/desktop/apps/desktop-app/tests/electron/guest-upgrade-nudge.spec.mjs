import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
// The benefit row renders the raw constant (CloudAuthPanel.tsx). If the
// renderer ever adds locale formatting or singular handling, update these
// assertions alongside it.

// CAN-936 (WS3): the soft upgrade nudge is a dismissible banner shown to a
// consented guest once they've gotten enough value from the app (a session
// threshold), inviting them to sign in / upgrade. It never blocks the shell.
//
// Show gate: guest credential AND `guestSessionCount >= THRESHOLD` (5) AND at
// least THRESHOLD sessions have elapsed since it was last shown (snooze). The
// nudge reads account + preferences on mount, so this spec seeds a guest
// credential (via the shared cloud mock's device-scoped guest-mint route) plus
// the session counters, then reloads the renderer so the nudge re-reads the
// seeded state. Sign-in routes through the same shared CloudSyncModal every
// other WS3 prompt uses; dismiss hides it for the launch.

const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

test('shows the guest upgrade nudge past the session threshold, and supports sign-in + dismiss', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Seed a device-scoped guest credential through the shared cloud mock's
    // guest-mint route (returns a `csk_guest_*` key saved as
    // `credentialSource: 'guest'`).
    const guestAccount = await window.evaluate(
      async (consent) => window.api.startCanopyGuestSession(consent),
      GUEST_CONSENT,
    );
    expect(guestAccount.credentialSource).toBe('guest');

    // Seed the session counters so the nudge's show gate passes: at/above the
    // threshold and never shown before.
    await window.evaluate(async () =>
      window.api.savePreferences({
        guestSessionCount: 5,
        guestUpgradeNudgeLastShownSessionCount: 0,
      }),
    );

    // The nudge reads account + prefs on mount only, so reload the renderer to
    // re-mount it against the seeded state.
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });

    const nudge = window.getByTestId('guest-upgrade-nudge');
    await expect(nudge).toBeVisible({ timeout: 30_000 });

    await window.screenshot({
      path: testInfo.outputPath('guest-upgrade-nudge-visible.png'),
    });

    // Sign-in routes through the shared cloud connect gate: a guest is treated
    // as not-yet-connected, so the common CloudSyncModal opens (rather than
    // resuming immediately).
    await window.getByTestId('guest-upgrade-nudge-sign-in').click();
    const gate = window.getByTestId('cloud-sync-modal');
    await expect(gate).toBeVisible();

    // The gate this nudge opens carries no subheading. Its old one repeated the
    // benefit rows and closed with "Your free AI Credits are already available",
    // which tells a guest the headline perk needs no account.
    await expect(gate).not.toContainText('already available');
    // The daily free AI Credits are opt-in, so signing in does not deliver
    // them and the benefit list must not promise them.
    await expect(window.getByTestId('cloud-auth-benefit-keep-work')).toHaveText(
      "Keep the work you've done as a guest",
    );
    await expect(
      window.getByTestId('cloud-auth-benefit-daily-credits'),
    ).toHaveCount(0);
    await expect(gate).not.toContainText('free AI credits every day');

    // Close the modal without upgrading (guest stays a guest); the pending
    // action is dropped and the nudge remains for this launch.
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('cloud-sync-modal')).toHaveCount(0);
    await expect(nudge).toBeVisible();

    // Dismiss hides the nudge for the current launch.
    await window.getByTestId('guest-upgrade-nudge-dismiss').click();
    await expect(nudge).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
