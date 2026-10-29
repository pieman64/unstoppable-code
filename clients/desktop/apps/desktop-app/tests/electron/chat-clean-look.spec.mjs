import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';
import { assertVisibleReplyCopy } from './fixtures/chat-message-copy.mjs';

/**
 * Clean chat (Labs, off by default): the transcript reads like the Codex
 * app. With it on, a running turn opens with "Working for …", a failed
 * command says "Couldn't run …" without color or code chips, and a finished
 * turn folds its steps under "Worked for …", with the steps in words on hover,
 * and its reply row offers Copy and a "•••" menu with Good / Bad response.
 * Turning it off brings back the standard look without a restart.
 *
 * Determinism: no live agent and no network. Every provider event goes
 * through the E2E chat-event ingress, which commits through main exactly as a
 * real provider session does.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'clean-chat-look-chat';
const TURN_ID = 'clean-chat-look-turn';
const TURN_STARTED_AT = Date.parse('2026-10-21T12:00:00.000Z');

function assistant(id, content) {
  return { type: 'assistant', message: { id, role: 'assistant', content } };
}

function result(id, content, isError = false) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, is_error: isError },
      ],
    },
  };
}

test('Clean chat changes how steps read and follows its Labs switch', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-clean-chat-look-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Clean chat look' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const enabled = () =>
      window.evaluate(async () => {
        const snapshot = await window.api.experiments.getSnapshot();
        return snapshot.experiments.find((entry) => entry.id === 'clean-chat')
          ?.enabled;
      });
    expect(await enabled()).toBe(false);

    const setSwitch = async (on) => {
      await app.openSettings();
      await app.openSettingsSection('experiments');
      const toggle = window.getByTestId('labs-experiment-toggle-clean-chat');
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).toHaveAttribute('aria-checked', String(!on));
      await toggle.click();
      await expect.poll(enabled).toBe(on);
      await app.closeSettings();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
    };
    await setSwitch(true);

    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible();

    const inject = (data) =>
      injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        providerType: 'claude',
        turnUserMessageId: TURN_ID,
        data: { ...data, canopy_turn_user_message_id: TURN_ID },
      });

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 2,
        messages: [
          {
            id: TURN_ID,
            role: 'user',
            timestamp: TURN_STARTED_AT,
            blocks: [{ type: 'text', text: 'Add the robot glyph' }],
          },
          {
            id: `${TURN_ID}-timer`,
            role: 'system',
            timestamp: TURN_STARTED_AT + 1_000,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: TURN_STARTED_AT,
                completedAt: null,
              },
            ],
          },
        ],
      },
    });
    await expect(panel.getByText('Add the robot glyph')).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByTestId('turn-work-header')).toContainText(
      'Working for',
    );

    // A failed command says so in its verb, and carries no code chip.
    await inject(
      assistant('clean-bash', [
        {
          type: 'tool_use',
          id: 'bash-1',
          name: 'Bash',
          input: { command: 'pnpm test icons', description: 'Run the tests' },
        },
      ]),
    );
    await inject(result('bash-1', 'FAIL AppIcons.test.tsx', true));
    const failedRow = panel.locator('[data-tool-status="error"]').first();
    await expect(failedRow).toContainText('Couldn’t run pnpm test icons');
    await expect(failedRow.locator('.font-mono')).toHaveCount(0);
    await expect(failedRow.locator('.fg-destructive')).toHaveCount(0);

    // Opening it shows the command, not the raw JSON input.
    await failedRow.getByRole('button').first().click();
    const details = failedRow.locator('pre').first();
    await expect(details).toHaveText('pnpm test icons');
    await expect(failedRow.getByText('"command"')).toHaveCount(0);

    await inject(
      assistant('clean-reads', [
        {
          type: 'tool_use',
          id: 'read-1',
          name: 'Read',
          input: { file_path: '/repo/src/icons.ts' },
        },
        {
          type: 'tool_use',
          id: 'read-2',
          name: 'Read',
          input: { file_path: '/repo/src/manifest.json' },
        },
      ]),
    );
    await inject(result('read-1', 'ok'));
    await inject(result('read-2', 'ok'));

    // The finished turn folds its steps under "Worked for", with what they
    // did in words on hover.
    await inject(
      assistant('clean-answer', [{ type: 'text', text: 'Added the glyph.' }]),
    );
    await inject({ type: 'result', is_error: false, result: 'Added.' });
    await expect(panel.getByText('Added the glyph.')).toBeVisible();
    const header = panel.getByTestId('turn-work-header').getByRole('button');
    await expect(header).toContainText('Worked', { timeout: 30_000 });
    await expect(
      header.locator('[title="Ran 1 command, read 2 files"]'),
    ).toHaveCount(1);

    // The reply row: Copy, then "•••" with Good / Bad response, then the time.
    await expect(panel.getByTestId('turn-copy-message')).toBeVisible();
    await assertVisibleReplyCopy(
      window,
      panel.getByTestId('turn-copy-message'),
      {
        markdown: 'Added the glyph.',
        readClipboard: () =>
          electronApp.evaluate(({ clipboard }) => clipboard.readText()),
        writeClipboard: (text) =>
          electronApp.evaluate(
            ({ clipboard }, value) => clipboard.writeText(value),
            text,
          ),
      },
    );
    const more = panel.getByTestId('turn-more-actions');
    await expect(more).toBeVisible();
    await more.click();
    const menu = window.getByTestId('turn-more-actions-menu');
    await expect(
      menu.getByRole('menuitemcheckbox', { name: 'Good response' }),
    ).toBeVisible();
    await expect(
      menu.getByRole('menuitemcheckbox', { name: 'Bad response' }),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Off again: chips are back and the failure is only the red icon.
    await setSwitch(false);
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('turn-work-header')).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: /^Agent steps:/ }),
    ).toBeVisible();
    await expect(panel.getByTestId('tool-call-failed')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
