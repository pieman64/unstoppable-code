// Regression: an upgrade-time partial preference migration must not normalize
// saved model ids before the package-backed model registries are initialized.
//
// Run after `pnpm run build:e2e`:
//   pnpm run test:electron:built preferences-model-defaults-upgrade.spec.mjs --reporter=line
//
// The fixture is a local pre-upgrade preferences file with the approval
// migration intentionally unmarked. No providers, network, or live agents are
// used.
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedModelDefaultsGatewayCatalog } from './seeders/seedUnavailableModelDefaults.mjs';

const SAVED_MODEL_PREFERENCES = {
  defaultChatProvider: 'codex',
  defaultChatModelByProvider: {
    claude: { model: 'sonnet', thinkingLevel: 'medium' },
    codex: { model: 'gpt-5.6-terra', thinkingLevel: 'xhigh' },
    ollama: { model: 'ollama-qwen3-coder', thinkingLevel: 'high' },
    aiCredits: null,
  },
  defaultWorktreeProvider: 'codex',
  defaultWorktreeModelByProvider: {
    claude: { model: 'sonnet', thinkingLevel: 'xhigh' },
    codex: { model: 'gpt-5.6-sol', thinkingLevel: 'ultra' },
    ollama: { model: 'ollama-qwen3-coder', thinkingLevel: 'high' },
    aiCredits: null,
  },
  summaryModel: 'gpt-5.6-terra',
  summaryThinkingLevel: 'medium',
  worktreeSummaryModel: 'gpt-5.6-sol',
  worktreeSummaryThinkingLevel: 'high',
  planDiagramModel: 'sonnet',
  planDiagramThinkingLevel: 'medium',
  codeReviewModel: 'gpt-5.6-terra',
  codeReviewThinkingLevel: 'high',
  prGenerationModel: 'gpt-5.6-sol',
  prGenerationThinkingLevel: 'ultra',
  commitGenerationModel: 'sonnet',
  commitGenerationThinkingLevel: 'medium',
  branchNamingModel: 'gpt-5.6-terra',
  branchNamingThinkingLevel: 'low',
  pipelineAdvisorModel: 'gpt-5.6-sol',
  pipelineAdvisorThinkingLevel: 'xhigh',
  appAdvisorModel: 'gpt-5.6-terra',
  appAdvisorThinkingLevel: 'medium',
  cronGenerationModel: 'sonnet',
  cronGenerationThinkingLevel: 'low',
  ifCommandGenerationModel: 'gpt-5.6-sol',
  ifCommandGenerationThinkingLevel: 'high',
  splitPrPlannerModel: 'gpt-5.6-terra',
  splitPrPlannerThinkingLevel: 'medium',
};

function seedPreUpgradePreferences(
  userDataDir,
  ollamaExecutable,
  modelPreferences = SAVED_MODEL_PREFERENCES,
) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          ...modelPreferences,
          approvalDefaults: {
            worktree: 'ask',
            cowork: 'ask',
            appAdvisor: 'ask',
          },
          ollamaExecutablePath: ollamaExecutable,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(userDataDir, 'ollama-model-cache.json'),
    `${JSON.stringify({
      version: 1,
      byPort: {
        11534: {
          refreshedAt: '2026-09-03T00:00:00.000Z',
          models: [
            {
              id: 'ollama-qwen3-coder',
              rawModelId: 'qwen3-coder',
              label: 'qwen3-coder',
              show: { capabilities: ['completion', 'tools'] },
            },
          ],
        },
      },
    })}\n`,
  );
}

function readPersistedPreferences(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences;
}

// The title is a `SettingsSection` heading (its section owns the provider
// rows) or a `SettingsRow` label (two wrappers below the row that owns the
// model controls).
function modelRow(chatTab, title) {
  const heading = chatTab.getByText(title, { exact: true });
  return title.startsWith('Default ')
    ? heading.locator('xpath=ancestor::section[1]')
    : heading.locator('../../..');
}

test('preserves saved model defaults while upgrading preferences', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-defaults-upgrade-'),
  );
  const ollamaExecutable = path.join(userDataDir, 'ollama');
  writeFileSync(ollamaExecutable, "#!/bin/sh\necho 'ollama version 0.14.0'\n");
  chmodSync(ollamaExecutable, 0o755);
  seedPreUpgradePreferences(userDataDir, ollamaExecutable);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    expect(readPersistedPreferences(userDataDir).approvalDefaults).toEqual({
      worktree: 'full-access',
      cowork: 'full-access',
      appAdvisor: 'full-access',
    });

    await app.openSettings();
    await app.openSettingsSection('chat');
    const chatTab = window.getByTestId('settings-tab-chat');

    const worktreeDefaults = modelRow(chatTab, 'Default code model');
    await expect(
      worktreeDefaults.getByTestId('chat-defaults-model-codex'),
    ).toHaveValue('gpt-5.6-sol');

    const standaloneDefaults = modelRow(chatTab, 'Default chat model');
    await expect(
      standaloneDefaults.getByTestId('chat-defaults-model-codex'),
    ).toHaveValue('gpt-5.6-terra');

    await expect(
      modelRow(chatTab, 'Plan parsing and diagrams model')
        .locator('select')
        .first(),
    ).toHaveValue('sonnet');

    expect(readPersistedPreferences(userDataDir)).toMatchObject({
      ...SAVED_MODEL_PREFERENCES,
      ollamaExecutablePath: ollamaExecutable,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('loads Settings with prototype-looking saved model IDs', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-defaults-prototype-'),
  );
  const savedPreferences = {
    ...SAVED_MODEL_PREFERENCES,
    defaultWorktreeModelByProvider: {
      ...SAVED_MODEL_PREFERENCES.defaultWorktreeModelByProvider,
      codex: { model: 'constructor', thinkingLevel: 'ultra' },
      aiCredits: { model: 'constructor', thinkingLevel: 'ultra' },
    },
    summaryModel: 'constructor',
    summaryThinkingLevel: 'ultra',
  };
  const ollamaExecutable = path.join(userDataDir, 'ollama');
  writeFileSync(ollamaExecutable, "#!/bin/sh\necho 'ollama version 0.14.0'\n");
  chmodSync(ollamaExecutable, 0o755);
  seedPreUpgradePreferences(userDataDir, ollamaExecutable, savedPreferences);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('chat');
    const chatTab = window.getByTestId('settings-tab-chat');
    await expect(
      modelRow(chatTab, 'Default code model').getByTestId(
        'chat-defaults-model-codex',
      ),
    ).toHaveValue('constructor');
    const creditsModel = modelRow(chatTab, 'Default code model').getByTestId(
      'chat-defaults-model-aiCredits',
    );
    await expect(creditsModel).toHaveValue('constructor');
    await expect(creditsModel.locator('option:checked')).toHaveText(
      /^constructor(?: \(unavailable\))?$/,
    );
    await expect(
      modelRow(chatTab, 'Chat title model').locator('select').first(),
    ).toHaveValue('constructor');
    await window.getByTestId('settings-auto-retry-transient-chats').click();
    await expect
      .poll(
        () =>
          readPersistedPreferences(userDataDir).autoRetryTransientErrorsChats,
      )
      .toBe(false);
    expect(readPersistedPreferences(userDataDir)).toMatchObject(
      savedPreferences,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('retains unavailable saved models across unrelated Settings saves and restart', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-defaults-unavailable-'),
  );
  const savedPreferences = {
    ...SAVED_MODEL_PREFERENCES,
    defaultChatModelByProvider: {
      ...SAVED_MODEL_PREFERENCES.defaultChatModelByProvider,
      codex: { model: 'gpt-future-cowork', thinkingLevel: 'xhigh' },
    },
    defaultWorktreeModelByProvider: {
      ...SAVED_MODEL_PREFERENCES.defaultWorktreeModelByProvider,
      codex: { model: 'gpt-future-code', thinkingLevel: 'ultra' },
      aiCredits: { model: 'gateway-retired-default', thinkingLevel: 'ultra' },
    },
    summaryModel: 'gpt-future-summary',
    summaryThinkingLevel: 'ultra',
  };
  const ollamaExecutable = path.join(userDataDir, 'ollama');
  writeFileSync(ollamaExecutable, "#!/bin/sh\necho 'ollama version 0.14.0'\n");
  chmodSync(ollamaExecutable, 0o755);
  seedPreUpgradePreferences(userDataDir, ollamaExecutable, savedPreferences);
  seedModelDefaultsGatewayCatalog(userDataDir);

  let electronApp;
  try {
    for (const restarting of [false, true]) {
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();
      await app.openSettingsSection('chat');

      const autoRetry = window.getByTestId(
        'settings-auto-retry-transient-chats',
      );
      if (!restarting) {
        await expect(autoRetry).toBeChecked();
        await autoRetry.click();
      }
      await expect(autoRetry).not.toBeChecked();
      await expect
        .poll(
          () =>
            readPersistedPreferences(userDataDir).autoRetryTransientErrorsChats,
        )
        .toBe(false);
      expect(readPersistedPreferences(userDataDir)).toMatchObject(
        savedPreferences,
      );

      const chatTab = window.getByTestId('settings-tab-chat');
      for (const [title, model] of [
        ['Default code model', 'gpt-future-code'],
        ['Default chat model', 'gpt-future-cowork'],
      ]) {
        const select = modelRow(chatTab, title).getByTestId(
          'chat-defaults-model-codex',
        );
        await expect(select).toHaveValue(model);
        await expect(select.locator('option:checked')).toHaveText(
          `${model} (unavailable)`,
        );
        await expect(select.locator('option:checked')).toBeDisabled();
      }
      const summaryModel = modelRow(chatTab, 'Chat title model')
        .locator('select')
        .first();
      await expect(summaryModel).toHaveValue('gpt-future-summary');
      await expect(summaryModel.locator('option:checked')).toHaveText(
        'gpt-future-summary (unavailable)',
      );
      await expect(summaryModel.locator('option:checked')).toBeDisabled();
      await expect(
        modelRow(chatTab, 'Default code model').getByTestId(
          'chat-defaults-thinking-codex',
        ),
      ).toHaveValue('ultra');
      await expect(
        modelRow(chatTab, 'Chat title model').getByRole('combobox', {
          name: 'Thinking level',
        }),
      ).toHaveValue('ultra');

      const creditsModel = modelRow(chatTab, 'Default code model').getByTestId(
        'chat-defaults-model-aiCredits',
      );
      await expect(creditsModel).toHaveValue('gateway-retired-default');
      await expect(creditsModel.locator('option:checked')).toHaveText(
        'gateway-retired-default (unavailable)',
      );
      await expect(creditsModel.locator('option:checked')).toBeDisabled();
      const creditsThinking = modelRow(
        chatTab,
        'Default code model',
      ).getByTestId('chat-defaults-thinking-aiCredits');
      await expect(creditsThinking).toHaveValue('ultra');
      await expect(creditsThinking).toBeDisabled();

      if (!restarting) {
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        electronApp = undefined;
      } else {
        await creditsModel.selectOption('');
        await expect
          .poll(
            () =>
              readPersistedPreferences(userDataDir)
                .defaultWorktreeModelByProvider.aiCredits,
          )
          .toBeNull();
      }
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('starts usable chats while preserving an unavailable saved default', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-default-runtime-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    tabs: [{ id: 'original', title: 'Original chat', model: 'gpt-5.6-sol' }],
  });
  const savedPreferences = {
    ...SAVED_MODEL_PREFERENCES,
    defaultWorktreeModelByProvider: {
      ...SAVED_MODEL_PREFERENCES.defaultWorktreeModelByProvider,
      codex: { model: 'gpt-future-code', thinkingLevel: 'ultra' },
    },
  };
  const ollamaExecutable = path.join(userDataDir, 'ollama');
  writeFileSync(ollamaExecutable, "#!/bin/sh\necho 'ollama version 0.14.0'\n");
  chmodSync(ollamaExecutable, 0o755);
  seedPreUpgradePreferences(userDataDir, ollamaExecutable, savedPreferences);
  let electronApp;
  try {
    for (const restarting of [false, true]) {
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();
      await app.openSettingsSection('chat');
      const chatTab = window.getByTestId('settings-tab-chat');
      await expect(
        modelRow(chatTab, 'Default code model').getByTestId(
          'chat-defaults-model-codex',
        ),
      ).toHaveValue('gpt-future-code');
      const autoRetry = window.getByTestId(
        'settings-auto-retry-transient-chats',
      );
      if (!restarting) await autoRetry.click();
      await expect(autoRetry).not.toBeChecked();
      await expect
        .poll(
          () =>
            readPersistedPreferences(userDataDir).autoRetryTransientErrorsChats,
        )
        .toBe(false);
      await app.closeSettings();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await window.getByTestId('panel-add-tab-group-chat').click();
      await window.getByTestId('panel-add-menu-item-new-chat').click();
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const snapshot = await window.api.chat.getState({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            });
            return snapshot.tabsFile.tabs.find(
              (tab) => tab.id === snapshot.tabsFile.activeTabId,
            )?.model;
          }),
        )
        .toBe('gpt-6.1-sol');
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('chat:send-message');
        globalThis.__capturedDefaultModelSend = undefined;
        ipcMain.handle('chat:send-message', (_event, request) => {
          globalThis.__capturedDefaultModelSend = request;
        });
      });
      await window
        .getByRole('textbox')
        .first()
        .fill('Use the available default model');
      await window
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__capturedDefaultModelSend?.model,
          ),
        )
        .toBe('gpt-6.1-sol');
      expect(readPersistedPreferences(userDataDir)).toMatchObject(
        savedPreferences,
      );
      if (!restarting) {
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        electronApp = undefined;
      }
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
