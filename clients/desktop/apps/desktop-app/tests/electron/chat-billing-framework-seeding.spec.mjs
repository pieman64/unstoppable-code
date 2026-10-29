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
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import {
  closeModelPicker,
  openSelectedModelBillingMenu,
} from './modelPickerBilling.mjs';
import {
  CHAT_EFFORT_TRIGGER_TEST_ID,
  closeEffortPanel,
  openEffortSlider,
  stepEffortAway,
} from './effortPanel.mjs';

// Billing-framework choice is remembered and seeds new chats/trees (CAN-838
// follow-up, plan Part 1).
//
// The reported bug: turning the "Use AI Credits" toggle OFF was per-tab only,
// so every new chat/tree re-defaulted ON. The fix records the last explicit
// picker choice and seeds new chats/trees from it. This spec proves the seam
// the renderer jest suite mocks: flipping the toggle in one chat updates the
// live model-defaults, and a new chat tab AND a freshly created worktree both
// inherit that choice in the SAME session (no restart), through the real
// provider-availability + preferences seam.
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'billing-framework-seeding-chat';
// Any `csk_`-prefixed key authenticates against the shared cloud mock and
// serves an eligible balance, so the resolver sees AI Credits as available and
// (with the E2E default native login present) the toggle is interactive.
const TEST_CLOUD_API_KEY = 'csk_billing_framework_seeding_e2e';
const MODEL_REGISTRY_UPDATED_CHANNEL = 'model-registry:updated';

async function injectCreditsDefaultRegistry(electronApp, options = {}) {
  const { nativeThinkingLevels = [], gatewayThinkingLevels = [] } = options;
  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, nativeLevels, gatewayLevels }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No BrowserWindow available');
      window.webContents.send(channel, {
        claude: [{ id: 'opus[1m]', label: 'Opus' }],
        codex: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
        ollama: [],
        agents: [],
        aliases: {},
        aiGatewayModels: [
          {
            id: 'deepseek-v4-pro',
            label: 'DeepSeek V4 Pro',
            recommendedHarness: 'codex',
            contextWindow: 1_000_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: nativeLevels,
            toolSchemaProfile: 'standard',
          },
        ],
        gatewayRoutes: [
          {
            modelId: 'deepseek-v4-pro',
            gatewayId: 'deepseek/deepseek-v4-pro',
            family: 'deepseek',
            recommendedHarness: 'codex',
            gatewayOnly: true,
            contextWindow: 1_000_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: gatewayLevels,
            toolSchemaProfile: 'standard',
          },
        ],
      });
    },
    {
      channel: MODEL_REGISTRY_UPDATED_CHANNEL,
      nativeLevels: nativeThinkingLevels,
      gatewayLevels: gatewayThinkingLevels,
    },
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Open the active chat's model picker and the selected model's billing menu.
 * Inactive chat-tab panels stay mounted in the DOM, so the picker is scoped to
 * the visible one rather than the (multi-match) `panel-content-chat` testid.
 */
async function openBillingMenu(window) {
  const modelPicker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await expect(modelPicker).toBeVisible({ timeout: 30_000 });
  return openSelectedModelBillingMenu(window);
}

/** Close the open model-picker dropdown. */
async function closePicker(window) {
  await closeModelPicker(window);
}

test('remembers the billing choice and seeds a new chat tab and a new worktree in the same session', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-billing-framework-seeding-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [{ id: CHAT_ID, title: 'Billing Framework Seeding' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });

    // Connect the mock cloud account so AI Credits are an available framework.
    await connectMockCloudAccount(window, TEST_CLOUD_API_KEY);

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    // A fresh chat starts on subscription billing.
    const billing = await openBillingMenu(window);
    await expect(billing.subscription).toHaveAttribute('aria-checked', 'true');

    // Choose AI Credits from the model's menu. This is the explicit choice
    // that must be remembered.
    await billing.credits.click();
    await expect(billing.credits).toHaveAttribute('aria-checked', 'true');
    await closePicker(window);

    // A new chat tab created in the same session inherits the remembered ON
    // choice (previously it re-defaulted to the global routing mode).
    // The `+` creates the chat directly now — no menu step.
    await window.getByTestId('panel-add-tab-group-chat').click();

    const newChatBilling = await openBillingMenu(window);
    await expect(newChatBilling.credits).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await closePicker(window);

    // A freshly created worktree's initial chat also inherits the choice.
    const workspaceHeader = window
      .getByRole('button', {
        name: new RegExp(
          `^(?:Expand|Collapse) ${escapeRegExp(WORKSPACE_NAME)}$`,
        ),
      })
      .first();
    await expect(workspaceHeader).toBeVisible({ timeout: 15_000 });
    if (
      (await workspaceHeader.getAttribute('aria-label')) ===
      `Expand ${WORKSPACE_NAME}`
    ) {
      await workspaceHeader.click();
    }
    await workspaceHeader.hover();
    const createButton = window.getByRole('button', {
      name: `Create worktree for ${WORKSPACE_NAME}`,
    });
    await expect(createButton).toBeVisible();
    await createButton.click();

    // The old chat already displays the credits banner. Wait for the newly
    // created worktree's canonical starter tab and its model before using it.
    const selectedWorktree = window
      .locator('[data-sidebar-selected-item] [data-testid="worktree-row"]')
      .first();
    await expect(selectedWorktree).not.toHaveAttribute(
      'data-worktree-id',
      WORKTREE_ID,
    );
    const createdWorktreeId =
      await selectedWorktree.getAttribute('data-worktree-id');
    expect(createdWorktreeId).toBeTruthy();
    let createdChatId;
    await expect
      .poll(
        async () => {
          const state = await window.evaluate(
            async (scope) => window.api.chat.getState(scope),
            { projectId: WORKSPACE_ID, worktreeId: createdWorktreeId },
          );
          const tab = state.tabsFile.tabs.find(
            (tab) => tab.id === state.tabsFile.activeTabId,
          );
          createdChatId = tab?.id;
          return Boolean(tab?.model);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${createdChatId}`),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      window.getByTestId('chat-input-ai-credits-active'),
    ).toBeVisible({ timeout: 30_000 });
    const worktreeBilling = await openBillingMenu(window);
    await expect(worktreeBilling.credits).toHaveAttribute(
      'aria-checked',
      'true',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a credits-only user gets the gateway default and AI Credits billing on a new chat', async () => {
  const authKey = 'can-1929-credits-only-default';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-billing-lane-default-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Billing Lane Default' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'unauthenticated' },
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: authKey },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, TEST_CLOUD_API_KEY);

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await injectCreditsDefaultRegistry(electronApp);

    await window.getByTestId('panel-add-tab-group-chat').click();
    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await expect(picker).toContainText('DeepSeek V4 Pro', { timeout: 30_000 });
    await expect(
      picker.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'codex');

    // A credits-only model always bills to AI Credits: its row says so and
    // offers no billing choice.
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-all').click();
    await expect(
      window.locator(
        '[data-testid="chat-model-row-credits-deepseek-v4-pro"]:visible',
      ),
    ).toHaveText('AI credits');
    // No row menu for it holds billing, whichever button opens it.
    await expect(
      window.locator(
        `[data-testid="chat-model-harness-control-deepseek-v4-pro"][data-billing-menu="true"], [data-testid="chat-model-billing-deepseek-v4-pro"]`,
      ),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(() => undefined);
  }
});

test('an AI-Credits-routed chat displays and cycles the gateway-advertised thinking levels', async () => {
  // CAN-2339 round-4 F3: `ChatInput` derives the composer's supported and
  // displayed thinking levels from the billing route the session executes on
  // (`isTabAiCreditsRouted` → `getEffectiveSupportedThinkingLevelsForModel`).
  // The registry below advertises DIFFERENT sets on the two routes — native
  // metadata says off/medium/high/xhigh while the gateway route says only
  // off/high — so the composer control proves which route it consulted: the
  // credits-routed chat's effort panel offers None and High (gateway set),
  // never the native four.
  const authKey = 'can-2339-credits-thinking-route';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-billing-thinking-route-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Credits Thinking Route' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'unauthenticated' },
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: authKey },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, TEST_CLOUD_API_KEY);

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await injectCreditsDefaultRegistry(electronApp, {
      nativeThinkingLevels: ['off', 'medium', 'high', 'xhigh'],
      gatewayThinkingLevels: ['off', 'high'],
    });

    // A credits-only user's new chat lands on the gateway-only default model,
    // which routes on AI Credits by construction.
    await window.getByTestId('panel-add-tab-group-chat').click();
    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await expect(picker).toContainText('DeepSeek V4 Pro', { timeout: 30_000 });

    const thinking = window
      .locator(`[data-testid="${CHAT_EFFORT_TRIGGER_TEST_ID}"]:visible`)
      .first();
    await expect(thinking).toBeVisible({ timeout: 15_000 });

    // Display: the shown level must already be one of the gateway-advertised
    // tiers, regardless of what the seed stored.
    const initial = await thinking.getAttribute('data-thinking-level');
    expect(['high', 'off']).toContain(initial);
    const other = initial === 'high' ? 'off' : 'high';
    const labelFor = { high: 'High', off: 'None' };

    // CAN-2540 §3: the control commits exactly the level it displays. Prove
    // the commit (not just the controlled render) through the main-owned
    // flush/load boundary. `persisted-tabs.ts` omits `thinkingLevel` when it
    // equals the 'high' default, so an absent field reads back as 'high'.
    const readCommittedThinkingLevel = async () => {
      return window.evaluate(
        async ({ projectId, worktreeId }) => {
          await window.api.chat.flushScope({ projectId, worktreeId });
          const file = await window.api.chat.loadTabs({
            projectId,
            worktreeId,
          });
          const tab = file.tabs.find((entry) => entry.id === file.activeTabId);
          if (!tab) return null;
          return tab.thinkingLevel ?? tab.modelConfig?.thinkingLevel ?? 'high';
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
    };

    // The effort panel offers the gateway set's two stops (None and High);
    // native metadata would offer four.
    const slider = await openEffortSlider(window, thinking);
    await expect(slider).toHaveAttribute('aria-valuemax', '1');
    await expect(slider).toHaveAttribute('aria-valuetext', labelFor[initial]);

    // Each move commits, and the displayed and committed levels agree.
    await stepEffortAway(slider);
    await expect(slider).toHaveAttribute('aria-valuetext', labelFor[other]);
    await expect(thinking).toHaveAttribute('data-thinking-level', other);
    await expect
      .poll(readCommittedThinkingLevel, { timeout: 10_000 })
      .toBe(other);
    await stepEffortAway(slider);
    await expect(thinking).toHaveAttribute('data-thinking-level', initial);
    await expect
      .poll(readCommittedThinkingLevel, { timeout: 10_000 })
      .toBe(initial);
    await closeEffortPanel(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(() => undefined);
  }
});
