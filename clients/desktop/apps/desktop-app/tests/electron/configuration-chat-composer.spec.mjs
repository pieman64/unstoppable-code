// Configured chat prompts use the same command and file-reference interactions
// as Home. Seeded repositories and inventory keep this independent of live
// accounts, agents, and network services.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  revealRowActions,
  saveWorkflowEdit,
} from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedAutomations,
  seedCoworkWorkspace,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { openProjectSettingsPage } from './projectSettingsDriver.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const MARKETPLACE_ID = 'demo/market';
const PLUGIN_NAME = 'available-plugin';
const COMMAND_NAME = 'say-hi';

// Keystrokes sent within milliseconds of focus leaving the worktree picker
// can miss Chromium's select-all, so retry the clear until the prompt is empty.
async function clearComposer(editor) {
  await editor.click();
  await expect(editor).toBeFocused();
  await expect(async () => {
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
    await expect(editor.locator('[data-slate-placeholder]')).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 15_000 });
}

function seedAvailableCommand(userDataDir) {
  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    version: 2,
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
    ],
  });
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
                details: {
                  skills: [],
                  agents: [],
                  apps: [],
                  hooks: [],
                  mcpServers: [],
                  lspServers: [],
                  hasReadme: false,
                  commands: [
                    {
                      name: COMMAND_NAME,
                      description: 'Seeded command',
                      filePath: 'commands/say-hi.md',
                    },
                  ],
                },
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

async function openNewCodeAutomation(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openAutomationsPage();
  await app.startNewWorkflow('schedule');
  await window.getByTestId('automations-form-name').fill('Configured chat');
  // A new workflow opens as a pipeline with no project; choosing a project
  // keeps Pipeline mode, so pick Chat.
  await window.getByTestId('automations-form-action-type-workspace').click();
  await window.getByTestId('automations-form-workspace').click();
  await window.getByRole('option').first().click();
  await window
    .getByTestId('automations-form-workspace-action-mode-chat')
    .click();
  await expect(window.getByTestId('automations-form-prompt')).toBeVisible();
  return window.getByTestId('automations-form-prompt');
}

test('new-chat automation enables a chosen slash command and saves its invocation', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-config-composer-command-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedAutomations({ userDataDir, activities: [] });
  seedAvailableCommand(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const editor = await openNewCodeAutomation(window);
    await expect(editor).toBeVisible();
    await editor.fill(`/${COMMAND_NAME}`);
    const menu = window.getByTestId('automations-form-prompt-plus-menu');
    await expect(menu).toBeVisible();
    await menu
      .getByTestId(`automations-form-prompt-capability-${COMMAND_NAME}`)
      .click();
    await expect(editor).toContainText(`/${COMMAND_NAME}`);
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    const saved = JSON.parse(
      readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
    ).activities[0];
    expect(saved.action).toMatchObject({
      type: 'worktree_prompt',
      workspaceId: WORKSPACE_ID,
      prompt: expect.stringContaining(`/${COMMAND_NAME}`),
    });
    expect(saved.action.pluginSelections?.pluginRefs).toContainEqual({
      marketplaceId: MARKETPLACE_ID,
      pluginName: PLUGIN_NAME,
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('new-chat automation retains an @ file pill through save and reopen without an upload', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-config-composer-file-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedAutomations({ userDataDir, activities: [] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const editor = await openNewCodeAutomation(window);
    await expect(editor).toBeVisible();
    // Clicking the rich editor must focus it without activating the + button.
    await editor.click();
    await editor.pressSequentially('Summarize @README');
    const menu = window.getByTestId('automations-form-prompt-plus-menu');
    await expect(menu).toBeVisible();
    await menu
      .getByTestId('automations-form-prompt-file-result')
      .filter({ hasText: 'README.md' })
      .first()
      .click();
    await expect(
      window
        .getByTestId('workflow-edit-shell')
        .getByTestId('file-reference-pill'),
    ).toHaveCount(1);
    await editor.press('End');
    await editor.press('Enter');
    await expect(window.getByTestId('workflow-edit-shell')).toBeVisible();
    const blockedFiles = await editor.evaluate((node) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(['image data'], 'pasted.png', { type: 'image/png' }),
      );
      const paste = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
      const drop = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      node.dispatchEvent(paste);
      node.dispatchEvent(drop);
      return { paste: paste.defaultPrevented, drop: drop.defaultPrevented };
    });
    expect(blockedFiles).toEqual({ paste: true, drop: true });
    await expect(
      window
        .getByTestId('workflow-edit-shell')
        .getByTestId('file-reference-pill'),
    ).toHaveCount(1);
    await window.getByTestId('automations-form-prompt-plus-button').click();
    await expect(
      window.getByTestId('automations-form-prompt-plus-attachment'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('automations-form-prompt-plus-linear'),
    ).toHaveCount(0);
    await window.getByTestId('automations-form-prompt-plus-button').click();
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    const saved = JSON.parse(
      readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
    ).activities[0];
    expect(saved.action.prompt).toContain('README.md');
    expect(saved.action.promptReferences).toHaveLength(1);
    const [reference] = saved.action.promptReferences;
    expect(reference).toMatchObject({
      kind: 'file',
      root: { kind: 'workspace' },
      relativePath: 'README.md',
      textStart: expect.any(Number),
      displayText: expect.stringContaining('README.md'),
    });
    expect(
      saved.action.prompt.slice(
        reference.textStart,
        reference.textStart + reference.displayText.length,
      ),
    ).toBe(reference.displayText);
    expect(JSON.stringify(saved.action)).not.toContain('absolutePath');
    expect(JSON.stringify(saved.action)).not.toContain(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID),
    );
    const app = new CanopyAppDriver(window);
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow(saved.id),
    );
    await expect(
      window
        .getByTestId('workflow-edit-shell')
        .getByTestId('file-reference-pill'),
    ).toHaveCount(1);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('new-chat automation file results follow project default and selected worktree', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-config-composer-context-'),
  );
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const workspace = seeded.workspaces.find(
    (entry) => entry.id === WORKSPACE_ID,
  );
  if (!workspace?.repoPath || !workspace.worktreePath)
    throw new Error('Missing seeded repository roots');
  writeFileSync(
    path.join(workspace.repoPath, 'context-default-only.md'),
    'default branch file\n',
  );
  writeFileSync(
    path.join(workspace.worktreePath, 'context-worktree-only.md'),
    'selected worktree file\n',
  );
  seedAutomations({ userDataDir, activities: [] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const editor = await openNewCodeAutomation(window);
    const menu = window.getByTestId('automations-form-prompt-plus-menu');
    const fileRows = menu.getByTestId('automations-form-prompt-file-result');
    await editor.fill('@context');
    await expect(
      fileRows.filter({ hasText: 'context-default-only.md' }),
    ).toBeVisible();
    await expect(
      fileRows.filter({ hasText: 'context-worktree-only.md' }),
    ).toHaveCount(0);

    await editor.press('Escape');
    await expect(menu).toBeHidden();
    await window.getByTestId('automations-form-base-worktree').click();
    await window.getByRole('option').last().click();
    await editor.fill('');
    await editor.fill('@context');
    await expect(
      fileRows.filter({ hasText: 'context-worktree-only.md' }),
    ).toBeVisible();
    await expect(
      fileRows.filter({ hasText: 'context-default-only.md' }),
    ).toHaveCount(0);

    await editor.press('Escape');
    await expect(menu).toBeHidden();
    await window.getByTestId('automations-form-base-worktree').click();
    await window.getByRole('option', { name: 'Project default' }).click();
    await editor.fill('@context-default');
    await fileRows.filter({ hasText: 'context-default-only.md' }).click();
    await expect(
      window
        .getByTestId('workflow-edit-shell')
        .getByTestId('file-reference-pill'),
    ).toHaveCount(1);
    await window.getByTestId('automations-form-base-worktree').click();
    await window.getByRole('option').last().click();
    await expect(window.getByTestId('automations-form-submit')).toBeDisabled();
    await window
      .getByTestId('automations-form-workspace-action-mode-pipeline')
      .click();
    await expect(window.getByTestId('automations-form-submit')).toBeEnabled();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('existing-chat automation searches the destination chat worktree', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-config-composer-chat-context-'),
  );
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const workspace = seeded.workspaces.find(
    (entry) => entry.id === WORKSPACE_ID,
  );
  if (!workspace?.repoPath || !workspace.worktreePath)
    throw new Error('Missing seeded repository roots');
  writeFileSync(
    path.join(workspace.repoPath, 'context-default-only.md'),
    'default branch file\n',
  );
  writeFileSync(
    path.join(workspace.worktreePath, 'context-chat-worktree.md'),
    'target chat file\n',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'destination-chat',
        title: 'Destination chat',
        messages: [],
        providerType: 'codex',
      },
    ],
    activeTabId: 'destination-chat',
  });
  seedAutomations({ userDataDir, activities: [] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const editor = await openNewCodeAutomation(window);
    const fileRows = window
      .getByTestId('automations-form-prompt-plus-menu')
      .getByTestId('automations-form-prompt-file-result');
    await editor.fill('@context');
    await expect(
      fileRows.filter({ hasText: 'context-default-only.md' }),
    ).toBeVisible();
    await expect(
      fileRows.filter({ hasText: 'context-chat-worktree.md' }),
    ).toHaveCount(0);

    await editor.press('Escape');
    await expect(
      window.getByTestId('automations-form-prompt-plus-menu'),
    ).toBeHidden();
    await clearComposer(editor);
    const menu = window.getByTestId('automations-form-prompt-plus-menu');
    if (await menu.isVisible()) await editor.press('Escape');
    await expect(menu).toBeHidden();
    await window.getByTestId('automations-form-run-in-existing_chat').click();
    await window.getByTestId('automations-form-chat-target-worktree').click();
    await window.getByRole('option').first().click();
    await window.getByTestId('automations-form-chat-target-chat').click();
    await window.getByRole('option', { name: 'Destination chat' }).click();
    await expect(window.getByText('Open chat', { exact: true })).toBeVisible();
    await expect(
      window.getByTestId('automations-form-prompt-composer').getByRole('alert'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('automations-form-prompt-plus-button'),
    ).toBeEnabled();
    await editor.click({ position: { x: 20, y: 12 } });
    if (await menu.isVisible()) await editor.press('Escape');
    await expect(menu).toBeHidden();
    await editor.pressSequentially('@context');
    await expect(editor).toHaveText('@context');
    await expect(
      fileRows.filter({ hasText: 'context-chat-worktree.md' }),
    ).toBeVisible();
    await expect(
      fileRows.filter({ hasText: 'context-default-only.md' }),
    ).toHaveCount(0);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('cowork automation searches the live cowork directory', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-config-composer-cowork-'),
  );
  const { workspaceId } = seedCoworkWorkspace({
    userDataDir,
    name: 'Live Cowork',
  });
  const coworkHome = path.join(userDataDir, 'workspaces', workspaceId, 'home');
  mkdirSync(coworkHome, { recursive: true });
  writeFileSync(
    path.join(coworkHome, 'context-cowork-live.md'),
    'live cowork file\n',
  );
  seedAutomations({ userDataDir, activities: [] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openAutomationsPage();
    await app.startNewWorkflow('schedule');
    await window
      .getByTestId('automations-form-name')
      .fill('Cowork file search');
    // A new workflow opens as a pipeline with no project; choosing a
    // project keeps Pipeline mode, so pick Chat.
    await window.getByTestId('automations-form-action-type-workspace').click();
    await window.getByTestId('automations-form-workspace').click();
    await window.getByRole('option', { name: 'Live Cowork' }).click();
    await window
      .getByTestId('automations-form-workspace-action-mode-chat')
      .click();
    const editor = window.getByTestId('automations-form-prompt');
    await expect(editor).toBeVisible();
    await editor.fill('@context-cowork');
    await expect(
      window
        .getByTestId('automations-form-prompt-plus-menu')
        .getByTestId('automations-form-prompt-file-result')
        .filter({ hasText: 'context-cowork-live.md' }),
    ).toBeVisible();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('hook source follows selected worktree while local override searches the default root', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-config-composer-hook-'),
  );
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const workspace = seeded.workspaces.find(
    (entry) => entry.id === WORKSPACE_ID,
  );
  if (!workspace?.repoPath || !workspace.worktreePath)
    throw new Error('Missing seeded repository roots');
  writeFileSync(
    path.join(workspace.repoPath, 'context-default-only.md'),
    'default branch file\n',
  );
  writeFileSync(
    path.join(workspace.worktreePath, 'context-worktree-only.md'),
    'selected worktree file\n',
  );
  writeJson(path.join(workspace.repoPath, 'canopy.json'), {
    version: 1,
    hooks: { 'pr:create': [{ type: 'chat', prompt: 'Source hook prompt.' }] },
  });
  writeJson(path.join(workspace.worktreePath, 'canopy.json'), {
    version: 1,
    hooks: { 'pr:create': [{ type: 'chat', prompt: 'Source hook prompt.' }] },
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.hooks = {
    'pr:create': [{ type: 'chat', prompt: 'Local hook prompt.' }],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // The temporary sole-project action can detach when the regular sidebar
    // row hydrates. Wait for that stable row before revealing its settings.
    const settingsButton = app.workspaceSettingsButton('TypeScript pnpm Vite');
    await expect(settingsButton).toBeAttached();
    await revealRowActions(window, settingsButton);
    await settingsButton.click();
    const settings = window.getByRole('dialog', {
      name: 'TypeScript pnpm Vite',
    });
    // Hooks live on Scripts and hooks; each hook opens on its own page.
    await openProjectSettingsPage(app, 'scripts');
    const openHook = async () => {
      await settings
        .getByTestId('project-settings-hook-pr:create')
        .getByRole('button', { name: 'Edit' })
        .click();
    };
    const backToScripts = async () => {
      await settings.getByTestId('settings-page-back').click();
    };
    await settings.getByTestId('project-settings-scope-source').click();
    await openHook();
    const sourcePrompt = settings
      .locator('[data-testid^="hook-chat-"][contenteditable="true"]')
      .filter({ hasText: 'Source hook prompt.' });
    await expect(sourcePrompt).toHaveCount(1);
    let sourceId = await sourcePrompt.getAttribute('data-testid');
    let sourceEditor = settings.getByTestId(sourceId);
    await sourceEditor.fill('@context');
    let sourceRows = window
      .getByTestId(`${sourceId}-plus-menu`)
      .getByTestId(`${sourceId}-file-result`);
    await expect(
      sourceRows.filter({ hasText: 'context-default-only.md' }),
    ).toBeVisible();
    await expect(
      sourceRows.filter({ hasText: 'context-worktree-only.md' }),
    ).toHaveCount(0);

    await sourceEditor.press('Escape');
    await expect(window.getByTestId(`${sourceId}-plus-menu`)).toBeHidden();
    await backToScripts();
    await window.getByTestId('source-worktree-picker-trigger').click();
    await window
      .getByTestId('source-worktree-picker-menu')
      .getByRole('option')
      .last()
      .click();
    await openHook();
    const selectedSourcePrompt = settings.locator(
      '[data-testid^="hook-chat-"][contenteditable="true"]',
    );
    await expect(selectedSourcePrompt).toHaveCount(1);
    sourceId = await selectedSourcePrompt.getAttribute('data-testid');
    sourceEditor = settings.getByTestId(sourceId);
    sourceRows = window
      .getByTestId(`${sourceId}-plus-menu`)
      .getByTestId(`${sourceId}-file-result`);
    await clearComposer(sourceEditor);
    await sourceEditor.pressSequentially('@context');
    await expect(
      sourceRows.filter({ hasText: 'context-worktree-only.md' }),
    ).toBeVisible();
    await expect(
      sourceRows.filter({ hasText: 'context-default-only.md' }),
    ).toHaveCount(0);

    await sourceEditor.press('Escape');
    await expect(window.getByTestId(`${sourceId}-plus-menu`)).toBeHidden();
    await backToScripts();
    await settings.getByTestId('project-settings-scope-local').click();
    await openHook();
    const localPrompt = settings
      .locator('[data-testid^="hook-chat-"][contenteditable="true"]')
      .filter({ hasText: 'Local hook prompt.' });
    await expect(localPrompt).toHaveCount(1);
    const localId = await localPrompt.getAttribute('data-testid');
    const localEditor = settings.getByTestId(localId);
    await clearComposer(localEditor);
    await localEditor.pressSequentially('@context');
    const localRows = window
      .getByTestId(`${localId}-plus-menu`)
      .getByTestId(`${localId}-file-result`);
    await expect(
      localRows.filter({ hasText: 'context-default-only.md' }),
    ).toBeVisible();
    await expect(
      localRows.filter({ hasText: 'context-worktree-only.md' }),
    ).toHaveCount(0);
    await localEditor.press('Escape');
    await expect(window.getByTestId(`${localId}-plus-menu`)).toBeHidden();
    await window.getByTestId(`${localId}-plus-button`).click();
    await expect(window.getByTestId(`${localId}-plus-menu`)).toBeVisible();
    await expect(window.getByTestId(`${localId}-plus-attachment`)).toHaveCount(
      0,
    );
    await expect(window.getByTestId(`${localId}-plus-linear`)).toHaveCount(0);

    await localEditor.press('Escape');
    await expect(window.getByTestId(`${localId}-plus-menu`)).toBeHidden();
    await expect(settings).toBeVisible();
    await backToScripts();
    await settings.getByTestId('project-settings-add-hook').click();
    let addHook = settings.getByTestId('hook-add-form');
    await expect(addHook).toHaveCount(1);
    await addHook.locator('select').nth(1).selectOption('chat');
    let draft = addHook.locator(
      '[data-testid^="hook-chat-draft-"][contenteditable="true"]',
    );
    await expect(draft).toBeVisible();
    await draft.fill('First drafted action.');
    await addHook.getByRole('button', { name: 'Add action' }).click();
    // The new hook opens on its own page with the added action.
    await expect(
      settings
        .locator('[data-testid^="hook-chat-"][contenteditable="true"]')
        .filter({ hasText: 'First drafted action.' }),
    ).toHaveCount(1);
    await settings.getByTestId('hook-add-another').click();
    addHook = settings.getByTestId('hook-add-form');
    await addHook.locator('select').nth(1).selectOption('chat');
    draft = addHook.locator(
      '[data-testid^="hook-chat-draft-"][contenteditable="true"]',
    );
    await expect(draft).toBeVisible();
    await draft.fill('Second drafted action.');
    await addHook.getByRole('button', { name: 'Add action' }).click();
    await expect(draft.locator('[data-slate-placeholder]')).toBeVisible();
    await expect(
      settings
        .locator('[data-testid^="hook-chat-"][contenteditable="true"]')
        .filter({ hasText: 'Second drafted action.' }),
    ).toHaveCount(1);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// 'Orchestrator' is ORCHESTRATOR_LABEL; .mjs specs cannot import the constant.
for (const destination of [
  'new project chat',
  'existing project chat',
  'Orchestrator',
]) {
  test(`automation ${destination} opens file mentions after clicking the prompt`, async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-config-composer-click-mention-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    if (destination === 'existing project chat') {
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: 'demo-main',
        tabs: [
          {
            id: 'mention-target',
            title: 'Mention target',
            messages: [],
            providerType: 'codex',
          },
        ],
        activeTabId: 'mention-target',
      });
    }
    if (destination === 'Orchestrator') {
      const advisorHome = path.join(
        userDataDir,
        'app-workspaces',
        'app-advisor',
        'home',
      );
      mkdirSync(advisorHome, { recursive: true });
      writeFileSync(
        path.join(advisorHome, 'mention-advisor.md'),
        'Advisor mention fixture\n',
      );
    }
    seedAutomations({ userDataDir, activities: [] });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openAutomationsPage();
      await app.startNewWorkflow('schedule');
      // A new workflow opens as a pipeline with no project, so every
      // destination is chosen explicitly; a project keeps Pipeline mode
      // until Chat is picked.
      if (destination === 'Orchestrator') {
        await window
          .getByTestId('automations-form-action-type-app_advisor')
          .click();
      } else {
        await window
          .getByTestId('automations-form-action-type-workspace')
          .click();
        await window.getByTestId('automations-form-workspace').click();
        await window.getByRole('option').first().click();
        await window
          .getByTestId('automations-form-workspace-action-mode-chat')
          .click();
      }
      if (destination === 'existing project chat') {
        await window
          .getByTestId('automations-form-run-in-existing_chat')
          .click();
        await window
          .getByTestId('automations-form-chat-target-worktree')
          .click();
        await window.getByRole('option').first().click();
        await window.getByTestId('automations-form-chat-target-chat').click();
        await window.getByRole('option', { name: 'Mention target' }).click();
      }

      const editor = window.getByTestId('automations-form-prompt');
      const menu = window.getByTestId('automations-form-prompt-plus-menu');
      const expectedFile =
        destination === 'Orchestrator' ? 'mention-advisor.md' : 'README.md';
      await expect(editor).toBeVisible();
      await editor.click();
      // A click on the editor must not activate its neighboring + button.
      await expect(menu).toBeHidden();
      await editor.pressSequentially(`@${expectedFile.slice(0, 6)}`);
      await expect(editor).toContainText(`@${expectedFile.slice(0, 6)}`);
      await expect(
        menu
          .getByTestId('automations-form-prompt-file-result')
          .filter({ hasText: expectedFile }),
      ).toBeVisible();
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
