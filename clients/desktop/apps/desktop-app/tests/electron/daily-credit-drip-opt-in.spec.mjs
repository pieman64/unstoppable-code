import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

// Daily free AI-credit drip opt-in (CAN-3761, PR #4691).
//
// The drip is off until the user answers. These specs walk the three desktop
// surfaces that answer it: the Home "Getting started" card (first in the
// queue for an undecided account), the Settings → Accounts toggle, and the
// `needs-credits` model recovery modal's "Turn on free daily AI Credits" action.
//
// Deterministic: no live agents and no network. Every cloud read goes to the
// shared mock server (`mock-server/routes/cloud.mjs`), keyed by the connected
// `csk_` credential. A `cloud.dailyCreditDrip` scenario override selects the
// undecided / opted-out / `grantFails` state; a PUT on a registered scenario
// persists the answer, records a `dailyCreditDripEnable` or
// `dailyCreditDripDisable` activity counter (the evidence of which body the
// desktop sent), and, unless `grantFails`, credits the balance to the cap.

const CAP_CREDITS = 25;
const DECIDED_AT = '2026-01-01T00:00:00.000Z';

// The Settings drip panel exists only without hosted account settings
// (CAN-4421: with them, the shared Billing / AI Credits page replaces it), so
// this spec runs with that rollout flag off. The Home card is unaffected.
const CLOUD_ENV = {
  CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-hosted-settings': false,
  }),
};

/** An empty, unsubscribed wallet that has not opted in to the drip. */
function zeroBalanceScenario(dailyCreditDrip) {
  return {
    cloud: {
      dailyCreditDrip: { capCredits: CAP_CREDITS, ...dailyCreditDrip },
      aiCreditsSubscription: { active: false, source: 'canopy' },
      aiCreditsBalance: {
        credits: 0,
        eligible: false,
        dailyDripEnabled: false,
        dailyDripCapCredits: CAP_CREDITS,
        orgPool: null,
        source: 'canopy',
      },
    },
  };
}

async function dripActivity(key) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key);
  return {
    enable: activity.dailyCreditDripEnable ?? 0,
    disable: activity.dailyCreditDripDisable ?? 0,
  };
}

/**
 * Launch on Home with every curated welcome entry resolved except
 * `pendingEntries`, then connect `key`. The daily-credits entry has no
 * persisted state in the seed, so the cloud answer alone decides whether it
 * shows.
 */
async function launchHome({ key, pendingEntries = [], env = {} }) {
  const userDataDir = seedWelcomeChecklist({ pendingEntries });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...CLOUD_ENV, ...env },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  // Connecting dispatches the account-changed event, which re-reads the
  // drip preference for the Home card and Settings section.
  await connectMockCloudAccount(window, key);
  return { electronApp, userDataDir, window, app };
}

async function openHome(window) {
  await window.getByTestId('sidebar-create-task').click();
  await expect(window.getByTestId('page-home')).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    window.getByTestId('home-composer-editor').locator('visible=true'),
  ).toBeVisible({
    timeout: 15_000,
  });
}

async function openAccountSettings(app) {
  await app.openSettings();
  await app.openSettingsSection('account');
  await expect(
    app.window.getByTestId('settings-daily-credit-drip'),
  ).toBeVisible({ timeout: 15_000 });
  return app.window.getByTestId('settings-daily-credit-drip-toggle');
}

async function cleanup(launch, key) {
  try {
    if (launch) await closeCanopy(launch.electronApp, launch.userDataDir);
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, key).catch(() => undefined);
  }
}

test.describe('daily free AI Credits opt-in', () => {
  test('the Settings toggle round-trips off, on, and off', async () => {
    test.setTimeout(120_000);
    const key = 'csk_daily_drip_settings_toggle_e2e';
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      key,
      zeroBalanceScenario({ enabled: false, decidedAt: DECIDED_AT }),
    );
    let launch;
    try {
      launch = await launchHome({ key, pendingEntries: ['focus-shortcut'] });
      const { window, app } = launch;

      // Already decided (off), so Home never asks.
      await openHome(window);
      await expect(
        window.getByTestId('home-composer-editor').locator('visible=true'),
      ).toBeVisible();
      await expect(
        window.getByTestId('home-onboarding-suggestion-daily-credits'),
      ).toHaveCount(0);

      const toggle = await openAccountSettings(app);
      const section = window.getByTestId('settings-daily-credit-drip');
      await expect(section).toContainText(
        `Get ${CAP_CREDITS} free AI Credits every day.`,
      );
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect
        .poll(() => dripActivity(key), { timeout: 20_000 })
        .toEqual({ enable: 1, disable: 0 });
      await expect(toggle).toBeEnabled();

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect
        .poll(() => dripActivity(key), { timeout: 20_000 })
        .toEqual({ enable: 1, disable: 1 });
      await expect(toggle).toBeEnabled();
      await expect(
        window.getByTestId('settings-daily-credit-drip-error'),
      ).toHaveCount(0);

      // The server holds the last answer.
      await expect
        .poll(() =>
          window.evaluate(
            async () =>
              (await window.api.loadCloudDailyCreditDrip()).preference.enabled,
          ),
        )
        .toBe(false);
    } finally {
      await cleanup(launch, key);
    }
  });

  test('an account that already answered sees no daily credits card', async () => {
    test.setTimeout(120_000);
    // Deliberately unregistered: the mock default is a decided, opted-in user.
    const key = 'csk_daily_drip_already_decided_e2e';
    let launch;
    try {
      launch = await launchHome({ key, pendingEntries: ['focus-shortcut'] });
      const { window, app } = launch;
      await openHome(window);
      await openAccountSettings(app);

      // Prove the preference was actually read before asserting absence.
      await expect
        .poll(
          async () =>
            (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity
              .dailyCreditDripRead ?? 0,
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
      const state = await window.evaluate(() =>
        window.api.loadCloudDailyCreditDrip(),
      );
      expect(state).toMatchObject({
        available: true,
        resolved: true,
        preference: { enabled: true, decidedAt: DECIDED_AT },
      });

      await app.closeSettings();
      await expect(
        window.getByTestId('home-composer-editor').locator('visible=true'),
      ).toBeVisible();
      await expect(
        window.getByTestId('home-onboarding-suggestion-daily-credits'),
      ).toHaveCount(0);
    } finally {
      await cleanup(launch, key);
    }
  });
});

// ---- `needs-credits` model recovery --------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const MODEL_REGISTRY_UPDATED_CHANNEL = 'model-registry:updated';
const GATEWAY_MODEL_ID = 'deepseek-v4.1-flash';
const GATEWAY_MODEL_LABEL = 'DeepSeek V4.1 Flash';

const gatewayConfig = {
  contextWindow: 128_000,
  supportsPromptCaching: false,
  supportedThinkingLevels: ['low', 'medium', 'high'],
  toolSchemaProfile: 'standard',
};

/**
 * Publish a registry with one gateway-only model, which can only ever be paid
 * for with AI Credits. With an empty wallet its row recovers through
 * `needs-credits`. Same snapshot shape as model-picker-gateway-catalog.spec.
 */
async function injectGatewayOnlyModel(electronApp) {
  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, snapshot }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error('No BrowserWindow available for model registry update');
      }
      window.webContents.send(channel, snapshot);
    },
    {
      channel: MODEL_REGISTRY_UPDATED_CHANNEL,
      snapshot: {
        claude: [],
        codex: [
          {
            id: 'gpt-5.6-luna',
            label: 'GPT-5.6 Luna',
            family: 'gpt-5.6',
            familyLabel: 'GPT 5.6',
            vendor: 'openai',
            sortOrder: 70,
          },
        ],
        ollama: [],
        agents: [],
        aliases: {},
        aiGatewayModels: [
          {
            id: GATEWAY_MODEL_ID,
            label: GATEWAY_MODEL_LABEL,
            family: 'deepseek',
            familyLabel: 'DeepSeek',
            vendor: 'deepseek',
            recommendedHarness: 'codex',
            ...gatewayConfig,
          },
        ],
        gatewayRoutes: [
          {
            modelId: GATEWAY_MODEL_ID,
            gatewayId: `deepseek/${GATEWAY_MODEL_ID}`,
            family: 'deepseek',
            recommendedHarness: 'codex',
            gatewayOnly: true,
            ...gatewayConfig,
          },
        ],
      },
    },
  );
}

async function launchRecoveryChat({ key, chatId }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-daily-drip-recovery-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      { id: chatId, title: 'Daily credits recovery', model: 'gpt-5.6-luna' },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir, env: CLOUD_ENV });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, key);
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);

  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await expect(picker).toContainText('Luna', { timeout: 30_000 });
  await injectGatewayOnlyModel(electronApp);
  return { electronApp, userDataDir, window, picker };
}

/** Pick the gateway-only model and land on the opted-out credits branch. */
async function openNeedsCreditsRecovery(window, picker) {
  await picker.click();
  const row = window.getByTestId(`chat-model-option-${GATEWAY_MODEL_ID}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  await row.click();

  const modal = window.getByTestId('model-recovery-modal');
  await expect(modal).toBeVisible();
  // CAN-5214 — the amount, recurrence and terms show before opting in.
  await expect(
    window.getByTestId('model-recovery-daily-credits-offer'),
  ).toHaveText(`Get ${CAP_CREDITS} free every day, no card needed.`, {
    timeout: 30_000,
  });
  await expect(modal.locator('h2')).toContainText('Choose how to use');
  await expect(
    window.getByTestId('model-recovery-daily-credits-body'),
  ).toHaveText("You're out of AI Credits.");
  const turnOn = window.getByTestId('model-recovery-turn-on-daily-credits');
  await expect(turnOn).toHaveText('Turn on free daily AI Credits');
  await expect(turnOn).toBeEnabled();
  await expect(window.getByTestId('model-recovery-get-credits')).toHaveText(
    'Get AI Credits',
  );
  // The X is the only dismiss, and every action label renders the same way.
  await expect(window.getByTestId('model-recovery-cancel')).toHaveCount(0);
  const labelStyles = await modal
    .locator('button[data-testid^="model-recovery-"]')
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const style = getComputedStyle(button);
        return `${style.fontSize}/${style.fontWeight}`;
      }),
    );
  expect(labelStyles.length).toBeGreaterThan(1);
  expect(new Set(labelStyles).size).toBe(1);
  return { modal, turnOn };
}

test.describe('needs-credits recovery offers the daily drip', () => {
  test('turning on free daily AI Credits clears the needs-credits step', async () => {
    test.setTimeout(150_000);
    const key = 'csk_daily_drip_recovery_commit_e2e';
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      key,
      zeroBalanceScenario({ enabled: false, decidedAt: DECIDED_AT }),
    );
    let launch;
    try {
      launch = await launchRecoveryChat({
        key,
        chatId: 'daily-drip-recovery-commit',
      });
      const { window, picker } = launch;
      const { turnOn } = await openNeedsCreditsRecovery(window, picker);
      // Reading the terms saves nothing.
      expect(await dripActivity(key)).toEqual({ enable: 0, disable: 0 });

      await turnOn.click();
      await expect
        .poll(() => dripActivity(key), { timeout: 20_000 })
        .toEqual({ enable: 1, disable: 0 });

      // The grant covers the model, so the recovery leaves the needs-credits
      // step: no second Turn on, and not the stay-open "start tomorrow" path.
      // The E2E harness cannot switch a seeded chat onto an injected
      // gateway-only model even with a funded wallet, so the final commit is
      // covered by the ModelRecoveryModal unit test instead.
      await expect(
        window.getByTestId('model-recovery-daily-credits'),
      ).toHaveCount(0, { timeout: 30_000 });
      await expect(
        window.getByTestId('model-recovery-turn-on-daily-credits'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('model-recovery-daily-credits-saved'),
      ).toHaveCount(0);
      expect(await dripActivity(key)).toEqual({ enable: 1, disable: 0 });
    } finally {
      await cleanup(launch, key);
    }
  });

  test('a saved choice without a grant keeps the modal open with no second Turn on', async () => {
    test.setTimeout(150_000);
    const key = 'csk_daily_drip_recovery_grant_fails_e2e';
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      key,
      zeroBalanceScenario({
        enabled: false,
        decidedAt: DECIDED_AT,
        grantFails: true,
      }),
    );
    let launch;
    try {
      launch = await launchRecoveryChat({
        key,
        chatId: 'daily-drip-recovery-grant-fails',
      });
      const { window, picker } = launch;
      const { modal, turnOn } = await openNeedsCreditsRecovery(window, picker);

      await turnOn.click();
      await expect(
        window.getByTestId('model-recovery-daily-credits-saved'),
      ).toContainText('Your free daily AI Credits start tomorrow.', {
        timeout: 30_000,
      });
      await expect(modal).toBeVisible();
      await expect(
        window.getByTestId('model-recovery-turn-on-daily-credits'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('model-recovery-daily-credits-error'),
      ).toHaveCount(0);
      expect(await dripActivity(key)).toEqual({ enable: 1, disable: 0 });

      // Nothing was committed: the chat keeps its model.
      await window
        .getByTestId('model-recovery-modal')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await expect(modal).toHaveCount(0);
      await expect(picker).toContainText('Luna');
      await expect(picker).not.toContainText(GATEWAY_MODEL_LABEL);
    } finally {
      await cleanup(launch, key);
    }
  });
});
