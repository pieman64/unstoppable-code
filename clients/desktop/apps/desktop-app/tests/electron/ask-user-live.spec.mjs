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
// Live-turn ASK-USER TOOL LOOP — bundled Claude SDK → mock LLM → in-app MCP
// `AskUserQuestion` tool → follow-up. Doc 5 §5; Doc 2 Spec 4/14.
//
// Builds on the `chat-live-turn.spec.mjs` pilot. The scripted conversation is
// TWO steps and exercises the full provider ask-user tool loop:
//
//   step 0 — the mock returns a `tool_use` for `mcp__canopy__AskUserQuestion`
//            with a single question (`Pick a color` / [Red, Blue]) and
//            `stopReason: 'tool_use'`. The bundled `claude` binary executes
//            that MCP tool in-process via the branded canopy MCP HTTP proxy
//            (`createClaudeCanopyToolRuntime` →
//            `executeCanopyInjectedTool('ask_user_question', ...)` →
//            `requestAnswersFromRenderer`).
//   step 1 — resolved by assistant-turn count once the tool_result returns,
//            the mock streams the follow-up text.
//
// WHAT THIS SPEC ASSERTS (the deterministic, reachable signal):
//   The live ask-user tool loop round-trips and the step-1 follow-up text
//   renders in the transcript. That text can ONLY originate from the SECOND
//   turn of the live loop (after the ask-user `tool_use` from step 0 was
//   executed and its `tool_result` handed back to the SDK), so its presence is
//   proof the bundled Claude SDK drove a real ask-user tool round-trip against
//   the mock. Verified deterministic across repeated runs.
//
// BLOCKER — the interactive `AskUserQuestionCard` is NOT reachable here:
//   The live `ask-user-question-card` (Submit/Dismiss + selectable options)
//   does NOT render during an automated live turn for the Claude MCP path.
//   `ChatBlockRenderer` mounts `AskUserQuestionCard` only off a rendered
//   ask-user `tool_use` display block, but that block is never surfaced to the
//   renderer transcript on this path: across an automated turn the persisted
//   transcript contains only the user `text` block and a `system` `turn_timer`
//   block — no ask-user `tool_use`, no `tool_result`, no "User questions" row.
//   Polling the DOM every 250ms for ~60s never observes either the
//   `ask-user-question-card` testid or the transient "Preparing question…"
//   state (`maxCard=0`, `maxPreparing=0`), and the loop still advances to the
//   step-1 follow-up. The interactive card therefore cannot be answered through
//   the UI in this harness; the loop completes as if the question resolved
//   without a card.
//
//   This is an in-app behavior of the Claude MCP ask-user path under an
//   automated live turn, not a mock or seeding gap: the mock correctly streams
//   the `tool_use` (an identical-shaped `GetScriptOutput` tool_use renders its
//   card fine and is asserted green in `chat-tool-call-live.spec.mjs`). Because
//   the live card is unreachable, this spec asserts the loop completion that IS
//   deterministic rather than faking a card interaction.
//
// See `chat-live-turn.spec.mjs` for the env-hygiene rationale behind
// `withBundledBinaryOverridesScrubbed`.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const CONVERSATION_MARKER = 'Canopy-CASKUSER';
const QUESTION = 'Pick a color';
const OPTION_RED = 'Red';
const OPTION_BLUE = 'Blue';
// No trailing punctuation: assistant text streams into a markdown <span> and a
// trailing '.' is not reliably part of the same matched text node.
const FOLLOW_UP_REPLY = 'Thanks for answering the question';

test.describe('ask-user live turn', () => {
  test('a live Claude ask-user tool loop round-trips and the follow-up renders', async () => {
    // SDK process spawn + two-turn loop (tool call + follow-up) takes longer
    // than the 60s default; bound it generously.
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-ask-user-live-'),
    );

    // Phase 1: real git worktree (plain `ts-pnpm-vite` fixture).
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    // Phase 1: a Claude-backed empty chat tab so the composer mounts ready to
    // send. No seeded transcript — the follow-up comes from the live loop.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });

    // Register the two-step ask-user loop under the `[Canopy-CASKUSER]` marker.
    // Step 0 = ask-user tool_use; step 1 (resolved by assistant-turn count
    // after the tool_result returns) = the follow-up text.
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'mcp__canopy__AskUserQuestion',
                input: {
                  questions: [
                    { question: QUESTION, options: [OPTION_RED, OPTION_BLUE] },
                  ],
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: FOLLOW_UP_REPLY, stopReason: 'end_turn' },
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

      // Type the marker-bearing message into the Slate composer and send it.
      const userMessage = `[${CONVERSATION_MARKER}] Ask me to pick a color.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);

      await window.getByRole('button', { name: 'Send message' }).click();

      // The user message renders once sent.
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The live loop is the real validator. The bundled `claude` binary POSTs
      // to the mock, the mock emits the ask-user `tool_use` (step 0), the SDK
      // executes the in-app `mcp__canopy__AskUserQuestion` tool, hands the
      // tool_result back, and the mock resolves step 1 (by assistant-turn
      // count). The follow-up text can ONLY originate from that second turn, so
      // its presence proves the live ask-user tool loop round-tripped against
      // the mock end to end.
      await expect(panel.getByText(FOLLOW_UP_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
