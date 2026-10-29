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

// ---------------------------------------------------------------------------
// PLAN MODE — Doc 5 §5 "C-plan"; Doc 13 WP-LIVE-PLAN.
//
// Intended live-turn shape (built on `chat-live-turn.spec.mjs` and
// `chat-tool-call-live.spec.mjs`): a Claude chat tab in plan mode, a scripted
// turn that proposes a plan, and an assertion that the plan-approval ("plan
// exit") bar renders with the scripted plan — WITHOUT approving into an
// implementation turn.
//
// HOW PLAN MODE IS ENTERED (deterministic, asserted below):
//   The tab is seeded with `planMode: true`. This is a passthrough
//   `PersistedChatTab` field: `seedWorktreeChat` forwards arbitrary tab fields
//   (`...rest` in `normalizeTab`) and the chatStore restore path reads
//   `planMode: pt.planMode ?? false`. At this roomy viewport, `ChatInput`
//   exposes plan mode as an inline composer control. Its
//   `chat-input-plan-mode-inline-button` carries `aria-pressed`, providing a
//   deterministic signal for both seeded state and live UI changes. When the
//   toolbar is compressed, the same action remains available from the `+` menu.
//
// HOW THE LIVE PLAN IS DETECTED (the seam):
//   In `permissionMode: 'plan'` the Claude SDK finishes a plan only by calling
//   the built-in `ExitPlanMode` tool. `claude-session.ts`'s
//   `canUseTool('ExitPlanMode', input)` then fires `IPC_CHANNELS.planExitRequest`
//   (carrying the plan) and returns `{ behavior: 'deny', interrupt: true }`; the
//   renderer's `handlePlanExitRequest` sets `tab.pendingPlanExit`, which renders
//   the plan-approval prompt in the composer (`chat-plan-approval`: its
//   `chat-plan-implement` / `chat-plan-pipeline` answers and `chat-plan-explore`)
//   plus the plan markdown as an `ExitPlanMode` tool block.
//   Explore opens the proposed plan's Plan panel (`panel-content-plan`) beside
//   the chat, tracking the plan first when needed.
//
// HOW THE MOCK SUPPLIES THE PLAN (verified against Claude Code 2.1.293):
//   The bundled binary takes the plan from its plan file, never from the
//   model's `ExitPlanMode` call: it drops a model-supplied `plan` from the tool
//   input and adds back only what is on disk, so a scripted
//   `ExitPlanMode({ plan })` reaches `canUseTool` as `{}` and the Plan panel
//   shows `{}`. (2.1.284 and earlier passed a model-supplied plan through when
//   no plan file existed.) The scripted turn therefore does what a real plan
//   turn does: it writes the plan file first, then calls `ExitPlanMode` with no
//   plan. The file's path carries a per-session slug, so the mock fills it in
//   from the plan-mode reminder in the request (`writesPlanModePlanFile`, see
//   `mock-server/routes/llm.mjs`).
//
//   See `chat-live-turn.spec.mjs` for the env-hygiene rationale behind
//   `withBundledBinaryOverridesScrubbed`.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const CONVERSATION_MARKER = 'Canopy-CPLAN';
const PLAN_MARKER_LINE = 'Mock plan ready for deterministic Canopy review';
const PLAN_TEXT = `# Proposed plan\n\n${PLAN_MARKER_LINE}\n\n- Step one\n- Step two`;

async function semanticWarningTone(window) {
  return window.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'bg-warning-subtle fg-warning';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const tone = {
      backgroundColor: style.backgroundColor,
      color: style.color,
    };
    probe.remove();
    return tone;
  });
}

test.describe('chat plan mode', () => {
  test('a seeded plan-mode tab shows the active plan toggle, toggles via the UI, and survives a live plan turn', async () => {
    // SDK process spawn + the two-step plan turn take longer than the default;
    // bound it generously.
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-plan-mode-'),
    );

    // Phase 1: real git worktree (plain `ts-pnpm-vite` fixture).
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    // Phase 1: a Claude-backed empty chat tab already in plan mode.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat', planMode: true }],
    });

    // The plan conversation: write the plan file, then leave plan mode (see
    // the header for why the plan cannot ride on the `ExitPlanMode` call).
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'Write',
                id: 'toolu_plan_file',
                writesPlanModePlanFile: true,
                input: { content: PLAN_TEXT },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            toolCalls: [
              { name: 'ExitPlanMode', id: 'toolu_exit_plan', input: {} },
            ],
            stopReason: 'tool_use',
          },
        ],
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

      // ── Deterministic plan-mode entry signal ──────────────────────────────
      // The seeded `planMode: true` restores into the inline Plan control.
      const planToggle = panel.getByTestId(
        'chat-input-plan-mode-inline-button',
      );
      await expect(planToggle).toBeVisible({ timeout: 30_000 });
      await expect(planToggle).toHaveAttribute('aria-pressed', 'true');
      await expect(planToggle).toContainText('Plan');
      const warningTone = await semanticWarningTone(window);
      await expect
        .poll(() =>
          planToggle.evaluate((button) => {
            const style = getComputedStyle(button);
            return {
              backgroundColor: style.backgroundColor,
              color: style.color,
            };
          }),
        )
        .toEqual(warningTone);

      // ── Deterministic plan-mode UI toggle ─────────────────────────────────
      // The active chip turns plan mode off. The + menu turns it back on.
      await planToggle.click();
      await expect(planToggle).toHaveCount(0);
      await panel.getByTestId('chat-input-plus-button').click();
      await window.getByTestId('chat-input-plan-mode-button').click();
      await expect(planToggle).toHaveAttribute('aria-pressed', 'true');
      await expect(planToggle).toContainText('Plan');

      // ── Drive the live plan turn ───────────────────────────────────────────
      // Plan mode is ON. Send the marker message so the bundled binary runs a
      // real `permissionMode: 'plan'` turn against the mock.
      const userMessage = `[${CONVERSATION_MARKER}] Plan a change for me.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);

      await window.getByRole('button', { name: 'Send message' }).click();

      // The user message renders once sent — proof the plan turn was dispatched.
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The live plan turn: the proposed plan renders in the chat and the
      // composer becomes the plan-approval prompt.
      await expect(panel.getByText(PLAN_MARKER_LINE).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(window.getByTestId('chat-plan-implement')).toBeVisible({
        timeout: 30_000,
      });
      await expect(window.getByTestId('chat-plan-explore')).toBeVisible({
        timeout: 30_000,
      });

      // Explore opens the proposed plan in its Plan panel beside the chat.
      await window.getByTestId('chat-plan-explore').click();
      const planPanel = window.locator('[data-testid="panel-content-plan"]');
      await expect(planPanel).toBeVisible({ timeout: 30_000 });
      await expect(planPanel).toContainText(PLAN_MARKER_LINE);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a waiting plan turns the composer into the approval prompt, which closes to a Plan ready chip', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-plan-approval-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    // A Claude chat whose plan-mode turn ended on a plan that still waits
    // (restored from the tab, as after a restart).
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: 't1',
          title: 'Chat',
          planMode: true,
          pendingPlanExit: { plan: PLAN_TEXT },
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

      const panel = window.getByTestId('panel-content-chat');
      const composer = panel.locator('[data-chat-composer-root]').first();
      const box = composer.locator('[data-composer-layout]');
      const prompt = composer.getByTestId('chat-plan-approval');

      // The box asks, with its numbered answers above the text row.
      await expect(prompt).toBeVisible({ timeout: 30_000 });
      await expect(box).toHaveAttribute(
        'data-composer-layout',
        'plan-approval',
      );
      await expect(prompt).toContainText('Implement this plan?');
      const implement = prompt.getByTestId('chat-plan-implement');
      const pipeline = prompt.getByTestId('chat-plan-pipeline');
      await expect(implement).toHaveText('1Yes, implement this plan');
      await expect(pipeline).toHaveText('2Run it as a pipeline');
      // No bar of buttons above the box any more.
      await expect(window.getByTestId('chat-plan-execute')).toHaveCount(0);

      // The text row is the composer's input with its own controls: the
      // microphone (or a disabled send) while empty, send once typed.
      const note = prompt.locator(
        '[data-chat-textarea][contenteditable="true"]',
      );
      // A pen leads the note, as on a question's own answer.
      await expect(prompt.getByTestId('composer-prompt-pen')).toBeVisible();
      await expect(prompt).toContainText('No, explain what to do differently');
      await expect(prompt.getByTestId('chat-plan-approval-skip')).toHaveCount(
        0,
      );
      const trailing = prompt
        .locator(
          '[data-testid="voice-input-button"], button[aria-label="Send message"]',
        )
        .last();
      await expect(trailing).toHaveCSS('height', '32px');
      // x is the microphone's 32px circle, ending where the trailing
      // control ends.
      const close = prompt.getByTestId('chat-plan-approval-close');
      await expect(close).toHaveCSS('height', '32px');
      await expect(close).toHaveCSS('width', '32px');
      const closeBox = await close.boundingBox();
      const trailingBox = await trailing.boundingBox();
      expect(closeBox).not.toBeNull();
      expect(trailingBox).not.toBeNull();
      if (closeBox && trailingBox) {
        expect(
          Math.abs(
            closeBox.x + closeBox.width - (trailingBox.x + trailingBox.width),
          ),
        ).toBeLessThanOrEqual(0.5);
      }
      await note.click();
      // @ opens the composer menu over the box, as in the composer, and the
      // first Escape closes the menu, not the prompt.
      await note.pressSequentially('@');
      const menu = window.getByTestId('chat-input-plus-menu');
      await expect(menu).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(prompt).toBeVisible();
      await note.fill('');
      await note.pressSequentially('Cap the retry at three');
      await expect(
        prompt.getByRole('button', { name: 'Send message', exact: true }),
      ).toBeEnabled();
      await note.fill('');

      // x closes the prompt and keeps the plan waiting behind Plan's chip.
      await close.click();
      await expect(prompt).toHaveCount(0);
      const ready = composer.getByTestId('chat-input-plan-ready-chip');
      await expect(ready).toHaveText('Plan ready');
      await expect(
        composer.getByTestId('chat-input-plan-mode-inline-button'),
      ).toHaveCount(0);
      await expect(box).toHaveAttribute('data-composer-layout', 'one-line');

      // The chip reopens it; the arrows move between answers and Escape
      // closes it again.
      await ready.click();
      await expect(prompt).toBeVisible();
      // Reopened, the cursor waits in the note.
      await expect(note).toBeFocused();
      await implement.focus();
      await window.keyboard.press('ArrowDown');
      await expect(pipeline).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(prompt).toHaveCount(0);
      await expect(ready).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
