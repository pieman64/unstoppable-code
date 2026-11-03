import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { writeUnauthenticatedGhFixture } from './ghAuthFixture.mjs';
import { closeCanopy, launchCanopyApp } from './launchCanopy.mjs';
import {
  chooseCloneDestination,
  fillCloneUrl,
} from './helpers/add-project.mjs';

// Add project → clone from a URL, for a clone slow enough to outlive the
// dialog's three-second foreground window. A CANOPY_GIT_EXECUTABLE shim holds
// every `git clone` in a loop that streams real-looking `--progress` lines
// until the spec writes a release file, then hands off to the real git. That
// makes the hand-off, the sidebar pill, the progress dialog, and cancellation
// deterministic without a network or a large repository.

const REPO_NAME = 'slow-source';

function createSourceRepository(root) {
  const sourceRepo = path.join(root, REPO_NAME);
  mkdirSync(sourceRepo, { recursive: true });
  execFileSync('/usr/bin/git', ['init', sourceRepo], { stdio: 'ignore' });
  writeFileSync(path.join(sourceRepo, 'README.md'), '# Slow clone\n');
  execFileSync('/usr/bin/git', ['-C', sourceRepo, 'add', 'README.md']);
  execFileSync(
    '/usr/bin/git',
    [
      '-C',
      sourceRepo,
      '-c',
      'user.name=Canopy E2E',
      '-c',
      'user.email=e2e@canopy.test',
      'commit',
      '-m',
      'Initial commit',
    ],
    { stdio: 'ignore' },
  );
  return sourceRepo;
}

function writeSlowCloneGitShim(root, releaseFile, failFile) {
  const shimPath = path.join(root, 'git-slow-clone-shim.sh');
  writeFileSync(
    shimPath,
    [
      '#!/bin/sh',
      'case " $* " in',
      '  *" clone "*)',
      '    for destination; do :; done',
      '    mkdir -p "$destination"',
      '    i=1',
      `    while [ ! -f '${releaseFile}' ]; do`,
      `      printf 'Receiving objects: %3d%% (%d/100), %d.00 MiB | 1.00 MiB/s\\r' "$i" "$i" "$i" >&2`,
      '      [ "$i" -lt 60 ] && i=$((i + 1))',
      '      sleep 0.2',
      '    done',
      `    if [ -f '${failFile}' ]; then`,
      "      printf 'fatal: controlled authentication failure\\n' >&2",
      '      exit 1',
      '    fi',
      '    ;;',
      'esac',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

async function startSlowClone(launched, sourceRepo, cloneRoot) {
  const { window, electronApp } = launched;
  // The add button is hover-revealed; the keyboard path avoids pointer flake.
  await window.getByTestId('sidebar-section-code-add').focus();
  await window.getByTestId('sidebar-section-code-add').press('Enter');
  await expect(
    window.getByRole('heading', { name: 'Add project' }),
  ).toBeVisible();
  await window.getByTestId('add-workspace-mode-remote').click();
  await fillCloneUrl(window, sourceRepo);
  await chooseCloneDestination(electronApp, window, cloneRoot);
  await window
    .getByRole('button', { name: 'Clone and add', exact: true })
    .click();
}

test.describe('Add project clone progress', () => {
  test.skip(process.platform === 'win32', 'POSIX git shim');

  let fixtureRoot;
  let sourceRepo;
  let cloneRoot;
  let releaseFile;
  let failFile;
  let launched;

  test.beforeEach(async () => {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'canopy-clone-progress-'));
    sourceRepo = createSourceRepository(fixtureRoot);
    cloneRoot = path.join(fixtureRoot, 'clones');
    mkdirSync(cloneRoot, { recursive: true });
    releaseFile = path.join(fixtureRoot, 'release-clone');
    failFile = path.join(fixtureRoot, 'fail-clone');
    launched = await launchCanopyApp({
      env: {
        CANOPY_GIT_EXECUTABLE: writeSlowCloneGitShim(
          fixtureRoot,
          releaseFile,
          failFile,
        ),
        GH_EXECUTABLE: writeUnauthenticatedGhFixture(
          path.join(fixtureRoot, 'github-auth'),
        ),
      },
      waitForShellOptions: { timeout: 30_000 },
    });
    await launched.app.openMainPage();
  });

  test.afterEach(async () => {
    writeFileSync(releaseFile, '');
    if (launched) await closeCanopy(launched.electronApp, launched.userDataDir);
    launched = undefined;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test('CAN-4342: background publication recovery stays visible in Clone progress', async () => {
    const job = {
      id: 'recovery-job',
      repoName: REPO_NAME,
      destinationPath: path.join(cloneRoot, REPO_NAME),
      phase: 'finishing',
      status: 'failed',
      cancellable: false,
      remoteUrl: 'https://github.com/fixture/repository',
      phasePercent: 100,
      percent: 99,
      processedCount: null,
      totalCount: null,
      received: null,
      throughput: null,
      startedAt: 1_000,
      background: true,
      workspaceId: null,
      workspaceName: null,
      error: 'This change was saved but did not finish and needs recovery.',
    };
    // Exercise the existing main-to-renderer projection; registry coverage pins
    // the real finishing failure that produces this controlled snapshot.
    await launched.electronApp.evaluate(({ BrowserWindow }, snapshot) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('clone-jobs:changed', [snapshot]);
    }, job);
    await launched.window.getByTestId('clone-progress-sidebar').click();
    const modal = launched.window.getByTestId('clone-progress-modal');
    await expect(modal.getByRole('alert')).toHaveText(job.error);
    await expect(
      modal.getByTestId('clone-progress-dismiss-recovery-job'),
    ).toBeVisible();
  });

  test('CAN-4342: foreground URL failures show one friendly error and retain the draft', async () => {
    test.setTimeout(120_000);
    writeFileSync(failFile, '');
    writeFileSync(releaseFile, '');
    await startSlowClone(launched, sourceRepo, cloneRoot);
    const error = launched.window.getByTestId('add-workspace-error');
    await expect(error).toHaveText(
      'Failed to clone the repository. Check the URL and access, then try again.',
    );
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(error).not.toContainText('fatal:');
    await expect(error).not.toContainText(sourceRepo);
    await expect(
      launched.window.getByTestId('add-workspace-remote-url-input'),
    ).toHaveValue(sourceRepo);
  });

  test('hands a slow clone to the sidebar, then adds the project and clears the pill when it finishes', async () => {
    test.setTimeout(120_000);
    const { window } = launched;

    await startSlowClone(launched, sourceRepo, cloneRoot);

    // The dialog stays up briefly, then closes and the pill takes over.
    await expect(
      window.getByRole('heading', { name: 'Add project' }),
    ).toHaveCount(0, { timeout: 15_000 });
    const pill = window.getByTestId('clone-progress-sidebar');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(`Cloning ${REPO_NAME}`);
    const pending = window.locator('[data-pending-project-row]');
    await expect(pending).toHaveCount(1);
    await expect(pending).toContainText(REPO_NAME);
    await expect(pending).toHaveAttribute('data-status', 'cloning');
    // The banner reports progress as its percent (no bar), on the trailing
    // edge and in its accessible name.
    await expect(pill.getByTestId('clone-progress-percent')).toHaveText(
      /^[1-9]\d*%$/,
      { timeout: 15_000 },
    );
    await expect(pill).toHaveAttribute('aria-label', /, [1-9]\d*%$/);

    // The dialog shows live detail for the clone.
    await pill.click();
    const modal = window.getByTestId('clone-progress-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Receiving objects');
    await expect(modal).toContainText('MiB at 1.00 MiB/s');
    await expect(modal).toContainText(sourceRepo);
    await expect(modal).toContainText(path.join(cloneRoot, REPO_NAME));

    // Closing the dialog keeps the clone running in the background.
    await window.getByTestId('clone-progress-close').click();
    await expect(modal).toHaveCount(0);
    await expect(pill).toBeVisible();
    const percent = async () =>
      Number.parseInt(
        (await pill.getByTestId('clone-progress-percent').textContent()) ?? '',
        10,
      );
    const before = await percent();
    await expect.poll(percent, { timeout: 15_000 }).toBeGreaterThan(before);

    // Let git finish: a toast confirms it, the project is added, and the pill
    // leaves the sidebar on its own.
    writeFileSync(releaseFile, '');
    const toast = window
      .getByTestId('toast-card')
      .filter({ hasText: 'Clone finished' });
    await expect(toast).toBeVisible({ timeout: 30_000 });
    await expect(toast).toContainText(`Added ${REPO_NAME}.`);
    await expect(
      window
        .getByTestId('sidebar-section-code')
        .getByRole('button', { name: `Collapse ${REPO_NAME}` }),
    ).toBeVisible({ timeout: 30_000 });
    expect(existsSync(path.join(cloneRoot, REPO_NAME, 'README.md'))).toBe(true);
    await expect(pill).toHaveCount(0, { timeout: 30_000 });
    await expect(pending).toHaveCount(0);
  });

  test('keeps a failed shared row after outcome announcement and supports Retry then Dismiss', async () => {
    test.setTimeout(120_000);
    const { window } = launched;
    await startSlowClone(launched, sourceRepo, cloneRoot);
    const pending = window.locator('[data-pending-project-row]');
    await expect(pending).toHaveAttribute('data-status', 'cloning', {
      timeout: 15_000,
    });
    writeFileSync(failFile, '');
    writeFileSync(releaseFile, '');
    await expect(pending).toHaveAttribute('data-status', 'failed', {
      timeout: 30_000,
    });
    await expect(
      window.getByTestId('toast-card').filter({ hasText: 'Clone failed' }),
    ).toBeVisible();
    // The row is titled with the repository and says why it failed.
    await expect(pending).toContainText(REPO_NAME);
    await expect(pending).toContainText(
      'Failed to clone the repository. Check the URL and access, then try again.',
    );
    await window.getByTestId('clone-progress-sidebar').click();
    const details = window.getByTestId('clone-progress-modal');
    await expect(details.getByRole('alert')).toHaveText(
      'Failed to clone the repository. Check the URL and access, then try again.',
    );
    await expect(details).not.toContainText('fatal:');
    await expect(details).not.toContainText('Check the URL and your access');
    await details.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(
      pending.locator('[data-testid^="sidebar-pending-project-status-"]'),
    ).not.toBeEmpty();
    await expect(
      pending.locator('[data-testid^="sidebar-pending-project-spinner-"]'),
    ).toHaveCount(0);
    const retry = pending.getByRole('button', {
      name: `Try again for ${REPO_NAME}`,
      exact: true,
    });
    await retry.focus();
    await retry.press('Enter');
    await expect(
      window.getByRole('heading', {
        name: 'Add project to Personal',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      window.getByTestId('add-workspace-remote-url-input'),
    ).toHaveValue(sourceRepo);
    await window.keyboard.press('Escape');
    await expect(
      window.getByRole('heading', {
        name: 'Add project to Personal',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(pending).toHaveAttribute('data-status', 'failed');
    const dismiss = pending.getByRole('button', {
      name: `Dismiss ${REPO_NAME}`,
      exact: true,
    });
    await dismiss.focus();
    await dismiss.press('Enter');
    await expect(pending).toHaveCount(0);
    await expect(window.getByTestId('clone-progress-sidebar')).toHaveCount(0);
  });

  test('cancels a slow clone and removes its partial checkout', async () => {
    test.setTimeout(120_000);
    const { window } = launched;
    const destination = path.join(cloneRoot, REPO_NAME);

    await startSlowClone(launched, sourceRepo, cloneRoot);
    const pill = window.getByTestId('clone-progress-sidebar');
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => existsSync(destination)).toBe(true);

    await pill.click();
    const modal = window.getByTestId('clone-progress-modal');
    await expect(modal).toBeVisible();
    await modal.locator('[data-testid^="clone-progress-cancel-"]').click();

    await expect(modal).toHaveCount(0, { timeout: 15_000 });
    await expect(pill).toHaveCount(0);
    await expect(window.locator('[data-pending-project-row]')).toHaveCount(0);
    await expect.poll(() => existsSync(destination)).toBe(false);

    // git was stopped, not merely abandoned: releasing the shim now must not
    // let a surviving clone recreate the checkout or add the project.
    writeFileSync(releaseFile, '');
    await window.waitForTimeout(2_000);
    expect(existsSync(destination)).toBe(false);
    await expect(
      window
        .getByTestId('sidebar-section-code')
        .getByRole('button', { name: `Collapse ${REPO_NAME}` }),
    ).toHaveCount(0);
  });

  test('keeps cleanup failure visible when the checkout cannot be removed', async () => {
    test.setTimeout(120_000);
    const { window } = launched;
    const destination = path.join(cloneRoot, REPO_NAME);

    await startSlowClone(launched, sourceRepo, cloneRoot);
    const pill = window.getByTestId('clone-progress-sidebar');
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => existsSync(destination)).toBe(true);

    chmodSync(cloneRoot, 0o500);
    try {
      await pill.click();
      const modal = window.getByTestId('clone-progress-modal');
      await modal.locator('[data-testid^="clone-progress-cancel-"]').click();
      await expect(modal).toContainText('Remove it manually.', {
        timeout: 15_000,
      });
      await expect(
        modal.locator('[data-testid^="clone-progress-dismiss-"]'),
      ).toBeEnabled();
      await expect(modal).not.toContainText(
        "Couldn't cancel the clone. Try again.",
      );
      await expect(modal).toContainText(destination);
      expect(existsSync(destination)).toBe(true);
    } finally {
      chmodSync(cloneRoot, 0o700);
    }
  });
});
