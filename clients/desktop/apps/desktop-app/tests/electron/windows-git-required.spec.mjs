import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('shows the Windows Git requirement gate before onboarding and app usage', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    freshOnboarding: true,
    env: {
      CANOPY_E2E_PLATFORM: 'win32',
      CANOPY_GIT_EXECUTABLE: '',
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await window.waitForLoadState('domcontentloaded');

    // The blocking first-run legal gate precedes the Git requirement gate.
    await app.acceptLegalConsent();

    await expect(
      window.getByTestId('windows-git-required-screen'),
    ).toBeVisible();
    await expect(window.getByTestId('git-gate-title')).toHaveText(
      'Git installation is required',
    );
    await expect(window.getByTestId('git-gate-manual')).toBeVisible();
    await expect(window.getByTestId('git-gate-recheck')).toBeVisible();

    await expect(window.getByTestId('app-sidebar')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

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
