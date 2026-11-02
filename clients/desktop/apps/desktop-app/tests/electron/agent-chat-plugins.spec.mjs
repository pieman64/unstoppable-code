import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { attachMainProcessLog } from './mainProcessLog.mjs';
import { seedPluginsCache, seedWorktreeChat } from './seeders/index.mjs';

import {
  seedPluginActivityLogos,
  stubPluginActivityLogoResolution,
} from './seeders/seedPluginActivityLogos.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import {
  openProjectSettingsPage,
  waitForProjectSettingsSaved,
} from './projectSettingsDriver.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const AGENT_ID = 'agent_model_locked_plugin';
const MARKETPLACE_ID = 'demo/market';
const PLUGIN_NAME = 'delta-tool';

function seedMentionInventory(userDataDir) {
  const { cacheFilePath } = seedPluginsCache({ userDataDir });
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  const plugin = cache.marketplaces[0].plugins.find(
    (entry) => entry.name === PLUGIN_NAME,
  );
  plugin.facets.claude = {
    provider: 'claude',
    mode: 'native',
    name: PLUGIN_NAME,
    sourcePath: plugin.sourcePath,
    details: { ...plugin.details },
  };
  plugin.facets.claude.details.commands = [
    {
      name: 'delta-command',
      description: 'Delta command',
      filePath: 'commands/delta-command.md',
    },
  ];
  writeFileSync(cacheFilePath, JSON.stringify(cache));
  writeFileSync(
    path.join(userDataDir, 'invocable-inventory-cache.json'),
    JSON.stringify({
      version: 3,
      builtAt: '2026-06-20T00:00:00.000Z',
      entries: [
        {
          id: `claude:plugin_command:${MARKETPLACE_ID}:${PLUGIN_NAME}:delta-command`,
          provider: 'claude',
          kind: 'plugin_command',
          name: 'delta-command',
          displayName: '/delta-command',
          description: 'Delta command',
          insertText: '/delta-command ',
          invocationKey: '/delta-command',
          enableRef: {
            kind: 'plugin',
            marketplaceId: MARKETPLACE_ID,
            pluginName: PLUGIN_NAME,
          },
          sourceLabel: PLUGIN_NAME,
        },
      ],
    }),
  );
}

test('plugin commands enable the plugin for the current chat and Activity can remove it', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-plugin-mentions-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMentionInventory(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    await window.evaluate(async () => {
      const preferences = await window.api.loadPreferences();
      // Save only the changed key: `preferences:save` rejects a payload that
      // carries `approvalDefaults`, which a full loaded object always does.
      await window.api.savePreferences({
        inAppNotifications: {
          ...preferences.inAppNotifications,
          enabled: false,
        },
      });
    });
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const input = window.locator('[data-chat-textarea]').first();
    await input.fill('/delta');
    const menu = window.getByTestId('chat-input-plus-menu');
    await expect(
      menu.getByTestId('chat-input-capability-delta-command'),
    ).toBeVisible();
    // Check unavailable entries only after the catalog has actually loaded.
    await input.fill('@alpha');
    await expect(
      menu.getByText('alpha-tool', { exact: true }),
    ).not.toBeVisible();
    await input.fill('/delta');
    await expect(
      menu.getByTestId('chat-input-capability-delta-command'),
    ).toBeVisible();
    await menu.getByTestId('chat-input-capability-delta-command').click();
    await expect
      .poll(() => readPersistedPluginRefs(userDataDir))
      .toContainEqual({
        marketplaceId: MARKETPLACE_ID,
        pluginName: PLUGIN_NAME,
      });
    const card = window.getByTestId('chat-plugins-activity');
    await expect(card).toBeVisible();
    await expect(
      window
        .getByTestId('activity-section-plugins')
        .getByText('Plugins', { exact: true }),
    ).toBeVisible();
    await expect(card).not.toContainText('Available tools may be discovered');
    await expect(card.locator('[data-activity-item-row]')).toHaveCount(1);
    await expect(card.getByTestId('activity-plugin-icon')).toBeVisible({
      timeout: 1500,
    });
    await expect(card.getByTestId('activity-plugin-icon')).toHaveText('D');
    await expect(card.getByText('delta-tool', { exact: true })).toBeVisible();
    const pluginTitle = window
      .getByTestId('activity-section-plugins')
      .locator('[data-panel-section-title-row]');
    await pluginTitle.click();
    await expect(pluginTitle).toHaveAttribute('aria-expanded', 'false');
    const addPlugin = window
      .getByTestId('activity-section-plugins')
      .getByRole('button', { name: 'Add plugins', exact: true });
    await expect(addPlugin).toBeVisible();
    await addPlugin.click();
    const picker = window
      .getByRole('dialog')
      .filter({ has: window.getByPlaceholder('Search by name…') });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(picker).toBeHidden();
    await pluginTitle.click();

    const remove = card.getByRole('button', {
      name: 'Remove delta-tool from this chat',
    });
    await expect(remove).toHaveText('Remove');
    await remove.hover();
    await expect(window.getByRole('tooltip')).toHaveText(
      'Remove from this chat',
    );
    await remove.click();
    await expect.poll(() => readPersistedPluginRefs(userDataDir)).toEqual([]);
    // Simulate a missing composer receiver while the empty card stays mounted.
    await window.evaluate(() => {
      document.addEventListener(
        'canopy:composer-action',
        (event) => event.stopImmediatePropagation(),
        { capture: true, once: true },
      );
    });
    await window
      .getByTestId('activity-section-plugins')
      .getByRole('button', { name: 'Add plugins', exact: true })
      .click();
    await expect(picker).toBeHidden();
    const pickerError = window
      .getByTestId('toast-card')
      .filter({ hasText: 'Open this chat to add plugins.' });
    await expect(pickerError).toBeVisible();
    await pickerError.getByRole('button', { name: 'Dismiss' }).click();
    // A per-chat rejection must suppress a global default without removing it
    // from preferences or affecting other chats.
    await window.evaluate(async () => {
      await window.api.savePreferences({
        globalPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: 'demo/market', pluginName: 'delta-tool' },
          ],
        },
      });
    });
    await expect(card.getByText('delta-tool', { exact: true })).toBeVisible();

    await card
      .getByRole('button', { name: 'Remove delta-tool from this chat' })
      .click();
    await expect(
      card.getByText('delta-tool', { exact: true }),
    ).not.toBeVisible();
    await expect
      .poll(
        () =>
          readPersistedActiveTab(userDataDir)?.disabledGlobalPluginSelections
            ?.pluginRefs,
      )
      .toContainEqual({
        marketplaceId: MARKETPLACE_ID,
        pluginName: PLUGIN_NAME,
      });
    expect(
      await window.evaluate(
        async () =>
          (await window.api.loadPreferences()).globalPluginSelections
            ?.pluginRefs,
      ),
    ).toContainEqual({
      marketplaceId: MARKETPLACE_ID,
      pluginName: PLUGIN_NAME,
    });
    // The full picker remains available during the activity-card transition.
    await window.getByTestId('chat-input-plus-button').click();
    await window.getByTestId('chat-plugins-button').click();
    await expect(window.getByTestId('plugin-picker-region')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('activity card adds plugins from empty and populated states', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-plugin-add-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedPluginsCache({ userDataDir });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const section = window.getByTestId('activity-section-plugins');
    const add = section.getByTestId('activity-plugins-add');
    await expect(add).toBeVisible();
    await expect(section).not.toContainText('No plugins added');
    await expect(section.locator('[aria-expanded]')).toHaveCount(0);
    await expect(
      section.getByTestId('body-only-section-action-card'),
    ).toBeVisible();
    await expect(add).toHaveText('Add plugins');
    await expect(
      section.getByRole('button', { name: 'Add plugins', exact: true }),
    ).toHaveCount(1);
    await add.click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ hasText: 'Plugins' });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Search by name…').fill(PLUGIN_NAME);
    await dialog
      .getByRole('checkbox', { name: `Select ${PLUGIN_NAME}`, exact: true })
      .check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(section.getByText(PLUGIN_NAME, { exact: true })).toBeVisible();
    await add.click();
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Search by name…').fill(PLUGIN_NAME);
    await expect(
      dialog.getByRole('checkbox', {
        name: `Select ${PLUGIN_NAME}`,
        exact: true,
      }),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await section
      .getByRole('button', { name: `Remove ${PLUGIN_NAME} from this chat` })
      .click();
    await expect(
      section.getByRole('button', { name: 'Add plugins', exact: true }),
    ).toHaveCount(1);
    await expect(section).not.toContainText('No plugins added');
    await expect(section.locator('[aria-expanded]')).toHaveCount(0);
    await expect(
      section.getByTestId('body-only-section-action-card'),
    ).toBeVisible();
    await expect(add).toHaveText('Add plugins');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Home plugin commands update the draft and the retained picker', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-plugin-mentions-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMentionInventory(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const home = await app.openHomeForProject(WORKSPACE_ID);
    const editor = home.getByTestId('home-composer-editor');
    await editor.fill('/delta');
    await window
      .getByTestId('home-composer-plus-menu')
      .getByTestId('home-composer-capability-delta-command')
      .click();
    await expect(editor).toContainText('/delta-command');
    await home.getByTestId('home-composer-plus-button').click();
    await window.getByTestId('home-plugins-button').click();
    const picker = window.getByTestId('plugin-picker-region');
    await expect(
      picker
        .locator('tr')
        .filter({ hasText: 'delta-tool' })
        .getByRole('checkbox'),
    ).toBeChecked();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('project plugin settings explain catalog sources and the scope of defaults', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-plugin-provenance-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedPluginsCache({ userDataDir });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.workspaceHeaderLabel('TypeScript pnpm Vite').hover();
    await app.workspaceSettingsButton('TypeScript pnpm Vite').click();
    const dialog = window.getByRole('dialog');
    await openProjectSettingsPage(app, 'plugins');
    const explanation = dialog.getByTestId('workspace-plugin-scope-help');
    await expect(explanation).toHaveText(
      'Defaults for every chat in this project. A chat can still turn one off.',
    );
    await explanation
      .getByRole('button', { name: 'How project defaults work' })
      .hover();
    const details = window.getByTestId('workspace-plugin-scope-help-details');
    await expect(details).toContainText('plugin marketplaces');
    await expect(details).toContainText(
      'Selections apply to every chat in this project, including existing chats',
    );
    await expect(details).toContainText('A chat can still turn a default off');
    await expect(details).toContainText('do not install plugins');
    // The plugin table opens from the page's "Plugins for new chats" row.
    await dialog.getByTestId('project-settings-choose-chat-plugins').click();
    await expect(dialog.getByTestId('plugin-selector-scope')).toHaveText(
      'Provider scope: All supported providers',
    );
    await expect(
      dialog.getByRole('group', { name: 'Selection filter' }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('project default plugins apply live to existing chats and each chat can turn them off', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-live-project-default-plugins-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedPluginsCache({ userDataDir });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'rejects-default',
    tabs: [
      { id: 'rejects-default', title: 'Rejects default', messages: [] },
      { id: 'inherits-default', title: 'Inherits default', messages: [] },
    ],
  });
  const pluginRef = { marketplaceId: MARKETPLACE_ID, pluginName: PLUGIN_NAME };
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const section = window.getByTestId('activity-section-plugins');
    const pluginRow = section
      .locator('[data-activity-item-row]')
      .filter({ hasText: PLUGIN_NAME });
    await expect(section.getByTestId('activity-plugins-add')).toBeVisible();
    await expect(pluginRow).toHaveCount(0);

    const setProjectDefault = async (enabled) => {
      await app.workspaceHeaderLabel('TypeScript pnpm Vite').hover();
      await app.workspaceSettingsButton('TypeScript pnpm Vite').click();
      const settings = window.getByRole('dialog');
      await openProjectSettingsPage(app, 'plugins');
      await settings
        .getByTestId('project-settings-choose-chat-plugins')
        .click();
      await settings.getByPlaceholder('Search by name…').fill(PLUGIN_NAME);
      const checkbox = settings.getByRole('checkbox', {
        name: `Select ${PLUGIN_NAME}`,
        exact: true,
      });
      if (enabled) await checkbox.check();
      else await checkbox.uncheck();
      // The page saves the choice as it is made; Back closes it.
      await waitForProjectSettingsSaved(app);
      await settings.getByTestId('project-settings-back').click();
      await expect(settings).toHaveCount(0);
    };

    // Adding a project default reaches the chat that already exists.
    await setProjectDefault(true);
    await expect(pluginRow).toBeVisible();
    await expect(
      pluginRow.getByTestId('activity-plugin-avatar'),
    ).toHaveAttribute('data-inherited-default', 'project');
    await expect(pluginRow.locator('[title*="Project default"]')).toHaveCount(
      1,
    );
    expect(
      readPersistedTab(userDataDir, 'rejects-default')?.pluginSelections
        ?.pluginRefs ?? [],
    ).not.toContainEqual(pluginRef);

    // Both seeded chats can keep a composer mounted; use the visible one.
    await window
      .locator('[data-testid="chat-input-plus-button"]:visible')
      .click();
    await window.getByTestId('chat-plugins-button').click();
    const picker = window
      .getByRole('dialog')
      .filter({ has: window.getByTestId('plugin-picker-region') });
    await expect(picker).toBeVisible();
    await picker.getByPlaceholder('Search by name…').fill(PLUGIN_NAME);
    const pickerRow = picker.locator('tr').filter({ hasText: PLUGIN_NAME });
    await expect(pickerRow.getByRole('checkbox')).toBeChecked();
    await expect(pickerRow).toContainText('Project default');
    // The row is built through the shared picker rows (REG-3042): desktop
    // records no unavailable capability, so it stays toggleable with no
    // status or Remove action.
    await expect(pickerRow.getByRole('checkbox')).toBeEnabled();
    await expect(
      picker.getByTestId('portal-plugins-remove-unavailable'),
    ).toHaveCount(0);
    await picker.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(picker).toHaveCount(0);

    // Turning it off in one chat records a durable chat-level rejection.
    await pluginRow
      .getByRole('button', { name: `Remove ${PLUGIN_NAME} from this chat` })
      .click();
    await expect(pluginRow).toHaveCount(0);
    await expect
      .poll(
        () =>
          readPersistedTab(userDataDir, 'rejects-default')
            ?.disabledGlobalPluginSelections?.pluginRefs ?? [],
      )
      .toContainEqual(pluginRef);
    expect(
      readPersistedTab(userDataDir, 'rejects-default')?.pluginSelections
        ?.pluginRefs ?? [],
    ).not.toContainEqual(pluginRef);

    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(section.getByTestId('activity-plugins-add')).toBeVisible();
    await expect(pluginRow).toHaveCount(0);

    // A chat that only inherits the default still has it.
    await window.getByTestId('panel-tab-panel-chat-inherits-default').click();
    await expect(pluginRow).toBeVisible();
    await expect(
      pluginRow.getByTestId('activity-plugin-avatar'),
    ).toHaveAttribute('data-inherited-default', 'project');

    // Removing the project default removes it from that chat too.
    await setProjectDefault(false);
    await expect(pluginRow).toHaveCount(0);
    expect(
      readPersistedTab(userDataDir, 'inherits-default')?.pluginSelections
        ?.pluginRefs ?? [],
    ).not.toContainEqual(pluginRef);

    // The rejection outlives the default it rejected.
    await window.getByTestId('panel-tab-panel-chat-rejects-default').click();
    await expect(pluginRow).toHaveCount(0);
    expect(
      readPersistedTab(userDataDir, 'rejects-default')
        ?.disabledGlobalPluginSelections?.pluginRefs ?? [],
    ).toContainEqual(pluginRef);
  } catch (error) {
    // CI has failed with the project default never reaching the existing chat
    // while it passes locally. Record whether main stamped the seeded tabs and
    // what it logged, so the next failure shows which side lost the update.
    await test.info().attach('persisted-tabs', {
      body: JSON.stringify(
        ['rejects-default', 'inherits-default'].map((tabId) => {
          const tab = readPersistedTab(userDataDir, tabId);
          return {
            tabId,
            inheritedPluginDefaultsVersion: tab?.inheritedPluginDefaultsVersion,
            pluginSelections: tab?.pluginSelections,
            disabledGlobalPluginSelections: tab?.disabledGlobalPluginSelections,
          };
        }),
        null,
        2,
      ),
      contentType: 'application/json',
    });
    await attachMainProcessLog(userDataDir);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a global default the project turned off stays off until a chat picks it', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-project-disabled-global-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedPluginsCache({ userDataDir });
  const pluginRef = { marketplaceId: MARKETPLACE_ID, pluginName: PLUGIN_NAME };
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...JSON.parse(readFileSync(configPath, 'utf8')),
        disabledGlobalPluginSelections: { pluginRefs: [pluginRef] },
      },
      null,
      2,
    ),
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(async (ref) => {
      await window.api.savePreferences({
        globalPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [ref],
        },
      });
    }, pluginRef);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const section = window.getByTestId('activity-section-plugins');
    const pluginRow = section
      .locator('[data-activity-item-row]')
      .filter({ hasText: PLUGIN_NAME });
    await expect(section.getByTestId('activity-plugins-add')).toBeVisible();
    await expect(pluginRow).toHaveCount(0);

    await section.getByTestId('activity-plugins-add').click();
    const picker = window
      .getByRole('dialog')
      .filter({ has: window.getByTestId('plugin-picker-region') });
    await expect(picker).toBeVisible();
    await picker.getByPlaceholder('Search by name…').fill(PLUGIN_NAME);
    const pickerRow = picker.locator('tr').filter({ hasText: PLUGIN_NAME });
    const checkbox = picker.getByRole('checkbox', {
      name: `Select ${PLUGIN_NAME}`,
      exact: true,
    });
    await expect(checkbox).not.toBeChecked();
    await expect(pickerRow).not.toContainText('Global default');

    // Picking it in this chat makes it the chat's own, not an inherited one.
    await checkbox.check();
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(pluginRow).toBeVisible();
    await expect(
      pluginRow.getByTestId('activity-plugin-avatar'),
    ).not.toHaveAttribute('data-inherited-default');
    await expect
      .poll(() => readPersistedPluginRefs(userDataDir))
      .toContainEqual(pluginRef);
    expect(
      readPersistedActiveTab(userDataDir)?.disabledGlobalPluginSelections
        ?.pluginRefs ?? [],
    ).not.toContainEqual(pluginRef);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

function seedAgentModels(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  const agent = {
    id: AGENT_ID,
    name: 'Locked Plugin Agent',
    baseModel: 'sonnet',
    instructions: 'Use the inherited plugin.',
    pluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: MARKETPLACE_ID, pluginName: PLUGIN_NAME }],
      mcpServerRefs: [],
    },
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
  const filePath = path.join(userDataDir, 'agent-models.json');
  writeFileSync(
    filePath,
    `${JSON.stringify({ version: 1, agents: [agent] }, null, 2)}\n`,
    'utf8',
  );
}

function readPersistedActiveTab(userDataDir) {
  const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  if (
    !existsSync(
      path.join(workspaceRoot, 'chat-storage-manifests', `${WORKTREE_ID}.json`),
    )
  )
    return null;
  const { live: chatFile } = readChatStorageIndexes(workspaceRoot, WORKTREE_ID);
  return (
    chatFile.tabs.find((tab) => tab.id === chatFile.activeTabId) ??
    chatFile.tabs[0] ??
    null
  );
}

function readPersistedTab(userDataDir, tabId) {
  const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  if (
    !existsSync(
      path.join(workspaceRoot, 'chat-storage-manifests', `${WORKTREE_ID}.json`),
    )
  )
    return null;
  const { live: chatFile } = readChatStorageIndexes(workspaceRoot, WORKTREE_ID);
  return chatFile.tabs.find((tab) => tab.id === tabId) ?? null;
}

function readPersistedPluginRefs(userDataDir) {
  return (
    readPersistedActiveTab(userDataDir)?.pluginSelections?.pluginRefs ?? []
  );
}

function expandPluginCatalog(cacheFilePath) {
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  const marketplace = cache.marketplaces[0];
  const template = marketplace.plugins[0];
  const overflowRows = Array.from({ length: 30 }, (_, index) => ({
    ...template,
    name: `scroll-test-tool-${String(index).padStart(2, '0')}`,
    description: `Scrollable plugin row ${index}`,
  }));
  marketplace.plugins.push(...overflowRows);
  marketplace.pluginCount = marketplace.plugins.length;
  marketplace.providerStatus.claude.pluginCount = marketplace.plugins.length;
  writeFileSync(cacheFilePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

test('Plugin picker scrolls while Agent-inherited plugins stay checked, locked, and tab-exclusive', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-chat-plugins-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const { cacheFilePath } = seedPluginsCache({ userDataDir });
  expandPluginCatalog(cacheFilePath);
  seedAgentModels(userDataDir);

  const { electronApp } = await launchCanopy({
    userDataDir,
    // This scenario exercises the plugin picker, not compact-composer
    // behavior. Keep enough horizontal room for the model picker to remain
    // mounted after the measured toolbar compression introduced by CAN-2799.
    viewportSize: { width: 1100, height: 830 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.getByTestId('chat-model-picker').click();
    const agentOption = window.getByTestId(`chat-model-option-${AGENT_ID}`);
    await expect(agentOption).toBeVisible();
    await expect(agentOption).not.toHaveAttribute('aria-disabled', 'true');
    await agentOption.click();
    await expect
      .poll(() => readPersistedActiveTab(userDataDir)?.model)
      .toBe(AGENT_ID);

    await window.getByTestId('chat-input-plus-button').click();
    await window.getByTestId('chat-plugins-button').click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ hasText: 'Plugins' });
    await expect(dialog).toBeVisible();
    const tableScroller = dialog.locator('table').locator('..');
    await expect
      .poll(() =>
        tableScroller.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);

    const dialogBox = await dialog.boundingBox();
    const viewport = window.viewportSize();
    expect(dialogBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );

    await tableScroller.hover();
    await window.mouse.wheel(0, 500);
    await expect
      .poll(() => tableScroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await dialog.getByPlaceholder('Search by name…').fill(PLUGIN_NAME);
    const checkbox = dialog.getByRole('checkbox', {
      name: `Select ${PLUGIN_NAME}`,
    });
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeDisabled();
    await expect(checkbox).toHaveAttribute('data-toggle-mode', 'locked');
    await checkbox.evaluate((element) => element.click());
    await expect(checkbox).toBeChecked();

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => readPersistedPluginRefs(userDataDir), {
        message: 'Agent-only plugin should not persist as a tab-owned plugin',
      })
      .toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('plugin activity shows app logos and falls back for broken images', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-plugin-logos-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedPluginActivityLogos(userDataDir);
  mkdirSync(path.join(userDataDir, 'collections'), { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'collections', 'index.json'),
    JSON.stringify({
      version: 2,
      collections: [
        {
          id: 'c418a324-a5a9-4734-ab07-e0a1634c27d3',
          name: 'Design tools',
          description: '',
          updatedAt: '2026-09-01T00:00:00Z',
          skillCount: 0,
          pluginCount: 0,
          mcpServerCount: 0,
        },
      ],
    }),
  );

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'logos',
    tabs: [
      {
        id: 'logos',
        title: 'Plugin logos',
        messages: [],
        pluginSelections: {
          collectionIds: ['c418a324-a5a9-4734-ab07-e0a1634c27d3'],
          skillRefs: [],
          mcpServerRefs: [
            { serverId: 'curated-slack', configId: 'default' },
            { serverId: 'curated-figma', configId: 'default' },
          ],
          pluginRefs: [
            { marketplaceId: MARKETPLACE_ID, pluginName: 'delta-tool' },
            { marketplaceId: MARKETPLACE_ID, pluginName: 'gamma-tool' },
          ],
        },
      },
    ],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    await stubPluginActivityLogoResolution(electronApp);
    const window = await electronApp.firstWindow();
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const rows = window
      .getByTestId('chat-plugins-activity')
      .locator('[data-activity-item-row]');
    await expect(rows.filter({ hasText: 'Design tools' })).toBeVisible();
    await expect(rows.filter({ hasText: 'c418a324' })).toHaveCount(0);
    const slack = rows.filter({ hasText: 'Slack' });
    await expect(slack.getByTestId('activity-plugin-logo')).toBeVisible();
    await expect
      .soft(slack.getByTestId('activity-plugin-logo'))
      .toHaveAttribute('src', /^data:image\/svg/);
    const figma = rows.filter({ hasText: 'Figma' });
    await expect.soft(figma.getByTestId('activity-plugin-logo')).toBeVisible();
    await expect.soft(figma.getByTestId('activity-plugin-icon')).toHaveCount(0);
    for (const row of [slack, figma, rows.filter({ hasText: 'gamma-tool' })]) {
      const alignment = await row.evaluate((element) => {
        const avatar = element
          .querySelector('[data-testid="activity-plugin-avatar"]')
          .getBoundingClientRect();
        const label = element
          .querySelector(':scope > span:nth-child(2)')
          .getBoundingClientRect();
        const button = element.querySelector('button').getBoundingClientRect();
        return {
          avatar: avatar.y + avatar.height / 2,
          label: label.y + label.height / 2,
          button: button.y + button.height / 2,
        };
      });
      expect.soft(Math.abs(alignment.avatar - alignment.label)).toBeLessThan(1);
      expect
        .soft(Math.abs(alignment.avatar - alignment.button))
        .toBeLessThan(1);
    }
    await expect(rows.filter({ hasText: 'curated-' })).toHaveCount(0);
    await slack
      .getByRole('button', { name: 'Remove Slack from this chat' })
      .click();
    await expect(slack).toHaveCount(0);
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(slack).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Figma' })).toBeVisible();
    const appRow = rows.filter({ hasText: 'Delta Tools' });
    await expect(appRow.getByTestId('activity-plugin-logo')).toBeVisible({
      timeout: 2000,
    });
    await expect
      .poll(() =>
        appRow
          .locator('img')
          .evaluate((img) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    const broken = rows.filter({ hasText: 'gamma-tool' });
    await expect(broken.getByTestId('activity-plugin-icon')).toHaveText('G');
    await expect(broken.locator('img')).toHaveCount(0);
    await appRow
      .getByRole('button', { name: 'Remove Delta Tools from this chat' })
      .click();
    await expect(appRow).toHaveCount(0);
    await expect(broken).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
