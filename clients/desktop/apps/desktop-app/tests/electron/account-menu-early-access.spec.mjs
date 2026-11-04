// The sidebar's personal account menu with early access on and off
// (CAN-4055).
//
// Both modes share one menu: a header naming the signed-in person, then
// Usage, a `Sync paused` status row that explains itself on hover, and
// `Sign out` last. Settings and Send feedback live on the account row's rail;
// the Personal/organization switcher is at the top of the sidebar. Early
// access changes ink only: usage near its limit shows as dots there, while
// without it the name and the Usage row take the usage ink.
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
  registerScenario,
} from './seeders/index.mjs';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ORGANIZATIONS = [
  {
    id: ORG_ID,
    name: 'Acme',
    role: 'MEMBER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];
const ACCOUNT = { name: 'Ada Lovelace', email: 'ada@example.test' };
// The app sends `Bearer mock` to the mock server for provider usage
// (launchCanopy.mjs), so this scenario drives the Claude usage probe.
const USAGE_SCENARIO_KEY = 'mock';

/** Launch with early access on or off, signed in with one organization. */
async function launchSignedIn({ earlyAccess, apiKey }) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORGANIZATIONS,
      account: ACCOUNT,
      // Signed in, Early access is the account's stored choice.
      experiments: { choices: { 'early-access': earlyAccess } },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_SCENARIO_KEY, {
    authUsage: { scenario: 'authed-near-limit' },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-acct-menu-'));
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-org-projects-enabled': true,
      }),
    },
  });
  const window = await electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await window.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; }',
  });
  await connectMockCloudAccount(window, apiKey);
  await expect
    .poll(async () =>
      window.evaluate(
        async () =>
          (await window.api.workspaceContext.get()).organizations.length,
      ),
    )
    .toBe(ORGANIZATIONS.length);
  return { electronApp, userDataDir, window };
}

/**
 * Stand in for the pause monitor's broadcast (CAN-3512): a queue whose oldest
 * item passed the six-hour threshold with no upload since. It crosses the real
 * preload guard, as telemetry-sync-paused.spec.mjs does.
 */
async function broadcastSyncPaused(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      browserWindow.webContents.send('telemetry-sync:status-event', {
        isSyncing: false,
        pendingCount: 12,
        sharingActive: true,
        lastSyncedAt: new Date(Date.now() - 30 * 3_600_000).toISOString(),
        lastErrorAt: null,
        lastError: null,
        pausedReason: 'queue-stalled',
      });
    }
  });
}

/** The computed value a class resolves to, from a probe carrying only it. */
async function probeColor(window, className) {
  return window.evaluate((name) => {
    const probe = document.createElement('span');
    probe.className = name;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, className);
}

async function colorOf(locator) {
  return locator.evaluate((element) => getComputedStyle(element).color);
}

/** Top edges of the given menu parts, failing if any is missing. */
async function tops(window, testIds) {
  const result = [];
  for (const testId of testIds) {
    const box = await window.getByTestId(testId).boundingBox();
    expect(box, `${testId} is laid out`).not.toBeNull();
    result.push(box.y);
  }
  return result;
}

function expectAscending(values) {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index]).toBeGreaterThan(values[index - 1]);
  }
}

for (const earlyAccess of [true, false]) {
  test(`personal menu order and ink with early access ${earlyAccess ? 'on' : 'off'}`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_account_menu_early_access_${earlyAccess ? 'on' : 'off'}`;
    const { electronApp, userDataDir, window } = await launchSignedIn({
      earlyAccess,
      apiKey,
    });
    try {
      // The switcher is at the top, never beside the account row.
      await expect(
        window
          .getByTestId('sidebar-top-context-row')
          .getByTestId('sidebar-context-row'),
      ).toBeVisible();
      await expect(
        window
          .getByTestId('sidebar-account-footer')
          .getByTestId('sidebar-context-row'),
      ).toHaveCount(0);

      // The avatar's dot reports usage; the name keeps the account row's
      // inherited ink for everyone after the Labs graduation (#5891).
      await expect(
        window.getByTestId('sidebar-account-attention-dot'),
      ).toBeVisible({ timeout: 20_000 });
      const identity = window.getByTestId('sidebar-account-identity');
      await expect(identity).toHaveText(ACCOUNT.name);
      const warning = await probeColor(window, 'fg-warning');
      const primary = await probeColor(window, 'fg-primary');
      expect(warning).not.toBe(primary);
      expect(await colorOf(identity)).not.toBe(warning);
      expect(await colorOf(identity)).toBe(
        await colorOf(window.getByTestId('sidebar-account-row')),
      );

      await broadcastSyncPaused(electronApp);
      await window.getByTestId('sidebar-account-row').click();
      const menu = window.getByTestId('sidebar-account-menu');
      await expect(menu).toBeVisible();
      const header = menu.getByTestId('sidebar-account-menu-header-identity');
      await expect(header).toContainText(ACCOUNT.name);
      await expect(header).toContainText(ACCOUNT.email);
      for (const removed of [
        'sidebar-account-menu-item-settings',
        'sidebar-account-menu-item-feedback',
        'sidebar-context-option-personal',
        'sidebar-account-menu-email-label',
      ]) {
        await expect(menu.getByTestId(removed)).toHaveCount(0);
      }
      const paused = menu.getByTestId('sidebar-account-menu-sync-paused');
      await expect(paused).toBeVisible();
      await expect(paused).toHaveAttribute('role', 'status');
      expectAscending(
        await tops(window, [
          'sidebar-account-menu-header-identity',
          'sidebar-account-menu-item-usage',
          'sidebar-account-menu-sync-paused',
          'sidebar-account-menu-item-sign-in-out',
        ]),
      );
      await expect(menu.getByRole('menuitem').last()).toHaveText('Sign out');

      // Sync paused lines up with Usage: same left edge, height, and label
      // column.
      const usage = menu.getByTestId('sidebar-account-menu-item-usage');
      const usageBox = await usage.boundingBox();
      const pausedBox = await paused.boundingBox();
      expect(pausedBox.x).toBeCloseTo(usageBox.x, 0);
      expect(pausedBox.height).toBeCloseTo(usageBox.height, 0);
      await expect(
        paused.getByTestId('sidebar-account-sync-paused-dot'),
      ).toBeVisible();

      // Its tooltip says what happened and what to do.
      await paused.hover();
      await expect(window.getByRole('tooltip')).toHaveText(
        /^Activity you share hasn't reached .+ in over 6 hours\. It's saved on this device and will upload automatically\. If this continues, check your internet connection or open Settings → Privacy\.$/,
      );

      // Usage near its limit keeps the warning on the dot, with primary
      // row ink for everyone after graduation.
      await expect(
        usage.getByTestId('sidebar-account-usage-alert-dot'),
      ).toBeVisible();
      await expect.poll(() => colorOf(usage)).toBe(primary);

      await window.keyboard.press('Escape');
      await expect(menu).toBeHidden();

      // Settings opens from the rail beside the account row.
      await window.getByTestId('sidebar-account-action-settings').click();
      await expect(window.getByTestId('settings-overlay')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_SCENARIO_KEY);
    }
  });
}
