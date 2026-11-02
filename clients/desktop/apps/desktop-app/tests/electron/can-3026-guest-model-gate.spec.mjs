import {
  revealModelRow,
  selectModelOption,
} from './model-selection-fixture.mjs';
import { textContrastRatio } from './text-contrast-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  expectGatewayRoutesInMain,
  gatewayCatalogEntry,
  seedGatewayCatalogCache,
} from './gateway-catalog-fixture.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

// CAN-3026 — durable Electron coverage for the desktop guest model gate.
//
// A guest may only run the cheap allowlisted models (`GUEST_ALLOWED_MODELS`)
// where Canopy pays for the inference. Picking anything else raises the shared
// sign-in prompt instead of committing the model.
//
// Fully deterministic: the gateway-only models are seeded into MAIN's AI
// Gateway catalog cache before launch (`gateway-catalog-fixture.mjs`), so main
// and the renderer share one registry; the native rows are main's real
// registry. The chat is seeded on disk, and the guest credential comes from
// the shared cloud mock's device-scoped guest-mint route. No live agent, no
// provider CLI, no network turn.
//
// Never send `model-registry:updated` to the renderer directly: a model main
// has not heard of is refused when it is applied (CAN-5022).
//
// The gated rows below are GATEWAY-ONLY on purpose. That branch of
// `resolveModelRowGate` refuses a guest BEFORE the credits probe runs, so the
// assertion does not depend on whatever balance the mock hands this guest —
// which is also the production property that matters, since every consented
// guest is funded by the daily drip.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'can-3026-guest-model-gate-chat';

const CURRENT_MODEL = 'sonnet';
const CURRENT_MODEL_LABEL = 'Sonnet 5.5';
/** Expensive, gateway-only, NOT on the guest allowlist. */
const BLOCKED_MODEL = 'claude-zulu-gateway-only';
/** The shipped desktop AI-Credits lane default — first in the allowlist. */
const ALLOWED_DEFAULT_MODEL = 'deepseek-v4-pro';
/** The guest model on web and desktop, and cloud chat's own default. */
const ALLOWED_NATIVE_MODEL = 'gpt-6-luna';
/**
 * The allowlisted Claude model. Allowlisted by its GATEWAY id only: the
 * registry id `haiku` is not on the allowlist, so the row is admitted through
 * its resolved route.
 */
const ALLOWED_CLAUDE_MODEL = 'haiku';
/**
 * An expensive Claude model with NO gateway route — the guest's own
 * subscription lane. Canopy pays nothing for it, so the gate must not touch it
 * even though it is not on the allowlist. The launch seeds the catalog
 * without `anthropic/claude-opus-5.5`, which strips the route from this id and
 * from any sibling id that shares that gateway id.
 *
 * The brackets break CSS attribute selectors: locate its rows with exact
 * `getByTestId` matches only.
 */
const NATIVE_SUBSCRIPTION_MODEL = 'opus[1m]';
const NATIVE_SUBSCRIPTION_GATEWAY_ID = 'anthropic/claude-opus-5.5';
const BLOCKED_MODEL_LABEL = 'Zulu Gateway';
/** CAN-4703 — the allowlist label of the Claude guest model. */
const ALLOWED_CLAUDE_FALLBACK_LABEL = 'Claude Haiku 5.5';
const ALLOWED_CLAUDE_PICKER_LABEL = 'Haiku 5.5';

const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

/**
 * Gateway-only rows for main's catalog. GPT 6 Luna and Haiku need no entries:
 * the mock's default catalog already routes those native models through
 * credits (`gatewayOnly: false`).
 */
function guestGateCatalog(blockedGatewayId = 'anthropic/zulu-gateway') {
  return {
    add: [
      gatewayCatalogEntry({
        id: BLOCKED_MODEL,
        gatewayId: blockedGatewayId,
        label: BLOCKED_MODEL_LABEL,
        family: 'anthropic',
        familyLabel: 'Anthropic',
        recommendedHarness: 'claude',
      }),
      gatewayCatalogEntry({
        id: ALLOWED_DEFAULT_MODEL,
        gatewayId: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        family: 'deepseek',
        familyLabel: 'DeepSeek',
        recommendedHarness: 'codex',
      }),
    ],
    withoutGatewayIds: [NATIVE_SUBSCRIPTION_GATEWAY_ID],
  };
}

async function expectGuestGateRoutesInMain(
  window,
  blockedGatewayId = 'anthropic/zulu-gateway',
) {
  await expectGatewayRoutesInMain(window, [
    { modelId: BLOCKED_MODEL, gatewayId: blockedGatewayId, gatewayOnly: true },
    {
      modelId: ALLOWED_DEFAULT_MODEL,
      gatewayId: 'deepseek/deepseek-v4-pro',
      gatewayOnly: true,
    },
    // Luna is a NATIVE Codex model that still routes through credits for a
    // guest with no Codex login — the exact case gating gateway-only rows
    // alone would miss.
    {
      modelId: ALLOWED_NATIVE_MODEL,
      gatewayId: 'openai/gpt-6-luna',
      gatewayOnly: false,
    },
    // The first guest model on the Claude harness: a native Claude row that
    // routes through credits under the allowlisted gateway id.
    {
      modelId: ALLOWED_CLAUDE_MODEL,
      gatewayId: 'anthropic/claude-haiku-5.5',
      gatewayOnly: false,
    },
  ]);
}

async function launchGuestChat(
  prefix,
  {
    model = CURRENT_MODEL,
    blockedGatewayId,
    clientDeviceId,
    env,
    preserveNativeGatewayRoutes = false,
    actualOpus = false,
    observeDrip = false,
  } = {},
) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  if (clientDeviceId !== undefined) {
    // Lets the mock's guest mint hand this launch its own guest credential.
    writeFileSync(
      path.join(userDataDir, 'portal-state.json'),
      `${JSON.stringify({ version: 1, clientDeviceId })}\n`,
      'utf8',
    );
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Guest model gate', model }],
  });
  seedGatewayCatalogCache(userDataDir, {
    ...guestGateCatalog(blockedGatewayId),
    ...(preserveNativeGatewayRoutes || actualOpus
      ? { withoutGatewayIds: [] }
      : {}),
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    ...(env === undefined ? {} : { env }),
  });
  const window = await electronApp.firstWindow();
  if (observeDrip) {
    // Count the outgoing operation, including a rejected PUT, independently
    // from the mock's successful activity. Intercept only that operation.
    await electronApp.evaluate(({ ipcMain }) => {
      const originalFetch = globalThis.fetch;
      globalThis.can5211DripRequests = [];
      globalThis.can5211RejectEnable = false;
      globalThis.fetch = async (url, init) => {
        if (
          String(url).endsWith('/api/v1/ai-credits/daily-drip') &&
          init?.method === 'PUT'
        ) {
          const body = JSON.parse(init.body);
          globalThis.can5211DripRequests.push(body);
          if (globalThis.can5211RejectEnable)
            return new Response(JSON.stringify({ error: 'Rejected enable' }), {
              status: 500,
            });
        }
        return originalFetch(url, init);
      };
      const originals = new Map();
      for (const channel of [
        'settings:claude-auth-status',
        'settings:codex-auth-status',
      ]) {
        originals.set(channel, ipcMain._invokeHandlers.get(channel));
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => ({
          authenticated: false,
          accountLabel: null,
          detail: null,
          error: null,
        }));
      }
      globalThis.can5211Restore = () => {
        globalThis.fetch = originalFetch;
        for (const [channel, handler] of originals) {
          ipcMain.removeHandler(channel);
          if (handler) ipcMain.handle(channel, handler);
        }
      };
    });
    // Start the tested renderer after auth is stubbed, before its provider
    // availability cache consumes either provider's answer.
    await window.reload();
  }
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });

  // Device-scoped guest credential (`csk_guest_*`, saved as
  // `credentialSource: 'guest'`), then the broadcast `useIsGuestCredential`
  // listens on so the picker re-resolves its rows as a guest.
  const guestAccount = await window.evaluate(
    async (consent) => window.api.startCanopyGuestSession(consent),
    GUEST_CONSENT,
  );
  expect(guestAccount.credentialSource).toBe('guest');
  await window.evaluate(() => {
    window.dispatchEvent(new Event('canopy:cloud-account-changed'));
  });

  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expectGuestGateRoutesInMain(window, blockedGatewayId);
  return { electronApp, userDataDir, window };
}

/** Fresh guest/device per flow; a relative decline date never ages the fixture. */
async function launchDailyCreditsGate({
  home = false,
  grantFails = false,
  enabled = false,
  unavailable = false,
  pickHaiku = false,
  hostedSettings = false,
} = {}) {
  const clientDeviceId = randomUUID();
  const guestKey = `csk_guest_can5211_${randomUUID().replaceAll('-', '')}`;
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    `guest-device:${clientDeviceId}`,
    { guestToken: guestKey },
  );
  await registerScenario(DEFAULT_MOCK_BASE_URL, guestKey, {
    authUsage: { scenario: 'unauthenticated' },
    cloud: {
      dailyCreditDrip: {
        enabled,
        decidedAt: new Date(Date.now() - 60_000).toISOString(),
        capCredits: 10,
        grantFails,
        saveDelayMs: 150,
        ...(unavailable ? { httpStatus: 404 } : {}),
      },
      aiCreditsSubscription: { active: false, source: 'canopy' },
      aiCreditsBalance: {
        credits: 0,
        eligible: false,
        dailyDripEnabled: enabled,
        dailyDripCapCredits: 10,
        orgPool: null,
        source: 'canopy',
      },
      entitlements: {
        plan: { key: 'free', displayName: 'Free' },
        source: 'none',
        trial: null,
        capabilities: [],
        coveringOrgs: [],
        billingManageableOrg: null,
        modelLibrary: 'needs_sign_in_then_purchase',
        workModelLibrary: {
          owner: { kind: 'personal' },
          access: 'needs_sign_in_then_purchase',
        },
      },
    },
  });
  let fixture;
  try {
    fixture = await launchGuestChat('canopy-can5211-', {
      clientDeviceId,
      actualOpus: true,
      observeDrip: true,
      env: {
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-hosted-settings': hostedSettings,
        }),
      },
    });
    const { window } = fixture;
    expect(
      await window.evaluate(() =>
        Promise.all([
          window.api.getClaudeAuthStatus(),
          window.api.getCodexAuthStatus(),
        ]),
      ),
    ).toEqual([
      expect.objectContaining({ authenticated: false }),
      expect.objectContaining({ authenticated: false }),
    ]);
    const app = new CanopyAppDriver(window);
    const surface = home ? await app.openHomeForProject(WORKSPACE_ID) : window;
    const editor = surface
      .locator('[contenteditable="true"][data-slate-editor="true"]:visible')
      .first();
    const prompt = `CAN-5211 ${home ? 'Home' : 'chat'} exact sentinel; do not submit.`;
    await editor.fill(prompt);
    const picker = surface
      .getByTestId('chat-model-picker')
      .filter({ visible: true })
      .first();
    const originalModel = await picker.textContent();
    await picker.click();
    // The real Opus route is retained in MAIN, unlike the legacy Zulu fixture.
    // Home starts on Opus itself in this fixture. Use the supplementary
    // advanced gateway row there; chat covers the actual native Opus route.
    const targetModel = pickHaiku
      ? ALLOWED_CLAUDE_MODEL
      : home
        ? BLOCKED_MODEL
        : NATIVE_SUBSCRIPTION_MODEL;
    const row = await revealModelRow(window, targetModel);
    if (!pickHaiku) {
      await expect(
        row.getByTestId(`chat-model-option-lock-label-${targetModel}`),
      ).toHaveText('Sign in and buy');
    }
    await row.click();
    await expect(
      window.getByTestId(
        pickHaiku
          ? 'model-recovery-daily-credits'
          : 'model-recovery-needs-account',
      ),
    ).toBeVisible();
    return {
      ...fixture,
      picker,
      editor,
      prompt,
      originalModel,
      guestKey,
      clientDeviceId,
    };
  } catch (error) {
    if (fixture) await closeCanopy(fixture.electronApp, fixture.userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, guestKey);
    await clearScenario(
      DEFAULT_MOCK_BASE_URL,
      `guest-device:${clientDeviceId}`,
    );
    throw error;
  }
}

async function closeDailyCreditsGate(fixture) {
  try {
    await fixture.electronApp.evaluate(() => globalThis.can5211Restore());
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, fixture.guestKey);
    await clearScenario(
      DEFAULT_MOCK_BASE_URL,
      `guest-device:${fixture.clientDeviceId}`,
    );
  }
}

for (const hostedSettings of [false, true]) {
  test(`CAN-5214 guest Haiku terms and Settings disable (hosted: ${hostedSettings})`, async () => {
    const fixture = await launchDailyCreditsGate({
      pickHaiku: true,
      grantFails: true,
      hostedSettings,
    });
    try {
      const { window, electronApp, guestKey } = fixture;
      const offer = window.getByTestId('model-recovery-daily-credits-offer');
      await expect(offer).toHaveText(
        'Get 10 free every day, no card or account needed.',
      );
      await expect(
        window.getByTestId('model-recovery-modal').locator('h2'),
      ).toHaveText(`Choose how to use ${ALLOWED_CLAUDE_PICKER_LABEL}`);
      await expect(window.getByTestId('model-recovery-sign-in')).toHaveText(
        'Use my Claude subscription',
      );
      expect(
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, guestKey)).activity
          .dailyCreditDripEnable ?? 0,
      ).toBe(0);
      await window
        .getByTestId('model-recovery-modal')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      expect(
        await electronApp.evaluate(() => globalThis.can5211DripRequests),
      ).toEqual([]);

      await fixture.picker.click();
      await (await revealModelRow(window, ALLOWED_CLAUDE_MODEL)).click();
      await expect(offer).toBeVisible();
      await window.getByTestId('model-recovery-turn-on-daily-credits').click();
      await expect(
        window.getByTestId('model-recovery-daily-credits-saved'),
      ).toHaveText('Your free daily AI Credits start tomorrow.');
      await expect(window.getByTestId('model-recovery-sign-in')).toHaveText(
        'Use my Claude subscription',
      );
      await window
        .getByTestId('model-recovery-modal')
        .getByRole('button', { name: 'Close', exact: true })
        .click();

      const app = new CanopyAppDriver(window);
      await app.openSettings();
      await app.openSettingsSection('account');
      const toggle = window.getByRole('switch', {
        name: 'Free daily AI Credits',
        exact: true,
      });
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(toggle).toBeEnabled();
      expect(
        await electronApp.evaluate(() => globalThis.can5211DripRequests),
      ).toEqual([{ enabled: true }, { enabled: false }]);
      expect(
        (await window.evaluate(() => window.api.loadCloudDailyCreditDrip()))
          .preference.enabled,
      ).toBe(false);
    } finally {
      await closeDailyCreditsGate(fixture);
    }
  });
}

test('CAN-5214 guest Haiku recovery stays usable with unavailable preference', async () => {
  const fixture = await launchDailyCreditsGate({
    pickHaiku: true,
    unavailable: true,
  });
  try {
    const { window, electronApp } = fixture;
    await expect(
      window.getByTestId('model-recovery-daily-credits-offer'),
    ).toHaveText('Get free AI Credits every day, no card or account needed.');
    await expect(
      window.getByTestId('model-recovery-turn-on-daily-credits'),
    ).toBeEnabled();
    await window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    expect(
      await electronApp.evaluate(() => globalThis.can5211DripRequests),
    ).toEqual([]);
    await expect(fixture.editor).toHaveText(fixture.prompt);
  } finally {
    await closeDailyCreditsGate(fixture);
  }
});

test('CAN-5211 unavailable daily credits never advertises activation', async () => {
  const fixture = await launchDailyCreditsGate({ unavailable: true });
  try {
    await expect(
      fixture.window.getByTestId('model-recovery-guest-fallback'),
    ).toHaveCount(0);
    await expect(fixture.editor).toHaveText(fixture.prompt);
    await expect(fixture.picker).toHaveText(fixture.originalModel);
  } finally {
    await closeDailyCreditsGate(fixture);
  }
});

for (const home of [false, true]) {
  test(`CAN-5211 ${home ? 'Home keyboard' : 'chat pointer'} enables once and selects Haiku preserving the prompt`, async () => {
    const fixture = await launchDailyCreditsGate({ home });
    try {
      const { window } = fixture;
      const primary = window.getByTestId('model-recovery-account-sign-in');
      const fallback = window.getByTestId('model-recovery-guest-fallback');
      await expect(fallback).toHaveAttribute(
        'data-fallback-access',
        'daily-credits',
      );
      await expect(primary).toHaveText('Get AI Credits');
      await expect(primary).toBeFocused();
      await expect(fallback).toHaveText(
        'Use Claude Haiku 5.5 with free daily AI Credits',
      );
      const actions = await window
        .getByTestId('model-recovery-modal')
        .locator('button[data-testid^="model-recovery-"]')
        .evaluateAll((buttons) =>
          buttons.map((button) => button.dataset.testid),
        );
      expect(actions).toEqual([
        'model-recovery-account-sign-in',
        'model-recovery-guest-fallback',
        'model-recovery-cancel',
      ]);
      if (home) {
        await window.keyboard.press('Tab');
        await expect(fallback).toBeFocused();
        await window.keyboard.press('Enter');
      } else {
        await fallback.dblclick();
      }
      await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
      await expect(fixture.picker).toContainText(ALLOWED_CLAUDE_PICKER_LABEL);
      await expect(fixture.editor).toHaveText(fixture.prompt);
      await expectComposerFocused(window, home ? 'home-composer-editor' : null);
      expect(
        await fixture.electronApp.evaluate(
          () => globalThis.can5211DripRequests,
        ),
      ).toEqual([{ enabled: true }]);
      const { activity } = await getScenarioActivity(
        DEFAULT_MOCK_BASE_URL,
        fixture.guestKey,
      );
      expect(activity.dailyCreditDripEnable).toBe(1);
      expect(activity.dailyCreditDripDisable ?? 0).toBe(0);
      await expect(window.getByTestId('cloud-sync-modal')).toHaveCount(0);
      await expect(window.getByTestId('user-message-content')).toHaveCount(0);
    } finally {
      await closeDailyCreditsGate(fixture);
    }
  });
}

test('CAN-5211 rejected enable is retryable and counts the rejected outgoing PUT', async () => {
  const fixture = await launchDailyCreditsGate();
  try {
    await fixture.electronApp.evaluate(() => {
      globalThis.can5211RejectEnable = true;
    });
    await fixture.window.getByTestId('model-recovery-guest-fallback').click();
    await expect(
      fixture.window.getByTestId('model-recovery-fallback-blocked'),
    ).toHaveText("Couldn't turn on free daily AI Credits. Try again.");
    await expect(fixture.editor).toHaveText(fixture.prompt);
    await expect(fixture.picker).toHaveText(fixture.originalModel);
    expect(
      await fixture.electronApp.evaluate(() => globalThis.can5211DripRequests),
    ).toEqual([{ enabled: true }]);
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      fixture.guestKey,
    );
    expect(activity.dailyCreditDripEnable ?? 0).toBe(0);
    await fixture.electronApp.evaluate(() => {
      globalThis.can5211RejectEnable = false;
    });
    await fixture.window.getByTestId('model-recovery-guest-fallback').click();
    await expect(fixture.picker).toContainText(ALLOWED_CLAUDE_PICKER_LABEL);
    expect(
      await fixture.electronApp.evaluate(() => globalThis.can5211DripRequests),
    ).toEqual([{ enabled: true }, { enabled: true }]);
  } finally {
    await closeDailyCreditsGate(fixture);
  }
});

test('CAN-5211 saved without a grant keeps the original model and prompt with honest status', async () => {
  const fixture = await launchDailyCreditsGate({ grantFails: true });
  try {
    await fixture.window.getByTestId('model-recovery-guest-fallback').click();
    const status = fixture.window.getByTestId('model-recovery-fallback-status');
    await expect(status).toHaveText(
      'Free daily AI Credits are on, but no credits are available right now.',
    );
    await expect(status).toHaveAttribute('role', 'status');
    await expect(
      fixture.window.getByTestId('model-recovery-guest-fallback'),
    ).toHaveCount(0);
    await expect(
      fixture.window.getByTestId('model-recovery-guest-fallback-recheck'),
    ).toHaveCount(0);
    await expect(fixture.editor).toHaveText(fixture.prompt);
    await expect(fixture.picker).toHaveText(fixture.originalModel);
    expect(
      await fixture.electronApp.evaluate(() => globalThis.can5211DripRequests),
    ).toEqual([{ enabled: true }]);
  } finally {
    await closeDailyCreditsGate(fixture);
  }
});

test('CAN-5211 enabled but spent daily credits do not offer another enable', async () => {
  const fixture = await launchDailyCreditsGate({ enabled: true });
  try {
    await expect(
      fixture.window.getByTestId('model-recovery-guest-fallback'),
    ).toHaveCount(0);
    expect(
      await fixture.electronApp.evaluate(() => globalThis.can5211DripRequests),
    ).toEqual([]);
    await expect(fixture.editor).toHaveText(fixture.prompt);
  } finally {
    await closeDailyCreditsGate(fixture);
  }
});

async function openPicker(window, label = CURRENT_MODEL_LABEL) {
  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await expect(picker).toContainText(label);
  await picker.click();
  return picker;
}

/** The caret is in a composer's editable input, not merely off `<body>`. */
async function expectComposerFocused(window, editorTestId) {
  await expect
    .poll(() =>
      window.evaluate((testId) => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !active.isContentEditable)
          return false;
        if (active.closest('[data-testid="model-recovery-modal"]'))
          return false;
        return (
          testId === null ||
          active.closest(`[data-testid="${testId}"]`) !== null ||
          active.dataset.testid === testId
        );
      }, editorTestId),
    )
    .toBe(true);
}

for (const surface of ['Home', 'chat']) {
  test(`CAN-5213 ${surface} daily-credit cues recover by keyboard and refresh readiness`, async () => {
    test.setTimeout(150_000);
    const suffix = randomUUID().replaceAll('-', '');
    const clientDeviceId = randomUUID();
    const guestKey = `csk_guest_can5213_${suffix}`;
    const authKey = `csk_can5213_auth_${suffix}`;
    let fixture;
    try {
      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        `guest-device:${clientDeviceId}`,
        { guestToken: guestKey },
      );
      await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
        authUsage: { scenario: 'unauthenticated' },
      });
      await registerScenario(DEFAULT_MOCK_BASE_URL, guestKey, {
        cloud: {
          dailyCreditDrip: {
            enabled: false,
            decidedAt: '2026-01-01T00:00:00.000Z',
            capCredits: 25,
          },
          aiCreditsSubscription: { active: false, source: 'canopy' },
          aiCreditsBalance: {
            credits: 0,
            eligible: false,
            dailyDripEnabled: false,
            dailyDripCapCredits: 25,
            orgPool: null,
            source: 'canopy',
          },
          entitlements: {
            plan: null,
            source: 'none',
            trial: null,
            capabilities: [],
            coveringOrgs: [],
            billingManageableOrg: null,
            modelLibrary: 'needs_sign_in_then_purchase',
            workModelLibrary: {
              owner: { kind: 'personal' },
              access: 'needs_sign_in_then_purchase',
            },
          },
        },
      });
      fixture = await withBundledBinaryOverridesScrubbed(() =>
        launchGuestChat('canopy-can5213-', {
          clientDeviceId,
          preserveNativeGatewayRoutes: true,
          env: {
            OPENAI_API_KEY: '',
            CANOPY_MOCK_API_KEY: authKey,
            CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
          },
        }),
      );
      const { window, electronApp } = fixture;
      if (surface === 'Home') {
        await new CanopyAppDriver(window).openHomeForProject(WORKSPACE_ID);
      }
      const picker = window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first();
      const original = await picker.textContent();
      await picker.click();
      for (const model of [
        ALLOWED_DEFAULT_MODEL,
        ALLOWED_NATIVE_MODEL,
        ALLOWED_CLAUDE_MODEL,
      ]) {
        const row = await revealModelRow(window, model);
        await expect(
          row.getByTestId(`chat-model-option-lock-label-${model}`),
        ).toHaveText('Needs free daily credits');
        await expect(row).toHaveAccessibleDescription(
          'Turn on free daily credits to use this model.',
        );
        await expect(row).not.toHaveAttribute('data-available');
        const name = row.getByTestId(`chat-model-option-label-${model}`);
        await expect
          .poll(
            () =>
              name.evaluate(
                (element) => element.scrollWidth <= element.clientWidth,
              ),
            {
              message: `${model} identity stays readable alongside its recovery cue`,
            },
          )
          .toBe(true);
      }
      for (const mode of ['light', 'dark']) {
        await electronApp.evaluate(({ nativeTheme }, themeSource) => {
          nativeTheme.themeSource = themeSource;
        }, mode);
        await window.evaluate(
          (dark) => document.documentElement.classList.toggle('dark', dark),
          mode === 'dark',
        );
        for (const model of [ALLOWED_DEFAULT_MODEL, BLOCKED_MODEL]) {
          const row = await revealModelRow(window, model);
          const label = row.getByTestId(
            `chat-model-option-lock-label-${model}`,
          );
          for (const state of ['rest', 'hover', 'focus']) {
            await window.mouse.move(0, 0);
            if (state === 'hover') await row.hover();
            if (state === 'focus') await row.focus();
            await expect
              .poll(() => label.evaluate(textContrastRatio), {
                message: `${model} ${mode} ${state} contrast`,
              })
              .toBeGreaterThanOrEqual(4.5);
          }
        }
      }
      const blocked = await revealModelRow(window, BLOCKED_MODEL);
      await expect(
        blocked.getByTestId(`chat-model-option-lock-label-${BLOCKED_MODEL}`),
      ).toHaveText('Sign in and buy');
      const opus = await revealModelRow(window, NATIVE_SUBSCRIPTION_MODEL);
      await expect(
        opus.getByTestId(
          `chat-model-option-lock-label-${NATIVE_SUBSCRIPTION_MODEL}`,
        ),
      ).toHaveText('Sign in and buy');
      await expect(opus).not.toHaveAttribute('data-available');
      const haiku = await revealModelRow(window, ALLOWED_CLAUDE_MODEL);
      await haiku.focus();
      await window.keyboard.press('Enter');
      const modal = window.getByTestId('model-recovery-modal');
      await expect(
        window.getByTestId('model-recovery-turn-on-daily-credits'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);
      await expect(picker).toHaveText(original);
      await expectComposerFocused(
        window,
        surface === 'Home' ? 'home-composer-editor' : null,
      );
      expect(
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, guestKey)).activity
          .dailyCreditDripEnable ?? 0,
      ).toBe(0);

      await picker.click();
      await (await revealModelRow(window, ALLOWED_CLAUDE_MODEL)).click();
      await window.getByTestId('model-recovery-turn-on-daily-credits').click();
      await expect(modal).toHaveCount(0, { timeout: 30_000 });
      await expect(picker).toContainText('Haiku');
      expect(
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, guestKey)).activity
          .dailyCreditDripEnable,
      ).toBe(1);

      await picker.click();
      for (const model of [
        ALLOWED_DEFAULT_MODEL,
        ALLOWED_NATIVE_MODEL,
        ALLOWED_CLAUDE_MODEL,
      ]) {
        const row = await revealModelRow(window, model);
        await expect(row).toHaveAttribute('data-available', 'true');
        await expect(row).toHaveAttribute('role', 'menuitemradio');
        await expect(
          row.getByTestId(`chat-model-option-available-${model}`),
        ).toHaveText('Available');
      }

      // Hold the real scoped IPC read after account invalidation. The open
      // picker must withdraw its old balance's cue before the answer arrives.
      await electronApp.evaluate(({ ipcMain }) => {
        const channel = 'settings:load-native-ai-credits-availability';
        const originalHandler = ipcMain._invokeHandlers.get(channel);
        if (typeof originalHandler !== 'function')
          throw new Error('Missing credit availability handler');
        globalThis.can5213PendingReads = 0;
        globalThis.can5213ReleaseReads = [];
        globalThis.can5213HoldReads = true;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          globalThis.can5213PendingReads += 1;
          if (globalThis.can5213HoldReads)
            await new Promise((resolve) =>
              globalThis.can5213ReleaseReads.push(resolve),
            );
          return originalHandler(event, ...args);
        });
      });
      await window.evaluate(() =>
        window.dispatchEvent(new Event('canopy:cloud-account-changed')),
      );
      await expect
        .poll(() => electronApp.evaluate(() => globalThis.can5213PendingReads))
        .toBeGreaterThan(0);
      await expect(
        window.locator('[data-model-id]:visible[data-available]'),
      ).toHaveCount(0);
      await electronApp.evaluate(() =>
        globalThis.can5213ReleaseReads.forEach((release) => release()),
      );
      await expect(
        await revealModelRow(window, ALLOWED_DEFAULT_MODEL),
      ).toHaveAttribute('data-available', 'true');

      // Exhaustion does not offer a second opt-in or change the checked model.
      await registerScenario(DEFAULT_MOCK_BASE_URL, guestKey, {
        cloud: {
          aiCreditsSubscription: { active: false, source: 'canopy' },
          aiCreditsBalance: {
            credits: 0,
            eligible: false,
            dailyDripEnabled: true,
            orgPool: null,
            source: 'canopy',
          },
          dailyCreditDrip: {
            enabled: true,
            decidedAt: '2026-01-01T00:00:00.000Z',
            capCredits: 25,
          },
          entitlements: {
            plan: null,
            source: 'none',
            trial: null,
            capabilities: [],
            coveringOrgs: [],
            billingManageableOrg: null,
            modelLibrary: 'needs_sign_in_then_purchase',
            workModelLibrary: {
              owner: { kind: 'personal' },
              access: 'needs_sign_in_then_purchase',
            },
          },
        },
      });
      await electronApp.evaluate(() => {
        globalThis.can5213HoldReads = false;
      });
      await window.evaluate(() =>
        window.dispatchEvent(new Event('canopy:cloud-account-changed')),
      );
      const exhausted = await revealModelRow(window, ALLOWED_CLAUDE_MODEL);
      const creditsTag = exhausted.getByTestId(
        `chat-model-row-credits-${ALLOWED_CLAUDE_MODEL}`,
      );
      // With no persisted credits route, chat billing now resolves an empty
      // balance to a native attempt (CAN-4272). Home has no billing intent yet.
      if (surface === 'Home') {
        await expect(creditsTag).toContainText('AI Credits');
      } else {
        await expect(creditsTag).toHaveCount(0);
      }
      await expect(
        exhausted.getByTestId(
          `chat-model-option-lock-label-${ALLOWED_CLAUDE_MODEL}`,
        ),
      ).toHaveCount(0);
      await expect(exhausted).not.toHaveAttribute('data-available');
      await expect(exhausted).not.toHaveAttribute('data-locked');
      await expect(exhausted).toHaveAttribute('aria-checked', 'true');
      await expect(picker).toContainText('Haiku');
    } finally {
      if (fixture) await closeCanopy(fixture.electronApp, fixture.userDataDir);
      for (const key of [`guest-device:${clientDeviceId}`, guestKey, authKey])
        await clearScenario(DEFAULT_MOCK_BASE_URL, key).catch(() => undefined);
    }
  });
}

test('intercepts a guest picking a model Canopy pays for, and never commits', async () => {
  const fixture = await launchGuestChat('canopy-can3026-intercept-');
  try {
    const picker = await openPicker(fixture.window);

    // Library locks name the standing account requirement before activation.
    const row = fixture.window.getByTestId(
      `chat-model-option-${BLOCKED_MODEL}`,
    );
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-disabled', 'true');
    await expect(
      row.getByTestId(`chat-model-option-lock-label-${BLOCKED_MODEL}`),
    ).toHaveText('Sign in');
    await expect(row).toHaveAccessibleDescription('Unlock with sign-in');
    await expect(
      row.getByTestId(`chat-model-row-credits-${BLOCKED_MODEL}`),
    ).toHaveCount(0);

    await row.click();

    const body = fixture.window.getByTestId('model-recovery-needs-account');
    await expect(body).toBeVisible();
    await expect(body).toContainText(`${BLOCKED_MODEL_LABEL} needs a free`);
    await expect(body).not.toContainText('hosted by');
    // Never a purchase: the guest is already funded, so credits are not the
    // missing thing.
    await expect(
      fixture.window.getByTestId('model-recovery-get-credits'),
    ).toHaveCount(0);

    // `Not now` restores the original selection.
    await fixture.window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(0);
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);

    await expectComposerFocused(fixture.window, null);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-4703 offers the free Claude model and selects it in one click', async () => {
  const fixture = await launchGuestChat('canopy-can4703-fallback-');
  try {
    const picker = await openPicker(fixture.window);
    await fixture.window
      .getByTestId(`chat-model-option-${BLOCKED_MODEL}`)
      .click();

    const modal = fixture.window.getByTestId('model-recovery-modal');
    await expect(modal).toContainText(
      `Sign in free to use ${BLOCKED_MODEL_LABEL}`,
    );
    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toContainText(
      `As a guest you can use ${ALLOWED_CLAUDE_FALLBACK_LABEL} right now.`,
    );
    await expect(
      fixture.window.getByTestId('model-recovery-account-sign-in'),
    ).toHaveText(`Sign in to use ${BLOCKED_MODEL_LABEL}`);
    const fallback = fixture.window.getByTestId(
      'model-recovery-guest-fallback',
    );
    await expect(fallback).toHaveText(
      `Use ${ALLOWED_CLAUDE_FALLBACK_LABEL} (free)`,
    );
    await expect(
      fixture.window.getByTestId('model-recovery-cancel'),
    ).toHaveText('Not now');

    await fallback.click();

    await expect(modal).toHaveCount(0);
    await expect(picker).toContainText(ALLOWED_CLAUDE_PICKER_LABEL);
    // The picker stays closed: the caret goes back to the composer input.
    await expect(fixture.window.getByTestId('chat-model-menu')).toHaveCount(0);
    await expectComposerFocused(fixture.window, null);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-4703 Home selects the free Claude model from the gate', async () => {
  const fixture = await launchGuestChat('canopy-can4703-home-');
  try {
    const app = new CanopyAppDriver(fixture.window);
    const home = await app.openHomeForProject(WORKSPACE_ID);
    const picker = home.getByTestId('chat-model-picker');
    await picker.click();
    const row = await revealModelRow(fixture.window, BLOCKED_MODEL);
    await row.click();

    await fixture.window.getByTestId('model-recovery-guest-fallback').click();

    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(0);
    await expect(picker).toContainText(ALLOWED_CLAUDE_PICKER_LABEL);
    await expectComposerFocused(fixture.window, 'home-composer-editor');
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-4703 preserves the original harness after a refused fallback and sign-in', async () => {
  const fixture = await launchGuestChat('canopy-can4703-refused-fallback-');
  try {
    const picker = await openPicker(fixture.window);
    await fixture.window.getByTestId('chat-model-harness-tab-claude').click();
    // The harness tab keeps a hidden copy of the row; click the visible one.
    await fixture.window
      .getByTestId(`chat-model-option-${BLOCKED_MODEL}`)
      .filter({ visible: true })
      .click();
    await expect(
      fixture.window.getByTestId('model-recovery-guest-fallback'),
    ).toBeVisible();

    // Reject only the alternative at the existing IPC seam. Observe the
    // subsequent original-model request without replacing its real handler.
    await fixture.electronApp.evaluate(({ ipcMain }, fallbackModel) => {
      const channel = 'chat:model-change';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Model change handler is unavailable');
      globalThis.can4703RecoveryRequests = [];
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, request) => {
        globalThis.can4703RecoveryRequests.push(request);
        if (request.model === fallbackModel) return false;
        return original(event, request);
      });
    }, ALLOWED_CLAUDE_MODEL);
    await fixture.window.getByTestId('model-recovery-guest-fallback').click();
    await expect(
      fixture.window.getByTestId('model-recovery-fallback-blocked'),
    ).toBeVisible();
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);
    await fixture.window.getByTestId('model-recovery-account-sign-in').click();
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toBeVisible();

    // Stand in for the fresh account read after guest OAuth completes. Manual
    // API-key replacement deliberately cannot replace a guest credential.
    const guestAccount = await fixture.window.evaluate(() =>
      window.api.loadCanopyCloudAccount(),
    );
    await fixture.electronApp.evaluate(({ ipcMain }, account) => {
      const channel = 'settings:load-canopy-cloud-account';
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({
        ...account,
        authMode: 'account',
        credentialSource: 'account',
        account: {
          ...account.account,
          id: 'can-4703-signed-in-account',
          name: 'Signed-in E2E',
        },
      }));
    }, guestAccount);
    await fixture.window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await fixture.window.keyboard.press('Escape');
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toHaveCount(0);
    await expect
      .poll(() =>
        fixture.electronApp.evaluate(() => globalThis.can4703RecoveryRequests),
      )
      .toEqual([
        expect.objectContaining({ model: ALLOWED_CLAUDE_MODEL }),
        expect.objectContaining({
          model: BLOCKED_MODEL,
          executionHarness: 'claude',
        }),
      ]);
    // Main's apply step has no guest rule, and main now knows the model
    // (its catalog was seeded, CAN-5022), so the resumed request for the
    // original model commits on the user's own harness. This used to assert a
    // refusal that only happened because main had never heard of the model.
    // Cancelling a refused recovery is covered by model-picker-recovery.spec.mjs
    // ("cancel never commits").
    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(0);
    await expect(picker).toContainText(BLOCKED_MODEL_LABEL);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-4703 selects the fallback with the keyboard from the initial sign-in focus', async () => {
  const fixture = await launchGuestChat('canopy-can4703-keyboard-');
  try {
    const picker = await openPicker(fixture.window);
    await fixture.window
      .getByTestId(`chat-model-option-${BLOCKED_MODEL}`)
      .click();
    await expect(
      fixture.window.getByTestId('model-recovery-account-sign-in'),
    ).toBeFocused();
    await fixture.window.keyboard.press('Tab');
    await expect(
      fixture.window.getByTestId('model-recovery-guest-fallback'),
    ).toBeFocused();
    await fixture.window.keyboard.press('Enter');
    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(0);
    await expect(picker).toContainText(ALLOWED_CLAUDE_PICKER_LABEL);
    await expectComposerFocused(fixture.window, null);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-4703 offers no unrelated default for a vendor without an allowed sibling', async () => {
  const fixture = await launchGuestChat('canopy-can4703-no-sibling-', {
    blockedGatewayId: 'unknown-vendor/zulu-gateway',
  });
  try {
    const picker = await openPicker(fixture.window);
    await fixture.window
      .getByTestId(`chat-model-option-${BLOCKED_MODEL}`)
      .click();
    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toContainText('Your guest work comes with you, nothing is lost.');
    await expect(
      fixture.window.getByTestId('model-recovery-guest-fallback'),
    ).toHaveCount(0);
    await fixture.window.keyboard.press('Escape');
    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(0);
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);
    await expectComposerFocused(fixture.window, null);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-4703 offers no fallback when the chat already uses it', async () => {
  const fixture = await launchGuestChat('canopy-can4703-selected-', {
    model: ALLOWED_CLAUDE_MODEL,
  });
  try {
    const picker = await openPicker(
      fixture.window,
      ALLOWED_CLAUDE_PICKER_LABEL,
    );
    await fixture.window
      .getByTestId(`chat-model-option-${BLOCKED_MODEL}`)
      .click();

    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toContainText('Your guest work comes with you, nothing is lost.');
    await expect(
      fixture.window.getByTestId('model-recovery-guest-fallback'),
    ).toHaveCount(0);
    await fixture.window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(picker).toContainText(ALLOWED_CLAUDE_PICKER_LABEL);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-4705 Home names sign-in locks before interaction and keyboard recovery preserves selection', async () => {
  const fixture = await launchGuestChat('canopy-can4705-home-');
  try {
    const app = new CanopyAppDriver(fixture.window);
    const home = await app.openHomeForProject(WORKSPACE_ID);
    const picker = home.getByTestId('chat-model-picker');
    const original = await picker.textContent();
    await picker.click();
    const allowed = await revealModelRow(fixture.window, ALLOWED_DEFAULT_MODEL);
    await expect(allowed).not.toHaveAttribute('data-locked', 'true');
    // CAN-5213: a funded guest's allowed row says Available in place of the
    // credits tag; an unsettled one keeps the tag. Never both.
    await expect(
      allowed.locator(
        `[data-testid="chat-model-option-available-${ALLOWED_DEFAULT_MODEL}"], [data-testid="chat-model-row-credits-${ALLOWED_DEFAULT_MODEL}"]`,
      ),
    ).toHaveCount(1);
    const row = await revealModelRow(fixture.window, BLOCKED_MODEL);
    await expect(
      row.getByTestId(`chat-model-option-lock-label-${BLOCKED_MODEL}`),
    ).toHaveText('Sign in');
    await expect(
      row.getByTestId(`chat-model-row-credits-${BLOCKED_MODEL}`),
    ).toHaveCount(0);
    await expect(row).toHaveAccessibleDescription('Unlock with sign-in');
    // The real registry makes this menu scroll. Park the pointer on an allowed
    // row near the locked one (DeepSeek sits at the far end of the list) while
    // the arrows below move the highlight.
    const neighbor = await revealModelRow(fixture.window, ALLOWED_CLAUDE_MODEL);
    await expect(row).toBeVisible();

    // Leave the pointer over another row while arrows move the highlight.
    await fixture.window.getByTestId('chat-model-search').click();
    await neighbor.hover();
    for (let step = 0; step < 30; step += 1) {
      await fixture.window.keyboard.press('ArrowDown');
      if (await row.evaluate((node) => node === document.activeElement)) break;
    }
    await expect(row).toBeFocused();
    const card = fixture.window.getByTestId(
      `chat-model-option-detail-${BLOCKED_MODEL}`,
    );
    await expect(card).toBeVisible();
    await expect(card.locator('p').nth(1)).toHaveText('Unlock with sign-in');
    await expect(
      fixture.window.locator(
        '[data-testid^="chat-model-option-detail-"]:visible',
      ),
    ).toHaveCount(1);
    await neighbor.hover();
    await expect(card).toBeHidden();
    await fixture.window.mouse.move(0, 0);
    await expect(card).toBeVisible();
    await fixture.window.keyboard.press('Enter');
    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toBeVisible();
    await fixture.window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(picker).toHaveText(original ?? '');
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('never raises the account gate for an allowlisted model', async () => {
  // DECISION-0 REGRESSION TEST. `deepseek-v4-pro` is the AI-Credits lane
  // default in already-shipped desktop builds and `gpt-6-luna` is cloud
  // chat's. Gating either would prompt installed guest clients that never
  // chose anything. Haiku 5.5 is the allowlisted Claude option; it is checked
  // first, while the chat is still on its original Claude model.
  //
  // Asserted as "no account gate" rather than "commits silently" so the case
  // does not depend on whatever credit balance the cloud mock hands this
  // guest: an allowlisted row must reach its ORDINARY pre-CAN-3026 outcome,
  // whichever that is.
  const fixture = await launchGuestChat('canopy-can3026-allowlist-');
  try {
    await openPicker(fixture.window);

    for (const model of [
      ALLOWED_CLAUDE_MODEL,
      ALLOWED_DEFAULT_MODEL,
      ALLOWED_NATIVE_MODEL,
    ]) {
      const row = await revealModelRow(fixture.window, model);
      await expect(row).toBeVisible();
      await expect(row).not.toHaveAttribute('aria-disabled', 'true');
      await row.click();
      await expect(
        fixture.window.getByTestId('model-recovery-needs-account'),
      ).toHaveCount(0);

      // Reopen for the next row, dismissing whatever (if anything) opened.
      const modal = fixture.window.getByTestId('model-recovery-modal');
      if ((await modal.count()) > 0) {
        await fixture.window
          .getByTestId('model-recovery-modal')
          .getByRole('button', { name: 'Close', exact: true })
          .click();
        await expect(modal).toHaveCount(0);
      }
      await openPicker(fixture.window).catch(async () => {
        await fixture.window
          .locator('[data-testid="chat-model-picker"]:visible')
          .first()
          .click();
      });
    }
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test("leaves a guest's own native subscription models alone", async () => {
  // The deliberate scope limit, and the reason this gate is NOT simply "a
  // guest may only pick allowlisted models". `opus[1m]` (Opus 5.5) has no
  // gateway route here (the launch seeds the catalog without its gateway id),
  // so AI Credits cannot carry it and Canopy pays nothing — it runs on the
  // guest's own Claude subscription. Prompting here
  // would push a guest OFF a subscription they already pay for and ONTO the
  // hosted gateway, raising Canopy's cost for exactly the users the gate
  // targets.
  //
  // Asserted as "no account gate" rather than "commits", so the case does not
  // depend on whatever native-auth state the E2E environment reports: the
  // CAN-3026 claim is that this row reaches its ORDINARY pre-gate outcome,
  // whichever that is.
  const fixture = await launchGuestChat('canopy-can3026-native-');
  try {
    await openPicker(fixture.window);

    const row = await revealModelRow(fixture.window, NATIVE_SUBSCRIPTION_MODEL);
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-disabled', 'true');
    await row.click();

    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-5213 names the provider sign-in on a row credits cannot run', async () => {
  // `opus[1m]` has no gateway route here, so only a Claude login runs it. The
  // row says so before it is opened instead of looking available. An unfunded
  // guest keeps the chat on its subscription lane, where the row is listed.
  test.setTimeout(150_000);
  const suffix = randomUUID().replaceAll('-', '');
  const clientDeviceId = randomUUID();
  const guestKey = `csk_guest_can5213_signin_${suffix}`;
  const authKey = `csk_can5213_signin_auth_${suffix}`;
  let fixture;
  try {
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      `guest-device:${clientDeviceId}`,
      { guestToken: guestKey },
    );
    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, guestKey, {
      cloud: {
        dailyCreditDrip: {
          enabled: false,
          decidedAt: '2026-01-01T00:00:00.000Z',
          capCredits: 25,
        },
        aiCreditsSubscription: { active: false, source: 'canopy' },
        aiCreditsBalance: {
          credits: 0,
          eligible: false,
          dailyDripEnabled: false,
          dailyDripCapCredits: 25,
          orgPool: null,
          source: 'canopy',
        },
      },
    });
    fixture = await withBundledBinaryOverridesScrubbed(() =>
      launchGuestChat('canopy-can5213-signin-', {
        clientDeviceId,
        observeDrip: true,
        env: {
          OPENAI_API_KEY: '',
          CANOPY_MOCK_API_KEY: authKey,
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        },
      }),
    );
    const { window } = fixture;
    const picker = await openPicker(window);
    const row = await revealModelRow(window, NATIVE_SUBSCRIPTION_MODEL);
    await expect(
      row.getByTestId(
        `chat-model-option-lock-label-${NATIVE_SUBSCRIPTION_MODEL}`,
      ),
    ).toHaveText('Needs Claude sign-in');
    await expect(row).toHaveAccessibleDescription(
      'Sign in to Claude to use this model.',
    );
    await expect(row).not.toHaveAttribute('data-available');

    await row.click();
    await expect(window.getByTestId('model-recovery-sign-in')).toHaveText(
      'Sign in to Claude',
    );
    await expect(
      window.getByTestId('model-recovery-needs-account'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);
  } finally {
    if (fixture) await closeCanopy(fixture.electronApp, fixture.userDataDir);
    for (const key of [`guest-device:${clientDeviceId}`, guestKey, authKey])
      await clearScenario(DEFAULT_MOCK_BASE_URL, key).catch(() => undefined);
  }
});

test('routes guest sign-in through the shared cloud gate without committing', async () => {
  const fixture = await launchGuestChat('canopy-can3026-signin-');
  try {
    const picker = await openPicker(fixture.window);
    await selectModelOption(fixture.window, `${BLOCKED_MODEL}`);
    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toBeVisible();

    await fixture.window.getByTestId('model-recovery-account-sign-in').click();

    // The SHARED `CloudSyncModal`, not a bespoke sign-in surface.
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toBeVisible();
    // The recovery modal stays MOUNTED underneath (hidden, not unmounted) so
    // the gate-close re-read still has a live component to commit through.
    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(1);
    // Nothing was committed on the way to the gate.
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);

    // Walking away from the gate WITHOUT connecting must leave the guest
    // exactly where they started. The gate-close effect re-reads the account,
    // finds the same guest, and the guard in `refreshAccountRead` holds — so
    // the one thing that must NOT happen is a commit landing on the way out.
    await fixture.window.keyboard.press('Escape');
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toHaveCount(0);
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-4703 purchase CTA signs a guest in and opens checkout without a second ask', async () => {
  test.setTimeout(120_000);
  const suffix = randomUUID().replaceAll('-', '');
  const clientDeviceId = randomUUID();
  const guestKey = `csk_guest_can4703_${suffix}`;
  const entitlementsWith = (access) => ({
    plan: { key: 'free', displayName: 'Free' },
    source: 'none',
    trial: null,
    capabilities: [],
    coveringOrgs: [],
    billingManageableOrg: null,
    modelLibrary: access,
    workModelLibrary: { owner: { kind: 'personal' }, access },
  });
  const opened = [];
  const capture = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    opened.push(JSON.parse(body).url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve));
  const { port } = capture.address();
  let fixture;
  try {
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      `guest-device:${clientDeviceId}`,
      { guestToken: guestKey },
    );
    await registerScenario(DEFAULT_MOCK_BASE_URL, guestKey, {
      cloud: { entitlements: entitlementsWith('needs_sign_in_then_purchase') },
    });
    fixture = await launchGuestChat('canopy-can4703-purchase-', {
      clientDeviceId,
      env: {
        CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: `http://127.0.0.1:${port}/capture`,
      },
    });
    const picker = await openPicker(fixture.window);
    const row = fixture.window.getByTestId(
      `chat-model-option-${BLOCKED_MODEL}`,
    );
    await expect(row).toHaveAccessibleDescription(
      'Unlock with sign-in and AI Credit purchase',
    );
    // CAN-5213: the row names both steps before it is opened.
    await expect(
      row.getByTestId(`chat-model-option-lock-label-${BLOCKED_MODEL}`),
    ).toHaveText('Sign in and buy');
    await row.click();

    const modal = fixture.window.getByTestId('model-recovery-modal');
    await expect(modal).toContainText('Unlock advanced models');
    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toHaveText(
      new RegExp(
        `^Using ${BLOCKED_MODEL_LABEL} requires a free .+ account and a purchase of AI Credits\\. As a guest you can use ${ALLOWED_CLAUDE_FALLBACK_LABEL} right now\\.$`,
      ),
    );
    const cta = fixture.window.getByTestId('model-recovery-account-sign-in');
    await expect(cta).toHaveText('Get AI Credits');
    await expect(cta).toBeFocused();

    await cta.click();
    // The shared sign-in gate, with the recovery modal hidden beneath it.
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toBeVisible();
    await expect(modal).toHaveCount(1);
    expect(opened).toHaveLength(0);

    // Stand in for completing guest OAuth: the account read reports a signed-in
    // account, and the server now answers for it. Manual API-key replacement
    // deliberately cannot replace a guest credential.
    await registerScenario(DEFAULT_MOCK_BASE_URL, guestKey, {
      cloud: { entitlements: entitlementsWith('needs_purchase') },
    });
    const guestAccount = await fixture.window.evaluate(() =>
      window.api.loadCanopyCloudAccount(),
    );
    const signedInEntitlements = await fixture.window.evaluate(() =>
      window.api.loadCanopyCloudEntitlements(),
    );
    await fixture.electronApp.evaluate(
      ({ ipcMain }, { account, entitlements }) => {
        const accountChannel = 'settings:load-canopy-cloud-account';
        ipcMain.removeHandler(accountChannel);
        ipcMain.handle(accountChannel, () => ({
          ...account,
          authMode: 'account',
          credentialSource: 'account',
          // The same id: main still reads entitlements for this credential, and
          // the modal only trusts an answer about the account it sees.
          account: { ...account.account, name: 'Signed-in E2E' },
        }));
        // Main's own answer, now about the signed-in account. Checkout opens
        // only when main and the renderer name the same account.
        const entitlementsChannel = 'settings:load-canopy-cloud-entitlements';
        ipcMain.removeHandler(entitlementsChannel);
        ipcMain.handle(entitlementsChannel, () => ({
          ...entitlements,
          modelLibraryAccountKey: `account:${account.account.id}`,
        }));
      },
      { account: guestAccount, entitlements: signedInEntitlements },
    );
    await fixture.window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    // A completed sign-in closes the panel; the gate then resumes the unlock
    // for the now signed-in account.
    await fixture.window.keyboard.press('Escape');
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toHaveCount(0);

    // Checkout opens straight away: no second "Get AI Credits" ask.
    await expect.poll(() => opened.length).toBe(1);
    const activity = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, guestKey);
    const minted = Object.keys(activity.activity).filter((name) =>
      name.startsWith('authLinkMint:'),
    );
    expect(minted).toHaveLength(1);
    const checkout = new URL(
      minted[0].slice('authLinkMint:'.length),
      DEFAULT_MOCK_BASE_URL,
    );
    expect(checkout.searchParams.get('reason')).toBe('unlock_models');
    expect(checkout.searchParams.get('modelId')).toBe(BLOCKED_MODEL);
    await expect(
      fixture.window.getByTestId('model-recovery-unlock-waiting'),
    ).toBeVisible();
    await expect(
      fixture.window.getByTestId('model-recovery-unlock-purchase'),
    ).toHaveCount(0);
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);
  } finally {
    if (fixture) await closeCanopy(fixture.electronApp, fixture.userDataDir);
    for (const key of [`guest-device:${clientDeviceId}`, guestKey]) {
      await clearScenario(DEFAULT_MOCK_BASE_URL, key).catch(() => undefined);
    }
    await new Promise((resolve) => capture.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Config surfaces (plan §4a). The five model-config editors — `ModelAliasesEditor`,
// `PipelineModelAliasEditor`, `HookActionEditor`, `AgentModelModal`,
// `AutomationsPage` — must stay at ZERO diff, because they write a CONFIG value
// rather than running a chat turn. A sign-in prompt that then commits a hook's
// model would gate the wrong thing entirely.
//
// The mechanism is `gatingEnabled`, which `ModelPicker` derives from whether the
// caller passed `providerAvailability` — only the two chat composers do. The
// unit matrix asserts the predicate directly; this spec proves the derivation
// actually reaches the gate through a real rendered config surface.
//
// `HookActionEditor` is the representative surface: it is the one with an
// established Electron path (`hook-action-model-alias.spec.mjs`). The other four
// share the identical `gatingEnabled` derivation and stay unit-covered.
// ---------------------------------------------------------------------------

const HOOK_WORKSPACE_ID = 'demo-multi-repo-fullstack';
const HOOK_WORKSPACE_NAME = 'Multi Repo Fullstack';
const HOOK_PROMPT = 'Review this PR for the guest model gate.';

function seedChatHook(userDataDir) {
  seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
    checkRuntimes: false,
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    HOOK_WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const webRepo = config.repos.find((repo) => repo.id === 'web');
  if (!webRepo) throw new Error('Missing web repo in seeded workspace');
  webRepo.hooks = {
    'pr:create': [{ type: 'chat', prompt: HOOK_PROMPT, model: CURRENT_MODEL }],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

test('leaves the model-config surfaces ungated for a guest', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3026-config-'),
  );
  seedChatHook(userDataDir);
  seedGatewayCatalogCache(userDataDir, guestGateCatalog());
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const guestAccount = await window.evaluate(
      async (consent) => window.api.startCanopyGuestSession(consent),
      GUEST_CONSENT,
    );
    expect(guestAccount.credentialSource).toBe('guest');
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await expectGuestGateRoutesInMain(window);

    const settings = window.getByRole('dialog', { name: HOOK_WORKSPACE_NAME });
    // Registry hydration can move the row after hover. Re-hover the visible
    // header rather than waiting on a settings icon whose hover was lost.
    await expect(async () => {
      if (await settings.isVisible()) return;
      await app.workspaceHeaderLabel(HOOK_WORKSPACE_NAME).hover();
      await app
        .workspaceSettingsButton(HOOK_WORKSPACE_NAME)
        .click({ timeout: 2_000 });
      await expect(settings).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await settings.getByRole('tab', { name: 'Hooks' }).click();

    // Scope to the chat-action editor card that owns the seeded prompt.
    const prompt = settings
      .locator('[data-testid^="hook-chat-"][contenteditable="true"]')
      .filter({ hasText: HOOK_PROMPT });
    await expect(prompt).toHaveCount(1);
    const editor = prompt.locator(
      'xpath=ancestor::div[contains(@class,"rounded-lg") and contains(@class,"bg-card")][1]',
    );

    const picker = editor.getByTestId('chat-model-picker');
    await expect(picker).toBeVisible();
    await picker.click();

    // The expensive, non-allowlisted row the CHAT composer intercepts for this
    // same guest. Here it must reach its ordinary pre-CAN-3026 outcome instead
    // — whatever `gatingEnabled: false` leaves it as — and must never raise the
    // account gate. If `gatingEnabled` ever stopped reaching `guestMustSignIn`,
    // this row would turn `recoverable` and the modal below would appear.
    const row = window.getByTestId(`chat-model-option-${BLOCKED_MODEL}`);
    await expect(row).toBeVisible();
    await row.click({ force: true });

    await expect(
      window.getByTestId('model-recovery-needs-account'),
    ).toHaveCount(0);
    await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
