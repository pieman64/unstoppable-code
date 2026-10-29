// Remote Control on the account row and in the account menu (CAN-3659).
//
// Desktop no longer lists Remote Control in the sidebar nav, the More menu or
// Customize sidebar. The account row's second line reports the Portal worker
// state (active, reconnecting, disconnected) and falls back to the account
// email while Remote Control is off; the personal account menu opens the
// Remote Control dialog. Both are gated on `canopy-portal-enabled`.
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

const ACCOUNT = { name: 'Ada Lovelace', email: 'ada@example.test' };

// The one set of portal fixtures for CAN-3659: the unit tables and the capture
// spec copy these field values verbatim.
const PORTAL_STATE_BASE = {
  sessionId: 'portal-session-can-3659',
  pairingCode: null,
  pairingCodeExpiresAt: null,
  machineName: 'Test Mac',
  activatedAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-01T10:05:00.000Z',
  lastErrorAt: null,
  error: null,
};
const PORTAL_STATES = {
  active: {
    ...PORTAL_STATE_BASE,
    status: 'active',
    connectionStatus: 'active',
  },
  reconnecting: {
    ...PORTAL_STATE_BASE,
    status: 'reconnecting',
    connectionStatus: 'reconnecting',
  },
  // What the worker reports once the server ends the session
  // (`transitionInactiveFromServer`): the timestamps are cleared.
  disconnected: {
    ...PORTAL_STATE_BASE,
    status: 'inactive',
    connectionStatus: 'inactive',
    sessionId: null,
    activatedAt: null,
    lastSeenAt: null,
    lastErrorAt: '2026-10-01T10:06:00.000Z',
    error: 'Remote Control session ended on the server.',
  },
};

/** Launch signed in as {@link ACCOUNT}, with any extra client flags. */
async function launchSignedIn({ apiKey, flags = {} }) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { account: ACCOUNT },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can-3659-'));
  const { electronApp } = await launchCanopy({
    userDataDir,
    ...(Object.keys(flags).length > 0
      ? { env: { CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify(flags) } }
      : {}),
  });
  const window = await electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await window.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; }',
  });
  await connectMockCloudAccount(window, apiKey);
  await expect(window.getByTestId('sidebar-account-identity')).toHaveText(
    ACCOUNT.name,
    { timeout: 20_000 },
  );
  return { electronApp, userDataDir, window };
}

/**
 * Stand in for the main-process worker's broadcast. It crosses the real
 * preload bridge into the store App.tsx hydrates.
 */
async function broadcastPortalState(electronApp, state) {
  await electronApp.evaluate(({ BrowserWindow }, next) => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      browserWindow.webContents.send('canopy-portal:state-changed', next);
    }
  }, state);
}

/**
 * Broadcast and wait for the row to report `status`. The initial `hydrate()`
 * can land after the first broadcast and overwrite it, so re-send once.
 */
async function seedPortalState(electronApp, window, status) {
  const subtitle = window.getByTestId(
    'sidebar-account-remote-control-subtitle',
  );
  await broadcastPortalState(electronApp, PORTAL_STATES[status]);
  try {
    await expect(subtitle).toHaveAttribute('data-status', status, {
      timeout: 2_000,
    });
  } catch {
    await broadcastPortalState(electronApp, PORTAL_STATES[status]);
    await expect(subtitle).toHaveAttribute('data-status', status);
  }
  return subtitle;
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

/** The account row's accessible name, from its `aria-labelledby` targets. */
async function rowAccessibleName(window) {
  return window.getByTestId('sidebar-account-row').evaluate((row) =>
    (row.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
}

test('reports Remote Control on the account row and opens it from the account menu', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can_3659_remote_control_on';
  const { electronApp, userDataDir, window } = await launchSignedIn({
    apiKey,
  });
  try {
    await test.step('the nav, More and Customize do not list Remote Control', async () => {
      await expect(
        window.getByTestId('sidebar-nav-remote-control'),
      ).toHaveCount(0);
      await window.getByTestId('sidebar-more').click();
      await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
      await expect(
        window.getByTestId('sidebar-more-item-remote-control'),
      ).toHaveCount(0);
      await window.getByTestId('sidebar-more-item-customize').click();
      const modal = window.getByTestId('customize-sidebar-modal');
      await expect(modal).toBeVisible();
      await expect(
        window.getByTestId('customize-sidebar-row-plugins'),
      ).toBeVisible();
      await expect(
        window.getByTestId('customize-sidebar-row-remote-control'),
      ).toHaveCount(0);
      await window.getByTestId('customize-sidebar-cancel').click();
      await expect(modal).toHaveCount(0);
    });

    await test.step('a never-paired account reads as off: the name alone', async () => {
      await expect(
        window.getByTestId('sidebar-account-remote-control-subtitle'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-subscription-plan-subtitle'),
      ).toHaveCount(0);
      const listItem = window.getByTestId('sidebar-account-list-item');
      await expect(listItem).not.toContainText(ACCOUNT.email);
      await expect(listItem).toHaveClass(/(^|\s)h-8(\s|$)/);
    });

    await test.step('active', async () => {
      const subtitle = await seedPortalState(electronApp, window, 'active');
      await expect(subtitle).toHaveText('Remote control active');
      await expect(window.getByTestId('sidebar-account-list-item')).toHaveClass(
        /(^|\s)h-10(\s|$)/,
      );
    });

    await test.step('reconnecting says so and pings', async () => {
      const subtitle = await seedPortalState(
        electronApp,
        window,
        'reconnecting',
      );
      await expect(subtitle).toHaveText('Remote control reconnecting');
      await expect(
        window.getByTestId('sidebar-account-remote-control-ping'),
      ).toBeAttached();
    });

    await test.step('disconnected takes the failed ink', async () => {
      const subtitle = await seedPortalState(
        electronApp,
        window,
        'disconnected',
      );
      await expect(subtitle).toHaveText('Remote control disconnected');
      expect(await colorOf(subtitle)).toBe(
        await probeColor(window, 'fg-destructive-strong'),
      );
    });

    await test.step('the account menu opens the Remote Control dialog', async () => {
      expect(await rowAccessibleName(window)).toContain(
        'Remote control disconnected',
      );
      await window.getByTestId('sidebar-account-row').click();
      const usage = window.getByTestId('sidebar-account-menu-item-usage');
      const item = window.getByTestId(
        'sidebar-account-menu-item-remote-control',
      );
      await expect(item).toBeVisible();
      await expect(item).toHaveText('Remote Control');
      const usageBox = await usage.boundingBox();
      const itemBox = await item.boundingBox();
      expect(usageBox).not.toBeNull();
      expect(itemBox).not.toBeNull();
      expect(itemBox?.y ?? 0).toBeGreaterThan(usageBox?.y ?? 0);
      await item.click();
      await expect(window.getByTestId('canopy-portal-modal')).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('canopy-portal-modal')).toBeHidden();
    });
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => {});
    await closeCanopy(electronApp, userDataDir);
  }
});

test('with the portal flag off, the menu has no Remote Control and the row keeps the email', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can_3659_remote_control_off';
  const { electronApp, userDataDir, window } = await launchSignedIn({
    apiKey,
    flags: { 'canopy-portal-enabled': false },
  });
  try {
    await window.getByTestId('sidebar-account-row').click();
    await expect(window.getByTestId('sidebar-account-menu')).toBeVisible();
    await expect(
      window.getByTestId('sidebar-account-menu-item-usage'),
    ).toBeVisible();
    await expect(
      window.getByTestId('sidebar-account-menu-item-remote-control'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');

    // A stale active snapshot must not surface while the flag is off. There
    // is no positive signal to wait for, so hold briefly and assert absence.
    await broadcastPortalState(electronApp, PORTAL_STATES.active);
    await window.waitForTimeout(1_000);
    await expect(window.getByTestId('sidebar-account-list-item')).toHaveClass(
      /(^|\s)h-8(\s|$)/,
    );
    await expect(
      window.getByTestId('sidebar-account-remote-control-subtitle'),
    ).toHaveCount(0);
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => {});
    await closeCanopy(electronApp, userDataDir);
  }
});
