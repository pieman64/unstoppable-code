import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  injectChatEvent,
  publishTurnLifecycle,
  seedWorktreeChat,
  turnEventInjector,
} from './seeders/index.mjs';

/**
 * CAN-4274: show only the three most recent agent steps while a turn runs.
 *
 * Chat detail "Recent" (Settings → Display → Appearance) is the default. A
 * running turn's newest run of steps shows its last three steps; with more
 * than three, a closed line above them counts only the earlier steps, so the
 * running step is not said twice. The oldest step drops behind the line as a
 * new one arrives. The line opens to every step, live, and closes back to the
 * window. Agent text shows in full and folds the steps before it into one
 * line; when the turn finishes every run is one line that still opens.
 * Choosing "Detailed" brings back one row per step.
 *
 * Determinism: no live agent and no network. Every provider event goes
 * through the E2E chat-event ingress, which commits through main exactly as a
 * real provider session does. The turn's start and root-result end are
 * published as a Claude session's lifecycle receipts, which alone start and
 * end a canonical root turn (turn-state phase 35c5d).
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

test('Recent chat detail groups multiple hidden calls and follows its setting', async () => {
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
        window.api.loadPreferences().then((prefs) => prefs.chatDetail),
      );
    expect(await saved()).toBe('recent');

    // Recent is the default, and Settings shows it chosen.
    await app.openSettings();
    await app.openSettingsSection('display');
    const detailRow = window.getByTestId('settings-chat-detail-row');
    await detailRow.scrollIntoViewIfNeeded();
    await expect(detailRow.getByTestId('chat-detail-recent')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible();

    const turn = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      turnUserMessageId: TURN_ID,
    };
    const inject = turnEventInjector(electronApp, turn);

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 1,
        messages: [
          {
            id: TURN_ID,
            role: 'user',
            timestamp: TURN_STARTED_AT,
            blocks: [{ type: 'text', text: 'Why is the tooltip stale?' }],
          },
        ],
      },
    });
    await publishTurnLifecycle(electronApp, {
      ...turn,
      phase: 'start',
      atMs: TURN_STARTED_AT,
    });
    await expect(panel.getByText('Why is the tooltip stale?')).toBeVisible({
      timeout: 30_000,
    });

    // Count expandable transcript groups, excluding the standalone activity row.
    const groups = panel.locator(
      '[data-testid="chat-tool-step-group"]:has([aria-expanded]):not([data-testid="turn-timer"] *)',
    );
    const live = panel.getByTestId('chat-tool-step-live');
    const liveCalls = live.getByTestId('chat-tool-call');
    const callRows = panel.getByTestId('chat-tool-call');
    const summary = groups.first().getByTestId('chat-tool-step-summary');

    // A thought and two reads in one message: three steps, all shown, with
    // no line above them.
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
    await expect(live).toHaveCount(1);
    // The thought is done once the reads start, so its row says so.
    await expect(live.getByText('Thought')).toBeVisible();
    await expect(liveCalls).toHaveCount(2);
    await expect(groups).toHaveCount(0);

    // A group represents at least two hidden calls. A thought or one older
    // call remains visible until there is enough work to summarize.
    await inject(assistant('step-read-3', [readCall('read-3', 'tooltip.ts')]));
    await expect(groups).toHaveCount(0);
    await expect(liveCalls).toHaveCount(3);
    await inject(results('read-3'));
    await inject(assistant('step-read-4', [readCall('read-4', 'cache.ts')]));
    await expect(groups).toHaveCount(0);
    await expect(liveCalls).toHaveCount(4);
    await inject(results('read-4'));
    await inject(assistant('step-read-5', [readCall('read-5', 'timer.ts')]));
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).not.toHaveAttribute('data-live', '');
    await expect(summary).toHaveText('Read 2 files');
    await expect(liveCalls).toHaveCount(3);
    await expect(live.getByText('WakeLockIndicator.tsx')).toHaveCount(0);
    await expect(live.getByText('timer.ts')).toBeVisible();

    // Expanding reveals the older calls while the recent rows stay mounted.
    const row = groups.first().getByRole('button').first();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(liveCalls).toHaveCount(3);
    await expect(callRows).toHaveCount(5);
    await inject(results('read-5'));
    await inject(assistant('step-read-6', [readCall('read-6', 'settings.ts')]));
    await expect(callRows).toHaveCount(6);
    await row.click();
    await expect(liveCalls).toHaveCount(3);
    await expect(callRows).toHaveCount(3);
    await inject(results('read-6'));

    // Agent text shows in full and folds the steps before it into one line.
    const message = 'Let me check where the cache is filled.';
    await inject(assistant('step-text', [{ type: 'text', text: message }]));
    await expect(panel.getByText(message)).toBeVisible();
    await expect(live).toHaveCount(0);
    await expect(callRows).toHaveCount(0);
    await expect(summary).toHaveText('Read 6 files');

    // A new window starts below the message, with no line of its own yet.
    await inject(assistant('step-read-7', [readCall('read-7', 'boot.ts')]));
    await expect(liveCalls).toHaveCount(1);
    await expect(groups).toHaveCount(1);
    await inject(results('read-7'));

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

    // Finishing folds the whole turn; reopening preserves a standalone call.
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
    const agentSteps = panel
      .getByTestId('turn-work-header')
      .getByRole('button', { name: /^Agent steps/ });
    await expect(agentSteps).toBeVisible({ timeout: 30_000 });
    // Completion folds even a watched turn; reopen it to inspect its steps.
    if ((await agentSteps.getAttribute('aria-expanded')) === 'false') {
      await agentSteps.click();
    }
    await expect(groups).toHaveCount(1);
    await expect(live).toHaveCount(1);
    await expect(callRows).toHaveCount(1);
    await expect(callRows.getByText('boot.ts')).toBeVisible();

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

    // Choosing Detailed, from anywhere, brings back one row per step.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await expect(groups).toHaveCount(0);
    await expect(callRows).toHaveCount(7);
    await expect(panel.getByText(message)).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
  }
});
