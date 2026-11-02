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
import { CHAT_EFFORT_TRIGGER_TEST_ID } from './effortPanel.mjs';
import { seedCoworkWorkspace, seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedModelDefaultsGatewayCatalog } from './seeders/seedUnavailableModelDefaults.mjs';
import {
  chooseSettingsOption,
  settingsOptionState,
} from './helpers/settingsSelect.mjs';

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

// A group's + opens the add-panel menu; its New Chat item creates the chat tab.
async function addChatTab(window) {
  await window.getByTestId('panel-add-tab-group-chat').click();
  await window
    .getByTestId('panel-add-menu')
    .getByTestId('panel-add-menu-item-new-chat')
    .click();
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
    ).toHaveAttribute('data-value', 'gpt-5.6-sol');

    const standaloneDefaults = modelRow(chatTab, 'Default chat model');
    await expect(
      standaloneDefaults.getByTestId('chat-defaults-model-codex'),
    ).toHaveAttribute('data-value', 'gpt-5.6-terra');

    await expect(
      modelRow(chatTab, 'Plan parsing and diagrams model')
        .locator('button[role="combobox"]')
        .first(),
    ).toHaveAttribute('data-value', 'sonnet');

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
    ).toHaveAttribute('data-value', 'constructor');
    const creditsModel = modelRow(chatTab, 'Default code model').getByTestId(
      'chat-defaults-model-aiCredits',
    );
    await expect(creditsModel).toHaveAttribute('data-value', 'constructor');
    await expect(creditsModel).toHaveText(/^constructor(?: \(unavailable\))?$/);
    await expect(
      modelRow(chatTab, 'Chat title model')
        .locator('button[role="combobox"]')
        .first(),
    ).toHaveAttribute('data-value', 'constructor');
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
        await expect(select).toHaveAttribute('data-value', model);
        await expect(select).toHaveText(`${model} (unavailable)`);
        expect(
          (
            await settingsOptionState(
              select,
              await select.getAttribute('data-value'),
            )
          )?.disabled,
        ).toBe(true);
      }
      const summaryModel = modelRow(chatTab, 'Chat title model')
        .locator('button[role="combobox"]')
        .first();
      await expect(summaryModel).toHaveAttribute(
        'data-value',
        'gpt-future-summary',
      );
      await expect(summaryModel).toHaveText('gpt-future-summary (unavailable)');
      expect(
        (
          await settingsOptionState(
            summaryModel,
            await summaryModel.getAttribute('data-value'),
          )
        )?.disabled,
      ).toBe(true);
      await expect(
        modelRow(chatTab, 'Default code model').getByTestId(
          'chat-defaults-thinking-codex',
        ),
      ).toHaveAttribute('data-value', 'ultra');
      await expect(
        modelRow(chatTab, 'Chat title model').getByRole('combobox', {
          name: 'Thinking level',
        }),
      ).toHaveAttribute('data-value', 'ultra');

      const creditsModel = modelRow(chatTab, 'Default code model').getByTestId(
        'chat-defaults-model-aiCredits',
      );
      await expect(creditsModel).toHaveAttribute(
        'data-value',
        'gateway-retired-default',
      );
      await expect(creditsModel).toHaveText(
        'gateway-retired-default (unavailable)',
      );
      expect(
        (
          await settingsOptionState(
            creditsModel,
            await creditsModel.getAttribute('data-value'),
          )
        )?.disabled,
      ).toBe(true);
      const creditsThinking = modelRow(
        chatTab,
        'Default code model',
      ).getByTestId('chat-defaults-thinking-aiCredits');
      await expect(creditsThinking).toHaveAttribute('data-value', 'ultra');
      await expect(creditsThinking).toBeDisabled();

      if (!restarting) {
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        electronApp = undefined;
      } else {
        await chooseSettingsOption(creditsModel, '');
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
      ).toHaveAttribute('data-value', 'gpt-future-code');
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
      await addChatTab(window);
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

// CAN-4646: GPT-6.1 Sol declares Low as its lowest effort. Both default groups
// must offer it, keep it through restart, and hand it to new chats.
const SOL_LOW = { model: 'gpt-6.1-sol', thinkingLevel: 'low' };

async function expectSolLowDefaults(chatTab) {
  for (const title of ['Default code model', 'Default chat model']) {
    const group = modelRow(chatTab, title);
    await expect(
      group.getByTestId('chat-defaults-model-codex'),
    ).toHaveAttribute('data-value', SOL_LOW.model);
    const thinking = group.getByTestId('chat-defaults-thinking-codex');
    await expect(thinking).toHaveAttribute('data-value', 'low');
    await expect(thinking).toHaveText('Low');
  }
}

function readActiveChat(window, target) {
  return window.evaluate(async (scope) => {
    const snapshot = await window.api.chat.getState(scope);
    const tab = snapshot.tabsFile.tabs.find(
      (candidate) => candidate.id === snapshot.tabsFile.activeTabId,
    );
    return {
      model: tab?.model,
      thinkingLevel: tab?.modelConfig?.thinkingLevel,
    };
  }, target);
}

async function sendFromComposer(window, electronApp, text) {
  const composer = window
    .locator('[data-chat-composer-root="true"]')
    .filter({ visible: true })
    .first();
  await expect(
    composer.getByTestId(CHAT_EFFORT_TRIGGER_TEST_ID),
  ).toHaveAttribute('data-thinking-level', 'low');
  await composer.getByRole('textbox').first().fill(text);
  await window
    .getByRole('button', { name: 'Send message', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect
    .poll(() =>
      electronApp.evaluate((_electron, message) => {
        const request = globalThis.__solLowSends?.find(
          (candidate) => candidate.text === message,
        );
        return request
          ? {
              model: request.model,
              thinkingLevel: request.modelConfig?.thinkingLevel,
            }
          : undefined;
      }, text),
    )
    .toEqual(SOL_LOW);
}

test('selects GPT-6.1 Sol Low in both default groups and starts new chats with it', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-defaults-sol-low-'),
  );
  const astraHigh = { model: 'gpt-6-astra', thinkingLevel: 'high' };
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    tabs: [
      {
        id: 'original',
        title: 'Original chat',
        model: astraHigh.model,
        modelConfig: { thinkingLevel: astraHigh.thinkingLevel },
      },
    ],
  });
  // A project default model overrides Default chat model, so leave it unset.
  const { workspaceId: coworkId, chatId: seededCoworkChatId } =
    seedCoworkWorkspace({ userDataDir, defaultModel: null, mergeIndex: true });
  const savedPreferences = {
    ...SAVED_MODEL_PREFERENCES,
    defaultChatModelByProvider: {
      ...SAVED_MODEL_PREFERENCES.defaultChatModelByProvider,
      codex: astraHigh,
    },
    defaultWorktreeModelByProvider: {
      ...SAVED_MODEL_PREFERENCES.defaultWorktreeModelByProvider,
      codex: astraHigh,
    },
  };
  const ollamaExecutable = path.join(userDataDir, 'ollama');
  writeFileSync(ollamaExecutable, "#!/bin/sh\necho 'ollama version 0.14.0'\n");
  chmodSync(ollamaExecutable, 0o755);
  seedPreUpgradePreferences(userDataDir, ollamaExecutable, savedPreferences);

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('chat');
    const chatTab = window.getByTestId('settings-tab-chat');
    for (const title of ['Default code model', 'Default chat model']) {
      const group = modelRow(chatTab, title);
      await chooseSettingsOption(
        group.getByTestId('chat-defaults-model-codex'),
        SOL_LOW.model,
      );
      const thinking = group.getByTestId('chat-defaults-thinking-codex');
      expect((await settingsOptionState(thinking, 'low'))?.label).toBe('Low');
      await chooseSettingsOption(thinking, 'low');
      await expect(thinking).toHaveAttribute('data-value', 'low');
    }
    await expect
      .poll(() => {
        const preferences = readPersistedPreferences(userDataDir);
        return [
          preferences.defaultWorktreeModelByProvider.codex,
          preferences.defaultChatModelByProvider.codex,
        ];
      })
      .toEqual([SOL_LOW, SOL_LOW]);

    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('chat');
    await expectSolLowDefaults(window.getByTestId('settings-tab-chat'));

    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('chat');
    await expectSolLowDefaults(window.getByTestId('settings-tab-chat'));
    await app.closeSettings();

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:send-message');
      globalThis.__solLowSends = [];
      ipcMain.handle('chat:send-message', (_event, request) => {
        globalThis.__solLowSends.push(request);
      });
    });

    // New worktree chat: Default code model.
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await addChatTab(window);
    await expect
      .poll(() =>
        readActiveChat(window, {
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        }),
      )
      .toEqual(SOL_LOW);
    await sendFromComposer(window, electronApp, 'Use the Sol Low code default');

    // New standalone chat: Default chat model.
    const coworkHeader = window.getByTestId(
      `sidebar-cowork-project-${coworkId}-header`,
    );
    await expect(coworkHeader).toBeVisible();
    await coworkHeader.hover();
    await window
      .getByTestId(`sidebar-cowork-project-${coworkId}-new-chat`)
      .click();
    let coworkEntryId;
    await expect
      .poll(async () => {
        const { entries } = await window.evaluate(
          (projectId) => window.api.workEntries.list({ projectId }),
          coworkId,
        );
        coworkEntryId = entries.find(
          (entry) => entry.id !== seededCoworkChatId,
        )?.id;
        return coworkEntryId;
      })
      .toBeTruthy();
    await expect
      .poll(() =>
        readActiveChat(window, {
          projectId: coworkId,
          worktreeId: coworkEntryId,
        }),
      )
      .toEqual(SOL_LOW);
    await sendFromComposer(window, electronApp, 'Use the Sol Low chat default');

    expect(readPersistedPreferences(userDataDir)).toMatchObject({
      defaultWorktreeModelByProvider: { codex: SOL_LOW },
      defaultChatModelByProvider: { codex: SOL_LOW },
    });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
