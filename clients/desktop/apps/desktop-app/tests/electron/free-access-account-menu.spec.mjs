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
  registerHostedSettingsScenario,
  registerScenario,
} from './seeders/index.mjs';

// CAN-3926 — free app access in the sidebar account menu.
//
// The server reports free access on `GET /api/v1/entitlements` (`freeAccess`).
// This spec proves that field end-to-end through the real entitlements client →
// `probeEntitlementsSummary` → `loadCanopyCloudEntitlements` IPC →
// `useSubscriptionStatus` → UI: the plan line, plan header, billing action and
// usage plan chip disappear, the AI Credits row carries the balance and opens
// account billing, and a later response without the field restores the plan.
//
// Where "account billing" opens depends on the `canopy-desktop-hosted-settings`
// rollout flag (CAN-4386), so every test here pins it. Off, AI Credits mints
// the signed-in web hand-off to `/account/billing`; on, it opens Account →
// Billing inside Settings and mints no billing link.
//
// The entitlements payload comes from the scenario (`cloud.entitlements`), so
// the same signed-in account can be flipped between free access and a paid
// plan without relaunching.

const FREE_ACCESS_CLOUD_API_KEY = 'csk_free_access_account_menu_e2e';
const ACCOUNT_BILLING_PATH = '/account/billing';

// `canopy-billing-enabled` resolves to its enabled-unavailable default (false)
// under E2E. It stays pinned on here because free access keeps the credit
// purchasing surfaces that flag controls, and because the tier half of this
// spec needs the plan subtitle it gates.
function billingEnabledEnv({ hostedSettings, ...flags }) {
  return {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-billing-enabled': true,
      'canopy-desktop-hosted-settings': hostedSettings,
      ...flags,
    }),
  };
}

const FREE_ACCESS_ENTITLEMENTS = {
  freeAccess: true,
  plan: null,
  source: 'none',
  trial: null,
  capabilities: ['data_sync_control', 'remote_control'],
  coveringOrgs: [],
  billingManageableOrg: null,
};

const PAID_ENTITLEMENTS = {
  plan: { key: 'individual', displayName: 'Pro' },
  source: 'subscription',
  trial: null,
  capabilities: ['data_sync_control'],
  coveringOrgs: [],
  billingManageableOrg: null,
};

/** The hosted Settings page, account pages in their frame. */
function hostedPage(win, pageKey) {
  return win.locator(
    `[data-testid="hosted-settings-content"][data-hosted-settings-page="${pageKey}"], ` +
      `[data-testid="hosted-settings-frame"][data-hosted-settings-page="${pageKey}"]`,
  );
}

async function mintCount(mintedPath) {
  const { activity } = await getScenarioActivity(
    DEFAULT_MOCK_BASE_URL,
    FREE_ACCESS_CLOUD_API_KEY,
  );
  return activity[`authLinkMint:${mintedPath}`] ?? 0;
}

test.describe('Free access account menu', () => {
  test('shows AI Credits in place of the plan and follows the server back to tiers', async () => {
    // Without hosted settings, AI Credits keeps the signed-in web hand-off.
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-free-access-menu-'),
    );
    await registerScenario(DEFAULT_MOCK_BASE_URL, FREE_ACCESS_CLOUD_API_KEY, {
      cloud: {
        entitlements: FREE_ACCESS_ENTITLEMENTS,
        aiCreditsBalance: { credits: 1.005, eligible: true },
      },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: billingEnabledEnv({ hostedSettings: false }),
    });

    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(win, FREE_ACCESS_CLOUD_API_KEY);

      await test.step('account menu offers AI Credits and no subscription rows', async () => {
        await win.getByTestId('sidebar-account-row').click();
        const credits = win.getByTestId('sidebar-account-menu-item-ai-credits');
        await expect(credits).toBeVisible({ timeout: 20_000 });
        const balance = win.getByTestId(
          'sidebar-account-menu-item-ai-credits-balance',
        );
        await expect(balance).toHaveText('1', { timeout: 20_000 });
        await expect(balance).toHaveAttribute('data-tone', 'critical');
        await expect(
          win.getByTestId('sidebar-account-menu-subscription-header'),
        ).toHaveCount(0);
        await expect(
          win.getByTestId('sidebar-account-menu-item-billing'),
        ).toHaveCount(0);
        // The row never shows the plan (CAN-3659: it shows the email or the
        // Remote Control status), so no plan line can linger there either.
        await expect(
          win.getByTestId('sidebar-subscription-plan-subtitle'),
        ).toHaveCount(0);
        // Sign out stays available: free access changes billing, not identity.
        await expect(
          win.getByTestId('sidebar-account-menu-item-sign-in-out'),
        ).toHaveText('Sign out');
      });

      await test.step('AI Credits opens account billing on the web', async () => {
        await win.getByTestId('sidebar-account-menu-item-ai-credits').click();
        await expect
          .poll(() => mintCount(ACCOUNT_BILLING_PATH), { timeout: 20_000 })
          .toBe(1);
        await expect(
          win.getByTestId('sidebar-account-menu-item-ai-credits'),
        ).toHaveCount(0);
      });

      await test.step('usage card shows the balance without a plan chip', async () => {
        await app.openUsagePage();
        await expect(win.getByTestId('usage-card-ai-credits')).toBeVisible({
          timeout: 20_000,
        });
        await expect(
          win.getByTestId('usage-card-ai-credits-plan-chip'),
        ).toHaveCount(0);
      });

      await test.step('a response without free access restores the plan', async () => {
        await registerScenario(
          DEFAULT_MOCK_BASE_URL,
          FREE_ACCESS_CLOUD_API_KEY,
          {
            cloud: {
              entitlements: PAID_ENTITLEMENTS,
              aiCreditsBalance: { credits: 688.77, eligible: true },
            },
          },
        );
        // Re-saving the same key forces a fresh account + entitlements read
        // rather than waiting out the main-process snapshot cache.
        await connectMockCloudAccount(win, FREE_ACCESS_CLOUD_API_KEY);

        await expect(
          win.getByTestId('usage-card-ai-credits-plan-chip'),
        ).toHaveText('Pro', { timeout: 20_000 });
        // The plan is named in the menu header (CAN-3659).
        await win.getByTestId('sidebar-account-row').click();
        await expect(
          win.getByTestId('sidebar-account-menu-subscription-header'),
        ).toContainText('Pro');
        await expect(
          win.getByTestId('sidebar-account-menu-item-ai-credits'),
        ).toHaveCount(0);
        await win.keyboard.press('Escape');
      });
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        FREE_ACCESS_CLOUD_API_KEY,
      ).catch(() => {});
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('with hosted settings, AI Credits opens Account billing inside Settings', async () => {
    test.setTimeout(120_000);
    const apiKey = 'csk_free_access_account_menu_hosted';
    // The hosted settings mock serves the settings bridge (session mint,
    // bootstrap, page data); the cloud slice keeps the free-access account.
    await registerHostedSettingsScenario(apiKey, 'hosted-settings-signed-in', {
      scenario: {
        cloud: {
          entitlements: FREE_ACCESS_ENTITLEMENTS,
          aiCreditsBalance: { credits: 1.005, eligible: true },
        },
      },
    });
    const { electronApp, userDataDir } = await launchCanopy({
      env: billingEnabledEnv({ hostedSettings: true }),
    });
    try {
      const win = await electronApp.firstWindow();
      await new CanopyAppDriver(win).waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(win, apiKey);

      await win.getByTestId('sidebar-account-row').click();
      await expect(
        win.getByTestId('sidebar-account-menu-item-ai-credits-balance'),
      ).toHaveText('1', { timeout: 20_000 });
      await win.getByTestId('sidebar-account-menu-item-ai-credits').click();

      await expect(win.getByTestId('settings-overlay')).toBeVisible();
      await expect(win.getByTestId('hosted-settings-content')).toHaveAttribute(
        'data-hosted-settings-page',
        'account/billing',
        { timeout: 30_000 },
      );
      await expect(
        win.getByTestId('settings-nav-account-billing'),
      ).toHaveAttribute('aria-current', 'page');
      // Settings opened the page itself: no web billing hand-off was minted.
      const { activity } = await getScenarioActivity(
        DEFAULT_MOCK_BASE_URL,
        apiKey,
      );
      expect(activity[`authLinkMint:${ACCOUNT_BILLING_PATH}`] ?? 0).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => {});
    }
  });
});

for (const role of ['OWNER', 'ADMIN', 'MEMBER']) {
  test(`free access keeps the wallet personal and shows the pool on the switcher for ${role}`, async () => {
    test.setTimeout(120_000);
    const orgId = '11111111-1111-4111-8111-111111111111';
    const emptyOrgId = '22222222-2222-4222-8222-222222222222';
    const apiKey = `csk_free_access_context_${role.toLowerCase()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        entitlements: FREE_ACCESS_ENTITLEMENTS,
        organizations: [
          {
            id: emptyOrgId,
            name: 'Empty pool',
            role,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: orgId,
            name: 'Acme',
            role,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        aiCreditsBalance: { credits: 688.77, eligible: true },
        // The organization's pool: Members receive classifier fields only.
        orgSpendableById: {
          [emptyOrgId]: {
            hasSpendableHeadroom: false,
            hasBalanceNow: false,
            canReplenish: false,
            orgCreditPoolCapable: true,
            ...(role === 'MEMBER' ? {} : { balanceCredits: 0, balanceUsd: 0 }),
            hasPaymentMethodOnFile: true,
            billingActive: true,
          },
          [orgId]: {
            hasSpendableHeadroom: true,
            hasBalanceNow: true,
            canReplenish: false,
            orgCreditPoolCapable: true,
            ...(role === 'MEMBER'
              ? {}
              : { balanceCredits: 412.5, balanceUsd: 247.5 }),
            hasPaymentMethodOnFile: true,
            billingActive: true,
          },
        },
      },
    });
    // With hosted settings, the wallet and pool open billing in-app.
    const { electronApp, userDataDir } = await launchCanopy({
      env: billingEnabledEnv({
        hostedSettings: true,
        'canopy-shared-org-projects-enabled': true,
      }),
    });
    try {
      const win = await electronApp.firstWindow();
      const driver = new CanopyAppDriver(win);
      await driver.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(win, apiKey);
      await expect
        .poll(() =>
          win.evaluate(
            async () =>
              (await window.api.workspaceContext.get()).organizations.length,
          ),
        )
        .toBe(2);

      const mints = async (target) => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          apiKey,
        );
        return activity[`authLinkMint:${target}`] ?? 0;
      };
      const poolPath = `/organization/${orgId}/settings?tab=billing`;

      // Free access no longer moves the picker into the account menu: one
      // switcher, at the top of the sidebar (CAN-4053).
      const contextRow = win.getByTestId('sidebar-context-row');
      await expect(
        win
          .getByTestId('sidebar-top-context-row')
          .getByTestId('sidebar-context-row'),
      ).toBeVisible();
      await contextRow.click();
      await win.getByTestId(`sidebar-context-option-${orgId}`).click();
      await expect
        .poll(() =>
          win.evaluate(
            async () => (await window.api.workspaceContext.get()).context,
          ),
        )
        .toEqual({ kind: 'organization', organizationId: orgId });

      // The account menu is the person's: their wallet, whatever the role,
      // opening account billing (CAN-4056).
      await expect(win.getByTestId('sidebar-account-identity')).not.toHaveText(
        'Acme',
      );
      await win.getByTestId('sidebar-account-row').click();
      const wallet = win.getByTestId(
        'sidebar-account-menu-item-ai-credits-balance',
      );
      await expect(wallet).toHaveText('689', { timeout: 20_000 });
      await expect(wallet).toHaveAttribute('data-tone', 'healthy');
      await win.getByTestId('sidebar-account-menu-item-ai-credits').click();
      // Hosted settings are pinned on, so billing opens inside Settings.
      await expect(hostedPage(win, 'account/billing')).toBeVisible({
        timeout: 20_000,
      });
      expect(await mints(ACCOUNT_BILLING_PATH)).toBe(0);
      await driver.closeSettings();

      // Owners and Admins see the pool; purchase permissions stay separate.
      await contextRow.click();
      const poolRow = win.getByTestId('sidebar-context-menu-item-ai-credits');
      if (role === 'MEMBER') {
        await expect(poolRow).toHaveCount(0);
        await win.keyboard.press('Escape');
        expect(await mints(poolPath)).toBe(0);
        return;
      }
      await expect(
        win.getByTestId('sidebar-context-menu-item-ai-credits-balance'),
      ).toHaveText('413', { timeout: 20_000 });
      await win.keyboard.press('Escape');
      await contextRow.click();
      await win.getByTestId(`sidebar-context-option-${emptyOrgId}`).click();
      await contextRow.click();
      await expect(
        win.getByTestId('sidebar-context-menu-item-ai-credits-balance'),
      ).toHaveText('0', { timeout: 20_000 });
      await win.keyboard.press('Escape');
      await contextRow.click();
      await win.getByTestId(`sidebar-context-option-${orgId}`).click();
      await contextRow.click();
      await expect(
        win.getByTestId('sidebar-context-menu-item-ai-credits-balance'),
      ).toHaveText('413', { timeout: 20_000 });
      await poolRow.click();
      // CAN-4445: the pool row opens the organization's Settings → Billing
      // in-app instead of minting a web link. This scenario serves no hosted
      // organization pages, so only the overlay is asserted here; the route
      // is covered by the switcher unit test and settings-in-app-links.
      await expect(win.getByTestId('settings-overlay')).toBeVisible({
        timeout: 20_000,
      });
      expect(await mints(poolPath)).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}
