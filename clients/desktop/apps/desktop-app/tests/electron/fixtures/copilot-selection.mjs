import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from '../canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from '../demoWorkspaces.mjs';
import { seedWorktreeChat } from '../seeders/index.mjs';
import { launchCanopy, closeCanopy } from '../launchCanopy.mjs';
import { copilotRuntimeFixture } from './copilot-runtime.mjs';

export async function launchCopilotSelectionFixture({
  approvalMode = 'ask',
  models = [],
  seedBeforeLaunch,
  env = {},
  /** Optional chat plugin selections (e.g. MCP server refs) for the seeded tab. */
  pluginSelections,
} = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'copilot-selection-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const target = {
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    chatId: 'copilot-selection',
  };
  seedWorktreeChat({
    userDataDir,
    workspaceId: target.projectId,
    worktreeId: target.worktreeId,
    providerType: 'claude',
    tabs: [
      {
        id: target.chatId,
        title: 'Copilot integration',
        model: 'sonnet',
        approvalMode,
        ...(pluginSelections ? { pluginSelections } : {}),
      },
    ],
  });
  seedBeforeLaunch?.({ userDataDir });
  const managed = await copilotRuntimeFixture({ models });
  let launched = await launchCanopy({
    userDataDir,
    env: { ...managed.env, ...env },
  });
  let window = await launched.electronApp.firstWindow();
  let driver = new CanopyAppDriver(window);
  const ready = async () => {
    await driver.waitForShell();
  };
  const openChat = async () => {
    await driver.openMainPage();
    await driver.selectWorktree('demo-main', {
      expandDefaultActivityRail: false,
    });
  };
  try {
    await ready();
  } catch (error) {
    await closeCanopy(launched.electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
    throw error;
  }
  return {
    managed,
    userDataDir,
    target,
    worktreePath: seeded.workspaces[0].worktreePath,
    get window() {
      return window;
    },
    get driver() {
      return driver;
    },
    get app() {
      return launched.electronApp;
    },
    get panel() {
      return window.getByTestId('panel-content-chat');
    },
    openChat,
    async connect({ login = 'copilot-fixture' } = {}) {
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await window.getByTestId('copilot-connect').click();
      await managed.approveDeviceCode(window, login);
      await expect(window.getByTestId('copilot-connection-status')).toHaveText(
        'Copilot connected',
      );
      await expect(window.getByTestId('copilot-connection-account')).toHaveText(
        `Signed in as ${login}`,
      );
      await driver.closeSettings();
    },
    approveDeviceCode(login = 'copilot-fixture') {
      return managed.approveDeviceCode(window, login);
    },
    denyDeviceCode() {
      return managed.denyDeviceCode(window);
    },
    async select() {
      await openChat();
      await window
        .getByTestId('panel-content-chat')
        .getByTestId('chat-model-picker')
        .click();
      await window.getByTestId('chat-model-harness-tab-copilot').click();
      await window
        .getByTestId('chat-model-option-copilot:fixture-model')
        .click();
    },
    async send(text) {
      const panel = window.getByTestId('panel-content-chat');
      await panel.getByRole('textbox').first().fill(text);
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    },
    async tab() {
      return (
        await window.evaluate(
          (target) => window.api.chat.loadTabs(target),
          target,
        )
      ).tabs.find((tab) => tab.id === target.chatId);
    },
    async restart() {
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      launched = await launchCanopy({
        userDataDir,
        env: { ...managed.env, ...env },
      });
      window = await launched.electronApp.firstWindow();
      driver = new CanopyAppDriver(window);
      await ready();
    },
    /** Relaunch with extra seeding and environment, e.g. a stored grant. */
    async restartWith({ seed, env: restartEnv } = {}) {
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      seed?.(userDataDir);
      launched = await launchCanopy({
        userDataDir,
        env: { ...managed.env, ...env, ...(restartEnv ?? {}) },
      });
      window = await launched.electronApp.firstWindow();
      driver = new CanopyAppDriver(window);
      await ready();
    },
    async close() {
      await closeCanopy(launched.electronApp, userDataDir);
      await managed.close();
      cleanupDemoWorkspaces(seeded);
    },
  };
}
