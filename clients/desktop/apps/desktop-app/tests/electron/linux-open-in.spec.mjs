/** CAN-3213/CAN-3225: real Linux discovery → launcher menu → direct argv spawn.
 * Uses inert Node executables, not a host editor/terminal; no shell, display app,
 * network, or sandbox overrides. Real GNOME editor/terminal acceptance is separate.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

function receipt(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function helper(file, output, stop) {
  writeFileSync(
    file,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid}));\nsetInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0); }, 50);\n`,
  );
  chmodSync(file, 0o700);
}

for (const terminalFixture of [
  { command: 'wezterm', execArgs: ' start --cwd .', args: ['start', '--cwd'] },
  {
    command: 'ptyxis',
    execArgs: ' --new-window',
    args: ['--new-window', '--working-directory'],
  },
  { command: 'kgx', execArgs: '', args: ['--working-directory'] },
]) {
  test(`Linux XDG applications launch safely with ${terminalFixture.command}, refresh stale entries and survive app quit`, async () => {
    test.skip(
      hostOperatingSystem() !== 'linux',
      'Linux runtime fixture; ordinary-user GNOME VM acceptance remains separate',
    );
    const fixture = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-linux-open-in-'),
    );
    const user = path.join(fixture, 'user data');
    const system = path.join(fixture, 'system data');
    const stop = path.join(fixture, 'stop');
    const editorReceipt = path.join(fixture, 'editor.json');
    const terminalReceipt = path.join(fixture, 'terminal.json');
    const editor = path.join(fixture, 'fixture editor');
    const terminal = path.join(fixture, terminalFixture.command);
    const applications = path.join(user, 'applications');
    mkdirSync(applications, { recursive: true });
    mkdirSync(path.join(system, 'applications'), { recursive: true });
    helper(editor, editorReceipt, stop);
    helper(terminal, terminalReceipt, stop);
    const desktop = `[Desktop Entry]\nType=Application\nName=Fixture Editor\nCategories=TextEditor;\nExec="${editor}" %F\n`;
    writeFileSync(path.join(applications, 'fixture-editor.desktop'), desktop);
    writeFileSync(
      path.join(system, 'applications/fixture-editor.desktop'),
      desktop.replace('Fixture Editor', 'System duplicate'),
    );
    writeFileSync(
      path.join(applications, 'fixture-terminal.desktop'),
      `[Desktop Entry]\nType=Application\nName=Fixture Terminal\nCategories=TerminalEmulator;\nExec="${terminal}"${terminalFixture.execArgs}\n`,
    );
    let launched;
    try {
      launched = await launchCanopy({
        seedDemoWorkspaces: true,
        demoWorkspaceApps: ['ts-pnpm-vite'],
        env: { XDG_DATA_HOME: user, XDG_DATA_DIRS: system },
      });
      const { electronApp } = launched;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree('demo-main', {
        expandDefaultActivityRail: false,
      });
      await window.getByTestId('worktree-open-trigger').click();
      await expect(
        window.getByTestId('worktree-open-app-linux:fixture-editor.desktop'),
      ).toHaveText('Fixture Editor');
      await window
        .getByTestId('worktree-open-app-linux:fixture-editor.desktop')
        .click();
      await expect.poll(() => receipt(editorReceipt)).not.toBeNull();
      const editorLaunch = receipt(editorReceipt);
      expect(editorLaunch.args).toEqual([editorLaunch.cwd]);
      await window.getByTestId('worktree-open-trigger').click();
      await window
        .getByTestId('worktree-open-app-linux:fixture-terminal.desktop')
        .click();
      await expect.poll(() => receipt(terminalReceipt)).not.toBeNull();
      const terminalLaunch = receipt(terminalReceipt);
      expect(terminalLaunch.args).toEqual([
        ...terminalFixture.args,
        editorLaunch.cwd,
      ]);
      expect(terminalLaunch.cwd).toBe(editorLaunch.cwd);

      // A new user tombstone must prevent the cached selection from launching a
      // lower-priority entry; the shared renderer recovery message is unchanged.
      writeFileSync(
        path.join(applications, 'fixture-editor.desktop'),
        `${desktop}Hidden=true\n`,
      );
      await expect(
        window.evaluate(async () => {
          try {
            await window.api.openInApp({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
              appId: 'linux:fixture-editor.desktop',
            });
            return '';
          } catch (error) {
            return String(error);
          }
        }),
      ).resolves.toContain('no longer available');
      expect(
        await window.evaluate(async () =>
          (await window.api.refreshDetectedApps()).map((entry) => entry.id),
        ),
      ).not.toContain('linux:fixture-editor.desktop');

      const closed = electronApp.waitForEvent('close');
      await electronApp
        .evaluate(({ app: electron }) => {
          electron.quit();
        })
        .catch(() => {});
      await closed;
      expect(() => process.kill(editorLaunch.pid, 0)).not.toThrow();
      expect(() => process.kill(terminalLaunch.pid, 0)).not.toThrow();
    } finally {
      // Ask only our inert fixtures to exit. Never signal a host application or
      // rely on Canopy's managed-process cleanup to own external GUI launches.
      writeFileSync(stop, 'stop');
      if (launched)
        await closeCanopy(launched.electronApp, launched.userDataDir);
      const fixturePids = [
        receipt(editorReceipt)?.pid,
        receipt(terminalReceipt)?.pid,
      ].filter((pid) => Number.isInteger(pid) && pid > 0);
      await expect
        .poll(() =>
          fixturePids.every((pid) => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if (error.code === 'ESRCH') return true;
              throw error;
            }
          }),
        )
        .toBe(true);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
