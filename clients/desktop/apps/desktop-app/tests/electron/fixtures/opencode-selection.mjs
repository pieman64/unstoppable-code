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
import { opencodeRuntimeFixture } from './opencode-runtime.mjs';

export async function launchOpenCodeSelectionFixture({
  approvalMode = 'ask',
  models = [],
  planMode = false,
  seedBeforeLaunch,
  env = {},
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'opencode-selection-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const target = {
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    chatId: 'opencode-selection',
  };
  seedWorktreeChat({
    userDataDir,
    workspaceId: target.projectId,
    worktreeId: target.worktreeId,
    providerType: 'claude',
    tabs: [
      {
        id: target.chatId,
        title: 'OpenCode integration',
        model: 'sonnet',
        approvalMode,
        planMode,
      },
    ],
  });
  seedBeforeLaunch?.({ userDataDir });
  const managed = await opencodeRuntimeFixture({ models });
  const fixtureEnv = {
    ...managed.env,
    XDG_DATA_HOME: path.join(userDataDir, 'opencode-native-data'),
    ...env,
  };
  let launched = await launchCanopy({
    userDataDir,
    env: fixtureEnv,
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
    async connect() {
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await window.getByTestId('opencode-connect').click();
      await expect(window.getByTestId('opencode-connection-status')).toHaveText(
        'OpenCode connected',
      );
      await driver.closeSettings();
    },
    async select() {
      await openChat();
      await window
        .getByTestId('panel-content-chat')
        .getByTestId('chat-model-picker')
        .click();
      await window.getByTestId('chat-model-harness-tab-opencode').click();
      await window
        .getByTestId('chat-model-option-opencode:fixture%2Fmodel')
        .click();
      await expect
        .poll(
          async () =>
            (
              await window.evaluate(
                (target) => window.api.chat.loadTabs(target),
                target,
              )
            ).tabs.find((tab) => tab.id === target.chatId)?.model,
        )
        .toBe('opencode:fixture%2Fmodel');
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
        env: fixtureEnv,
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
