// CAN-3084: real menu/dialog commands, canonical persistence and auxiliary focus.
// No agent turns or provider requests are needed for this fixture.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { openPipelineAssistant } from './pipelineAssistant.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const projectId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';
const tabId = 'rename-chat';
const tabTestId = `panel-tab-panel-chat-${tabId}`;

async function openApp(userDataDir) {
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openMainPage();
  await app.selectWorktree(worktreeId);
  await expect(window.getByTestId(tabTestId)).toBeVisible();
  return { ...launched, window };
}

async function openRename(window) {
  await window.getByTestId(tabTestId).click({ button: 'right' });
  await window.getByTestId('panel-tab-context-rename').click();
  await expect(window.getByTestId('chat-tab-rename-input'))
    .toBeFocused()
    .catch(async (error) => {
      await test.info().attach('rename-window.html', {
        body: await window.content(),
        contentType: 'text/html',
      });
      throw error;
    });
}

async function save(window, value) {
  await openRename(window);
  await window.getByTestId('chat-tab-rename-input').fill(value);
  await window.getByTestId('chat-tab-rename-save').click();
  await expect(window.getByTestId('chat-tab-rename-dialog')).toHaveCount(0);
}

test('pinned chat rename survives restart and clear reveals its generated name', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-rename-chat-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    projectId,
    'worktrees.json',
  );
  const index = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  const worktree = index.worktrees.find(
    (candidate) => candidate.id === worktreeId,
  );
  if (!worktree) throw new Error('fixture worktree missing');
  delete worktree.label;
  writeFileSync(worktreesPath, JSON.stringify(index));
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        title: 'Original',
        description: 'Generated name',
        pinned: true,
      },
    ],
  });
  let launched = await openApp(userDataDir);
  try {
    await openRename(launched.window);
    await expect(
      launched.window.getByTestId('chat-tab-rename-input'),
    ).toHaveValue('');
    await expect(
      launched.window.getByTestId('chat-tab-rename-input'),
    ).toHaveAttribute('placeholder', 'Generated name');
    await launched.window
      .getByTestId('chat-tab-rename-input')
      .fill('Cancelled');
    await launched.window.getByTestId('chat-tab-rename-cancel').click();
    await expect(launched.window.getByTestId(tabTestId)).toContainText(
      'Generated name',
    );
    await save(launched.window, '  Release notes  ');
    await expect(launched.window.getByTestId(tabTestId)).toContainText(
      'Release notes',
    );
    await launched.window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+K' : 'Control+K',
    );
    await launched.window
      .getByTestId('command-palette-input')
      .fill('Release notes');
    await expect(
      launched.window
        .getByTestId('command-palette')
        .locator('[data-palette-section="chats"]')
        .getByText('Release notes', { exact: true }),
    ).toBeVisible();
    await launched.window.keyboard.press('Escape');
    await expect
      .poll(async () =>
        (
          await launched.window.evaluate(() => window.api.chatSearch.catalog())
        ).entries.map((entry) => entry.title),
      )
      .toContain('Release notes');
    await launched.window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: true,
      }),
    );
    await expect(
      launched.window.locator(`[data-worktree-id="${worktreeId}"]`).first(),
    ).toContainText('Release notes');
    await launched.window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: false,
      }),
    );
    await expect
      .poll(() =>
        launched.window.evaluate(
          async (scope) =>
            (await window.api.chat.getState(scope)).tabsFile.tabs[0]
              .customTitle,
          { projectId, worktreeId },
        ),
      )
      .toBe('Release notes');
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = await openApp(userDataDir);
    await expect(launched.window.getByTestId(tabTestId)).toContainText(
      'Release notes',
    );
    await launched.window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+K' : 'Control+K',
    );
    await launched.window
      .getByTestId('command-palette-input')
      .fill('Release notes');
    await expect(
      launched.window
        .getByTestId('command-palette')
        .locator('[data-palette-section="chats"]')
        .getByText('Release notes', { exact: true }),
    ).toBeVisible();
    await launched.window.keyboard.press('Escape');
    await expect
      .poll(async () =>
        (
          await launched.window.evaluate(() => window.api.chatSearch.catalog())
        ).entries.map((entry) => entry.title),
      )
      .toContain('Release notes');
    await save(launched.window, '   ');
    await expect(launched.window.getByTestId(tabTestId)).toContainText(
      'Generated name',
    );
    await expect
      .poll(() =>
        launched.window.evaluate(
          async (scope) =>
            (await window.api.chat.getState(scope)).tabsFile.tabs[0]
              .customTitle ?? null,
          { projectId, worktreeId },
        ),
      )
      .toBeNull();
    await expect
      .poll(async () =>
        (
          await launched.window.evaluate(() => window.api.chatSearch.catalog())
        ).entries.filter((entry) => entry.title === 'Release notes'),
      )
      .toEqual([]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a real streaming chat can save and clear without stopping its turn', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-rename-stream-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: projectId,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    activeTabId: tabId,
    tabs: [{ id: tabId, title: 'Working' }],
  });
  const marker = 'Canopy-CRENAMETAB';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: 'Rename while working', streamMs: 120_000 }] },
  });
  const launched = await withBundledBinaryOverridesScrubbed(() =>
    openApp(userDataDir),
  );
  try {
    const composer = launched.window.getByRole('textbox').last();
    await composer.fill(`[${marker}] start a slow turn`);
    await composer.press('Enter');
    const stop = launched.window.getByTestId('chat-stop-generation');
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await save(launched.window, 'Live notes');
    await expect(launched.window.getByTestId(tabTestId)).toContainText(
      'Live notes',
    );
    await expect(stop).toBeVisible();
    await save(launched.window, '');
    await expect(launched.window.getByTestId(tabTestId)).not.toContainText(
      'Live notes',
    );
    await expect(stop).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('auxiliary window owns the rename dialog and restores tab focus', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-rename-aux-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    activeTabId: tabId,
    tabs: [
      { id: tabId, title: 'Original' },
      { id: 'remaining', title: 'Remaining' },
    ],
  });
  const launched = await openApp(userDataDir);
  try {
    const newWindow = launched.electronApp.waitForEvent('window');
    await launched.window.getByTestId(tabTestId).click({ button: 'right' });
    await launched.window.getByTestId('panel-tab-context-new-window').click();
    const aux = await newWindow;
    await expect(aux.getByTestId(tabTestId)).toBeVisible();
    await save(aux, 'Auxiliary name');
    await expect(aux.getByTestId(tabTestId)).toContainText('Auxiliary name');
    await expect(aux.getByTestId(tabTestId))
      .toBeFocused()
      .catch(async (error) => {
        await test.info().attach('aux-focus.json', {
          body: JSON.stringify(
            await aux.evaluate(() => ({
              active: document.activeElement?.outerHTML,
              tabs: [...document.querySelectorAll('[role=tab]')].map((t) => ({
                html: t.outerHTML,
                realm: t instanceof HTMLElement,
              })),
            })),
          ),
          contentType: 'application/json',
        });
        throw error;
      });
    await expect(
      launched.window.getByTestId('chat-tab-rename-dialog'),
    ).toHaveCount(0);
    await save(aux, '');
    await expect(aux.getByTestId(tabTestId)).toContainText('Original');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('classic Pipeline Assistant strip saves, cancels and clears a custom name', async () => {
  test.setTimeout(120_000);
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await openPipelineAssistant(app);
    const tab = window
      .getByTestId('pipeline-chat-tabs')
      .locator('[role="tab"]')
      .first();
    await expect(tab).toBeVisible();
    const label = tab.locator('span[title]').first();
    const originalLabel = await label.getAttribute('title');
    if (!originalLabel) throw new Error('classic tab label missing');
    async function rename(draft) {
      await tab.click({ button: 'right' });
      await window.getByTestId('chat-tab-context-rename').click();
      await expect(window.getByTestId('chat-tab-rename-input')).toBeFocused();
      await window.getByTestId('chat-tab-rename-input').fill(draft);
    }
    await rename('Cancelled');
    await window.keyboard.press('Escape');
    await expect(label).toHaveAttribute('title', originalLabel);
    await rename('Assistant notes');
    await window.getByTestId('chat-tab-rename-save').click();
    await expect(tab).toContainText('Assistant notes');
    await expect(tab).toHaveAccessibleName(/Assistant notes/);
    await rename('');
    await window.getByTestId('chat-tab-rename-save').click();
    await expect(label).toHaveAttribute('title', originalLabel);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
