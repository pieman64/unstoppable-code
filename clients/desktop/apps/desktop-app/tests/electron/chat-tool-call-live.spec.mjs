import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// Live-turn TOOL LOOP — bundled Claude SDK → mock LLM → in-app MCP tool.
// Doc 5 §5; Doc 2 Spec 4/14.
//
// This builds on the `chat-live-turn.spec.mjs` pilot (which proved a single
// live text turn reaches the mock and streams back). Here the scripted
// conversation is TWO steps and exercises the full provider tool loop:
//
//   step 0 — the mock returns a `tool_use` for `mcp__canopy__GetScriptOutput`
//            with `stopReason: 'tool_use'`. The bundled `claude` binary
//            EXECUTES that tool in-process: it routes to the HTTP MCP proxy
//            (`getMcpHttpProxyService`) →
//            `executeCanopyInjectedTool('get_script_output', ...)` →
//            `loadWorktreeScriptOutput`. The demo worktree has no persisted
//            script output, so the tool returns a deterministic
//            "No persisted output" text result with NO real side effects.
//   step 1 — resolved by assistant-turn count once the tool_result is sent
//            back, the mock returns the follow-up text.
//
// `GetScriptOutput` is the right tool for this spec because its card renders
// from the `tool_use` alone (no UI interaction needed to complete it — the
// ask-user interactive loop is the SIBLING `ask-user-live.spec.mjs`). The
// rendered card label is "Script Output" (see
// packages/ui-shared/src/components/chat/tool-display.tsx `renderGetScriptOutput`).
//
// A green run is proof the bundled Claude SDK drove a real tool call against
// the mock: the asserted card + follow-up text can ONLY come from the live
// two-step loop. See `chat-live-turn.spec.mjs` for the env-hygiene rationale
// behind `withBundledBinaryOverridesScrubbed`.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const CONVERSATION_MARKER = 'Canopy-CTOOLLOOP';
// Distinct scriptId so the rendered tool-call card is unambiguous in the
// transcript. The mock ignores the input; the in-app tool just reports no
// persisted output for it.
const SCRIPT_ID = 'launch';
// No trailing punctuation: assistant text streams into a markdown <span> and a
// trailing '.' is not reliably part of the same matched text node.
const FOLLOW_UP_REPLY = 'Checked the script output and finished the loop';

test.describe('chat tool-call live turn', () => {
  test('a live Claude turn drives an MCP tool call against the mock and renders the card + follow-up', async () => {
    // SDK process spawn + two-turn loop (tool call + follow-up) takes longer
    // than the 60s default; bound it generously.
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-tool-call-live-'),
    );

    // Phase 1: real git worktree (plain `ts-pnpm-vite` fixture).
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const reportPath = path.join(
      seeded.workspaces[0].worktreePath,
      'canopy-report.md',
    );
    const resultsPath = path.join(
      seeded.workspaces[0].worktreePath,
      'canopy-results.csv',
    );
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });

    // Phase 1: a Claude-backed empty chat tab so the composer mounts ready to
    // send. No seeded transcript blocks — every block asserted below must come
    // from the live turn against the mock.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });

    // Register the two-step tool loop under the `[Canopy-CTOOLLOOP]` marker.
    // Step 0 = tool_use; step 1 (resolved by assistant-turn count after the
    // tool_result returns) = the follow-up text.
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'mcp__canopy__GetScriptOutput',
                input: { scriptId: SCRIPT_ID },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            toolCalls: [
              {
                name: 'Write',
                input: {
                  file_path: reportPath,
                  content: '# Tool output report\n',
                },
              },
              {
                name: 'Write',
                input: { file_path: resultsPath, content: 'result,42\n' },
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
      const userMessage = `[${CONVERSATION_MARKER}] Read the launch script output.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);

      await window.getByRole('button', { name: 'Send message' }).click();

      // The user message renders once sent.
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The live tool loop is the real validator. The bundled `claude` binary
      // POSTs to the mock, the mock emits the `tool_use`, the SDK executes the
      // in-app GetScriptOutput MCP tool, and the tool-call card renders. The
      // card label is "Script Output" with the scriptId as a code chunk.
      await expect(panel.getByText('Script Output').first()).toBeVisible({
        timeout: 90_000,
      });
      await expect(panel.getByText(SCRIPT_ID).first()).toBeVisible({
        timeout: 30_000,
      });

      // After the tool_result is sent back, the mock resolves step 1 (by
      // assistant-turn count) and the follow-up text streams in. This text can
      // ONLY originate from the second turn of the live loop.
      await expect(panel.getByText(FOLLOW_UP_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });

      // Tool-created files must remain reachable from the transcript summary.
      const files = panel.getByTestId('turn-files').last();
      const disclosure = files.locator('button[aria-expanded="false"]');
      if (await disclosure.count()) await disclosure.press('Enter');
      await files
        .getByRole('button', { name: /^(?:Open )?canopy-report\.md$/ })
        .click();
      const viewer = window.getByTestId('file-viewer');
      await expect(viewer).toContainText('canopy-report.md');
      expect(readFileSync(reportPath, 'utf8')).toBe('# Tool output report\n');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
