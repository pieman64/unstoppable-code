import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedPluginsCache,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const DEMO_APP_ID = 'ts-pnpm-vite';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const ORIGINAL_WORKTREE_BRANCH = 'demo-main';
const CUSTOM_SKILL_NAME = 'e2e-chat-plugin';
const SEEDED_CLAUDE_PLUGIN_NAME = 'gamma-tool';
// Large enough that resolving it keeps a Codex turn busy for many IPC samples,
// small enough that copying it fits the app's 20 s materialization deadline on
// a slow CI disk. Past that deadline the app skips the skill by design, and
// the aggregate-cache assertion below would then fail for the host's speed.
const CODEX_SKILL_FIXTURE_FILES = 1500;
const RESPONSIVE_BOUND_MS = 2500;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function seedPreferences(userDataDir, { provider, model }) {
  // Avoid collisions with a developer Canopy instance bound to the default
  // Claude MCP proxy port.
  const mcpProxyPort = 41000 + (Date.now() % 20000);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: provider,
          defaultChatProvider: provider,
          defaultChatInterfaceMode: 'canopy',
          defaultStandaloneChatInterfaceMode: 'canopy',
          defaultAppAdvisorInterfaceMode: 'canopy',
          mcpProxyPort,
          defaultWorktreeModelByProvider: {
            [provider]: { model, thinkingLevel: 'high' },
          },
          defaultChatModelByProvider: {
            [provider]: { model, thinkingLevel: 'high' },
          },
          providerModelConfigDefaults: {
            [provider]: { thinkingLevel: 'high' },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

function readPersistedActiveTab(userDataDir, worktreeId) {
  // The eager composer precedes canonical persistence. An absent manifest
  // means this readiness poll should continue, not that creation failed.
  if (
    !existsSync(
      path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'chat-storage-manifests',
        `${worktreeId}.json`,
      ),
    )
  )
    return null;
  const { live: chatFile } = readChatStorageIndexes(
    path.join(userDataDir, 'workspaces', WORKSPACE_ID),
    worktreeId,
  );
  return (
    chatFile.tabs.find((tab) => tab.id === chatFile.activeTabId) ??
    chatFile.tabs[0] ??
    null
  );
}

function seedCustomSkill(userDataDir, fixtureFiles = 0) {
  const skillDir = path.join(
    userDataDir,
    'skills',
    'custom:app',
    CUSTOM_SKILL_NAME,
  );
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'description: UI automation chat plugin fixture',
      '---',
      '',
      'This skill is a deterministic UI automation fixture.',
      '',
    ].join('\n'),
    'utf8',
  );
  const referencesDir = path.join(skillDir, 'references');
  mkdirSync(referencesDir, { recursive: true });
  for (let index = 0; index < fixtureFiles; index += 1) {
    writeFileSync(
      path.join(referencesDir, `reference-${index}.md`),
      `# Reference ${index}\n\nDeterministic capability fixture ${index}.\n`,
      'utf8',
    );
  }
}

function seedClaudePluginFixture(userDataDir) {
  const pluginDir = path.join(
    userDataDir,
    'plugin-fixtures',
    SEEDED_CLAUDE_PLUGIN_NAME,
  );
  const manifestDir = path.join(pluginDir, '.claude-plugin');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify(
      {
        name: SEEDED_CLAUDE_PLUGIN_NAME,
      },
      null,
      2,
    ),
    'utf8',
  );
  return pluginDir;
}

async function createAndOpenWorktreeChat(window) {
  const workspaceHeader = window
    .getByRole('button', {
      name: new RegExp(`^(?:Expand|Collapse) ${escapeRegExp(WORKSPACE_NAME)}$`),
    })
    .first();
  await expect(workspaceHeader).toBeVisible();
  if (
    (await workspaceHeader.getAttribute('aria-label')) ===
    `Expand ${WORKSPACE_NAME}`
  ) {
    await workspaceHeader.click();
  }
  await expect(
    window
      .getByRole('button', {
        name: `Collapse ${WORKSPACE_NAME}`,
      })
      .first(),
  ).toBeVisible();
  await workspaceHeader.hover();

  const createButton = window.getByRole('button', {
    name: `Create worktree for ${WORKSPACE_NAME}`,
  });
  await expect(createButton).toBeVisible();
  await createButton.click();

  // 0e1fce54b (#1918) intentionally restored the classic workspace "+" flow:
  // it creates/selects a worktree immediately and opens its Code chat instead
  // of routing through a Home draft.
  await expect(window.getByTestId('page-home')).toHaveCount(0);
  const chatPanel = window.getByTestId('panel-content-chat');
  await expect(chatPanel).toBeVisible({ timeout: 15_000 });
  const selectedWorktree = window
    .locator('[data-sidebar-selected-item] [data-testid="worktree-row"]')
    .first();
  await expect(selectedWorktree).toBeVisible();
  const worktreeId = await selectedWorktree.getAttribute('data-worktree-id');
  if (!worktreeId) throw new Error('Expected the created worktree id');
  return worktreeId;
}

async function enablePluginOrSkill(window, { kind, name }) {
  const openPlugins = async () => {
    await window.getByTestId('chat-input-plus-button').click();
    await window.getByTestId('chat-plugins-button').click();
  };
  await openPlugins();

  const dialog = window
    .locator('[role="dialog"]')
    .filter({ hasText: 'Plugins' });
  const checkbox = dialog.getByRole('checkbox', {
    name: `Select ${name}`,
  });
  const applyFilters = async () => {
    await expect(dialog).toBeVisible({ timeout: 2_000 });
    await dialog.getByPlaceholder('Search by name…').fill(name);
    await dialog
      .getByRole('combobox', { name: 'Kind filter' })
      .selectOption(kind);
    await expect(checkbox).toBeVisible({ timeout: 2_000 });
  };

  // A newly created worktree can finish hydrating the chat tab after the
  // modal opens. That replaces the modal's initial selection snapshot and can
  // legitimately undo the first click. Retry the complete user operation
  // until reopening the modal proves that the selected row was persisted.
  await expect(async () => {
    if ((await dialog.count()) === 0) {
      await openPlugins();
    }
    await applyFilters();
    await checkbox.check({ timeout: 2_000 });
    await expect(checkbox).toBeChecked({ timeout: 2_000 });
    await expect(dialog.getByTestId('unified-table-selected-count')).toHaveText(
      '1',
      { timeout: 2_000 },
    );
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0, { timeout: 2_000 });
    await openPlugins();
    await applyFilters();
    await expect(checkbox).toBeChecked({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
}

function hasMaterializedAggregateCapability(userDataDir) {
  return materializedAggregateCapabilityKey(userDataDir) !== null;
}

function materializedAggregateCapabilityKey(userDataDir) {
  const aggregateRoot = path.join(
    userDataDir,
    'plugin-cache',
    'codex-compatibility',
    '_aggregate',
  );
  if (!existsSync(aggregateRoot)) return null;
  const materializedEntries = readdirSync(aggregateRoot, {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(
          path.join(aggregateRoot, entry.name, 'canopy-compatibility.json'),
        ),
    )
    .map((entry) => entry.name)
    .sort();
  return materializedEntries.length > 0 ? materializedEntries.join(',') : null;
}

async function measureIpcRoundTripMs(window) {
  return window.evaluate(async () => {
    const start = performance.now();
    await window.api.loadPreferences();
    return performance.now() - start;
  });
}

async function sendMessageAndExpectReply(window, { marker, reply }) {
  const userMessage = `[${marker}] Confirm the new worktree chat path.`;
  const composer = window.getByRole('textbox').first();

  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill(userMessage);
  await window.getByRole('button', { name: 'Send message' }).click();

  await expect(window.getByText(userMessage).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(window.getByText(reply).first()).toBeVisible({
    timeout: 120_000,
  });
}

async function measureIpcWhile(window, operation) {
  let sampleCount = 0;
  let maxLatencyMs = 0;
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      maxLatencyMs = Math.max(
        maxLatencyMs,
        await measureIpcRoundTripMs(window),
      );
      sampleCount += 1;
      if (!stop) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  })();
  try {
    await operation();
  } finally {
    stop = true;
    await sampler;
  }
  return { sampleCount, maxLatencyMs };
}

async function runCreatedWorktreePluginChatFlow(providerConfig) {
  const {
    provider,
    model,
    marker,
    reply,
    pluginSelection,
    materializationResponsivenessOnly = false,
  } = providerConfig;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), `canopy-${provider}-created-worktree-plugins-`),
  );

  seedPreferences(userDataDir, { provider, model });
  seedCustomSkill(
    userDataDir,
    materializationResponsivenessOnly ? CODEX_SKILL_FIXTURE_FILES : 0,
  );
  const claudePluginDir = seedClaudePluginFixture(userDataDir);
  seedPluginsCache({
    userDataDir,
    installedPluginCachePaths: {
      [SEEDED_CLAUDE_PLUGIN_NAME]: claudePluginDir,
    },
  });
  seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });

  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    authUsage: { scenario: 'authed-low-usage' },
    llm: {
      steps: [{ text: reply, stopReason: 'end_turn' }],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, 'mock', {
    authUsage: { scenario: 'authed-low-usage' },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  let worktreeId;
  let mainLog = '';
  const recordMainOutput = (chunk) => {
    mainLog = (mainLog + chunk.toString()).slice(-256 * 1024);
  };
  electronApp.process().stdout?.on('data', recordMainOutput);
  electronApp.process().stderr?.on('data', recordMainOutput);

  try {
    const window = await electronApp.firstWindow();
    const rendererErrors = [];
    window.on('pageerror', (error) => rendererErrors.push(error.message));
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    worktreeId = await createAndOpenWorktreeChat(window);
    // New-worktree hydration can replace the responsive composer's initial
    // picker snapshot. Persistence is the canonical readiness signal and is
    // stable even when the picker is temporarily hidden at CI widths.
    await expect
      .poll(() => readPersistedActiveTab(userDataDir, worktreeId)?.model)
      .toBe(model);

    if (materializationResponsivenessOnly) {
      const responsiveness = await measureIpcWhile(window, async () => {
        await enablePluginOrSkill(window, pluginSelection);
        await sendMessageAndExpectReply(window, { marker, reply });
        await expect
          .poll(() => hasMaterializedAggregateCapability(userDataDir), {
            timeout: 90_000,
            message: 'selected skill materialized into the aggregate cache',
          })
          .toBe(true);
      });
      expect(responsiveness.sampleCount).toBeGreaterThanOrEqual(3);
      expect(responsiveness.maxLatencyMs).toBeLessThan(RESPONSIVE_BOUND_MS);
    } else {
      await enablePluginOrSkill(window, pluginSelection);
      await sendMessageAndExpectReply(window, { marker, reply });
    }
    if (provider === 'codex' && !materializationResponsivenessOnly) {
      await expect
        .poll(() => hasMaterializedAggregateCapability(userDataDir), {
          timeout: 90_000,
          message: 'selected skill materialized into the aggregate cache',
        })
        .toBe(true);
    }
    expect(
      rendererErrors.filter((message) =>
        message.includes('Cannot resolve a DOM node from Slate node'),
      ),
    ).toEqual([]);
    await expect(
      window
        .getByTestId('worktree-row')
        .filter({ hasNotText: ORIGINAL_WORKTREE_BRANCH })
        .first(),
    ).toBeVisible({ timeout: 45_000 });
  } catch (error) {
    await test.info().attach('main-process-tail', {
      body: mainLog,
      contentType: 'text/plain',
    });
    try {
      const responses = await Promise.all(
        ['state', 'activity'].map(async (kind) => {
          const response = await fetch(
            `${DEFAULT_MOCK_BASE_URL}/__mock/${kind}/${encodeURIComponent(marker)}`,
            { signal: AbortSignal.timeout(5_000) },
          );
          return { kind, status: response.status, body: await response.text() };
        }),
      );
      await test.info().attach('mock-scenario-state', {
        body: JSON.stringify(responses, null, 2),
        contentType: 'application/json',
      });
    } catch (diagnosticError) {
      await test.info().attach('mock-scenario-state-error', {
        body: String(diagnosticError),
        contentType: 'text/plain',
      });
    }
    if (worktreeId) {
      const root = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
      try {
        const indexes = readChatStorageIndexes(root, worktreeId);
        const transcripts = indexes.live.tabs
          .filter((tab) => tab.kind !== 'file')
          .map((tab) => ({
            chatId: tab.id,
            messages: readChatStorageMessages(root, worktreeId, tab.id),
          }));
        await test.info().attach('native-chat-state', {
          body: JSON.stringify({ indexes, transcripts }, null, 2),
          contentType: 'application/json',
        });
      } catch (diagnosticError) {
        await test.info().attach('native-chat-state-error', {
          body: String(diagnosticError),
          contentType: 'text/plain',
        });
      }
    }
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
    await clearScenario(DEFAULT_MOCK_BASE_URL, 'mock').catch(() => undefined);
  }
}

test.describe('created worktree chat with plugins and mock provider reply', () => {
  test('preserves the initial composer draft when switching across harnesses', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-created-worktree-model-draft-'),
    );
    const draft = 'Keep this unsent draft while changing models.';

    seedPreferences(userDataDir, { provider: 'codex', model: 'gpt-6.1-sol' });
    seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await createAndOpenWorktreeChat(window);
      const chatPanel = window.getByTestId('panel-content-chat');
      const composer = chatPanel.getByRole('textbox').first();
      await composer.fill(draft);
      await chatPanel.getByTestId('chat-model-picker').click();
      const sonnetOption = window.getByTestId('chat-model-option-sonnet');
      await expect(sonnetOption).toBeVisible();

      // Reproduce the terminal race outcome deterministically: the legacy
      // model channel is accepted, then its redundant typed settings patch
      // observes a not-yet-canonical starter tab. Install only after the
      // picker is ready so unrelated activation/read commands are unaffected.
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('chat:command');
        ipcMain.handle('chat:command', (_event, envelope) => ({
          commandId: envelope.commandId,
          revision: 9,
          outcome: 'not_found',
        }));
      });
      await sonnetOption.click();

      await expect(chatPanel.getByTestId('chat-model-picker')).toContainText(
        'Sonnet',
      );
      await expect(composer).toHaveText(draft);
      await expect(
        window.getByText(
          'Chat changed elsewhere. Your view has been refreshed.',
        ),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps the renderer responsive while a large Codex skill materializes', async () => {
    test.setTimeout(180_000);

    await runCreatedWorktreePluginChatFlow({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      pluginSelection: { kind: 'skill', name: CUSTOM_SKILL_NAME },
      marker: 'Canopy-CWORKTREE-CODEX-MATERIALIZATION',
      reply: 'Codex mock response after large skill materialization',
      materializationResponsivenessOnly: true,
    });
  });

  test('uses a Codex model, enables a chat plugin, and renders the mock response', async () => {
    test.setTimeout(180_000);

    await runCreatedWorktreePluginChatFlow({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      pluginSelection: { kind: 'skill', name: CUSTOM_SKILL_NAME },
      marker: 'Canopy-CWORKTREE-CODEX',
      reply: 'Codex mock response for the plugin-enabled created worktree',
    });
  });

  test('uses a Claude model, enables a chat plugin, and renders the mock response', async () => {
    test.setTimeout(180_000);

    await runCreatedWorktreePluginChatFlow({
      provider: 'claude',
      model: 'opus[1m]',
      pluginSelection: { kind: 'plugin', name: SEEDED_CLAUDE_PLUGIN_NAME },
      marker: 'Canopy-CWORKTREE-CLAUDE',
      reply: 'Claude mock response for the plugin-enabled created worktree',
    });
  });
});
