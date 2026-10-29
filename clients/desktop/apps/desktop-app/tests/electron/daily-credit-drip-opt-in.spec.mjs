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
// `needs-credits` model recovery modal's "Turn on free daily credits" action.
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
  await expect(window.getByTestId('home-onboarding-suggestions')).toBeVisible({
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
  test('an undecided account sees the daily credits card first in Getting started', async () => {
    test.setTimeout(120_000);
    const key = 'csk_daily_drip_first_in_queue_e2e';
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      key,
      zeroBalanceScenario({ enabled: false, decidedAt: null }),
    );
    let launch;
    try {
      launch = await launchHome({
        key,
        pendingEntries: ['focus-shortcut'],
      });
      const { window } = launch;
      await openHome(window);

      const card = window.getByTestId(
        'home-onboarding-suggestion-daily-credits',
      );
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toHaveAttribute('data-step', 'enable-daily-credits');
      await expect(card).toHaveAttribute('data-status', 'pending');
      await expect(card).toContainText('Free AI Credits, every single day');
      await expect(card).toContainText(
        `Claim ${CAP_CREDITS} free AI Credits daily. Use them with any model, on top of your own plan.`,
      );
      await expect(
        window.getByTestId('home-onboarding-daily-credits-turn-on'),
      ).toHaveText('Claim');
      await expect(
        window.getByTestId('home-onboarding-daily-credits-turn-on'),
      ).toBeEnabled();
      await expect(
        window.getByTestId('home-onboarding-daily-credits-not-now'),
      ).toBeEnabled();

      // Getting started shows one entry at a time; the opt-in leads the
      // queue, ahead of the other pending entry (`focus-shortcut`). The counter
      // reads "done + 1" (#4697), so leading the queue leaves exactly that one
      // step after the live one. A new counted onboarding step left pending by
      // the seed changes this count.
      const progress = window.getByTestId('home-onboarding-checklist-progress');
      await expect
        .poll(async () => {
          const match = /^(\d+)\/(\d+)$/.exec(await progress.innerText());
          return match ? Number(match[2]) - Number(match[1]) : null;
        })
        .toBe(1);

      // Showing the card answers nothing.
      expect(await dripActivity(key)).toEqual({ enable: 0, disable: 0 });
    } finally {
      await cleanup(launch, key);
    }
  });

  test('Claim saves enabled, removes the card, and credits the balance', async () => {
    test.setTimeout(150_000);
    const key = 'csk_daily_drip_turn_on_e2e';
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      key,
      zeroBalanceScenario({ enabled: false, decidedAt: null }),
    );
    let launch;
    try {
      launch = await launchHome({
        key,
        pendingEntries: ['focus-shortcut'],
      });
      const { window, app } = launch;

      // The empty wallet before the opt-in.
      await app.openUsagePage();
      await expect(
        window.getByTestId('usage-card-ai-credits-balance'),
      ).toHaveText('0 credits', { timeout: 30_000 });

      await openHome(window);
      const card = window.getByTestId(
        'home-onboarding-suggestion-daily-credits',
      );
      await expect(card).toBeVisible({ timeout: 30_000 });
      await window.getByTestId('home-onboarding-daily-credits-turn-on').click();

      await expect
        .poll(() => dripActivity(key), { timeout: 20_000 })
        .toEqual({ enable: 1, disable: 0 });
      await expect(card).toHaveCount(0);
      await expect(
        window.getByTestId('home-onboarding-daily-credits-error'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('home-onboarding-suggestion-focus-shortcut'),
      ).toBeVisible();

      // Settings reflects the saved answer.
      const toggle = await openAccountSettings(app);
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await app.closeSettings();

      // The grant reached the balance surfaces without a relaunch.
      await app.openUsagePage();
      await expect(
        window.getByTestId('usage-card-ai-credits-balance'),
      ).toHaveText(`${CAP_CREDITS} credits`, { timeout: 30_000 });
      expect(await dripActivity(key)).toEqual({ enable: 1, disable: 0 });
    } finally {
      await cleanup(launch, key);
    }
  });

  test('Not now saves disabled, removes the card, and leaves Settings off', async () => {
    test.setTimeout(120_000);
    const key = 'csk_daily_drip_not_now_e2e';
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      key,
      zeroBalanceScenario({ enabled: false, decidedAt: null }),
    );
    let launch;
    try {
      launch = await launchHome({ key, pendingEntries: ['focus-shortcut'] });
      const { window, app } = launch;
      await openHome(window);

      const card = window.getByTestId(
        'home-onboarding-suggestion-daily-credits',
      );
      await expect(card).toBeVisible({ timeout: 30_000 });
      await window.getByTestId('home-onboarding-daily-credits-not-now').click();

      await expect
        .poll(() => dripActivity(key), { timeout: 20_000 })
        .toEqual({ enable: 0, disable: 1 });
      await expect(card).toHaveCount(0);
      await expect(
        window.getByTestId('home-onboarding-suggestion-focus-shortcut'),
      ).toBeVisible();

      const toggle = await openAccountSettings(app);
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      // The answer is durable server-side: a fresh read reports decided.
      const state = await window.evaluate(() =>
        window.api.loadCloudDailyCreditDrip(),
      );
      expect(state).toMatchObject({
        available: true,
        resolved: true,
        preference: { enabled: false, capCredits: CAP_CREDITS },
      });
      expect(state.preference.decidedAt).not.toBeNull();
    } finally {
      await cleanup(launch, key);
    }
  });

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
        window.getByTestId('home-onboarding-suggestion-focus-shortcut'),
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
      const { window } = launch;
      await openHome(window);

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

      await expect(
        window.getByTestId('home-onboarding-suggestion-focus-shortcut'),
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
  await expect(
    window.getByTestId('model-recovery-daily-credits'),
  ).toContainText('Turn on free daily credits', { timeout: 30_000 });
  const turnOn = window.getByTestId('model-recovery-turn-on-daily-credits');
  await expect(turnOn).toBeVisible();
  await expect(turnOn).toBeEnabled();
  return { modal, turnOn };
}

test.describe('needs-credits recovery offers the daily drip', () => {
  test('turning on free daily credits clears the needs-credits step', async () => {
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
      ).toContainText('Your free daily credits start tomorrow.', {
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
      await window.getByTestId('model-recovery-cancel').click();
      await expect(modal).toHaveCount(0);
      await expect(picker).toContainText('Luna');
      await expect(picker).not.toContainText(GATEWAY_MODEL_LABEL);
    } finally {
      await cleanup(launch, key);
    }
  });
});
