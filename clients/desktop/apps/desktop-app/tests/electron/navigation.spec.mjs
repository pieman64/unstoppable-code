import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('navigates the primary application pages', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();
    await app.openChatPage();
    await app.openPipelinesPage();
    await app.openMarketplaceAgents();
    await app.openPluginsPage();
    await app.openAuditPage();
    await app.openUsagePage();
    await app.openPluginsPage();

    await app.openPluginsTab('collections');
    await app.expectPluginsTab('collections');

    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');

    await app.openPluginsTab('mcp');
    await app.expectPluginsTab('mcp');

    await app.openPluginsTab('marketplace');
    await app.expectPluginsTab('marketplace');

    await app.openMainPage();
    await window.screenshot({
      path: testInfo.outputPath('navigation-pages.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('opens and navigates settings sections', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    // CAN-4421: with hosted account settings on, the local Accounts section
    // is "Providers", and Notifications is a hosted account page.
    await app.openSettingsSection('account');
    await expect(
      window.getByRole('heading', { name: 'Providers', exact: true }),
    ).toBeVisible();
    await app.openSettingsSection('display');
    await app.expectSettingsSection('display');
    await app.openAccountSettingsPage('notifications');
    await app.openSettingsSection('mcp');
    await app.expectSettingsSection('mcp');
    await app.openSettingsSection('shortcuts');
    await expect(
      window.getByRole('heading', {
        name: 'Keyboard shortcuts',
        exact: true,
      }),
    ).toBeVisible();
    await app.openSettingsSection('chat');
    await expect(
      window.getByRole('heading', { name: 'Models', exact: true }),
    ).toBeVisible();
    await app.openSettingsSection('instructions');
    await expect(
      window.getByRole('heading', { name: 'Instructions', exact: true }),
    ).toBeVisible();
    await app.openSettingsSection('files');
    await app.expectSettingsSection('files');
    await app.openSettingsSection('dictation');
    await app.expectSettingsSection('dictation');
    await app.openSettingsSection('codex');
    await app.expectSettingsSection('codex');
    await app.openSettingsSection('ollama');
    await app.expectSettingsSection('ollama');
    await app.openSettingsSection('git');
    await expect(
      window.getByRole('heading', { name: 'Git', exact: true }),
    ).toBeVisible();
    await app.openSettingsSection('applications');
    await app.expectSettingsSection('applications');
    await app.openSettingsSection('canopy');
    await app.closeSettings();
    await app.expectMainPage();
    await window.screenshot({
      path: testInfo.outputPath('navigation-settings.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('opens the command palette with the global shortcut', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+K' : 'Control+K',
    );
    await expect(window.getByTestId('command-palette-input')).toBeVisible();
    await window.screenshot({
      path: testInfo.outputPath('navigation-command-palette.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('opens settings with the global shortcut from a focused composer input', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openChatPage();

    // Focus the chat composer (a Slate `contenteditable`, role="textbox") so
    // the shortcut must escape an active text-input context. _(717)_
    // The Cowork tab cold-starts to a full-area empty state while the chat
    // store hydrates, so wait for either the composer or the cold-start CTA
    // to render before deciding — an instant isVisible() probe races the
    // hydration and can miss the CTA, leaving no composer to focus.
    const chatPage = window.getByTestId('page-chat');
    const emptyNewChat = chatPage.getByTestId('empty-new-chat');
    const composer = chatPage.locator(
      '[data-chat-textarea][contenteditable="true"]',
    );
    await expect(composer.or(emptyNewChat).first()).toBeVisible();
    if (await emptyNewChat.isVisible().catch(() => false)) {
      await emptyNewChat.click();
    }
    await expect(composer).toBeVisible();
    await composer.click();

    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+,' : 'Control+,',
    );
    await expect(window.getByTestId('settings-overlay')).toBeVisible();

    await app.closeSettings();
    await app.expectChatPage();
    await window.screenshot({
      path: testInfo.outputPath('navigation-settings-from-composer.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('opens settings with the global shortcut from an open command palette', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();

    // Open the command palette, then trigger the global settings shortcut while
    // its search input is focused. _(717)_
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+K' : 'Control+K',
    );
    const paletteInput = window.getByTestId('command-palette-input');
    await expect(paletteInput).toBeVisible();
    await paletteInput.click();

    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+,' : 'Control+,',
    );
    await expect(window.getByTestId('settings-overlay')).toBeVisible();

    await app.closeSettings();
    await window.screenshot({
      path: testInfo.outputPath('navigation-settings-from-palette.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('does not trigger page shortcuts while settings is open', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openChatPage();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+,' : 'Control+,',
    );
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+7' : 'Control+7',
    );
    await app.closeSettings();
    await app.expectChatPage();
    await window.screenshot({
      path: testInfo.outputPath('navigation-settings-shortcut-guard.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
