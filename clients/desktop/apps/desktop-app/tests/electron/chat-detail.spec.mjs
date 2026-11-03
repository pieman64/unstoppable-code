import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 * Appearance → "Chat detail" (Detailed, Recent, Compact) replaced the two
 * Settings → Experiments switches "Show only recent steps" and "Group tool
 * calls", and Clean chat graduated from Labs, so the clean look is the only
 * chat look.
 *
 * One running turn with six reads and a message is drawn at each level:
 * - Detailed: every step is its own row;
 * - Recent (the default): the run's newest three steps show under a line
 *   that counts only the steps before them, so the running read is said once;
 * - Compact: the run is one closed line.
 * The setting saves to this computer's preferences and open chats follow it
 * at once. A preference file from before the setting moves the old switches
 * over once.
 *
 * Under Detailed, a step whose target outgrows the row keeps its tool name
 * whole while the target's badge ends in "…".
 *
 * Determinism: no live agent and no network. Every provider event goes
 * through the E2E chat-event ingress, which commits through main exactly as a
 * real provider session does.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'chat-detail-chat';
const TURN_ID = 'chat-detail-turn';
const TURN_STARTED_AT = Date.parse('2026-10-27T12:00:00.000Z');

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

function seedProfile(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Chat detail' }],
  });
}

function cleanup(userDataDir) {
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
}

test('Chat detail lives in Appearance and changes an open chat at once', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-detail-'),
  );
  seedProfile(userDataDir);

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

    // The old Experiments switches are gone.
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(
      window.getByTestId('settings-chat-live-step-window'),
    ).toHaveCount(0);
    await expect(window.getByText('Show only recent steps')).toHaveCount(0);
    await expect(window.getByText('Group tool calls')).toHaveCount(0);

    // Display → Appearance shows the level, Recent by default.
    await app.openSettingsSection('display');
    const row = window.getByTestId('settings-chat-detail-row');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Chat detail');
    await expect(window.getByTestId('chat-detail-recent')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await window.getByTestId('chat-detail-detailed').click();
    await expect(window.getByTestId('chat-detail-detailed')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(row).toContainText(
      'Every step the agent takes gets its own row.',
    );
    await expect.poll(saved).toBe('detailed');

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
            blocks: [{ type: 'text', text: 'Fix the flaky toolbar test.' }],
          },
        ],
      },
    });
    await publishTurnLifecycle(electronApp, {
      ...turn,
      phase: 'start',
      atMs: TURN_STARTED_AT,
    });
    await expect(panel.getByText('Fix the flaky toolbar test.')).toBeVisible({
      timeout: 30_000,
    });

    // Two reads, a message, then four reads with the last still running.
    await inject(
      assistant('reads-1', [
        readCall('read-1', 'toolbar.test.ts'),
        readCall('read-2', 'toolbar.ts'),
      ]),
    );
    await inject(results('read-1', 'read-2'));
    const note = 'The test clicks before the idle timer settles.';
    await inject(assistant('note', [{ type: 'text', text: note }]));
    for (const [index, file] of [
      [3, 'idle.ts'],
      [4, 'clock.ts'],
      [5, 'events.ts'],
    ]) {
      await inject(
        assistant(`read-${index}`, [readCall(`read-${index}`, file)]),
      );
      await inject(results(`read-${index}`));
    }
    await inject(assistant('read-6', [readCall('read-6', 'lint.ts')]));
    await expect(panel.getByText(note)).toBeVisible();

    const groups = panel.getByTestId('chat-tool-step-group');
    const live = panel.getByTestId('chat-tool-step-live');
    const callRows = panel.getByTestId('chat-tool-call');

    // Detailed: every step is its own row, its file in a code badge.
    await expect(callRows).toHaveCount(6);
    await expect(groups).toHaveCount(0);
    const badges = panel.locator('[data-step-badge]');
    await expect(badges.filter({ hasText: 'lint.ts' })).toHaveCount(1);

    // Recent, chosen from anywhere: the newest three steps show under a line
    // that counts only the one before them.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'recent' }),
    );
    await expect(live.getByTestId('chat-tool-call')).toHaveCount(3);
    await expect(groups).toHaveCount(2);
    // Badges are Detailed only; Recent's rows keep plain words.
    await expect(badges).toHaveCount(0);
    const liveLine = groups.nth(1);
    await expect(liveLine).not.toHaveAttribute('data-live', /.*/);
    await expect(liveLine.getByTestId('chat-tool-step-summary')).toHaveText(
      'Read 1 file',
    );
    await expect(panel.getByText('lint.ts')).toHaveCount(1);
    await expect(
      groups.first().getByTestId('chat-tool-step-summary'),
    ).toHaveText('Read 2 files');

    // Compact: every run is one closed line.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'compact' }),
    );
    await expect(live).toHaveCount(0);
    await expect(callRows).toHaveCount(0);
    await expect(groups).toHaveCount(2);
    await expect(panel.getByText(note)).toBeVisible();

    // Settings follows a level saved elsewhere.
    await app.openSettings();
    await app.openSettingsSection('display');
    await expect(window.getByTestId('chat-detail-compact')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanup(userDataDir);
  }
});

// A long target, wider than any chat column: the MCP tool list Tool search
// asked for in CAN-5464.
const LONG_TOOL_QUERY = `select:${Array.from(
  { length: 6 },
  (_, index) => `mcp__appproxy-internal-hub-production__tool_${String(index)}`,
).join(',')}`;

test('Detailed keeps the tool name whole while a long target ends in …', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-detail-badge-'),
  );
  seedProfile(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
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
            blocks: [{ type: 'text', text: 'Find the hub tools.' }],
          },
        ],
      },
    });
    await publishTurnLifecycle(electronApp, {
      ...turn,
      phase: 'start',
      atMs: TURN_STARTED_AT,
    });
    await expect(panel.getByText('Find the hub tools.')).toBeVisible({
      timeout: 30_000,
    });
    await inject(
      assistant('search', [
        {
          type: 'tool_use',
          id: 'search-1',
          name: 'ToolSearch',
          input: { query: LONG_TOOL_QUERY },
        },
      ]),
    );
    await inject(results('search-1'));

    const row = panel.getByTestId('chat-tool-call');
    await expect(row).toHaveCount(1);
    const badge = row.locator('[data-step-badge]');
    await expect(badge).toHaveText(LONG_TOOL_QUERY);
    const words = row.locator('[data-step-row-words] span.truncate', {
      hasText: 'Tool search',
    });
    await expect(words).toHaveCount(1);
    // Whether a box's text is cut: its text is wider than its box.
    const cut = (locator) =>
      locator.evaluate((element) => element.scrollWidth > element.clientWidth);
    // The target outgrows the row and ends in "…"; the tool name stays whole.
    await expect.poll(() => cut(badge.locator('span'))).toBe(true);
    expect(await cut(words)).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanup(userDataDir);
  }
});

for (const [legacy, level] of [
  [{ chatLiveStepWindowEnabled: true }, 'recent'],
  [{ chatGroupToolCallsEnabled: true }, 'compact'],
  [
    { chatLiveStepWindowEnabled: false, chatGroupToolCallsEnabled: false },
    'recent',
  ],
]) {
  test(`moves the retired switches over once (${JSON.stringify(legacy)} → ${level})`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-detail-migration-'),
    );
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({ version: 1, preferences: legacy }, null, 2),
      'utf8',
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('display');
      await expect(window.getByTestId(`chat-detail-${level}`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      cleanup(userDataDir);
    }
  });
}
