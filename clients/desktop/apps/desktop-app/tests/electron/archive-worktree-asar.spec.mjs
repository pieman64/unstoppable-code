import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPackage } from '@electron/asar';
import { expect, test } from '@playwright/test';
import electronBinaryPath from 'electron';
import { build } from 'esbuild';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

// ---------------------------------------------------------------------------
// Archiving worktrees that contain `.asar` files and sealed evidence folders.
//
// Reported symptom: archiving a worktree with `node_modules/electron`
// installed failed in teardown with
//   ENOTEMPTY: directory not empty, rmdir
//   '.../.<id>.archive-quarantine/node_modules/electron/dist/Electron.app/
//   Contents/Resources'
// Electron patches `fs` (main and utility processes) so `*.asar` files look
// like read-only folders; recursive removal descended into `default_app.asar`
// instead of unlinking it. The row came back and every retry failed the same
// way against the leftover quarantine.
//
// Desired behaviour: archive removes `.asar` files as plain files. A worktree
// already stuck with a leftover quarantine keeps it across retries and
// relaunches, and the user's discard removes it, asar archive included.
// Delegated checkouts also live in worktree metadata: cleanup must finish
// there before removing the durable sidebar record and releasing chat fences.
//
// Determinism: no live agents, no network, no PTY. The workspace is the plain
// `ts-pnpm-vite` demo fixture with a real asar archive written into it.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const REMOVAL_HELPER_SOURCE = fileURLToPath(
  new URL('../../src/main/lib/remove-tree-without-asar.ts', import.meta.url),
);
const WORKTREE_BRANCH = 'demo-main';
// Run the metadata cases against an already-built production bundle with
// CANOPY_ASAR_BUILD_KIND=production; the shared launcher keeps it headless.
const USE_PRODUCTION_BUILD =
  process.env.CANOPY_ASAR_BUILD_KIND === 'production';
const ASAR_RELATIVE_PATH = path.join(
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'Resources',
  'default_app.asar',
);
function seedWorktree(userDataDir) {
  const { workspaces } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = workspaces[0];
  expect(workspace?.worktreePath, 'seeded worktree path').toBeTruthy();
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'worktrees.json',
  );
  return {
    workspace,
    worktreesPath,
    quarantinePath: path.join(
      path.dirname(workspace.worktreePath),
      `.${path.basename(workspace.worktreePath)}.archive-quarantine`,
    ),
  };
}

/** Writes a real asar archive where an Electron install would place one. */
async function writeAsarArchive(worktreePath, scratchDir) {
  const source = path.join(scratchDir, 'default-app-source');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'default_app', main: 'main.js' }),
  );
  writeFileSync(path.join(source, 'main.js'), 'module.exports = {};\n');
  const asarPath = path.join(worktreePath, ASAR_RELATIVE_PATH);
  mkdirSync(path.dirname(asarPath), { recursive: true });
  await createPackage(source, asarPath);
  expect(existsSync(asarPath)).toBe(true);
  return asarPath;
}

function worktreeRecordCount(worktreesPath) {
  return JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees.length;
}

async function archiveFromRowMenu(window, row, action = 'archive') {
  await row.hover();
  await window.getByTestId('worktree-actions-menu-button').click();
  await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
  await window.getByTestId(`worktree-actions-menu-${action}`).click();

  const dialog = window.getByRole('dialog', {
    name: action === 'archive' ? /^Archive worktree/ : /^Delete worktree/,
  });
  await expect
    .poll(async () => (await dialog.isVisible()) || (await row.count()) === 0)
    .toBe(true);
  if (await dialog.isVisible()) {
    if (USE_PRODUCTION_BUILD) {
      // The branch switch keeps the local branch by default.
      await dialog
        .getByRole('button', {
          name: action === 'archive' ? 'Archive worktree' : 'Delete worktree',
          exact: true,
        })
        .click();
      return;
    }
    await window.getByTestId('worktree-removal-preserve-branch').click();
  }
}

async function expectArchivedAfterReload(window, app, row, paths) {
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(() => worktreeRecordCount(paths.worktreesPath), { timeout: 30_000 })
    .toBe(0);
  await expect
    .poll(() => existsSync(paths.quarantinePath), { timeout: 30_000 })
    .toBe(false);
  await expect(window.getByText(/ENOTEMPTY/)).toHaveCount(0);

  await window.reload();
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await expect(row).toHaveCount(0);
}

test('archives a worktree that contains an asar archive', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-archive-asar-'),
  );
  const paths = seedWorktree(userDataDir);
  await writeAsarArchive(paths.workspace.worktreePath, userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const row = window.locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
    );
    await expect(row).toBeVisible();

    await archiveFromRowMenu(window, row);
    await expectArchivedAfterReload(window, app, row, paths);
    expect(existsSync(paths.workspace.worktreePath)).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const action of ['archive', 'delete']) {
  test(`${action} removes sealed evidence directories without following symlinks`, async () => {
    skipUnlessReadOnlyDirectoryBlocksRemoval();
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archive-sealed-'),
    );
    const paths = seedWorktree(userDataDir);
    const relativeSealed = path.join('.mini-swarm', 'acceptance-sealed');
    const sealed = path.join(paths.workspace.worktreePath, relativeSealed);
    const outside = path.join(userDataDir, 'external-evidence');
    mkdirSync(sealed, { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(sealed, 'archive'), 'sealed CLI artifact');
    chmodSync(path.join(sealed, 'archive'), 0o444);
    writeFileSync(path.join(outside, 'keep.txt'), 'retain external evidence');
    symlinkSync(outside, path.join(sealed, 'external'));
    chmodSync(sealed, 0o555);
    chmodSync(outside, 0o555);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const { window, app, row } = await openWorktreeRow(electronApp);
      await archiveFromRowMenu(window, row, action);
      await expectArchivedAfterReload(window, app, row, paths);
      expect(existsSync(paths.workspace.worktreePath)).toBe(false);
      expect(readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe(
        'retain external evidence',
      );
      expect(statSync(outside).mode & 0o777).toBe(0o555);
      expect(
        existsSync(
          path.join(
            userDataDir,
            'workspaces',
            paths.workspace.id,
            'archived-containers',
            WORKTREE_BRANCH,
            'container.json',
          ),
        ),
      ).toBe(true);
      await expect(window.getByText(/EACCES/)).toHaveCount(0);
    } finally {
      for (const directory of [
        sealed,
        path.join(paths.quarantinePath, relativeSealed),
        outside,
      ]) {
        if (existsSync(directory)) chmodSync(directory, 0o755);
      }
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const action of ['archive', 'delete']) {
  test(`${action} finishes when delegated runtime metadata contains asar archives`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-delegation-metadata-asar-'),
    );
    const paths = seedWorktree(userDataDir);
    const workspaceRoot = path.join(
      userDataDir,
      'workspaces',
      paths.workspace.id,
    );
    const metadata = path.join(workspaceRoot, 'worktree-data', WORKTREE_BRANCH);
    for (const delegateId of ['delegate-one', 'delegate-two']) {
      await writeAsarArchive(
        path.join(metadata, 'delegation', 'worktrees', delegateId),
        userDataDir,
      );
    }
    seedWorktreeChat({
      userDataDir,
      workspaceId: paths.workspace.id,
      worktreeId: WORKTREE_BRANCH,
      tabs: [
        {
          id: 'retained-chat',
          title: 'Delegated work',
          messages: [
            {
              id: 'retained-message',
              role: 'assistant',
              blocks: [
                { type: 'text', text: 'Keep this delegated work transcript.' },
              ],
              timestamp: Date.now(),
            },
          ],
        },
      ],
    });

    const { electronApp } = await launchCanopy({
      userDataDir,
      ...(USE_PRODUCTION_BUILD
        ? {
            buildKind: 'production',
            productionWindowMode: 'headless',
            productionAdapterArchivePath: test
              .info()
              .outputPath('production.adapter.cjs'),
          }
        : {}),
    });
    try {
      const { window, app, row } = await openWorktreeRow(electronApp);
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(
        window.getByText('Keep this delegated work transcript.'),
      ).toBeVisible();
      await archiveFromRowMenu(window, row, action);
      // The row leaves optimistically before cleanup; the durable record and
      // metadata must also disappear before deletion can be called complete.
      await expectArchivedAfterReload(window, app, row, paths);
      expect(existsSync(metadata)).toBe(false);
      expect(existsSync(paths.workspace.worktreePath)).toBe(false);
      expect(
        existsSync(
          path.join(workspaceRoot, 'chat-storage-v2', WORKTREE_BRANCH),
        ),
      ).toBe(false);
      const retained = path.join(
        workspaceRoot,
        'archived-containers',
        WORKTREE_BRANCH,
      );
      expect(
        JSON.parse(readFileSync(path.join(retained, 'container.json'), 'utf8'))
          .chatCount,
      ).toBe(1);
      const transcript = path.join(
        retained,
        'chat-storage-v2',
        WORKTREE_BRANCH,
        'transcripts',
        'retained-chat.jsonl',
      );
      expect(readFileSync(transcript, 'utf8')).toContain(
        'Keep this delegated work transcript.',
      );
      await expect(
        window.getByText('Chat state repository is draining', { exact: false }),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

// POSIX permission bits only reproduce the sealed-folder failure as non-root.
function skipUnlessReadOnlyDirectoryBlocksRemoval() {
  test.skip(
    process.platform === 'win32' || process.getuid?.() === 0,
    'A read-only directory does not block deletion on Windows or as root.',
  );
}

/**
 * Leaves the asar and sealed evidence in quarantine after the worker failure.
 */
async function seedWorktreeWithBlockedTeardown(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const paths = seedWorktree(userDataDir);
  await writeAsarArchive(paths.workspace.worktreePath, userDataDir);
  const relativeSealed = path.join('.mini-swarm', 'acceptance-sealed');
  const sealed = path.join(paths.workspace.worktreePath, relativeSealed);
  mkdirSync(sealed, { recursive: true });
  writeFileSync(
    path.join(sealed, 'archive'),
    'sealed evidence retained across retry',
  );
  chmodSync(sealed, 0o555);
  return {
    userDataDir,
    paths,
    sealed,
    quarantinedSealed: path.join(paths.quarantinePath, relativeSealed),
  };
}

function restoreSealedPermissions(seeded) {
  for (const directory of [seeded.sealed, seeded.quarantinedSealed]) {
    if (existsSync(directory)) chmodSync(directory, 0o755);
  }
}

async function openWorktreeRow(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  const row = window.locator(
    `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
  );
  await expect(row).toBeVisible();
  return { window, app, row };
}

/** Fail the first removal request after capture and quarantine verification. */
async function failFirstTeardown(electronApp, window, row, seeded) {
  const { paths } = seeded;
  await electronApp.evaluate(({ utilityProcess }) => {
    const originalFork = utilityProcess.fork;
    utilityProcess.fork = function (...args) {
      const child = originalFork.apply(this, args);
      if (args[2]?.serviceName !== 'archive-io') return child;
      const originalPost = child.postMessage.bind(child);
      child.postMessage = (message, ...rest) => {
        if (message?.type !== 'remove-worktree')
          return originalPost(message, ...rest);
        child.postMessage = originalPost;
        utilityProcess.fork = originalFork;
        queueMicrotask(() => {
          child.emit('message', {
            version: 1,
            type: 'error',
            requestId: message.requestId,
            code: 'ARCHIVE_IO_FAILED',
            message: 'Fixture archive teardown interrupted.',
          });
          child.emit('message', {
            version: 1,
            type: 'cleanup-complete',
            requestId: message.requestId,
            childCleanup: 'not-required',
          });
        });
      };
      return child;
    };
  });
  await archiveFromRowMenu(window, row);

  // The failed teardown keeps the quarantine and rolls the row back. The row
  // leaves the sidebar before main starts archiving, so once the checkout is
  // in quarantine a visible row can only be the rollback.
  await expect
    .poll(() => existsSync(paths.quarantinePath), { timeout: 30_000 })
    .toBe(true);
  await expect(row).toBeVisible({ timeout: 30_000 });
  expect(existsSync(paths.workspace.worktreePath)).toBe(false);
  expect(existsSync(path.join(paths.quarantinePath, ASAR_RELATIVE_PATH))).toBe(
    true,
  );
  expect(existsSync(seeded.quarantinedSealed)).toBe(true);
  expect(worktreeRecordCount(paths.worktreesPath)).toBe(1);
}

/**
 * A failed archive's journal ends recovery-required, so another removal is
 * refused and offers the discard instead. Cancel keeps everything.
 */
async function expectRemovalOffersDiscard(window, row, seeded, action) {
  await archiveFromRowMenu(window, row, action);
  const discard = window.getByTestId('worktree-discard-dialog');
  await expect(discard).toBeVisible({ timeout: 30_000 });
  await expect(
    window.getByTestId('worktree-discard-dialog-targets'),
  ).toContainText(seeded.paths.quarantinePath);
  return discard;
}

function expectQuarantineKept(seeded) {
  const { paths } = seeded;
  expect(existsSync(path.join(paths.quarantinePath, ASAR_RELATIVE_PATH))).toBe(
    true,
  );
  expect(existsSync(seeded.quarantinedSealed)).toBe(true);
  expect(worktreeRecordCount(paths.worktreesPath)).toBe(1);
}

test('a retried archive keeps a leftover quarantine that contains an asar archive', async () => {
  test.setTimeout(180_000);
  const seeded = await seedWorktreeWithBlockedTeardown(
    'canopy-archive-asar-retry-',
  );

  const { electronApp } = await launchCanopy({
    userDataDir: seeded.userDataDir,
  });
  try {
    const { window, row } = await openWorktreeRow(electronApp);
    await failFirstTeardown(electronApp, window, row, seeded);

    const discard = await expectRemovalOffersDiscard(window, row, seeded);
    await window.getByTestId('worktree-discard-dialog-cancel').click();
    await expect(discard).toHaveCount(0);
    await expect(row).toBeVisible();
    expectQuarantineKept(seeded);
    await expect(window.getByText(/ENOTEMPTY/)).toHaveCount(0);
  } finally {
    restoreSealedPermissions(seeded);
    await closeCanopy(electronApp, seeded.userDataDir);
  }
});

test('a relaunch keeps a leftover asar quarantine until the user discards it', async () => {
  test.setTimeout(180_000);
  const seeded = await seedWorktreeWithBlockedTeardown(
    'canopy-archive-asar-recovery-',
  );
  const { userDataDir, paths } = seeded;

  let { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, row } = await openWorktreeRow(electronApp);
    await failFirstTeardown(electronApp, window, row, seeded);

    // Startup never finishes the interrupted archive on its own.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const reopened = await openWorktreeRow(electronApp);
    expectQuarantineKept(seeded);

    // The discard removes the quarantine, asar archive and sealed folder
    // included, through the archive worker.
    const discard = await expectRemovalOffersDiscard(
      reopened.window,
      reopened.row,
      seeded,
      'delete',
    );
    await reopened.window
      .getByTestId('worktree-discard-dialog-confirm')
      .click();
    await expect(discard).toHaveCount(0, { timeout: 60_000 });
    await expect(reopened.row).toHaveCount(0, { timeout: 30_000 });
    expect(worktreeRecordCount(paths.worktreesPath)).toBe(0);
    expect(existsSync(paths.quarantinePath)).toBe(false);
    await expect(reopened.window.getByText(/ENOTEMPTY|EACCES/)).toHaveCount(0);
  } finally {
    restoreSealedPermissions(seeded);
    await closeCanopy(electronApp, userDataDir);
  }
});

// Every app-driven case above removes the checkout in the archive worker, so
// none of them shows what the main-process helper does. Run the helper itself
// under the real Electron runtime, next to the patched `fs` it replaces.
test('the main-process removal helper unlinks an asar archive under Electron', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'canopy-asar-helper-'));
  try {
    const bundle = path.join(scratch, 'remove-tree-without-asar.cjs');
    await build({
      entryPoints: [REMOVAL_HELPER_SOURCE],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      logLevel: 'silent',
    });
    const patchedTree = path.join(scratch, 'patched-fs');
    const helperTree = path.join(scratch, 'helper');
    await writeAsarArchive(patchedTree, scratch);
    await writeAsarArchive(helperTree, scratch);
    const runner = path.join(scratch, 'runner.cjs');
    writeFileSync(
      runner,
      `
const fs = require('node:fs');
const [bundle, patchedTree, helperTree] = process.argv.slice(2);
const { removeTreeWithoutAsar } = require(bundle);
const options = { recursive: true, force: true };
(async () => {
  const patchedError = await fs.promises.rm(patchedTree, options).then(
    () => null,
    (error) => error.code,
  );
  await removeTreeWithoutAsar(helperTree, options);
  process.stdout.write(
    JSON.stringify({ patchedError, helperRemoved: !fs.existsSync(helperTree) }),
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    );

    const { stdout } = await execFileAsync(
      electronBinaryPath,
      [runner, bundle, patchedTree, helperTree],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    );

    // The patched `fs` still fails the way the bug did, which is what makes
    // the helper's result meaningful.
    expect(JSON.parse(stdout)).toEqual({
      patchedError: 'ENOTEMPTY',
      helperRemoved: true,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
