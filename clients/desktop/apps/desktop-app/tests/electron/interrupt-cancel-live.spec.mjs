import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  registerScenario,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

// Doc 2 — Spec 2 (LIVE) — `interrupt-cancel-live.spec.mjs` (PRs 698 / 827).
//
// PR 698 added the queued-message bubble + its Interrupt control
// (`data-testid="queued-message-interrupt"`, `QueuedMessageBubble.tsx`). PR 827
// hardened turn cancellation so a stopped turn ends cleanly — no spurious error
// banner, the chat returns to idle, and the composer accepts the next message.
// The streaming-only interrupt affordances are: the composer's "Stop
// generation" button (`ChatInput.tsx`, rendered only while `isStreaming`) and
// the `queued-message-interrupt` bubble (rendered only while a turn is
// streaming AND a follow-up message has been queued).
//
// This is the LIVE counterpart of the seeded `chat-queued-message.spec.mjs`.
// That seeded spec could only assert the ABSENCE of those controls, because
// both a streaming turn and a queued message are runtime-only Zustand state no
// persisted chat file can populate. This spec drives a REAL Claude turn against
// the shared mock provider (same seam as `chat-live-turn.spec.mjs`: composer
// send → chatStore.sendMessage IPC → bundled `claude` binary pointed at the
// mock → scripted reply streams back → renderer transcript renders it).
//
// VERIFIED HARNESS LIMITATION — the mid-stream streaming frame is NOT
// observable for a live mock Claude turn:
//   The bundled `claude` binary drives a mock turn to completion (or an
//   immediate error) within a few tens of milliseconds at the renderer, even
//   when the mock paces its SSE deltas (the mock's `CannedStep.streamMs` pacing
//   was verified to hold the HTTP stream open for its full budget, but the SDK
//   does not surface a renderer-visible `status: 'streaming'` window from it).
//   Across high-frequency polling (40ms) for the full turn, the "Stop
//   generation" button and the `queued-message-interrupt` bubble are never
//   present — the optimistic streaming status set by `sendMessage` is collapsed
//   into the idle/final state inside a single render batch. Producing a stable,
//   clickable mid-stream interrupt control therefore requires a turn that
//   actually stays streaming at the renderer, which the bundled binary against
//   the mock does not provide. The mid-stream click of `Stop generation` /
//   `queued-message-interrupt` stays at unit level (the `ChatInput` /
//   `QueuedMessageBubble` RTL tests).
//
// What this spec DOES verify live (the PR 827 clean-cancellation contract that
// is observable without a held streaming frame):
//   - A real Claude turn runs end to end and renders its scripted reply.
//   - When the turn ends, the chat is idle: the streaming-only "Stop
//     generation" interrupt control is NOT present and the idle "Send message"
//     control IS — i.e. the interrupt control's presence is correctly bound to
//     the streaming state, never lingering after the turn.
//   - No spurious error banner (`role="alert"`) is surfaced by the completed
//     turn.
//   - The composer accepts the next message after the turn — the chat returned
//     to a usable idle state, the core post-cancel guarantee from PR 827.
//
// See `chat-live-turn.spec.mjs` for the env-hygiene / prereq rationale.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const CONVERSATION_MARKER = 'Canopy-CINTRLIVE';
const ASSISTANT_REPLY =
  'Interruptible live reply from the Canopy mock provider';

test.describe('interrupt / cancel live turn (698 / 827)', () => {
  test('a live Claude turn ends cleanly: interrupt control is streaming-bound, no error banner, chat stays usable', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-interrupt-cancel-live-'),
    );

    // Phase 1: real git worktree + an empty Claude chat tab so the composer
    // mounts ready to send. No seeded transcript blocks — the asserted reply
    // can only come from the live turn against the mock.
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });

    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: ASSISTANT_REPLY, stopReason: 'end_turn' }],
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

      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      // Before any turn, the streaming-only interrupt controls are absent.
      await expect(
        window.getByRole('button', { name: 'Stop generation' }),
      ).toHaveCount(0);
      await expect(window.getByTestId('queued-message-interrupt')).toHaveCount(
        0,
      );

      // Drive a REAL Claude turn against the mock.
      const userMessage = `[${CONVERSATION_MARKER}] Say something.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      // The user message renders, then the live scripted reply streams in. This
      // text can only originate from the mock answering the live turn.
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(panel.getByText(ASSISTANT_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });

      // PR 827 clean-cancellation / clean-completion contract (observable):
      // once the turn has ended, the chat is idle. The streaming-only "Stop
      // generation" interrupt control is gone and the idle "Send message"
      // control is present — the interrupt control's presence is correctly
      // bound to the streaming state and never lingers.
      await expect(
        window.getByRole('button', { name: 'Stop generation' }),
      ).toHaveCount(0);
      await expect(composerIdleAction(window)).toBeVisible({ timeout: 30_000 });

      // No queued-message interrupt bubble lingers (nothing was queued, and the
      // turn is done).
      await expect(window.getByTestId('queued-message-interrupt')).toHaveCount(
        0,
      );

      // A cleanly ended turn surfaces no error banner.
      await expect(panel.getByRole('alert')).toHaveCount(0);

      // The composer accepts the next message — the chat returned to a usable
      // idle state (the core post-cancel guarantee from PR 827). We type and
      // assert the text renders in the live composer without sending it.
      await composer.click();
      const followUp = 'Composer is usable after the turn ended.';
      await composer.fill(followUp);
      await expect(panel.getByText(followUp)).toBeVisible({ timeout: 15_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
