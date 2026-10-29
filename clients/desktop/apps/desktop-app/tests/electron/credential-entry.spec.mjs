import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Doc 3 — G14: Credential entry UI structure (Linear / Canopy Cloud).
//
// Structural-only coverage of the masking / visibility affordances and the
// presence + mode-switching structure of the credential controls in
// `settings/LinearKeyRow.tsx` and `CanopyCloudAccountSection.tsx`, shown on the
// hosted Integrations and Account pages (CAN-4421). No live Linear validation, no OAuth, no network:
// we never submit a real token round-trip, only assert input masking, the
// show/hide toggle flipping the input `type`, and that the Canopy Cloud
// section, mode toggle, status dot, and per-mode controls render and swap.
//
// B0 baseline — no seeding.
//
// Testids / aria-labels exercised:
//   settings-linear-token-input                      (Linear token input, type=password)
//   aria-label "Show token" / "Hide token"           (Linear show/hide toggle)
//   settings-account-canopy-cloud-section            (Cloud section root)
//   settings-account-canopy-cloud-mode-oauth         ("Back to sign in" link)
//   settings-account-canopy-cloud-mode-api-key       ("Use an API key instead" link)
//   settings-account-canopy-cloud-status-dot         (status dot)
//   settings-account-canopy-cloud-oauth              (OAuth-mode controls container)
//   settings-account-canopy-cloud-api-key            (API-key-mode controls container)
//   settings-account-canopy-cloud-api-key-input      (API-key input)

const FAKE_LINEAR_TOKEN = 'lin_api_fake000000000000000000';

test('Account settings: credential entry masking + Cloud structure', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await app.openSettings();
    await app.openAccountSettingsPage('integrations');
    await expect(
      window.getByTestId('account-device-card-linear'),
    ).toBeVisible();

    // --- Linear token input: masking + show/hide toggle ------------------
    const linearInput = window.getByTestId('settings-linear-token-input');
    await expect(linearInput).toBeVisible();

    // Masked by default.
    await expect(linearInput).toHaveAttribute('type', 'password');

    // Fill a fake token (no validation round-trip is asserted here).
    await linearInput.fill(FAKE_LINEAR_TOKEN);
    await expect(linearInput).toHaveValue(FAKE_LINEAR_TOKEN);

    // The toggle starts as "Show token" while masked.
    const showToggle = window.getByRole('button', { name: 'Show token' });
    await expect(showToggle).toBeVisible();

    // Click to reveal → input becomes type=text and toggle flips to "Hide".
    await showToggle.click();
    await expect(linearInput).toHaveAttribute('type', 'text');
    const hideToggle = window.getByRole('button', { name: 'Hide token' });
    await expect(hideToggle).toBeVisible();

    // Click again to re-mask → input returns to type=password.
    await hideToggle.click();
    await expect(linearInput).toHaveAttribute('type', 'password');
    await expect(
      window.getByRole('button', { name: 'Show token' }),
    ).toBeVisible();

    // --- Canopy Cloud section: structural presence -----------------------
    await app.openAccountSettingsPage('account');
    const cloudSection = window.getByTestId(
      'settings-account-canopy-cloud-section',
    );
    await expect(cloudSection).toBeVisible();

    // The OAuth/API-key segmented control is gone. Each mode renders alone,
    // and the other is reachable through a link INSIDE the visible pane — so
    // the two mode affordances are now mutually exclusive rather than both
    // visible at once.
    const oauthModeButton = window.getByTestId(
      'settings-account-canopy-cloud-mode-oauth',
    );
    const apiKeyModeButton = window.getByTestId(
      'settings-account-canopy-cloud-mode-api-key',
    );
    await expect(apiKeyModeButton).toBeVisible();
    await expect(oauthModeButton).toHaveCount(0);

    await expect(
      window.getByTestId('settings-account-canopy-cloud-status-dot'),
    ).toBeVisible();

    // --- Mode switching swaps the per-mode controls ----------------------
    // A fresh profile starts in OAuth mode.
    await expect(
      window.getByTestId('settings-account-canopy-cloud-oauth'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-account-canopy-cloud-api-key'),
    ).toHaveCount(0);

    // "Use an API key instead" → API-key controls (incl. input) visible,
    // OAuth pane absent, and the return link takes its place.
    await apiKeyModeButton.click();
    await expect(
      window.getByTestId('settings-account-canopy-cloud-api-key'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-account-canopy-cloud-api-key-input'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-account-canopy-cloud-oauth'),
    ).toHaveCount(0);
    await expect(oauthModeButton).toBeVisible();
    await expect(apiKeyModeButton).toHaveCount(0);

    // "Back to sign in" returns to the OAuth pane.
    await oauthModeButton.click();
    await expect(
      window.getByTestId('settings-account-canopy-cloud-oauth'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-account-canopy-cloud-api-key'),
    ).toHaveCount(0);

    await apiKeyModeButton.click();
    await expect(
      window.getByTestId('settings-account-canopy-cloud-api-key-input'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('credential-entry-account.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
