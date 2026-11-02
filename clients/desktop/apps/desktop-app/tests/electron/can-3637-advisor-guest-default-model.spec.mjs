// CAN-3637: real first-launch guest, exact request model, hydration and picker seam.
// All probes are explicit fixtures; live turns hit the scripted loopback LLM.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectModelOption } from './model-selection-fixture.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';

const allowed = /DeepSeek V4 Pro|GPT 6 Luna|GPT 5\.6 Luna/;
// The native Codex default: no gateway route, so guests never see it.
const NATIVE_DEFAULT_MODEL = 'gpt-6.1-sol';
// Gateway-routable and listed, but outside the guest allowlist above.
const NO_GUEST_ROUTE_MODEL = 'gpt-5.6-terra';

async function runAdvisor(
  name,
  { hold = false, native = false, noRoute = false } = {},
  body,
) {
  const marker = `Canopy-C3637-${name}`;
  const reply = `Advisor fixture reply ${name}`;
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-3637-advisor-'));
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    authUsage: { scenario: native ? 'authed-low-usage' : 'unauthenticated' },
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });
  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        freshOnboarding: true,
        env: {
          OPENAI_API_KEY: '',
          CANOPY_MOCK_API_KEY: marker,
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-guest-mode-enabled': true,
            'canopy-billing-enabled': true,
          }),
        },
      }),
    ));
    // Fixture only provider detection. The guest is minted by the real startup
    // consent path; no startCanopyGuestSession call substitutes for onboarding.
    await electronApp.evaluate(
      ({ ipcMain }, { hold, native }) => {
        const state = {
          calls: [],
          held: [],
          catalogs: [],
          released: !hold,
          release: () => {},
        };
        const ready = new Promise((resolve) => {
          state.release = () => {
            state.released = true;
            for (const [sender, snapshot] of state.catalogs)
              sender.send('model-registry:updated', snapshot);
            resolve();
          };
        });
        globalThis.can3637Fixture = state;
        for (const provider of ['claude', 'codex']) {
          const channel = `settings:${provider}-auth-status`;
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, async (event) => {
            if (
              !state.released &&
              event.sender.getURL().includes('app-advisor')
            ) {
              state.held.push(channel);
              await ready;
            }
            return {
              authenticated: native && provider === 'codex',
              accountLabel: native ? 'fixture@example.test' : null,
              detail: null,
              error: null,
            };
          });
        }
        const accountChannel = 'settings:load-canopy-cloud-account';
        const accountRead = ipcMain._invokeHandlers.get(accountChannel);
        ipcMain._invokeHandlers.set(accountChannel, async (event, ...args) => {
          if (
            !state.released &&
            event.sender.getURL().includes('app-advisor')
          ) {
            state.held.push(accountChannel);
            await ready;
          }
          return accountRead(event, ...args);
        });
        const registryChannel = 'model-registry:get';
        const registryRead = ipcMain._invokeHandlers.get(registryChannel);
        ipcMain._invokeHandlers.set(registryChannel, async (event, ...args) => {
          const snapshot = await registryRead(event, ...args);
          if (
            !state.released &&
            event.sender.getURL().includes('app-advisor')
          ) {
            state.held.push(registryChannel);
            state.catalogs.push([event.sender, snapshot]);
            // Native rows let the composer mount; gateway routes stay cold
            // until the explicit release, matching delayed catalog availability.
            return { ...snapshot, aiGatewayModels: [], gatewayRoutes: [] };
          }
          return snapshot;
        });
        const sendChannel = 'chat:send-message';
        const send = ipcMain._invokeHandlers.get(sendChannel);
        ipcMain._invokeHandlers.set(sendChannel, (event, request) => {
          if (request.projectId === 'app-advisor')
            state.calls.push({
              model: request.model,
              providerType: request.providerType,
            });
          return send(event, request);
        });
      },
      { hold, native },
    );
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          window.evaluate(
            async () =>
              (await window.api.loadCanopyCloudAccount()).credentialSource,
          ),
        { timeout: 30_000 },
      )
      .toBe('guest');
    if (noRoute) {
      const snapshot = await window.evaluate(() =>
        window.api.getModelRegistry(),
      );
      snapshot.aiGatewayModels = snapshot.aiGatewayModels.filter(
        (entry) => entry.id === NO_GUEST_ROUTE_MODEL,
      );
      snapshot.gatewayRoutes = snapshot.gatewayRoutes.filter(
        (entry) => entry.modelId === NO_GUEST_ROUTE_MODEL,
      );
      await electronApp.evaluate(({ ipcMain }, snapshot) => {
        ipcMain.removeHandler('model-registry:get');
        ipcMain.handle('model-registry:get', () => snapshot);
      }, snapshot);
    }
    const advisor = await driver.openAppAdvisorWindow(electronApp);
    await advisor.setViewportSize({ width: 1200, height: 800 });
    const composer = advisor.getByRole('textbox').first();
    await expect(composer).toBeVisible();
    await body({ electronApp, advisor, composer, marker, reply });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker);
  }
}

async function calls(electronApp) {
  return electronApp.evaluate(() => globalThis.can3637Fixture.calls);
}
async function activity(marker) {
  return (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker)).activity;
}
async function sendAndAssert(
  { electronApp, advisor, composer, marker, reply },
  { native = false } = {},
) {
  const picker = advisor.getByTestId('chat-model-picker').first();
  await expect(picker).toContainText(native ? 'GPT 6.1 Sol' : allowed, {
    timeout: 30_000,
  });
  const label = await picker.textContent();
  const selected = native
    ? NATIVE_DEFAULT_MODEL
    : label.includes('DeepSeek')
      ? 'deepseek-v4-pro'
      : label.includes('GPT 6 Luna')
        ? 'gpt-6-luna'
        : 'gpt-5.6-luna';
  const gateway = {
    'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
    'gpt-6-luna': 'openai/gpt-6-luna',
    'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  };
  if (!native) {
    // The generic E2E Codex mock replaces prepareInvocation entirely. Bypass
    // that provider redirect after fixtures hydrate so this turn traverses the real
    // credits broker to the same loopback mock's /llm-proxy/openai endpoint.
    await electronApp.evaluate(() => {
      process.env.CANOPY_E2E_CODEX_REAL_ROUTING = '1';
    });
  }
  await composer.fill(`[${marker}] what is an advisor?`);
  await advisor
    .getByRole('button', { name: 'Send message', exact: true })
    .click();
  await expect(advisor.getByText(reply).first()).toBeVisible({
    timeout: 90_000,
  });
  expect(await calls(electronApp)).toEqual([
    expect.objectContaining({ model: selected, providerType: 'codex' }),
  ]);
  const observed = await activity(marker);
  expect(
    observed[`llmModel:${native ? selected : gateway[selected]}`] ?? 0,
    JSON.stringify(observed),
  ).toBeGreaterThan(0);
  if (!native) {
    expect(observed[`llmModel:${NATIVE_DEFAULT_MODEL}`] ?? 0).toBe(0);
  }
  if (!native) expect(observed['llmProxy:openai']).toBeGreaterThan(0);
  await expect(advisor.getByText(/guest_model_not_allowed/)).toHaveCount(0);
}

test('fresh onboarding guest sends an untouched Advisor default with canonical request agreement', async () => {
  test.setTimeout(180_000);
  await runAdvisor('FRESH', {}, (fixture) => sendAndAssert(fixture));
});

test('early typing preserves the draft and prevents dispatch until account, auth and catalog hydration', async () => {
  test.setTimeout(180_000);
  await runAdvisor('EARLY', { hold: true }, async (fixture) => {
    const { electronApp, advisor, composer } = fixture;
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.can3637Fixture.held.length),
      )
      .toBeGreaterThan(0);
    const text = `[${fixture.marker}] what is an advisor?`;
    await composer.fill(text);
    await composer.press('Enter');
    await test.info().attach('early-boundary.json', {
      body: JSON.stringify({
        calls: await calls(electronApp),
        activity: await activity(fixture.marker),
        tabs: await advisor.evaluate(async () => {
          const preferences = await window.api.loadPreferences();
          return {
            advisorModel: preferences.appAdvisorModel,
            defaultChatProvider: preferences.defaultChatProvider,
          };
        }),
      }),
      contentType: 'application/json',
    });
    await expect(composer).toContainText(text);
    expect(await calls(electronApp)).toEqual([]);
    expect((await activity(fixture.marker)).llmRequests ?? 0).toBe(0);
    await electronApp.evaluate(() => globalThis.can3637Fixture.release());
    await expect(
      advisor.getByTestId('chat-model-picker').first(),
    ).toContainText(allowed, { timeout: 30_000 });
    await expect(composer).toContainText(text);
    await sendAndAssert(fixture);
  });
});

test('hydrated catalog without an eligible route shows recovery and never dispatches', async () => {
  test.setTimeout(180_000);
  await runAdvisor(
    'NO-ROUTE',
    { noRoute: true },
    async ({ electronApp, advisor, composer, marker }) => {
      await expect(
        advisor.getByTestId('chat-input-no-billing-source-banner'),
      ).toBeVisible({ timeout: 30_000 });
      await composer.fill(`[${marker}] blocked draft`);
      await composer.press('Enter');
      await expect(composer).toContainText('blocked draft');
      expect(await calls(electronApp)).toEqual([]);
      expect((await activity(marker)).llmRequests ?? 0).toBe(0);
    },
  );
});

test('Advisor picker sign-in recovery cancels without a model request or selection change', async () => {
  test.setTimeout(180_000);
  await runAdvisor('PICKER', {}, async (fixture) => {
    await sendAndAssert(fixture);
    const { electronApp, advisor, marker } = fixture;
    const picker = advisor.getByTestId('chat-model-picker').first();
    const before = await picker.textContent();
    const beforeRequests = (await activity(marker)).llmRequests;
    const beforeCalls = await calls(electronApp);
    await picker.click();
    await selectModelOption(advisor, NO_GUEST_ROUTE_MODEL);
    await expect(
      advisor.getByTestId('model-recovery-needs-account'),
    ).toBeVisible();
    await expect(advisor.getByTestId('model-recovery-get-credits')).toHaveCount(
      0,
    );
    await advisor
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(picker).toHaveText(before);
    expect(await calls(electronApp)).toEqual(beforeCalls);
    expect((await activity(marker)).llmRequests).toBe(beforeRequests);
  });
});

test('a detected native Codex subscription retains the Advisor seed and native route', async () => {
  test.setTimeout(180_000);
  await runAdvisor('NATIVE', { native: true }, (fixture) =>
    sendAndAssert(fixture, { native: true }),
  );
});
