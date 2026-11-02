import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedObservabilityAudit } from './seeders/seedObservabilityAudit.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// Turn feedback is accessed through Clean chat's More menu. Cover rating,
// clearing, optional details, dismissal, read-only gating, and persistence.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'can-1521-feedback';

const AUDIT_ENTRY_ID = 'can-1521-audit-turn';

const T = Date.parse('2026-04-10T12:00:00.000Z');

/**
 * `user → assistant → system(turn_timer completed)` triple for one turn group.
 * See the seeding contract note in the header comment for the 120s / 10s
 * spacing and the "assistant text must differ from user text" rule.
 */
function buildTurnGroup(order) {
  const base = T + order * 120_000;
  return [
    {
      id: `turn-${order}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: `Request number ${order}.` }],
      timestamp: base,
    },
    {
      id: `turn-${order}-assistant`,
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: `Completed the work for step ${order}.${order === 2 ? '\n\n[Footer reference](https://example.test/reference)' : ''}`,
        },
      ],
      timestamp: base + 10_000,
    },
    {
      id: `turn-${order}-timer`,
      role: 'system',
      blocks: [
        { type: 'turn_timer', startedAt: base, completedAt: base + 30_000 },
      ],
      timestamp: base + 20_000,
    },
  ];
}

function seedFeedbackChat(userDataDir) {
  return seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'Turn Feedback',
        providerType: 'codex',
        model: 'gpt-6-sol',
        sharedRun: {
          externalId: '11111111-1111-4111-8111-111111111111',
          shareScope: 'team',
          sharedAt: '2026-04-10T12:00:00.000Z',
          commentRevision: 1,
          unreadCommentCount: 2,
        },
        messages: [
          ...buildTurnGroup(1),
          ...buildTurnGroup(2),
          ...buildTurnGroup(3),
        ],
      },
    ],
  });
}

/** Zeroed `AgentAuditToolCounts` (every field is required on the entry). */
function zeroToolCounts() {
  return {
    thinking: 0,
    bash: 0,
    read: 0,
    readLines: 0,
    writeEdit: 0,
    plan: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    workflow: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    claude: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    graph: 0,
    appAdvisor: 0,
    pipelineEditor: 0,
    mcp: 0,
    other: 0,
  };
}

/**
 * One audit entry with a transcript sidecar, so the Audit Trail transcript
 * modal (the read-only `TranscriptViewer` host) is reachable. The `success`
 * status makes the modal pass `closeOpenTurnAtEnd`, so the parsed transcript's
 * open turn timer is completed and the turn group renders as COMPLETE.
 */
function seedAuditTranscript(userDataDir) {
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const completedAt = new Date(Date.now() - 9 * 60_000).toISOString();
  return seedObservabilityAudit({
    userDataDir,
    entries: [
      {
        id: AUDIT_ENTRY_ID,
        eventType: 'worktree_chat',
        status: 'success',
        provider: 'codex',
        label: 'CAN-1521 Read-only Transcript',
        startedAt,
        completedAt,
        durationMs: 12_000,
        model: 'gpt-6-sol',
        totalCostUsd: 0.0042,
        tokens: {
          input: 1200,
          output: 345,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        messageCount: 2,
        assistantMessageCount: 1,
        toolUseCount: 0,
        subAgentCount: 0,
        toolCounts: zeroToolCounts(),
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: TAB_ID,
        hasTranscript: true,
      },
    ],
    transcripts: {
      [AUDIT_ENTRY_ID]: [
        {
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'read-only transcript user prompt',
          submitted_text: 'read-only transcript user prompt',
          plan_mode: false,
        },
        // A real Codex `item.completed` / `agent_message` event — the shape the
        // transcript parser actually reduces into an assistant text block.
        // (`response_item` lines, as used by `observability.spec.mjs`, are
        // skipped by the parser and only ever show up in the RAW view.)
        {
          type: 'item.completed',
          thread_id: 'can-1521-thread',
          turn_id: 'can-1521-turn',
          item: {
            id: 'can-1521-agent-message',
            type: 'agent_message',
            text: 'read-only transcript assistant output',
          },
        },
      ],
    },
  });
}

/** Per-turn wrapper (`data-chat-turn-group` in `ChatMessageList.tsx`). */
function turnScope(window, order) {
  return window.locator(`[data-chat-turn-group="turn-${order}-user"]`);
}

async function openFeedbackMenu(window, order) {
  const more = turnScope(window, order).getByTestId('turn-more-actions');
  await more.click();
  await expect(window.getByTestId('turn-feedback-up')).toBeVisible();
  return more;
}

async function expectRating(window, order, rating) {
  const more = await openFeedbackMenu(window, order);
  for (const value of ['up', 'down']) {
    await expect(window.getByTestId(`turn-feedback-${value}`)).toHaveAttribute(
      'aria-checked',
      String(rating === value),
    );
  }
  await window.keyboard.press('Escape');
  await expect(more).toBeFocused();
}

async function rate(window, order, rating) {
  await openFeedbackMenu(window, order);
  await window.getByTestId(`turn-feedback-${rating}`).click();
}

async function openWorktreeChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(window.getByTestId('panel-content-chat')).toBeVisible();
  await expect(window.getByTestId('turn-more-actions')).toHaveCount(3, {
    timeout: 20_000,
  });
  return { window, app };
}

test('records, clears, details, pins, and persists turn-level feedback', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-can-1521-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedFeedbackChat(userDataDir);
  seedAuditTranscript(userDataDir);
  const first = await launchCanopy({ userDataDir });
  try {
    const { window, app } = await openWorktreeChat(first.electronApp);
    for (const order of [1, 2, 3]) await expectRating(window, order, null);

    // Clean chat keeps More visible. Its menu takes keyboard focus and Escape
    // returns focus without shifting the footer or the next turn.
    const middle = turnScope(window, 2);
    const more = middle.getByTestId('turn-more-actions');
    const before = await middle.getByTestId('turn-timer').boundingBox();
    await more.focus();
    await more.press('Enter');
    const up = window.getByTestId('turn-feedback-up');
    await expect(up).toHaveAccessibleName('Good response');
    await up.focus();
    await up.press('Enter');
    await expectRating(window, 2, 'up');
    expect(await middle.getByTestId('turn-timer').boundingBox()).toEqual(
      before,
    );
    await rate(window, 2, 'up');
    await expectRating(window, 2, null);

    // Shared turns keep Comments in the same menu and restore a usable footer.
    await openFeedbackMenu(window, 3);
    await window.getByTestId('turn-more-share-comments').click();
    const comments = window.getByTestId('run-comments-modal');
    await expect(comments).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(comments).toHaveCount(0);
    await expect(
      turnScope(window, 3).getByTestId('turn-more-actions'),
    ).toBeVisible();

    await rate(window, 1, 'up');
    await expect(window.getByTestId('turn-feedback-dialog')).toHaveCount(0);
    await expectRating(window, 1, 'up');
    await rate(window, 1, 'up');
    await expectRating(window, 1, null);

    // Skip keeps the rating; selecting the same item clears it.
    await rate(window, 2, 'down');
    const dialog = window.getByTestId('turn-feedback-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('turn-feedback-skip').click();
    await expect(dialog).toHaveCount(0);
    await expectRating(window, 2, 'down');
    await rate(window, 2, 'down');
    await expectRating(window, 2, null);

    await rate(window, 2, 'down');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByTestId('turn-feedback-open-app-feedback'),
    ).toBeVisible();
    const reason = dialog.getByTestId('turn-feedback-reason-got-stuck');
    await expect(reason).toHaveAttribute('aria-pressed', 'false');
    await reason.click();
    await expect(reason).toHaveAttribute('aria-pressed', 'true');
    const comment = dialog.getByTestId('turn-feedback-comment');
    await comment.fill('It looped over the same file three times.');
    await expect(comment).toHaveValue(
      'It looped over the same file three times.',
    );
    await dialog.getByTestId('turn-feedback-submit').click();
    await expect(dialog).toHaveCount(0);
    await expectRating(window, 2, 'down');

    await rate(window, 3, 'down');
    await expect(dialog).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expectRating(window, 3, 'down');

    // A completed read-only audit transcript must not offer ratings.
    await app.openAuditPage();
    await window
      .getByTestId(`audit-transcript-button-${AUDIT_ENTRY_ID}`)
      .click();
    const modal = window.getByTestId('audit-transcript-modal');
    await expect(modal).toBeVisible();
    const transcript = modal.getByTestId('audit-transcript-rich');
    await expect(
      transcript.getByText('read-only transcript assistant output'),
    ).toBeVisible();
    await expect(
      transcript.locator('[data-testid="turn-timer"][data-state="completed"]'),
    ).not.toHaveCount(0);
    await expect(modal.getByTestId('turn-feedback-up')).toHaveCount(0);
    await expect(modal.getByTestId('turn-feedback-down')).toHaveCount(0);
    await expect(modal.getByTestId('turn-more-actions')).toHaveCount(0);
    await window.screenshot({
      path: testInfo.outputPath('can-1521-turn-feedback.png'),
    });
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  const second = await launchCanopy({ userDataDir });
  try {
    const { window } = await openWorktreeChat(second.electronApp);
    await expectRating(window, 3, 'down');
    await expectRating(window, 2, 'down');
    // Clearing must persist too; a fetched rating must not resurrect it.
    await expectRating(window, 1, null);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});
