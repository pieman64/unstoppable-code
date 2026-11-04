import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  buildApprovalRule,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { exercisePlanApproval } from './planApprovalScenario.mjs';
import { stripHookErrorPrefix } from '../../../../packages/ui-shared/src/components/chat/tool-denial.ts';

// ---------------------------------------------------------------------------
// Task 18 — live tool-approval round trip.
//
// WHY THIS FILE IS "tool-approvals-claude-live", NOT "...codex-live":
//
// The task brief asked for a Codex live-turn attempt at a real tool-approval
// round trip (register a conversation whose canned step emits a shell
// command, expect the app-server to raise
// `item/commandExecution/requestApproval`). That attempt was made and its
// premise held — `codexApprovalPolicyFor`/`codexSandboxPolicyFor`
// (`apps/desktop-app/src/main/codex/approval-policy.ts`) DO send
// `askForApproval: 'untrusted'` + a `workspaceWrite` sandbox for `ask` mode
// on this branch (not the old hardcoded `'never'`+`dangerFullAccess` that
// `docs/tool-approvals.md`'s CLAUDE.md summary still describes), and
// `apps/desktop-app/src/main/codex/app-server-client.ts`
// (`handleCommandExecutionApproval`) DOES route a genuine
// `item/commandExecution/requestApproval` through the SAME
// `createApprovalSession` used by Claude.
//
// The blocker is the MOCK, not Canopy: inspecting the real bundled Codex
// binary's actual request payload (by temporarily logging the mock server's
// received body — reverted, not shipped) showed Codex does not ask the model
// for a plain `function_call`/`local_shell_call` at all. Every request
// carries exactly one `custom` tool named `exec`, whose description says the
// model must submit **freeform JavaScript source** that the Codex binary
// evaluates in a sandboxed isolate, invoking nested tools through a global
// `tools` object (e.g. `await tools.exec_command({ command: [...] })`) —
// there is no wire item the mock's `buildResponsesEvents`
// (`mock-server/routes/llm.mjs`) can currently emit that looks like that
// call. A registered `toolCalls: [{ name: 'shell'|'exec_command', input }]`
// canned step is simply never recognized as an executable command by the
// real binary (verified: the turn completes in ~1s straight to the
// follow-up text step, with no approval RPC and no card). Making the mock
// emit the `custom` tool call shape (freeform `response.custom_tool_call_
// input.*` events, not `response.function_call_arguments.*`) is a real,
// separately-scoped change to the shared mock LLM surface used by dozens of
// specs, not a one-off addition belonging to this task. See the "Inherently
// un-automatable" list in `docs/ui-automation.md` for the summary entry.
//
// What DID work, verified empirically before writing this file: a live
// CLAUDE turn whose canned step emits a real `Bash` tool_use (not an
// MCP/Canopy-injected tool) DOES surface the `tool-approval-card` live and
// DOES pause the turn timer — unlike the ask-user MCP path
// (`ask-user-live.spec.mjs`), the Claude approval prompt's `tool_use` block
// is not held back from the transcript while `canUseTool` awaits a
// decision. So "Claude live approval cards" is NOT an un-automatable
// surface (the task brief assumed it would mirror ask-user; it does not),
// and this file exercises that real, reachable path instead — including
// the one persistence contract the synthetic interaction matrix
// (`tool-approval-interactions.spec.mjs`) could not honestly cover:
// session-scope ("Allow for this chat") `sessionApprovalRules` persistence,
// which only happens inside a real `createApprovalSession(...).check(...)`
// call.
//
// Command choice matters here: an `echo ...` command consistently completed
// the turn in well under a second with NO approval prompt at all, while the
// exact same setup with a mutating `touch /tmp/...` command consistently
// prompted. This points to a pre-approval classifier upstream of Canopy's
// own `canUseTool`/`checkViaQueue` (which has no such allowlist —
// `evaluateApproval` in `packages/desktop-shared/src/lib/approval-engine.ts`
// prompts for every `command`-kind check with no matching rule, regardless
// of the command text) — most likely the Claude Agent SDK/CLI's own
// read-only-command safety classification. Every command in this file is
// therefore a real filesystem mutation (`touch`), not a read-only command,
// so it reliably reaches Canopy's approval gate.
// ---------------------------------------------------------------------------

// Every seeded chat here is stamped `approvalMode: 'ask'`: Full Access is the
// product default (CAN-3055) and would run these tool calls without a card.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';

function readTabSessionApprovalRules(
  userDataDir,
  workspaceId,
  worktreeId,
  tabId,
) {
  let file;
  try {
    file = readChatStorageTabs(
      path.join(userDataDir, 'workspaces', workspaceId),
      worktreeId,
    );
  } catch {
    return undefined;
  }
  return file.tabs?.find((t) => t.id === tabId)?.sessionApprovalRules;
}

function readCompletedTurnTimer(userDataDir, workspaceId, worktreeId, tabId) {
  let file;
  try {
    file = readChatStorageTabs(
      path.join(userDataDir, 'workspaces', workspaceId),
      worktreeId,
    );
  } catch {
    return undefined;
  }
  const tab = file.tabs?.find((candidate) => candidate.id === tabId);
  return tab?.messages
    ?.flatMap((message) => message.blocks ?? [])
    .find((block) => block.type === 'turn_timer' && block.completedAt !== null);
}

// Read committed results rather than relying on card interaction alone.
function rawPersistedErrorOutputs(userDataDir) {
  const tabs = readChatStorageTabs(
    path.join(userDataDir, 'workspaces', WORKSPACE_ID),
    WORKTREE_ID,
  ).tabs;
  return (
    tabs
      ?.find((tab) => tab.id === 't1')
      ?.messages?.flatMap((message) => message.blocks ?? [])
      .filter((block) => block.type === 'tool_result' && block.isError)
      .map((block) => block.output) ?? []
  );
}

function persistedErrorOutputs(userDataDir) {
  return rawPersistedErrorOutputs(userDataDir).map(stripHookErrorPrefix);
}

test.describe('live tool-approval round trip (Claude)', () => {
  for (const scenario of [
    { mode: 'ask', decision: 'allow' },
    { mode: 'ask', decision: 'deny' },
    { mode: 'auto', decision: 'allow' },
    { mode: 'auto', tool: 'Write' },
    { mode: 'auto', rule: 'deny', decision: 'deny' },
    { mode: 'full-access', rule: 'deny' },
  ]) {
    test(`plan mode honors session approvals ${JSON.stringify(scenario)}`, async () => {
      test.setTimeout(180_000);
      await exercisePlanApproval(scenario);
    });
  }

  test('an Ask-mode force-push is denied by a safety rule with a visible notice and no approval card', async () => {
    test.setTimeout(180_000);
    const CONVERSATION_MARKER = 'Canopy-CAPPROVELIVE-SAFETY';
    const FOLLOW_UP_REPLY = 'The force-push was blocked by a safety rule';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-live-safety-'),
    );
    // The marker segment runs first, so it exists only if the denied command
    // executed. The demo worktree has no remote to push to either way.
    const markerPath = path.join(userDataDir, 'safety-denied-ran');
    const command = `touch ${markerPath}; git push --force origin HEAD`;
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat', approvalMode: 'ask' }],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [{ name: 'Bash', input: { command } }],
            stopReason: 'tool_use',
          },
          { text: FOLLOW_UP_REPLY, stopReason: 'end_turn' },
        ],
      },
    });

    let { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await window.evaluate(() =>
        window.api.savePreferences({ chatDetail: 'detailed' }),
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('approval-mode-picker')).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
        { timeout: 15_000 },
      );

      // Watch the whole turn: a final count of zero cannot prove a card
      // never flashed up and resolved.
      await window.evaluate(() => {
        const seen = { card: false };
        Reflect.set(window, '__can4811ApprovalCardSeen', seen);
        const check = () => {
          if (document.querySelector('[data-testid="tool-approval-card"]')) {
            seen.card = true;
          }
        };
        new MutationObserver((records) => {
          for (const record of records) {
            for (const added of record.addedNodes) {
              if (
                added instanceof Element &&
                (added.matches('[data-testid="tool-approval-card"]') ||
                  added.querySelector('[data-testid="tool-approval-card"]'))
              )
                seen.card = true;
            }
          }
          check();
        }).observe(document.body, {
          childList: true,
          subtree: true,
        });
        check();
      });

      const panel = window.getByTestId('panel-content-chat');
      const composer = window.getByRole('textbox').first();
      await composer.fill(`[${CONVERSATION_MARKER}] Force-push this branch.`);
      await window.getByRole('button', { name: 'Send message' }).click();

      const notice = panel.getByTestId('approval-safety-denied-notice');
      await expect(notice).toBeVisible({ timeout: 60_000 });
      await expect(notice).toHaveAttribute('data-safety-reason', 'force-push');
      await expect(notice).toContainText(
        'Force-push blocked by a safety rule.',
      );
      await expect(notice).toContainText(
        'This call cannot be approved from a prompt.',
      );
      await expect(notice).toContainText('git push --force origin HEAD');
      await expect(notice).toHaveCount(1);

      const reply = panel.getByText(FOLLOW_UP_REPLY).first();
      await expect(reply).toBeVisible({ timeout: 90_000 });
      await expect
        .poll(() =>
          readCompletedTurnTimer(userDataDir, WORKSPACE_ID, WORKTREE_ID, 't1'),
        )
        .toBeTruthy();

      // The notice reads before the agent's follow-up text.
      const noticeBeforeReply = await notice.evaluate((element, text) => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.includes(text)) {
            return Boolean(
              element.compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_FOLLOWING,
            );
          }
        }
        return false;
      }, FOLLOW_UP_REPLY);
      expect(noticeBeforeReply).toBe(true);
      // Inspect the denied Bash row, then restore the completed collapsed turn.
      const steps = panel.getByRole('button', { name: /^Agent steps/ }).first();
      if ((await steps.getAttribute('aria-expanded')) !== 'true')
        await steps.click();
      const blockedRow = panel
        .locator('[data-tool-name="Bash"][data-tool-status="blocked"]')
        .first();
      await expect(blockedRow).toBeVisible();
      await blockedRow.locator('button').first().click();
      await expect(blockedRow).toContainText('blocked by safety rule');
      await expect(blockedRow).not.toContainText('user denied');
      await expect(blockedRow).not.toContainText('PreToolUse:');
      expect(
        await blockedRow.evaluate((row) => {
          const notice = document.querySelector(
            '[data-testid="approval-safety-denied-notice"]',
          );
          return (
            notice !== null &&
            Boolean(
              row.compareDocumentPosition(notice) &
              Node.DOCUMENT_POSITION_FOLLOWING,
            )
          );
        }),
      ).toBe(true);
      if ((await steps.getAttribute('aria-expanded')) === 'true')
        await steps.click();
      await expect(steps).toHaveAttribute('aria-expanded', 'false');
      // Still visible once the completed turn collapses its tool rows.
      await expect(notice).toBeVisible();

      expect(
        await window.evaluate(
          () => Reflect.get(window, '__can4811ApprovalCardSeen')?.card,
        ),
      ).toBe(false);
      expect(existsSync(markerPath)).toBe(false);
      const safetyMessage =
        'Blocked by a safety rule (force-push). This call cannot be approved from a prompt. Do not retry or repackage the blocked operation. Choose a safe alternative or explain the block to the user.';
      await expect
        .poll(() => persistedErrorOutputs(userDataDir))
        .toContainEqual(expect.stringContaining(safetyMessage));
      await test.info().attach('safety-denial-persisted-output.json', {
        body: JSON.stringify(rawPersistedErrorOutputs(userDataDir), null, 2),
        contentType: 'application/json',
      });

      // Exactly one durable receipt, and exactly one notice after a full app restart.
      const receipts = () =>
        readChatStorageTabs(
          path.join(userDataDir, 'workspaces', WORKSPACE_ID),
          WORKTREE_ID,
        )
          .tabs?.find((tab) => tab.id === 't1')
          ?.messages?.flatMap((message) => message.blocks ?? [])
          .filter((block) => block.type === 'approval_safety_denied_info') ??
        [];
      await expect.poll(() => receipts().length).toBe(1);
      expect(receipts()[0]).toEqual(
        expect.objectContaining({ reason: 'force-push', mode: 'ask' }),
      );

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir }),
      ));
      const restoredWindow = await electronApp.firstWindow();
      const restoredApp = new CanopyAppDriver(restoredWindow);
      await restoredApp.waitForShell({ timeout: 30_000 });
      await restoredApp.openMainPage();
      await restoredApp.selectWorktree(WORKTREE_BRANCH);
      await expect(
        restoredWindow.getByTestId('approval-safety-denied-notice'),
      ).toHaveCount(1, { timeout: 30_000 });
      expect(receipts()).toHaveLength(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a remembered command allow still prompts before targeting protected approval policy', async () => {
    test.setTimeout(180_000);
    const CONVERSATION_MARKER = 'Canopy-CAPPROVELIVE-PROTECTED';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-live-protected-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const { filePath: protectedPolicyPath } = seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      rules: [
        buildApprovalRule({
          behavior: 'allow',
          target: { kind: 'command', pattern: 'touch *' },
        }),
      ],
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat', approvalMode: 'ask' }],
    });

    const command = `touch ${protectedPolicyPath}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [{ name: 'Bash', input: { command } }],
            stopReason: 'tool_use',
          },
          { text: 'Protected command resolved', stopReason: 'end_turn' },
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
      await window.evaluate(() =>
        window.api.savePreferences({ chatDetail: 'detailed' }),
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const composer = window.getByRole('textbox').first();
      await composer.fill(
        `[${CONVERSATION_MARKER}] Run the remembered protected command.`,
      );
      await window.getByRole('button', { name: 'Send message' }).click();

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText(command);
      await card.getByRole('button', { name: 'Add a reason' }).click();
      await card.getByRole('textbox').fill('Not on this branch.');
      await window.getByTestId('tool-approval-deny').click();
      await expect(card).toHaveCount(0);
      await expect
        .poll(() => persistedErrorOutputs(userDataDir), { timeout: 60_000 })
        .toContainEqual(
          expect.stringMatching(
            /^The user denied this tool call: Not on this branch\./,
          ),
        );
      const steps = window
        .getByRole('button', { name: /^Agent steps/ })
        .first();
      if (
        (await steps.count()) > 0 &&
        (await steps.getAttribute('aria-expanded')) !== 'true'
      )
        await steps.click();
      const blocked = window
        .locator('[data-tool-name="Bash"][data-tool-status="blocked"]')
        .first();
      await expect(blocked).toBeVisible();
      await blocked.locator('button').first().click();
      await expect(blocked).toContainText('denied by you');
      await expect(blocked).toContainText('Not on this branch.');
      await expect(blocked).not.toContainText('PreToolUse:');
      await expect
        .poll(() => persistedErrorOutputs(userDataDir))
        .toContainEqual(
          expect.stringMatching(
            /^The user denied this tool call: Not on this branch\./,
          ),
        );
      await test.info().attach('user-denial-persisted-output.json', {
        body: JSON.stringify(rawPersistedErrorOutputs(userDataDir), null, 2),
        contentType: 'application/json',
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a live Bash tool call in Ask mode renders the approval card, pauses the turn timer, and Allow once completes the turn', async () => {
    test.setTimeout(180_000);
    const CONVERSATION_MARKER = 'Canopy-CAPPROVELIVE1';
    const FOLLOW_UP_REPLY = 'Finished running the approved command';

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-live-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat', approvalMode: 'ask' }],
    });

    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'Bash',
                input: {
                  command: 'touch /tmp/canopy-approval-live-once-marker',
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
      await expect(
        window.getByRole('button', {
          name: `Collapse ${WORKSPACE_NAME}`,
        }),
      ).toBeVisible();
      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      // New chats default to Full Access (CAN-3055), so the seeded tab is
      // stamped Ask. Confirm the picker shows it before sending so the send
      // path reads the hydrated mode rather than a still-loading default.
      await expect(window.getByTestId('approval-mode-picker')).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
        { timeout: 15_000 },
      );

      const userMessage = `[${CONVERSATION_MARKER}] Run the approval-gated command.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The live approval-service round trip: the bundled `claude` binary
      // POSTs to the mock, gets back the Bash `tool_use`, and `canUseTool`
      // routes it through the real `createApprovalSession(...).check(...)`,
      // which bridges to the renderer and renders the card.
      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText(
        'touch /tmp/canopy-approval-live-once-marker',
      );

      // CAN-5291: inspect the transcript call tied to this real approval.
      await window.evaluate(() =>
        window.api.savePreferences({ chatDetail: 'detailed' }),
      );
      const waitingCall = panel
        .locator('[data-tool-name="Bash"]')
        .filter({ hasText: 'canopy-approval-live-once-marker' });
      await expect(waitingCall).toHaveAttribute('data-tool-status', 'pending');
      await expect(waitingCall).toHaveAttribute(
        'data-tool-approval',
        'waiting',
      );
      await expect(waitingCall).toContainText('Waiting for approval');
      await expect(
        waitingCall.locator('[class*="canopy-text-shimmer"]'),
      ).toHaveCount(0);

      // A renderer-only reload keeps the main-process approval waiter alive.
      // Revisioned hydration must recover that canonical pending request so
      // the user can still answer it after the renderer reconnects.
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText(
        'touch /tmp/canopy-approval-live-once-marker',
      );

      const timer = window.getByTestId('turn-timer');
      await expect(timer).toHaveAttribute('data-state', 'paused');

      // Keep the approval open long enough that the durable paused interval is
      // unambiguous even on coarse or heavily loaded CI clocks.
      await window.waitForTimeout(250);

      await window.getByTestId('tool-approval-allow').click();

      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);

      // This decision was resolved by a REAL `createApprovalSession(...)
      // .check(...)` pending entry (not a synthetic/injected event), so
      // `approval:respond` resolves `true` and the renderer's
      // `resumeApprovalTurnTimer` gate (`stores/chat/slices/approvals.ts`,
      // hardened in c4585cb7b) actually fires — the timer must leave
      // `paused`. This is the real-path counterpart to the synthetic
      // "does not resume" case asserted in
      // `tool-approval-interactions.spec.mjs`.
      await expect(timer).not.toHaveAttribute('data-state', 'paused');
      await expect(waitingCall).not.toHaveAttribute(
        'data-tool-approval',
        'waiting',
      );

      // The follow-up text can only originate from the SDK actually
      // executing the approved command and continuing the turn.
      await expect(panel.getByText(FOLLOW_UP_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });

      await expect
        .poll(() =>
          readCompletedTurnTimer(userDataDir, WORKSPACE_ID, WORKTREE_ID, 't1'),
        )
        .toEqual(
          expect.objectContaining({
            accumulatedPausedDurationMs: expect.any(Number),
          }),
        );
      expect(
        readCompletedTurnTimer(userDataDir, WORKSPACE_ID, WORKTREE_ID, 't1')
          ?.accumulatedPausedDurationMs,
      ).toBeGreaterThanOrEqual(200);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a live "Allow for this chat" decision persists a real sessionApprovalRules entry', async () => {
    test.setTimeout(180_000);
    const CONVERSATION_MARKER = 'Canopy-CAPPROVELIVE2';
    const FOLLOW_UP_REPLY = 'Finished with a remembered rule';
    const TAB_ID = 'session-scope-live';

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-live-session-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: TAB_ID,
      tabs: [{ id: TAB_ID, title: 'Session Scope Live', approvalMode: 'ask' }],
    });

    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'Bash',
                input: {
                  command: 'touch /tmp/canopy-approval-live-session-marker',
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

      const userMessage = `[${CONVERSATION_MARKER}] Run the remembered command.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible({ timeout: 60_000 });

      await window.getByLabel('More allow options').click();
      await window
        .getByRole('menuitem', { name: /Allow for this chat/ })
        .click();

      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
      await expect(panel.getByText(FOLLOW_UP_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });

      // Unlike the synthetic interaction matrix, this decision was resolved
      // by a REAL `createApprovalSession(...).check(...)` call, so the main
      // process's `persistScopedRule('session', ...)` really does push a
      // rule and emit `approval:rule-added` — poll the persisted tab file
      // for it (debounced 500ms save).
      await expect
        .poll(() =>
          readTabSessionApprovalRules(
            userDataDir,
            WORKSPACE_ID,
            WORKTREE_ID,
            TAB_ID,
          ),
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ behavior: 'allow', origin: 'prompt' }),
          ]),
        );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // Current Claude builds gate the parent `Agent` invocation before launching
  // its background process. This live case exercises that reachable boundary;
  // deterministic interaction coverage owns child-attributed badge rendering.
  test('a live background Agent invocation in Ask mode renders an approval card, and Allow once lets it proceed', async () => {
    test.setTimeout(180_000);
    const PARENT_MARKER = 'Canopy-CAPPROVELIVESUB';
    const PARENT_FOLLOW_UP = 'Started the background task';

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-live-subagent-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat', approvalMode: 'ask' }],
    });

    // Parent turn: request a background agent and continue once its
    // approval-gated invocation is released.
    await registerScenario(DEFAULT_MOCK_BASE_URL, PARENT_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'Agent',
                input: {
                  description: 'Run background task',
                  prompt: 'Complete the background task.',
                  subagent_type: 'general-purpose',
                  run_in_background: true,
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: PARENT_FOLLOW_UP, stopReason: 'end_turn' },
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
      await expect(
        window.getByRole('button', {
          name: `Collapse ${WORKSPACE_NAME}`,
        }),
      ).toBeVisible();
      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      await expect(window.getByTestId('approval-mode-picker')).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
        { timeout: 15_000 },
      );

      const userMessage = `[${PARENT_MARKER}] Spawn the background agent.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The parent Agent tool use goes through the same real approval-session
      // path as Bash, before Claude creates the background process.
      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText('Agent');
      await expect(
        window.getByTestId('tool-approval-subagent-badge'),
      ).toHaveCount(0);

      await window.getByTestId('tool-approval-allow').click();

      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);

      await expect(panel.getByText(PARENT_FOLLOW_UP).first()).toBeVisible({
        timeout: 90_000,
      });

      // The background process is created and reaches a terminal bucket after
      // the approval gate is released.
      await expect(
        window.getByText('Agent background processes'),
      ).toBeVisible();
      await expect(window.getByText(/Stopped \(1\)/)).toBeVisible({
        timeout: 90_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
