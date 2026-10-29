// The guest sign-in CTA label must fit, unelided, in the account-menu row.
//
//   pnpm exec playwright test guest-sign-in-cta-fit.spec.mjs --reporter=line
//
// The guest sign-in label renders in the fixed-height account-menu sign-in row.
// It uses `truncate`, so copy that outgrows the box degrades silently into
// "Sign in to work from any..." — which is also the control's accessible name,
// so a voice-control user cannot speak a label they can see (WCAG 2.5.3).
//
// The account menu row has ~176px and does not grow — the dropdown is a fixed
// `w-56` (224px) that ignores the sidebar width. State is deterministic: the
// shared cloud mock's device-scoped guest-mint route, and the billing flag
// pinned on because the CTA is gated behind it.

// The label is the same on every brand, so the rendered label is the only one
// to measure.
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/** The CTA is gated on `canopy-billing-enabled`, which is off by default in E2E. */
const BILLING_ENABLED_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-billing-enabled': true,
  }),
};

const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

/**
 * Mirrors `GUEST_SIGN_IN_CTA_LABEL` in `renderer/src/lib/guest-cta-copy.ts`.
 * Duplicated as a literal because this spec is plain ESM and cannot import the
 * TS source; `guest-cta-copy.test.ts` checks the two stay in sync.
 */
const GUEST_SIGN_IN_CTA_LABEL = 'Sign in for more';

/**
 * Measure the truncating label inside a row: `scrollWidth` is the width the
 * text actually wants, `clientWidth` the box it was given. Equal means it fits;
 * greater means the ellipsis is showing.
 */
async function measureLabel(window, testId) {
  return window.evaluate((id) => {
    const row = document.querySelector(`[data-testid="${id}"]`);
    const label = row?.querySelector('.truncate');
    if (!label) {
      return null;
    }
    return {
      text: label.textContent ?? '',
      scrollWidth: label.scrollWidth,
      clientWidth: label.clientWidth,
    };
  }, testId);
}

test('the guest sign-in label fits the sidebar pill and the account menu at the default width', async () => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // A guest credential makes the account-menu action use the shared CTA.
    const account = await window.evaluate(
      async (consent) => window.api.startCanopyGuestSession(consent),
      GUEST_CONSENT,
    );
    expect(account.credentialSource).toBe('guest');
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });

    await window.getByTestId('sidebar-account-row').click();
    await expect(window.getByTestId('sidebar-account-menu')).toBeVisible({
      timeout: 15_000,
    });
    const menuLabel = await measureLabel(
      window,
      'sidebar-account-menu-item-sign-in-out',
    );
    expect(menuLabel).not.toBeNull();
    expect(menuLabel.text).toBe(GUEST_SIGN_IN_CTA_LABEL);
    expect(
      menuLabel.scrollWidth,
      `Account menu truncates "${menuLabel.text}": needs ${menuLabel.scrollWidth}px, has ${menuLabel.clientWidth}px in the fixed w-56 dropdown. Shorten the guest sign-in label.`,
    ).toBeLessThanOrEqual(menuLabel.clientWidth);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
