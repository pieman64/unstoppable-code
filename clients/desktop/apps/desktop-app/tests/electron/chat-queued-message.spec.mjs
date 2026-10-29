import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Doc 2 — Spec 2: `chat-queued-message.spec.mjs`.
//
// Targets PR 698: the queued-message bubble (`QueuedMessageBubble.tsx`) and its
// "Interrupt" action (`data-testid="queued-message-interrupt"`). A queued
// bubble renders while a Canopy-native turn is streaming and the user has
// queued a follow-up message; the Interrupt button (shown when `canForce &&
// onForce`) flushes the queued message immediately.
//
// TWO-PHASE SEEDING: a real git worktree (`demo-ts-pnpm-vite` / `demo-main`,
// plain `ts-pnpm-vite` fixture) plus a seeded Claude chat file with transcript
// blocks so the chat panel mounts with content.
//
// LIMITATION (the queued bubble is NOT reachable from a seeded chat file):
//   - A chat tab's `queuedMessages` array is runtime-only Zustand store state.
//     `PersistedChatTab` (packages/desktop-shared/src/types.ts) has no
//     `queuedMessages` field, and `fromPersistedTab` (chatStore.ts) hardcodes
//     `queuedMessages: []` on hydration. Nothing in the persisted chat file can
//     populate it.
//   - The bubble only renders while a message is queued, which only happens
//     while a turn is streaming (`status: 'streaming'`). `status` is likewise
//     runtime-only and hardcoded to `'idle'` on hydration.
//   - The component also has no window-exposed store seam to inject either
//     value at runtime, and we must not modify app source.
// Producing the queued bubble therefore requires a live Claude turn plus a
// queued send, which the harness cannot drive. The Interrupt-button assertion
// itself stays at unit level (the `QueuedMessageBubble` RTL tests). Here we
// assert the reachable surface: the streaming-intent Claude chat mounts its
// panel/tab bar with the seeded transcript, and — with no live turn and no
// queued message — the `queued-message-interrupt` control is correctly absent.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const SEEDED_TEXT = 'Seeded assistant reply for the queued-message spec.';

test.describe('chat queued message bubble (698)', () => {
  test('streaming-intent Claude chat mounts; queued bubble is not reachable from seeded state', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-queued-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    // Seed a Claude-backed tab. `status: 'streaming'` is requested here to
    // document the intent, but note it only sets `staleSessionDetected` via the
    // seeder and does NOT survive into the live store status (see file header).
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: 'queued-tab-1',
          title: 'Queued Message Chat',
          blocks: [{ type: 'text', text: SEEDED_TEXT }],
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await app.selectWorktree(WORKTREE_BRANCH);

      // The chat panel + tab bar mount, and the seeded transcript renders.
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await expect(window.getByTestId('worktree-top-bar')).toBeVisible();
      await expect(window.getByText(SEEDED_TEXT)).toBeVisible();

      // No live turn and no queued message can be produced from seeded state, so
      // the queued bubble — and its Interrupt control — are correctly absent.
      // (When the bubble does render in a live session, this is the durable hook
      // the unit tests assert against.)
      await expect(window.getByTestId('queued-message-interrupt')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // The main-chat composer follows the Home / New Task hierarchy: the raised
  // `+` owns attachment, Linear, plugins, commands, plan mode, and scheduling;
  // model/effort, voice, and send remain persistent. This cheap seeded-chat
  // host pins that real user flow without a provider turn.
  test('ChatInput consolidates secondary composer actions in the raised plus menu', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-input-plus-menu-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: 'plus-menu-tab-1',
          title: 'Plus Menu Chat',
          blocks: [{ type: 'text', text: SEEDED_TEXT }],
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const plusButton = window.getByTestId('chat-input-plus-button');
      await expect(plusButton).toBeVisible();
      await expect(plusButton).toHaveAttribute('aria-label', 'More actions');
      await expect(plusButton).toHaveClass(/h-8/);
      await expect(plusButton).toHaveClass(/rounded-full/);

      // Secondary actions live in +. Plan appears inline only while enabled.
      await expect(window.getByTestId('chat-plugins-button')).toHaveCount(0);
      await expect(
        window.getByTestId('chat-input-schedule-button'),
      ).toHaveCount(0);
      const inlinePlan = window.getByTestId(
        'chat-input-plan-mode-inline-button',
      );
      await expect(inlinePlan).toHaveCount(0);

      await plusButton.click();

      const plusMenu = window.getByTestId('chat-input-plus-menu');
      await expect(plusMenu).toBeVisible();
      await expect(
        plusMenu.getByTestId('chat-input-plus-attachment'),
      ).toBeVisible();

      // CAN-2709: connecting Linear lives in Account settings, so the menu
      // offers the ticket picker only once a connection exists. This fixture
      // has none.
      await expect(plusMenu.getByTestId('chat-input-plus-linear')).toHaveCount(
        0,
      );

      await expect(plusMenu.getByTestId('chat-plugins-button')).toBeVisible();
      // Skills and commands are opened directly with `/`; the Add menu keeps
      // whole-plugin, attachment, and composer-mode actions.
      await expect(
        plusMenu.getByTestId('chat-input-commands-button'),
      ).toHaveCount(0);
      const menuPlan = plusMenu.getByTestId('chat-input-plan-mode-button');
      await expect(menuPlan).toContainText('Plan mode');
      await expect(menuPlan).toHaveAttribute('aria-pressed', 'false');
      await expect(
        plusMenu.getByTestId('chat-input-schedule-button'),
      ).toContainText('Schedule message');

      // Enable Plan through +; its removable chip is the way back out.
      await menuPlan.click();
      await expect(plusMenu).toHaveCount(0);
      await expect(inlinePlan).toHaveAttribute('aria-pressed', 'true');
      await expect(inlinePlan).toContainText('Plan');
      await inlinePlan.click();
      await expect(inlinePlan).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
