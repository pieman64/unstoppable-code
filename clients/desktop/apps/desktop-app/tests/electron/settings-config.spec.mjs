import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

// Doc 3 supplemental gaps G8 (Notifications), G9 (Files), and G11 (Dictation).
// These are pure settings UI + local-preference persistence surfaces, so they
// run on the B0 baseline (no workspace/demo seeding). Each spec exercises the
// real on-disk persistence round-trip via a relaunch against a reused
// `userDataDir`. We deliberately never assert native OS notification delivery
// or real dictation probe results — both are platform-gated and out of scope.

// The activation-journey settings controls are gated on the same flag as the
// behavior they describe, so they must be driven on explicitly here. The flag
// is dark in both LaunchDarkly modes.
const ACTIVATION_FLAG_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-activation-journey-enabled': true,
  }),
};

test('activation settings stay hidden while the journey flag is dark', async () => {
  // Gating regression: these controls previously rendered and saved for every
  // user while the behavior behind them was flag-gated off, so a Windows user
  // could enable close-to-tray, watch it persist, and still have the app quit
  // on close.
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');

    await expect(
      window.getByTestId('notifications-toggle-quiet-hours'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('notifications-toggle-close-to-tray'),
    ).toHaveCount(0);
    // The promotional controls (CAN-3013) describe notifications that cannot
    // fire while dark, so the whole section must be hidden too.
    await expect(
      window.getByTestId('notifications-promotional-section'),
    ).toHaveCount(0);
    // The rest of the notifications tab is unaffected.
    await expect(
      window.getByTestId('notifications-toggle-master'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('promotional master and child toggles persist across relaunch', async () => {
  // Switching the master off disables the remaining category without
  // rewriting it; the retired Getting started category stays absent.
  let { electronApp, userDataDir } = await launchCanopy({
    env: ACTIVATION_FLAG_ENV,
  });

  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');

    const master = window.getByTestId(
      'notifications-toggle-promotional-master',
    );
    const arbitrary = window.getByTestId(
      'notifications-toggle-promotional-arbitrary',
    );

    // Everything ships on.
    await expect(master).toBeChecked();
    await expect(
      window.getByTestId('notifications-toggle-promotional-getting-started'),
    ).toHaveCount(0);
    await expect(arbitrary).toBeChecked();

    // The user's category choice survives disabling the master.
    await arbitrary.uncheck();
    await expect(arbitrary).not.toBeChecked();

    // Master off: the category keeps its value and cannot be changed.
    await master.uncheck();
    await expect(master).not.toBeChecked();
    await expect(arbitrary).not.toBeChecked();
    await expect(arbitrary).toBeDisabled();

    await closeCanopy(electronApp, userDataDir, { keepUserData: true });

    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ACTIVATION_FLAG_ENV,
    }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');

    const masterAfter = window.getByTestId(
      'notifications-toggle-promotional-master',
    );
    await expect(masterAfter).not.toBeChecked();

    // Master back on restores the user's own child selection.
    await masterAfter.check();
    await expect(
      window.getByTestId('notifications-toggle-promotional-getting-started'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('notifications-toggle-promotional-arbitrary'),
    ).toBeEnabled();
    await expect(
      window.getByTestId('notifications-toggle-promotional-arbitrary'),
    ).not.toBeChecked();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('activation quiet hours + close-to-tray persist across relaunch', async () => {
  // CAN-1967: the activation-journey settings surfaces. Quiet hours is
  // cross-platform; the close-to-tray toggle is Windows-only, so its presence
  // is asserted conditionally rather than skipping the whole spec.
  let { electronApp, userDataDir } = await launchCanopy({
    env: ACTIVATION_FLAG_ENV,
  });

  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');

    // Quiet hours ships enabled 22:00-08:00 (DEFAULT_ACTIVATION_QUIET_HOURS),
    // so the toggle starts checked with the hour selects rendered. Prove the
    // toggle round-trips off/on, then persist non-default hours.
    const quietToggle = window.getByTestId('notifications-toggle-quiet-hours');
    await expect(quietToggle).toBeChecked();

    const start = window.getByTestId('notifications-quiet-hours-start');
    const end = window.getByTestId('notifications-quiet-hours-end');
    await expect(start).toHaveAttribute('data-value', '22');
    await expect(end).toHaveAttribute('data-value', '8');

    await quietToggle.uncheck();
    await expect(quietToggle).not.toBeChecked();
    await expect(
      window.getByTestId('notifications-quiet-hours-start'),
    ).toHaveCount(0);
    await quietToggle.check();
    await expect(quietToggle).toBeChecked();
    await expect(start).toBeVisible();
    await expect(end).toBeVisible();

    await chooseSettingsOption(start, '23');
    await chooseSettingsOption(end, '7');
    await expect(start).toHaveAttribute('data-value', '23');
    await expect(end).toHaveAttribute('data-value', '7');

    // Equal start/end means "no quiet time", which is easy to set by accident,
    // so the UI has to say so rather than silently doing nothing.
    await chooseSettingsOption(end, '23');
    await expect(window.getByText(/Start and end are the same/i)).toBeVisible();
    await chooseSettingsOption(end, '7');

    const closeToTray = window.getByTestId(
      'notifications-toggle-close-to-tray',
    );
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      await expect(closeToTray).toBeVisible();
      await closeToTray.uncheck();
      await expect(closeToTray).not.toBeChecked();
    } else {
      // macOS keeps the app alive on window close by convention and Linux is
      // deliberately excluded, so the toggle must not render.
      await expect(closeToTray).toHaveCount(0);
    }

    await closeCanopy(electronApp, userDataDir, { keepUserData: true });

    // Relaunch against the same userDataDir: the values must come back from
    // disk, which is what proves the partial-patch save actually persisted.
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ACTIVATION_FLAG_ENV,
    }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');

    await expect(
      window.getByTestId('notifications-toggle-quiet-hours'),
    ).toBeChecked();
    await expect(
      window.getByTestId('notifications-quiet-hours-start'),
    ).toHaveAttribute('data-value', '23');
    await expect(
      window.getByTestId('notifications-quiet-hours-end'),
    ).toHaveAttribute('data-value', '7');
    if (isWindows) {
      await expect(
        window.getByTestId('notifications-toggle-close-to-tray'),
      ).not.toBeChecked();
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('G8: notifications in-app toggle + OS test-button gating persists across relaunch', async ({}, testInfo) => {
  // First launch: flip a per-event in-app toggle and confirm the OS-only test
  // buttons are correctly gated by the OS master toggle.
  let { electronApp, userDataDir } = await launchCanopy();

  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');

    // Every category row's OS controls (checkbox, sound, Test) stay inside
    // the group box instead of spilling past its right edge.
    const categoryOverflow = await window
      .getByTestId('notifications-test-chat')
      .evaluate((button) => {
        const group = button.closest('.divide-y');
        if (!group) return null;
        const box = group.getBoundingClientRect();
        const sound = document
          .querySelector('[data-testid="notifications-sound-chat"]')
          ?.getBoundingClientRect();
        return {
          testRightGap: box.right - button.getBoundingClientRect().right,
          soundRightGap: sound ? box.right - sound.right : null,
        };
      });
    expect(categoryOverflow).not.toBeNull();
    expect(categoryOverflow?.testRightGap).toBeGreaterThanOrEqual(0);
    expect(categoryOverflow?.soundRightGap).toBeGreaterThan(0);

    // In-app notifications default to enabled; the per-event `chat` in-app
    // toggle defaults to checked. Toggle it OFF and assert the checkbox state
    // updates deterministically (no agent activity / toast required).
    const inAppChatToggle = window.getByTestId(
      'notifications-toggle-in-app-chat',
    );
    await expect(inAppChatToggle).toBeChecked();
    await inAppChatToggle.uncheck();
    await expect(inAppChatToggle).not.toBeChecked();

    // OS notifications default to disabled (B0 baseline), so the per-event OS
    // "Test" button is disabled. We assert the gating rather than firing a
    // native OS notification.
    const osChatTest = window.getByTestId('notifications-test-chat');
    await expect(osChatTest).toBeDisabled();
    await expect(
      window.getByTestId('notifications-test-button'),
    ).toBeDisabled();

    // Enable the OS master toggle. The per-event `chat` OS toggle defaults to
    // checked, so its "Test" button — and the master "Send test notification"
    // button — must both become enabled. We assert the enabled state only and
    // never click to deliver a real native notification.
    const osMasterToggle = window.getByTestId('notifications-toggle-master');
    await expect(osMasterToggle).not.toBeChecked();
    await osMasterToggle.check();
    await expect(osMasterToggle).toBeChecked();
    await expect(
      window.getByTestId('notifications-toggle-os-chat'),
    ).toBeChecked();
    await expect(osChatTest).toBeEnabled();
    await expect(window.getByTestId('notifications-test-button')).toBeEnabled();

    await app.closeSettings();
    await window.screenshot({
      path: testInfo.outputPath('settings-notifications.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  // Relaunch against the same userDataDir and assert both the in-app per-event
  // toggle and the OS master toggle persisted to disk.
  ({ electronApp } = await launchCanopy({ userDataDir }));
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');

    await expect(
      window.getByTestId('notifications-toggle-in-app-chat'),
    ).not.toBeChecked();
    await expect(
      window.getByTestId('notifications-toggle-master'),
    ).toBeChecked();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('G9: files custom-glob add/validation/remove + auto-save persists across relaunch', async ({}, testInfo) => {
  const customPattern = '**/generated/**';

  let { electronApp, userDataDir } = await launchCanopy();

  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('files');
    await app.expectSettingsSection('files');

    // The Do-not-index config lives in a collapsed disclosure section.
    await window.getByTestId('settings-files-do-not-index-toggle').click();

    // Empty state for custom globs.
    await expect(
      window.getByTestId('settings-files-custom-empty'),
    ).toBeVisible();
    await expect(window.getByTestId('settings-files-custom-error')).toHaveCount(
      0,
    );

    // Add a valid custom glob → a row renders and the empty state disappears.
    const input = window.getByTestId('settings-files-custom-input');
    await input.fill(customPattern);
    await window.getByTestId('settings-files-custom-add').click();
    await expect(window.getByTestId('settings-files-custom-empty')).toHaveCount(
      0,
    );
    const customRow = window
      .locator('[data-testid^="settings-files-custom-"]')
      .filter({ hasText: customPattern });
    await expect(customRow).toHaveCount(1);

    // Adding the same pattern again surfaces the duplicate validation error.
    await input.fill(customPattern);
    await window.getByTestId('settings-files-custom-add').click();
    await expect(window.getByTestId('settings-files-custom-error')).toHaveText(
      'This glob is already listed.',
    );

    // Adding a whitespace-only pattern surfaces the empty validation error.
    await input.fill('   ');
    await window.getByTestId('settings-files-custom-add').click();
    await expect(window.getByTestId('settings-files-custom-error')).toHaveText(
      'Enter a glob pattern.',
    );

    // Remove the added row → back to the empty state.
    await customRow
      .getByRole('button', { name: `Remove ${customPattern}` })
      .click();
    await expect(
      window.getByTestId('settings-files-custom-empty'),
    ).toBeVisible();

    // Toggle Auto Save off (defaults on/off depend on backend; assert the flip
    // is observable via aria-checked and persist whatever the new value is).
    const autoSave = window.getByTestId('settings-files-auto-save');
    const initialAutoSave =
      (await autoSave.getAttribute('aria-checked')) === 'true';
    await autoSave.click();
    await expect(autoSave).toHaveAttribute(
      'aria-checked',
      String(!initialAutoSave),
    );

    // Re-add the pattern so we can assert it persists across relaunch.
    await input.fill(customPattern);
    await window.getByTestId('settings-files-custom-add').click();
    await expect(
      window
        .locator('[data-testid^="settings-files-custom-"]')
        .filter({ hasText: customPattern }),
    ).toHaveCount(1);

    await app.closeSettings();
    await window.screenshot({
      path: testInfo.outputPath('settings-files.png'),
    });

    // Stash the expected post-toggle auto-save value for the relaunch assertion.
    test.info().annotations.push({
      type: 'expected-auto-save',
      description: String(!initialAutoSave),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  const expectedAutoSave =
    test.info().annotations.find((a) => a.type === 'expected-auto-save')
      ?.description ?? 'false';

  ({ electronApp } = await launchCanopy({ userDataDir }));
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('files');
    await app.expectSettingsSection('files');

    // The Do-not-index config lives in a collapsed disclosure section.
    await window.getByTestId('settings-files-do-not-index-toggle').click();

    // The custom glob persisted.
    await expect(
      window
        .locator('[data-testid^="settings-files-custom-"]')
        .filter({ hasText: customPattern }),
    ).toHaveCount(1);
    await expect(window.getByTestId('settings-files-custom-empty')).toHaveCount(
      0,
    );

    // The auto-save toggle persisted to its flipped value.
    await expect(
      window.getByTestId('settings-files-auto-save'),
    ).toHaveAttribute('aria-checked', expectedAutoSave);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('G11: dictation tab renders, toggle persists, and recheck shows no error', async ({}, testInfo) => {
  let { electronApp, userDataDir } = await launchCanopy();

  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('dictation');
    await app.expectSettingsSection('dictation');

    // Structural: the enable toggle and recheck control render.
    const enableToggle = window.getByTestId('dictation-enabled-toggle');
    await expect(enableToggle).toBeVisible();
    const recheck = window.getByTestId('dictation-recheck');
    await expect(recheck).toBeVisible();

    // Flip the enable toggle (default value is backend-driven) and assert the
    // checkbox state changed.
    const initialEnabled = await enableToggle.isChecked();
    if (initialEnabled) {
      await enableToggle.uncheck();
      await expect(enableToggle).not.toBeChecked();
    } else {
      await enableToggle.check();
      await expect(enableToggle).toBeChecked();
    }

    // Stash the expected flipped value for the relaunch persistence assertion.
    test.info().annotations.push({
      type: 'expected-dictation-enabled',
      description: String(!initialEnabled),
    });

    // The recheck button re-probes platform support. The probe is platform-gated
    // (real transcription is not automatable), so we only assert the control
    // settles back to its clickable label and the tab stays mounted — i.e. the
    // recheck did not crash or throw into an error boundary.
    await recheck.click();
    await expect(recheck).toHaveText('Re-check');
    await expect(recheck).toBeEnabled();
    await app.expectSettingsSection('dictation');

    await app.closeSettings();
    await window.screenshot({
      path: testInfo.outputPath('settings-dictation.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  const expectedDictationEnabled =
    test.info().annotations.find((a) => a.type === 'expected-dictation-enabled')
      ?.description ?? 'false';

  // Relaunch and assert the enable toggle persisted to its flipped value.
  ({ electronApp } = await launchCanopy({ userDataDir }));
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('dictation');
    await app.expectSettingsSection('dictation');

    const persisted = window.getByTestId('dictation-enabled-toggle');
    await expect(persisted).toBeVisible();
    if (expectedDictationEnabled === 'true') {
      await expect(persisted).toBeChecked();
    } else {
      await expect(persisted).not.toBeChecked();
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
