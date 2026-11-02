import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { hostedPage } from './hostedSettingsLocators.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerHostedSettingsScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { HOSTED_SETTINGS_ORG_IDS } from './seeders/hostedSettingsCloud.mjs';

/**
 * Links to web settings pages inside chat (CAN-4692). A chat link to an
 * account or organization settings page on the configured web origin opens
 * the matching page inside Settings, with its query as page state. Every other
 * link keeps its ordinary routing, and with the hosted settings flag off the
 * settings links route as before.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'settings-links-chat';
const ORG_ID = HOSTED_SETTINGS_ORG_IDS.owner;
const BILLING_URL = `${DEFAULT_MOCK_BASE_URL}/account/billing`;
const MEMBERS_URL = `${DEFAULT_MOCK_BASE_URL}/organization/${ORG_ID}/members`;
const ORG_BILLING_URL = `${DEFAULT_MOCK_BASE_URL}/organization/${ORG_ID}/settings?tab=billing`;
const PRICING_URL = `${DEFAULT_MOCK_BASE_URL}/pricing`;

const ORG_FLAGS = {
  'canopy-billing-enabled': true,
  'canopy-shared-org-projects-enabled': true,
};

const FREE_ACCESS_ENTITLEMENTS = {
  freeAccess: true,
  plan: null,
  source: 'none',
  trial: null,
  capabilities: ['data_sync_control', 'remote_control'],
  coveringOrgs: [],
  billingManageableOrg: null,
};

async function launchSettingsLinkChat(apiKey, capture, flags = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), `canopy-${apiKey}-`));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Settings links',
        blocks: [
          {
            type: 'text',
            text: [
              `Review [billing](${BILLING_URL}),`,
              `[members](${MEMBERS_URL}),`,
              `[organization billing](${ORG_BILLING_URL})`,
              `and [pricing](${PRICING_URL}).`,
            ].join(' '),
          },
        ],
      },
    ],
  });
  await registerHostedSettingsScenario(apiKey, 'hosted-settings-signed-in', {
    scenario: {
      cloud: {
        entitlements: FREE_ACCESS_ENTITLEMENTS,
        aiCreditsBalance: { credits: 250, eligible: true },
      },
    },
  });
  // Main matches link origins against its own web origin, which the launcher
  // leaves unset, so point it at the mock server the links name.
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        ...ORG_FLAGS,
        ...flags,
      }),
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      ...capture.env,
    },
  });
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
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const link = (url) => window.locator(`a[href="${url}"]:visible`).first();
  await expect(link(BILLING_URL)).toBeVisible();
  return { app, electronApp, userDataDir, window, link };
}

/** How many links opened outside Settings: externally or in a Browser panel. */
async function ordinaryOpens(window, capture) {
  const browserTabs = await window
    .locator('[data-testid^="panel-tab-panel-browser-"]')
    .count();
  return capture.opened.length + browserTabs;
}

test.describe('Settings links in chat (CAN-4692)', () => {
  test('settings links open inside Settings and other links route as before', async () => {
    test.setTimeout(180_000);
    const capture = await startExternalOpenCapture();
    const { app, electronApp, userDataDir, window, link } =
      await launchSettingsLinkChat('csk_settings_links_in_chat', capture);
    try {
      await test.step('an account billing link opens inside Settings', async () => {
        await link(BILLING_URL).click();
        await expect(hostedPage(window, 'account/billing')).toBeVisible({
          timeout: 20_000,
        });
        expect(await ordinaryOpens(window, capture)).toBe(0);
        await app.closeSettings();
      });

      await test.step('an organization members link opens inside Settings', async () => {
        await link(MEMBERS_URL).click();
        await expect(hostedPage(window, 'organization/members')).toBeVisible({
          timeout: 20_000,
        });
        expect(await ordinaryOpens(window, capture)).toBe(0);
        await app.closeSettings();
      });

      await test.step('an organization settings link lands on its tab', async () => {
        await link(ORG_BILLING_URL).click();
        await expect(hostedPage(window, 'organization/settings')).toBeVisible({
          timeout: 20_000,
        });
        // Billing is its own rail row.
        await expect(
          window.getByTestId('settings-nav-organization-settings-billing'),
        ).toHaveAttribute('aria-current', 'page');
        expect(await ordinaryOpens(window, capture)).toBe(0);
        await app.closeSettings();
      });

      await test.step('a non-settings web link keeps its ordinary routing', async () => {
        await link(PRICING_URL).click();
        await expect.poll(() => ordinaryOpens(window, capture)).toBe(1);
        await expect(window.getByTestId('hosted-settings-content')).toHaveCount(
          0,
        );
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
    }
  });

  test('with the hosted settings flag off, a settings link routes as before', async () => {
    test.setTimeout(120_000);
    const capture = await startExternalOpenCapture();
    const { electronApp, userDataDir, window, link } =
      await launchSettingsLinkChat(
        'csk_settings_links_in_chat_flag_off',
        capture,
        { 'canopy-desktop-hosted-settings': false },
      );
    try {
      await link(BILLING_URL).click();
      await expect.poll(() => ordinaryOpens(window, capture)).toBe(1);
      await expect(window.getByTestId('hosted-settings-content')).toHaveCount(
        0,
      );
      await expect(window.getByTestId('hosted-settings-frame')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
    }
  });
});
