import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Global Instructions (Models settings page): two sub-sections (Chats,
// Pipelines), each with one overall textarea plus ordered scoped instructions
// narrowed by harness/model (chats also by workspace type) with append/replace
// modes and non-blocking replace-priority warnings. Pure settings UI +
// local-preference persistence, so it runs on the B0 baseline (no seeding, no
// live agent) and exercises the on-disk round-trip via a relaunch against the
// reused `userDataDir`.

test('global instructions: overall + scoped editing, replace warnings, reorder, persistence', async ({}, testInfo) => {
  let { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('instructions');
    await app.expectSettingsSection('instructions');

    const section = window.getByTestId('settings-global-instructions');
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
    // The page description states the new-session-only contract.
    await expect(window.getByTestId('settings-tab-instructions')).toContainText(
      'only added when a new agent session starts',
    );

    // Chats: overall instructions.
    const chatsOverall = window.getByTestId(
      'global-instructions-chats-overall',
    );
    await chatsOverall.fill('Always answer tersely.');
    await expect(chatsOverall).toHaveValue('Always answer tersely.');

    // Add a Claude-scoped Replace instruction.
    await window.getByTestId('global-instructions-chats-add').click();
    const firstItem = window.getByTestId('global-instructions-chats-item-0');
    await expect(firstItem).toBeVisible();
    await window
      .getByTestId('global-instructions-chats-item-0-text')
      .fill('Claude sessions use the replacement instructions.');
    await window
      .getByTestId('global-instructions-chats-item-0-harness-claude')
      .check();
    await window
      .getByTestId('global-instructions-chats-item-0-mode-replace')
      .click();

    // No warning with a single scoped instruction.
    await expect(
      window.getByTestId('global-instructions-chats-item-0-warning'),
    ).toHaveCount(0);

    // Add a second overlapping Replace (same harness). The later replace gets
    // the non-blocking priority warning; the earlier one stays clean.
    await window.getByTestId('global-instructions-chats-add').click();
    await window
      .getByTestId('global-instructions-chats-item-1-text')
      .fill('Second replace that loses for Claude sessions.');
    await window
      .getByTestId('global-instructions-chats-item-1-harness-claude')
      .check();
    await window
      .getByTestId('global-instructions-chats-item-1-mode-replace')
      .click();

    const laterWarning = window.getByTestId(
      'global-instructions-chats-item-1-warning',
    );
    await expect(laterWarning).toBeVisible();
    await expect(laterWarning).toContainText('Replace #1 takes priority');
    await expect(
      window.getByTestId('global-instructions-chats-item-0-warning'),
    ).toHaveCount(0);
    // Non-blocking: the losing instruction stays fully editable.
    await expect(
      window.getByTestId('global-instructions-chats-item-1-text'),
    ).toBeEnabled();

    // Reorder: moving the second item up swaps replace priority, so the
    // warning follows the now-later item.
    await window
      .getByTestId('global-instructions-chats-item-1-move-up')
      .click();
    await expect(
      window.getByTestId('global-instructions-chats-item-0-text'),
    ).toHaveValue('Second replace that loses for Claude sessions.');
    await expect(
      window.getByTestId('global-instructions-chats-item-1-warning'),
    ).toBeVisible();
    await expect(
      window.getByTestId('global-instructions-chats-item-1-text'),
    ).toHaveValue('Claude sessions use the replacement instructions.');

    // Chats items expose workspace-type narrowing (Cowork / Code / App
    // Advisor); check Cowork on the first item.
    await window
      .getByTestId('global-instructions-chats-item-0-workspace-cowork')
      .check();

    // Pipelines: overall + one scoped item without workspace-type options.
    const pipelinesOverall = window.getByTestId(
      'global-instructions-pipelines-overall',
    );
    await pipelinesOverall.scrollIntoViewIfNeeded();
    await pipelinesOverall.fill('Pipeline agents must keep output brief.');
    await window.getByTestId('global-instructions-pipelines-add').click();
    await expect(
      window.getByTestId('global-instructions-pipelines-item-0'),
    ).toBeVisible();
    await expect(
      window.getByTestId('global-instructions-pipelines-item-0-harness-codex'),
    ).toBeVisible();
    await expect(
      window.getByTestId(
        'global-instructions-pipelines-item-0-workspace-cowork',
      ),
    ).toHaveCount(0);
    await window
      .getByTestId('global-instructions-pipelines-item-0-text')
      .fill('Codex pipeline agents skip preamble.');
    await window
      .getByTestId('global-instructions-pipelines-item-0-harness-codex')
      .check();

    await window.screenshot({
      path: testInfo.outputPath('global-instructions-settings.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  // Relaunch against the same userDataDir: everything persisted.
  ({ electronApp } = await launchCanopy({ userDataDir }));
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('instructions');
    await app.expectSettingsSection('instructions');

    await expect(
      window.getByTestId('global-instructions-chats-overall'),
    ).toHaveValue('Always answer tersely.');
    await expect(
      window.getByTestId('global-instructions-chats-item-0-text'),
    ).toHaveValue('Second replace that loses for Claude sessions.');
    await expect(
      window.getByTestId('global-instructions-chats-item-0-workspace-cowork'),
    ).toBeChecked();
    await expect(
      window.getByTestId('global-instructions-chats-item-1-text'),
    ).toHaveValue('Claude sessions use the replacement instructions.');
    await expect(
      window.getByTestId('global-instructions-chats-item-1-warning'),
    ).toBeVisible();
    await expect(
      window.getByTestId('global-instructions-pipelines-overall'),
    ).toHaveValue('Pipeline agents must keep output brief.');
    await expect(
      window.getByTestId('global-instructions-pipelines-item-0-harness-codex'),
    ).toBeChecked();

    // Deleting a scoped instruction clears its priority warning.
    await window.getByTestId('global-instructions-chats-item-0-delete').click();
    await expect(
      window.getByTestId('global-instructions-chats-item-0-text'),
    ).toHaveValue('Claude sessions use the replacement instructions.');
    await expect(
      window.getByTestId('global-instructions-chats-item-0-warning'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
