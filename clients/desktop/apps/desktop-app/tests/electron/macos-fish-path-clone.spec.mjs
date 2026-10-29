import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { writeUnauthenticatedGhFixture } from './ghAuthFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  FISH_PATH,
  expectShellPathClone,
  seedMacosShellPath,
  submitShellPathClone,
} from './helpers/macos-shell-path.mjs';
import {
  chooseCloneDestination,
  fillCloneUrl,
} from './helpers/add-project.mjs';

function createSourceRepository(rootDir) {
  const sourceRepo = path.join(rootDir, 'fish-path-source');
  mkdirSync(sourceRepo, { recursive: true });
  execFileSync('/usr/bin/git', ['init', sourceRepo]);
  writeFileSync(path.join(sourceRepo, 'README.md'), '# Fish PATH clone\n');
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

function createFishProbeFixture(rootDir) {
  const shellPath = path.join(rootDir, 'fish');
  writeFileSync(
    shellPath,
    [
      '#!/bin/sh',
      'case "$2" in',
      '  "exec /usr/bin/printenv PATH"|"exec /usr/bin/printf "*)',
      "  printf '%s\\n' '/usr/bin:/bin'",
      '  ;;',
      '  *)',
      "  printf '%s\\n' '/usr/bin /bin'",
      '  ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(shellPath, 0o755);
  return shellPath;
}

test.describe('macOS Fish login-shell PATH', () => {
  test.skip(process.platform !== 'darwin', 'macOS PATH recovery only');

  test('clones a remote project when Fish exposes PATH as a list', async () => {
    test.setTimeout(120_000);

    const fixtureRoot = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-fish-path-e2e-'),
    );
    const sourceRepo = createSourceRepository(fixtureRoot);
    const cloneRoot = path.join(fixtureRoot, 'clones');
    mkdirSync(cloneRoot, { recursive: true });
    const shellPath = createFishProbeFixture(fixtureRoot);
    const ghExecutable = writeUnauthenticatedGhFixture(
      path.join(fixtureRoot, 'github-auth'),
    );

    let launch;
    try {
      launch = await launchCanopy({
        env: {
          GH_EXECUTABLE: ghExecutable,
          SHELL: shellPath,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        },
      });
      const { electronApp, userDataDir } = launch;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await window.getByTestId('sidebar-section-code-toggle').hover();
      await window.getByTestId('sidebar-section-code-add').click();
      await expect(
        window.getByRole('heading', { name: 'Add project' }),
      ).toBeVisible();
      await window.getByTestId('add-workspace-mode-remote').click();
      await fillCloneUrl(window, sourceRepo);
      await chooseCloneDestination(electronApp, window, cloneRoot);
      await window
        .getByRole('button', { name: 'Clone and add', exact: true })
        .click();

      await expect(
        window.getByRole('heading', { name: 'Add project' }),
      ).toHaveCount(0, { timeout: 30_000 });
      await expect(
        window
          .getByTestId('sidebar-section-code')
          .getByRole('button', { name: 'Collapse fish-path-source' }),
      ).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => existsSync(path.join(cloneRoot, 'fish-path-source')))
        .toBe(true);

      await closeCanopy(electronApp, userDataDir);
      launch = undefined;
    } finally {
      if (launch) {
        await closeCanopy(launch.electronApp, launch.userDataDir);
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

test.describe('real macOS login-shell Git selection', () => {
  test.skip(process.platform !== 'darwin', 'macOS PATH recovery only');
  for (const shell of ['zsh', 'bash', 'fish']) {
    for (const exported of [true, false]) {
      test(`${shell} clones using its ${exported ? 'exported' : 'unexported'} PATH`, async () => {
        test.skip(
          shell === 'fish' && !FISH_PATH,
          'Install Fish to run real Fish coverage',
        );
        test.setTimeout(120_000);
        const root = mkdtempSync(
          path.join(os.tmpdir(), 'canopy-shell-path-e2e-'),
        );
        let launch;
        try {
          const fixture = seedMacosShellPath(root, shell, exported);
          launch = await launchCanopy({ env: fixture.env });
          const window = await launch.electronApp.firstWindow();
          await submitShellPathClone(
            window,
            new CanopyAppDriver(window),
            fixture,
            launch.electronApp,
          );
          await expectShellPathClone(window, fixture);
        } finally {
          if (launch) await closeCanopy(launch.electronApp, launch.userDataDir);
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
