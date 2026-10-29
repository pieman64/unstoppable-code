import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('managed delegation depth defaults to one and persists the maximum of ten', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    const depth = window.getByTestId('settings-managed-delegation-depth');
    await expect(depth).toHaveValue('1');
    await expect(depth.locator('option')).toHaveCount(10);
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      await expect(depth).toBeDisabled();
      return;
    }
    await depth.selectOption('10');
    await expect
      .poll(() =>
        window.evaluate(
          async () =>
            (await window.api.loadPreferences()).managedDelegationMaxDepth,
        ),
      )
      .toBe(10);
    await window.reload();
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(depth).toHaveValue('10');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const legacyValue of [undefined, '1']) {
  test(`managed consultation is opt-in and saves explicit and proactive policies across reload (legacy env ${legacyValue ?? 'unset'})`, async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_DEVELOPMENT_DELEGATION: legacyValue },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.openSettings();
      await app.openSettingsSection('experiments');
      await expect(
        window.getByRole('heading', {
          name: 'Managed delegation',
          exact: true,
        }),
      ).toBeVisible();
      await app.openSettingsSection('chat');
      await expect(
        window.getByTestId('managed-delegation-settings'),
      ).toHaveCount(0);
      await app.openSettingsSection('experiments');
      const mode = window.getByTestId('settings-managed-delegation-mode');
      await expect(mode).toHaveValue('off');
      await expect(
        window.getByTestId('managed-delegation-settings'),
      ).toContainText('explicit file permissions');
      if (process.platform !== 'darwin' && process.platform !== 'win32') {
        await expect(mode).toBeDisabled();
        return;
      }
      for (const value of ['explicit-only', 'proactive', 'off']) {
        await mode.selectOption(value);
        await expect
          .poll(() =>
            window.evaluate(
              async () =>
                (await window.api.loadPreferences()).managedDelegationMode,
            ),
          )
          .toBe(value);
        await window.reload();
        await app.waitForShell();
        await app.openSettings();
        await app.openSettingsSection('experiments');
        await expect(mode).toHaveValue(value);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('turning consultation off warns when child shutdown is incomplete', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_E2E_FORCE_DELEGATION_REVOCATION_FAILURE: '1' },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    const mode = window.getByTestId('settings-managed-delegation-mode');
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      await expect(mode).toBeDisabled();
      return;
    }
    await mode.selectOption('proactive');
    await expect(mode).toHaveValue('proactive');
    await mode.selectOption('off');

    await expect(mode).toHaveValue('off');
    await expect(
      window.getByText(
        'Consultation is off, but some child sessions could not be stopped.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      window.getByRole('button', { name: 'Retry shutdown', exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('managed delegation concurrency offers 1-64, defaults to five, and persists a custom limit', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    const limit = window.getByTestId('settings-managed-delegation-concurrency');
    await expect(limit).toHaveValue('5');
    // The application-wide cap is 64 (was 16); the select offers every value
    // in that range, not just the historical 1-16.
    const options = limit.locator('option');
    await expect(options).toHaveCount(64);
    await expect(options.first()).toHaveAttribute('value', '1');
    await expect(options.last()).toHaveAttribute('value', '64');
    await expect(
      window.getByTestId('settings-managed-delegation-concurrency-help'),
    ).toHaveText(
      'Active managed subagents across the whole chat, including nested agents. Defaults to 5. Tasks over the limit wait their turn and start automatically. Changes apply to new tasks; running tasks continue. The application-wide limit is 64.',
    );
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      await expect(limit).toBeDisabled();
      return;
    }
    await limit.selectOption('2');
    await expect
      .poll(() =>
        window.evaluate(
          async () =>
            (await window.api.loadPreferences()).managedDelegationMaxConcurrent,
        ),
      )
      .toBe(2);
    await window.reload();
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(limit).toHaveValue('2');
    await window
      .getByTestId('settings-managed-delegation-mode')
      .selectOption('proactive');
    await expect(
      window.getByTestId('settings-managed-delegation-mode'),
    ).toHaveValue('proactive');
    await expect(limit).toHaveValue('2');

    // The higher ceiling (was capped at 16) persists across reload too.
    await limit.selectOption('64');
    await expect
      .poll(() =>
        window.evaluate(
          async () =>
            (await window.api.loadPreferences()).managedDelegationMaxConcurrent,
        ),
      )
      .toBe(64);
    await window.reload();
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(limit).toHaveValue('64');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('says Codex tasks run without the Codex sandbox on Windows only', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(
      window.getByTestId('managed-delegation-settings'),
    ).toBeVisible();
    const note = window.getByTestId(
      'settings-managed-delegation-windows-codex',
    );
    if (process.platform !== 'win32') {
      await expect(note).toHaveCount(0);
      return;
    }
    await expect(note).toHaveText(
      "On Windows, Codex tasks run without the Codex sandbox and follow this chat's approval settings.",
    );
    // The managed delegation controls are enabled on Windows.
    await expect(
      window.getByTestId('settings-managed-delegation-mode'),
    ).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
