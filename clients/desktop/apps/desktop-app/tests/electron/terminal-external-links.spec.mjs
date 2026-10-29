import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { spawnPanelTerminal } from './panelHarness.mjs';
import { DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';

const CLAUDE_LINK = 'https://example.com/claude-account-help';
const SCHEMELESS_LINK = 'localhost:3000/help';
const WORKSPACE_LINK = 'https://example.com/workspace-help';
const AUTH_KEY = 'terminal-external-links';

async function clickTerminalText(window, locator) {
  // xterm can re-render a row while it is measured, so retry until it has a box.
  let bounds = null;
  await expect(async () => {
    bounds = await locator.boundingBox();
    expect(bounds).not.toBeNull();
  }).toPass();
  await window.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  // xterm's link provider resolves the hovered cell asynchronously.
  await window.waitForTimeout(300);
  await window.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
}

test.describe('terminal interaction and external links', () => {
  test.setTimeout(120_000);

  test('Claude Change account accepts terminal input and opens its link externally', async () => {
    test.skip(
      process.platform === 'win32',
      'The local auth fixture is a POSIX shell script; Windows auth terminal behavior remains unit-covered.',
    );
    const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: AUTH_KEY,
        scenario: { authUsage: { scenario: 'authed-low-usage' } },
      }),
    });
    expect(response.ok).toBe(true);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-claude-account-terminal-'),
    );
    const fixture = path.join(userDataDir, 'claude-auth-fixture');
    writeFileSync(
      fixture,
      [
        '#!/bin/sh',
        'if [ "$#" -ne 2 ] || [ "$1" != auth ] || [ "$2" != login ]; then printf "WRONG_AUTH_COMMAND\\n"; exit 1; fi',
        `printf '\\033]8;;${CLAUDE_LINK}\\007${CLAUDE_LINK}\\033]8;;\\007\\n'`,
        `printf '\\033]8;;${SCHEMELESS_LINK}\\007${SCHEMELESS_LINK}\\033]8;;\\007\\n'`,
        'printf "CLAUDE_AUTH_CODE_PROMPT\\n"',
        'while IFS= read -r line; do printf "RECEIVED:%s\\n" "$line"; done',
      ].join('\n'),
    );
    chmodSync(fixture, 0o755);
    const capture = await startExternalOpenCapture();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...capture.env,
        CANOPY_MOCK_API_KEY: AUTH_KEY,
        CLAUDE_CODE_EXECUTABLE: fixture,
      },
    });
    try {
      const window = await electronApp.firstWindow();
      window.on('dialog', (dialog) => void dialog.dismiss());
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('account');
      const changeAccount = window.getByTestId('auth-panel-claude-connect');
      await expect(changeAccount).toHaveText('Change account', {
        timeout: 20_000,
      });
      await changeAccount.click();
      const terminal = window.getByTestId('auth-login-terminal');
      await expect(terminal).toContainText('CLAUDE_AUTH_CODE_PROMPT');

      await clickTerminalText(window, terminal.getByText(CLAUDE_LINK));
      await expect.poll(() => capture.opened).toContain(CLAUDE_LINK);
      await clickTerminalText(window, terminal.getByText(SCHEMELESS_LINK));
      await expect
        .poll(() => capture.opened)
        .toContain('http://localhost:3000/help');

      // Returning from the browser, the user clicks the auth terminal and
      // pastes the code into the same `claude auth login` PTY.
      await terminal.click({ position: { x: 24, y: 64 } });
      await electronApp.evaluate(({ clipboard }) =>
        clipboard.writeText('test-auth-code-123'),
      );
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+V' : 'Control+V',
      );
      await window.keyboard.press('Enter');
      await expect(terminal).toContainText('RECEIVED:test-auth-code-123');

      await expect(window.getByTestId('auth-login-modal')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
      await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/state/${AUTH_KEY}`, {
        method: 'DELETE',
      }).catch(() => undefined);
    }
  });

  test('workspace terminal opens a printed URL in the external browser', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-terminal-link-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const capture = await startExternalOpenCapture();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: capture.env,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      const pane = await spawnPanelTerminal(window);
      await pane.click();
      // Keep the URL out of the typed command. Typing can start before the
      // prompt, and the shell's redraw can wrap the command line, so only the
      // printed output row may contain the full link.
      const [scheme, address] = WORKSPACE_LINK.split('://');
      await window.keyboard.type(`printf '${scheme}://%s\\n' '${address}'`);
      await window.keyboard.press('Enter');
      const printedLink = pane.getByText(WORKSPACE_LINK, { exact: true });
      await expect(printedLink).toHaveCount(1);
      await clickTerminalText(window, printedLink);
      await expect.poll(() => capture.opened).toContain(WORKSPACE_LINK);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
    }
  });
});
