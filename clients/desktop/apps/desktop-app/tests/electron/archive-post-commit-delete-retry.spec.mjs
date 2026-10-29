import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKTREE_ID = 'demo-main';

function worktreeRow(window) {
  return window.locator(
    `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
  );
}

async function openWorkspace(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await expect(worktreeRow(window)).toBeVisible();
}

async function removeThroughSidebar(window, action) {
  const row = worktreeRow(window);
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId(`worktree-actions-menu-${action}`).click();
  const dialog = window.getByRole('dialog', {
    name: `${action === 'delete' ? 'Delete' : 'Archive'} worktree?`,
  });
  // A clean Delete can bypass confirmation with a cached diff. Archive always
  // confirms. Both paths exercise the same real sidebar command.
  const asked = await dialog.waitFor({ state: 'visible', timeout: 3_000 }).then(
    () => true,
    () => false,
  );
  if (asked) {
    await dialog.getByTestId('worktree-removal-preserve-branch').click();
  } else if (action === 'archive') {
    throw new Error('Archive confirmation did not appear');
  }
}

function readRows(worktreesPath) {
  return JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees;
}

function seedInterruptedPostCommitArchive({
  userDataDir,
  workspaceId,
  originalRow,
  originalWorktreesFile,
  originalCheckoutIdentity,
  worktreesPath,
  manifestPath,
}) {
  const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  expect(manifest).toMatchObject({
    version: 2,
    kind: 'worktree',
    id: WORKTREE_ID,
    createdAt: originalRow.createdAt,
  });
  expect(manifest.gitState.repositories.length).toBeGreaterThan(0);
  expect(
    existsSync(path.join(path.dirname(manifestPath), 'git-state.staged.json')),
  ).toBe(false);
  expect(readRows(worktreesPath)).toEqual([]);
  const stat = lstatSync(workspaceDir);
  expect(stat.isDirectory()).toBe(true);

  // Recreate only the durable state left by a crash inside sidecar cleanup.
  // The manifest and captured Git refs are genuine outputs of the app's
  // preceding archive, not hand-written approximations. The checkout stays
  // absent while the original canonical row remains to be removed on retry.
  writeFileSync(worktreesPath, originalWorktreesFile);
  const sidecarPath = path.join(
    workspaceDir,
    'worktree-data',
    WORKTREE_ID,
    'stale-sidecar.txt',
  );
  mkdirSync(path.dirname(sidecarPath), { recursive: true });
  writeFileSync(sidecarPath, 'sidecar cleanup was interrupted\n');
  const sidecarStat = lstatSync(path.dirname(sidecarPath));

  const journalDir = path.join(userDataDir, 'w5', 'destructive-lifecycles');
  const journalKey = createHash('sha256')
    .update(JSON.stringify([workspaceId, WORKTREE_ID]))
    .digest('hex');
  mkdirSync(journalDir, { recursive: true });
  const journalPath = path.join(journalDir, `${journalKey}.json`);
  writeFileSync(
    journalPath,
    `${JSON.stringify(
      {
        version: 1,
        operationId: randomUUID(),
        operation: 'worktree-archive',
        workspaceId,
        worktreeId: WORKTREE_ID,
        createdAt: originalRow.createdAt,
        directoryIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
        state: 'recovery-required',
        steps: [
          'live-state-teardown',
          'retained-payload-capture',
          'git-capture',
          'provider-capture',
          'checkout-quarantine',
          'git-worktree-removal',
          'quarantine-directory-removal',
          'branch-deletion',
          'pipeline-cleanup',
          'turn-diff-cleanup',
          'retained-manifest-commit',
          'browser-retirement',
          'git-capture-completion',
        ]
          .map((phase) => ({ phase, state: 'done' }))
          .concat({ phase: 'sidecar-cleanup', state: 'pending' }),
        ownedPaths: [
          {
            path: path.join(workspaceDir, 'worktrees', WORKTREE_ID),
            identity: originalCheckoutIdentity,
          },
          {
            path: path.dirname(sidecarPath),
            identity: `${sidecarStat.dev}:${sidecarStat.ino}:${sidecarStat.birthtimeMs}`,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { journalPath, sidecarPath };
}

test('ordinary sidebar Delete still removes a live worktree', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-delete-guard-'),
  );
  const {
    workspaces: [workspace],
  } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    await openWorkspace(window);
    await removeThroughSidebar(window, 'delete');
    await expect(worktreeRow(window)).toHaveCount(0, { timeout: 45_000 });
    await expect
      .poll(() =>
        readRows(
          path.join(userDataDir, 'workspaces', workspace.id, 'worktrees.json'),
        ),
      )
      .toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('sidebar Delete resumes sidecar cleanup after a committed retained archive', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-archive-retry-'),
  );
  const {
    workspaces: [workspace],
  } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'worktrees.json',
  );
  const manifestPath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'archived-containers',
    WORKTREE_ID,
    'container.json',
  );
  const originalWorktreesFile = readFileSync(worktreesPath, 'utf8');
  const originalRow = readRows(worktreesPath).find(
    (row) => row.id === WORKTREE_ID,
  );
  expect(originalRow?.createdAt).toBeTruthy();
  const checkoutStat = lstatSync(workspace.worktreePath);
  const originalCheckoutIdentity = `${checkoutStat.dev}:${checkoutStat.ino}:${checkoutStat.birthtimeMs}`;
  let electronApp;
  try {
    // First create the exact retained archive and completed Git capture that
    // production writes; stop the app before seeding the interrupted journal.
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let window = await electronApp.firstWindow();
    await openWorkspace(window);
    await removeThroughSidebar(window, 'archive');
    await expect(worktreeRow(window)).toHaveCount(0, { timeout: 45_000 });
    await expect.poll(() => existsSync(manifestPath)).toBe(true);
    await expect.poll(() => readRows(worktreesPath)).toEqual([]);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    const { journalPath, sidecarPath } = seedInterruptedPostCommitArchive({
      userDataDir,
      workspaceId: workspace.id,
      originalRow,
      originalWorktreesFile,
      originalCheckoutIdentity,
      worktreesPath,
      manifestPath,
    });
    expect(existsSync(workspace.worktreePath)).toBe(false);
    expect(existsSync(sidecarPath)).toBe(true);

    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    await openWorkspace(window);
    await removeThroughSidebar(window, 'delete');

    await expect(worktreeRow(window)).toHaveCount(0, { timeout: 45_000 });
    await expect.poll(() => readRows(worktreesPath)).toEqual([]);
    expect(existsSync(sidecarPath)).toBe(false);
    expect(existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).createdAt).toBe(
      originalRow.createdAt,
    );
    expect(JSON.parse(readFileSync(journalPath, 'utf8')).state).toBe(
      'completed',
    );
    await window
      .getByTestId(`sidebar-project-${workspace.id}-archived-link`)
      .click();
    await expect(
      window.getByTestId(`archived-overview-open-${WORKTREE_ID}`),
    ).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
