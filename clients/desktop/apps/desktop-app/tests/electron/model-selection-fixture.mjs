import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

export async function launchPendingModelFixture({ reject = false } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-selection-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    tabs: [{ id: 'original', title: 'Original chat', model: 'gpt-5.6-sol' }],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await window.getByTestId('panel-add-tab-group-chat').click();
    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();
    await selectModelOption(window, 'gpt-5.6-sol');
    await expect(picker).toContainText('GPT 5.6 Sol');
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
      .toBe('gpt-5.6-sol');
    await electronApp.evaluate(({ ipcMain }, reject) => {
      const channel = 'chat:model-change';
      const original = ipcMain._invokeHandlers.get(channel);
      if (typeof original !== 'function') {
        throw new Error('Expected chat:model-change handler to be registered');
      }
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        if (request.model === 'gpt-5.6-luna') {
          await new Promise((resolve) => {
            globalThis.__releasePendingModel = resolve;
          });
          if (reject) return false;
        }
        return original(event, request);
      });
    }, reject);
    await picker.click();
    await selectModelOption(window, 'gpt-5.6-luna');
    await expect
      .poll(() =>
        electronApp.evaluate(() => typeof globalThis.__releasePendingModel),
      )
      .toBe('function');
    return { electronApp, userDataDir, window, picker };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir);
    throw error;
  }
}

export async function releasePendingModel(electronApp) {
  await electronApp.evaluate(() => globalThis.__releasePendingModel?.());
}

/**
 * Reveal a model row in an already-open desktop picker and return its locator.
 * The composer's harness picker keeps hidden copies of each row under every
 * rail tab, so this opens All when it exists and only ever looks at visible
 * rows. Rows the catalog marks `showMoreOnly` sit behind their vendor's
 * Legacy models flyout, so open those rather than assuming the list is flat.
 */
export async function revealModelRow(window, modelId) {
  const menu = window.getByTestId('chat-model-menu');
  await expect(menu).toBeVisible({ timeout: 15_000 });
  const allTab = menu.getByTestId('chat-model-harness-tab-all');
  if ((await allTab.count()) > 0) await allTab.click();
  return revealVisibleRow(window, menu, modelId);
}

/**
 * Pick a model for one harness from an already-open desktop picker. A model
 * more than one harness runs is the same row under each of their rail tabs,
 * so this opens that harness's tab and picks the row there.
 */
export async function selectModelOnHarness(window, modelId, harness) {
  const menu = window.getByTestId('chat-model-menu');
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.getByTestId(`chat-model-harness-tab-${harness}`).click();
  await (await revealVisibleRow(window, menu, modelId)).click();
}

async function revealVisibleRow(window, menu, modelId) {
  const option = window
    .locator(`[data-testid="chat-model-option-${modelId}"]:visible`)
    .first();
  if (await option.isVisible().catch(() => false)) return option;
  // The flyout's own menu shares the prefix; only the triggers are wanted.
  const triggerIds = await menu
    .locator('[data-testid^="chat-model-more-"]:visible')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('data-testid') ?? '')
        .filter((testId) => !testId.startsWith('chat-model-more-group-')),
    );
  for (const testId of triggerIds) {
    await menu.locator(`[data-testid="${testId}"]:visible`).first().click();
    if (await option.isVisible().catch(() => false)) return option;
  }
  throw new Error(`No model option ${modelId} in the picker`);
}

/** Select a model from an already-open desktop picker. */
export async function selectModelOption(window, modelId) {
  await (await revealModelRow(window, modelId)).click();
}
