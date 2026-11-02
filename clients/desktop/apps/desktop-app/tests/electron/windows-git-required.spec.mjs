import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

for (const { platform, screen, title } of [
  {
    platform: 'win32',
    screen: 'windows',
    title:
      'shows the win32 Git requirement gate before onboarding and app usage',
  },
  {
    platform: 'linux',
    screen: 'linux',
    title:
      'shows the linux Git requirement gate before onboarding and app usage',
  },
]) {
  test(title, async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      freshOnboarding: true,
      env: {
        CANOPY_E2E_PLATFORM: platform,
        CANOPY_GIT_EXECUTABLE: '/canopy-e2e-missing/git',
      },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await window.waitForLoadState('domcontentloaded');

      // The blocking first-run legal gate precedes the Git requirement gate.
      await app.acceptLegalConsent();

      await expect(
        window.getByTestId(`${screen}-git-required-screen`),
      ).toBeVisible();
      await expect(window.getByTestId('git-gate-title')).toHaveText(
        'Git installation is required',
      );
      await expect(window.getByTestId('git-gate-manual')).toBeVisible();
      await expect(window.getByTestId('git-gate-recheck')).toBeVisible();

      if (platform === 'linux') {
        await expect(window.getByTestId('git-gate-auto')).toBeHidden();
        await expect(
          window.getByTestId('git-gate-install-explanation'),
        ).toContainText('sudo apt install git');
        await expect(window.getByTestId('git-gate-winget-hint')).toBeHidden();
        await window.getByTestId('git-gate-recheck').click();
        await expect(window.getByTestId('git-gate-error')).toContainText(
          'Selected Git executable cannot be used',
        );
        await expect(window.getByTestId('git-gate-browse')).toBeEnabled();
      }
      await expect(window.getByTestId('app-sidebar')).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Recheck clears a missing inherited Git path and keeps recovery controls usable', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    freshOnboarding: true,
    env: {
      CANOPY_E2E_PLATFORM: 'win32',
      CANOPY_GIT_EXECUTABLE: 'D:\\Git\\cmd\\git.exe',
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.acceptLegalConsent();
    await expect(
      window.getByTestId('windows-git-required-screen'),
    ).toBeVisible();
    await window.getByTestId('git-gate-recheck').click();
    await expect(window.getByTestId('git-gate-recheck')).toBeEnabled();
    await expect
      .poll(() => electronApp.evaluate(() => process.env.CANOPY_GIT_EXECUTABLE))
      .toBeUndefined();
    await expect(window.getByTestId('git-gate-manual')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Only the native chooser is stubbed: executable validation, saved selection,
// shared status/recheck and spawn resolution run through the production host.
test('Linux Browse rejects invalid Git, saves a valid selection and rechecks a stale selection without restart', async () => {
  test.skip(process.platform === 'win32', 'Linux Git probe needs a POSIX host');
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_PLATFORM: 'linux',
      CANOPY_GIT_EXECUTABLE: '/canopy-e2e-missing/git',
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    // The default seeded profile already accepted legal terms.
    await expect(window.getByTestId('linux-git-required-screen')).toBeVisible();
    const directory = join(userDataDir, 'selected-git');
    mkdirSync(directory);
    const selected = join(directory, 'git');
    writeFileSync(selected, '#!/bin/sh\necho "not a Git executable"\n', {
      mode: 0o755,
    });
    await electronApp.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, selected);
    await window.getByTestId('git-gate-browse').click();
    await expect(window.getByTestId('git-gate-error')).toContainText(
      'did not report a Git version',
    );
    const validScript = '#!/bin/sh\nexec /usr/bin/git "$@"\n';
    const target = join(directory, 'actual-git');
    writeFileSync(target, validScript, { mode: 0o755 });
    unlinkSync(selected);
    symlinkSync(target, selected);
    await window.getByTestId('git-gate-browse').click();
    await expect(window.getByTestId('git-gate-title')).toHaveText(
      'Git is ready',
    );
    unlinkSync(target);
    await window.getByTestId('git-gate-recheck').click();
    await expect(window.getByTestId('git-gate-error')).toContainText(
      'Selected Git executable cannot be used',
    );
    await expect(window.getByTestId('git-gate-continue')).toBeHidden();
    writeFileSync(target, validScript, { mode: 0o755 });
    await window.getByTestId('git-gate-recheck').click();
    await expect(window.getByTestId('git-gate-title')).toHaveText(
      'Git is ready',
    );
    await window.getByTestId('git-gate-continue').click();
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('git');
    await expect(window.getByTestId('settings-git-executable-path')).toHaveText(
      selected,
    );
    expect(
      await window.evaluate(
        async () => (await window.api.loadPreferences()).gitExecutablePath,
      ),
    ).toBe(selected);
    unlinkSync(target);
    await window.getByTestId('settings-git-executable-redetect').click();
    await expect(window.getByTestId('settings-git-executable-path')).toHaveText(
      'No Git executable detected',
    );
    await expect(
      window.getByTestId('settings-git-executable-status'),
    ).toContainText('Selected Git executable cannot be used');
    await expect(
      window.getByTestId('git-gate-install-explanation'),
    ).toContainText('Ubuntu');
    await expect(
      window.getByTestId('git-gate-install-explanation'),
    ).toContainText('sudo apt install git');
    await expect(window.getByTestId('git-gate-manual')).toBeVisible();
    // The stale explicit choice is retained, not silently replaced by system Git.
    expect(
      await window.evaluate(
        async () => (await window.api.loadPreferences()).gitExecutablePath,
      ),
    ).toBe(selected);
    writeFileSync(target, validScript, { mode: 0o755 });
    await window.getByTestId('settings-git-executable-redetect').click();
    await expect(window.getByTestId('settings-git-executable-path')).toHaveText(
      selected,
    );
    await window.reload();
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('git');
    await expect(window.getByTestId('settings-git-executable-path')).toHaveText(
      selected,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
