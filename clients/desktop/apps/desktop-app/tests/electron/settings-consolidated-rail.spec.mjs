import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readBrandAppName } from './helpers/brand-app-name.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  readHostedSettingsRequests,
  registerHostedSettingsScenario,
} from './seeders/index.mjs';

/**
 * The consolidated desktop Settings rail (CAN-4421): with hosted account
 * settings available, the scope picker and the hosted Account rows sit on
 * top (the Organizations list is in the picker's menu), then the local app
 * group (General, Privacy, Remote access, Display, labeled with the product
 * name), then Agents (starting with "Providers"), Tools, Workflow and
 * Advanced. The local Notifications row is gone; its rows, the cloud sign-in,
 * GitHub, Linear and the personal catalog live in the "On this computer"
 * region of the hosted Account, Notifications, Integrations and Public profile
 * pages. With the rollout flag off, the legacy rail is unchanged.
 *
 * Signed-out and guest runs never reach the hosted settings bridge; the
 * signed-in runs drive the mock cloud's `hosted-settings` scenarios.
 */

const HOSTED_RAIL_GROUPS = [
  'settings-nav-group-account',
  'settings-nav-group-personal',
  'settings-nav-group-agents',
  'settings-nav-group-integrations',
  'settings-nav-group-workflow',
  'settings-nav-group-advanced',
];

const LEGACY_RAIL_GROUPS = [
  'settings-nav-group-personal',
  'settings-nav-group-agents',
  'settings-nav-group-integrations',
  'settings-nav-group-workflow',
  'settings-nav-group-advanced',
];

const FLAG_OFF_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-hosted-settings': false,
  }),
};

const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

/** Rail group test ids in DOM order. */
async function railGroupIds(window) {
  return window
    .getByTestId('settings-sidebar')
    .locator('[data-testid^="settings-nav-group-"]')
    .evaluateAll((groups) => groups.map((group) => group.dataset.testid));
}

/** Row test ids of one rail group, in order. */
async function groupRowIds(window, groupTestId) {
  return window
    .getByTestId(groupTestId)
    .locator('[data-sidebar-nav-row]')
    .evaluateAll((rows) => rows.map((row) => row.dataset.testid));
}

/** The hosted Account group's rows once a signed-in bootstrap is known. */
const SIGNED_IN_ACCOUNT_ROWS = [
  'settings-nav-account-account',
  'settings-nav-account-profile',
  'settings-nav-account-digests',
  'settings-nav-account-notifications',
  'settings-nav-account-integrations',
  'settings-nav-account-security',
  'settings-nav-account-billing',
];

/** Long enough that a rail drawn before the bootstrap is caught drawing. */
const BOOTSTRAP_DELAY_MS = 2_000;

/**
 * Starts recording every distinct list of hosted rail row ids (Account,
 * Organizations and the browsed organization) the page draws, from before
 * Settings opens, so the first paint is part of the record.
 */
async function startHostedRailRecording(window) {
  await window.evaluate(() => {
    const read = () =>
      Array.from(
        document.querySelectorAll(
          '[data-testid="settings-sidebar"] [data-testid^="settings-nav-group-"] [data-sidebar-nav-row]',
        ),
      )
        .map((row) => row.dataset.testid ?? '')
        .filter(
          (id) =>
            id.startsWith('settings-nav-account-') ||
            id.startsWith('settings-nav-organization'),
        );
    const seen = [];
    const record = () => {
      const ids = read();
      if (ids.length === 0) return;
      const last = seen.at(-1);
      if (last === undefined || last.join('|') !== ids.join('|'))
        seen.push(ids);
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    record();
    globalThis.__hostedRailRecording = {
      seen,
      stop: () => observer.disconnect(),
    };
  });
}

/** Stops the recording and returns every distinct row list it saw. */
async function stopHostedRailRecording(window) {
  return window.evaluate(() => {
    const recording = globalThis.__hostedRailRecording;
    recording.stop();
    return recording.seen;
  });
}

/** `settings.bootstrap` requests the mock has seen for a key. */
async function bootstrapRequests(apiKey) {
  const log = await readHostedSettingsRequests(apiKey);
  return log.requests.filter(
    (request) => request.operation === 'settings.bootstrap',
  );
}

/**
 * Waits until a bootstrap read started after `since` requests has been
 * answered and no other is in flight, including one that a finished read
 * (the session mint's) leads to.
 */
async function waitForBootstrapsAnswered(window, apiKey, since) {
  const answered = async () => {
    const requests = (await bootstrapRequests(apiKey)).slice(since);
    return (
      requests.length > 0 &&
      requests.every((request) => request.status !== null)
    );
  };
  await expect.poll(answered, { timeout: 30_000 }).toBe(true);
  await window.waitForTimeout(BOOTSTRAP_DELAY_MS);
  await expect.poll(answered, { timeout: 30_000 }).toBe(true);
}

/** Rows marked current: hosted rows by `aria-current`, local by class. */
async function selectedRailRows(window) {
  return window
    .getByTestId('settings-sidebar')
    .locator('[data-sidebar-nav-row]')
    .evaluateAll((rows) =>
      rows
        .filter(
          (row) =>
            row.getAttribute('aria-current') === 'page' ||
            row.className.split(/\s+/).includes('bg-muted'),
        )
        .map((row) => row.dataset.testid),
    );
}

function hostedPage(window, pageKey) {
  return window.locator(
    `[data-testid="hosted-settings-content"][data-hosted-settings-page="${pageKey}"], ` +
      `[data-testid="hosted-settings-frame"][data-hosted-settings-page="${pageKey}"]`,
  );
}

/** Hosted settings bridge requests the mock saw without a session. */
async function unauthenticatedSettingsRequests() {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/hosted-settings-unauthenticated`,
  );
  const { requests } = await response.json();
  return requests.filter((request) =>
    String(request.path).startsWith('/api/v1/settings/'),
  ).length;
}

/** Local receiver standing in for the host browser. */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Ignore malformed payloads; the assertion reports the gap.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

function openSettingsFromAppAdvisor(electronApp, section) {
  return electronApp.evaluate(({ BrowserWindow }, targetSection) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.webContents.getURL().includes('surface=app-advisor'),
    );
    if (!mainWindow) throw new Error('Main window not found');
    mainWindow.webContents.send('app-advisor:tool-request', {
      kind: 'dispatch_action',
      requestId: `settings-consolidated-rail-${targetSection}-${Date.now()}`,
      originWorktreeId: 'e2e-origin',
      action: { type: 'navigation.open_settings', section: targetSection },
    });
  }, section);
}

async function openPaletteSetting(window, title) {
  await window.getByTestId('sidebar-search').click();
  const palette = window.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await window.getByTestId('command-palette-input').fill(title);
  const row = palette
    .locator('li[data-palette-kind="setting"]')
    .filter({ hasText: new RegExp(`^\\s*${title}\\s*Settings\\s*$`) });
  await expect(row).toHaveCount(1);
  await row.getByRole('option').click();
  await expect(palette).toHaveCount(0);
}

async function launchSignedIn(apiKey, scenarioName, env = undefined) {
  await registerHostedSettingsScenario(apiKey, scenarioName);
  const { electronApp, userDataDir } = await launchCanopy(
    env === undefined ? undefined : { env },
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await connectMockCloudAccount(window, apiKey);
  return { app, electronApp, userDataDir, window };
}

test.describe('Settings rail with hosted account settings (CAN-4421)', () => {
  test('signed out: the app group leads the rail, and each merged page carries this computer’s settings', async () => {
    test.setTimeout(150_000);
    const unauthenticatedBefore = await unauthenticatedSettingsRequests();
    const externalOpen = await startExternalOpenCapture();
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();

      // Settings still opens on General.
      await app.expectSettingsSection('canopy');
      expect(await selectedRailRows(window)).toEqual(['settings-nav-canopy']);

      // Rail order and labels.
      await expect(
        window.getByTestId('settings-nav-group-account'),
      ).toBeVisible();
      expect(await railGroupIds(window)).toEqual(HOSTED_RAIL_GROUPS);
      for (const [groupTestId, name] of [
        ['settings-nav-group-account', 'Account'],
        ['settings-nav-group-personal', readBrandAppName()],
        ['settings-nav-group-agents', 'Agents'],
        ['settings-nav-group-integrations', 'Tools'],
      ]) {
        await expect(window.getByTestId(groupTestId)).toHaveAccessibleName(
          name,
        );
      }
      // Signed out, the flag-gated Digests and Billing rows are hidden;
      // Integrations is always listed on desktop.
      expect(await groupRowIds(window, 'settings-nav-group-account')).toEqual([
        'settings-nav-account-account',
        'settings-nav-account-profile',
        'settings-nav-account-notifications',
        'settings-nav-account-integrations',
        'settings-nav-account-security',
      ]);
      expect(await groupRowIds(window, 'settings-nav-group-personal')).toEqual([
        'settings-nav-canopy',
        'settings-nav-privacy',
        'settings-nav-remote-access',
        'settings-nav-display',
      ]);
      // Providers leads Agents (Multi-account proxy follows it only when the
      // proxy is available, which needs a signed-in account).
      const agentRows = await groupRowIds(window, 'settings-nav-group-agents');
      expect(agentRows[0]).toBe('settings-nav-account');
      await expect(window.getByTestId('settings-nav-account')).toHaveText(
        'Providers',
      );
      await expect(
        window.getByTestId('settings-nav-notifications'),
      ).toHaveCount(0);

      // Account: only this computer's sign-in card.
      await app.openAccountSettingsPage('account');
      await expect(hostedPage(window, 'account/account')).toHaveAttribute(
        'data-hosted-settings-state',
        'signed_out',
      );
      await expect(
        window.getByTestId('account-device-card-cloud-account'),
      ).toBeVisible();
      await expect(
        window
          .getByTestId('account-device-card-cloud-account')
          .getByTestId('settings-account-canopy-cloud-oauth-login'),
      ).toBeVisible();
      await expect(
        window.getByTestId('hosted-settings-signed-out'),
      ).toHaveCount(0);
      expect(await selectedRailRows(window)).toEqual([
        'settings-nav-account-account',
      ]);
      // Every rail row, link or button, shows the arrow cursor rather than a
      // hand.
      const railCursors = await window.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            '[data-testid="settings-sidebar"] [data-testid^="settings-nav-"]:is(a, button)',
          ),
        ).map((row) => getComputedStyle(row).cursor),
      );
      expect(railCursors.length).toBeGreaterThan(10);
      expect(new Set(railCursors)).toEqual(new Set(['default']));

      // Notifications: only the device cards, with no sign-in prompt.
      await app.openAccountSettingsPage('notifications');
      await expect(hostedPage(window, 'account/notifications')).toHaveAttribute(
        'data-hosted-settings-state',
        'signed_out',
      );
      await expect(
        window.getByTestId('hosted-settings-signed-out'),
      ).toHaveCount(0);
      for (const card of [
        'account-device-card-in-app-notifications',
        'account-device-card-os-notifications',
        'account-device-card-notification-categories',
      ]) {
        await expect(window.getByTestId(card)).toBeVisible();
      }
      // The activation journey is off by default, so no Promotional card.
      await expect(
        window.getByTestId('notifications-promotional-section'),
      ).toHaveCount(0);
      // Daily free AI Credits and work digests are gone with hosted settings on.
      await expect(window.getByTestId('settings-cloud-digests')).toHaveCount(0);

      // A device toggle persists across reopen.
      const inAppChat = window.getByTestId('notifications-toggle-in-app-chat');
      await expect(inAppChat).toBeChecked();
      await inAppChat.uncheck();
      await expect(inAppChat).not.toBeChecked();
      await app.closeSettings();
      await app.openSettings();
      await app.openAccountSettingsPage('notifications');
      await expect(
        window.getByTestId('notifications-toggle-in-app-chat'),
      ).not.toBeChecked();

      // Integrations: GitHub and Linear on this computer, again with no
      // sign-in prompt.
      await app.openAccountSettingsPage('integrations');
      await expect(
        window.getByTestId('hosted-settings-signed-out'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('account-device-card-github'),
      ).toBeVisible();
      await expect(
        window
          .getByTestId('account-device-card-github')
          .getByTestId('auth-panel-github'),
      ).toBeVisible();
      await expect(
        window
          .getByTestId('account-device-card-linear')
          .getByTestId('settings-linear-token-input'),
      ).toBeVisible();

      // Security has nothing on this computer, so it keeps the signed-out
      // state, whose Sign in stays inside the app and lands on Account.
      await app.openAccountSettingsPage('security');
      const signedOut = window.getByTestId('hosted-settings-signed-out');
      await signedOut.getByRole('button', { name: 'Sign in' }).click();
      await app.expectAccountSettingsPage('account');
      expect(await selectedRailRows(window)).toEqual([
        'settings-nav-account-account',
      ]);
      expect(externalOpen.opened).toEqual([]);

      // Privacy keeps Activity sharing only.
      await app.openSettingsSection('privacy');
      const privacy = window.getByTestId('settings-tab-privacy');
      await expect(
        privacy.getByTestId('telemetry-disclosure-protection'),
      ).toBeVisible();
      await expect(
        privacy.getByTestId('settings-account-canopy-cloud-section'),
      ).toHaveCount(0);
      await expect(
        privacy.getByTestId('personal-catalog-settings'),
      ).toHaveCount(0);

      // Providers keeps the LLM providers only.
      await app.openSettingsSection('account');
      const providers = window.getByTestId('settings-tab-account');
      await expect(providers.getByTestId('auth-panel-claude')).toBeVisible();
      await expect(providers.getByTestId('auth-panel-codex')).toBeVisible();
      await expect(
        providers.getByTestId('settings-account-canopy-cloud-section'),
      ).toHaveCount(0);
      await expect(providers.getByTestId('auth-panel-github')).toHaveCount(0);
      await expect(
        providers.getByTestId('settings-linear-token-input'),
      ).toHaveCount(0);
      await expect(
        providers.getByTestId('settings-daily-credit-drip'),
      ).toHaveCount(0);
      await app.closeSettings();

      // The palette's Notifications lands on the hosted page; its Providers
      // entry opens the local Providers page.
      await openPaletteSetting(window, 'Notifications');
      await expect(window.getByTestId('settings-overlay')).toBeVisible();
      await app.expectAccountSettingsPage('notifications');
      await expect(
        window.getByTestId('settings-tab-notifications'),
      ).toHaveCount(0);
      await app.closeSettings();
      await openPaletteSetting(window, 'Providers');
      await app.expectSettingsSection('account');

      // App Advisor's `navigation.open_settings` with `notifications` lands
      // on the hosted page, both while Settings is open on another section
      // and from a cold open. (OS deep links only open Privacy.)
      await openSettingsFromAppAdvisor(electronApp, 'notifications');
      await app.expectAccountSettingsPage('notifications');
      expect(await selectedRailRows(window)).toEqual([
        'settings-nav-account-notifications',
      ]);
      await app.closeSettings();
      await openSettingsFromAppAdvisor(electronApp, 'notifications');
      await expect(window.getByTestId('settings-overlay')).toBeVisible();
      await app.expectAccountSettingsPage('notifications');
      await expect(window.getByTestId('settings-tab-canopy')).toHaveCount(0);
      await app.closeSettings();

      // Signed out, nothing reached the hosted settings bridge.
      expect(await unauthenticatedSettingsRequests()).toBe(
        unauthenticatedBefore,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await externalOpen.close();
    }
  });

  test('signed in: Account shows the shared panel and the device card; disconnecting stays on Account', async () => {
    test.setTimeout(150_000);
    const apiKey = 'csk_settings_consolidated_rail_signed_in';
    const { app, electronApp, userDataDir, window } = await launchSignedIn(
      apiKey,
      'hosted-settings-signed-in',
    );
    try {
      await app.openSettings();
      expect(await railGroupIds(window)).toEqual(HOSTED_RAIL_GROUPS);
      // Signed in, the bootstrap adds Digests and Billing. The rows may be
      // drawn from the flag snapshot until the bootstrap lands, so retry.
      await expect
        .poll(() => groupRowIds(window, 'settings-nav-group-account'))
        .toEqual(SIGNED_IN_ACCOUNT_ROWS);

      await app.openAccountSettingsPage('account');
      const content = window.getByTestId('hosted-settings-content');
      await expect(content).toHaveAttribute(
        'data-hosted-settings-page',
        'account/account',
      );
      const deviceCard = content.getByTestId(
        'account-device-card-cloud-account',
      );
      await expect(deviceCard).toBeVisible();
      await expect(
        deviceCard.getByTestId('settings-account-canopy-cloud-section'),
      ).toContainText('portal-e2e@example.test');
      // The device region follows the shared page in the frame.
      const order = await content.evaluate((root) => {
        const device = root.querySelector(
          '[data-testid="account-device-settings-account"]',
        );
        const main = device?.closest('main');
        return main
          ? Array.from(main.children).map((child) =>
              child.contains(device) ? 'device' : 'shared',
            )
          : [];
      });
      expect(order.at(-1)).toBe('device');
      expect(
        order.filter((entry) => entry === 'shared').length,
      ).toBeGreaterThan(0);

      // Billing replaces the drip panel; Digests replaces the digest toggles.
      await app.openAccountSettingsPage('billing');
      await expect(
        window.getByTestId('settings-daily-credit-drip'),
      ).toHaveCount(0);

      // Disconnecting on Account (clearing the saved API key) keeps the page
      // and shows the signed-out frame around this computer's card.
      await app.openAccountSettingsPage('account');
      await deviceCard
        .getByTestId('settings-account-canopy-cloud-api-key-input')
        .fill('');
      await expect(hostedPage(window, 'account/account')).toHaveAttribute(
        'data-hosted-settings-state',
        'signed_out',
        { timeout: 20_000 },
      );
      await expect(
        window.getByTestId('account-device-card-cloud-account'),
      ).toBeVisible();
      await expect(window.getByTestId('settings-tab-canopy')).toHaveCount(0);
      expect(await selectedRailRows(window)).toEqual([
        'settings-nav-account-account',
      ]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('signed in: the rail draws its final rows at first paint on a reopen and after a restart (CAN-4558)', async () => {
    test.setTimeout(240_000);
    const apiKey = 'csk_settings_consolidated_rail_first_paint';
    await registerHostedSettingsScenario(apiKey, 'hosted-settings-signed-in', {
      overrides: {
        operationDelaysMs: { 'settings.bootstrap': BOOTSTRAP_DELAY_MS },
      },
    });
    // The Organizations list is in the rail's scope menu, not a row.
    const expectedRows = SIGNED_IN_ACCOUNT_ROWS;
    const first = await launchCanopy();
    const { userDataDir } = first;
    try {
      const window = await first.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connectMockCloudAccount(window, apiKey);

      // The first open learns the rows from the bootstrap.
      let since = (await bootstrapRequests(apiKey)).length;
      await app.openSettings();
      await waitForBootstrapsAnswered(window, apiKey, since);
      await expect
        .poll(() => groupRowIds(window, 'settings-nav-group-account'))
        .toEqual(SIGNED_IN_ACCOUNT_ROWS);
      await app.closeSettings();

      // A reopen draws the last-known rows at once; the bootstrap is read
      // again and confirms them without a shift.
      since = (await bootstrapRequests(apiKey)).length;
      await startHostedRailRecording(window);
      await app.openSettings();
      await waitForBootstrapsAnswered(window, apiKey, since);
      expect(await stopHostedRailRecording(window)).toEqual([expectedRows]);
      await app.closeSettings();
    } finally {
      await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
    }

    // After a restart only the persisted rows are left to draw from.
    const relaunched = await launchCanopy({ userDataDir });
    try {
      const window = await relaunched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await expect
        .poll(
          () =>
            window.evaluate(async () => {
              const account = await window.api.loadCanopyCloudAccount();
              return account.hasApiKey === true;
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
      const since = (await bootstrapRequests(apiKey)).length;
      await startHostedRailRecording(window);
      await app.openSettings();
      await waitForBootstrapsAnswered(window, apiKey, since);
      expect(await stopHostedRailRecording(window)).toEqual([expectedRows]);
    } finally {
      await closeCanopy(relaunched.electronApp, userDataDir);
    }
  });

  test('signed in: with Integrations off on the server, the page shows only this computer’s rows', async () => {
    test.setTimeout(120_000);
    const apiKey = 'csk_settings_consolidated_rail_integrations_off';
    const { app, electronApp, userDataDir, window } = await launchSignedIn(
      apiKey,
      'hosted-settings-integrations-disabled',
    );
    try {
      await app.openSettings();
      await expect(
        window.getByTestId('settings-nav-account-integrations'),
      ).toBeVisible();
      await app.openAccountSettingsPage('integrations');
      const frame = hostedPage(window, 'account/integrations');
      await expect(frame).toHaveAttribute(
        'data-hosted-settings-state',
        'unavailable',
      );
      await expect(
        frame.getByTestId('account-device-card-github'),
      ).toBeVisible();
      await expect(
        frame.getByTestId('account-device-card-linear'),
      ).toBeVisible();
      // No misleading access-lost, error or loading state.
      for (const state of [
        'hosted-settings-access-lost',
        'hosted-settings-failed',
        'hosted-settings-route-loading',
      ]) {
        await expect(frame.getByTestId(state)).toHaveCount(0);
      }

      // The desktop never asked for the disabled page's data.
      const log = await readHostedSettingsRequests(apiKey);
      expect(
        log.requests.filter(
          (request) =>
            request.operation === 'settings.pageData' &&
            request.body?.route?.page === 'integrations',
        ),
      ).toEqual([]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('signed in: the "Connect a tool" campaign click opens Integrations', async () => {
    test.setTimeout(120_000);
    const apiKey = 'csk_settings_consolidated_rail_campaign';
    const { app, electronApp, userDataDir, window } = await launchSignedIn(
      apiKey,
      'hosted-settings-signed-in',
    );
    try {
      // Playwright cannot click a native banner; deliver the click's
      // navigation event the way main does, with the campaign's deep link.
      const sendCampaignClick = (destination) =>
        electronApp.evaluate(({ BrowserWindow }, payload) => {
          const mainWindow = BrowserWindow.getAllWindows().find(
            (candidate) =>
              !candidate.webContents.getURL().includes('surface=app-advisor'),
          );
          if (!mainWindow) throw new Error('Main window not found');
          mainWindow.webContents.send('activation-campaign:navigate', payload);
        }, destination);

      await sendCampaignClick({
        campaignId: 'getting-started',
        itemId: 'connect-accounts',
        destination: {
          kind: 'settings',
          section: 'account',
          target: 'integrations',
        },
      });
      await expect(window.getByTestId('settings-overlay')).toBeVisible();
      await app.expectAccountSettingsPage('integrations');
      expect(await selectedRailRows(window)).toEqual([
        'settings-nav-account-integrations',
      ]);
      await app.closeSettings();

      // "Create an account" (no target) opens the cloud Account page.
      await sendCampaignClick({
        campaignId: 'getting-started',
        itemId: 'create-account',
        destination: { kind: 'settings', section: 'account' },
      });
      await app.expectAccountSettingsPage('account');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('guest: a guest is signed out for hosted settings and keeps daily credits in Providers', async () => {
    test.setTimeout(120_000);
    const { electronApp, userDataDir } = await launchCanopy();
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const guestAccount = await window.evaluate(
        async (consent) => window.api.startCanopyGuestSession(consent),
        GUEST_CONSENT,
      );
      expect(guestAccount.credentialSource).toBe('guest');

      await app.openSettings();
      expect(await railGroupIds(window)).toEqual(HOSTED_RAIL_GROUPS);
      await app.openAccountSettingsPage('account');
      await expect(hostedPage(window, 'account/account')).toHaveAttribute(
        'data-hosted-settings-state',
        'signed_out',
      );
      await expect(
        window.getByTestId('account-device-card-cloud-account'),
      ).toBeVisible();
      await expect(
        window.getByTestId('settings-daily-credit-drip'),
      ).toHaveCount(0);
      // A guest has no hosted Billing page, so Providers keeps the daily
      // credits switch that the recovery offer points to (CAN-5214).
      await app.openSettingsSection('account');
      await expect(
        window
          .getByTestId('settings-tab-account')
          .getByTestId('settings-daily-credit-drip'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('flag off: the legacy rail and Accounts page are unchanged', async () => {
    test.setTimeout(120_000);
    const { electronApp, userDataDir } = await launchCanopy({
      env: FLAG_OFF_ENV,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();
      await app.expectSettingsSection('canopy');
      expect(await railGroupIds(window)).toEqual(LEGACY_RAIL_GROUPS);
      for (const [groupTestId, name] of [
        ['settings-nav-group-personal', 'Personal'],
        ['settings-nav-group-agents', 'Agents'],
        ['settings-nav-group-integrations', 'Integrations'],
      ]) {
        await expect(window.getByTestId(groupTestId)).toHaveAccessibleName(
          name,
        );
      }
      expect(await groupRowIds(window, 'settings-nav-group-personal')).toEqual([
        'settings-nav-canopy',
        'settings-nav-account',
        'settings-nav-privacy',
        'settings-nav-remote-access',
        'settings-nav-display',
        'settings-nav-notifications',
      ]);
      await expect(window.getByTestId('settings-nav-account')).toHaveText(
        'Accounts',
      );
      await expect(window.getByTestId('hosted-settings-content')).toHaveCount(
        0,
      );

      await app.openSettingsSection('account');
      const accounts = window.getByTestId('settings-tab-account');
      await expect(
        accounts.getByTestId('settings-account-canopy-cloud-section'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(accounts.getByTestId('auth-panel-claude')).toBeVisible();
      await expect(accounts.getByTestId('auth-panel-github')).toBeVisible();
      await expect(
        accounts.getByTestId('settings-linear-token-input'),
      ).toBeVisible({ timeout: 20_000 });
      const headers = await accounts
        .locator('[data-testid^="account-section-header-"]')
        .allTextContents();
      expect(headers.map((text) => text.trim())).toEqual([
        'LLM provider',
        'Version control',
        'Project management',
      ]);

      await app.openSettingsSection('notifications');
      await expect(
        window.getByTestId('notifications-toggle-in-app-chat'),
      ).toBeVisible();
      await app.openSettingsSection('privacy');
      await expect(
        window
          .getByTestId('settings-tab-privacy')
          .getByTestId('settings-account-canopy-cloud-section'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
