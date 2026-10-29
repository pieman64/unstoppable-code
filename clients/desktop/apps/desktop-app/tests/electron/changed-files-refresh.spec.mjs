import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'changed-files-refresh-tab';
const FILE_NAME = 'README.md';
const INITIAL_DIRTY_FILE_NAME = 'INITIAL_DIRTY.txt';
const EDIT_MARKER = ' CHANGED_FILES_REFRESH_E2E';
const SAVE_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Compares a status dot's painted color with a theme role. The role is resolved
 * through a probe element, so the check follows the active theme instead of
 * pinning a hex value or a class name.
 */
function dotColors(dot, roleVariable) {
  return dot.evaluate((element, variable) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${variable})`;
    document.body.append(probe);
    const role = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      matches: getComputedStyle(element).backgroundColor === role,
      resolved: role !== 'rgba(0, 0, 0, 0)',
    };
  }, roleVariable);
}

/**
 * Regression coverage for git-refresh convergence. A successful in-app save
 * already requests an immediate scoped diff-stat refresh. Changed Files must
 * join that refresh instead of waiting for its independent ten-second poll.
 *
 * The disposable dirty file makes the initial Changed Files snapshot visible.
 * After it loads, the synthetic blur stops only the periodic renderer poll,
 * the fixture removes that file, and an in-app save creates a different
 * change. The local git reads and UI updates are otherwise the real user flow
 * and require no network.
 */
test('Changed Files converges with the immediate git refresh after a file save', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-changed-files-refresh-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const filePath = path.join(worktreePath, FILE_NAME);
  const initialDirtyFilePath = path.join(worktreePath, INITIAL_DIRTY_FILE_NAME);
  writeFileSync(
    initialDirtyFilePath,
    'initial changed-files fixture\n',
    'utf8',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: FILE_NAME,
        kind: 'file',
        filePath,
        fileViewMode: 'raw',
        description: filePath,
        messages: [],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const changedFiles = window.getByTestId('changed-files-section');
    await expect(changedFiles).toBeVisible({ timeout: 20_000 });
    await expect(changedFiles).toContainText(INITIAL_DIRTY_FILE_NAME, {
      timeout: 20_000,
    });
    await expect(changedFiles).not.toContainText(FILE_NAME);

    // The fixture file is untracked. A new file reads as new whether or not
    // git tracks it yet, so its dot paints with the same success role as an
    // added file instead of a fixed palette color.
    const untrackedDot = changedFiles.getByTitle('Untracked', { exact: true });
    await expect(untrackedDot).toBeVisible();
    expect(await dotColors(untrackedDot, '--bg-success')).toEqual({
      matches: true,
      resolved: true,
    });

    // Freeze the independent polling path so this assertion proves that the
    // save-triggered git refresh itself keeps Changed Files synchronized.
    await window.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
    });
    rmSync(initialDirtyFilePath);

    const editor = window.getByTestId('monaco-file-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.click();
    await window.keyboard.type(EDIT_MARKER);
    await window.keyboard.press(`${SAVE_MODIFIER}+s`);

    await expect
      .poll(() => readFileSync(filePath, 'utf8'), { timeout: 10_000 })
      .toContain(EDIT_MARKER);

    await expect(changedFiles).toContainText(FILE_NAME, { timeout: 5_000 });
    await expect(changedFiles).not.toContainText(INITIAL_DIRTY_FILE_NAME);

    // The saved file is a modified file. Its status dot paints with the
    // warning role, so it follows the theme instead of a fixed palette color.
    const modifiedDot = changedFiles.getByTitle('Modified', { exact: true });
    await expect(modifiedDot).toBeVisible();
    expect(await dotColors(modifiedDot, '--bg-warning')).toEqual({
      matches: true,
      resolved: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Renamed, copied, and type-changed are identities, not states. Their dots
// take intent inks whose hues are fixed in every theme (renamed and copied
// the info blue, type-changed the special purple), like the run states.
test('Changed Files paints a renamed file with the renamed role', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-changed-files-renamed-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  // A staged rename is what git reports as renamed.
  execFileSync('git', ['mv', 'src/status.ts', 'src/status-renamed.ts'], {
    cwd: worktreePath,
    stdio: 'pipe',
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const changedFiles = window.getByTestId('changed-files-section');
    await expect(changedFiles).toBeVisible({ timeout: 20_000 });
    const renamedDot = changedFiles.getByTitle('Renamed', { exact: true });
    await expect(renamedDot).toBeVisible({ timeout: 20_000 });
    expect(await dotColors(renamedDot, '--fg-info')).toEqual({
      matches: true,
      resolved: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Changed Files lists local state, so it must not wait on the network. Here the
 * multi-repo worktree's remote is a local server that answers 401, so git asks
 * a credential helper, and the only helper blocks for longer than the
 * assertion waits. That is what the self-hosted macOS pool does with a
 * github.com fixture remote. Offline and deterministic.
 */
test('Changed Files lists a multi-repo worktree while its remote waits on credentials', async () => {
  test.skip(
    process.platform === 'win32',
    'The blocking credential helper is a POSIX shell command.',
  );
  test.setTimeout(180_000);
  const remote = http.createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="canopy-e2e"' });
    response.end();
  });
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const remoteAddress = remote.address();
  if (remoteAddress === null || typeof remoteAddress === 'string') {
    throw new Error('The credential-gated remote has no TCP port.');
  }
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-changed-files-remote-'),
  );
  let launched = null;
  try {
    const seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['multi-repo-fullstack'],
    });
    const worktreePath = seed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded multi-repo worktree path').toBeTruthy();
    execFileSync(
      'git',
      [
        '-C',
        worktreePath,
        'remote',
        'add',
        'origin',
        `http://127.0.0.1:${remoteAddress.port}/multi-repo-fullstack.git`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    writeFileSync(
      path.join(worktreePath, INITIAL_DIRTY_FILE_NAME),
      'changed while the remote waits\n',
      'utf8',
    );

    launched = await launchCanopy({
      userDataDir,
      env: {
        // Replace every configured helper (an empty value resets the list)
        // with one that never answers within the assertion's wait.
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '!sleep 90 #',
      },
    });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const changedFiles = window.getByTestId('changed-files-section');
    await expect(changedFiles).toBeVisible({ timeout: 20_000 });
    await expect(changedFiles).toContainText(INITIAL_DIRTY_FILE_NAME);
  } finally {
    if (launched !== null) {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
    await new Promise((resolve) => remote.close(resolve));
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
