import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  openScriptActionsFixture,
  SCRIPT_CONTEXT,
} from './script-actions-fixture.mjs';

const pending = (dialog, name) =>
  dialog.locator(
    `[data-testid="script-actions-pending-row"][data-script-name="${name}"]`,
  );
const approved = (dialog, name) =>
  dialog.locator(
    `[data-testid="script-actions-approved-row"][data-script-name="${name}"]`,
  );

test('CAN-2050 review, package cwd, aliases, shortcuts, pin reuse and changed definitions', async () => {
  test.setTimeout(180_000);
  const fixture = await openScriptActionsFixture();
  const { window, userDataDir } = fixture;
  const editor = window
    .locator('[data-chat-composer-root]:visible [contenteditable="true"]')
    .first();
  const sessions = () => window.evaluate(() => window.api.terminal.list());
  const scriptSnapshot = () =>
    window.evaluate(
      (context) =>
        window.api.scriptActions.list({ ...context, includeDismissed: true }),
      SCRIPT_CONTEXT,
    );
  try {
    await expect(editor).toBeVisible();
    await editor.fill('!');
    await window.getByTestId('chat-input-scripts-review').click();
    const dialog = window.getByTestId('script-actions-review-dialog');
    await expect(dialog).toBeVisible();
    await expect(pending(dialog, 'record')).toHaveCount(1);
    // Every definition starts pending; review selection only affects checked rows.
    await pending(dialog, 'record')
      .getByTestId('script-actions-row-select')
      .check();
    await pending(dialog, 'hold')
      .getByTestId('script-actions-row-select')
      .check();
    await dialog.getByTestId('script-actions-approve').click();
    await expect(approved(dialog, 'record')).toHaveCount(1);
    await pending(dialog, 'root-check')
      .getByTestId('script-actions-row-select')
      .check();
    await dialog.getByTestId('script-actions-dismiss').click();
    await dialog.getByTestId('script-actions-dismissed-toggle').click();
    await dialog.getByTestId('script-actions-restore').click();
    await expect(pending(dialog, 'root-check')).toHaveCount(1);
    // Home is injected from the registered fixture; never read the user's shell files.
    await dialog.getByTestId('script-actions-scan-shell').click();
    await expect(pending(dialog, 'fixture_status')).toHaveCount(1);
    await expect(
      dialog.getByText('fixture_dynamic', { exact: true }),
    ).toHaveCount(0);
    await pending(dialog, 'fixture_status')
      .getByTestId('script-actions-row-select')
      .check();
    await dialog.getByTestId('script-actions-approve').click();
    const hold = approved(dialog, 'hold');
    await hold.getByTestId('script-actions-shortcut-edit').click();
    const recorder = hold.getByTestId('script-actions-shortcut-input');
    await recorder.press(
      process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
    );
    await expect(
      hold.getByTestId('script-actions-shortcut-validation'),
    ).toContainText('Already used by');
    await recorder.press('Control+Alt+y');
    await hold.getByTestId('script-actions-shortcut-save').click();
    await hold.getByTestId('script-actions-pin').click();
    await expect
      .poll(
        async () =>
          (await scriptSnapshot()).actions.find(
            (action) => action.name === 'hold',
          )?.pinned,
      )
      .toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.fill('!record');
    const count = (await sessions()).length;
    await editor.press('Enter');
    await expect(editor).toContainText('pnpm');
    expect((await sessions()).length).toBe(count);
    await editor.press('End');
    await editor.press('Space');
    await editor.type('extra-argument');
    await editor.press('Enter');
    const packageDir = path.join(
      userDataDir,
      'workspaces',
      SCRIPT_CONTEXT.projectId,
      'worktrees',
      SCRIPT_CONTEXT.worktreeId,
      'repos',
      'repo-a',
      'apps',
      'web',
    );
    await expect
      .poll(() => {
        try {
          return JSON.parse(
            readFileSync(path.join(packageDir, 'recorded.json'), 'utf8'),
          );
        } catch {
          return null;
        }
      })
      .toEqual({ cwd: realpathSync(packageDir), args: ['extra-argument'] });
    // A controllable process holds foreground activity; no timed sleep race.
    const pin = window
      .getByTestId('worktree-top-pin')
      .filter({ hasText: 'hold' })
      .getByRole('button')
      .first();
    await pin.click();
    await expect
      .poll(
        async () =>
          (await sessions()).filter((session) => session.running === true)
            .length,
      )
      .toBeGreaterThan(0);
    const runningCount = (await sessions()).length;
    await pin.click();
    await editor.click();
    await editor.press('Control+Alt+y');
    await expect.poll(async () => (await sessions()).length).toBe(runningCount);
    const running = (await sessions()).find(
      (session) => session.running === true,
    );
    await window.evaluate(
      (terminalId) => window.api.terminal.write({ terminalId, data: '\u0003' }),
      running.id,
    );
    await expect
      .poll(
        async () =>
          (await sessions()).find((session) => session.id === running.id)
            ?.running,
      )
      .toBe(false);
    const packageFile = path.join(packageDir, 'package.json');
    const manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
    manifest.scripts.hold = 'node hold.cjs changed';
    writeFileSync(packageFile, JSON.stringify(manifest));
    await window.evaluate(
      (context) => window.api.scriptActions.rescan(context),
      SCRIPT_CONTEXT,
    );
    await expect
      .poll(
        async () =>
          (await scriptSnapshot()).actions.find(
            (action) => action.name === 'hold',
          )?.status,
      )
      .toBe('pending');
    await expect(
      window.getByRole('button', { name: 'Run hold', exact: true }),
    ).toHaveCount(0);
    await editor.fill('!');
    await window.getByTestId('chat-input-scripts-review').click();
    await expect(pending(dialog, 'hold')).toBeVisible();
    await pending(dialog, 'hold')
      .getByTestId('script-actions-row-select')
      .check();
    await dialog.getByTestId('script-actions-approve').click();
    await expect(approved(dialog, 'hold')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(
      window.getByRole('button', { name: 'Run hold', exact: true }),
    ).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('CAN-2050 a mouse click on Run sends a ! draft while the script menu is open', async () => {
  test.setTimeout(120_000);
  const fixture = await openScriptActionsFixture();
  const { window } = fixture;
  const composer = window.locator('[data-chat-composer-root]:visible').first();
  const editor = composer.locator('[contenteditable="true"]').first();
  try {
    await expect(editor).toBeVisible();
    const count = (await window.evaluate(() => window.api.terminal.list()))
      .length;
    await editor.fill('!echo can-2050-run-click');
    // Detected scripts await review, so the menu offers its review row.
    await expect(window.getByTestId('chat-input-scripts-menu')).toBeVisible();
    await composer
      .getByRole('button', { name: 'Run terminal command', exact: true })
      .click();
    await expect(window.getByTestId('chat-input-scripts-menu')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.terminal.list())).length,
      )
      .toBe(count + 1);
    await expect(editor).not.toContainText('can-2050-run-click');
  } finally {
    await fixture.close();
  }
});

test('CAN-2050 refuses a selected script changed before the watcher rescan', async () => {
  const fixture = await openScriptActionsFixture();
  const { window, electronApp, userDataDir } = fixture;
  try {
    const editor = window
      .locator('[data-chat-composer-root]:visible [contenteditable="true"]')
      .first();
    await editor.fill('!');
    await window.getByTestId('chat-input-scripts-review').click();
    const dialog = window.getByTestId('script-actions-review-dialog');
    await pending(dialog, 'record')
      .getByTestId('script-actions-row-select')
      .check();
    await dialog.getByTestId('script-actions-approve').click();
    await expect(approved(dialog, 'record')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.fill('!record');
    await expect(
      window.getByTestId('chat-input-scripts-row').first(),
    ).toBeVisible();
    await editor.press('Enter');
    await expect(editor).toContainText('pnpm');
    // Hold the one-second watcher debounce so only dispatch can observe the edit.
    await electronApp.evaluate(() => {
      const original = globalThis.setTimeout;
      globalThis.setTimeout = (callback, delay, ...args) =>
        original(callback, delay === 1000 ? 60_000 : delay, ...args);
    });
    const packageFile = path.join(
      userDataDir,
      'workspaces',
      SCRIPT_CONTEXT.projectId,
      'worktrees',
      SCRIPT_CONTEXT.worktreeId,
      'repos',
      'repo-a',
      'apps',
      'web',
      'package.json',
    );
    const manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
    manifest.scripts.record = 'node record.cjs unreviewed';
    writeFileSync(packageFile, JSON.stringify(manifest));
    const cached = await window.evaluate(
      (context) => window.api.scriptActions.list(context),
      SCRIPT_CONTEXT,
    );
    expect(
      cached.actions.find((action) => action.name === 'record')?.status,
    ).toBe('approved');
    const before = await window.evaluate(() => window.api.terminal.list());
    await editor.press('Enter');
    await expect(
      window.getByTestId('chat-input-terminal-mode-error'),
    ).toContainText("Couldn't run: the script changed");
    await expect(editor).toContainText('record');
    expect(
      await window.evaluate(() => window.api.terminal.list()),
    ).toHaveLength(before.length);
    expect(() =>
      readFileSync(path.join(path.dirname(packageFile), 'recorded.json')),
    ).toThrow();
  } finally {
    await fixture.close();
  }
});

test('CAN-2050 successful add retains one operation receipt and shows Review without opening it', async () => {
  test.setTimeout(120_000);
  const fixture = await openScriptActionsFixture();
  const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-script-add-'));
  try {
    const source = fixture.config.repos.find((repo) => repo.id === 'repo-b');
    expect(source).toBeTruthy();
    const repoPath = path.join(root, 'Notice fixture');
    cpSync(source.repoPath, repoPath, { recursive: true });
    const added = await fixture.window.evaluate(
      (request) => window.api.addWorkspaceFromFolder(request),
      { repoPath },
    );
    expect(added.scriptActionsOperationId).toEqual(expect.any(String));
    await expect
      .poll(() =>
        fixture.window.evaluate(
          (request) => window.api.scriptActions.receipt(request),
          { projectId: added.id, operationId: added.scriptActionsOperationId },
        ),
      )
      .toMatchObject({
        operationId: added.scriptActionsOperationId,
        status: 'complete',
        pendingCount: 2,
      });
    const notice = fixture.window
      .locator('[data-toast-id]')
      .filter({ hasText: /Found 2 scripts .* to review/ });
    await expect(notice).toHaveCount(1);
    await expect(notice.getByTestId('toast-action')).toHaveText('Review');
    await expect(
      fixture.window.getByTestId('script-actions-review-dialog'),
    ).toHaveCount(0);
    await fixture.window.evaluate(
      (context) => window.api.scriptActions.rescan(context),
      SCRIPT_CONTEXT,
    );
    await expect(notice).toHaveCount(1);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
