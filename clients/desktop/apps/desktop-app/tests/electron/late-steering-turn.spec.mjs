// A steer admitted while a turn was running, but picked up only after that
// turn settled, starts a brand new provider turn. The transcript must read as
// one: its own turn group, no "Steering" title, and the "Working…" timer
// trailing the answer instead of wedged between the prompt and its reply.
//
// Determinism: Claude holds an admitted async message until the query's next
// input boundary. With a single streamed text response and no tool calls,
// that boundary is the end of the root turn, so the pickup is reliably late.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 't1';
const MARKER = 'Canopy-CLATESTEER';
const SCORPION_SESSION_ID = `${WORKSPACE_ID}/${WORKTREE_ID}/${CHAT_ID}`;
const SCORPION_FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-claude-scorpion-cli.mjs', import.meta.url),
);

function readScorpionLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function send(window, text) {
  const composer = window.getByRole('textbox').last();
  await composer.fill(text);
  // Enter is the queue affordance: while a turn streams, the trailing
  // composer button is Stop, so there is no Send button to click.
  await expect
    .poll(
      async () => {
        const draft = await composer.evaluate((element) => {
          const content = element.cloneNode(true);
          content
            .querySelectorAll('[data-slate-placeholder]')
            .forEach((placeholder) => placeholder.remove());
          return (content.textContent ?? '').replaceAll('﻿', '').trim();
        });
        if (draft !== '') await composer.press('Enter');
        return draft;
      },
      { timeout: 15_000 },
    )
    .toBe('');
}

test('a steering pickup after the turn ended renders as its own turn', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-late-steer-'));
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Chat', model: 'claude-haiku-4-5-20251001' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: {
      steps: [{ text: 'Unexpected untagged request', stopReason: 'end_turn' }],
      stepsByRequestTag: {
        root: {
          text: 'Root turn still streaming. '.repeat(20),
          streamMs: 8_000,
          chunkChars: 8,
          stopReason: 'end_turn',
        },
        late: { text: 'Late steering reply', stopReason: 'end_turn' },
      },
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    await expect(window.getByTestId('chat-model-picker')).toHaveAttribute(
      'aria-label',
      /^Select model, current model (?!Workspace default$).+/,
      { timeout: 30_000 },
    );

    await send(
      window,
      `[${MARKER}] [Canopy-Mock-Request:root] Begin the root turn`,
    );
    await expect(panel.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });
    await send(
      window,
      `[${MARKER}] [Canopy-Mock-Request:late] Steer me after the turn`,
    );
    const bubbles = panel.getByTestId('queued-message-bubble');
    await expect(bubbles).toHaveCount(1, { timeout: 15_000 });
    await bubbles
      .first()
      .getByRole('button', { name: 'Steer', exact: true })
      .click();
    await expect(panel.getByTestId('input-delivery-row')).toContainText(
      'Sending…',
    );

    const tabState = () =>
      window.evaluate(
        async ({ projectId, worktreeId, chatId }) => {
          const state = await window.api.chat.getState({
            projectId,
            worktreeId,
          });
          return state.tabsFile.tabs.find((tab) => tab.id === chatId);
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
      );

    // The root turn ends on its own; the SDK then starts the held steer as a
    // fresh turn, which is what makes the pickup a turn root.
    await expect
      .poll(
        async () => {
          const tab = await tabState();
          const rowId = tab?.inputDelivery?.rows[0]?.id;
          const message = tab?.messages.find((entry) => entry.id === rowId);
          return message?.blocks.find((block) => block.type === 'text')
            ?.steering?.startsTurn;
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    const tab = await tabState();
    const rowId = tab.inputDelivery.rows[0].id;
    // Every other turn-timer producer writes `system`, and both display
    // predicates require that role before they recognize a timer at all.
    expect(
      tab.messages.find((entry) => entry.id === `${rowId}:timer`),
    ).toMatchObject({ role: 'system' });

    await expect(
      panel.getByText('Late steering reply', { exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    // The pickup is an ordinary prompt, not an aside on a running turn.
    await expect(panel.getByTestId('steering-title')).toHaveCount(0);

    // The turn's timer trails its answer rather than sitting above it.
    await expect
      .poll(async () =>
        panel.evaluate((root) => {
          const reply = Array.from(root.querySelectorAll('p')).find(
            (node) => node.textContent?.trim() === 'Late steering reply',
          );
          const timers = Array.from(
            root.querySelectorAll('[data-testid="turn-timer"]'),
          );
          if (!reply || timers.length === 0) return null;
          // The nearest timer at or after the reply must follow it in document
          // order — a timer before it is the wedged "Working…" row.
          return timers.some(
            (timer) =>
              reply.compareDocumentPosition(timer) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
      )
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('a persisted legacy pickup timer reopens inside its turn', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-legacy-late-steer-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Legacy late steer',
        messages: [
          {
            id: 'root',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Start the root turn' }],
          },
          {
            id: 'root-answer',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'Root answer' }],
          },
          {
            id: 'root:timer',
            role: 'system',
            timestamp: 1,
            blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
          },
          {
            id: 'steer',
            role: 'user',
            timestamp: 3,
            blocks: [
              {
                type: 'text',
                text: 'Late steer from an older build',
                steering: { startsTurn: true },
              },
            ],
          },
          {
            id: 'steer:timer',
            role: 'assistant',
            timestamp: 3,
            blocks: [{ type: 'turn_timer', startedAt: 3, completedAt: 5 }],
          },
          {
            id: 'steer-answer',
            role: 'assistant',
            timestamp: 4,
            blocks: [{ type: 'text', text: 'Persisted late steering reply' }],
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    await expect(
      panel.getByText('Persisted late steering reply', { exact: true }),
    ).toBeVisible();

    await expect
      .poll(async () =>
        panel.evaluate((root) => {
          const reply = Array.from(root.querySelectorAll('p')).find(
            (node) =>
              node.textContent?.trim() === 'Persisted late steering reply',
          );
          const timers = Array.from(
            root.querySelectorAll('[data-testid="turn-timer"]'),
          );
          if (!reply || timers.length < 2) return null;
          return timers.some(
            (timer) =>
              reply.compareDocumentPosition(timer) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
      )
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('scorpion: Steer delivers a queued message into the parent turn while two subagents run', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-scorpion-steer-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-scorpion-cli.mjs');
  const logPath = path.join(userDataDir, 'fake-claude-scorpion.log');
  copyFileSync(SCORPION_FIXTURE, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Scorpion chat', providerType: 'claude' }],
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CLAUDE_CODE_EXECUTABLE: fakeCliPath,
        CANOPY_CLAUDE_SCORPION_LOG: logPath,
        // The parent turn stays running until the steered message arrives.
        CANOPY_CLAUDE_SCORPION_HOLD_ROOT: '1',
      },
    }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();

    await send(window, 'scorpion root request');
    await expect(
      panel.getByText('scorpion root reply', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        () => {
          const entries = readScorpionLog(logPath);
          return (
            entries.some((entry) => entry.type === 'subagents_started') &&
            entries.some((entry) => entry.type === 'root_held')
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // Foreground: the parent turn is still running with its subagents.
    const steer = 'scorpion steer request';
    await send(window, steer);
    const bubble = panel.getByTestId('queued-message-bubble');
    await expect(bubble).toHaveCount(1, { timeout: 15_000 });
    await bubble.getByTestId('queued-message-more').click();
    await expect(
      window
        .getByTestId('queued-message-more-menu')
        .getByTestId('queued-message-interrupt'),
    ).toBeVisible({
      timeout: 15_000,
    });
    await window.keyboard.press('Escape');
    const steerButton = bubble.getByTestId('queued-message-steer');
    await expect(steerButton).toBeVisible({ timeout: 15_000 });
    await steerButton.click();

    // The fake provider receives the message inside the running parent turn.
    await expect
      .poll(
        () =>
          readScorpionLog(logPath).filter(
            (entry) =>
              entry.type === 'user' &&
              entry.sessionId === SCORPION_SESSION_ID &&
              entry.text.includes(steer),
          ),
        { timeout: 30_000 },
      )
      .toEqual([expect.objectContaining({ rootTurnRunning: true })]);
    await expect(
      panel.getByText(`scorpion steer reply: ${steer}`, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    expect(
      readScorpionLog(logPath).filter(
        (entry) =>
          entry.type === 'control_request' && entry.subtype === 'interrupt',
      ),
    ).toHaveLength(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
