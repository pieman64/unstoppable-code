import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { launchMobileOnboarding } from './seeders/launchMobileOnboarding.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

test('mobile is the final setup step, opens the existing QR experience, and can be skipped', async () => {
  test.skip(
    process.env.CANOPY_BRAND !== 'unstoppable-code',
    'requires a brand with mobile store listings',
  );
  // The global hotkey is the last live setup step before mobile.
  const launch = await launchMobileOnboarding({
    pendingEntry: 'focus-shortcut',
  });
  try {
    const { window, app } = launch;
    // Home shows the full card, so the sidebar card is absent here.
    await expect(app.homeChecklistRow('focus-shortcut')).toBeVisible();
    await window
      .getByTestId('home-onboarding-suggestion-dismiss-focus-shortcut')
      .click();
    await expect(app.homeChecklistRow('mobile-app')).toBeVisible();
    // The mobile step keeps its Home surface while the sidebar card steps aside.
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-get-mobile-app'),
    ).toHaveText('Keep your agents going with the mobile app');
    await expect(
      app
        .homeChecklistRow('mobile-app')
        .getByTestId('home-onboarding-checklist-progress'),
    ).toHaveText(/^\d+\/\d+$/);
    await window.getByTestId('home-onboarding-get-mobile-app').click();
    const dialog = window.getByRole('dialog', {
      name: 'Get the mobile app',
      exact: true,
    });
    const promo = dialog.getByTestId('mobile-app-qr-promo');
    await expect(promo).toBeVisible();
    await expect(promo.getByTestId('mobile-app-qr')).toHaveCount(1);
    await promo.getByTestId('mobile-app-qr-tab-play').click();
    await expect(promo.getByTestId('store-badge-google-play')).toBeVisible();
    await window.keyboard.press('Escape');
    // Merely opening the download UI is not activation or completion.
    await expect(app.homeChecklistRow('mobile-app')).toBeVisible();
    await window
      .getByTestId('home-onboarding-suggestion-dismiss-mobile-app')
      .click();
    await expect(
      window.getByTestId('home-onboarding-checklist-progress'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeVisible();
    await window.reload();
    await launch.app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(app.homeChecklistRow('mobile-app')).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-get-mobile-app'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('mobile activation hides the checklist CTA and any open download dialog live', async () => {
  test.skip(
    process.env.CANOPY_BRAND !== 'unstoppable-code',
    'requires a brand with mobile store listings',
  );
  const launch = await launchMobileOnboarding();
  try {
    const { window } = launch;
    await window.getByTestId('home-onboarding-get-mobile-app').click();
    const dialog = window.getByRole('dialog', {
      name: 'Get the mobile app',
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await connectMockCloudAccount(window, 'csk_mobile_activation_e2e');
    await expect(dialog).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-get-mobile-app'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeVisible();
    // Home hides the sidebar card anyway, so check it from Plugins.
    await launch.app.openPluginsPage();
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('already-activated accounts and brands without listings get no mobile checklist CTA', async () => {
  const launch = await launchMobileOnboarding({ activated: true });
  try {
    await expect(
      launch.window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeVisible();
    await expect(
      launch.window.getByTestId('home-onboarding-get-mobile-app'),
    ).toHaveCount(0);
    // Home hides the sidebar card anyway, so check it from Plugins.
    await launch.app.openPluginsPage();
    await expect(
      launch.window.getByTestId('sidebar-onboarding-checklist'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
