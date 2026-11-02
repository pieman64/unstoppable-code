import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { hostedPage } from './hostedSettingsLocators.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerHostedSettingsScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import {
  HOSTED_SETTINGS_ORG_IDS,
  hostedSettingsCloudAccount,
} from './seeders/hostedSettingsCloud.mjs';
import {
  defaultHostedSettingsOrganizations,
  feedItem,
} from './mock-server/routes/hosted-settings-fixtures.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

/**
 * In-app links to the consolidated account and organization Settings
 * (CAN-4445). With hosted settings available, the context switcher's Feed,
 * Statistics, AI Credits pool and Organization settings, the Usage card's
 * Manage, and the palette's account and organization entries open inside
 * Settings, never as a signed-in web link.
 */

const ORG_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-billing-enabled': true,
    'canopy-shared-org-projects-enabled': true,
  }),
};

/**
 * The seeded organizations with the viewer as OWNER of the lapsed team, the
 * only role that may choose a plan, in both the hosted bootstrap and the
 * cloud account's memberships.
 */
function lapsedTeamOwnedByViewer() {
  const lapsedId = HOSTED_SETTINGS_ORG_IDS.lapsed;
  const account = hostedSettingsCloudAccount();
  return {
    overrides: {
      organizations: defaultHostedSettingsOrganizations().map((org) =>
        org.id === lapsedId ? { ...org, viewerRole: 'OWNER' } : org,
      ),
    },
    cloud: {
      organizations: account.organizations.map((org) =>
        org.id === lapsedId ? { ...org, role: 'OWNER' } : org,
      ),
    },
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

async function launchSignedIn(
  apiKey,
  {
    cloud = {},
    overrides = {},
    scenario = {},
    userDataDir: seededUserDataDir,
    env = {},
    wrap = (launchApp) => launchApp(),
  } = {},
) {
  await registerHostedSettingsScenario(apiKey, 'hosted-settings-signed-in', {
    overrides,
    scenario: {
      ...scenario,
      cloud: {
        entitlements: FREE_ACCESS_ENTITLEMENTS,
        aiCreditsBalance: { credits: 250, eligible: true },
        ...cloud,
      },
    },
  });
  const { electronApp, userDataDir } = await wrap(() =>
    launchCanopy({
      ...(seededUserDataDir ? { userDataDir: seededUserDataDir } : {}),
      env: { ...ORG_ENV, ...env },
    }),
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, apiKey);
  await expect
    .poll(() =>
      window.evaluate(
        async () =>
          (await window.api.workspaceContext.get()).organizations.length,
      ),
    )
    .toBeGreaterThan(0);
  const mints = async (target) => {
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    return activity[`authLinkMint:${target}`] ?? 0;
  };
  return { app, electronApp, userDataDir, window, mints };
}

async function openFromSwitcher(window, testId) {
  await window.getByTestId('sidebar-context-row').click();
  await window.getByTestId(testId).click();
  await expect(window.getByTestId('sidebar-context-menu')).toHaveCount(0);
}

async function runPaletteEntry(window, query, kind, title) {
  await window.getByTestId('sidebar-search').click();
  const palette = window.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await window.getByTestId('command-palette-input').fill(query);
  const row = palette
    .locator(`li[data-palette-kind="${kind}"]`)
    .filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await row.getByRole('option').click();
  await expect(palette).toHaveCount(0);
}

test.describe('In-app Settings links (CAN-4445)', () => {
  test('an owner opens organization pages from the switcher, Usage and the palette inside Settings', async () => {
    test.setTimeout(180_000);
    const organizationId = HOSTED_SETTINGS_ORG_IDS.owner;
    const { app, electronApp, userDataDir, window, mints } =
      await launchSignedIn('csk_settings_in_app_links_owner');
    try {
      await selectWorkspaceContext(window, organizationId);

      for (const [testId, pageKey, path] of [
        [
          'account-personal-activity-row',
          'organization/feed',
          `/organization/${organizationId}`,
        ],
        [
          'account-context-statistics-row',
          'organization/statistics',
          `/organization/${organizationId}/statistics`,
        ],
        [
          'sidebar-context-menu-item-ai-credits',
          'organization/settings',
          `/organization/${organizationId}/settings?tab=billing`,
        ],
        [
          'sidebar-context-organization-settings',
          'organization/settings',
          `/organization/${organizationId}/settings`,
        ],
      ]) {
        await test.step(`${testId} opens ${pageKey} in-app`, async () => {
          await openFromSwitcher(window, testId);
          await expect(hostedPage(window, pageKey)).toBeVisible({
            timeout: 20_000,
          });
          expect(await mints(path)).toBe(0);
          await app.closeSettings();
        });
      }

      await test.step('Usage Manage opens the organization billing in-app', async () => {
        await app.openUsagePage();
        await window.getByTestId('usage-card-ai-credits-manage').click();
        await expect(hostedPage(window, 'organization/settings')).toBeVisible({
          timeout: 20_000,
        });
        expect(
          await mints(`/organization/${organizationId}/settings?tab=billing`),
        ).toBe(0);
        await app.closeSettings();
      });

      await test.step('palette opens the Organizations list in-app', async () => {
        await runPaletteEntry(
          window,
          'Organizations',
          'setting',
          'Organizations',
        );
        await expect(hostedPage(window, 'organizations/list')).toBeVisible({
          timeout: 20_000,
        });
        await app.closeSettings();
      });

      await test.step('palette opens the organization Members in-app', async () => {
        await runPaletteEntry(
          window,
          'Northwind Labs Members',
          'command',
          'Open Northwind Labs Members',
        );
        await expect(hostedPage(window, 'organization/members')).toBeVisible({
          timeout: 20_000,
        });
        expect(await mints(`/organization/${organizationId}/members`)).toBe(0);
        await app.closeSettings();
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('an owner of a lapsed organization chooses a plan inside Settings', async () => {
    test.setTimeout(120_000);
    const organizationId = HOSTED_SETTINGS_ORG_IDS.lapsed;
    const billingPath = `/organization/${organizationId}/settings?tab=billing`;
    const { app, electronApp, userDataDir, window, mints } =
      await launchSignedIn(
        'csk_settings_in_app_links_choose_plan',
        lapsedTeamOwnedByViewer(),
      );
    try {
      await selectWorkspaceContext(window, organizationId);

      await test.step('the sidebar Choose a plan opens billing in-app', async () => {
        await window
          .getByTestId('sidebar-context-empty-state-choose-plan')
          .click({ timeout: 15_000 });
        await expect(hostedPage(window, 'organization/settings')).toBeVisible({
          timeout: 20_000,
        });
        expect(await mints(billingPath)).toBe(0);
        await app.closeSettings();
      });

      await test.step('the Home Choose a plan opens billing in-app', async () => {
        await window.getByTestId('sidebar-create-task').click();
        const notice = window
          .getByTestId('page-home')
          .getByTestId('home-composer-org-without-plan');
        await notice.getByTestId('home-composer-choose-plan').click();
        await expect(hostedPage(window, 'organization/settings')).toBeVisible({
          timeout: 20_000,
        });
        expect(await mints(billingPath)).toBe(0);
        await app.closeSettings();
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('an admin opens organization billing from the pool row inside Settings', async () => {
    test.setTimeout(120_000);
    const organizationId = HOSTED_SETTINGS_ORG_IDS.owner;
    const account = hostedSettingsCloudAccount();
    const { app, electronApp, userDataDir, window, mints } =
      await launchSignedIn('csk_can4058_settings_admin', {
        overrides: {
          organizations: defaultHostedSettingsOrganizations().map((org) =>
            org.id === organizationId ? { ...org, viewerRole: 'ADMIN' } : org,
          ),
        },
        cloud: {
          organizations: account.organizations.map((org) =>
            org.id === organizationId ? { ...org, role: 'ADMIN' } : org,
          ),
        },
      });
    try {
      await selectWorkspaceContext(window, organizationId);
      await openFromSwitcher(window, 'sidebar-context-menu-item-ai-credits');
      await expect(hostedPage(window, 'organization/settings')).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        window.getByTestId('settings-nav-organization-settings-billing'),
      ).toHaveAttribute('aria-current', 'page');
      await expect(window.getByTestId('team-billing-section')).toBeVisible();
      await expect(
        window
          .getByTestId('team-billing-ai-credits')
          .getByText(/^[0-9,.]+ credits$/),
      ).toBeVisible({
        timeout: 20_000,
      });
      expect(
        await mints(`/organization/${organizationId}/settings?tab=billing`),
      ).toBe(0);
      await app.closeSettings();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a member gets Feed but no Statistics on the switcher', async () => {
    test.setTimeout(120_000);
    const organizationId = HOSTED_SETTINGS_ORG_IDS.member;
    const { app, electronApp, userDataDir, window, mints } =
      await launchSignedIn('csk_settings_in_app_links_member');
    try {
      await selectWorkspaceContext(window, organizationId);
      await window.getByTestId('sidebar-context-row').click();
      await expect(
        window.getByTestId('account-personal-activity-row'),
      ).toBeVisible();
      await expect(
        window.getByTestId('account-context-statistics-row'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-context-menu-item-ai-credits'),
      ).toHaveCount(0);
      await window.getByTestId('account-personal-activity-row').click();
      await expect(hostedPage(window, 'organization/feed')).toBeVisible({
        timeout: 20_000,
      });
      expect(await mints(`/organization/${organizationId}`)).toBe(0);
      await app.closeSettings();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

/**
 * A personal Claude chat with no native login and an account with no
 * spendable AI Credits, so the composer's no-billing-source banner offers
 * Get AI Credits. One key carries the native auth usage (`CANOPY_MOCK_API_KEY`)
 * and the signed-in cloud account.
 */
async function launchWithoutBillingSource(
  apiKey,
  prefix,
  { env = {}, flags = {} } = {},
) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      { id: 'can-4691-get-credits', title: 'Get credits', model: 'opus[1m]' },
    ],
  });
  const launched = await launchSignedIn(apiKey, {
    cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
    scenario: { authUsage: { scenario: 'unauthenticated' } },
    userDataDir,
    env: {
      ...env,
      CANOPY_MOCK_API_KEY: apiKey,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        ...JSON.parse(ORG_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS),
        ...flags,
      }),
    },
    wrap: withBundledBinaryOverridesScrubbed,
  });
  try {
    await launched.app.openMainPage();
    await launched.app.selectWorktree('demo-main');
    const banner = launched.window.getByTestId(
      'chat-input-no-billing-source-banner',
    );
    await expect(banner).toBeVisible({ timeout: 30_000 });
    const cta = launched.window.getByTestId(
      'chat-input-no-billing-source-get-credits',
    );
    // Inert until the banner's coverage read settles.
    await expect(cta).toBeEnabled({ timeout: 30_000 });
    return { ...launched, cta };
  } catch (error) {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    throw error;
  }
}

// The chat banner's Get AI Credits always opens the signed-in web top-up, even
// when Billing could open inside Settings, so the chat keeps waiting for the
// purchase (CAN-5159).
const BANNER_TOP_UP_PATH =
  '/account/billing?topUp=1&reason=credits&source=banner';

test.describe('Get AI Credits (CAN-4691)', () => {
  for (const hostedSettings of [true, false]) {
    test(`Get AI Credits opens the signed-in web top-up exactly once with hosted settings ${hostedSettings ? 'on' : 'off'}`, async () => {
      test.setTimeout(180_000);
      const externalOpen = await startExternalOpenCapture();
      try {
        const { cta, electronApp, userDataDir, window, mints } =
          await launchWithoutBillingSource(
            `csk_can4691_get_credits_web_${hostedSettings ? 'on' : 'off'}`,
            `canopy-can4691-get-credits-web-${hostedSettings ? 'on' : 'off'}-`,
            {
              env: externalOpen.env,
              flags: { 'canopy-desktop-hosted-settings': hostedSettings },
            },
          );
        try {
          await cta.click();
          await expect.poll(() => mints(BANNER_TOP_UP_PATH)).toBe(1);
          // The minted link, never the pricing page.
          await expect.poll(() => externalOpen.opened.length).toBe(1);
          expect(externalOpen.opened[0]).not.toContain('/pricing');
          await expect(hostedPage(window, 'account/billing')).toHaveCount(0);
          await expect(
            window.getByTestId(
              'chat-input-no-billing-source-get-credits-handoff',
            ),
          ).toBeVisible();
          // The banner names the step the user is on, and every action is a
          // button on its own row under the copy (CAN-5162).
          const banner = window.getByTestId(
            'chat-input-no-billing-source-banner',
          );
          await expect(banner).toContainText(
            'Finish checkout in your browser. Your credits show up here once the payment goes through.',
          );
          await expect(banner).toHaveAttribute('data-notice-intent', 'neutral');
          await expect(
            banner.locator('[data-notice-actions="below"]'),
          ).toBeVisible();
          await expect(
            window.getByTestId('chat-input-no-billing-source-reopen-billing'),
          ).toHaveText('Reopen billing');
        } finally {
          await closeCanopy(electronApp, userDataDir);
        }
      } finally {
        await externalOpen.close();
      }
    });
  }
});

// CAN-4693: real shared controls must cross the strict authenticated boundary.
// External-open capture observes the consume URL; it does not redeem a session.
const AUTHENTICATED_RUN_PATH = '/runs/can-4693?view=full#summary';
function authenticatedLinkFeed() {
  return {
    items: [
      feedItem({
        id: 'can-4693-merged-run',
        type: 'pr_merged',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        totalCostUsd: null,
        totalTokens: null,
        models: [],
        planId: null,
        sharedPlanId: null,
        planTitle: null,
        runUrl: AUTHENTICATED_RUN_PATH,
      }),
    ],
    scriptedItems: [],
  };
}

test.describe('Authenticated hosted settings links (CAN-4693)', () => {
  test('billing Open on web fails closed with the portal gate off and authenticates after recovery', async () => {
    test.setTimeout(180_000);
    const externalOpen = await startExternalOpenCapture();
    try {
      const { electronApp, userDataDir, window, mints } = await launchSignedIn(
        'csk_can4693_billing_open_on_web',
        { env: externalOpen.env },
      );
      try {
        await selectWorkspaceContext(window, HOSTED_SETTINGS_ORG_IDS.owner);
        await openFromSwitcher(window, 'sidebar-context-menu-item-ai-credits');
        const page = hostedPage(window, 'organization/settings');
        await expect(page).toBeVisible({ timeout: 20_000 });
        const destination = `/organization/${HOSTED_SETTINGS_ORG_IDS.owner}/settings?tab=billing`;
        // Change only the existing E2E flag input, through the real refresh
        // handler. The hosted session is already established and stays valid.
        const setPortalAvailable = async (available) => {
          await electronApp.evaluate((_electron, enabled) => {
            const flags = JSON.parse(
              process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS,
            );
            flags['canopy-portal-enabled'] = enabled;
            process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(flags);
          }, available);
          const snapshot = await window.evaluate(() =>
            window.api.featureFlags.refreshContext(),
          );
          expect(snapshot.values['canopy-portal-enabled']).toBe(available);
        };
        await setPortalAvailable(false);
        await window.evaluate(() => window.dispatchEvent(new Event('focus')));
        const openOnWeb = page.getByTestId(
          'team-billing-payment-handoff-open-on-web',
        );
        await expect(openOnWeb).toBeVisible();
        const before = await mints(destination);
        const opensBefore = externalOpen.opened.length;
        await openOnWeb.click();
        await expect(
          window
            .getByText("Couldn't open this payment page. Try again.", {
              exact: true,
            })
            .first(),
        ).toBeVisible();
        expect(await mints(destination)).toBe(before);
        expect(externalOpen.opened).toHaveLength(opensBefore);
        await expect(page).toBeVisible();

        await setPortalAvailable(true);
        await openOnWeb.click();
        await expect.poll(() => mints(destination)).toBe(before + 1);
        await expect
          .poll(() => externalOpen.opened.length)
          .toBe(opensBefore + 1);
        expect(new URL(externalOpen.opened.at(-1)).pathname).toMatch(
          /\/auth-link\/consume$/,
        );
        await expect(page).toBeVisible();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    } finally {
      await externalOpen.close();
    }
  });

  test('Connect GitHub opens the guarded off-origin installation without an authenticated mint', async () => {
    test.setTimeout(180_000);
    const externalOpen = await startExternalOpenCapture();
    try {
      const { electronApp, userDataDir, window, mints } = await launchSignedIn(
        'csk_can4693_github_install',
        { env: externalOpen.env },
      );
      try {
        await selectWorkspaceContext(window, HOSTED_SETTINGS_ORG_IDS.owner);
        await openFromSwitcher(window, 'sidebar-context-organization-settings');
        const page = hostedPage(window, 'organization/settings');
        await expect(page).toBeVisible({ timeout: 20_000 });
        await window
          .getByTestId('settings-nav-organization-settings-integrations')
          .click();
        const connect = page.getByTestId('team-github-connect');
        await expect(connect).toBeVisible();
        const destination =
          'https://github.com/apps/canopy-e2e/installations/new';
        const before = await mints(destination);
        const opensBefore = externalOpen.opened.length;
        await connect.click();
        await expect
          .poll(() => externalOpen.opened.length)
          .toBe(opensBefore + 1);
        expect(externalOpen.opened.at(-1)).toBe(destination);
        expect(await mints(destination)).toBe(before);
        await expect(
          page.getByTestId('team-github-continue-in-browser'),
        ).toBeVisible();
        await expect(page).toBeVisible();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    } finally {
      await externalOpen.close();
    }
  });

  test('raw run anchors mint once per primary, keyboard and middle activation; off-origin links stay guarded', async () => {
    test.setTimeout(180_000);
    const externalOpen = await startExternalOpenCapture();
    try {
      const { app, electronApp, userDataDir, window, mints } =
        await launchSignedIn('csk_can4693_raw_run', {
          env: externalOpen.env,
          overrides: { feed: authenticatedLinkFeed() },
        });
      try {
        await selectWorkspaceContext(window, HOSTED_SETTINGS_ORG_IDS.owner);
        await openFromSwitcher(window, 'account-personal-activity-row');
        const page = hostedPage(window, 'organization/feed');
        await expect(page).toBeVisible({ timeout: 20_000 });
        const run = page.getByRole('link', { name: 'View run', exact: true });
        await expect(run).toBeVisible();
        const before = await mints(AUTHENTICATED_RUN_PATH);
        const opensBefore = externalOpen.opened.length;
        for (const activation of ['primary', 'keyboard', 'middle']) {
          if (activation === 'keyboard') {
            await run.focus();
            await run.press('Enter');
          } else
            await run.click({
              button: activation === 'middle' ? 'middle' : 'left',
            });
          const count =
            ['primary', 'keyboard', 'middle'].indexOf(activation) + 1;
          await expect
            .poll(() => mints(AUTHENTICATED_RUN_PATH))
            .toBe(before + count);
          await expect
            .poll(() => externalOpen.opened.length)
            .toBe(opensBefore + count);
          const opened = new URL(externalOpen.opened.at(-1));
          expect(opened.pathname).toMatch(/\/auth-link\/consume$/);
          expect(opened.searchParams.has('code')).toBe(true);
          await expect(page).toBeVisible();
        }
        await page
          .locator(
            'a[href="https://github.com/example-org/build-service/pull/42"]',
          )
          .click();
        await expect
          .poll(() => externalOpen.opened.at(-1))
          .toBe('https://github.com/example-org/build-service/pull/42');
        expect(await mints(AUTHENTICATED_RUN_PATH)).toBe(before + 3);
        await app.closeSettings();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    } finally {
      await externalOpen.close();
    }
  });

  test('a failed raw-anchor mint keeps Settings open and reports failure without a bare-page fallback', async () => {
    test.setTimeout(180_000);
    const externalOpen = await startExternalOpenCapture();
    try {
      const { electronApp, userDataDir, window, mints } = await launchSignedIn(
        'csk_can4693_raw_run_failure',
        {
          env: externalOpen.env,
          // First mint establishes hosted settings. Subsequent activations fail.
          overrides: {
            feed: authenticatedLinkFeed(),
            mint: ['ok', { status: 503, body: { error: 'fixture failure' } }],
          },
        },
      );
      try {
        await selectWorkspaceContext(window, HOSTED_SETTINGS_ORG_IDS.owner);
        await openFromSwitcher(window, 'account-personal-activity-row');
        const page = hostedPage(window, 'organization/feed');
        const run = page.getByRole('link', { name: 'View run', exact: true });
        await expect(run).toBeVisible({ timeout: 20_000 });
        const before = await mints(AUTHENTICATED_RUN_PATH);
        const opensBefore = externalOpen.opened.length;
        await run.click();
        await expect.poll(() => mints(AUTHENTICATED_RUN_PATH)).toBe(before + 1);
        await expect(
          window
            .getByText("Couldn't open this page. Try again.", { exact: true })
            .first(),
        ).toBeVisible();
        expect(externalOpen.opened).toHaveLength(opensBefore);
        await expect(page).toBeVisible();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    } finally {
      await externalOpen.close();
    }
  });

  test('Invite on the web stays external and authenticated even for an internal settings route', async () => {
    test.setTimeout(180_000);
    const externalOpen = await startExternalOpenCapture();
    try {
      const { electronApp, userDataDir, window, mints } = await launchSignedIn(
        'csk_can4693_invite',
        {
          env: externalOpen.env,
          cloud: {
            entitlements: { ...FREE_ACCESS_ENTITLEMENTS, freeAccess: false },
          },
        },
      );
      try {
        await selectWorkspaceContext(window, HOSTED_SETTINGS_ORG_IDS.owner);
        await runPaletteEntry(
          window,
          'Northwind Labs Members',
          'command',
          'Open Northwind Labs Members',
        );
        const page = hostedPage(window, 'organization/members');
        await expect(page).toBeVisible({ timeout: 20_000 });
        const invite = window.getByTestId('team-invite-on-web');
        await expect(invite).toBeVisible();
        const destination = `/organization/${HOSTED_SETTINGS_ORG_IDS.owner}/members?invite=1`;
        const before = await mints(destination);
        const opensBefore = externalOpen.opened.length;
        await invite.click();
        await expect.poll(() => mints(destination)).toBe(before + 1);
        await expect
          .poll(() => externalOpen.opened.length)
          .toBe(opensBefore + 1);
        expect(new URL(externalOpen.opened.at(-1)).pathname).toMatch(
          /\/auth-link\/consume$/,
        );
        await expect(page).toBeVisible();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    } finally {
      await externalOpen.close();
    }
  });
});
