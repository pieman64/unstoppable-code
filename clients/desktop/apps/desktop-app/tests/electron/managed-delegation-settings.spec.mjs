import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  chooseSettingsOption,
  settingsOptionValues,
} from './helpers/settingsSelect.mjs';

test('managed delegation lifetime limit shows the shipped cap and persists across reload', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    const lifetime = window.getByTestId(
      'settings-managed-delegation-lifetime-limit',
    );
    await expect(lifetime).toBeVisible();
    await expect(lifetime).toHaveAttribute('data-value', '512');
    await expect(lifetime).toBeDisabled();
    // A disabled dropdown cannot open; its one choice is the label it shows.
    await expect(lifetime).toHaveText('512');
    await expect(
      window.getByTestId('settings-managed-delegation-lifetime-limit-help'),
    ).toHaveText(
      'Managed delegates a worktree can start over its lifetime, separate from how many run at once. This build allows only 512.',
    );
    // The only shipped choice is disabled; exercise the existing preference
    // writer rather than pretending the user can select a higher allowance.
    const saved = await window.evaluate(async () => {
      const preferences = await window.api.savePreferences({
        managedDelegationLifetimeLimit: 512,
      });
      return preferences.managedDelegationLifetimeLimit;
    });
    expect(saved).toBe(512);
    await window.reload();
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(lifetime).toHaveAttribute('data-value', '512');
    expect(
      await window.evaluate(
        async () =>
          (await window.api.loadPreferences()).managedDelegationLifetimeLimit,
      ),
    ).toBe(512);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// On non-Linux hosts this exercises the Linux renderer through the existing
// E2E platform seam. It is not evidence of native Linux process confinement.
test('Linux managed delegation stays opt-in with usable limits and durable policy choices', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_E2E_PLATFORM: 'linux' },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    expect(await window.evaluate(() => window.platform)).toBe('linux');
    const settings = window.getByTestId('managed-delegation-settings');
    const mode = window.getByTestId('settings-managed-delegation-mode');
    const depth = window.getByTestId('settings-managed-delegation-depth');
    const concurrency = window.getByTestId(
      'settings-managed-delegation-concurrency',
    );
    await expect(mode).toHaveAttribute('data-value', 'off');
    await expect(mode).toBeEnabled();
    await expect(depth).toBeEnabled();
    await expect(concurrency).toBeEnabled();
    await expect(settings).toContainText('Code worktree chats');
    await expect(settings).toContainText('Your approval settings still apply.');
    await expect(
      window.getByTestId('settings-managed-delegation-windows-codex'),
    ).toHaveCount(0);
    await chooseSettingsOption(concurrency, '2');
    await expect(concurrency).toBeEnabled();
    await chooseSettingsOption(depth, '3');
    await expect(depth).toBeEnabled();
    // Editing limits must not implicitly opt in.
    await expect(mode).toHaveAttribute('data-value', 'off');
    for (const value of ['explicit-only', 'proactive', 'off']) {
      await chooseSettingsOption(mode, value);
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const preferences = await window.api.loadPreferences();
            return [
              preferences.managedDelegationMode,
              preferences.managedDelegationMaxConcurrent,
              preferences.managedDelegationMaxDepth,
            ];
          }),
        )
        .toEqual([value, 2, 3]);
      await window.reload();
      await app.waitForShell();
      await app.openSettings();
      await app.openSettingsSection('experiments');
      await expect(mode).toHaveAttribute('data-value', value);
      await expect(concurrency).toHaveAttribute('data-value', '2');
      await expect(depth).toHaveAttribute('data-value', '3');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

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
    await expect(depth).toHaveAttribute('data-value', '1');
    expect(await settingsOptionValues(depth)).toHaveLength(10);
    await chooseSettingsOption(depth, '10');
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
    await expect(depth).toHaveAttribute('data-value', '10');
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
      await expect(mode).toHaveAttribute('data-value', 'off');
      await expect(
        window.getByTestId('managed-delegation-settings'),
      ).toContainText('explicit file permissions');
      for (const value of ['explicit-only', 'proactive', 'off']) {
        await chooseSettingsOption(mode, value);
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
        await expect(mode).toHaveAttribute('data-value', value);
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
    await chooseSettingsOption(mode, 'proactive');
    await expect(mode).toHaveAttribute('data-value', 'proactive');
    await chooseSettingsOption(mode, 'off');

    await expect(mode).toHaveAttribute('data-value', 'off');
    await expect(
      window.getByText(
        'Consultation is off, but some child sessions could not be stopped.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      window.getByRole('button', { name: 'Try again', exact: true }),
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
    await expect(limit).toHaveAttribute('data-value', '5');
    // The application-wide cap is 64 (was 16); the select offers every value
    // in that range, not just the historical 1-16.
    const options = await settingsOptionValues(limit);
    expect(options).toHaveLength(64);
    expect(options[0]).toBe('1');
    expect(options.at(-1)).toBe('64');
    await expect(
      window.getByTestId('settings-managed-delegation-concurrency-help'),
    ).toHaveText(
      'Active managed subagents across the whole chat, including nested agents. Defaults to 5. Tasks over the limit wait their turn and start automatically. Changes apply to new tasks; running tasks continue. The application-wide limit is 64.',
    );
    await chooseSettingsOption(limit, '2');
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
    await expect(limit).toHaveAttribute('data-value', '2');
    await chooseSettingsOption(
      window.getByTestId('settings-managed-delegation-mode'),
      'proactive',
    );
    await expect(
      window.getByTestId('settings-managed-delegation-mode'),
    ).toHaveAttribute('data-value', 'proactive');
    await expect(limit).toHaveAttribute('data-value', '2');

    // The higher ceiling (was capped at 16) persists across reload too.
    await chooseSettingsOption(limit, '64');
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
    await expect(limit).toHaveAttribute('data-value', '64');
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
    if ((await window.evaluate(() => window.platform)) !== 'win32') {
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
