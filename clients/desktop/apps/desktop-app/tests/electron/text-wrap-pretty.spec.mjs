import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { buildMathTranscriptMessages } from '../performance/scenarios.mjs';

/**
 * Wrapped UI text avoids a lone last word (`text-wrap-style: pretty`), but the
 * chat window, transcript and composer, keeps plain line breaks.
 *
 * Determinism: a seeded transcript, no live agent, no network.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'chat-text-wrap';
const T = Date.parse('2026-10-23T12:00:00.000Z');
const ANSWER =
  'The jump comes from the panel grid measuring its rows before the new layout has loaded, so the second frame snaps to the new heights.';

const wrapStyle = (locator) =>
  locator.evaluate((el) => getComputedStyle(el).textWrapStyle);

test('chat keeps plain breaks and selectable content while app chrome does not select', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-text-wrap-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Text wrap',
        messages: [
          {
            id: 'user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Why does the sidebar jump?' }],
            timestamp: T,
          },
          {
            id: 'answer',
            role: 'assistant',
            blocks: [{ type: 'text', text: ANSWER }],
            timestamp: T + 1_000,
          },
          {
            id: 'timer',
            role: 'system',
            blocks: [
              { type: 'turn_timer', startedAt: T, completedAt: T + 2_000 },
            ],
            timestamp: T + 2_000,
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
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    const answer = panel.getByText(ANSWER);
    await expect(answer).toBeVisible();

    await expect(window.locator('body')).toHaveCSS('user-select', 'none');
    await answer.dblclick({ position: { x: 8, y: 8 } });
    expect(await window.evaluate(() => window.getSelection()?.toString())).toBe(
      'The',
    );
    await expect(panel.getByRole('button').first()).toHaveCSS(
      'user-select',
      'none',
    );

    expect(await wrapStyle(window.locator('html'))).toBe('pretty');
    const chatWindow = panel.locator('[data-chat-window]');
    await expect(chatWindow).toHaveCount(1);
    expect(await wrapStyle(chatWindow)).toBe('auto');
    expect(await wrapStyle(answer)).toBe('auto');
    const composer = chatWindow.locator('[contenteditable="true"]').first();
    await composer.fill('Copy this draft');
    await composer.press('ControlOrMeta+a');
    expect(await window.evaluate(() => window.getSelection()?.toString())).toBe(
      'Copy this draft',
    );
    expect(
      await wrapStyle(chatWindow.locator('[contenteditable="true"]').first()),
    ).toBe('auto');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Count Chromium's actual style work rather than setting a machine-dependent
// typing-time budget. Selection must not multiply whole-document style work.
test('typing beside math content keeps style work bounded', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-selection-style-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Math selection',
        messages: buildMathTranscriptMessages({
          tier: 'heavy',
          elementCount: 8,
        }),
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
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(
      panel.getByText('Math benchmark heavy element 8.', { exact: true }),
    ).toBeVisible();
    const composer = panel.locator('[contenteditable="true"]').first();
    await composer.fill('Ready ');
    await composer.press('End');
    await window.evaluate(() => document.fonts.ready);
    await window.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const elements = await window.locator('*').count();
    expect(elements).toBeGreaterThan(2_000);
    await electronApp.evaluate(async ({ contentTracing }) => {
      await contentTracing.startRecording({
        included_categories: ['devtools.timeline'],
      });
    });
    await composer.pressSequentially('Selection stays responsive', {
      delay: 20,
    });
    await expect(composer).toHaveText('Ready Selection stays responsive');
    await composer.press('ControlOrMeta+a');
    await composer.pressSequentially('Replacement draft', { delay: 20 });
    await expect(composer).toHaveText('Replacement draft');
    const tracePath = path.join(userDataDir, 'selection-typing-trace.json');
    await electronApp.evaluate(async ({ contentTracing }, output) => {
      await contentTracing.stopRecording(output);
    }, tracePath);
    await test.info().attach('selection-typing-style-work', {
      path: tracePath,
      contentType: 'application/json',
    });
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));

    const styleUpdates = trace.traceEvents.filter(
      (event) =>
        event.name === 'UpdateLayoutTree' &&
        Number.isFinite(event.args?.elementCount),
    );
    expect(styleUpdates.length).toBeGreaterThan(0);
    // The unchanged baseline can perform one idle full-document update,
    // including anonymous layout elements (~1.2x the DOM count). Allow that
    // bookkeeping; the descendant-highlight regression visited over 7x the
    // document in one update. This is a work bound, not a host-speed budget.
    expect(
      Math.max(...styleUpdates.map((event) => event.args.elementCount)),
    ).toBeLessThan(elements * 2);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
