/**
 * Per-turn Auto model routing — desktop composer coverage.
 *
 * Auto is a SELECTION MODE offered by the shared model picker, not a catalog
 * row. These specs walk the real Home (New Task) composer flow: open the
 * picker, read the Auto row, select it, and confirm the trigger, the harness
 * chip, the real send path, and the return-to-manual path all behave.
 *
 * Determinism: the bundled mock cloud server advertises `model-routing-v1` and
 * an eligible AI Credits balance, and the E2E build has no LaunchDarkly, so
 * `canopy-shared-auto-model-routing` resolves to its LaunchDarkly-disabled
 * default (`true`). The send assertion uses the deterministic mock routing
 * endpoint and bundled mock provider surface; no live agent or network runs.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  CHATS_SECTION_CODE_WORKSPACE_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
  DEFAULT_MOCK_BASE_URL,
  connectMockCloudAccount,
  getScenarioActivity,
  registerScenario,
  seedChatsSectionFixture,
} from './seeders/index.mjs';
import {
  closeModelPicker,
  offeredBillingMenus,
  openModelPicker,
  openSelectedModelBillingMenu,
} from './modelPickerBilling.mjs';

const AUTO_DESCRIPTION = 'Picks the best model for you';
// What a ChatGPT sign-in's Codex `model/list` returns: no GPT 6 Sol or Luna and
// no Spark, even though all three are in the package's Codex catalog.
const CODEX_ACCOUNT_MODELS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
];
// The composer chip reads plain `Auto`; the routed model lives on each turn.
const AUTO_CHIP_TEXT = /^\s*Auto\s*$/;
const SEND_MARKER = 'Canopy-CAUTOROUTESEND';
const SEND_REPLY = 'Auto routing reached the deterministic provider';
const CODE_WORKTREE_ID = 'feature-01';

async function scenarioActivity(key) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key);
  return activity;
}

async function waitForActivity(key, field, count) {
  await expect
    .poll(async () => (await scenarioActivity(key))[field] ?? 0)
    .toBe(count);
}

async function readCodeAutoTab(window) {
  return window.evaluate(
    async ({ projectId, worktreeId }) => {
      const state = await window.api.chat.getState({ projectId, worktreeId });
      return (
        state.tabsFile.tabs.find((tab) => tab.modelSelectionMode === 'auto') ??
        null
      );
    },
    {
      projectId: CHATS_SECTION_CODE_WORKSPACE_ID,
      worktreeId: CODE_WORKTREE_ID,
    },
  );
}

async function sendPanelMessage(panel, text) {
  const composer = panel.getByRole('textbox').first();
  await composer.fill(text);
  await panel.getByRole('button', { name: 'Send message' }).click();
}

async function selectCodeWorktree(home, window) {
  await home.getByTestId('home-branch-picker-button').click();
  await window
    .getByTestId(`home-branch-picker-worktree-${CODE_WORKTREE_ID}`)
    .click();
}

async function setAutoRoutingFlag(electronApp, window, enabled) {
  await electronApp.evaluate((value) => {
    const current = JSON.parse(
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}',
    );
    process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify({
      ...current,
      'canopy-shared-auto-model-routing': value,
    });
  }, enabled);
  await window.evaluate(() => window.api.featureFlags.refreshContext());
}

/**
 * A CODE workspace, not the catch-all cowork one: the separate harness chip is
 * cowork-suppressed already, so asserting Auto hides it would be vacuous there.
 */
async function launchWithCodeWorkspace(
  scenarioKey,
  scenario = { authUsage: { scenario: 'authed-low-usage' } },
) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-auto-model-routing-'),
  );
  seedChatsSectionFixture(userDataDir, {
    worktreeCount: 1,
    chatEntryCount: 1,
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, scenario);
  const launched = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: scenarioKey },
  });
  return { ...launched, apiKey: scenarioKey };
}

test('Home composer offers Auto, and selecting it takes over the model chip', async () => {
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    'csk_auto_model_routing_home_e2e',
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);

    const trigger = home.getByTestId('chat-model-picker');
    await expect(trigger).toBeVisible();
    const manualLabel = (await trigger.innerText()).trim();
    expect(manualLabel).not.toContain('Auto');

    await trigger.click();
    const autoRow = window.getByTestId('chat-model-option-auto');
    await expect(autoRow).toBeVisible();
    // Auto is the search row's toggle; the shared description, so desktop
    // and the portal read identically, is its tooltip.
    await autoRow.hover();
    await expect(window.getByRole('tooltip')).toContainText(
      new RegExp(AUTO_DESCRIPTION, 'i'),
    );
    // Nothing is routed until the user opts in.
    await expect(autoRow).toHaveAttribute('aria-pressed', 'false');

    await autoRow.click();

    // Before the first routed turn the chip reads plain `Auto` — it must not
    // claim a concrete selection Jev has not made yet.
    await expect(trigger).toHaveText(/Auto/);
    await expect(trigger).not.toHaveText(/·/);

    await trigger.click();
    await expect(window.getByTestId('chat-model-option-auto')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('one Send resolves Auto exactly once before provider dispatch', async () => {
  test.setTimeout(120_000);
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    'csk_auto_model_routing_send_e2e',
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);

    await registerScenario(DEFAULT_MOCK_BASE_URL, SEND_MARKER, {
      llm: {
        steps: [{ text: SEND_REPLY, stopReason: 'end_turn' }],
      },
    });

    await home.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-option-auto').click();
    await home
      .getByTestId('home-composer-editor')
      .fill(
        `[${SEND_MARKER}] Route this message once, then start the provider turn.`,
      );
    await home.getByTestId('home-send-button').click();

    await expect(window.getByTestId('panel-content-chat')).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          apiKey,
        );
        return activity.modelRoutingResolve ?? 0;
      })
      .toBe(1);
    await expect
      .poll(async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          SEND_MARKER,
        );
        return activity.llmRequests ?? 0;
      })
      .toBeGreaterThan(0);
    await expect(window.getByText(SEND_REPLY).first()).toBeVisible();
    await expect(
      window.getByTestId('panel-content-chat').getByTestId('chat-model-picker'),
    ).toHaveText(AUTO_CHIP_TEXT);
    await expect
      .poll(async () => {
        const activity = await scenarioActivity(SEND_MARKER);
        return Object.keys(activity).some((key) => key.startsWith('llmProxy:'));
      })
      .toBe(false);
    await waitForActivity(apiKey, 'modelRoutingLane:provider_subscription', 1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Cowork Home carries Auto onto the created chat before first send', async () => {
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    'csk_auto_model_routing_cowork_home_e2e',
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_NAMED_COWORK_ID);
    await home.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-option-auto').click();
    await home
      .getByTestId('home-composer-editor')
      .fill('Route this Cowork New Task');
    await home.getByTestId('home-send-button').click();

    await waitForActivity(apiKey, 'modelRoutingResolve', 1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Auto reroutes an existing Claude chat, keeps its harness, and survives restart', async () => {
  test.setTimeout(180_000);
  const scenarioKey = 'csk_auto_model_routing_reroute_e2e';
  const marker = 'Canopy-CAUTOROUTEREROUTE';
  const firstReply = 'The Opus-routed turn completed.';
  const secondReply = 'The Sonnet-routed turn completed.';
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    authUsage: { scenario: 'authed-low-usage' },
    cloud: {
      modelRouting: {
        responses: [
          { selectedModelId: 'anthropic/claude-opus-5' },
          { selectedModelId: 'anthropic/claude-sonnet-5' },
        ],
      },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        { text: firstReply, stopReason: 'end_turn' },
        { text: secondReply, stopReason: 'end_turn' },
      ],
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-auto-model-routing-reroute-'),
  );
  seedChatsSectionFixture(userDataDir, {
    worktreeCount: 1,
    chatEntryCount: 1,
  });
  let launched = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: scenarioKey },
  });
  try {
    let window = await launched.electronApp.firstWindow();
    await connectMockCloudAccount(window, scenarioKey);
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);
    await selectCodeWorktree(home, window);
    await home.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-option-auto').click();
    await home
      .getByTestId('home-composer-editor')
      .fill(`[${marker}] Start this chat on Opus.`);
    await home.getByTestId('home-send-button').click();

    let panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByText(firstReply).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(async () => {
        const tab = await readCodeAutoTab(window);
        return { model: tab?.model, provider: tab?.providerType };
      })
      .toEqual({ model: 'claude-opus-5', provider: 'claude' });

    await sendPanelMessage(panel, `[${marker}] Route this follow-up again.`);
    await expect(panel.getByText(secondReply).first()).toBeVisible({
      timeout: 60_000,
    });
    await waitForActivity(
      scenarioKey,
      'modelRoutingSelected:anthropic/claude-sonnet-5',
      1,
    );
    await waitForActivity(scenarioKey, 'modelRoutingResolve', 2);
    await waitForActivity(scenarioKey, 'modelRoutingCapturedHarness:claude', 1);

    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = await launchCanopy({
      userDataDir,
      env: { CANOPY_MOCK_API_KEY: scenarioKey },
    });
    window = await launched.electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(CODE_WORKTREE_ID);
    panel = window.getByTestId('panel-content-chat');
    // The chip names the mode only; each turn's footer names the model Auto
    // picked for it, and that history survives a restart.
    await expect(panel.getByTestId('chat-model-picker')).toHaveText(
      AUTO_CHIP_TEXT,
    );
    const turnModels = panel.getByTestId('turn-auto-model');
    await expect(turnModels).toHaveCount(2);
    await expect(turnModels.nth(0)).toHaveText(/Opus/);
    await expect(turnModels.nth(1)).toHaveText(/Sonnet 5/);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('Auto New Task can choose Codex', async () => {
  test.setTimeout(120_000);
  const scenarioKey = 'csk_auto_model_routing_codex_e2e';
  const marker = 'Canopy-CAUTOROUTECODEX';
  const reply = 'The Codex-routed Auto turn completed.';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-auto-model-routing-codex-'),
  );
  seedChatsSectionFixture(userDataDir, {
    worktreeCount: 1,
    chatEntryCount: 0,
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    authUsage: { scenario: 'authed-low-usage' },
    codexAccountModels: CODEX_ACCOUNT_MODELS,
    cloud: {
      modelRouting: {
        responses: [{ selectedModelId: 'openai/gpt-5.6-luna' }],
      },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: scenarioKey },
  });
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, scenarioKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);
    await selectCodeWorktree(home, window);
    await home.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-option-auto').click();
    await home
      .getByTestId('home-composer-editor')
      .fill(`[${marker}] Choose the Codex harness.`);
    await home.getByTestId('home-send-button').click();

    await expect(window.getByText(reply).first()).toBeVisible({
      timeout: 60_000,
    });
    await waitForActivity(
      scenarioKey,
      'modelRoutingSelected:openai/gpt-5.6-luna',
      1,
    );
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByTestId('turn-auto-model')).toHaveText(
      'GPT 5.6 Luna',
    );
    await expect(panel.getByTestId('chat-model-picker')).toHaveText(
      AUTO_CHIP_TEXT,
    );
    // Auto offers only the Codex models the signed-in account lists; the
    // rest would be rejected by the sign-in and run only on AI Credits.
    const activity = await scenarioActivity(scenarioKey);
    const offeredCodexModels = Object.keys(activity)
      .filter((key) => key.startsWith('modelRoutingCandidate:'))
      .map((key) => key.slice('modelRoutingCandidate:'.length))
      .filter((id) => id.startsWith('openai/') || id.startsWith('gpt-'))
      .map((id) => id.replace(/^openai\//, ''));
    expect(offeredCodexModels).toContain('gpt-5.6-luna');
    expect(
      offeredCodexModels.filter((id) => !CODEX_ACCOUNT_MODELS.includes(id)),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('AI Credits Auto uses one routing charge and one separate Gateway execution while locking the ongoing lane', async () => {
  test.setTimeout(180_000);
  const scenarioKey = 'csk_auto_model_routing_credits_e2e';
  const marker = 'Canopy-CAUTOROUTECREDITS';
  const reply = 'The AI Credits Auto turn completed.';
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    authUsage: { scenario: 'authed-low-usage' },
    cloud: {
      modelRouting: {
        responses: [{ selectedModelId: 'anthropic/claude-sonnet-5' }],
      },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-auto-model-routing-credits-'),
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: scenarioKey },
  });
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, scenarioKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openChatPage();
    await window.getByTestId('empty-new-chat').click();
    const panel = window.getByTestId('panel-content-chat').first();
    // Billing is the chat's, set from a model's own menu; Auto follows it.
    const billing = await openSelectedModelBillingMenu(window);
    await expect(billing.subscription).toHaveAttribute('aria-checked', 'true');
    await billing.credits.click();
    await expect(billing.credits).toHaveAttribute('aria-checked', 'true');
    await closeModelPicker(window);
    await panel.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-option-auto').click();

    await sendPanelMessage(panel, `[${marker}] Route through AI Credits.`);
    await expect(panel.getByText(reply).first()).toBeVisible({
      timeout: 60_000,
    });
    await waitForActivity(scenarioKey, 'modelRoutingResolve', 1);
    await waitForActivity(scenarioKey, 'modelRoutingLane:ai_credits', 1);
    await expect
      .poll(
        async () => (await scenarioActivity(marker))['llmProxy:anthropic'] ?? 0,
      )
      .toBeGreaterThanOrEqual(1);

    // Billing locks once the chat has run: no row offers a billing menu.
    await openModelPicker(window);
    await expect(offeredBillingMenus(window)).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Auto fallback dispatches exactly one provider turn', async () => {
  test.setTimeout(120_000);
  const scenarioKey = 'csk_auto_model_routing_fallback_e2e';
  const marker = 'Canopy-CAUTOROUTEFALLBACK';
  const reply = 'The fallback provider turn completed.';
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    authUsage: { scenario: 'authed-low-usage' },
    cloud: {
      modelRouting: {
        responses: [{ fallbackReason: 'timeout' }],
      },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    scenarioKey,
    {
      authUsage: { scenario: 'authed-low-usage' },
      cloud: {
        modelRouting: {
          responses: [{ fallbackReason: 'timeout' }],
        },
      },
    },
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);
    await selectCodeWorktree(home, window);
    await home.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-option-auto').click();
    await home
      .getByTestId('home-composer-editor')
      .fill(`[${marker}] Exercise the fallback path.`);
    await home.getByTestId('home-send-button').click();
    const panel = window.getByTestId('panel-content-chat').first();
    await expect(panel.getByText(reply)).toHaveCount(1, {
      timeout: 60_000,
    });
    await waitForActivity(scenarioKey, 'modelRoutingResolve', 1);
    await waitForActivity(scenarioKey, 'modelRoutingFallback:timeout', 1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Stop during Choosing a model launches no provider turn', async () => {
  test.setTimeout(120_000);
  const scenarioKey = 'csk_auto_model_routing_stop_e2e';
  const marker = 'Canopy-CAUTOROUTESTOP';
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    authUsage: { scenario: 'authed-low-usage' },
    cloud: {
      modelRouting: {
        delayMs: 2_000,
        responses: [{ selectedModelId: 'anthropic/claude-sonnet-5' }],
      },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: 'This must never render.', stopReason: 'end_turn' }],
    },
  });
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    scenarioKey,
    {
      authUsage: { scenario: 'authed-low-usage' },
      cloud: {
        modelRouting: {
          delayMs: 2_000,
          responses: [{ selectedModelId: 'anthropic/claude-sonnet-5' }],
        },
      },
    },
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);
    await selectCodeWorktree(home, window);
    await home.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-option-auto').click();
    await home
      .getByTestId('home-composer-editor')
      .fill(`[${marker}] Stop this routing request.`);
    await home.getByTestId('home-send-button').click();
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByText('Choosing a model…')).toBeVisible();
    await panel.getByTestId('chat-stop-generation').click();
    await expect
      .poll(async () => (await scenarioActivity(marker)).llmRequests ?? 0, {
        timeout: 4_000,
      })
      .toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('live rollout disable checks replay and returns an idle Auto chat to manual', async () => {
  const scenarioKey = 'csk_auto_model_routing_disable_e2e';
  const marker = 'Canopy-CAUTOROUTEDISABLE';
  const reply = 'The manual turn after rollout disable completed.';
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    authUsage: { scenario: 'authed-low-usage' },
    cloud: {
      modelRouting: {
        responses: [{ fallbackReason: 'policy_blocked' }],
      },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    scenarioKey,
    {
      authUsage: { scenario: 'authed-low-usage' },
      cloud: {
        modelRouting: {
          responses: [{ fallbackReason: 'policy_blocked' }],
        },
      },
    },
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);
    await home.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-option-auto').click();
    await setAutoRoutingFlag(electronApp, window, false);
    await home.getByTestId('chat-model-picker').click();
    await expect(window.getByTestId('chat-model-option-auto')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await home
      .getByTestId('home-composer-editor')
      .fill(`[${marker}] Send after rollout disable.`);
    await home.getByTestId('home-send-button').click();
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByText(reply).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(panel.getByTestId('chat-model-picker')).not.toContainText(
      'Auto',
    );
    await waitForActivity(scenarioKey, 'modelRoutingResolve', 1);
    await waitForActivity(
      scenarioKey,
      'modelRoutingFallback:policy_blocked',
      1,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('queued Auto messages route independently when dequeued', async () => {
  test.setTimeout(180_000);
  const scenarioKey = 'csk_auto_model_routing_queue_e2e';
  const marker = 'Canopy-CAUTOROUTEQUEUE';
  const firstReply = 'The first queued-routing turn completed slowly.';
  const secondReply = 'The dequeued Auto turn completed.';
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    authUsage: { scenario: 'authed-low-usage' },
    cloud: {
      modelRouting: {
        responses: [
          { selectedModelId: 'anthropic/claude-opus-5' },
          { selectedModelId: 'anthropic/claude-haiku-4.5' },
        ],
      },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          text: firstReply,
          stopReason: 'end_turn',
          streamMs: 2_000,
          chunkChars: 8,
        },
        { text: secondReply, stopReason: 'end_turn' },
      ],
    },
  });
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    scenarioKey,
    {
      authUsage: { scenario: 'authed-low-usage' },
      cloud: {
        modelRouting: {
          responses: [
            { selectedModelId: 'anthropic/claude-opus-5' },
            { selectedModelId: 'anthropic/claude-haiku-4.5' },
          ],
        },
      },
    },
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);
    await selectCodeWorktree(home, window);
    await home.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-option-auto').click();
    await home
      .getByTestId('home-composer-editor')
      .fill(`[${marker}] Start the slow turn.`);
    await home.getByTestId('home-send-button').click();
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByTestId('chat-stop-generation')).toBeVisible();
    const composer = panel.getByRole('textbox').first();
    await composer.fill(`[${marker}] Queue this follow-up.`);
    await composer.press('Enter');
    await expect(window.getByTestId('queued-message-bubble')).toContainText(
      'Queue this follow-up',
    );
    await expect(panel.getByText(secondReply).first()).toBeVisible({
      timeout: 90_000,
    });
    await waitForActivity(scenarioKey, 'modelRoutingResolve', 2);
    await waitForActivity(
      scenarioKey,
      'modelRoutingSelected:anthropic/claude-opus-5',
      1,
    );
    await waitForActivity(
      scenarioKey,
      'modelRoutingSelected:anthropic/claude-haiku-4.5',
      1,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('picking a concrete model returns the Home composer to manual', async () => {
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    'csk_auto_model_routing_manual_e2e',
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);

    const trigger = home.getByTestId('chat-model-picker');
    await trigger.click();
    await window.getByTestId('chat-model-option-auto').click();
    await expect(trigger).toHaveText(/Auto/);

    // Any concrete pick is the exit from Auto — no separate "turn Auto off".
    await trigger.click();
    const menu = window.getByTestId('chat-model-menu');
    // Model rows carry `data-model-id`; the harness rail tabs are radios too,
    // so a bare `menuitemradio` locator would switch tabs instead of models.
    const concrete = menu.locator(
      '[data-model-id]:visible:not([disabled]):not([aria-disabled="true"])',
    );
    await concrete.first().click();

    await expect(trigger).not.toHaveText(/Auto/);
    await trigger.click();
    await expect(window.getByTestId('chat-model-option-auto')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Auto sits at the end of the search row', async () => {
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    'csk_auto_model_routing_menu_layout_e2e',
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);

    await home.getByTestId('chat-model-picker').click();
    const menu = window.getByTestId('chat-model-menu');
    const autoRow = window.getByTestId('chat-model-option-auto');
    await expect(autoRow).toBeVisible();
    const autoIcon = window.getByTestId('chat-model-option-auto-icon');
    await expect(autoIcon).toBeVisible();
    // Auto's glyph matches the search icon beside it: a 14px box, laid out,
    // not snapped to the Lucide tiers. Read once the menu stops scaling in.
    await expect
      .poll(() =>
        autoIcon.evaluate((icon) => {
          const { width, height } = icon.getBoundingClientRect();
          return `${Math.round(width * 10) / 10}x${Math.round(height * 10) / 10}`;
        }),
      )
      .toBe('14x14');
    // A toggle beside the search field, not a row leading the list.
    expect(
      await autoRow.evaluate(
        (toggle) =>
          toggle
            .closest('.h-9')
            ?.querySelector('[data-testid="chat-model-search"]') != null,
      ),
    ).toBe(true);
    await expect(window.getByTestId('chat-model-auto-divider')).toHaveCount(0);
    await expect(menu).toBeVisible();

    await autoRow.click();
    await expect(
      home.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-selection-mode', 'auto');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Auto without AI Credits opens billing instead of doing nothing', async () => {
  const scenarioKey = 'csk_auto_model_routing_no_credits_e2e';
  const { apiKey, electronApp, userDataDir } = await launchWithCodeWorkspace(
    scenarioKey,
    {
      authUsage: { scenario: 'authed-low-usage' },
      cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
    },
  );
  try {
    const window = await electronApp.firstWindow();
    await connectMockCloudAccount(window, apiKey);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(CHATS_SECTION_CODE_WORKSPACE_ID);

    const trigger = home.getByTestId('chat-model-picker');
    const manualLabel = (await trigger.innerText()).trim();
    await trigger.click();
    const autoRow = window.getByTestId('chat-model-option-auto');
    // Still clickable, with the remedy in its tooltip.
    await expect(autoRow).toBeEnabled();
    await expect(autoRow).toHaveAttribute('aria-pressed', 'false');
    await autoRow.hover();
    await expect(window.getByRole('tooltip')).toContainText(
      'Add AI Credits to use this',
    );

    await autoRow.click();
    await waitForActivity(scenarioKey, 'authLinkMint:/account/billing', 1);
    // Opening billing is not an opt-in: the chat stays manual.
    await expect(window.getByTestId('chat-model-menu')).toHaveCount(0);
    await expect(trigger).toHaveText(manualLabel);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
