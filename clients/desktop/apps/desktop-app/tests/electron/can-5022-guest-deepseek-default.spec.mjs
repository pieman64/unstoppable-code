// CAN-5022 — a credits-only guest runs its Home default, DeepSeek V4 Pro.
//
//   pnpm run test:electron:built can-5022-guest-deepseek-default.spec.mjs --reporter=line
//
// DeepSeek V4 Pro is on the guest allowlist and is the credits lane's first
// default candidate. A journey reported it refused with "The selected model
// could not be applied to this chat." That refusal came from the test setup,
// not from a guest rule: the registry was sent to the renderer only, so the
// renderer chose a gateway model main had never heard of, and main's
// `chat:model-change` handler refused it.
//
// Here DeepSeek reaches main the production way: its catalog cache is seeded
// before launch (`gateway-catalog-fixture.mjs`), main hydrates it, and the
// renderer receives the routes with its first registry read. A recorder
// around main's real `chat:model-change` handler then proves the model the
// renderer chose is the model main accepted, and scripted replies through the
// mock LLM proxy prove both turns ran. A second test checks the AI Credits
// tag on that row meets AA contrast in light and dark, at rest and hovered.
import { mkdtempSync } from 'node:fs';
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
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { revealModelRow } from './model-selection-fixture.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { textContrastRatio } from './text-contrast-fixture.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const AUTH_KEY = 'can-5022-guest-unauthenticated';
const DEEPSEEK_MODEL = 'deepseek-v4-pro';
const DEEPSEEK_GATEWAY_ID = 'deepseek/deepseek-v4-pro';
const DEEPSEEK_LABEL = 'DeepSeek V4 Pro';
const REFUSAL_COPY = 'could not be applied';
const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};
const TURNS = [
  {
    marker: 'Canopy-C5022-first',
    prompt: 'Say hello as a guest.',
    reply: 'DeepSeek reply one',
  },
  {
    marker: 'Canopy-C5022-second',
    prompt: 'Say hello again.',
    reply: 'DeepSeek reply two',
  },
];

/**
 * Launches a guest whose provider CLIs are signed out, so the Home default
 * rides the AI Credits lane, with DeepSeek V4 Pro loaded into main.
 */
async function launchCreditsOnlyGuest(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedGatewayCatalogCache(userDataDir, {
    add: [
      gatewayCatalogEntry({
        id: DEEPSEEK_MODEL,
        gatewayId: DEEPSEEK_GATEWAY_ID,
        label: DEEPSEEK_LABEL,
        family: 'deepseek',
        familyLabel: 'DeepSeek',
        recommendedHarness: 'codex',
      }),
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, AUTH_KEY, {
    authUsage: { scenario: 'unauthenticated' },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        // A host API credential is a real native lane even when mock probes
        // say signed out.
        OPENAI_API_KEY: '',
        CANOPY_MOCK_API_KEY: AUTH_KEY,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-guest-mode-enabled': true,
          'canopy-billing-enabled': true,
        }),
      },
    }),
  );
  const close = async () => {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, AUTH_KEY).catch(() => {});
  };
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // A device-scoped guest credential, then the broadcast the renderer's
    // guest flag listens on, exactly as a first-launch guest mint does.
    const account = await window.evaluate(
      async (consent) => window.api.startCanopyGuestSession(consent),
      GUEST_CONSENT,
    );
    expect(account.credentialSource).toBe('guest');
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await expectGatewayRoutesInMain(window, [
      {
        modelId: DEEPSEEK_MODEL,
        gatewayId: DEEPSEEK_GATEWAY_ID,
        gatewayOnly: true,
      },
    ]);

    // Observe main's real acceptance without replacing it. Model changes
    // before this point are not recorded; the Home default is applied inside
    // the send path, after it.
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'chat:model-change';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Model change handler is unavailable');
      globalThis.can5022ModelChanges = [];
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        const result = await original(event, request);
        globalThis.can5022ModelChanges.push({ request, result });
        return result;
      });
    });

    return { app, close, electronApp, userDataDir, window };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * WCAG contrast of an element's text against what is actually painted under
 * it. Runs in the page. A canvas composites every ancestor background from
 * the outside in, so translucent hover fills are blended over the opaque
 * surface below them instead of overstating contrast, and any CSS color
 * syntax is normalized to sRGB.
 */

function homeModelChip(window) {
  return window
    .getByTestId('page-home')
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
}

async function sendFromHome(window, { marker, prompt, reply }) {
  const home = window.getByTestId('page-home');
  await home.getByTestId('home-composer-editor').fill(`[${marker}] ${prompt}`);
  await home.getByTestId('home-send-button').click();
  await expect(window.getByTestId('home-composer-error')).toHaveCount(0);

  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(reply).first()).toBeVisible({
    timeout: 120_000,
  });
  expect(await window.locator('body').innerText()).not.toContain(REFUSAL_COPY);
}

test('a credits-only guest sends on the DeepSeek V4 Pro default, then again after New task, and main accepted every model change', async () => {
  test.setTimeout(360_000);
  for (const { marker, reply } of TURNS) {
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
    });
  }
  let fixture;
  try {
    fixture = await launchCreditsOnlyGuest('canopy-can5022-deepseek-');
    const { app, electronApp, window } = fixture;
    await app.openHomeForProject(WORKSPACE_ID);

    // The seed settles once the auth probes and credits read land.
    await expect(homeModelChip(window)).toHaveText(DEEPSEEK_LABEL, {
      timeout: 30_000,
    });
    await expect(window.getByTestId('chat-model-menu')).toHaveCount(0);

    await sendFromHome(window, TURNS[0]);

    // New task resets Home to the same default, and it must still run.
    await app.openHomeForProject(WORKSPACE_ID);
    await expect(homeModelChip(window)).toHaveText(DEEPSEEK_LABEL, {
      timeout: 30_000,
    });
    // The picker was never opened.
    await expect(window.getByTestId('chat-model-menu')).toHaveCount(0);

    await sendFromHome(window, TURNS[1]);

    // Both turns rode the credits gateway's OpenAI-compatible leg.
    for (const { marker } of TURNS) {
      await expect
        .poll(
          async () => {
            const { activity } = await getScenarioActivity(
              DEFAULT_MOCK_BASE_URL,
              marker,
            );
            return activity?.['llmProxy:openai'] ?? 0;
          },
          {
            timeout: 30_000,
            message: `credits gateway activity for ${marker}`,
          },
        )
        .toBeGreaterThanOrEqual(1);
    }

    // The acceptance criterion: the model the renderer chose is the model
    // main accepted, and main refused nothing.
    const changes = await electronApp.evaluate(
      () => globalThis.can5022ModelChanges,
    );
    const summary = JSON.stringify(changes);
    expect(
      changes.some(
        ({ request, result }) =>
          request?.model === DEEPSEEK_MODEL && result === true,
      ),
      `main accepted ${DEEPSEEK_MODEL}: ${summary}`,
    ).toBe(true);
    expect(
      changes.every(({ result }) => result === true),
      `main accepted every model change: ${summary}`,
    ).toBe(true);
  } finally {
    await fixture?.close();
    for (const { marker } of TURNS) {
      await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => {});
    }
  }
});

test('the guest availability cue meets AA contrast in light and dark', async () => {
  test.setTimeout(240_000);
  let fixture;
  try {
    fixture = await launchCreditsOnlyGuest('canopy-can5022-contrast-');
    const { app, electronApp, window } = fixture;
    await app.openHomeForProject(WORKSPACE_ID);
    await expect(homeModelChip(window)).toHaveText(DEEPSEEK_LABEL, {
      timeout: 30_000,
    });

    for (const mode of ['light', 'dark']) {
      // The same theme drive floating-menus.spec.mjs uses: the app follows
      // the system theme, and the class pins it even if a stored app
      // preference would otherwise win.
      await electronApp.evaluate(({ nativeTheme }, themeSource) => {
        nativeTheme.themeSource = themeSource;
      }, mode);
      await window.emulateMedia({ colorScheme: mode });
      await window.evaluate((dark) => {
        document.documentElement.classList.toggle('dark', dark);
      }, mode === 'dark');
      await expect
        .poll(() =>
          window.evaluate(() =>
            document.documentElement.classList.contains('dark'),
          ),
        )
        .toBe(mode === 'dark');

      await homeModelChip(window).click();
      const row = await revealModelRow(window, DEEPSEEK_MODEL);
      const tag = row.getByTestId(
        `chat-model-option-available-${DEEPSEEK_MODEL}`,
      );
      await expect(row).toHaveAttribute('data-available', 'true');
      await expect(tag).toHaveText('Available');

      // DeepSeek is the selected model, so its row keeps the highlighted
      // fill even with the pointer away; before the fix this measured 3.7:1
      // in dark.
      await window.mouse.move(0, 0);
      await expect
        .poll(() => tag.evaluate(textContrastRatio), {
          message: `AI Credits tag contrast at rest in ${mode}`,
        })
        .toBeGreaterThanOrEqual(4.5);

      // The hovered row is the case that failed (3.69:1 in dark). Polling
      // lets the row's background transition settle.
      await row.hover();
      await expect
        .poll(() => tag.evaluate(textContrastRatio), {
          message: `AI Credits tag contrast on a hovered row in ${mode}`,
        })
        .toBeGreaterThanOrEqual(4.5);

      await row.focus();
      await expect
        .poll(() => tag.evaluate(textContrastRatio), {
          message: `Available cue at focus in ${mode}`,
        })
        .toBeGreaterThanOrEqual(4.5);
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('chat-model-menu')).toHaveCount(0);
    }
  } finally {
    await fixture?.close();
  }
});
