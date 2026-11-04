import { expandTurnSteps } from './turnSteps.mjs';
// CAN-4897: actual restart settlement, Home resume, durable provenance and a
// second relaunch. Only the harness's deterministic mock provider executes.
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  captureDaemonDryRunEvidence,
  closeCanopy,
  launchCanopy,
} from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/registerScenario.mjs';
import { seedUsageLimitedChats } from './seeders/seedUsageLimitedChats.mjs';
import {
  seedInterruptedTurnResume,
  seedCanonicalInterruptedTurnResume,
  interruptedResumeScope,
  interruptedActivityAt,
} from './seeders/seedInterruptedTurnResume.mjs';

const transcript = (window) =>
  window.evaluate(
    (scope) => window.api.chat.getTranscriptPage(scope),
    interruptedResumeScope,
  );

test('background child output remains attached after the next user turn', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can-4897-background-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: interruptedResumeScope.projectId,
    worktreeId: interruptedResumeScope.worktreeId,
    activeTabId: interruptedResumeScope.chatId,
    tabs: [
      {
        id: interruptedResumeScope.chatId,
        title: 'Background transcript',
        messages: [
          {
            id: 'background-user',
            role: 'user',
            timestamp: interruptedActivityAt,
            blocks: [{ type: 'text', text: 'Start background review' }],
          },
          {
            id: 'background-parent',
            role: 'assistant',
            timestamp: interruptedActivityAt + 1,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'background-review',
                toolName: 'Agent',
                input: JSON.stringify({
                  description: 'Background review',
                  run_in_background: true,
                }),
              },
              {
                type: 'tool_result',
                toolUseId: 'background-review',
                toolName: 'Agent',
                output: 'Async agent launched successfully. agentId: abc123',
                isError: false,
              },
            ],
          },
          {
            id: 'early-child',
            role: 'assistant',
            parentToolUseId: 'background-review',
            timestamp: interruptedActivityAt + 2,
            blocks: [{ type: 'text', text: 'Early background progress' }],
          },
          {
            id: 'next-user',
            role: 'user',
            timestamp: interruptedActivityAt + 3,
            blocks: [{ type: 'text', text: 'Continue with another task' }],
          },
          {
            id: 'next-reply',
            role: 'assistant',
            timestamp: interruptedActivityAt + 4,
            blocks: [
              { type: 'text', text: 'Another task completed' },
              {
                type: 'tool_use',
                toolUseId: 'retrieve-background',
                toolName: 'TaskOutput',
                input: '{"task_id":"abc123"}',
              },
              {
                type: 'tool_result',
                toolUseId: 'retrieve-background',
                toolName: 'TaskOutput',
                output: 'Background task failed after retrieval',
                isError: true,
              },
            ],
          },
          {
            id: 'late-child',
            role: 'assistant',
            parentToolUseId: 'background-review',
            timestamp: interruptedActivityAt + 5,
            blocks: [{ type: 'text', text: 'Late background answer' }],
          },
        ],
      },
    ],
  });
  const launched = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await launched.electronApp.firstWindow();
    await openChat(window);
    await expandTurnSteps(window);
    const agent = window.getByTestId('agent-block');
    await expect(agent).toBeVisible();
    const agentToggle = agent.locator('button[aria-expanded]').first();
    if ((await agentToggle.getAttribute('aria-expanded')) === 'false')
      await agentToggle.click();
    await expect(
      agent.getByText('Early background progress', { exact: true }),
    ).toBeVisible();
    await expect(
      agent.getByText('Late background answer', { exact: true }),
    ).toBeVisible();
    await expect(
      window.getByText('Another task completed', { exact: true }),
    ).toBeVisible();
    await agent
      .getByRole('button', { name: 'Show result', exact: true })
      .click();
    await expect(
      agent.getByText('Background task failed after retrieval', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(agent.locator('button[aria-expanded]').first()).toContainText(
      'Failed',
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

async function openChat(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  // Individual-step assertions use the Detailed preference.
  await window.evaluate(() =>
    window.api.savePreferences({ chatDetail: 'detailed' }),
  );
  await app.openMainPage();
  await app.selectWorktree(interruptedResumeScope.worktreeId);
  const tab = window.getByTestId(
    `panel-tab-panel-chat-${interruptedResumeScope.chatId}`,
  );
  await expect(tab).toBeVisible();
  await tab.click();
}

test('a live tool-free turn preserves recorded cancellation after a graceful quit and two reopens', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can-5178-clean-quit-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: interruptedResumeScope.projectId,
    worktreeId: interruptedResumeScope.worktreeId,
    activeTabId: interruptedResumeScope.chatId,
    providerType: 'claude',
    tabs: [
      {
        id: interruptedResumeScope.chatId,
        title: 'Clean shutdown',
        model: 'sonnet',
        messages: [],
      },
    ],
  });
  const marker = 'Canopy-CAN5178-CleanQuit';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          text: 'A turn that is still writing. '.repeat(200),
          streamMs: 60_000,
          stopReason: 'end_turn',
        },
      ],
    },
  });
  let launched = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    let window = await launched.electronApp.firstWindow();
    await openChat(window);
    const composer = window.getByRole('textbox').last();
    await composer.fill(`[${marker}] Keep writing until I quit.`);
    await composer.press('Enter');
    await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () => {
        const response = await fetch(
          `${DEFAULT_MOCK_BASE_URL}/__mock/requests?key=${encodeURIComponent(marker)}`,
        );
        const observed = await response.json();
        return observed.requests.some(
          (request) => request.route === '/v1/messages',
        );
      })
      .toBe(true);
    const before = await transcript(window);
    const userMessageId = before.messages.find(
      (message) => message.role === 'user',
    )?.id;
    expect(userMessageId).toBeTruthy();
    // Wait for the normal app.quit lifecycle itself, without the harness's
    // forced-close fallback, before cleaning up the already exited launch.
    await captureDaemonDryRunEvidence(launched.electronApp);
    const appProcess = launched.electronApp.process();
    const exited = launched.electronApp.waitForEvent('close', {
      timeout: 30_000,
    });
    await launched.electronApp
      .evaluate(({ app }) => app.quit())
      .catch((error) => {
        if (!/closed|destroyed/i.test(String(error))) throw error;
      });
    await exited;
    await expect.poll(() => appProcess.exitCode).toBe(0);
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = null;
    for (let reopen = 0; reopen < 2; reopen += 1) {
      launched = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir }),
      );
      window = await launched.electronApp.firstWindow();
      await openChat(window);
      const tabs = await window.evaluate(
        (scope) => window.api.chat.loadTabs(scope),
        interruptedResumeScope,
      );
      const tab = tabs.tabs.find(
        (entry) => entry.id === interruptedResumeScope.chatId,
      );
      // The provider's drained cancellation is an explicit end and wins over
      // any restart evidence, per the shared completion contract.
      expect(tab?.turnEnds?.[userMessageId]?.outcome).toBe('cancelled');
      const turn = window.locator(`[data-chat-turn-group="${userMessageId}"]`);
      await expect(turn.getByTestId('turn-timer-label')).toHaveText(
        /^Cancelled after \d+:\d{2}$/,
      );
      await expect(turn.getByTestId('turn-outcome-control')).toHaveCount(0);
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: reopen === 0,
      });
      launched = null;
    }
  } finally {
    if (launched) await closeCanopy(launched.electronApp, userDataDir);
  }
});

async function assertInterruptedOutcome(window) {
  const turn = window.locator('[data-chat-turn-group="original"]');
  const outcome = turn.getByTestId('turn-outcome-control');
  await expect(outcome).toHaveText('1 interrupted');
  await expect(outcome).toHaveAttribute('data-turn-interrupted', '1');
  await expect(outcome).not.toHaveAttribute('data-turn-failed', /.+/);
  await expect(
    outcome.locator('[data-turn-outcome="interrupted"]'),
  ).toHaveClass(/fg-secondary/);
  await expect(turn.locator('[aria-label^="Agent steps"]')).toHaveAttribute(
    'aria-label',
    /1 interrupted/,
  );
  await expect(turn.getByTestId('turn-timer-label')).toHaveText(
    'Interrupted after 0:12',
  );
  await outcome.hover();
  await expect(
    window.getByTestId('turn-outcome-tooltip-surface'),
  ).toContainText('Interrupted when');
  await outcome.click();
  await expect(turn.locator('[data-tool-name="Edit"]')).toHaveAttribute(
    'data-tool-status',
    'interrupted',
  );
  await expect(turn.locator('[data-tool-name="Read"]')).toHaveAttribute(
    'data-tool-status',
    'success',
  );
}

async function assertHistory(window, originals) {
  const { messages } = await transcript(window);
  for (const original of originals) {
    const stored = messages.find((message) => message.id === original.id);
    expect(stored?.timestamp).toBe(original.timestamp);
  }
  expect(messages.find((m) => m.id === 'old-timer')?.blocks).toContainEqual(
    expect.objectContaining({ completedAt: interruptedActivityAt }),
  );
  const results = messages
    .flatMap((m) => m.blocks)
    .filter((b) => b.type === 'tool_result');
  expect(results.filter((b) => b.toolUseId === 'edit')).toEqual([
    expect.objectContaining({
      isError: true,
      interruption: { reason: 'app_restart', at: interruptedActivityAt },
    }),
  ]);
  expect(results.find((b) => b.toolUseId === 'read')).toMatchObject({
    isError: false,
  });
  return messages;
}

test('Home resume preserves the interrupted transcript through a second relaunch', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can-4897-transcript-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const originals = seedInterruptedTurnResume(userDataDir);
  let launched = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    let window = await launched.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await openChat(window);
    await assertInterruptedOutcome(window);
    await window.getByTestId('sidebar-create-task').click();
    await window.getByTestId('home-interrupted-sessions-resume').click();
    const modal = window.getByTestId('usage-limit-resume-modal');
    await expect(
      modal.getByTestId(
        `usage-limit-resume-chat-${interruptedResumeScope.chatId}`,
      ),
    ).toBeChecked();
    await modal.getByTestId('usage-limit-resume-confirm').click();
    await expect(modal).toBeHidden();
    await openChat(window);
    const marker = window.getByTestId('auto-resume-marker');
    await expect(marker).toHaveCount(1);
    await expect(marker).toContainText('closed · resumed');
    await expect(marker).toContainText('Sent automatically: Continue');
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0, {
      timeout: 90_000,
    });
    await expect
      .poll(async () =>
        (await transcript(window)).messages.some(
          (m) =>
            m.role === 'assistant' &&
            m.timestamp > interruptedActivityAt &&
            m.blocks.some((b) => b.type === 'text'),
        ),
      )
      .toBe(true);
    await assertInterruptedOutcome(window);
    await expandTurnSteps(window);
    await expect(window.locator('[data-tool-name="Edit"]')).toHaveAttribute(
      'data-tool-status',
      'interrupted',
    );
    await expect(window.locator('[data-tool-name="Read"]')).toHaveAttribute(
      'data-tool-status',
      'success',
    );
    await expect(window.getByText(/Chat initiated by automation/)).toHaveCount(
      0,
    );
    const messages = await assertHistory(window, originals);
    const resume = messages.find((m) => m.userMessageSource === 'auto_resume');
    expect(resume).toMatchObject({
      autoResume: {
        reason: 'app_shutdown',
        resumesUserMessageId: 'original',
        resendsUserMessage: false,
      },
    });
    expect(resume).not.toHaveProperty('inputMode');
    expect(
      messages.filter(
        (m) =>
          m.role === 'user' &&
          m.blocks.some((b) => b.type === 'text' && b.text === 'Continue'),
      ),
    ).toHaveLength(1);
    const formatted = await window.evaluate(
      (at) =>
        new Intl.DateTimeFormat(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(at),
      resume.timestamp,
    );
    await expect(marker).toContainText(formatted);
    // Freeze only the renderer's wall clock after dispatch has completed. The
    // persisted reply still comes from the real main-owned provider lifecycle.
    await window.clock.setFixedTime(new Date(resume.timestamp + 300_000));
    // The seeded turn is two to three calendar days back from the frozen
    // clock, which the completion stamp names by weekday.
    const historicalStamp = await window.evaluate(
      (at) =>
        `${new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(at)}, ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)}`,
      interruptedActivityAt,
    );
    const oldTurn = window.locator('[data-chat-turn-group="original"]');
    await expect(oldTurn.getByTestId('turn-timer-relative')).toHaveText(
      historicalStamp,
    );
    await expect(oldTurn.getByTestId('turn-timer-label')).toHaveText(
      'Interrupted after 0:12',
    );
    const resumedTurn = window.locator(`[data-chat-turn-group="${resume.id}"]`);
    const replyCompletion = messages
      .flatMap((message) => message.blocks)
      .find(
        (block) =>
          block.type === 'turn_timer' &&
          block.startedAt > interruptedActivityAt,
      )?.completedAt;
    expect(replyCompletion).toBeGreaterThan(resume.timestamp);
    const replyTitle = await window.evaluate(
      (at) =>
        new Intl.DateTimeFormat(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(at),
      replyCompletion,
    );
    await expect(resumedTurn.getByTestId('turn-timer')).toHaveAttribute(
      'data-state',
      'completed',
    );
    await expect(resumedTurn).not.toContainText(
      /Interrupted after|Failed after|Stopped after/,
    );
    // Clean chat puts the exact completion time in the shared hover tooltip.
    await resumedTurn.getByTestId('turn-timer-relative').hover();
    await expect(window.getByRole('tooltip')).toContainText(replyTitle);
    await window.mouse.move(0, 0);
    await window.getByTestId('auto-resume-copy').click();
    await expect(window.getByTestId('auto-resume-copy')).toHaveAttribute(
      'aria-label',
      'Copied',
    );
    await expect
      .poll(() =>
        launched.electronApp.evaluate(({ clipboard }) => clipboard.readText()),
      )
      .toBe('Continue');
    const id = resume.id;
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = null;
    launched = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    window = await launched.electronApp.firstWindow();
    await openChat(window);
    await expect(window.getByTestId('auto-resume-marker')).toHaveCount(1);
    await assertInterruptedOutcome(window);
    const reopened = await assertHistory(window, originals);
    expect(
      reopened.filter((m) => m.userMessageSource === 'auto_resume'),
    ).toEqual([resume]);
    expect(reopened.find((m) => m.id === id)?.timestamp).toBe(resume.timestamp);

    // The marker occupies the original user-row navigation slot. Exercise
    // the real scroll handler in a small viewport, including its normal clamp
    // when this last turn has too little content to reach the panel's top.
    await window.setViewportSize({ width: 1280, height: 450 });
    const reopenedMarker = window.getByTestId('auto-resume-marker');
    await reopenedMarker.scrollIntoViewIfNeeded();
    const scroller = window.getByTestId('chat-message-list-scroll');
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await reopenedMarker.getByTestId('auto-resume-marker-headline').click();
    await expect
      .poll(() =>
        scroller.evaluate((element, messageId) => {
          const section = [
            ...element.querySelectorAll('[data-chat-sticky-section]'),
          ].find((row) => row.dataset.chatStickySection === messageId);
          if (!section) return Infinity;
          const topGap =
            section.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            (Number.parseFloat(getComputedStyle(element).paddingTop) || 0);
          const bottomGap =
            element.scrollHeight - element.clientHeight - element.scrollTop;
          return Math.min(Math.abs(topGap), Math.abs(bottomGap));
        }, id),
      )
      .toBeLessThan(2);
    await expect(reopenedMarker).toBeVisible();
    await window.setViewportSize({ width: 1280, height: 900 });
    await window.getByTestId('fork-chat-button').last().click();
    await expect(
      window.locator('[role="tab"][data-panel-kind="chat"]'),
    ).toHaveCount(2);
    await expect
      .poll(() =>
        window.evaluate(async ({ projectId, worktreeId, chatId }) => {
          const loaded = await window.api.chat.loadTabs({
            projectId,
            worktreeId,
          });
          return loaded.tabs.find((tab) => tab.id !== chatId)?.forkedFrom
            ?.chatId;
        }, interruptedResumeScope),
      )
      .toBe(interruptedResumeScope.chatId);
    await expect(window.getByTestId('auto-resume-marker')).toHaveCount(1);
  } finally {
    if (launched) await closeCanopy(launched.electronApp, userDataDir);
  }
});

for (const denied of [false, true]) {
  test(`${denied ? 'late denied' : 'settled resultless'} Agent and Workflow steps keep exclusive clean-run counts`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can-5178-resultless-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: interruptedResumeScope.projectId,
      worktreeId: interruptedResumeScope.worktreeId,
      activeTabId: interruptedResumeScope.chatId,
      tabs: [
        {
          id: interruptedResumeScope.chatId,
          title: 'Interrupted helpers',
          messages: [
            {
              id: 'resultless-user',
              role: 'user',
              timestamp: interruptedActivityAt - 1000,
              blocks: [{ type: 'text', text: 'Inspect the changes' }],
            },
            {
              id: 'resultless-helpers',
              role: 'assistant',
              timestamp: interruptedActivityAt,
              blocks: ['Agent', 'Workflow'].map((toolName) => ({
                type: 'tool_use',
                toolName,
                toolUseId: `resultless-${toolName}`,
                input: JSON.stringify({ description: 'Inspect the changes' }),
              })),
            },
            ...(denied
              ? [
                  {
                    id: 'interrupted-results',
                    role: 'system',
                    timestamp: interruptedActivityAt,
                    blocks: ['Agent', 'Workflow'].map((toolName) => ({
                      type: 'tool_result',
                      toolName,
                      toolUseId: `resultless-${toolName}`,
                      output: 'Interrupted by restart',
                      isError: true,
                      interruption: {
                        reason: 'app_restart',
                        at: interruptedActivityAt,
                      },
                    })),
                  },
                ]
              : []),
            {
              id: 'resultless-timer',
              role: 'system',
              timestamp: interruptedActivityAt,
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: interruptedActivityAt - 1000,
                  completedAt: interruptedActivityAt,
                },
              ],
            },
            ...(denied
              ? [
                  {
                    id: 'later-user',
                    role: 'user',
                    timestamp: interruptedActivityAt + 1,
                    blocks: [{ type: 'text', text: 'Next task' }],
                  },
                  {
                    id: 'late-receipts',
                    role: 'system',
                    timestamp: interruptedActivityAt + 2,
                    blocks: ['Agent', 'Workflow'].map((toolName) => ({
                      type: 'approval_safety_denied_info',
                      receiptId: `late-${toolName}`,
                      toolUseId: `resultless-${toolName}`,
                      turnUserMessageId: 'resultless-user',
                      timestamp: interruptedActivityAt + 2,
                      reason: 'force-push',
                      command: 'git push --force',
                      mode: 'ask',
                    })),
                  },
                ]
              : []),
          ],
        },
      ],
    });
    const launched = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await launched.electronApp.firstWindow();
      await openChat(window);
      await window.evaluate(() =>
        window.api.savePreferences({ chatDetail: 'compact' }),
      );
      await window.getByRole('button', { name: /^Agent steps:/ }).click();
      const run = window.getByTestId('chat-tool-step-group');
      await expect(
        run.getByTestId(
          denied ? 'chat-tool-step-blocked' : 'chat-tool-step-interrupted',
        ),
      ).toHaveText(denied ? '· 2 blocked' : '· 2 interrupted');
      if (denied)
        await expect(run.getByTestId('chat-tool-step-interrupted')).toHaveCount(
          0,
        );
      await expect(run.getByTestId('chat-tool-step-failed')).toHaveCount(0);
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
}

for (const paged of [false, true]) {
  test(`${paged ? 'paged' : 'loaded'} interrupted Read/Edit turn keeps exclusive neutral outcomes and navigation`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can-5178-outcome-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const originals = seedInterruptedTurnResume(userDataDir);
    const rows = originals
      .filter((row) => !row.parentToolUseId)
      .map((row) => ({
        ...row,
        blocks: row.blocks.filter(
          (block) => block.toolUseId !== 'background-agent',
        ),
      }));
    if (paged)
      rows.splice(
        3,
        0,
        ...Array.from({ length: 1100 }, (_, i) => ({
          id: `read-${i}`,
          role: 'assistant',
          timestamp: rows[0].timestamp + 2000 + i,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: `history-${i}`,
              toolName: 'Read',
              input: '{}',
            },
            {
              type: 'tool_result',
              toolUseId: `history-${i}`,
              toolName: 'Read',
              output: 'ok',
              isError: false,
            },
          ],
        })),
      );
    seedWorktreeChat({
      userDataDir,
      workspaceId: interruptedResumeScope.projectId,
      worktreeId: interruptedResumeScope.worktreeId,
      activeTabId: interruptedResumeScope.chatId,
      tabs: [
        {
          id: interruptedResumeScope.chatId,
          title: 'Interrupted outcomes',
          model: 'sonnet',
          messages: rows,
        },
      ],
    });
    const launched = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await launched.electronApp.firstWindow();
      await openChat(window);
      const turn = window.locator('[data-chat-turn-group="original"]');
      const control = turn.getByTestId('turn-outcome-control');
      await expect(control).toHaveText('1 interrupted');
      await expect(control).not.toHaveAttribute('data-turn-failed', /.+/);
      await expect(turn.locator('[data-turn-step-count]')).toHaveAttribute(
        'data-turn-step-count',
        String(paged ? 1102 : 2),
      );
      await control.hover();
      const tooltip = window.getByTestId('turn-outcome-tooltip-surface');
      await expect(tooltip).toContainText(
        paged ? '1 step was interrupted' : 'Interrupted when',
      );
      await control.click();
      const edit = turn.locator('[data-tool-name="Edit"]');
      await expect(edit).toHaveAttribute('data-tool-status', 'interrupted');
      await expect(edit).toHaveAttribute('data-chat-call-focus', 'true');
      await expect(edit).toBeInViewport();
      await expect(turn.locator('[data-tool-use-id="read"]')).toHaveAttribute(
        'data-tool-status',
        'success',
      );
      await expect(turn.getByTestId('turn-timer-label')).toHaveText(
        'Interrupted after 0:12',
      );
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
}

// CAN-5177: enter through the product's real navigation, then use its inline
// action. Keep these in the existing transcript suite and CI shard.
async function launchInlineResumeFixture({ unanswered = false } = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-5177-inline-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const other = { ...interruptedResumeScope, chatId: 'other-interrupted' };
  await seedCanonicalInterruptedTurnResume(userDataDir, {
    unanswered,
    additionalTabs: [
      {
        id: other.chatId,
        title: 'Other interruption',
        interruptedTurns: { 'other-original': {} },
        messages: [
          {
            id: 'other-original',
            role: 'user',
            timestamp: interruptedActivityAt,
            blocks: [{ type: 'text', text: 'Other work' }],
          },
        ],
      },
    ],
  });
  const registryPath = path.join(userDataDir, 'usage-limited-chats.json');
  const launched = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  return { ...launched, userDataDir, other, registryPath };
}

async function enterInterruptedChat(window, route) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  if (route === 'Home') {
    await window.getByTestId('sidebar-create-task').click();
    await window.getByTestId('home-interrupted-sessions-open').click();
  } else if (route === 'palette') {
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
    );
    const palette = window.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    await window
      .getByTestId('command-palette-input')
      .fill('Interrupted transcript');
    await palette
      .getByTestId('command-palette-result')
      .filter({ hasText: 'Interrupted transcript' })
      .first()
      .click();
  } else {
    await app.openMainPage();
    await app.selectWorktree(interruptedResumeScope.worktreeId);
    if (route === 'tab') {
      await window
        .getByTestId(`panel-tab-panel-chat-${interruptedResumeScope.chatId}`)
        .click();
    }
  }
  await expect(window.getByTestId('interrupted-turn-resume')).toBeVisible();
}

for (const route of ['Home', 'sidebar', 'palette', 'tab']) {
  test(`CAN-5177 ${route} opens the same interrupted-turn offer`, async () => {
    test.setTimeout(180_000);
    const fixture = await launchInlineResumeFixture();
    try {
      const window = await fixture.electronApp.firstWindow();
      await enterInterruptedChat(window, route);
      const notice = window.getByTestId('interrupted-turn-resume');
      await expect(notice).toContainText(
        'Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again.',
      );
      await expect(window.getByTestId('usage-limit-resume-modal')).toHaveCount(
        0,
      );
      if (route !== 'Home') return;
      const registry = JSON.parse(readFileSync(fixture.registryPath, 'utf8'));
      seedUsageLimitedChats({
        userDataDir: fixture.userDataDir,
        entries: [
          ...registry.entries,
          {
            ...fixture.other,
            provider: 'claude',
            resumeReason: 'app_shutdown',
            interruptedUserMessageId: 'other-original',
            detectedAt: Date.now() - 1000,
            workspaceName: 'TypeScript pnpm Vite',
            chatTitle: 'Other interruption',
          },
        ],
      });
      await expandTurnSteps(window);
      await expect(window.locator('[data-tool-name="Edit"]')).toHaveAttribute(
        'data-tool-status',
        'interrupted',
      );
      // Keyboard activation uses the same action as a pointer press.
      await window.getByTestId('interrupted-turn-resume-button').focus();
      await window.keyboard.press('Enter');
      await expect(window.getByTestId('auto-resume-marker')).toHaveCount(1);
      await expect(notice).toHaveCount(0);
      const stored = (await transcript(window)).messages;
      expect(
        stored.filter((m) => m.userMessageSource === 'auto_resume'),
      ).toEqual([
        expect.objectContaining({
          autoResume: expect.objectContaining({
            reason: 'app_shutdown',
            resumesUserMessageId: 'original',
            resendsUserMessage: false,
          }),
        }),
      ]);
      await expect
        .poll(() =>
          JSON.parse(readFileSync(fixture.registryPath, 'utf8')).entries.map(
            (e) => e.chatId,
          ),
        )
        .toEqual([fixture.other.chatId]);
      await window.getByTestId('sidebar-create-task').click();
      await expect(
        window.getByTestId('home-interrupted-sessions-banner'),
      ).toContainText('Other interruption');
      await expect(
        window.getByTestId('home-interrupted-sessions-banner'),
      ).not.toContainText('Interrupted transcript');
    } finally {
      await closeCanopy(fixture.electronApp, fixture.userDataDir);
    }
  });
}

test('CAN-5177 dismissal survives navigation but renderer and app restarts offer Resume again', async () => {
  test.setTimeout(180_000);
  const fixture = await launchInlineResumeFixture();
  let electronApp = fixture.electronApp;
  try {
    let window = await electronApp.firstWindow();
    await enterInterruptedChat(window, 'tab');
    const before = JSON.parse(readFileSync(fixture.registryPath, 'utf8'));
    await window.getByTestId('interrupted-turn-resume-dismiss').click();
    await expect(window.getByTestId('interrupted-turn-resume')).toHaveCount(0);
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-interrupted-sessions-banner'),
    ).toContainText('Interrupted transcript');
    await openChat(window);
    await expect(window.getByTestId('interrupted-turn-resume')).toHaveCount(0);
    expect(JSON.parse(readFileSync(fixture.registryPath, 'utf8'))).toEqual(
      before,
    );
    await window.reload();
    await enterInterruptedChat(window, 'tab');
    expect(JSON.parse(readFileSync(fixture.registryPath, 'utf8'))).toEqual(
      before,
    );
    await window.getByTestId('interrupted-turn-resume-dismiss').click();
    await closeCanopy(electronApp, fixture.userDataDir, { keepUserData: true });
    electronApp = null;
    const relaunched = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir: fixture.userDataDir }),
    );
    electronApp = relaunched.electronApp;
    window = await electronApp.firstWindow();
    await enterInterruptedChat(window, 'tab');
    expect(JSON.parse(readFileSync(fixture.registryPath, 'utf8'))).toEqual(
      before,
    );
  } finally {
    if (electronApp) await closeCanopy(electronApp, fixture.userDataDir);
  }
});

test('CAN-5177 ordinary messaging retires the interrupted offer through reload', async () => {
  test.setTimeout(180_000);
  const fixture = await launchInlineResumeFixture();
  try {
    const window = await fixture.electronApp.firstWindow();
    await enterInterruptedChat(window, 'tab');
    const composer = window.getByRole('textbox').first();
    await composer.fill('Do something else instead.');
    await window
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(window.getByTestId('interrupted-turn-resume')).toHaveCount(0);
    await expect
      .poll(async () => {
        const tabs = await window.evaluate(
          (target) => window.api.chat.loadTabs(target),
          interruptedResumeScope,
        );
        return tabs.tabs.find((t) => t.id === interruptedResumeScope.chatId)
          ?.interruptedTurns?.original?.abandoned;
      })
      .toBe(true);
    await window.reload();
    await openChat(window);
    await expect(window.getByTestId('interrupted-turn-resume')).toHaveCount(0);
    await expect(window.getByTestId('auto-resume-marker')).toHaveCount(0);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

for (const unanswered of [false, true]) {
  test(`CAN-5177 retries a failed ${unanswered ? 'resend' : 'continuation'} once under duplicate activation`, async () => {
    test.setTimeout(180_000);
    const fixture = await launchInlineResumeFixture({ unanswered });
    try {
      const window = await fixture.electronApp.firstWindow();
      await enterInterruptedChat(window, 'tab');
      await expect(window.getByTestId('interrupted-turn-resume')).toContainText(
        unanswered
          ? 'Resuming re-sends your last message in this chat.'
          : 'Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again.',
      );
      // Existing Electron harness seam: fail once, then invoke the real handler.
      // The context-bridged preload API remains intact and immutable.
      await fixture.electronApp.evaluate(({ ipcMain }) => {
        const channel = 'usage-limited-chats:resume';
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('Resume handler missing');
        globalThis.can5177ResumeCalls = 0;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, request) => {
          globalThis.can5177ResumeCalls += 1;
          if (globalThis.can5177ResumeCalls === 1)
            return { resumedCount: 0, failedTargets: request.targets };
          return original(event, request);
        });
      });
      await window.getByTestId('interrupted-turn-resume-button').click();
      await expect(window.getByTestId('interrupted-turn-resume')).toContainText(
        'Could not resume this chat. Try again.',
      );
      await window
        .getByTestId('interrupted-turn-resume-button')
        .evaluate((button) => {
          button.click();
          button.click();
        });
      await expect(window.getByTestId('auto-resume-marker')).toHaveCount(1);
      await expect(window.getByTestId('interrupted-turn-resume')).toHaveCount(
        0,
      );
      expect(
        await fixture.electronApp.evaluate(() => globalThis.can5177ResumeCalls),
      ).toBe(2);
      const messages = (await transcript(window)).messages;
      expect(
        messages.filter((m) => m.userMessageSource === 'auto_resume'),
      ).toEqual([
        expect.objectContaining({
          autoResume: expect.objectContaining({
            reason: 'app_shutdown',
            resumesUserMessageId: 'original',
            resendsUserMessage: unanswered,
          }),
        }),
      ]);
    } finally {
      await closeCanopy(fixture.electronApp, fixture.userDataDir);
    }
  });
}
