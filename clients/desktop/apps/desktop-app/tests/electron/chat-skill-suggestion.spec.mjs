import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { createFixture } from './codexPipelineRuntime.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  MATCHING_PROMPT,
  NON_MATCHING_PROMPT,
  readSeededSuggestion,
  SECOND_SUGGESTION_ID,
  seedChatSkillSuggestion,
  SUGGESTION_ID,
  SUGGESTION_WORKTREE,
} from './seeders/chatSkillSuggestion.mjs';

/** Sends one real mock turn in the selected worktree chat. */
async function sendTurn(window, text, reply) {
  const panel = window.getByTestId('panel-content-chat');
  const replies = panel.getByText(reply, { exact: true });
  const before = await replies.count();
  await panel.getByRole('textbox').first().fill(text);
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(replies).toHaveCount(before + 1, { timeout: 60_000 });
}

/** The drafted, unsent prompt in the newly opened chat's composer. */
async function expectDraftedChat(window) {
  const composer = window.getByRole('textbox').first();
  await expect(composer).toContainText(
    'Task: Summarize release review comments',
    { timeout: 30_000 },
  );
  await expect(composer).toContainText('skills.create_custom');
}

test('a matching turn shows the banner; Dismiss persists across restart', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can385-banner-'));
  seedChatSkillSuggestion(userDataDir);
  const fixture = createFixture('normal', 'Suggestion fixture completed');
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(SUGGESTION_WORKTREE);

    // A different request leaves the suggestion alone.
    await sendTurn(window, NON_MATCHING_PROMPT, 'Suggestion fixture completed');
    await expect(window.getByTestId('skill-suggestion-banner')).toHaveCount(0);
    expect(readSeededSuggestion(userDataDir).matchedTurnIds).toHaveLength(3);

    await sendTurn(window, MATCHING_PROMPT, 'Suggestion fixture completed');
    const banner = window.getByTestId('skill-suggestion-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("You've asked for this 4 times");
    await expect
      .poll(() => readSeededSuggestion(userDataDir).state)
      .toBe('shown');

    await banner.getByTestId('skill-suggestion-banner-dismiss').click();
    await expect(banner).toHaveCount(0);
    await expect
      .poll(() => readSeededSuggestion(userDataDir).state)
      .toBe('dismissed');

    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(SUGGESTION_WORKTREE);
    // Count replies only once the restored transcript has rendered.
    await expect(
      window
        .getByTestId('panel-content-chat')
        .getByText('Suggestion fixture completed', { exact: true }),
    ).toHaveCount(2, { timeout: 30_000 });
    await sendTurn(window, MATCHING_PROMPT, 'Suggestion fixture completed');
    await expect(window.getByTestId('skill-suggestion-banner')).toHaveCount(0);
    expect(readSeededSuggestion(userDataDir).state).toBe('dismissed');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixture.runtimeDir, { recursive: true, force: true });
  }
});

test('Create skill opens a chat with the drafting prompt unsent', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can385-create-'));
  seedChatSkillSuggestion(userDataDir);
  const fixture = createFixture('normal', 'Suggestion fixture completed');
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(SUGGESTION_WORKTREE);
    await sendTurn(window, MATCHING_PROMPT, 'Suggestion fixture completed');
    const banner = window.getByTestId('skill-suggestion-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await banner.getByTestId('skill-suggestion-banner-create').click();
    await expectDraftedChat(window);
    await expect
      .poll(() => readSeededSuggestion(userDataDir).state)
      .toBe('accepted');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixture.runtimeDir, { recursive: true, force: true });
  }
});

test('with the preference off a matching turn shows no banner', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can385-off-'));
  seedChatSkillSuggestion(userDataDir);
  const fixture = createFixture('normal', 'Suggestion fixture completed');
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('plugins');
    const toggle = window.getByTestId('skill-suggestions-settings-toggle');
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree(SUGGESTION_WORKTREE);
    await sendTurn(window, MATCHING_PROMPT, 'Suggestion fixture completed');
    await expect(window.getByTestId('skill-suggestion-banner')).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixture.runtimeDir, { recursive: true, force: true });
  }
});

test('Settings badge opens the modal; create and dismiss empty it', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can385-modal-'));
  seedChatSkillSuggestion(userDataDir, { second: true });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('plugins');
    const badge = window.getByTestId('skill-suggestions-settings-badge');
    await expect(badge).toHaveText('2');
    await window.getByTestId('skill-suggestions-settings-view').click();
    const modal = window.getByTestId('skill-suggestions-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('skill-suggestions-row')).toHaveCount(2);

    const second = modal.locator(
      `[data-testid="skill-suggestions-row"][data-suggestion-id="${SECOND_SUGGESTION_ID}"]`,
    );
    await second.getByTestId('skill-suggestions-row-dismiss').click();
    await expect(modal.getByTestId('skill-suggestions-row')).toHaveCount(1);
    await expect(badge).toHaveText('1');
    await expect
      .poll(() => readSeededSuggestion(userDataDir, SECOND_SUGGESTION_ID).state)
      .toBe('dismissed');

    await modal.getByTestId('skill-suggestions-row-create').click();
    await expect(modal).toHaveCount(0);
    await expectDraftedChat(window);
    await expect
      .poll(() => readSeededSuggestion(userDataDir, SUGGESTION_ID).state)
      .toBe('accepted');

    await app.openSettings();
    await app.openSettingsSection('plugins');
    await expect(
      window.getByTestId('skill-suggestions-settings-badge'),
    ).toHaveCount(0);
    await window.getByTestId('skill-suggestions-settings-view').click();
    await expect(window.getByTestId('skill-suggestions-empty')).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
  }
});
