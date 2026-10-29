import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedMacGitStatus } from './seeders/seedMacGitStatus.mjs';

test.skip(process.platform !== 'darwin', 'macOS Git setup');

test('macOS missing Git offers explicit installation, cancel, recheck, and automatic completion', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    freshOnboarding: true,
  });
  try {
    await seedMacGitStatus(electronApp);
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.acceptLegalConsent();
    await expect(window.getByTestId('git-gate-title')).toHaveText(
      'Git installation is required',
    );
    await expect(
      window.getByTestId('git-gate-install-explanation'),
    ).toContainText('Apple');
    expect(
      await electronApp.evaluate(() => globalThis.__macGitFixture.installs),
    ).toBe(0);
    await window.getByTestId('git-gate-auto').click();
    await expect(window.getByTestId('git-gate-title')).toHaveText(
      'Waiting for install to finish',
    );
    await expect(window.getByTestId('git-gate-install-explanation')).toHaveText(
      "Choose Install in Apple's dialog and accept the license. We'll continue automatically when Git is ready.",
    );
    await expect(
      window.getByText(
        "Cancel stops these checks. Close Apple's installer separately if needed.",
        { exact: true },
      ),
    ).toBeVisible();
    await window.getByTestId('git-gate-cancel').click();
    await expect(window.getByTestId('git-gate-recheck')).toBeEnabled();
    await window.getByTestId('git-gate-recheck').click();
    await expect(window.getByTestId('git-gate-auto')).toBeEnabled();
    await window.getByTestId('git-gate-auto').click();
    await expect(window.getByTestId('git-gate-cancel')).toBeVisible();
    await electronApp.evaluate(() => {
      globalThis.__macGitFixture.ready = true;
    });
    await expect(window.getByTestId('git-gate-title')).toBeHidden({
      timeout: 15_000,
    });
    expect(
      await electronApp.evaluate(() => globalThis.__macGitFixture.installs),
    ).toBe(2);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('macOS Settings validates a selected installation and preserves it through reload', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const initial = await window.evaluate(() =>
      window.api.getGitExecutableStatus(),
    );
    expect(initial.ready).toBe(true);
    expect(initial.path).toBeTruthy();
    expect(initial.path).not.toBe('/usr/bin/git');
    const directory = join(userDataDir, 'alternate-git');
    mkdirSync(directory);
    const selected = join(directory, 'git');
    // A local wrapper delegates to the already verified real Git. Only the
    // native file picker is stubbed; validation, persistence and spawning are real.
    const quoted = "'" + initial.path.replaceAll("'", "'\"'\"'") + "'";
    writeFileSync(selected, '#!/bin/sh\nexec ' + quoted + ' "$@"\n', {
      mode: 0o755,
    });
    const selectedRealPath = realpathSync(selected);
    await electronApp.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, selected);
    await app.openSettings();
    await app.openSettingsSection('git');
    await expect(window.getByTestId('settings-git-executable-path')).toHaveText(
      initial.path,
    );
    await window.getByTestId('settings-git-executable-browse').click();
    await expect(window.getByTestId('settings-git-executable-path')).toHaveText(
      selectedRealPath,
    );
    expect(
      await window.evaluate(
        async () => (await window.api.loadPreferences()).gitExecutablePath,
      ),
    ).toBe(selectedRealPath);
    expect(
      await electronApp.evaluate(() => process.env.CANOPY_GIT_EXECUTABLE),
    ).toBe(selectedRealPath);
    await window.reload();
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('git');
    await expect(window.getByTestId('settings-git-executable-path')).toHaveText(
      selectedRealPath,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
