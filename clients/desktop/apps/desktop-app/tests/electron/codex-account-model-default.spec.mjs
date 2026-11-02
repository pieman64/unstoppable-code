// CAN-4716: a new chat's Codex default is a model the signed-in ChatGPT
// account can run. A free account's `model/list` omits the configured default,
// so the composer seeds the first catalog model the account lists instead; a
// paid account that lists it keeps it. The saved setting never changes.
//
// The E2E Codex catalog is pinned separately from production, so the lists
// are built from the E2E ids the Auto routing spec uses rather than from
// production defaults. Mock providers only, no network.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  connectMockCloudAccount,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CONFIGURED_MODEL = 'gpt-5.6-sol';

function seedCodexDefault(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify({
      version: 1,
      preferences: {
        defaultWorktreeProvider: 'codex',
        defaultWorktreeModelByProvider: {
          claude: { model: 'sonnet', thinkingLevel: 'high' },
          codex: { model: CONFIGURED_MODEL, thinkingLevel: 'high' },
        },
      },
    })}\n`,
  );
}

function readActiveTabModel(window) {
  return window.evaluate(
    async ({ projectId, worktreeId }) => {
      const { tabsFile } = await window.api.chat.getState({
        projectId,
        worktreeId,
      });
      return (
        tabsFile.tabs.find((tab) => tab.id === tabsFile.activeTabId)?.model ??
        null
      );
    },
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
}

async function launchWithAccountModels(scenarioKey, codexAccountModels) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-account-default-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCodexDefault(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    authUsage: { scenario: 'authed-low-usage' },
    codexAccountModels,
  });
  const launched = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: scenarioKey },
  });
  return { ...launched, userDataDir };
}

async function openNewChat(window, scenarioKey) {
  await connectMockCloudAccount(window, scenarioKey);
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await window.getByTestId('panel-add-tab-group-chat').click();
  await window.getByTestId('panel-add-menu-item-new-chat').click();
}

async function sendAndReadModel(window, scenarioKey, marker) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: 'Done on the eligible model.', stopReason: 'end_turn' }],
    },
  });
  const panel = window.getByTestId('panel-content-chat');
  await panel.getByRole('textbox').first().fill(`[${marker}] First turn.`);
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText('Done on the eligible model.')).toBeVisible({
    timeout: 60_000,
  });
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker);
  return Object.keys(activity)
    .filter((key) => key.startsWith('llmModel:'))
    .map((key) => key.slice('llmModel:'.length));
}

test('a free account defaults to a Codex model it can run', async () => {
  test.setTimeout(180_000);
  const scenarioKey = 'csk_codex_account_default_free_e2e';
  // A free ChatGPT account: everything but the configured default.
  const accountModels = ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
  const { electronApp, userDataDir } = await launchWithAccountModels(
    scenarioKey,
    accountModels,
  );
  try {
    const window = await electronApp.firstWindow();
    await openNewChat(window, scenarioKey);

    await expect
      .poll(() => readActiveTabModel(window), { timeout: 30_000 })
      .not.toBe(CONFIGURED_MODEL);
    const seeded = await readActiveTabModel(window);
    expect(accountModels).toContain(seeded);

    const used = await sendAndReadModel(
      window,
      scenarioKey,
      'Canopy-CCODEXACCOUNTFREE',
    );
    expect(used).toContain(seeded);
    expect(used).not.toContain(CONFIGURED_MODEL);

    // The saved setting itself never changes.
    const saved = JSON.parse(
      readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
    );
    expect(saved.preferences.defaultWorktreeModelByProvider.codex.model).toBe(
      CONFIGURED_MODEL,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a paid account keeps the configured Codex default', async () => {
  test.setTimeout(180_000);
  const scenarioKey = 'csk_codex_account_default_paid_e2e';
  const { electronApp, userDataDir } = await launchWithAccountModels(
    scenarioKey,
    [CONFIGURED_MODEL, 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  );
  try {
    const window = await electronApp.firstWindow();
    await openNewChat(window, scenarioKey);

    await expect
      .poll(() => readActiveTabModel(window), { timeout: 30_000 })
      .toBe(CONFIGURED_MODEL);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
