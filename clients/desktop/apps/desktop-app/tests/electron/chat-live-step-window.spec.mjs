import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

/**
 * CAN-4274: show only the three most recent agent steps while a turn runs.
 *
 * The setting lives in Settings → Labs, is off by default and does not
 * need Early access. With it on, a running turn's newest run of steps shows
 * its last three steps under the run's summary row; the oldest drops off as a
 * new step arrives. The row opens to every step, live, and closes back to the
 * window. Agent text shows in full and compresses the steps before it; when
 * the turn finishes every run is one compressed row that still opens. Turning
 * the setting off brings back one row per step.
 *
 * Determinism: no live agent and no network. Every provider event goes
 * through the E2E chat-event ingress, which commits through main exactly as a
 * real provider session does.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'live-step-window-chat';
const TURN_ID = 'live-step-window-turn';
const TURN_STARTED_AT = Date.parse('2026-10-15T12:00:00.000Z');

function readCall(id, file) {
  return {
    type: 'tool_use',
    id,
    name: 'Read',
    input: { file_path: `/repo/src/${file}` },
  };
}

function assistant(id, content) {
  return { type: 'assistant', message: { id, role: 'assistant', content } };
}

function results(...ids) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: ids.map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: 'ok',
      })),
    },
  };
}

test('the live step window shows the newest three steps and follows its setting', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-live-step-window-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Live step window' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const saved = () =>
      window.evaluate(() =>
        window.api
          .loadPreferences()
          .then((prefs) => prefs.chatLiveStepWindowEnabled),
      );
    expect(await saved()).toBe(false);

    // Off by default; switching it on saves the preference.
    await app.openSettings();
    await app.openSettingsSection('experiments');
    const toggle = window.getByTestId('chat-live-step-window-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(saved).toBe(true);

    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
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
            blocks: [{ type: 'text', text: 'Why is the tooltip stale?' }],
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
    await expect(panel.getByText('Why is the tooltip stale?')).toBeVisible({
      timeout: 30_000,
    });

    const groups = panel.getByTestId('chat-tool-step-group');
    const live = panel.getByTestId('chat-tool-step-live');
    const liveCalls = live.getByTestId('chat-tool-call');
    const callRows = panel.getByTestId('chat-tool-call');

    // A thought and two reads in one message: three steps, all shown.
    await inject(
      assistant('step-think-1', [
        { type: 'thinking', thinking: 'The indicator reads a cached value.' },
      ]),
    );
    await inject(
      assistant('step-reads-1', [
        readCall('read-1', 'WakeLockIndicator.tsx'),
        readCall('read-2', 'wakeLockStore.ts'),
      ]),
    );
    await inject(results('read-1', 'read-2'));
    await expect(groups).toHaveCount(1);
    await expect(live.getByText('Thinking')).toBeVisible();
    await expect(liveCalls).toHaveCount(2);

    // Each new step drops the oldest one.
    await inject(assistant('step-read-3', [readCall('read-3', 'tooltip.ts')]));
    await expect(live.getByText('Thinking')).toHaveCount(0);
    await expect(liveCalls).toHaveCount(3);
    await inject(results('read-3'));
    await inject(assistant('step-read-4', [readCall('read-4', 'cache.ts')]));
    await expect(liveCalls).toHaveCount(3);
    await expect(live.getByText('WakeLockIndicator.tsx')).toHaveCount(0);
    await expect(live.getByText('cache.ts')).toBeVisible();

    // The row opens to every step and keeps following the turn.
    const row = groups.first().getByRole('button').first();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(live).toHaveCount(0);
    await expect(callRows).toHaveCount(4);
    await inject(results('read-4'));
    await inject(assistant('step-read-5', [readCall('read-5', 'timer.ts')]));
    await expect(callRows).toHaveCount(5);
    await row.click();
    await expect(liveCalls).toHaveCount(3);
    await expect(callRows).toHaveCount(3);
    await inject(results('read-5'));

    // Agent text shows in full and compresses the steps before it.
    const message = 'Let me check where the cache is filled.';
    await inject(assistant('step-text', [{ type: 'text', text: message }]));
    await expect(panel.getByText(message)).toBeVisible();
    await expect(live).toHaveCount(0);
    await expect(callRows).toHaveCount(0);
    await expect(
      groups.first().getByTestId('chat-tool-step-summary'),
    ).toHaveText('Thought, read 5 files');

    // A new window starts below the message.
    await inject(assistant('step-read-6', [readCall('read-6', 'boot.ts')]));
    await expect(groups).toHaveCount(2);
    await expect(liveCalls).toHaveCount(1);
    await inject(results('read-6'));

    // A provider may emit thinking and text in one source message. Search
    // must reach the later text piece, with occurrences relative to the source.
    const searchNeedle = 'split-search-needle';
    const searchText = `${searchNeedle} and ${searchNeedle}`;
    await inject(
      assistant('mixed-search', [
        { type: 'thinking', thinking: 'Checking the cache refresh path.' },
        { type: 'text', text: searchText },
      ]),
    );

    // Finishing the turn compresses every run; each still opens.
    await inject(
      assistant('step-answer', [
        { type: 'text', text: 'The tooltip is cached on start.' },
      ]),
    );
    await inject({
      type: 'result',
      is_error: false,
      result: 'The tooltip is cached on start.',
    });
    await expect(
      panel.getByText('The tooltip is cached on start.'),
    ).toBeVisible();
    const agentSteps = panel.getByRole('button', { name: /^Agent steps:/ });
    await expect(agentSteps).toBeVisible({ timeout: 30_000 });
    await agentSteps.click();
    await expect(groups).toHaveCount(2);
    await expect(live).toHaveCount(0);
    await expect(callRows).toHaveCount(0);
    await groups.nth(1).getByRole('button').first().click();
    await expect(callRows).toHaveCount(1);

    await panel.click();
    await window.keyboard.press('ControlOrMeta+f');
    const searchBar = window.getByTestId('surface-find-bar');
    await expect(searchBar).toBeVisible();
    await expect(searchBar).toHaveAttribute('data-find-mode', 'chat');
    await searchBar.getByRole('textbox').fill(searchNeedle);
    await expect(searchBar.getByText('1 of 2', { exact: true })).toBeVisible();
    const activeMatch = () =>
      window.evaluate(() =>
        Array.from(CSS.highlights.get('search-match-active') ?? []).map(
          (range) => {
            const owner = range.startContainer.parentElement?.closest(
              '[data-chat-message-id]',
            );
            if (!owner) return null;
            // Measure the actual highlighted boundary in its rendered piece,
            // independently of the search counter and matcher occurrence index.
            const prefix = range.cloneRange();
            prefix.selectNodeContents(owner);
            prefix.setEnd(range.startContainer, range.startOffset);
            return {
              sourceMessageId: owner.getAttribute('data-chat-message-id'),
              ownerText: owner.textContent,
              text: range.toString(),
              textOffset: prefix.toString().length,
            };
          },
        ),
      );
    const expectedMatch = {
      sourceMessageId: 'mixed-search',
      ownerText: searchText,
      text: searchNeedle,
      textOffset: 0,
    };
    await expect.poll(activeMatch).toEqual([expectedMatch]);
    await searchBar.getByRole('textbox').press('Enter');
    await expect(searchBar.getByText('2 of 2', { exact: true })).toBeVisible();
    await expect
      .poll(activeMatch)
      .toEqual([
        { ...expectedMatch, textOffset: searchNeedle.length + ' and '.length },
      ]);
    await searchBar.getByRole('textbox').press('Escape');
    await expect(searchBar).toBeHidden();

    // Turning the setting off, from anywhere, brings back one row per step.
    await window.evaluate(() =>
      window.api.savePreferences({ chatLiveStepWindowEnabled: false }),
    );
    await expect(groups).toHaveCount(0);
    await expect(callRows).toHaveCount(6);
    await expect(panel.getByText(message)).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
  }
});
