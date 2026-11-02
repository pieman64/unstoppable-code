import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  addSharedPlanThread,
  buildPlanCommentThread,
  buildTrackedPlan,
  clearScenario,
  generalAnchor,
  registerScenario,
  registerSharedPlanScenario,
  remoteComment,
  seedTrackedPlans,
  seedWorktreeChat,
  sharedPlanServerSeed,
  SHARED_PLAN_TEAMMATES,
  teamShareState,
  userComment,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closeSharedPlanOwner,
  launchSharedPlanOwner,
  waitForSharedPlanStartupSync,
} from './sharedPlanOwnerFixture.mjs';

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
// Headings, numbered steps, a fence, backticked paths and Unicode: Copy plan
// must reproduce every byte (CAN-5354).
const PLAN_TEXT = `# Proposed plan\n\n${PLAN_MARKER_LINE}\n\n- Step one\n- Step two\n\n## Steps ✓\n\n1. Edit \`src/main.ts\`\n2. Run the tests — naïvely\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n`;
const CLIPBOARD_SENTINEL = 'canopy-clipboard-sentinel';

/** Seed the clipboard, then wait for `action` to replace it with the plan. */
async function expectCopiedPlan(electronApp, action) {
  await electronApp.evaluate(
    ({ clipboard }, text) => clipboard.writeText(text),
    CLIPBOARD_SENTINEL,
  );
  await action();
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(PLAN_TEXT);
}

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

// Holds a revise turn before its replacement `ExitPlanMode` (CAN-5431).
const REVISE_EXIT_BARRIER = 'can-5431-revise-exit';

async function reviseExitWaiting(key) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/barrier?key=${encodeURIComponent(key)}`,
  );
  expect(response.ok).toBe(true);
  const { barriers } = await response.json();
  return (
    barriers.find(({ name }) => name === REVISE_EXIT_BARRIER)?.waiting ?? 0
  );
}

async function releaseReviseExit(key) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name: REVISE_EXIT_BARRIER }),
  });
  expect(response.ok).toBe(true);
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

      // ── Copy plan (CAN-5354) ──────────────────────────────────────────────
      // The prompt's Copy plan copies the raw Markdown from the keyboard,
      // announces it, and leaves the prompt waiting.
      const approvalCopy = window.getByTestId('chat-plan-copy');
      await expect(approvalCopy).toHaveAccessibleName('Copy plan');
      await expectCopiedPlan(electronApp, async () => {
        await approvalCopy.focus();
        await window.keyboard.press('Enter');
      });
      await expect(window.getByTestId('chat-plan-copy-status')).toHaveText(
        'Copied',
      );
      await expect(window.getByTestId('chat-plan-approval')).toBeVisible();

      // The finished plan turn has exactly one copy action: its plan's.
      const turnCopy = panel.getByTestId('turn-copy-plan');
      await expect(turnCopy).toHaveCount(1, { timeout: 30_000 });
      await expect(panel.getByTestId('turn-copy-message')).toHaveCount(0);
      await expectCopiedPlan(electronApp, () => turnCopy.click());
      await expect(panel.getByTestId('turn-copy-plan-status')).toHaveText(
        'Copied',
      );

      // Explore opens the proposed plan in its Plan panel beside the chat.
      await window.getByTestId('chat-plan-explore').click();
      const planPanel = window.locator('[data-testid="panel-content-plan"]');
      await expect(planPanel).toBeVisible({ timeout: 30_000 });
      await expect(planPanel).toContainText(PLAN_MARKER_LINE);
      // The Plan panel's Copy plan sits beside Share, out of Execute's menu.
      const headerCopy = planPanel.getByTestId('plan-panel-copy');
      await expect(headerCopy).toBeVisible();
      await expectCopiedPlan(electronApp, () => headerCopy.click());
      await expect(planPanel.getByTestId('plan-panel-copy-status')).toHaveText(
        'Copied',
      );
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
      await expect(pipeline).toHaveText('2Run it as a workflow');
      // A restored plan still copies exactly, without answering the prompt.
      await expectCopiedPlan(electronApp, () =>
        prompt.getByTestId('chat-plan-copy').click(),
      );
      await expect(prompt).toBeVisible();
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

  test("the approval prompt warns about the waiting plan's unsent comments, without blocking Implement", async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-plan-unsent-comments-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const PLAN_ID = 'plan-unsent-comments';
    const DRAFT = 'Cap the retry at three attempts';
    seedTrackedPlans({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      plans: [
        buildTrackedPlan({
          id: PLAN_ID,
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          title: 'Proposed plan',
          content: PLAN_TEXT,
          commentThreads: [
            buildPlanCommentThread({
              id: 'thread-draft',
              anchor: generalAnchor(),
              comments: [
                userComment({ id: 'draft-1', body: DRAFT, staged: true }),
              ],
            }),
          ],
        }),
      ],
    });
    // The waiting chat sits beside another editable chat; the notice is the
    // waiting chat's plan only.
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
          trackedPlanId: PLAN_ID,
        },
        { id: 't2', title: 'Other chat' },
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
      const prompt = composer.getByTestId('chat-plan-approval');
      await expect(prompt).toBeVisible({ timeout: 30_000 });

      // The unsent comment is one more answer, after the numbered ones.
      const notice = prompt.getByTestId('chat-plan-send-comments');
      await expect(notice).toHaveText('Address 1 comment first');
      await expect(
        prompt.getByRole('group').getByRole('button').last(),
      ).toHaveAttribute('data-testid', 'chat-plan-send-comments');
      // A warning, not a gate.
      await expect(prompt.getByTestId('chat-plan-implement')).toBeEnabled();

      // The Plan panel's tray shows the same draft, labelled Not sent.
      await prompt.getByTestId('chat-plan-explore').click();
      const draft = window.locator('li').filter({ hasText: DRAFT });
      await expect(draft).toBeVisible({ timeout: 15_000 });
      await expect(draft).toContainText('Not sent');
      await expect(
        window.getByRole('button', { name: 'Submit 1 comment' }),
      ).toBeVisible();

      // Deleting the draft in the tray clears the warning in the composer.
      await draft.getByRole('button', { name: 'Delete comment' }).click();
      await expect(draft).toHaveCount(0);
      await expect(notice).toHaveCount(0);
      await expect(prompt.getByTestId('chat-plan-implement')).toBeEnabled();
      await window.getByTestId('plan-comment-add-note').click();
      await window.getByTestId('plan-comment-note-input').fill('Try again');
      await window.getByTestId('plan-comment-note-save').click();
      await expect(notice).toHaveText('Address 1 comment first');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('opening the waiting composer pulls newer teammate comments without opening the Plan panel', async () => {
    test.setTimeout(180_000);
    const apiKey = 'csk_can5164_composer_pull';
    const remoteId = '66666666-6666-4666-8666-000000005164';
    const planId = 'can5164-shared-plan';
    const plan = buildTrackedPlan({
      id: planId,
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      title: 'Shared waiting plan',
      content: PLAN_TEXT,
      share: teamShareState({ remoteId }),
    });
    await registerSharedPlanScenario(apiKey, {
      stream: 'disabled',
      plans: [sharedPlanServerSeed({ remoteId, plan, commentThreads: [] })],
    });
    let owner;
    try {
      owner = await launchSharedPlanOwner({
        apiKey,
        plans: [plan],
        beforeFirstLaunch: ({ userDataDir }) => {
          seedWorktreeChat({
            userDataDir,
            workspaceId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            providerType: 'claude',
            activeTabId: 'other',
            tabs: [
              { id: 'other', title: 'Other chat' },
              {
                id: 'waiting',
                title: 'Waiting chat',
                planMode: true,
                trackedPlanId: planId,
                pendingPlanExit: { plan: PLAN_TEXT },
              },
            ],
          });
        },
      });
      const { window, app } = owner;
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await waitForSharedPlanStartupSync(window, { apiKey, remoteId, planId });
      await window.getByTestId('panel-tab-panel-chat-waiting').click();
      const prompt = window.getByTestId('chat-plan-approval');
      await expect(prompt).toBeVisible();
      await prompt.getByTestId('chat-plan-approval-close').click();
      // No realtime signal: only opening the composer can fetch this comment.
      await addSharedPlanThread(
        apiKey,
        remoteId,
        buildPlanCommentThread({
          id: 'new-teammate-thread',
          anchor: generalAnchor(),
          comments: [
            remoteComment({
              id: 'new-teammate-note',
              body: 'Include a timeout',
              author: SHARED_PLAN_TEAMMATES.ada,
            }),
          ],
        }),
        { signal: false },
      );
      await window.getByTestId('chat-input-plan-ready-chip').click();
      await expect(prompt).toBeVisible();
      await expect(prompt.getByTestId('chat-plan-send-comments')).toHaveText(
        'Address 1 comment first',
        { timeout: 15_000 },
      );
      await expect(prompt.getByTestId('chat-plan-implement')).toBeEnabled();
      await expect(window.getByTestId('panel-content-plan')).toHaveCount(0);
    } finally {
      await closeSharedPlanOwner(owner, apiKey);
    }
  });

  for (const action of ['send', 'implement', 'overlap']) {
    test(`unsent comments: ${action} preserves the plan handoff and approval contract`, async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), `canopy-plan-${action}-`),
      );
      const planId = `can-5164-${action}`;
      const marker = `Canopy-CAN5164-${action}`;
      const note = `[${marker}] Cap retries at three attempts.`;
      const revised = '# Revised plan\n\nRetries are capped at three attempts.';
      // A seeded restored plan can be revised through the same real Claude
      // send path as typed feedback. Approval has its existing plain payload.
      const scenario = action === 'implement' ? 'Approved' : marker;
      await registerScenario(DEFAULT_MOCK_BASE_URL, scenario, {
        llm: {
          steps:
            action === 'implement'
              ? [{ text: 'Implementation accepted.', stopReason: 'end_turn' }]
              : [
                  {
                    toolCalls: [
                      {
                        name: 'Write',
                        id: 'toolu_revised_file',
                        writesPlanModePlanFile: true,
                        input: { content: revised },
                      },
                    ],
                    stopReason: 'tool_use',
                  },
                  {
                    // The send variant holds the revision mid-turn.
                    ...(action === 'send'
                      ? {
                          waitFor: REVISE_EXIT_BARRIER,
                          barrierTimeoutMs: 90_000,
                        }
                      : {}),
                    toolCalls: [
                      {
                        name: 'ExitPlanMode',
                        id: 'toolu_revised_exit',
                        input: {},
                      },
                    ],
                    stopReason: 'tool_use',
                  },
                ],
        },
      });
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedTrackedPlans({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        plans: [
          buildTrackedPlan({
            id: planId,
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            title: 'Proposed plan',
            content: PLAN_TEXT,
            commentThreads: [
              buildPlanCommentThread({
                id: 'feedback',
                anchor: generalAnchor(),
                comments: [
                  userComment({ id: 'draft', body: note, staged: true }),
                ],
              }),
            ],
          }),
        ],
      });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        tabs: [
          {
            id: 't1',
            title: 'Waiting chat',
            interfaceMode: 'canopy',
            planMode: true,
            trackedPlanId: planId,
            trackedPlanSource: 'claude',
            trackedPlanReviewStatus: 'pending',
            pendingPlanExitRequestId: 'can-5164-old-exit',
            pendingPlanExit: { plan: PLAN_TEXT },
          },
          { id: 't2', title: 'Other editable chat' },
        ],
      });
      const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir }),
      );
      let window;
      try {
        window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_BRANCH);
        const chat = window
          .getByTestId('panel-content-chat')
          .filter({ visible: true })
          .first();
        const prompt = chat.getByTestId('chat-plan-approval');
        await expect(prompt.getByTestId('chat-plan-send-comments')).toHaveText(
          'Address 1 comment first',
        );
        await prompt.getByTestId('chat-plan-explore').click();
        const tray = window.getByTestId('plan-explore-comments-tray');
        await expect(tray).toContainText(note);
        if (action === 'overlap') {
          await window.evaluate(() =>
            window.__canopyPanelTestApi.holdChatSends(),
          );
        }
        if (action === 'implement') {
          await prompt.getByTestId('chat-plan-implement').click();
          await expect(chat).toContainText('Approved', { timeout: 30_000 });
          await expect(tray).toContainText('Not sent');
          await expect(window.getByTestId('plan-comments-submit')).toHaveText(
            'Submit 1 comment',
          );
          await expect(chat).not.toContainText('I have 1 comment thread');
        } else {
          // Native keyboard activation never chooses numbered Implement.
          const send = prompt.getByTestId('chat-plan-send-comments');
          // Tab from the last numbered answer reaches the comments row.
          await prompt.getByRole('group').getByRole('button').nth(-2).focus();
          await window.keyboard.press('Tab');
          await expect(send).toBeFocused();
          await send.press(action === 'send' ? 'Space' : 'Enter');
          if (action === 'overlap') {
            await expect(send).toHaveText('Sending…');
            await expect(
              prompt.getByTestId('chat-plan-implement'),
            ).toBeEnabled();
            // Both controls stay nonblocking. Tray submit cannot duplicate
            // the shared in-flight snapshot; approval retains its own policy.
            await window.getByTestId('plan-comments-submit').click();
            await prompt.getByTestId('chat-plan-implement').click();
            await window.evaluate(() =>
              window.__canopyPanelTestApi.releaseHeldChatSends(),
            );
          }
          await expect(chat).toContainText(note, { timeout: 60_000 });
          await expect(tray.getByText('Not sent', { exact: true })).toHaveCount(
            0,
          );
          await expect(window.getByTestId('plan-comments-submit')).toHaveCount(
            0,
          );
          await expect(chat.getByTestId('chat-plan-send-comments')).toHaveCount(
            0,
          );
          if (action === 'send') {
            await expect(chat).not.toContainText('Approved');
            // CAN-5431: while the revision runs, the old request is retired.
            await expect
              .poll(() => reviseExitWaiting(marker), { timeout: 60_000 })
              .toBeGreaterThan(0);
            await expect(chat.getByTestId('chat-plan-approval')).toHaveCount(0);
            await expect(chat.getByTestId('chat-plan-implement')).toHaveCount(
              0,
            );
            const revising = await window.evaluate(
              (scope) => window.api.chat.loadTabs(scope),
              { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
            );
            const revisingTab = revising.tabs.find(
              (entry) => entry.id === 't1',
            );
            expect(revisingTab?.pendingPlanExit).toBeUndefined();
            expect(revisingTab?.pendingPlanExitRequestId).toBeUndefined();
            expect(revisingTab).toMatchObject({
              planMode: true,
              trackedPlanId: planId,
              trackedPlanReviewStatus: 'pending',
            });
            // The canonical state did not bring the old prompt back.
            await expect(chat.getByTestId('chat-plan-approval')).toHaveCount(0);
            const row = window.locator(
              `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
            );
            await expect(
              row.getByTestId('worktree-row-classic-streaming-spinner'),
            ).toBeVisible();
            const chatTab = window.getByTestId('panel-tab-panel-chat-t1');
            await expect(chatTab.getByLabel('Thinking')).toBeVisible();
            await expect(
              chatTab.getByLabel('Plan waiting for review'),
            ).toHaveCount(0);
            const execute = window
              .getByTestId('plan-panel-execute')
              .filter({ visible: true })
              .first();
            await execute.click();
            await expect(
              window.getByTestId('plan-panel-execute-implement'),
            ).toBeDisabled();
            await expect(
              window.getByTestId('plan-panel-execute-pipeline'),
            ).toBeDisabled();
            await window.keyboard.press('Escape');
            // The retired request has no keyboard answer left.
            const executionsBefore = await window.evaluate(() =>
              window.pipelines.listExecutions(),
            );
            await window.keyboard.press('1');
            await expect(chat).not.toContainText('Approved');
            await expect(
              window.getByTestId('pipeline-trigger-modal'),
            ).toHaveCount(0);
            expect(
              await window.evaluate(() => window.pipelines.listExecutions()),
            ).toEqual(executionsBefore);
            await releaseReviseExit(marker);
            await expect(chat).toContainText(
              'Retries are capped at three attempts.',
              { timeout: 60_000 },
            );
            await expect(prompt).toBeVisible({ timeout: 60_000 });
            await expect(prompt).toContainText('Implement the revised plan?');
            await expect(
              prompt.getByTestId('chat-plan-implement'),
            ).toBeEnabled();
            await expect(chat).not.toContainText('Approved');
            await expect
              .poll(async () => {
                const state = await window.evaluate(
                  (scope) => window.api.chat.loadTabs(scope),
                  { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
                );
                const tab = state.tabs.find((entry) => entry.id === 't1');
                const requestId = tab?.pendingPlanExitRequestId;
                return {
                  hasNewRequest:
                    typeof requestId === 'string' &&
                    requestId.length > 0 &&
                    requestId !== 'can-5164-old-exit',
                  planMode: tab?.planMode,
                };
              })
              .toEqual({
                hasNewRequest: true,
                planMode: true,
              });
          }
        }
        const saved = await window.evaluate(
          (scope) => window.api.activity.plans.get(scope),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, planId },
        );
        expect(saved?.commentThreads?.[0]?.comments[0]?.staged).toBe(
          action === 'implement',
        );
        const state = await window.evaluate(
          (scope) => window.api.chat.loadTabs(scope),
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
          },
        );
        const messages =
          state.tabs.find((tab) => tab.id === 't1')?.messages ?? [];
        const userTexts = messages
          .filter((message) => message.role === 'user')
          .flatMap((message) =>
            message.blocks
              .filter((block) => block.type === 'text')
              .map((block) => block.text),
          );
        expect(
          userTexts.filter((text) => text.includes('I have 1 comment thread')),
        ).toHaveLength(action === 'implement' ? 0 : 1);
        // Approval during feedback follows the existing queue policy: one
        // approval remains visible for the following turn, with no second
        // comment handoff. It must not vanish or silently implement feedback.
        if (action === 'overlap') {
          await expect(chat.getByTestId('queued-message-bubble')).toHaveCount(
            1,
          );
          await expect(chat.getByTestId('queued-message-bubble')).toContainText(
            'Approved',
          );
        } else {
          expect(userTexts.filter((text) => text === 'Approved')).toHaveLength(
            action === 'implement' ? 1 : 0,
          );
        }
        expect(state.tabs.find((tab) => tab.id === 't2')?.messages).toEqual([]);
      } finally {
        await window
          ?.evaluate(() => window.__canopyPanelTestApi.releaseHeldChatSends())
          .catch(() => undefined);
        await clearScenario(DEFAULT_MOCK_BASE_URL, scenario);
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }
});
