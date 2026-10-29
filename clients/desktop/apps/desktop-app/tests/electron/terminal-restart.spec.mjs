// Terminal readonly restart regression coverage.
//
// A normally exited shell remains visible as readonly synthetic history. The
// inline Restart terminal action must restore that same terminal id, replay
// its prior scrollback plus the synthetic restart marker, and accept new input.
// The demo workspace is local and the commands use only the spawned shell, so
// the flow is deterministic and requires no live agent or network access.

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { spawnPanelTerminal } from './panelHarness.mjs';
import { withAutomaticTerminalRestore } from './automaticTerminalRestore.mjs';

test('clears a shell-unavailable error after automatic restore succeeds on reveal', async () => {
  test.setTimeout(120_000);
  await withAutomaticTerminalRestore(async ({ window, pane, error }) => {
    await expect(error).toBeHidden();
    // Recovery must clear the saved failure, not merely hide it while live.
    // A later ordinary shell exit must not resurrect the previous error.
    await pane.click();
    await window.keyboard.type('exit');
    await window.keyboard.press('Enter');
    await expect(pane.getByTestId('terminal-restart-button')).toBeVisible();
    await expect(pane).toContainText('The shell exited with code 0.');
    await expect(error).toBeHidden();
  });
});

test('restarts a readonly terminal and preserves its synthetic history', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-terminal-restart-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const pane = await spawnPanelTerminal(window);
    await expect(pane).toBeVisible();
    await pane.click();
    await window.keyboard.type('echo canopy-history-before-restart');
    await window.keyboard.press('Enter');
    await expect
      .poll(() => pane.innerText(), { timeout: 20_000 })
      .toContain('canopy-history-before-restart');

    await window.keyboard.type('exit');
    await window.keyboard.press('Enter');
    const restart = pane.getByTestId('terminal-restart-button');
    await expect(restart).toBeVisible({ timeout: 20_000 });
    await restart.click();

    await expect(restart).toBeHidden({ timeout: 20_000 });
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => pane.innerText(), { timeout: 20_000 })
      .toContain('canopy-history-before-restart');
    await expect
      .poll(() => pane.innerText(), { timeout: 20_000 })
      .toContain('[Terminal restarted]');

    await pane.click();
    await window.keyboard.type('echo canopy-restarted-live');
    await window.keyboard.press('Enter');
    await expect
      .poll(() => pane.innerText(), { timeout: 20_000 })
      .toContain('canopy-restarted-live');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('recovers a terminal after its Windows input socket reports EOF', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-terminal-pipe-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });
  const faultPath = testInfo.outputPath('terminal-pipe.log');
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await electronApp.evaluate(({ app }, faultPath) => {
      const fs = process.getBuiltinModule('fs');
      const { createRequire } = process.getBuiltinModule('module');
      const require = createRequire(`${app.getAppPath()}/package.json`);
      const { EventEmitter } = process.getBuiltinModule('events');
      const windows = process.platform === 'win32';
      const Terminal = windows
        ? require('node-pty/lib/windowsTerminal').WindowsTerminal
        : require('node-pty/lib/unixTerminal').UnixTerminal;
      const prototype = Terminal.prototype;
      const write = prototype._write;
      const input = new EventEmitter();
      // The host uses a real Unix PTY. Add the pinned Windows dependency's
      // separate input-socket shape before PtyManager registers the session.
      if (!windows) prototype._agent = { inSocket: input };
      process.on('uncaughtExceptionMonitor', (error) =>
        fs.appendFileSync(faultPath, `${error.stack}\n`),
      );
      prototype._write = function () {
        prototype._write = write;
        const socket = this._agent.inSocket;
        if (!windows) delete prototype._agent;
        fs.appendFileSync(faultPath, 'Injected terminal stdin EOF\n');
        setImmediate(() =>
          socket.emit(
            'error',
            Object.assign(new Error('write EOF'), {
              code: 'EOF',
              syscall: 'write',
            }),
          ),
        );
      };
    }, faultPath);
    const pane = await spawnPanelTerminal(window);
    await expect(pane).toBeVisible();
    await pane.click();
    await window.keyboard.press('x');
    await expect
      .poll(() => {
        try {
          return readFileSync(faultPath, 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('Injected terminal stdin EOF');
    const restart = pane.getByTestId('terminal-restart-button');
    await expect(restart).toBeVisible({ timeout: 20_000 });
    await restart.click();
    await expect(restart).toBeHidden({ timeout: 20_000 });
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await pane.click();
    await window.keyboard.type('echo recovered-input-pipe');
    await window.keyboard.press('Enter');
    await expect.poll(() => pane.innerText()).toContain('recovered-input-pipe');
    expect(readFileSync(faultPath, 'utf8')).toBe(
      'Injected terminal stdin EOF\n',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
