import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';

const LIGHT_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#f5b700"/></svg>';
const DARK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="#6554c0"/></svg>';
const LIGHT_ICON_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(LIGHT_ICON_SVG).toString('base64')}`;
const DARK_ICON_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(DARK_ICON_SVG).toString('base64')}`;
const INTERACTIVE_PRESET_COMMAND =
  "printf 'TUI_READY\\n\\033]10;?\\007\\033]11;?\\007'; read -s tui_exit";

test('Terminal settings control nested panel-picker shells, presets, and settings navigation', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  const app = new CanopyAppDriver(window);

  try {
    await app.openSettings();
    await app.openSettingsSection('terminal');

    await expect(
      window.getByRole('heading', { name: 'Terminal', exact: true }),
    ).toBeVisible();
    await expect(window.getByTestId('terminal-settings-shells')).toBeVisible();
    const settingsShellRows = window.locator(
      '[data-testid^="terminal-shell-option-"]',
    );
    await expect(settingsShellRows).toHaveCount(2);
    await expect(settingsShellRows.nth(0)).toContainText('zsh');
    await expect(settingsShellRows.nth(1)).toContainText('bash');
    const settingsDefaultBadge = window.getByTestId(
      'terminal-shell-default-badge',
    );
    await expect(settingsDefaultBadge).toHaveCount(1);
    const settingsDefaultRow = settingsShellRows.filter({
      has: settingsDefaultBadge,
    });
    const defaultShellProfileId = (
      await settingsDefaultRow.getAttribute('data-testid')
    )?.replace('terminal-shell-option-', '');
    expect(defaultShellProfileId).toBeTruthy();
    const settingsDefaultToggle = settingsDefaultRow.getByRole('switch');
    await settingsDefaultBadge.hover();
    await expect(window.getByRole('tooltip')).toContainText(
      /This shell will be used for interactive scripts invoked by .+\./,
    );
    await expect(settingsDefaultToggle).toHaveAttribute('aria-checked', 'true');

    const shellToggles = window.locator(
      '[data-testid^="terminal-shell-toggle-"]',
    );
    const shellCount = await shellToggles.count();
    expect(shellCount).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < shellCount; index += 1) {
      const toggle = shellToggles.nth(index);
      if ((await toggle.getAttribute('aria-checked')) === 'true') {
        await toggle.click();
      }
    }

    await app.closeSettings();
    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-terminal-submenu').click();
    await expect(
      window.getByTestId('panel-add-menu-terminal-shells-group'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('panel-add-menu-terminal-presets-group'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('panel-add-menu-terminal-settings'),
    ).toBeVisible();

    await window.getByTestId('panel-add-menu-terminal-settings').click();
    await app.expectSettingsSection('terminal');

    const reopenedShellRows = window.locator(
      '[data-testid^="terminal-shell-option-"]',
    );
    const reopenedDefaultRow = reopenedShellRows.filter({
      has: window.getByTestId('terminal-shell-default-badge'),
    });
    await reopenedDefaultRow.getByRole('switch').click();
    await window.getByTestId('terminal-preset-add').click();
    const preset = window.getByTestId('terminal-preset-editor');
    await expect(preset.getByLabel('Preset name')).toHaveAttribute(
      'placeholder',
      'Custom TUI',
    );
    await expect(preset.getByLabel('Shell')).toHaveValue(defaultShellProfileId);
    await preset.getByLabel('Preset name').fill('Project status');
    await preset.getByLabel('Command').fill(INTERACTIVE_PRESET_COMMAND);
    await preset.getByLabel('Image or SVG').setInputFiles({
      name: 'light.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(LIGHT_ICON_SVG),
    });
    await expect(
      preset.getByTestId('terminal-preset-image-light-preview'),
    ).toHaveAttribute('src', LIGHT_ICON_DATA_URL);
    await expect(
      preset.getByTestId('terminal-preset-image-dark-preview'),
    ).toHaveAttribute('src', LIGHT_ICON_DATA_URL);
    await preset.getByLabel('Dark mode image').setInputFiles({
      name: 'dark.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(DARK_ICON_SVG),
    });
    const swapImages = preset.getByRole('button', {
      name: 'Swap light and dark preset images',
    });
    await expect(swapImages).toBeVisible();
    await swapImages.click();
    await expect(
      preset.getByTestId('terminal-preset-image-light-preview'),
    ).toHaveAttribute('src', DARK_ICON_DATA_URL);
    await expect(
      preset.getByTestId('terminal-preset-image-dark-preview'),
    ).toHaveAttribute('src', LIGHT_ICON_DATA_URL);
    await preset.getByRole('button', { name: 'Save preset' }).click();
    await expect(window.getByTestId('terminal-preset-editor')).toHaveCount(0);
    await expect(
      window.getByTestId('terminal-preset-image-light'),
    ).toHaveAttribute('src', DARK_ICON_DATA_URL);
    await expect(
      window.getByTestId('terminal-preset-image-dark'),
    ).toHaveAttribute('src', LIGHT_ICON_DATA_URL);

    await app.closeSettings();
    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-terminal-submenu').click();
    const terminalMenu = window.getByTestId('panel-add-menu-terminal-group');
    await expect(
      terminalMenu.getByTestId('panel-add-menu-terminal-shells-group'),
    ).toBeVisible();
    await expect(
      terminalMenu.getByTestId('panel-add-menu-terminal-presets-group'),
    ).toBeVisible();
    const pickerShells = terminalMenu.locator(
      '[role="menuitem"][data-testid^="panel-add-menu-item-terminal"]',
    );
    await expect(pickerShells.filter({ hasText: /^Default$/ })).toHaveCount(0);
    await expect(
      terminalMenu.getByTestId('panel-add-menu-item-terminal-default-badge'),
    ).toHaveText('Default');
    await terminalMenu
      .getByTestId('panel-add-menu-item-terminal-default-badge')
      .hover();
    await expect(window.getByRole('tooltip')).toContainText(
      /This shell will be used for interactive scripts invoked by .+\./,
    );
    await expect(
      terminalMenu.getByTestId('panel-add-menu-item-terminal-preset').filter({
        hasText: 'Project status',
      }),
    ).toBeVisible();
    await expect(
      terminalMenu
        .getByTestId('panel-add-menu-item-terminal-preset-icon')
        .locator('img'),
    ).toHaveAttribute('src', DARK_ICON_DATA_URL);

    const orderedText = await terminalMenu.innerText();
    expect(orderedText.indexOf('Shells')).toBeLessThan(
      orderedText.indexOf('Presets'),
    );
    expect(orderedText.indexOf('Presets')).toBeLessThan(
      orderedText.indexOf('Settings'),
    );

    await window.evaluate(() => {
      document.documentElement.classList.add('dark');
    });
    await expect(
      terminalMenu
        .getByTestId('panel-add-menu-item-terminal-preset-icon')
        .locator('img'),
    ).toHaveAttribute('src', LIGHT_ICON_DATA_URL);

    await terminalMenu
      .getByTestId('panel-add-menu-item-terminal-preset')
      .filter({ hasText: 'Project status' })
      .click();
    const presetTerminal = window.getByTestId('terminal-pane').last();
    await expect(presetTerminal).toContainText('TUI_READY', {
      timeout: 20_000,
    });
    await expect(presetTerminal).not.toContainText(INTERACTIVE_PRESET_COMMAND);
    await presetTerminal.click();
    await window.keyboard.type('/exit');
    await window.keyboard.press('Enter');
    const restartPreset = presetTerminal.getByTestId('terminal-restart-button');
    await expect(restartPreset).toBeVisible({ timeout: 20_000 });
    await restartPreset.click();
    await expect
      .poll(
        async () => {
          const text = await presetTerminal.innerText();
          return text.match(/TUI_READY/g)?.length ?? 0;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(2);
    await expect(presetTerminal).not.toContainText(INTERACTIVE_PRESET_COMMAND);
    await expect(restartPreset).toBeHidden();
    await presetTerminal.click();
    await window.keyboard.type('/exit');
    await window.keyboard.press('Enter');
    await expect(restartPreset).toBeVisible({ timeout: 20_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Terminal settings reject preset images that persistence cannot retain', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  const app = new CanopyAppDriver(window);

  try {
    await app.openSettings();
    await app.openSettingsSection('terminal');
    await window.getByTestId('terminal-preset-add').click();

    const editor = window.getByTestId('terminal-preset-editor');
    const imageInput = editor.getByLabel('Image or SVG');
    await expect(imageInput).toHaveAttribute(
      'accept',
      'image/png,image/jpeg,image/gif,image/webp,image/svg+xml',
    );

    await imageInput.setInputFiles({
      name: 'unsupported.bmp',
      mimeType: 'image/bmp',
      buffer: Buffer.from('unsupported-image'),
    });
    await expect(window.getByRole('alert')).toContainText(
      'Preset icons must be PNG, JPEG, GIF, WebP, or SVG images.',
    );
    await expect(editor.getByTestId('terminal-preset-images')).toHaveCount(0);

    await imageInput.setInputFiles({
      name: 'too-large.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.alloc(750_000, 'x'),
    });
    await expect(window.getByRole('alert')).toContainText(
      'Preset icons must be smaller than 1 MB after encoding.',
    );
    await expect(editor.getByTestId('terminal-preset-images')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('App Advisor can navigate the main window to Terminal settings', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  const app = new CanopyAppDriver(window);

  try {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      mainWindow.webContents.send('app-advisor:tool-request', {
        kind: 'dispatch_action',
        requestId: 'terminal-settings-navigation',
        originWorktreeId: 'e2e-origin',
        action: {
          type: 'navigation.open_settings',
          section: 'terminal',
        },
      });
    });

    await app.expectSettingsSection('terminal');
    await expect(
      window.getByRole('heading', { name: 'Terminal', exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('preset commands with trailing comments still exit and become restartable', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  const app = new CanopyAppDriver(window);

  try {
    await app.openSettings();
    await app.openSettingsSection('terminal');
    await window.getByTestId('terminal-preset-add').click();
    const editor = window.getByTestId('terminal-preset-editor');
    await editor.getByLabel('Preset name').fill('Commented command');
    await editor
      .getByLabel('Command')
      .fill("printf 'COMMENT_EXIT_OK\\n' # user note");
    await editor.getByRole('button', { name: 'Save preset' }).click();
    await app.closeSettings();

    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-terminal-submenu').click();
    await window
      .getByTestId('panel-add-menu-item-terminal-preset')
      .filter({ hasText: 'Commented command' })
      .click();

    const terminal = window.getByTestId('terminal-pane').last();
    await expect(terminal).toContainText('COMMENT_EXIT_OK', {
      timeout: 20_000,
    });
    await expect(terminal.getByTestId('terminal-restart-button')).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
