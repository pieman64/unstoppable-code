import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const DEFERRED_TOOLS_TOGGLES = [
  {
    testId: 'settings-plugins-deferred-worktree-chats',
    field: 'deferredToolsWorktreeChatsEnabled',
  },
  {
    testId: 'settings-plugins-deferred-standalone-chats',
    field: 'deferredToolsStandaloneChatsEnabled',
  },
  {
    testId: 'settings-plugins-deferred-app-advisor',
    field: 'deferredToolsAppAdvisorEnabled',
  },
  {
    testId: 'settings-plugins-deferred-pipeline-assistant',
    field: 'deferredToolsPipelineAssistantEnabled',
  },
];

test('Settings → Plugins persists deferred-tools defaults', async () => {
  test.setTimeout(120_000);

  const launch = await launchCanopy();
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('plugins');
    await expect(window.getByTestId('settings-tab-plugins')).toBeVisible();

    const created = await window.evaluate(() =>
      window.skills.saveCustomSkill({
        name: 'settings-active-skill',
        description: 'Settings fixture',
        body: 'A deterministic skill.',
      }),
    );
    expect(created.success).toBe(true);
    await window.getByTestId('active-items-summary-manage').click();
    const statusFilter = window.getByTestId(
      'customize-installed-status-filter',
    );
    await expect(statusFilter).toHaveAttribute('data-status', 'active');
    await statusFilter.click();
    await window
      .getByTestId('customize-installed-status-filter-option-any')
      .click();
    await expect(statusFilter).toHaveAttribute('data-status', 'any');
    const status = window.getByTestId(
      'plugins-entry-status-skill:custom:app:settings-active-skill',
    );
    await expect(status).toHaveAttribute('data-status', 'available');
    await status.click();
    await window
      .getByTestId(
        'plugins-entry-status-skill:custom:app:settings-active-skill-option-active',
      )
      .click();
    await expect(status).toHaveAttribute('data-status', 'active');
    await app.openSettings();
    await app.openSettingsSection('plugins');
    await expect(
      window.getByTestId('active-items-summary-counts'),
    ).toContainText('1 skill');

    for (const { testId, field } of DEFERRED_TOOLS_TOGGLES) {
      const toggle = window.getByTestId(testId);
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      await expect(toggle).not.toBeChecked();
      await expect
        .poll(() =>
          window.evaluate(
            (preferenceField) =>
              window.api
                .loadPreferences()
                .then((preferences) => preferences[preferenceField]),
            field,
          ),
        )
        .toBe(false);
    }

    // Cowork uses the same read-time global overlay as worktree chat. The
    // composer must display that effective set too, rather than looking empty
    // until the main process resolves plugins on send.
    await app.closeSettings();
    await app.openChatPage();
    const chatPage = window.getByTestId('page-chat');
    const emptyCoworkCta = chatPage.getByTestId('empty-new-chat');
    const plusButton = chatPage.getByTestId('chat-input-plus-button');
    await expect(plusButton.or(emptyCoworkCta).first()).toBeVisible();
    if (await emptyCoworkCta.isVisible().catch(() => false)) {
      await emptyCoworkCta.click();
    }
    await expect(plusButton).toBeVisible();
    await plusButton.click();
    const coworkPluginsButton = window.getByTestId('chat-plugins-button');
    await expect(coworkPluginsButton).toBeVisible({ timeout: 15_000 });
    await expect(coworkPluginsButton).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir, {
      keepUserData: true,
    });
  }

  const relaunch = await launchCanopy({ userDataDir: launch.userDataDir });
  try {
    const window = await relaunch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('plugins');

    await expect(
      window.getByTestId('active-items-summary-counts').getByText(/1 skill/),
    ).toBeVisible();

    for (const { testId } of DEFERRED_TOOLS_TOGGLES) {
      await expect(window.getByTestId(testId)).not.toBeChecked();
    }
  } finally {
    await closeCanopy(relaunch.electronApp, relaunch.userDataDir);
  }
});
