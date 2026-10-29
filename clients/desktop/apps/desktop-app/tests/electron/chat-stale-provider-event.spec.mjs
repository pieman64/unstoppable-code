// Provider-event lifecycle convergence regressions.
//
// A completed background tab must not accept later assistant/tool output from
// that settled turn while the user is working in another tab. The fixture and
// provider events are local and deterministic: the spec navigates through the
// real worktree UI, commits a prompt + terminal through main-owned state, then
// injects the late provider payload through the same commit-before-broadcast
// E2E ingress used by provider-facing Electron coverage. Companion cases prove
// a valid continuation revives every activity surface and a real fake-app-
// server Codex terminal settles those same surfaces together.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closeFixture,
  createFixture,
  seedPreferences as seedCodexPreferences,
} from './codexPipelineRuntime.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SETTLED_CHAT_ID = 'settled-background-chat';
const ACTIVE_CHAT_ID = 'active-foreground-chat';
const SETTLED_TURN_ID = 'settled-turn-user-message';
const LATE_OUTPUT = 'This orphaned provider output must stay invisible';
const REVIVED_OUTPUT = 'Valid continuation output must remain visible';
const LIVE_CODEX_REPLY = 'Live Codex output completed normally';

function worktreeRow(window) {
  return window.locator(
    `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
  );
}

function panelTab(window, chatId) {
  return window.getByTestId(`panel-tab-panel-chat-${chatId}`);
}

async function sendMessage(panel, text) {
  const composer = panel.getByRole('textbox').first();
  await composer.click();
  await composer.fill(text);
  await panel.getByRole('button', { name: 'Send message' }).click();
}

test('a settled background tab rejects late provider output from its old turn', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-stale-provider-event-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: ACTIVE_CHAT_ID,
    tabs: [
      { id: SETTLED_CHAT_ID, title: 'Settled background chat' },
      { id: ACTIVE_CHAT_ID, title: 'Active foreground chat' },
    ],
  });

  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const activeTab = window.getByTestId(
      `panel-tab-panel-chat-${ACTIVE_CHAT_ID}`,
    );
    await expect(activeTab).toHaveAttribute('data-active', 'true', {
      timeout: 15_000,
    });

    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: SETTLED_CHAT_ID,
      turnUserMessageId: SETTLED_TURN_ID,
      data: {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: SETTLED_TURN_ID,
      },
    });
    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: SETTLED_CHAT_ID,
      turnUserMessageId: SETTLED_TURN_ID,
      data: {
        type: 'result',
        is_error: false,
        result: 'Settled normally',
        canopy_turn_user_message_id: SETTLED_TURN_ID,
      },
    });
    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: SETTLED_CHAT_ID,
      turnUserMessageId: SETTLED_TURN_ID,
      data: {
        type: 'assistant',
        canopy_turn_user_message_id: SETTLED_TURN_ID,
        message: {
          id: 'late-provider-message',
          role: 'assistant',
          content: [{ type: 'text', text: LATE_OUTPUT }],
        },
      },
    });

    await window.getByTestId(`panel-tab-panel-chat-${SETTLED_CHAT_ID}`).click();
    const settledPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${SETTLED_CHAT_ID}"]`,
    );
    await expect(settledPanel).toBeVisible();
    await expect(settledPanel.getByText(LATE_OUTPUT)).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('valid continuation revives every chat activity surface and settles consistently', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-revived-provider-event-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: SETTLED_CHAT_ID,
    tabs: [{ id: SETTLED_CHAT_ID, title: 'Revived continuation chat' }],
  });

  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${SETTLED_CHAT_ID}"]`,
    );
    const tab = panelTab(window, SETTLED_CHAT_ID);
    const row = worktreeRow(window);

    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: SETTLED_CHAT_ID,
      turnUserMessageId: SETTLED_TURN_ID,
      data: {
        type: 'canopy_user_prompt',
        original_text: 'Continue after an early terminal event.',
        canopy_turn_user_message_id: SETTLED_TURN_ID,
      },
    });
    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: SETTLED_CHAT_ID,
      turnUserMessageId: SETTLED_TURN_ID,
      data: {
        type: 'result',
        is_error: false,
        result: 'Provider emitted an early terminal event',
        canopy_turn_user_message_id: SETTLED_TURN_ID,
      },
    });

    await expect(panel.getByText(/Completed/).last()).toBeVisible();
    await expect(composerIdleAction(panel)).toBeVisible();
    await expect(tab.getByLabel('Thinking')).toHaveCount(0);

    // A retained provider callback can continue without a turn tag after its
    // early terminal event. This is valid only while the same turn still owns
    // the stream, and must revive canonical runtime before renderer delivery.
    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: SETTLED_CHAT_ID,
      turnUserMessageId: SETTLED_TURN_ID,
      data: {
        type: 'assistant',
        message: {
          id: 'revived-provider-message',
          role: 'assistant',
          content: [{ type: 'text', text: REVIVED_OUTPUT }],
        },
      },
    });

    await expect(panel.getByText(REVIVED_OUTPUT)).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Stop generation' }),
    ).toBeVisible();
    await expect(panel.getByText(/Working/).last()).toBeVisible();
    await expect(tab.getByLabel('Thinking')).toBeVisible();
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toBeVisible();

    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: SETTLED_CHAT_ID,
      turnUserMessageId: SETTLED_TURN_ID,
      data: {
        type: 'result',
        is_error: false,
        result: 'Continuation completed',
      },
    });

    await expect(panel.getByText(REVIVED_OUTPUT)).toBeVisible();
    await expect(panel.getByText(/Completed/).last()).toBeVisible();
    await expect(composerIdleAction(panel)).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Stop generation' }),
    ).toHaveCount(0);
    await expect(tab.getByLabel('Thinking')).toHaveCount(0);
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a routed Codex subagent error does not settle the root activity surfaces', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-subagent-error-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: SETTLED_CHAT_ID,
        title: 'Codex subagent error chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });

  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${SETTLED_CHAT_ID}"]`,
    );
    const tab = panelTab(window, SETTLED_CHAT_ID);
    const row = worktreeRow(window);
    const injectCodexEvent = (event) =>
      injectChatEvent(launched.electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: SETTLED_CHAT_ID,
        turnUserMessageId: SETTLED_TURN_ID,
        data: { type: 'codex', event },
      });

    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: SETTLED_CHAT_ID,
      turnUserMessageId: SETTLED_TURN_ID,
      data: {
        type: 'canopy_user_prompt',
        provider: 'codex',
        original_text: 'Delegate and finish after a child error.',
        canopy_turn_user_message_id: SETTLED_TURN_ID,
      },
    });
    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: SETTLED_CHAT_ID,
      turnUserMessageId: SETTLED_TURN_ID,
      data: {
        type: 'system',
        subtype: 'init',
        session_id: 'thread-root',
        canopy_turn_user_message_id: SETTLED_TURN_ID,
      },
    });
    await injectCodexEvent({
      type: 'error',
      thread_id: 'thread-child',
      turn_id: 'turn-child',
      message: 'Child failed',
    });

    await expect(
      panel.getByRole('button', { name: 'Stop generation' }),
    ).toBeVisible();
    await expect(panel.getByText(/Working/).last()).toBeVisible();
    await expect(tab.getByLabel('Thinking')).toBeVisible();
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toBeVisible();

    await injectCodexEvent({
      type: 'turn.completed',
      thread_id: 'thread-root',
      turn_id: 'turn-root',
    });
    await expect(panel.getByText(/Completed/).last()).toBeVisible();
    await expect(composerIdleAction(panel)).toBeVisible();
    await expect(tab.getByLabel('Thinking')).toHaveCount(0);
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a live Codex root terminal settles every chat activity surface', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-root-terminal-'),
  );
  const fixture = createFixture('normal', LIVE_CODEX_REPLY);
  seedCodexPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: SETTLED_CHAT_ID,
        title: 'Codex root terminal chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });

  const launched = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${SETTLED_CHAT_ID}"]`,
    );
    const tab = panelTab(window, SETTLED_CHAT_ID);
    const row = worktreeRow(window);

    // Codex emits its structured turn.completed event before the session's
    // compatibility result. The first terminal must settle both canonical
    // activity and the transcript timer; the second must remain harmless.
    await sendMessage(panel, 'Complete this live Codex turn.');
    await expect(
      panel.getByText(LIVE_CODEX_REPLY, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/Completed/).last()).toBeVisible();
    await expect(composerIdleAction(panel)).toBeVisible();
    await expect(tab.getByLabel('Thinking')).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: 'Stop generation' }),
    ).toHaveCount(0);
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toHaveCount(0);
  } finally {
    await closeFixture(launched.electronApp, userDataDir, fixture.runtimeDir);
  }
});
