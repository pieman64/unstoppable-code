import { selectModelOption } from './model-selection-fixture.mjs';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { cursorRuntimeFixture } from './fixtures/cursor-runtime.mjs';
import { expectCursorConnected } from './fixtures/cursor-tile.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';

// Doc 2 Spec 5 (usage half) / Doc 6 — provider auth + usage cards driven by the
// WP-MOCK-AUTHUSAGE HTTP surface (PRs 814, 832). This exercises the AUTH/USAGE
// mock over HTTP, NOT a live chat turn.
//
// ── How the app reaches the mock (build-gated E2E seams) ────────────────────
//   - Claude usage: `observability/service.ts` calls
//     `readClaudeOauthCredentialsResult()`, which returns a successful dummy
//     credential containing `CANOPY_MOCK_API_KEY ?? 'mock'`, and
//     `resolveClaudeUsageUrl()` points at `<mock>/api/oauth/usage`, so the
//     Claude usage window GET is sent with `Authorization: Bearer mock`.
//   - Codex usage: `readCodexUsageSources()` fetches `<mock>/__mock/codex/account`
//     and `<mock>/__mock/codex/ratelimits` with `Authorization: Bearer mock`.
//   `launchCanopy.mjs` injects `CANOPY_MOCK_LLM_BASE_URL=http://127.0.0.1:4011`
//   and `CANOPY_MOCK_API_KEY=mock`, so the scenario KEY for both providers is the
//   static bearer `mock` (see `mock-server/routes/authUsage.mjs` →
//   `keyFromBearer`). We register the scenario under that key BEFORE launch so
//   the app's startup `refreshUsageAdapters()` AND the on-demand refresh button
//   both resolve the seeded scenario.
//
// ── Deterministic provider state ────────────────────────────────────────────
//   Both providers' usage and live auth probes are build-gated to the mock
//   control plane, so account state and rate-limit cards are deterministic
//   across machines and CI.
//
// Usage-limit banners are rendered by the chat surface, not by the usage HTTP
// cards. The mock-chat banner coverage lives in
// `chat-usage-limit-banner.spec.mjs`, while this file stays focused on provider
// auth/usage cards.

const USAGE_KEY = 'mock';

/** The same usage fetch a finished Cursor turn triggers. */
async function refreshCursorUsage(window) {
  await window.evaluate(() => window.api.observability.refreshUsage('cursor'));
}

async function connectCursor(app, window, { plan } = {}) {
  await app.openSettings();
  await app.openSettingsSection('experiments');
  await window.getByTestId('cursor-connect').click();
  await expectCursorConnected(window);
  // The Settings tile joins the seeded plan onto the signed-in line once the
  // connect-time usage refresh lands, as the Claude / Codex tiles do.
  if (plan !== undefined) {
    await expect(window.getByTestId('cursor-connection-account')).toHaveText(
      `Signed in as fixture@example.test · ${plan}`,
    );
  }
  await app.closeSettings();
}

for (const variant of ['all', 'cursor', 'active-chat']) {
  test(`Cursor account usage is available in the ${variant} Usage panel`, async () => {
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: {
        cursor: {
          // The tile shows the plan only for the CLI's signed-in address, so
          // the seeded usage account is the fixture agent's account.
          account: {
            userId: 'panel-account',
            email: 'fixture@example.test',
          },
          plan: { planInfo: { planName: 'Pro' } },
          usage: { enabled: true, planUsage: { totalPercentUsed: 25 } },
        },
      },
    });
    const managed = await cursorRuntimeFixture();
    const { electronApp, userDataDir, window, app } = await seedPanelWorktree({
      providerType: 'cursor',
      env: managed.env,
    });
    try {
      await connectCursor(app, window, { plan: 'Pro' });
      const picker = window
        .getByTestId('panel-content-chat')
        .getByTestId('chat-model-picker');
      await picker.click();
      await selectModelOption(window, 'cursor-default');
      await expect(picker).toContainText('Cursor');
      await window.getByTestId('panel-add-tab-group-chat').click();
      await window.getByTestId('panel-add-menu-usage-submenu').click();
      await window.getByTestId(`panel-add-menu-item-usage-${variant}`).click();
      const panel = window.getByTestId('panel-content-usage');
      await expect(panel).toBeVisible();
      const cursor = panel.getByTestId('usage-provider-card-cursor');
      await expect(cursor).toContainText('fixture@example.test');
      await expect(cursor).toContainText('25%');
      // The panel has one refresh control, in its Updated line above the
      // provider groups.
      const refreshUsage = panel.getByTestId('usage-refresh');
      await refreshUsage.click();
      await expect(refreshUsage).toBeEnabled();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await managed.close();
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY);
    }
  });
}

test('Cursor composer shows account usage and response tokens with refresh and recovery', async () => {
  const cursor = {
    account: { userId: 'composer-user', email: 'composer@example.com' },
    plan: { planInfo: { planName: 'Pro' } },
    usage: {
      enabled: true,
      billingCycleEnd: '4099680000000',
      planUsage: {
        totalPercentUsed: 25,
        includedSpend: 500,
        remaining: 1500,
        limit: 2000,
      },
    },
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
    authUsage: { cursor },
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp, userDataDir, window, app } = await seedPanelWorktree({
    providerType: 'cursor',
    env: managed.env,
  });
  try {
    await connectCursor(app, window);
    const panel = window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(window, 'cursor-default');
    await panel.getByTestId('usage-indicator').click();
    const popover = window.getByTestId('usage-indicator-popover');
    const account = popover.getByTestId('usage-indicator-account');
    // The header names the subscription, then the account in brackets.
    await expect(account.locator('[title="composer@example.com"]')).toHaveCount(
      1,
    );
    await expect(account.getByTestId('usage-indicator-plan')).toHaveText(
      'Cursor Pro',
    );
    await expect(
      account.getByTestId('usage-indicator-account-label'),
    ).toHaveText('(composer@example.com)');
    await expect(account).toContainText('25%');
    await expect(account).toContainText('$15.00');
    await expect(account).toContainText('Resets');
    await expect(popover).toContainText('Cursor has not reported token usage.');
    await panel.getByTestId('usage-indicator').click();
    await panel.getByRole('textbox').first().fill('CURSOR_CHAT_E2E_USAGE');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Usage response complete.', { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0);
    await panel.getByTestId('usage-indicator').click();
    await expect(account).toContainText('25%');
    await expect(popover).toContainText('Response tokens');
    await expect(popover).toContainText('12.0k');
    await expect(popover).toContainText('800');
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: {
        cursor: {
          ...cursor,
          usage: {
            ...cursor.usage,
            planUsage: { ...cursor.usage.planUsage, totalPercentUsed: 40 },
          },
        },
      },
    });
    // The popover has no refresh button: usage refreshes as it opens (at most
    // every 30s) and after turns. Drive the same fetch a finished turn does,
    // and the open popover updates in place.
    await refreshCursorUsage(window);
    await expect(account).toContainText('40%');
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: { cursor: { ...cursor, usageHttpStatus: 503 } },
    });
    await refreshCursorUsage(window);
    await expect(account).toContainText('Cursor account usage is unavailable.');
    await expect(account).not.toContainText('40%');
    await expect(popover).toContainText('12.0k');
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: { cursor },
    });
    // A failed read offers a retry in place of the old button.
    await account.getByTestId('usage-indicator-retry').click();
    await expect(account).toContainText('25%');
    // Keep the composer controls visible; narrow panels move Usage into overflow.
    await window.setViewportSize({ width: 1400, height: 400 });
    await expect
      .poll(async () => {
        const box = await popover.boundingBox();
        return box !== null && box.y >= 0 && box.y + box.height <= 400;
      })
      .toBe(true);
    await popover.getByText('800', { exact: true }).scrollIntoViewIfNeeded();
    await expect(popover.getByText('800', { exact: true })).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY);
  }
});

for (const kind of ['auth', 'unsupported']) {
  test(`Cursor composer explains ${kind} account usage without suggesting a retry`, async () => {
    const cursor = {
      account: { userId: 'composer-guidance', email: 'guidance@example.com' },
      usage: { enabled: true, planUsage: { totalPercentUsed: 25 } },
    };
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: { cursor },
    });
    const managed = await cursorRuntimeFixture();
    const { electronApp, userDataDir, window, app } = await seedPanelWorktree({
      providerType: 'cursor',
      env: managed.env,
    });
    try {
      await connectCursor(app, window);
      const panel = window.getByTestId('panel-content-chat');
      await panel.getByTestId('chat-model-picker').click();
      await selectModelOption(window, 'cursor-default');
      await panel.getByTestId('usage-indicator').click();
      const popover = window.getByTestId('usage-indicator-popover');
      const account = popover.getByTestId('usage-indicator-account');
      await expect(account).toContainText('25%');
      await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
        authUsage: {
          cursor:
            kind === 'auth'
              ? { ...cursor, usageHttpStatus: 401 }
              : { ...cursor, usage: { enabled: false } },
        },
      });
      await refreshCursorUsage(window);
      await expect(account).toContainText(
        kind === 'auth'
          ? 'Connect Cursor to see account usage.'
          : 'Cursor has not provided usage details for this account.',
      );
      // Signing in or an unsupported account is not fixed by fetching again.
      await expect(account.getByTestId('usage-indicator-retry')).toHaveCount(0);
      await expect(account).not.toContainText('25%');
      await expect(popover).toContainText(
        'Cursor has not reported token usage.',
      );
      await account.getByRole('button', { name: 'Manage Cursor' }).click();
      await expect(window.getByTestId('cursor-connection')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await managed.close();
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY);
    }
  });
}

test('Cursor rollout hides cached usage cards and sidebar warnings together', async () => {
  await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
    authUsage: {
      cursor: {
        account: { userId: 'cursor-warning', email: 'cursor@example.com' },
        usage: { enabled: true, planUsage: { totalPercentUsed: 95 } },
      },
    },
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp, userDataDir } = await launchCanopy({ env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(app, window);
    await app.openUsagePage();
    await expect(
      window.getByTestId('usage-provider-card-cursor'),
    ).toContainText('95%');
    await window.getByTestId('sidebar-account-row').click();
    await expect(
      window.getByTestId('sidebar-account-usage-alert-dot'),
    ).toBeVisible();
    await electronApp.evaluate(() => {
      const flags = JSON.parse(
        process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}',
      );
      flags['canopy-desktop-cursor-harness'] = false;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(flags);
    });
    await window.evaluate(() => window.api.featureFlags.refreshContext());
    await expect(window.getByTestId('usage-provider-card-cursor')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('sidebar-account-usage-alert-dot'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY);
  }
});

test('Cursor account usage appears and refreshes on the Usage page', async () => {
  const cursor = {
    account: { email: 'cursor@example.com', userId: 'cursor-user-test' },
    usage: {
      enabled: true,
      billingCycleStart: String(Date.now() - 10 * 86400_000),
      billingCycleEnd: String(Date.now() + 20 * 86400_000),
      planUsage: {
        totalPercentUsed: 75,
        autoPercentUsed: 10,
        apiPercentUsed: 20,
        includedSpend: 1500,
        remaining: 500,
        limit: 2000,
      },
      spendLimitUsage: { individualUsed: 1250, limitType: 'user' },
    },
    plan: { planInfo: { planName: 'Pro' } },
    hardLimit: { hardLimit: 50 },
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
    authUsage: { cursor },
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp, userDataDir } = await launchCanopy({ env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectCursor(app, window);
    await app.openUsagePage();
    const card = window.getByTestId('usage-provider-card-cursor');
    // The Usage page has one refresh control, in its heading.
    const refreshUsage = window
      .getByTestId('page-usage')
      .getByTestId('usage-refresh');
    await expect(card).toBeVisible();
    await expect(card).toContainText('cursor@example.com');
    await expect(card).toContainText('Pro');
    await expect(card).toContainText('75%');
    await expect(card).toContainText('$5.00');
    await expect(card).toContainText('$12.50 spent');
    await expect(card).toContainText('$37.50');
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: {
        cursor: {
          ...cursor,
          usage: {
            ...cursor.usage,
            planUsage: { ...cursor.usage.planUsage, totalPercentUsed: 80 },
          },
        },
      },
    });
    await refreshUsage.click();
    await expect(card).toContainText('80%');
    // A failed refresh clears live counters and offers a real retry.
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: { cursor: { ...cursor, usageHttpStatus: 503 } },
    });
    await refreshUsage.click();
    await expect(card).toContainText('Usage unavailable.');
    await expect(card).toContainText(
      'Cursor is not answering right now, so try again in a moment.',
    );
    await expect(card).not.toContainText('80%');
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: {
        cursor: {
          ...cursor,
          account: { email: 'second@example.com', userId: 'second' },
        },
      },
    });
    await card.getByRole('button', { name: 'Try again' }).click();
    await expect(card).toContainText('second@example.com');
    await expect(card).toContainText('75%');
    // A sign-out cannot leave another account's usage presented as current.
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: { cursor: { account: null } },
    });
    await refreshUsage.click();
    await expect(card).toContainText('Sign in to Cursor again');
    await expect(card).not.toContainText('75%');
    await card.getByTestId('usage-provider-cursor-manage').click();
    await expect(window.getByTestId('cursor-connection')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY);
  }
});

async function setCursorRollout(electronApp, window, enabled) {
  await electronApp.evaluate((_electron, value) => {
    const flags = JSON.parse(
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}',
    );
    flags['canopy-desktop-cursor-harness'] = value;
    process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(flags);
  }, enabled);
  await window.evaluate(() => window.api.featureFlags.refreshContext());
}

test('Cursor account usage uses the billing reset supplied by the plan', async () => {
  await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
    authUsage: {
      cursor: {
        account: { email: 'reset@example.com', userId: 'reset' },
        usage: { enabled: true, planUsage: { totalPercentUsed: 75 } },
        plan: {
          planInfo: {
            planName: 'Pro',
            billingCycleEnd: String(Date.now() + 20 * 86400_000),
          },
        },
      },
    },
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp, userDataDir } = await launchCanopy({ env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(app, window);
    await app.openUsagePage();
    const card = window.getByTestId('usage-provider-card-cursor');
    await expect(card).toContainText('75%');
    await expect(card).toContainText('Resets ');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY);
  }
});

test('Cursor account usage resumes after a rollout-disabled restart', async () => {
  await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
    authUsage: {
      cursor: {
        account: { email: 'rollout@example.com', userId: 'rollout' },
        usage: { enabled: true, planUsage: { totalPercentUsed: 25 } },
      },
    },
  });
  const managed = await cursorRuntimeFixture();
  let { electronApp, userDataDir } = await launchCanopy({ env: managed.env });
  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(app, window);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...managed.env,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-cursor-harness': false,
        }),
      },
    }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openUsagePage();
    await expect(window.getByTestId('usage-provider-card-cursor')).toHaveCount(
      0,
    );
    await setCursorRollout(electronApp, window, true);
    const card = window.getByTestId('usage-provider-card-cursor');
    await expect(card).toContainText('25%');
    await setCursorRollout(electronApp, window, false);
    await expect(card).toHaveCount(0);
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: {
        cursor: {
          account: { email: 'rollout@example.com', userId: 'rollout' },
          usage: { enabled: true, planUsage: { totalPercentUsed: 40 } },
        },
      },
    });
    await setCursorRollout(electronApp, window, true);
    await expect(card).toContainText('40%');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY);
  }
});

test('Cursor retained account usage survives shutdown with the rollout disabled', async () => {
  test.setTimeout(120_000);
  const billingCycleEnd = String(Date.now() + 20 * 86400_000);
  await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
    authUsage: {
      cursor: {
        account: { email: 'retained@example.com', userId: 'retained' },
        usage: {
          enabled: true,
          billingCycleEnd,
          planUsage: { totalPercentUsed: 25 },
        },
      },
    },
  });
  const managed = await cursorRuntimeFixture();
  let { electronApp, userDataDir } = await launchCanopy({ env: managed.env });
  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(app, window);
    await app.openUsagePage();
    await expect(
      window.getByTestId('usage-provider-card-cursor'),
    ).toContainText('25%');
    await expect(
      window.getByTestId('usage-provider-card-cursor'),
    ).toContainText('Resets ');
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...managed.env,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-cursor-harness': false,
        }),
      },
    }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openUsagePage();
    await expect(window.getByTestId('usage-provider-card-cursor')).toHaveCount(
      0,
    );
    const disabledSnapshotMtime = statSync(
      path.join(userDataDir, 'agent-observability', 'snapshot.json'),
    ).mtimeMs;
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByLabel('Retention days', { exact: true }).fill('14');
    await app.closeSettings();
    // Updating audit retention schedules a snapshot while the Cursor rollout is off.
    await expect
      .poll(
        () =>
          statSync(
            path.join(userDataDir, 'agent-observability', 'snapshot.json'),
          ).mtimeMs,
      )
      .toBeGreaterThan(disabledSnapshotMtime);
    const persisted = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'agent-observability', 'snapshot.json'),
        'utf8',
      ),
    );
    expect(persisted.usage.accountSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountEmail: 'retained@example.com' }),
      ]),
    );
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    // A different current account makes the retained account independently visible.
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: {
        cursor: {
          account: { email: 'current@example.com', userId: 'current' },
          usage: {
            enabled: true,
            billingCycleEnd,
            planUsage: { totalPercentUsed: 40 },
          },
        },
      },
    });
    ({ electronApp } = await launchCanopy({ userDataDir, env: managed.env }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openUsagePage();
    const card = window.getByTestId('usage-provider-card-cursor');
    await expect(card).toContainText('current@example.com');
    await expect(card).toContainText('40%');
    const retainedToggle = card.getByTestId(
      'other-account-snapshots-toggle-cursor',
    );
    await expect(retainedToggle).toBeVisible();
    await retainedToggle.click();
    await expect(card.getByTestId('other-account-single-cursor')).toContainText(
      'retained@example.com',
    );
    await expect(card).toContainText('25%');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY);
  }
});

test('Cursor Usage App Advisor action obeys the live rollout', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    // Use the real Advisor request/response bridge, as transcript-storage tests do.
    const dispatch = (requestId) =>
      electronApp.evaluate(async ({ BrowserWindow, ipcMain }, requestId) => {
        ipcMain.removeHandler('app-advisor:tool-response');
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Advisor response timed out')),
            15000,
          );
          ipcMain.handle('app-advisor:tool-response', (_event, response) => {
            if (response?.requestId !== requestId) return;
            clearTimeout(timer);
            resolve(response);
          });
          const main = BrowserWindow.getAllWindows().find(
            (candidate) =>
              !candidate.webContents.getURL().includes('surface=app-advisor'),
          );
          main.webContents.send('app-advisor:tool-request', {
            kind: 'dispatch_action',
            requestId,
            originWorktreeId: 'demo-main',
            action: { type: 'panel.add_tab', kind: 'usage', variant: 'cursor' },
          });
        });
      }, requestId);
    await setCursorRollout(electronApp, window, false);
    const denied = await dispatch('cursor-usage-advisor-disabled');
    expect(denied.ok).toBe(false);
    await expect(window.getByTestId('panel-content-usage')).toHaveCount(0);
    await setCursorRollout(electronApp, window, true);
    const allowed = await dispatch('cursor-usage-advisor-enabled');
    expect(allowed).toMatchObject({ ok: true });
    await expect(window.getByTestId('panel-content-usage')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// authed-near-limit (from the SCENARIO_LIBRARY in authUsage.mjs):
//   Claude five_hour utilization 92 / seven_day 78, extra_usage enabled.
//   Codex primary usedPercent 88 (5-hour window), secondary 70 (7-day window),
//   credits balance 12.5. All resets are future (`+2h` / `+5d`).
const NEAR_LIMIT_CODEX_PRIMARY_USED = '88%';
const NEAR_LIMIT_CODEX_SECONDARY_USED = '70%';
// Codex counts its balance in credits, not dollars.
const NEAR_LIMIT_CODEX_CREDITS = '12.5';
const NEAR_LIMIT_CLAUDE_FIVE_HOUR_USED = '92%';

// authed-low-usage:
//   Codex primary usedPercent 10, secondary 6, credits balance 25.0.
const LOW_USAGE_CODEX_PRIMARY_USED = '10%';
const LOW_USAGE_CODEX_CREDITS = '25';

/**
 * Resolve a provider's usage group (`codex` / `claude`). `ProviderUsageCards.tsx`
 * renders one `<section data-testid="usage-provider-card-<provider>">` per
 * provider, headed by its name and plan.
 */
function providerCard(window, provider) {
  return window.getByTestId(`usage-provider-card-${provider}`);
}

/** The Usage page's one refresh control, in its heading. */
function pageRefreshButton(window) {
  return window.getByTestId('page-usage').getByTestId('usage-refresh');
}

test.describe('provider usage cards (auth/usage mock surface)', () => {
  test('Codex usage card renders the seeded near-limit values', async ({}, testInfo) => {
    test.setTimeout(120_000);

    // Register BEFORE launch so startup + on-demand refresh both see it.
    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: { scenario: 'authed-near-limit' },
    });

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await app.openUsagePage();

      const codexCard = providerCard(window, 'codex');
      await expect(codexCard).toBeVisible({ timeout: 30_000 });

      // Trigger an explicit on-demand refresh. The Usage page has one refresh
      // control (`Refresh usage`, in its heading) that reads every provider.
      const refreshUsage = pageRefreshButton(window);
      await expect(refreshUsage).toBeVisible();
      await refreshUsage.click();

      // The seeded high-usage values land asynchronously (IPC refresh round-trip
      // to the mock). Poll the rendered card text until the seeded primary window
      // usage percentage appears.
      await expect
        .poll(async () => (await codexCard.innerText()).replace(/\s+/g, ' '), {
          timeout: 30_000,
        })
        .toContain(NEAR_LIMIT_CODEX_PRIMARY_USED);

      // Secondary window + remaining credits also reflect the scenario.
      const codexText = (await codexCard.innerText()).replace(/\s+/g, ' ');
      expect(codexText).toContain(NEAR_LIMIT_CODEX_SECONDARY_USED);
      expect(codexText).toContain(`${NEAR_LIMIT_CODEX_CREDITS} credits left`);
      // The usage snapshot still carries the seeded chatgpt/plus subscription.
      // The raw `plus` plan token is run through the shared subscription-plan
      // catalog (normalizePlanKey + labelForPlanKey), so the card renders the
      // friendly full tier label "ChatGPT Plus" (codex:plus) instead of the bare
      // token, shown beside the provider name in the group heading. This label
      // comes from the mocked usage refresh, not live auth.
      // The account-control row itself is driven by live Codex auth state, so it
      // can differ between local signed-in runs and isolated CI data dirs — do
      // not assert the seeded account email here.
      expect(codexText).toContain('ChatGPT Plus');

      // A future reset time is rendered (resets_at `+2h` resolved to an absolute,
      // future ISO and phrased in words → "Resets today at …").
      expect(codexText).toContain('Resets ');

      // ── Claude card: authenticated live probe ────────────────────────────
      const claudeCard = providerCard(window, 'claude');
      const claudeAccount = claudeCard.getByTestId(
        'usage-provider-claude-account',
      );
      await expect(claudeCard).toBeVisible();
      await expect(claudeAccount).toContainText('tester@example.com', {
        timeout: 20_000,
      });

      const changeClaudeAccount = window.getByTestId(
        'usage-provider-claude-connect',
      );
      await expect(changeClaudeAccount).toHaveText('Change account');
      await expect(claudeCard).toContainText(NEAR_LIMIT_CLAUDE_FIVE_HOUR_USED);

      // Delay an authenticated re-probe long enough to assert the loading
      // branch. While that fresher probe is in flight, the card must retain the
      // authenticated usage snapshot rather than disabling the control or
      // flashing a signed-out state.
      await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
        authUsage: {
          claude: {
            auth: {
              loggedIn: true,
              email: 'tester@example.com',
              authMethod: 'oauth',
              subscriptionType: 'max',
              responseDelayMs: 5_000,
            },
            usage: {
              five_hour: { utilization: 92, resets_at: '+2h' },
              seven_day: { utilization: 78, resets_at: '+5d' },
            },
          },
        },
      });
      await changeClaudeAccount.click();

      const loginModal = window.getByTestId('auth-login-modal');
      await expect(loginModal).toBeVisible();
      await expect(window.getByTestId('auth-login-terminal')).toBeVisible();
      await window
        .getByRole('dialog', { name: 'Sign in to Claude' })
        .getByRole('button', { name: 'Close' })
        .click();
      await expect(loginModal).toBeHidden();

      await expect(claudeAccount).toContainText('tester@example.com');
      await expect(changeClaudeAccount).toBeEnabled();
      await expect(changeClaudeAccount).toHaveText('Change account');

      // Wait for the delayed authenticated probe to settle before changing
      // the scenario, then force a fresh signed-out probe through the same
      // close-and-refresh UI path.
      await window.evaluate(() =>
        window.api.getClaudeAuthStatus({ forceRefresh: true }),
      );
      await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
        authUsage: { scenario: 'unauthenticated' },
      });
      await changeClaudeAccount.click();
      await expect(loginModal).toBeVisible();
      await window
        .getByRole('dialog', { name: 'Sign in to Claude' })
        .getByRole('button', { name: 'Close' })
        .click();

      // The fresh negative must override the older authenticated snapshot and
      // expose the signed-out action.
      await expect(claudeAccount).toContainText('Sign in to see usage', {
        timeout: 15_000,
      });
      await expect(changeClaudeAccount).toHaveText('Sign in');

      await window.screenshot({
        path: testInfo.outputPath('provider-usage-near-limit.png'),
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
        () => undefined,
      );
    }
  });

  test('Codex usage card reflects the seeded low-usage scenario', async ({}, testInfo) => {
    test.setTimeout(120_000);

    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
      authUsage: { scenario: 'authed-low-usage' },
    });

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await app.openUsagePage();

      const codexCard = providerCard(window, 'codex');
      await expect(codexCard).toBeVisible({ timeout: 30_000 });

      await pageRefreshButton(window).click();

      // The low-usage primary percentage confirms the card reflects the
      // scenario (and is distinct from the near-limit case above).
      await expect
        .poll(async () => (await codexCard.innerText()).replace(/\s+/g, ' '), {
          timeout: 30_000,
        })
        .toContain(LOW_USAGE_CODEX_PRIMARY_USED);

      const codexText = (await codexCard.innerText()).replace(/\s+/g, ' ');
      expect(codexText).toContain(`${LOW_USAGE_CODEX_CREDITS} credits left`);
      // The near-limit primary value must NOT be present under low-usage.
      expect(codexText).not.toContain(NEAR_LIMIT_CODEX_PRIMARY_USED);

      await window.screenshot({
        path: testInfo.outputPath('provider-usage-low-usage.png'),
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
        () => undefined,
      );
    }
  });
});

test('Claude Extra usage shows monthly spend and cap in currency units', async () => {
  test.setTimeout(120_000);
  const key = 'can-4272-extra-usage';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    authUsage: {
      claude: {
        auth: {
          loggedIn: true,
          email: 'tester@example.com',
          authMethod: 'oauth',
          subscriptionType: 'max',
        },
        usage: {
          five_hour: { utilization: 0, resets_at: '+2h' },
          seven_day: { utilization: 0, resets_at: '+5d' },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 5000,
            used_credits: 6100,
            utilization: 122,
            currency: 'USD',
            decimal_places: 2,
          },
        },
      },
    },
  });
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_MOCK_API_KEY: key },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openUsagePage();
    const card = window.getByTestId('usage-provider-card-claude');
    await expect(card).toContainText('Extra usage');
    await expect(card).toContainText('Monthly spend: $61.00');
    await expect(card).toContainText('Monthly spending cap: $50.00');
    await expect(card).not.toContainText('Remaining credits');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
