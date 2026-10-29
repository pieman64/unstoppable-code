// CAN-1939 — desktop mobile-install CTA regression coverage.
//
// Default brand run:
//   pnpm run build:e2e
//   pnpm exec playwright test can-1939-mobile-install-ctas.spec.mjs --reporter=line
//
// Store-enabled internal run (isolated from the default `out-e2e/` build):
//   CANOPY_BRAND=unstoppable-code CANOPY_RELEASE_FLAVOR=internal CANOPY_E2E_OUT_DIR=out-e2e-internal pnpm run build:e2e
//   CANOPY_BRAND=unstoppable-code CANOPY_RELEASE_FLAVOR=internal CANOPY_E2E_OUT_DIR=out-e2e-internal pnpm run test:electron:built can-1939-mobile-install-ctas.spec.mjs --reporter=line
//
// The first test always runs and proves a brand with no `web.mobileApps` never
// leaks hard-coded store URLs into any desktop surface. The rest run only for
// the store-enabled build and exercise the real account/preferences/IPC seams:
// card + CTA banner presence, the pill sizing itself to its copy rather than
// to the notification column (this brand's name is what makes the copy
// outgrow 24rem), the banner's QR popover (store toggle owning both the one
// code and the one badge on screen, Escape + focus restore), one-day shared
// snooze across a renderer reload in both directions, live activation
// suppression while a popover is open — proving the pill unmounts cleanly —
// with the Remote Control modal staying available as a deliberate download
// surface, and the guest gate: a device-scoped guest gets the create-account
// CTA alone, with the mobile app named in the modal subtitle instead of a
// competing pair of store badges. State is deterministic: demo workspaces are
// seeded on disk and Canopy Cloud is the suite mock server.
//
// CI runs the default-brand negative test in the stable matrix and the positive
// store-enabled flow in the isolated `electron-ui-internal-variant` job.

import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/index.mjs';

const ELIGIBLE_API_KEY = 'csk_mobile_promo_eligible_e2e';
const ACTIVATED_API_KEY = 'csk_mobile_activation_e2e';
const STORE_ENABLED_BUILD = process.env.CANOPY_BRAND === 'unstoppable-code';

/** Consent payload the device-scoped guest-mint route expects. */
const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

/**
 * Mint a device-scoped guest credential through the shared cloud mock, then
 * reload so every surface re-reads the account. A guest holds a real `csk_` key,
 * so the modal treats it as connected and shows the create-account CTA rather
 * than the no-account state.
 */
async function connectGuest(window, app) {
  const account = await window.evaluate(
    async (consent) => window.api.startCanopyGuestSession(consent),
    GUEST_CONSENT,
  );
  expect(account.credentialSource).toBe('guest');
  await window.reload();
  await app.waitForShell({ timeout: 30_000 });
}

async function launchSignedIn(apiKey) {
  const launched = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, apiKey);
  return { ...launched, window, app };
}

test('the default brand renders none of the three desktop install surfaces', async () => {
  test.skip(
    STORE_ENABLED_BUILD,
    'default-brand regression runs with the normal canopy build',
  );
  const { electronApp, userDataDir, window, app } =
    await launchSignedIn(ELIGIBLE_API_KEY);
  try {
    await app.openOverviewPage();
    await expect(window.getByTestId('mobile-app-promo-card')).toHaveCount(0);
    await expect(window.getByTestId('mobile-app-cta-banner')).toHaveCount(0);

    await app.openCanopyPortal();
    await expect(
      window.getByTestId('remote-control-mobile-apps-cta'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Measure the pill against the notification column it sits in.
 *
 * `scrollWidth` vs `clientWidth` on the truncating label is the ellipsis
 * check: equal means the copy fits, greater means it is clipped. The pill and
 * column boxes tell the other half of the story — whether the pill sized
 * itself to its content and stayed against the stack's edge.
 */
async function measurePill(window) {
  return window.evaluate(() => {
    const pill = document.querySelector(
      '[data-testid="mobile-app-cta-banner"]',
    );
    const column = pill?.parentElement;
    const label = pill?.querySelector('.truncate');
    if (!pill || !column || !label) {
      return null;
    }
    const pillBox = pill.getBoundingClientRect();
    const columnBox = column.getBoundingClientRect();
    return {
      text: label.textContent ?? '',
      labelScrollWidth: label.scrollWidth,
      labelClientWidth: label.clientWidth,
      pillWidth: pillBox.width,
      columnWidth: columnBox.width,
      pillRight: pillBox.right,
      columnRight: columnBox.right,
      viewportWidth: window.innerWidth,
    };
  });
}

/** Clear the shared snooze and reload so the eligible fixture is restored. */
async function resetSnooze(window, app) {
  await window.evaluate(async () => {
    await window.api.savePreferences({
      mobileInstallCueSnoozedUntil: '2000-01-01T00:00:00.000Z',
    });
  });
  await window.reload();
  await app.waitForShell({ timeout: 30_000 });
  await app.openOverviewPage();
}

test('store-enabled desktop CTAs share snooze and suppress live after activation', async () => {
  test.skip(
    !STORE_ENABLED_BUILD,
    'requires CANOPY_BRAND=unstoppable-code at build and test time',
  );
  test.setTimeout(240_000);

  const { electronApp, userDataDir, window, app } =
    await launchSignedIn(ELIGIBLE_API_KEY);
  try {
    await app.openOverviewPage();
    const card = window.getByTestId('mobile-app-promo-card');
    const banner = window.getByTestId('mobile-app-cta-banner');
    await expect(card).toBeVisible();
    await expect(banner).toBeVisible();

    // --- The pill is sized by its copy, not by the column it sits in. ---
    //
    // The notification stack is a fixed 24rem column shared with the toasts.
    // The pill used to stretch to fill it and ellipsise its own message —
    // "Get Unstoppable Code on y..." — with no way to read the rest, because
    // the pill had already taken every pixel the column had. It now sizes to
    // `max-content` and overflows the column inward instead, so this is the
    // brand whose name makes the copy longest asserting it fits unelided.
    const measured = await measurePill(window);
    expect(measured).not.toBeNull();
    expect(
      measured.labelScrollWidth,
      `The pill truncates "${measured.text}": needs ${measured.labelScrollWidth}px, has ${measured.labelClientWidth}px.`,
    ).toBeLessThanOrEqual(measured.labelClientWidth);
    // Proves the column is no longer the binding constraint: on this brand the
    // full copy does not fit 24rem, so a pill still bounded by the column
    // could not have passed the assertion above.
    expect(
      measured.pillWidth,
      `The pill (${measured.pillWidth}px) fits inside the ${measured.columnWidth}px column, so the assertion above no longer proves anything. Either the copy got shorter or the column got wider.`,
    ).toBeGreaterThan(measured.columnWidth);
    // ...but the viewport still is, and the pill stays against the stack's
    // edge, overflowing away from it rather than off-screen.
    expect(measured.pillWidth).toBeLessThanOrEqual(measured.viewportWidth);
    expect(Math.abs(measured.pillRight - measured.columnRight)).toBeLessThan(1);

    // --- The popover: a rich surface behind one accent action. ---
    const action = window.getByTestId('mobile-app-cta-banner-action');
    await action.click();
    const promo = window.getByTestId('mobile-app-qr-promo');
    await expect(promo).toBeVisible();
    await expect(action).toHaveAttribute('aria-expanded', 'true');

    // The toggle owns the whole surface: one QR and one badge, both for the
    // selected store. A phone camera must not be able to lock onto the wrong
    // code, and the badge must not offer a store the code does not point at.
    // Count, not just visibility: two overlapping codes would both "be
    // visible".
    await expect(
      promo.getByTestId('store-badge-apple-app-store'),
    ).toBeVisible();
    await expect(promo.getByTestId('store-badge-google-play')).toHaveCount(0);
    const qr = promo.getByTestId('mobile-app-qr');
    await expect(qr).toHaveCount(1);
    await expect(qr).toHaveAttribute('data-store', 'apple-app-store');

    // The popover is operable by keyboard, not pointer-only: opening lands
    // focus INSIDE the dialog, and Tab cycles within it rather than tearing it
    // down. Asserting focus restore alone would pass even if focus had never
    // entered the dialog, which is exactly how this regressed.
    //
    // This runs BEFORE the pointer-driven toggle below on purpose: clicking a
    // toggle focuses it, which would invalidate the initial-focus assertion.
    await expect(
      promo.getByTestId('mobile-app-qr-tab-app-store'),
    ).toBeFocused();
    await window.keyboard.press('Tab');
    await expect(promo).toBeVisible();
    await expect(promo.getByTestId('mobile-app-qr-tab-play')).toBeFocused();
    await window.keyboard.press('Tab');
    await expect(promo).toBeVisible();
    await expect(
      promo.getByTestId('store-badge-apple-app-store'),
    ).toBeFocused();

    // The toggle swaps the code in place rather than adding a second one, and
    // takes the badge with it.
    await promo.getByTestId('mobile-app-qr-tab-play').click();
    await expect(promo.getByTestId('mobile-app-qr')).toHaveCount(1);
    await expect(promo.getByTestId('mobile-app-qr')).toHaveAttribute(
      'data-store',
      'google-play',
    );
    await expect(promo.getByTestId('store-badge-google-play')).toBeVisible();
    await expect(promo.getByTestId('store-badge-apple-app-store')).toHaveCount(
      0,
    );

    // FloatingMenu owns dismissal and focus restore; there is no second path.
    await window.keyboard.press('Escape');
    await expect(promo).toHaveCount(0);
    await expect(action).toBeFocused();

    // The dismiss X is a sibling of the popover trigger. With the popover open
    // it used to read as an outside press: the popover closed and swallowed
    // the click, so the first press never snoozed the banner.
    await action.click();
    await expect(window.getByTestId('mobile-app-qr-promo')).toBeVisible();
    await window.getByTestId('mobile-app-cta-banner-dismiss').click();
    await expect(banner).toHaveCount(0);
    await expect(window.getByTestId('mobile-app-qr-promo')).toHaveCount(0);
    await expect(card).toHaveCount(0);

    await resetSnooze(window, app);
    await expect(card).toBeVisible();
    await expect(banner).toBeVisible();

    // --- Shared snooze, card -> banner. ---
    await card.getByTestId('mobile-app-promo-dismiss').click();
    await expect(card).toHaveCount(0);
    await expect(banner).toHaveCount(0);

    // The preference survives a renderer reload.
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openOverviewPage();
    await expect(window.getByTestId('mobile-app-promo-card')).toHaveCount(0);
    await expect(window.getByTestId('mobile-app-cta-banner')).toHaveCount(0);

    // --- Shared snooze, banner -> card (the other direction). ---
    await resetSnooze(window, app);
    await expect(window.getByTestId('mobile-app-promo-card')).toBeVisible();
    await expect(window.getByTestId('mobile-app-cta-banner')).toBeVisible();
    await window.getByTestId('mobile-app-cta-banner-dismiss').click();
    await expect(window.getByTestId('mobile-app-cta-banner')).toHaveCount(0);
    await expect(window.getByTestId('mobile-app-promo-card')).toHaveCount(0);

    // --- Live activation clears both, popover and all. ---
    await resetSnooze(window, app);
    await expect(window.getByTestId('mobile-app-promo-card')).toBeVisible();
    await expect(window.getByTestId('mobile-app-cta-banner')).toBeVisible();

    // Open the popover BEFORE the activation flip: the pill unmounting must
    // take its portalled popover with it, not strand it over the app.
    await window.getByTestId('mobile-app-cta-banner-action').click();
    await expect(window.getByTestId('mobile-app-qr-promo')).toBeVisible();

    await connectMockCloudAccount(window, ACTIVATED_API_KEY);
    await expect(window.getByTestId('mobile-app-promo-card')).toHaveCount(0);
    await expect(window.getByTestId('mobile-app-cta-banner')).toHaveCount(0);
    await expect(window.getByTestId('mobile-app-qr-promo')).toHaveCount(0);

    // Activation suppresses nudges, never the modal's deliberate download CTA.
    await app.openCanopyPortal();
    await expect(
      window.getByTestId('remote-control-mobile-apps-cta'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a guest gets the create-account CTA alone, with the app named in the subtitle', async () => {
  test.skip(
    !STORE_ENABLED_BUILD,
    'requires CANOPY_BRAND=unstoppable-code at build and test time',
  );
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectGuest(window, app);

    await app.openCanopyPortal();
    const modal = window.getByTestId('canopy-portal-modal');
    // One ask, not two: the create-account CTA is the only call to action in
    // the modal, and the store badges under it are gone.
    await expect(window.getByTestId('canopy-portal-guest-cta')).toBeVisible();
    await expect(
      window.getByTestId('remote-control-mobile-apps-cta'),
    ).toHaveCount(0);
    // The install story survives as prose in the subtitle.
    await expect(modal).toContainText('mobile app');

    // The shell-mounted CTA banner stays away for a guest too, so the modal's
    // single ask is not undercut from behind it.
    await expect(window.getByTestId('mobile-app-cta-banner')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
