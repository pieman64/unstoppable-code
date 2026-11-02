import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { writeAuthenticatedGhFixture } from './ghAuthFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

// First run lands on the ordinary Home composer without the retired checklist.
// Provider steps use the harness auth fixtures; no live agent sends are needed.

test('fresh user reaches the ordinary Home composer after the first-run page', async () => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  // The examples preview only queues behind a connected tool, so pin GitHub
  // as signed in instead of reading the host's own `gh` login.
  const env = { GH_EXECUTABLE: writeAuthenticatedGhFixture(userDataDir) };
  const { electronApp } = await launchCanopy({
    userDataDir,
    freshOnboarding: true,
    env,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    // Fresh launch shows the blocking first-run legal gate before the shell.
    await app.acceptLegalConsent();
    await app.waitForShell();
    await app.skipFirstRunImport();

    await expect(
      window.getByTestId('home-onboarding-subscription-prompt'),
    ).toBeHidden();
    await expect(
      window.getByTestId('home-onboarding-credits-remaining'),
    ).toBeHidden();
    // After the first-run page, the surface is the Home composer.
    await expect(window.getByTestId('page-home')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      window.getByTestId('home-composer-editor').locator('visible=true'),
    ).toBeVisible();
    await expect(window.getByTestId('home-onboarding-suggestions')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  // Relaunch preserves individual dismissals and keeps the next suggestion visible.
  const second = await launchCanopy({ userDataDir, env });
  try {
    const window2 = await second.electronApp.firstWindow();
    const app2 = new CanopyAppDriver(window2);
    await app2.waitForShell();
    await expect(window2.getByTestId('page-home')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      window2.getByTestId('home-onboarding-suggestions'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(second.electronApp, second.userDataDir);
  }
});

test('Home does not advertise plugin recommendations absent from the bundled catalog', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({
      pendingEntries: [
        'plugin:universal:google',
        'plugin:universal:slack',
        'plugin:universal:notion',
        'plugin:universal:datadog',
      ],
      enabledPlugins: ['gmail'],
    }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    for (const name of ['google', 'slack', 'notion', 'datadog'])
      await expect(
        window.getByTestId(
          `home-onboarding-suggestion-plugin:universal:${name}`,
        ),
      ).toHaveCount(0);
    await expect(
      window.getByTestId('home-composer-editor').locator('visible=true'),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
