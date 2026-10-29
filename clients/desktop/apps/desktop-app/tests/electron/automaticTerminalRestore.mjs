// Shared by the durable terminal regression and its one-shot visual captures.
// Seed a shutdown shell, fail only its first automatic restore at the real IPC
// boundary, then reveal the same mounted panel to retry against the real PTY.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TERMINAL_ID = 'automatic-restore-terminal';
const PANEL_ID = 'panel-terminal-automatic-restore';
const CHAT_ID = 'automatic-restore-chat';
const GROUP_ID = 'group-automatic-restore';
export const AUTOMATIC_RESTORE_FAILURE =
  'The saved shell is temporarily unavailable. Try revealing this terminal again.';

function seedRestorableTerminal() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automatic-terminal-restore-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    tabs: [{ id: CHAT_ID, title: 'Chat' }],
  });
  const dataDir = path.join(
    userDataDir,
    'workspaces',
    PROJECT_ID,
    'worktree-data',
    WORKTREE_ID,
  );
  mkdirSync(dataDir, { recursive: true });
  const shell =
    process.platform === 'win32'
      ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe')
      : '/bin/bash';
  const write = (name, value) =>
    writeFileSync(path.join(dataDir, name), JSON.stringify(value), 'utf8');
  write('terminal-state.json', {
    version: 1,
    drawerCollapsed: false,
    groups: [
      {
        id: 'restored-terminal-group',
        terminalIds: [TERMINAL_ID],
        focusedTerminalId: TERMINAL_ID,
        splitSizes: [1],
      },
    ],
    activeGroupId: 'restored-terminal-group',
    nextGroupOrdinal: 2,
    groupOrdinals: { 'restored-terminal-group': 1 },
    terminalCustomNames: { [TERMINAL_ID]: 'Recovered shell' },
    groupCustomNames: {},
    terminals: [
      {
        session: {
          id: TERMINAL_ID,
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          shell,
          shellBasename: path.basename(shell),
          cwd: demo.workspaces[0].worktreePath,
          createdAt: 1,
        },
        scrollbackLines: ['canopy-history-before-automatic-restore', ''],
        exitCode: null,
        signal: 'app-quit',
      },
    ],
  });
  write('panel-layout-mode.json', { version: 1, mode: 'advanced' });
  write('panel-layout.json', {
    version: 1,
    grid: {
      orientation: 1,
      width: 1200,
      height: 800,
      root: {
        type: 'leaf',
        groupId: GROUP_ID,
        size: 1200,
        panels: [
          {
            panelId: `panel-chat-${CHAT_ID}`,
            kind: 'chat',
            instance: { chatTabId: CHAT_ID },
          },
          {
            panelId: PANEL_ID,
            kind: 'terminal',
            instance: { terminalId: TERMINAL_ID },
          },
        ],
        activePanelId: `panel-chat-${CHAT_ID}`,
      },
    },
    activeGroupId: GROUP_ID,
    mostRecentActiveGroupIds: [GROUP_ID],
  });
  return userDataDir;
}

export async function withAutomaticTerminalRestore(verifyRecovered) {
  const userDataDir = seedRestorableTerminal();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    // Observe requests without mocking session/store state. Only the first
    // restore is rejected; all subsequent attempts invoke the original handler.
    await electronApp.evaluate(
      ({ ipcMain }, { terminalId, reason }) => {
        const original = ipcMain._invokeHandlers.get('terminal:restore');
        if (!original) throw new Error('terminal:restore handler is missing');
        globalThis.__automaticRestoreAttempts = [];
        ipcMain.removeHandler('terminal:restore');
        ipcMain.handle('terminal:restore', async (event, request) => {
          if (request.terminalId !== terminalId)
            return original(event, request);
          const attempts = globalThis.__automaticRestoreAttempts;
          attempts.push({ terminalId: request.terminalId, status: 'pending' });
          const attempt = attempts.at(-1);
          if (attempts.length === 1) {
            attempt.status = 'failed';
            throw new Error(`Terminal shell unavailable: ${reason}`);
          }
          const session = await original(event, request);
          attempt.status = 'restored';
          return session;
        });
      },
      { terminalId: TERMINAL_ID, reason: AUTOMATIC_RESTORE_FAILURE },
    );
    await app.selectWorktree(WORKTREE_ID, { expandDefaultActivityRail: false });
    const terminalTab = window.getByTestId(`panel-tab-${PANEL_ID}`);
    const chatTab = window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`);
    await terminalTab.click();
    const surface = window.locator(
      `[data-testid="terminal-panel-surface"][data-panel-id="${PANEL_ID}"]`,
    );
    const pane = surface.getByTestId('terminal-pane');
    const error = surface.getByTestId('terminal-panel-error');
    await expect(error).toHaveText(AUTOMATIC_RESTORE_FAILURE);
    await expect(pane.getByTestId('terminal-restart-button')).toBeVisible();
    await expect(pane).toContainText('canopy-history-before-automatic-restore');
    const surfaceHandle = await surface.elementHandle();

    // Never click Restart: that handler already clears the error and would
    // produce a false-green regression. Tab selection toggles restoreOnMount
    // while the owning surface (and its stale local error state) stays mounted.
    await chatTab.click();
    await expect(pane).toBeHidden();
    expect(await surfaceHandle.evaluate((node) => node.isConnected)).toBe(true);
    await terminalTab.click();
    expect(
      await surface.evaluate(
        (node, original) => node === original,
        surfaceHandle,
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__automaticRestoreAttempts),
      )
      .toEqual([
        { terminalId: TERMINAL_ID, status: 'failed' },
        { terminalId: TERMINAL_ID, status: 'restored' },
      ]);
    // The read-only bar disappearing is the real renderer session.live signal;
    // PTY list plus executed output independently prove backend recovery.
    await expect(pane.getByTestId('terminal-restart-button')).toBeHidden();
    await expect
      .poll(() => window.evaluate(() => window.api.terminal.list()))
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ id: TERMINAL_ID })]),
      );
    await pane.click();
    await window.keyboard.type('echo canopy-automatic-restore-live');
    await window.keyboard.press('Enter');
    await expect
      .poll(() => pane.innerText())
      .toMatch(/\ncanopy-automatic-restore-live\n/);
    await expect(pane).toContainText('canopy-history-before-automatic-restore');
    await verifyRecovered({ window, surface, pane, error });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}
