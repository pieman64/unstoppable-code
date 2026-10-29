// Web MCP phase 20, decision D18: show the External agents (MCP) account-menu
// row only for signed-in desktop accounts when its client flag is enabled.
// Desktop has no externalAgents CanopyClient port, so there is no waiting-count
// assertion by design.
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';

const ACCOUNT = { name: 'Ada Lovelace', email: 'ada@example.test' };
// A provisioned Personal destination, as a real signed-in account has.
const PERSONAL_ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const EXTERNAL_AGENTS_FLAG = JSON.stringify({
  'canopy-desktop-external-agents-menu': true,
});
const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

async function cleanupTest({
  electronApp,
  userDataDir,
  scenarioKey,
  scenarioRegistered,
  external,
}) {
  try {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    }
  } finally {
    try {
      if (scenarioRegistered) {
        await clearScenario(DEFAULT_MOCK_BASE_URL, scenarioKey);
      }
    } finally {
      if (external) {
        await external.close();
      }
    }
  }
}

test('signed-in account menu opens External agents when the feature flag is enabled', async () => {
  test.setTimeout(120_000);
  const scenarioKey = 'csk_external_agents_row_on';
  let electronApp;
  let userDataDir;
  let scenarioRegistered = false;
  let external;

  try {
    await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
      cloud: {
        account: ACCOUNT,
        personalOrganizationId: PERSONAL_ORGANIZATION_ID,
      },
    });
    scenarioRegistered = true;
    external = await startExternalOpenCapture();
    ({ electronApp, userDataDir } = await launchCanopy({
      env: {
        ...external.env,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: EXTERNAL_AGENTS_FLAG,
      },
    }));

    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, scenarioKey, {
      expectedAccount: { personalOrganizationId: PERSONAL_ORGANIZATION_ID },
    });
    await window.getByTestId('sidebar-account-row').click();

    const menu = window.getByTestId('sidebar-account-menu');
    const usageRow = menu.getByTestId('sidebar-account-menu-item-usage');
    const externalAgentsRow = menu.getByTestId('account-external-agents-row');
    await expect(menu).toBeVisible();
    await expect(usageRow).toBeVisible();
    await expect(externalAgentsRow).toBeVisible();
    await expect(externalAgentsRow).toContainText('External agents (MCP)');

    const externalAgentsFollowsUsage = await window.evaluate(() => {
      const menuElement = document.querySelector(
        '[data-testid="sidebar-account-menu"]',
      );
      const usage = menuElement?.querySelector(
        '[data-testid="sidebar-account-menu-item-usage"]',
      );
      const externalAgents = menuElement?.querySelector(
        '[data-testid="account-external-agents-row"]',
      );
      return Boolean(
        usage &&
        externalAgents &&
        usage.compareDocumentPosition(externalAgents) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(externalAgentsFollowsUsage).toBe(true);

    await externalAgentsRow.click();
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, scenarioKey))
            .activity['authLinkMint:/account/external-agents'] ?? 0,
      )
      .toBe(1);
    await expect.poll(() => external.opened.length).toBe(1);
    expect(new URL(external.opened[0]).pathname).toBe(
      '/api/v1/canopy/auth-link/consume',
    );
    await expect(menu).toHaveCount(0);
  } finally {
    await cleanupTest({
      electronApp,
      userDataDir,
      scenarioKey,
      scenarioRegistered,
      external,
    });
  }
});

test('signed-in account menu hides External agents when the feature flag is off', async () => {
  test.setTimeout(120_000);
  const scenarioKey = 'csk_external_agents_row_off';
  let electronApp;
  let userDataDir;
  let scenarioRegistered = false;
  let external;

  try {
    await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
      cloud: {
        account: ACCOUNT,
        personalOrganizationId: PERSONAL_ORGANIZATION_ID,
      },
    });
    scenarioRegistered = true;
    external = await startExternalOpenCapture();
    ({ electronApp, userDataDir } = await launchCanopy({
      env: {
        ...external.env,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-external-agents-menu': false,
        }),
      },
    }));

    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, scenarioKey, {
      expectedAccount: { personalOrganizationId: PERSONAL_ORGANIZATION_ID },
    });
    await window.getByTestId('sidebar-account-row').click();

    const menu = window.getByTestId('sidebar-account-menu');
    await expect(menu).toBeVisible();
    await expect(
      menu.getByTestId('sidebar-account-menu-item-usage'),
    ).toBeVisible();
    await expect(menu.getByTestId('account-external-agents-row')).toHaveCount(
      0,
    );
  } finally {
    await cleanupTest({
      electronApp,
      userDataDir,
      scenarioKey,
      scenarioRegistered,
      external,
    });
  }
});

test('guest account menu hides External agents even when the feature flag is enabled', async () => {
  test.setTimeout(120_000);
  const scenarioKey = 'csk_external_agents_row_guest';
  let electronApp;
  let userDataDir;
  let scenarioRegistered = false;
  let external;

  try {
    await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {});
    scenarioRegistered = true;
    external = await startExternalOpenCapture();
    ({ electronApp, userDataDir } = await launchCanopy({
      env: {
        ...external.env,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: EXTERNAL_AGENTS_FLAG,
      },
    }));

    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(
      (consent) => window.api.startCanopyGuestSession(consent),
      GUEST_CONSENT,
    );
    expect(account.credentialSource).toBe('guest');
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-account-row').click();

    const menu = window.getByTestId('sidebar-account-menu');
    await expect(menu).toBeVisible();
    await expect(
      menu.getByTestId('sidebar-account-menu-item-sign-in-out'),
    ).toBeVisible();
    await expect(menu.getByTestId('account-external-agents-row')).toHaveCount(
      0,
    );
  } finally {
    await cleanupTest({
      electronApp,
      userDataDir,
      scenarioKey,
      scenarioRegistered,
      external,
    });
  }
});
