import {
  releasePendingModel,
  selectModelOption,
} from './model-selection-fixture.mjs';
import { holdModelChange } from './fixtures/pending-model-change.mjs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import {
  createFixture,
  conversationRequests,
  seedPreferences as seedCodexPreferences,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat, writeJson } from './seeders/index.mjs';
import {
  launchOllamaDiscoveryFixture,
  respondToOllamaDiscovery,
} from './fixtures/ollama-discovery.mjs';
import { cursorRuntimeFixture } from './fixtures/cursor-runtime.mjs';
import { expectCursorConnected } from './fixtures/cursor-tile.mjs';

const WORKTREE_BRANCH = 'demo-main';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const MARKETPLACE_ID = 'demo/market';
const PLUGIN_NAME = 'available-plugin';
const COMMAND_NAME = 'say-hi';
const STANDALONE_SKILL_NAME = 'review';
const CODEX_INVOCATION_KEY = `$builtin-app-plugin:${STANDALONE_SKILL_NAME}`;
const TYPED_MESSAGE = `/${STANDALONE_SKILL_NAME} hello`;
const NORMALIZED_MESSAGE = `${CODEX_INVOCATION_KEY} hello`;
const CODEX_REPLY = 'Normalized invocation received by the Codex fixture';

for (const scope of ['all', 'mention', 'plugin', 'toolbar', 'plus']) {
  test(`composer menu enables and inserts an available inventory command (${scope})`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-slash-inventory-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    seedPluginCache(userDataDir);
    seedInventoryCache(userDataDir);

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(
        scope === 'toolbar' || scope === 'plus'
          ? 'Keep this draft '
          : scope === 'plugin'
            ? `@${PLUGIN_NAME}`
            : scope === 'mention'
              ? '@'
              : '/',
      );
      const menu = window.getByTestId('chat-input-plus-menu');
      if (scope === 'toolbar' || scope === 'plus') {
        await window.getByTestId('chat-input-plus-button').click();
      }
      await expect(menu).toBeVisible();
      await expect(composer).toBeFocused();
      if (scope !== 'all') {
        // The Add / mention menu lists whole plugins, never their members:
        // picking the plugin enables it for the chat and drops an `@` pill,
        // after which its command is reachable through `/` like any other.
        if (scope !== 'plugin') await composer.pressSequentially(PLUGIN_NAME);
        await menu
          .getByTestId(`chat-input-plugin-${MARKETPLACE_ID}-${PLUGIN_NAME}`)
          .click();
        await expect(menu).toHaveCount(0);
        await expect(
          composer.locator(
            '[data-testid="file-reference-pill"][data-mention-kind="plugin"]',
          ),
        ).toHaveCount(1);
        await expect
          .poll(() => readPersistedPluginRefs(userDataDir), {
            message: 'picking the whole plugin should enable it',
          })
          .toEqual([
            { marketplaceId: MARKETPLACE_ID, pluginName: PLUGIN_NAME },
          ]);
        await composer.click();
        await composer.press('End');
        await composer.pressSequentially(`/${COMMAND_NAME}`);
        await expect(menu).toBeVisible();
      } else {
        await composer.pressSequentially(COMMAND_NAME);
      }
      await menu.getByTestId(`chat-input-capability-${COMMAND_NAME}`).click();
      await expect(menu).toHaveCount(0);
      if (scope === 'toolbar' || scope === 'plus') {
        await expect(composer).toContainText('Keep this draft');
      }

      await expect(composer).toContainText(`/${COMMAND_NAME}`);
      await expect(window.getByTestId('slash-command-menu')).toHaveCount(0);

      await expect
        .poll(() => readPersistedPluginRefs(userDataDir), {
          message: 'available slash row should enable its backing plugin',
        })
        .toEqual([{ marketplaceId: MARKETPLACE_ID, pluginName: PLUGIN_NAME }]);
      if (scope === 'toolbar') {
        await window.getByTestId('chat-input-plus-button').click();
        await window.getByTestId('chat-plugins-button').click();
        const dialog = window
          .getByRole('dialog')
          .filter({ has: window.getByTestId('plugin-selector-scope') });
        await dialog.getByPlaceholder('Search by name…').fill(PLUGIN_NAME);
        const row = dialog
          .locator('tbody tr')
          .filter({ hasText: PLUGIN_NAME })
          .first();
        await row.getByTestId('plugin-members-toggle').click();
        await expect(
          row.getByRole('list', { name: `${PLUGIN_NAME} capabilities` }),
        ).toContainText(COMMAND_NAME);
        await expect(row.getByRole('checkbox')).toBeChecked();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

/** Moves the composer's keyboard highlight onto `row` with ArrowDown. */
async function highlightRow(composer, row) {
  const id = await row.getAttribute('id');
  await expect(async () => {
    if ((await composer.getAttribute('aria-activedescendant')) !== id)
      await composer.press('ArrowDown');
    expect(await composer.getAttribute('aria-activedescendant')).toBe(id);
  }).toPass();
}

// CAN-3545: plain Tab completes the highlighted typed `/` or `@` suggestion
// the way Enter does, keeps focus in the composer, and never sends; Shift+Tab
// keeps moving focus out of the composer.
test('Tab completes typed / and @ suggestions without sending', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-tab-completion-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedPluginCache(userDataDir);
  seedInventoryCache(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();

    const composer = panel.getByRole('textbox').first();
    const menu = window.getByTestId('chat-input-plus-menu');
    await composer.click();

    await composer.pressSequentially('/say-h');
    const commandRow = menu.getByTestId(
      `chat-input-capability-${COMMAND_NAME}`,
    );
    await expect(commandRow).toBeVisible();
    await highlightRow(composer, commandRow);
    await composer.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText(/^\s*\/say-hi\s*$/);
    await expect(panel.getByTestId('user-message-content')).toHaveCount(0);

    await composer.press('End');
    await composer.pressSequentially(' @package.json');
    const fileRow = menu.getByTestId('chat-input-file-result').first();
    await expect(fileRow).toBeVisible();
    await highlightRow(composer, fileRow);
    await composer.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(
      composer.locator('[data-testid="file-reference-pill"]'),
    ).toHaveCount(1);
    await expect(composer).toContainText('package.json');
    await expect(panel.getByTestId('user-message-content')).toHaveCount(0);

    for (const action of ['attach', 'plugins', 'model']) {
      await composer.fill('');
      await composer.pressSequentially(`/${action}`);
      const actionRow = menu.getByTestId(`chat-input-capability-${action}`);
      await expect(actionRow).toBeVisible();
      await expect(actionRow).not.toHaveAttribute('data-completion-row');
      await composer.press('Tab');
      await expect(menu).toHaveCount(0);
      await expect(window.getByTestId('plugin-picker-region')).toHaveCount(0);
    }

    await composer.fill('');
    await composer.pressSequentially('/say-h');
    await expect(commandRow).toBeVisible();
    await composer.press('Shift+Tab');
    await expect(menu).toHaveCount(0);
    await expect(composer).not.toBeFocused();
    await expect(composer).toHaveText(/\/say-h\s*$/);

    // The New Task composer shares the same menu session.
    await window.getByTestId('sidebar-create-task').click();
    const homePage = window.getByTestId('page-home');
    await expect(homePage).toBeVisible();
    const homeComposer = homePage.getByTestId('home-composer-editor');
    const homeMenu = window.getByTestId('home-composer-plus-menu');
    await homeComposer.click();
    await homeComposer.pressSequentially('@package.json');
    const homeFileRow = homeMenu
      .getByTestId('home-composer-file-result')
      .first();
    await expect(homeFileRow).toBeVisible();
    await highlightRow(homeComposer, homeFileRow);
    await homeComposer.press('Tab');
    await expect(homeMenu).toHaveCount(0);
    await expect(homeComposer).toBeFocused();
    await expect(
      homeComposer.locator('[data-testid="file-reference-pill"]'),
    ).toHaveCount(1);

    // A bare `@` lists actions (Files and folders, Plugins) above the
    // suggestions; Tab skips them and completes the first suggestion
    // instead of opening a picker or dialog.
    await homeComposer.pressSequentially(' @');
    await expect(
      homeMenu.getByTestId('home-composer-file-result').first(),
    ).toBeVisible();
    await homeComposer.press('Tab');
    await expect(homeMenu).toHaveCount(0);
    await expect(window.getByTestId('plugin-picker-region')).toHaveCount(0);
    await expect(homeComposer).toBeFocused();
    await expect(
      homeComposer.locator('[data-testid="file-reference-pill"]'),
    ).toHaveCount(2);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const harness of ['claude', 'codex']) {
  test(`Ollama enables an inventory command on the selected ${harness} harness`, async () => {
    const { electronApp, userDataDir } = await launchOllamaDiscoveryFixture(
      harness,
      {
        seed: (dir) => {
          if (harness === 'claude') {
            seedPluginCache(dir);
            seedInventoryCache(dir);
          } else {
            seedCodexStandaloneSkill(dir);
            seedCodexInventoryCache(dir);
          }
        },
      },
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel.getByTestId('chat-model-picker')).toContainText(
        'qwen3-coder',
      );
      const composer = panel.getByRole('textbox').first();
      const commandName =
        harness === 'claude' ? COMMAND_NAME : STANDALONE_SKILL_NAME;
      await composer.fill(`/${commandName}`);
      const menu = window.getByTestId('chat-input-plus-menu');
      await menu.getByTestId(`chat-input-capability-${commandName}`).click();
      await expect(menu).toHaveCount(0);
      await expect(composer).toContainText(
        harness === 'claude' ? `/${COMMAND_NAME}` : CODEX_INVOCATION_KEY,
      );
      await expect
        .poll(() => {
          const { live: file } = readChatStorageIndexes(
            path.join(userDataDir, 'workspaces', WORKSPACE_ID),
            WORKTREE_ID,
          );
          return file.tabs.find((tab) => tab.id === 'ollama-discovery')
            ?.pluginSelections;
        })
        .toMatchObject(
          harness === 'claude'
            ? {
                pluginRefs: [
                  { marketplaceId: MARKETPLACE_ID, pluginName: PLUGIN_NAME },
                ],
              }
            : {
                skillRefs: [
                  { sourceId: 'custom:app', skillName: STANDALONE_SKILL_NAME },
                ],
              },
        );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const harness of [undefined, 'claude', 'codex']) {
  test(`fresh Ollama chat retains discovered commands (${harness ?? 'default'} harness)`, async () => {
    const { electronApp, userDataDir } =
      await launchOllamaDiscoveryFixture(harness);
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel.getByTestId('chat-model-picker')).toContainText(
        'qwen3-coder',
      );
      await expect
        .poll(() =>
          electronApp.evaluate(() =>
            globalThis.harnessDiscoveryRequests
              .filter((request) => request.chatId === 'ollama-discovery')
              .map((request) => request.providerType),
          ),
        )
        .toContain(harness === 'codex' ? 'codex' : 'ollama');
      await respondToOllamaDiscovery(electronApp);
      const composer = panel.getByRole('textbox').first();
      await composer.fill('/local-review');
      const command = window.getByTestId('chat-input-capability-local-review');
      await expect(command).toBeVisible();
      await command.click();
      await expect(composer).toContainText('/local-review');
      await expect(window.getByTestId('chat-input-plus-menu')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Tab accepts the highlighted typed / command exactly as Enter does', async () => {
  const { electronApp, userDataDir } = await launchOllamaDiscoveryFixture();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'qwen3-coder',
    );
    await expect
      .poll(() =>
        electronApp.evaluate(() =>
          globalThis.harnessDiscoveryRequests
            .filter((request) => request.chatId === 'ollama-discovery')
            .map((request) => request.providerType),
        ),
      )
      .toContain('ollama');
    await respondToOllamaDiscovery(electronApp);
    const composer = panel.getByRole('textbox').first();
    const menu = window.getByTestId('chat-input-plus-menu');
    const accepted = {};
    for (const key of ['Enter', 'Tab']) {
      await composer.fill('');
      await composer.pressSequentially('/local-rev');
      await expect(menu).toBeVisible();
      await expect(
        window.getByTestId('chat-input-capability-local-review'),
      ).toBeVisible();
      await composer.press(key);
      await expect(menu).toHaveCount(0);
      await expect(composer).toContainText('/local-review');
      // Accepting keeps focus in the composer; Tab must not move it away.
      await expect(composer).toBeFocused();
      accepted[key] = await composer.innerText();
    }
    expect(accepted.Tab).toBe(accepted.Enter);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Cursor lists its own inventory rows after switching from Claude, never the cached Claude ones', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-slash-inventory-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedPluginCache(userDataDir);
  seedInventoryCache(userDataDir);
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');
    const composer = panel.getByRole('textbox').first();
    await composer.fill('/');
    await expect(
      window.getByTestId(`chat-input-capability-${COMMAND_NAME}`),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('chat-input-plus-menu')).toHaveCount(0);
    await composer.fill('');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(window, 'cursor-default');
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'Cursor',
    );
    await composer.fill('/');
    const menu = window.getByTestId('chat-input-plus-menu');
    await expect(menu).toBeVisible();
    await composer.pressSequentially(COMMAND_NAME);
    // The row is the Cursor projection of the command (the id the chat's
    // private Cursor root holds), not Claude's cached `/say-hi`.
    const row = menu.getByTestId(`chat-input-capability-${COMMAND_NAME}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(`/${PLUGIN_NAME}-${COMMAND_NAME}`);
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // Browsing the row enabled nothing.
    expect(readPersistedPluginRefs(userDataDir)).toEqual([]);
    await composer.fill(
      'CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.',
    );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
  }
});

test('a typed slash trigger survives the Cursor switch committing underneath it', async () => {
  // Main commits a model change durably before it answers, so a user who
  // types `/` right after picking Cursor still has Claude's rows open when the
  // switch lands. The composer must keep that menu and re-project its rows
  // for Cursor instead of dismissing the trigger.
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-slash-inventory-pending-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedPluginCache(userDataDir);
  seedInventoryCache(userDataDir);
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');
    const composer = panel.getByRole('textbox').first();
    // Hold the Cursor commit in main until the trigger has been typed.
    await holdModelChange(electronApp, 'cursor-default');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(window, 'cursor-default');
    await expect
      .poll(() =>
        electronApp.evaluate(() => typeof globalThis.__releasePendingModel),
      )
      .toBe('function');
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'Cursor',
    );
    await composer.fill('/');
    const menu = window.getByTestId('chat-input-plus-menu');
    await expect(menu).toBeVisible();
    await composer.pressSequentially(COMMAND_NAME);
    const row = menu.getByTestId(`chat-input-capability-${COMMAND_NAME}`);
    // The menu opened on the pre-switch rows: Claude's cached `/say-hi`
    // (labelled with its plugin, CAN-5271), not the Cursor projection, so the
    // switch really lands underneath it.
    await expect(row).toContainText(`/${PLUGIN_NAME}:${COMMAND_NAME}`);
    await expect(row).not.toContainText(`/${PLUGIN_NAME}-${COMMAND_NAME}`);
    await releasePendingModel(electronApp);
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
      .toBe('cursor-default');
    // The same open menu now lists the Cursor projection of the command.
    await expect(row).toContainText(`/${PLUGIN_NAME}-${COMMAND_NAME}`);
    await expect(menu).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(readPersistedPluginRefs(userDataDir)).toEqual([]);
  } finally {
    // Never tear main down with the held invoke still pending.
    await releasePendingModel(electronApp).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
  }
});

test('composer normalizes a standalone Codex skill before the provider boundary', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-invocation-normalization-'),
  );
  seedCodexPreferences(userDataDir);
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedCodexStandaloneSkill(userDataDir);
  seedCodexInventoryCache(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: 'invocation-normalization',
        title: 'Invocation normalization',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [
            {
              sourceId: 'custom:app',
              skillName: STANDALONE_SKILL_NAME,
            },
          ],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
    ],
  });
  const fixture = createFixture('normal', CODEX_REPLY);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: fixture.env,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    const composer = panel.getByRole('textbox').first();
    await composer.fill(TYPED_MESSAGE);
    await window.getByRole('button', { name: 'Send message' }).click();

    await expect(panel.getByText(TYPED_MESSAGE, { exact: true })).toBeVisible();
    await expect(panel.getByText(CODEX_REPLY, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() => firstCodexTurnText(fixture.logPath), {
        message: 'Codex turn/start should receive the normalized invocation',
        timeout: 30_000,
      })
      .toBe(NORMALIZED_MESSAGE);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.runtimeDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

function seedCodexStandaloneSkill(userDataDir) {
  const skillDir = path.join(
    userDataDir,
    'skills',
    'custom:app',
    STANDALONE_SKILL_NAME,
  );
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${STANDALONE_SKILL_NAME}`,
      'description: Provider-boundary invocation normalization fixture',
      'user-invocable: true',
      '---',
      '',
      'Review the requested change.',
      '',
    ].join('\n'),
    'utf8',
  );
}

function seedCodexInventoryCache(userDataDir) {
  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    version: 3,
    builtAt: '2026-08-31T00:00:00.000Z',
    entries: [
      {
        id: 'codex:skill:custom%3Aapp:review',
        provider: 'codex',
        kind: 'skill',
        name: STANDALONE_SKILL_NAME,
        displayName: CODEX_INVOCATION_KEY,
        description: 'Provider-boundary invocation normalization fixture',
        insertText: `${CODEX_INVOCATION_KEY} `,
        invocationKey: CODEX_INVOCATION_KEY,
        enableRef: {
          kind: 'skill',
          sourceId: 'custom:app',
          skillName: STANDALONE_SKILL_NAME,
        },
        sourceLabel: 'Custom',
      },
    ],
  });
}

function firstCodexTurnText(logPath) {
  const turnRequest = conversationRequests(logPath).find(
    (request) => request.method === 'turn/start',
  );
  const textInput = turnRequest?.params?.input?.find(
    (item) => item.type === 'text',
  );
  return textInput?.text;
}

function seedInventoryCache(userDataDir) {
  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    version: 3,
    builtAt: '2026-06-20T00:00:00.000Z',
    entries: [
      {
        id: `claude:plugin_command:${MARKETPLACE_ID}:${PLUGIN_NAME}:${COMMAND_NAME}`,
        provider: 'claude',
        kind: 'plugin_command',
        name: COMMAND_NAME,
        displayName: `/${COMMAND_NAME}`,
        description: 'Seeded command',
        insertText: `/${COMMAND_NAME} `,
        invocationKey: `/${COMMAND_NAME}`,
        enableRef: {
          kind: 'plugin',
          marketplaceId: MARKETPLACE_ID,
          pluginName: PLUGIN_NAME,
        },
        sourceLabel: PLUGIN_NAME,
      },
      // The same plugin command as a Cursor chat inserts it: the id the
      // chat's private Cursor root holds for a plugin member.
      {
        id: `cursor:plugin_command:${MARKETPLACE_ID}:${PLUGIN_NAME}:${COMMAND_NAME}`,
        provider: 'cursor',
        kind: 'plugin_command',
        name: COMMAND_NAME,
        displayName: `/${PLUGIN_NAME}-${COMMAND_NAME}`,
        description: 'Seeded command',
        insertText: `/${PLUGIN_NAME}-${COMMAND_NAME} `,
        invocationKey: `/${PLUGIN_NAME}-${COMMAND_NAME}`,
        enableRef: {
          kind: 'plugin',
          marketplaceId: MARKETPLACE_ID,
          pluginName: PLUGIN_NAME,
        },
        sourceLabel: PLUGIN_NAME,
      },
    ],
  });
}

function seedPluginCache(userDataDir) {
  const details = {
    skills: [],
    agents: [],
    commands: [
      {
        name: COMMAND_NAME,
        description: 'Seeded command',
        filePath: 'commands/say-hi.md',
      },
    ],
    apps: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };

  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: '2026-06-20T00:00:00.000Z',
    lastProviderRefreshAt: '2026-06-20T00:00:00.000Z',
    marketplaces: [
      {
        id: MARKETPLACE_ID,
        name: 'Demo Market',
        sourceType: 'github',
        sourceUrl: 'demo/market',
        installLocation: '/tmp/demo-market',
        pluginCount: 1,
        plugins: [
          {
            name: PLUGIN_NAME,
            description: 'Seeded plugin',
            sourcePath: '',
            marketplaceId: MARKETPLACE_ID,
            providerSupport: { claude: 'native', codex: 'none' },
            facets: {
              claude: {
                provider: 'claude',
                mode: 'native',
                name: PLUGIN_NAME,
                installLocation: '',
                sourcePath: '',
                details,
              },
            },
          },
        ],
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: '2026-06-20T00:00:00.000Z',
          },
        },
        validProviders: ['claude'],
      },
    ],
  });
}

function readPersistedPluginRefs(userDataDir) {
  const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  if (
    !existsSync(
      path.join(workspaceRoot, 'chat-storage-manifests', `${WORKTREE_ID}.json`),
    )
  )
    return [];
  const { live: chatFile } = readChatStorageIndexes(workspaceRoot, WORKTREE_ID);
  const activeTab =
    chatFile.tabs.find((tab) => tab.id === chatFile.activeTabId) ??
    chatFile.tabs[0];
  return activeTab?.pluginSelections?.pluginRefs ?? [];
}
