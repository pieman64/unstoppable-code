import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  registerHostedSettingsScenario,
  registerScenario,
} from './seeders/index.mjs';
import { HOSTED_SETTINGS_ORG_IDS } from './seeders/hostedSettingsCloud.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

// Sidebar effective-plan subtitle + account-menu CTA.
//
// End-to-end seam coverage the renderer jest suite mocks out: the indicator's data
// flows through the REAL entitlements client → `probeEntitlementsSummary` →
// `loadCanopyCloudEntitlements` IPC → `useSubscriptionStatus` hook → UI, over
// a live mock-server round-trip. The renderer unit tests
// (SidebarAccountMenu.test.tsx) already assert every indicator state and exact
// click destinations through the auth-link request recorded by the mock cloud;
// this spec proves the plan/trial/billingManageableOrg wire fields and upgrade
// destinations through the real renderer → IPC → main-process stack.
//
// The shared cloud mock (mock-server/routes/cloud.mjs) serves a billing grant
// from `GET /api/v1/entitlements` ONLY for this dedicated key — an active trial
// whose resolved plan is Business plus a billing-manageable org. The footer and
// menu show only that effective plan while the menu CTA still reads `Upgrade`.
// Every other key keeps the default 404 (unlinked), so no other spec is affected.

const TRIAL_CLOUD_API_KEY = 'csk_subscription_pill_e2e';
const BUSINESS_TRIAL_CLOUD_API_KEY = 'csk_subscription_pill_business_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
// Mirrors `GUEST_SIGN_IN_CTA_LABEL` in
// apps/desktop-app/src/renderer/src/lib/guest-cta-copy.ts. Duplicated as a
// literal because this spec is plain ESM and cannot import the TS source; keep
// the two in sync when the guest CTA copy changes. The label is the same on
// every brand.
const GUEST_SIGN_IN_CTA_LABEL = 'Sign in for more';

const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

// Every flag here resolves to its enabled-unavailable default (false) under
// E2E, so each surface this spec drives must be pinned explicitly:
//   - `canopy-billing-enabled` gates the sidebar plan subtitle + account-menu
//     subscription section.
//   - `canopy-portal-enabled` gates the Remote Control modal, whose paid-plan
//     CTA is the second upgrade destination asserted below.
//   - `canopy-desktop-hosted-settings` (CAN-4386) decides where the account
//     menu's billing CTA opens: off, it mints the signed-in web hand-off these
//     tests count; on, it opens the same page inside Settings (the last test).
//     The Remote Control CTA hands off to the web either way.
function billingEnv({ hostedSettings, ...flags }) {
  return {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-billing-enabled': true,
      'canopy-portal-enabled': true,
      'canopy-desktop-hosted-settings': hostedSettings,
      ...flags,
    }),
  };
}
const BILLING_ENABLED_ENV = billingEnv({ hostedSettings: false });

const PERSONAL_TRIAL_BILLING_PATH = '/account/billing?plan=individual';
// Where the CAN-2590 owner/admin branch of the Remote Control paywall sends the
// user: the LAPSED org's own billing page. Distinct from the personal path
// above, which is what every non-lapsed CTA in this spec mints.
//
// No `plan=` intent, deliberately. This fixture is a personal-trial user, so
// `billingPresentation` resolves to `owner: { type: 'user' }` with the personal
// entry tier — a lapsed org is not a presentation candidate while it is
// billing-inactive. The modal only names a plan (and only forwards the intent)
// when the presentation's owner IS this org, so a user-scoped key never reaches
// an org billing page that cannot sell it. This spec is the end-to-end pin on
// that: it previously asserted `Get Pro` → `...&plan=individual`, which promised
// a tier the destination does not offer.
const ORG_LAPSED_BILLING_PATH =
  '/organization/org-pill-e2e/settings?tab=billing';

async function expectMintCount(path, expected) {
  await expect
    .poll(
      async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          TRIAL_CLOUD_API_KEY,
        );
        return activity[`authLinkMint:${path}`] ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBe(expected);
}

async function expectSubscriptionMintCount(expected) {
  await expectMintCount(PERSONAL_TRIAL_BILLING_PATH, expected);
}

test.describe('Sidebar effective-plan subtitle', () => {
  // Kept as ONE test rather than split per surface: each `launchCanopy` costs a
  // full Electron boot plus shell wait, and all four assertions share the same
  // signed-in trial account and the same cumulative mint counter. The phases are
  // wrapped in `test.step` so a pricing hand-off regression is attributed to the
  // surface that broke instead of surfacing as a subtitle-rendering failure.
  test('renders the conversion tier and routes every signed-in CTA directly to billing', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-subscription-pill-'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: BILLING_ENABLED_ENV,
    });

    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });

      // Connect the mock cloud account. The dedicated key resolves the account
      // (real, non-guest) and its `/api/v1/entitlements` trial grant.
      await connectMockCloudAccount(win, TRIAL_CLOUD_API_KEY);

      await test.step('account menu header shows Pro with an unmistakable trial pill', async () => {
        await win.getByTestId('sidebar-account-row').click();
        const header = win.getByTestId(
          'sidebar-account-menu-subscription-header',
        );
        await expect(header).toHaveText(/^ProTrial/, { timeout: 20_000 });
        await expect(
          header.getByTestId('sidebar-subscription-trial-pill'),
        ).toBeVisible();
        await win.keyboard.press('Escape');
        await expect(win.getByTestId('sidebar-account-menu')).toHaveCount(0);
      });

      await test.step('account-menu CTA mints direct personal billing intent', async () => {
        // Clicking the row opens the account menu, which carries the status
        // header plus the authenticated pricing hand-off.
        await win.getByTestId('sidebar-account-row').click();
        await expect(
          win.getByTestId('sidebar-account-menu-subscription-header'),
        ).toContainText('ProTrial', { timeout: 20_000 });
        const cta = win.getByTestId('sidebar-account-menu-item-billing');
        await expect(cta).toBeVisible();
        await expect(cta).toHaveText(/Subscribe to Pro/);
        await cta.click();
        await expectSubscriptionMintCount(1);
      });

      await test.step('Remote Control CTA mints /pricing', async () => {
        // Remote Control is another signed-in upgrade-only surface. The fixture
        // deliberately lacks portal-v1 so the modal shows its paid-plan CTA.
        await app.openCanopyPortal();
        const remoteUpgrade = win.getByTestId(
          'canopy-portal-upgrade-cta-button',
        );
        await expect(remoteUpgrade).toHaveText('Upgrade to unlock');
        await remoteUpgrade.click();
        await expectSubscriptionMintCount(2);
        await win.keyboard.press('Escape');
        await expect(win.getByTestId('canopy-portal-modal')).toHaveCount(0);
      });

      await test.step('Privacy is not an upgrade surface', async () => {
        // Off is the default on every plan, so this fixture (no
        // `data_sync_control`) sees selectable Off and no upgrade prompt, and
        // opening Privacy mints nothing.
        await app.openSettings();
        await app.openSettingsSection('privacy');
        await expect(
          win.getByTestId('telemetry-sharing-metadata-off'),
        ).not.toHaveAttribute('aria-disabled', 'true');
        await expect(win.getByTestId('telemetry-subscribe-cta')).toHaveCount(0);
        await expectSubscriptionMintCount(2);
      });

      await test.step('no CTA minted a non-pricing destination', async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          TRIAL_CLOUD_API_KEY,
        );
        const wrongDestinations = Object.keys(activity).filter(
          (field) =>
            field.startsWith('authLinkMint:') &&
            field !== `authLinkMint:${PERSONAL_TRIAL_BILLING_PATH}`,
        );
        expect(wrongDestinations).toEqual([]);
      });

      await test.step('lapsed manageable org retargets the CTA at that org', async () => {
        // CAN-2590. The only UI automation that reaches the paywall's
        // lapsed-org branch: this fixture's `billingManageableOrg` is
        // `org-pill-e2e`, so flipping that same org to `teamsEntitled: false`
        // makes the signed-in user an OWNER/ADMIN of the org the copy names.
        // The panel must then read as one sentence, and the button must
        // deep-link into that org's billing page — not the personal path every
        // other CTA in this spec mints.
        //
        // The sentence names no plan and the link carries no `plan=` intent:
        // see `ORG_LAPSED_BILLING_PATH` for why a personal-trial fixture must
        // never mint an org link carrying a user-scoped plan key.
        //
        // Runs LAST because `registerScenario` resets this key's recorded
        // activity and this is the one step that deliberately mints a
        // non-pricing destination: placing it earlier would zero the cumulative
        // counters the steps above build up, and trip the
        // "no CTA minted a non-pricing destination" sweep above.
        await registerScenario(DEFAULT_MOCK_BASE_URL, TRIAL_CLOUD_API_KEY, {
          cloud: {
            orgBillingStates: [
              {
                organizationId: 'org-pill-e2e',
                organizationName: 'Acme E2E',
                teamsEntitled: false,
              },
            ],
          },
        });
        // Re-saving the same key forces a fresh account read rather than
        // waiting out the main-process snapshot cache.
        await connectMockCloudAccount(win, TRIAL_CLOUD_API_KEY);

        // The Privacy step above left the Settings overlay open, and it is
        // `fixed inset-0 z-modal` — it covers the main sidebar, so the
        // account row is visible but intercepted. Close it first.
        await app.closeSettings();
        await app.openCanopyPortal();
        const lapsedCopy = win.getByTestId(
          'canopy-portal-upgrade-cta-lapsed-copy',
        );
        await expect(lapsedCopy).toHaveText(
          'This feature requires a paid plan, and Acme E2E has no active plan to cover it.',
          { timeout: 20_000 },
        );
        const remoteUpgrade = win.getByTestId(
          'canopy-portal-upgrade-cta-button',
        );
        await expect(remoteUpgrade).toHaveText('Upgrade to unlock');
        await remoteUpgrade.click();
        await expectMintCount(ORG_LAPSED_BILLING_PATH, 1);
        // Zero, not two: `registerScenario` above resets this key's recorded
        // activity, so both counters started over. That is what makes this
        // assertion meaningful — the click minted the ORG path and never fell
        // back to the personal one.
        await expectSubscriptionMintCount(0);
        await win.keyboard.press('Escape');
        await expect(win.getByTestId('canopy-portal-modal')).toHaveCount(0);
      });
    } finally {
      await clearScenario(DEFAULT_MOCK_BASE_URL, TRIAL_CLOUD_API_KEY).catch(
        () => {},
      );
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('routes a Business trial to the exact represented organization', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-business-trial-'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: BILLING_ENABLED_ENV,
    });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(win, BUSINESS_TRIAL_CLOUD_API_KEY);
      await win.getByTestId('sidebar-account-row').click();
      await expect(
        win.getByTestId('sidebar-account-menu-subscription-header'),
      ).toHaveText(/^BusinessTrial/, { timeout: 20_000 });
      const cta = win.getByTestId('sidebar-account-menu-item-billing');
      await expect(cta).toHaveText(/Subscribe to Business/);
      await cta.click();
      const expectedPath =
        '/organization/org-business-e2e/settings?tab=billing&plan=business';
      await expect
        .poll(async () => {
          const { activity } = await getScenarioActivity(
            DEFAULT_MOCK_BASE_URL,
            BUSINESS_TRIAL_CLOUD_API_KEY,
          );
          return activity[`authLinkMint:${expectedPath}`] ?? 0;
        })
        .toBe(1);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        BUSINESS_TRIAL_CLOUD_API_KEY,
      ).catch(() => {});
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // CAN-3463: the billing action follows the selected organization context.
  // An OWNER gets "Manage plan" on that org; a MEMBER keeps the server's pick.
  test('targets the selected organization by role', async () => {
    test.setTimeout(120_000);
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      BUSINESS_TRIAL_CLOUD_API_KEY,
      {
        cloud: {
          organizations: [
            { id: ORG_CONTEXT_A, name: 'Acme', role: 'OWNER' },
            { id: ORG_CONTEXT_B, name: 'Beta', role: 'MEMBER' },
          ].map((organization) => ({
            ...organization,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          })),
        },
      },
    );
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-context-billing-'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: billingEnv({
        hostedSettings: false,
        'canopy-shared-org-projects-enabled': true,
      }),
    });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(win, BUSINESS_TRIAL_CLOUD_API_KEY);
      await win.getByTestId('sidebar-account-row').click();
      await expect(
        win.getByTestId('sidebar-account-menu-subscription-header'),
      ).toHaveText(/^BusinessTrial/, { timeout: 20_000 });
      await win.keyboard.press('Escape');
      await expect(win.getByTestId('sidebar-account-menu')).toHaveCount(0);

      await selectWorkspaceContext(win, ORG_CONTEXT_A);
      await win.keyboard.press('Escape');
      await win.getByTestId('sidebar-account-row').click();
      const cta = win.getByTestId('sidebar-account-menu-item-billing');
      await expect(cta).toHaveText(/Manage plan/);
      await cta.click();
      const ownerPath = `/organization/${ORG_CONTEXT_A}/settings?tab=billing`;
      await expect
        .poll(async () => {
          const { activity } = await getScenarioActivity(
            DEFAULT_MOCK_BASE_URL,
            BUSINESS_TRIAL_CLOUD_API_KEY,
          );
          return activity[`authLinkMint:${ownerPath}`] ?? 0;
        })
        .toBe(1);

      await selectWorkspaceContext(win, ORG_CONTEXT_B);
      await win.keyboard.press('Escape');
      await win.getByTestId('sidebar-account-row').click();
      await expect(
        win.getByTestId('sidebar-account-menu-item-billing'),
      ).toHaveText(/Subscribe to Business/);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        BUSINESS_TRIAL_CLOUD_API_KEY,
      ).catch(() => {});
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // CAN-4386: with hosted settings, the same CTAs open the page inside
  // Settings instead of minting a web hand-off: personal billing for a
  // user-owned trial, the organization's Settings billing tab for its OWNER.
  test('with hosted settings, the billing CTA opens the matching page inside Settings', async () => {
    test.setTimeout(120_000);
    const apiKey = 'csk_subscription_pill_hosted_e2e';
    const endsAt = new Date(Date.now() + 12 * 86_400_000).toISOString();
    // The personal-trial grant the mock serves the dedicated trial key.
    await registerHostedSettingsScenario(apiKey, 'hosted-settings-signed-in', {
      scenario: {
        cloud: {
          entitlements: {
            plan: { key: 'business', displayName: 'Business' },
            source: 'trial',
            trial: { active: true, endsAt },
            capabilities: [],
            coveringOrgs: [],
            billingManageableOrg: null,
            billingPresentation: {
              plan: { key: 'individual', displayName: 'Pro' },
              owner: { type: 'user' },
              lifecycle: 'trial',
              trialEndsAt: endsAt,
              action: 'subscribe',
            },
          },
        },
      },
    });
    const { electronApp, userDataDir } = await launchCanopy({
      env: billingEnv({
        hostedSettings: true,
        'canopy-shared-org-projects-enabled': true,
      }),
    });
    const mints = async (target) => {
      const { activity } = await getScenarioActivity(
        DEFAULT_MOCK_BASE_URL,
        apiKey,
      );
      return activity[`authLinkMint:${target}`] ?? 0;
    };
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(win, apiKey);
      const content = win.getByTestId('hosted-settings-content');

      await test.step('a personal trial opens Account billing', async () => {
        await win.getByTestId('sidebar-account-row').click();
        const cta = win.getByTestId('sidebar-account-menu-item-billing');
        await expect(cta).toHaveText(/Subscribe to Pro/, { timeout: 20_000 });
        await cta.click();
        await expect(win.getByTestId('settings-overlay')).toBeVisible();
        await expect(content).toHaveAttribute(
          'data-hosted-settings-page',
          'account/billing',
          { timeout: 30_000 },
        );
        await expect(
          win.getByTestId('settings-nav-account-billing'),
        ).toHaveAttribute('aria-current', 'page');
        expect(await mints(PERSONAL_TRIAL_BILLING_PATH)).toBe(0);
        await app.closeSettings();
      });

      await test.step("an OWNER's Manage plan opens the organization's billing", async () => {
        const ownerId = HOSTED_SETTINGS_ORG_IDS.owner;
        await selectWorkspaceContext(win, ownerId);
        await win.keyboard.press('Escape');
        await win.getByTestId('sidebar-account-row').click();
        const cta = win.getByTestId('sidebar-account-menu-item-billing');
        await expect(cta).toHaveText(/Manage plan/, { timeout: 20_000 });
        await cta.click();
        await expect(content).toHaveAttribute(
          'data-hosted-settings-page',
          'organization/settings',
          { timeout: 30_000 },
        );
        await expect(
          win.getByTestId('settings-nav-organization-settings'),
        ).toHaveAttribute('aria-current', 'page');
        // The OWNER's organization, on its Billing tab.
        await expect(
          win.getByTestId('settings-nav-group-organization'),
        ).toContainText('Northwind Labs');
        await expect(
          content.getByTestId('team-settings-tab-billing'),
        ).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
        expect(
          await mints(`/organization/${ownerId}/settings?tab=billing`),
        ).toBe(0);
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => {});
    }
  });

  test('shows a sync CTA for a guest without claiming sign-in unlocks its free credits', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-subscription-pill-guest-'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: BILLING_ENABLED_ENV,
    });

    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });

      // Seed a device-scoped guest credential through the shared cloud mock's
      // guest-mint route so the account row resolves to a guest (not signed in).
      const guestAccount = await win.evaluate(
        async (consent) => window.api.startCanopyGuestSession(consent),
        GUEST_CONSENT,
      );
      expect(guestAccount.credentialSource).toBe('guest');
      await win.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);

      // Guest credits are already available. The promotional panel is gone;
      // the account menu remains the single sidebar sign-in entry point.
      await expect(
        win.getByTestId('sidebar-subscription-pill-guest-cta'),
      ).toHaveCount(0);
      await expect(
        win.getByTestId('sidebar-subscription-plan-subtitle'),
      ).toHaveCount(0);
      await expect(win.getByTestId('sidebar-account-row')).toContainText(
        'Guest',
      );

      // The account menu carries the same action for guests.
      await win.getByTestId('sidebar-account-row').click();
      const guestAction = win.getByTestId(
        'sidebar-account-menu-item-sign-in-out',
      );
      await expect(guestAction).toBeVisible({ timeout: 20_000 });
      await expect(guestAction).toContainText(GUEST_SIGN_IN_CTA_LABEL);
      await expect(
        guestAction.getByTestId('sidebar-account-menu-login-icon'),
      ).toBeVisible();
      await win.keyboard.press('Escape');

      // The remaining account-menu action routes through the shared
      // cloud-connect gate.
      await win.getByTestId('sidebar-account-row').click();
      await guestAction.click();
      await expect(win.getByTestId('cloud-sync-modal')).toBeVisible({
        timeout: 20_000,
      });
      await win.keyboard.press('Escape');
      await expect(win.getByTestId('cloud-sync-modal')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
