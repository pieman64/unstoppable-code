import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedUsageLimitedChats, seedWorktreeChat } from './seeders/index.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withResumeQueue } from './resume-queue.scenario.mjs';
import {
  withAccountChangedCodexResumes,
  withResumedCodexTimers,
} from './usage-limit-resume-timers.scenario.mjs';

const WORKTREE_ID = 'demo-main';
const PIPELINE_EXECUTION_ID = 'usage-limit-resume-pipeline';
const PIPELINE_REASON_ID = '123e4567-e89b-42d3-a456-426614174000';

// Two demo apps so the resume modal renders two workspace groups. Same
// workspaceId/app/worktree values as `chat-usage-limit-banner.spec.mjs`.
const WORKSPACES = [
  {
    workspaceId: 'demo-ts-pnpm-vite',
    workspaceName: 'TypeScript pnpm Vite',
    app: 'ts-pnpm-vite',
    chatId: 'usage-limit-resume-vite-chat',
    chatTitle: 'Vite usage-limit chat',
  },
  {
    workspaceId: 'demo-ts-npm-next',
    workspaceName: 'TypeScript npm Next',
    app: 'ts-npm-next',
    chatId: 'usage-limit-resume-next-chat',
    chatTitle: 'Next usage-limit chat',
  },
];

function seedWorkspacesAndChats(userDataDir) {
  const seedResult = seedDemoWorkspaces({
    userDataDir,
    apps: WORKSPACES.map((workspace) => workspace.app),
  });
  for (const workspace of WORKSPACES) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: workspace.workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: workspace.chatId,
          title: workspace.chatTitle,
        },
      ],
    });
  }
  return seedResult;
}

function buildRegistryEntries() {
  return WORKSPACES.map((workspace, index) => ({
    projectId: workspace.workspaceId,
    worktreeId: WORKTREE_ID,
    chatId: workspace.chatId,
    provider: 'claude',
    detectedAt: Date.parse('2026-04-10T12:00:00.000Z') + index,
    workspaceName: workspace.workspaceName,
    chatTitle: workspace.chatTitle,
  }));
}

async function openResumeModal(window) {
  await window.evaluate(() => {
    window.__canopyUsageLimitResumeTestApi?.open('claude');
  });
}

function readRegistry(userDataDir) {
  const registryPath = path.join(userDataDir, 'usage-limited-chats.json');
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

test.describe('account-change usage-limit resume modal', () => {
  for (const status of ['resumed', 'failed']) {
    test(`a persisted ${status} queue ${status === 'resumed' ? 'clears after closing its dialog' : 'keeps its attention pill'}`, async () => {
      test.setTimeout(100_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-finished-resume-queue-'),
      );
      seedWorkspacesAndChats(userDataDir);
      const queuePath = path.join(userDataDir, 'resume-queue.json');
      writeFileSync(
        queuePath,
        JSON.stringify({
          version: 1,
          revision: 1,
          paused: false,
          entries: [
            {
              id: 'finished-session',
              target: {
                kind: 'chat',
                projectId: WORKSPACES[0].workspaceId,
                worktreeId: WORKTREE_ID,
                chatId: WORKSPACES[0].chatId,
              },
              interruptionId: 'fixture-interruption',
              title: 'Finished fixture session',
              workspaceName: WORKSPACES[0].workspaceName,
              createdAt: 1,
              status,
              ...(status === 'failed'
                ? { error: 'Fixture session needs attention.' }
                : {}),
            },
          ],
        }),
      );
      const { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        await new CanopyAppDriver(window).waitForShell();
        const pill = window.getByTestId('resume-queue-sidebar');
        await expect(pill).toBeVisible();
        // A healthy single session's chip opens its chat; its trailing
        // action opens the queue. A failed session's chip opens the queue.
        await (
          status === 'resumed'
            ? window.getByTestId('resume-queue-sidebar-open-queue')
            : pill
        ).click();
        const modal = window.getByTestId('resume-queue-modal');
        await expect(modal).toBeVisible();
        // A handoff is a start, not a finished task; one entry has no counts.
        await expect(modal.getByTestId('resume-queue-status')).toHaveText(
          status === 'resumed' ? 'Started' : 'Needs attention',
        );
        await expect(modal).not.toContainText('of 1');
        await window.waitForTimeout(31_000);
        await expect(pill).toBeVisible();
        expect(
          JSON.parse(readFileSync(queuePath, 'utf8')).entries,
        ).toHaveLength(1);
        // A finished queue's footer offers only Done; Escape is its close.
        await window.keyboard.press('Escape');
        await expect(modal).toBeHidden();
        if (status === 'resumed') {
          // Closing the modal over a clean queue clears the pill at once,
          // well before the 30-second auto-dismiss (CAN-4970).
          await expect(pill).toBeHidden({ timeout: 5_000 });
          expect(JSON.parse(readFileSync(queuePath, 'utf8')).entries).toEqual(
            [],
          );
        } else {
          await window.waitForTimeout(31_000);
          await expect(pill).toBeVisible();
          expect(
            JSON.parse(readFileSync(queuePath, 'utf8')).entries,
          ).toHaveLength(1);
          await pill.click();
          await expect(modal).toContainText('Fixture session needs attention.');
          await expect(modal.getByTestId('resume-queue-done')).toBeEnabled();
        }
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('a persisted single resumed chat has one Done action that opens it and durably clears the queue', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-single-resumed-done-'),
    );
    seedWorkspacesAndChats(userDataDir);
    const workspace = WORKSPACES[0];
    const queuePath = path.join(userDataDir, 'resume-queue.json');
    writeFileSync(
      queuePath,
      JSON.stringify({
        version: 1,
        revision: 1,
        paused: false,
        entries: [
          {
            id: 'persisted-resumed-chat',
            target: {
              kind: 'chat',
              projectId: workspace.workspaceId,
              worktreeId: WORKTREE_ID,
              chatId: workspace.chatId,
            },
            interruptionId: 'persisted-handoff',
            title: workspace.chatTitle,
            workspaceName: workspace.workspaceName,
            createdAt: 1,
            status: 'resumed',
          },
        ],
      }),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      await window.getByTestId('resume-queue-sidebar-open-queue').click();
      const modal = window.getByTestId('resume-queue-modal');
      const dialog = window.getByRole('dialog', { name: 'Resume queue' });
      await expect(modal.locator('[role="status"]')).toContainText('Started');
      await expect(modal).toContainText(
        'Your chat has started again. Open it to follow along.',
      );
      await expect(modal).not.toContainText(
        /Finished|processed|every 10 seconds|\d+ of \d+|\d+ waiting/,
      );
      await expect(modal.getByRole('progressbar')).toHaveCount(0);
      await expect(dialog).not.toContainText('You can close this');
      const footer = modal.getByTestId('resume-queue-footer');
      await expect(footer.getByRole('button')).toHaveCount(1);
      await expect(
        footer.getByRole('button', { name: 'Close', exact: true }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole('button', { name: 'Close', exact: true }),
      ).toBeVisible();
      await footer.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(
        window.locator(`[data-panel-id="panel-chat-${workspace.chatId}"]`),
      ).toBeVisible();
      await expect(modal).toBeHidden();
      await expect(window.getByTestId('resume-queue-sidebar')).toBeHidden();
      await expect
        .poll(() => JSON.parse(readFileSync(queuePath, 'utf8')).entries)
        .toEqual([]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  for (const paused of [false, true]) {
    test(`a terminal queue error retains its reopen route after Escape (paused: ${paused})`, async () => {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-queue-error-'),
      );
      seedWorkspacesAndChats(userDataDir);
      const queuePath = path.join(userDataDir, 'resume-queue.json');
      const error =
        'The resume queue stopped unexpectedly. Your saved queue is safe. Restart the app to retry.';
      writeFileSync(
        queuePath,
        JSON.stringify({
          version: 1,
          revision: 1,
          paused,
          error,
          entries: [
            {
              id: 'error-chat',
              target: {
                kind: 'chat',
                projectId: WORKSPACES[0].workspaceId,
                worktreeId: WORKTREE_ID,
                chatId: WORKSPACES[0].chatId,
              },
              interruptionId: 'error-handoff',
              title: WORKSPACES[0].chatTitle,
              workspaceName: WORKSPACES[0].workspaceName,
              createdAt: 1,
              status: 'resumed',
            },
          ],
        }),
      );
      const { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        await new CanopyAppDriver(window).waitForShell();
        const chip = window.getByTestId('resume-queue-sidebar');
        await chip.click();
        const modal = window.getByTestId('resume-queue-modal');
        await expect(modal.getByTestId('resume-queue-status')).toHaveText(
          'Paused',
        );
        await expect(modal.getByRole('alert')).toHaveText(error);
        await expect(
          modal.getByTestId('resume-queue-footer').getByRole('button'),
        ).toHaveCount(1);
        await expect(modal.getByTestId('resume-queue-done')).toBeDisabled();
        await expect(modal).not.toContainText('every 10 seconds');
        await window.keyboard.press('Escape');
        await expect(modal).toBeHidden();
        await expect(chip).toBeVisible();
        expect(JSON.parse(readFileSync(queuePath, 'utf8'))).toMatchObject({
          error,
          entries: [{ id: 'error-chat' }],
        });
        await chip.click();
        await expect(modal.getByRole('alert')).toHaveText(error);
        await expect(modal.getByTestId('resume-queue-done')).toBeDisabled();
        await window
          .getByRole('dialog', { name: 'Resume queue' })
          .getByRole('button', { name: 'Close', exact: true })
          .click();
        await expect(modal).toBeHidden();
        await expect(chip).toBeVisible();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  // Completion allows ten seconds between handoffs and real provider startup.
  // Admission while providers stay active is asserted separately.
  test('single resume opens the selected chat and shows gated streaming without Continue', async () => {
    await withResumeQueue(
      async ({ window, starts, chatIds, fixture }) => {
        await window.getByTestId('usage-limit-resume-confirm').click();
        await expect(
          window.getByTestId('usage-limit-resume-modal'),
        ).toBeHidden();
        await expect(window.getByTestId('resume-queue-modal')).toBeHidden();
        const chat = window.locator(
          `[data-panel-id="panel-chat-${chatIds[0]}"]`,
        );
        await expect(chat).toBeVisible();
        await expect(chat).toContainText('E2E_CODEX_STREAM_007', {
          timeout: 30_000,
        });
        expect(starts()).toHaveLength(1);
        await window.getByTestId('sidebar-create-task').click();
        await window.getByTestId('resume-queue-sidebar').click();
        await expect(chat).toBeVisible();
        await window.getByTestId('resume-queue-sidebar-open-queue').focus();
        await window.keyboard.press('Enter');
        const queue = window.getByTestId('resume-queue-modal');
        await expect(queue).toBeVisible();
        await expect(
          queue.getByRole('button', { name: 'Open chat', exact: true }),
        ).toHaveCount(1);
        await queue.getByTestId('resume-queue-done').click();
        await expect(queue).toBeHidden();
        await expect(chat).toBeVisible();
        expect(starts()).toHaveLength(1);
        writeFileSync(fixture.releasePath, 'release');
        await expect(chat).toContainText('E2E_CODEX_STREAM_015');
      },
      1,
      'staged',
    );
  });

  test('single resume shows a fast completed reply even with a saved earlier scroll position', async () => {
    const messages = Array.from({ length: 20 }, (_, index) => [
      {
        id: `history-user-${index}`,
        role: 'user',
        blocks: [{ type: 'text', text: `Earlier request ${index}` }],
        timestamp: 1790060000000 + index * 2,
      },
      {
        id: `history-reply-${index}`,
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: `Earlier reply ${index}\n\n${'Previous work.\n'.repeat(15)}`,
          },
        ],
        timestamp: 1790060000001 + index * 2,
      },
    ]).flat();
    await withResumeQueue(
      async ({ window, starts, chatIds }) => {
        await window.getByTestId('usage-limit-resume-confirm').click();
        const chat = window.locator(
          `[data-panel-id="panel-chat-${chatIds[0]}"]`,
        );
        await expect(chat).toBeVisible();
        const reply = chat.getByText('done', { exact: true });
        await expect(reply).toBeVisible({ timeout: 30_000 });
        await expect(window.getByTestId('resume-queue-modal')).toBeHidden();
        const scroller = chat.getByTestId('chat-message-list-scroll');
        await scroller.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event('scroll'));
        });
        await expect(reply).not.toBeInViewport();
        await window.getByTestId('sidebar-create-task').click();
        await window.getByTestId('resume-queue-sidebar').click();
        await expect(reply).toBeInViewport({ timeout: 15_000 });
        expect(starts()).toHaveLength(1);
      },
      1,
      'complete',
      { messages },
    );
  });

  test('opening a waiting queue row leaves later resumes running', async () => {
    await withResumeQueue(async ({ window, starts, chatIds }) => {
      await window.getByTestId('usage-limit-resume-confirm').click();
      const queue = window.getByTestId('resume-queue-modal');
      await expect(queue).toBeVisible();
      await queue
        .locator('li')
        .filter({ hasText: 'Interrupted task 2' })
        .getByRole('button', { name: 'Open chat', exact: true })
        .click();
      await expect(queue).toBeHidden();
      await expect(
        window.locator(`[data-panel-id="panel-chat-${chatIds[1]}"]`),
      ).toBeVisible();
      await expect.poll(() => starts().length, { timeout: 45_000 }).toBe(2);
      await expect(
        window.locator(`[data-panel-id="panel-chat-${chatIds[1]}"]`),
      ).toBeVisible();
      expect(
        new Set(starts().map((request) => request.params.threadId)).size,
      ).toBe(2);
    }, 2);
  });

  test('Continue observes a real resume working offscreen and its unread activity', async () => {
    await withResumeQueue(
      async ({ window, app, starts, fixture }) => {
        await window.getByTestId('usage-limit-resume-confirm').click();
        const queue = window.getByTestId('resume-queue-modal');
        await expect(queue).toBeVisible();
        await window.keyboard.press('Escape');
        await expect(queue).toBeHidden();
        await app.openPipelinesPage();
        await window.getByTestId('sidebar-create-task').click();
        const home = window.getByTestId('page-home');
        const activity = home.getByTestId('home-resume-activity');
        await expect(activity).toHaveText('· Agent working', {
          timeout: 30_000,
        });
        await expect.poll(() => starts().length, { timeout: 45_000 }).toBe(2);
        writeFileSync(fixture.releasePath, 'release');
        // Once the resumed chats finish, Continue names each unread result
        // (CAN-4958), and Last viewed, with its activity cue, steps aside
        // because attention already leads to its worktree.
        const unreadRows = home.getByTestId('home-continue-unread-row');
        await expect(unreadRows).toHaveCount(2, { timeout: 30_000 });
        await expect(home.getByTestId('home-resume-details')).toHaveCount(0);
        await expect(activity).toHaveCount(0);
        await unreadRows.first().getByRole('button').click();
        await expect(
          window.locator('[data-testid="panel-content-chat"]:visible'),
        ).toBeVisible();
      },
      2,
      'staged',
      { startupOffer: true },
    );
  });

  test('resumes seventeen interrupted sessions through the normal provider path', async () => {
    test.setTimeout(300_000);
    await withResumeQueue(async ({ window, starts }) => {
      await window.getByTestId('usage-limit-resume-confirm').click();
      await expect.poll(() => starts().length, { timeout: 210_000 }).toBe(17);
      expect(
        new Set(starts().map((request) => request.params.threadId)).size,
      ).toBe(17);
    });
  });

  test('keeps a paused resume queue across closing the dialog and restarting', async () => {
    test.setTimeout(300_000);
    await withResumeQueue(async ({ window, starts, restart }) => {
      await window.getByTestId('usage-limit-resume-confirm').click();
      await expect(
        window.getByRole('heading', { name: 'Resume queue', exact: true }),
      ).toBeVisible();
      // Pacing is promised only while a batch keeps starting (CAN-4898).
      await expect(window.getByTestId('resume-queue-modal')).toContainText(
        'every 10 seconds',
      );
      await window
        .getByRole('button', { name: 'Pause queue', exact: true })
        .click();
      await expect(window.getByTestId('resume-queue-modal')).toContainText(
        'Paused',
      );
      await expect(window.getByTestId('resume-queue-modal')).not.toContainText(
        'every 10 seconds',
      );
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('resume-queue-sidebar')).toContainText(
        'Paused',
      );
      await window.getByTestId('resume-queue-sidebar').click();
      const queue = window.getByTestId('resume-queue-modal');
      await expect(queue).toContainText('Paused');
      // Pausing keeps a handoff already in flight. Let it start its turn before
      // quitting: a quit in between interrupts that chat again, and the queue
      // never replays a delivered resume, so the chat would not start here.
      await expect(queue.getByText('Resuming…', { exact: true })).toHaveCount(
        0,
        { timeout: 30_000 },
      );
      const handedOff = await queue
        .getByText('Resumed', { exact: true })
        .count();
      await expect
        .poll(() => starts().length, { timeout: 30_000 })
        .toBe(handedOff);
      const next = await restart();
      await expect(
        next.window.getByTestId('resume-queue-sidebar'),
      ).toContainText('Paused');
      const pausedCount = starts().length;
      await next.window.getByTestId('resume-queue-sidebar').click();
      await expect(next.window.getByTestId('resume-queue-modal')).toContainText(
        'Paused',
      );
      expect(starts().length).toBe(pausedCount);
      await next.window
        .getByRole('button', { name: 'Resume queue', exact: true })
        .click();
      await expect.poll(() => starts().length, { timeout: 210_000 }).toBe(3);
      await expect(next.window.getByTestId('resume-queue-modal')).toContainText(
        '3 of 3 started',
      );
    }, 3);
  });

  test('appends new selections to a paused queue without duplicating waiting sessions', async () => {
    test.setTimeout(300_000);
    await withResumeQueue(async ({ window, starts, chatIds }) => {
      await window.getByTestId('usage-limit-resume-select-all').click();
      await window.getByTestId(`usage-limit-resume-chat-${chatIds[0]}`).check();
      await window.getByTestId('usage-limit-resume-confirm').click();
      // One confirmed chat opens directly; the chip reopens its queue.
      await window.getByTestId('resume-queue-sidebar-open-queue').click();
      await window
        .getByRole('button', { name: 'Pause queue', exact: true })
        .click();
      await window.keyboard.press('Escape');
      await window.getByTestId('sidebar-create-task').click();
      await window.getByTestId('home-interrupted-sessions-resume').click();
      await expect(
        window.getByTestId('usage-limit-resume-modal'),
      ).toBeVisible();
      await window.getByTestId('usage-limit-resume-confirm').click();
      const queue = window.getByTestId('resume-queue-modal');
      await expect(queue).toContainText('Paused');
      await expect(queue.locator('li')).toHaveCount(3);
      await window
        .getByRole('button', { name: 'Resume queue', exact: true })
        .click();
      await expect.poll(() => starts().length, { timeout: 210_000 }).toBe(3);
      expect(
        new Set(starts().map((request) => request.params.threadId)).size,
      ).toBe(3);
    }, 3);
  });

  test('automatically continues waiting items after the app crashes without replaying confirmed resumes', async () => {
    test.setTimeout(300_000);
    await withResumeQueue(async ({ window, starts, restart }) => {
      await window.getByTestId('usage-limit-resume-confirm').click();
      await expect(window.getByTestId('resume-queue-modal')).toContainText(
        '1 of 3 started',
      );
      await expect.poll(() => starts().length).toBeGreaterThan(0);
      const next = await restart(true);
      await expect(
        next.window.getByTestId('resume-queue-sidebar'),
      ).toBeVisible();
      await next.window.getByTestId('resume-queue-sidebar').click();
      await expect.poll(() => starts().length, { timeout: 210_000 }).toBe(3);
      await expect(next.window.getByTestId('resume-queue-modal')).toContainText(
        '3 of 3 started',
      );
      expect(
        new Set(starts().map((request) => request.params.threadId)).size,
      ).toBe(3);
    }, 3);
  });

  test('continues paced resumes while earlier providers remain active and keeps controls usable', async () => {
    test.setTimeout(120_000);
    await withResumeQueue(
      async ({ window, starts }) => {
        await window.getByTestId('usage-limit-resume-confirm').click();
        await expect.poll(() => starts().length, { timeout: 30_000 }).toBe(1);
        await window.waitForTimeout(5000);
        expect(starts()).toHaveLength(1);
        // All five providers hang: admission must pass both former busy limits.
        await expect.poll(() => starts().length, { timeout: 65_000 }).toBe(5);
        await window.keyboard.press('Escape');
        await window.getByTestId('resume-queue-sidebar').click();
        await window
          .getByRole('button', { name: 'Pause queue', exact: true })
          .click();
        await expect(window.getByTestId('resume-queue-modal')).toContainText(
          'Paused',
        );
        await window
          .getByRole('button', { name: 'Stop remaining', exact: true })
          .click();
        await expect(
          window
            .getByTestId('resume-queue-modal')
            .getByTestId('resume-queue-status'),
        ).toHaveText('Stopped');
        await expect(
          window
            .getByTestId('resume-queue-modal')
            .locator('li')
            .getByText('Stopped', { exact: true }),
        ).toHaveCount(12);
        expect(starts()).toHaveLength(5);
      },
      17,
      'hang',
    );
  });

  test('bulk resumes six usage-rejected chats after account change without interrupt', async () => {
    test.setTimeout(300_000);
    await withAccountChangedCodexResumes(
      async ({ window, readTabs, chatIds, userDataDir }) => {
        await expect
          .poll(
            () =>
              readTabs().filter((tab) =>
                tab.messages.some((message) =>
                  message.blocks.some(
                    (block) =>
                      block.type === 'text' &&
                      block.text ===
                        'Reply from Codex account new-account@example.test',
                  ),
                ),
              ).length,
            { timeout: 15_000 },
          )
          .toBe(6);
        const state = await window.evaluate(() =>
          window.api.chat.getState({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          }),
        );
        expect(state.queue.flatMap((entry) => entry.queue)).toHaveLength(0);
        for (const id of chatIds)
          expect(state.runtimeByChatId[id].status).toBe('completed');
        for (const tab of readTabs()) {
          expect(
            tab.messages.some((message) =>
              message.blocks.some(
                (block) =>
                  block.type === 'text' &&
                  block.text.includes('Earlier Codex turn failed late.'),
              ),
            ),
          ).toBe(false);
        }
        await expect(
          window
            .getByText('Reply from Codex account new-account@example.test', {
              exact: true,
            })
            .last(),
        ).toBeVisible();
        // The finished queue clears its own sidebar pill, without Done.
        await expect(window.getByTestId('resume-queue-sidebar')).toBeHidden({
          timeout: 45_000,
        });
        expect(
          JSON.parse(
            readFileSync(path.join(userDataDir, 'resume-queue.json'), 'utf8'),
          ).entries,
        ).toEqual([]);
      },
    );
  });

  test('settles a failed Codex timer and shows the resumed timer after an unopened chat restarts', async () => {
    test.setTimeout(180_000);
    await withResumedCodexTimers(async ({ panel, failedTab, readTab }) => {
      const timers = panel.getByTestId('turn-timer');
      await expect(timers).toHaveCount(2);
      await expect(timers.nth(0)).toHaveAttribute('data-state', 'completed');
      await expect(timers.nth(1)).toHaveAttribute('data-state', 'live');
      const oldTimer = failedTab.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.type === 'turn_timer');
      expect(oldTimer?.completedAt).toEqual(expect.any(Number));
      const messages = readTab().messages;
      const resumedUser = messages.findIndex(
        (message) =>
          message.role === 'user' &&
          message.blocks.some(
            (block) => block.type === 'text' && block.text === 'Continue',
          ),
      );
      expect(
        messages
          .slice(resumedUser + 1)
          .flatMap((message) => message.blocks)
          .filter(
            (block) =>
              block.type === 'turn_timer' && block.completedAt === null,
          ),
      ).toHaveLength(1);
    });
  });

  test('renders grouped chats, tracks selection, and resumes on confirm', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-usage-limit-resume-modal-'),
    );

    const seedResult = seedWorkspacesAndChats(userDataDir);
    const worktreePath = seedResult.workspaces.find(
      (workspace) => workspace.id === WORKSPACES[0].workspaceId,
    )?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();
    seedUsageLimitedChats({ userDataDir, entries: buildRegistryEntries() });
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACES[0].workspaceId,
      worktreeId: WORKTREE_ID,
      execution: {
        id: PIPELINE_EXECUTION_ID,
        pipelineName: 'Usage-limited pipeline',
        status: 'paused',
        cwd: worktreePath,
        jobs: [
          {
            id: 'build',
            name: 'Build',
            steps: [
              {
                id: 'compile',
                name: 'Compile',
                run: 'node -e "setTimeout(() => {}, 5000)"',
              },
            ],
          },
        ],
        stepResults: {
          'build.compile': {
            status: 'paused',
            recovery_count: 0,
            agent_recovery: {
              version: 1,
              reason_id: PIPELINE_REASON_ID,
              action: 'agent-prompt',
              provider: 'claude',
              had_agent_activity: false,
              strategy: 'restart_step',
              recovery_count: 0,
              paused_at: '2026-04-10T12:00:00.000Z',
              failure_message: 'usage exhausted',
            },
          },
        },
        stateOverrides: {
          version: 6,
          status_reasons: [
            {
              id: PIPELINE_REASON_ID,
              kind: 'provider_usage_limit',
              code: 'rate_limit',
              provider: 'claude',
              account_scope: 'native',
              model: 'claude-opus-4.8',
              detected_at: '2026-04-10T12:00:00.000Z',
              source: {
                job_id: 'build',
                step_id: 'compile',
                attempt: 0,
                iteration: 1,
              },
            },
          ],
        },
      },
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      // The row's one-slot status system intentionally gives unread chat
      // activity priority over pipeline attention. Wait for the seeded paused
      // pipeline itself instead of assuming its planning shield owns the slot.
      const pausedPipelineCard = window.getByTestId(
        `pipeline-run-card-${PIPELINE_EXECUTION_ID}`,
      );
      await expect(pausedPipelineCard).toBeVisible({
        timeout: 15_000,
      });

      await openResumeModal(window);

      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });

      const [first, second] = WORKSPACES;
      const firstWorkspaceCheckbox = window.getByTestId(
        `usage-limit-resume-workspace-${first.workspaceId}`,
      );
      const secondWorkspaceCheckbox = window.getByTestId(
        `usage-limit-resume-workspace-${second.workspaceId}`,
      );
      await expect(firstWorkspaceCheckbox).toBeVisible();
      await expect(secondWorkspaceCheckbox).toBeVisible();

      const firstChatCheckbox = window.getByTestId(
        `usage-limit-resume-chat-${first.chatId}`,
      );
      const secondChatCheckbox = window.getByTestId(
        `usage-limit-resume-chat-${second.chatId}`,
      );
      const pipelineCheckbox = window.getByTestId(
        `usage-limit-resume-pipeline-${PIPELINE_EXECUTION_ID}`,
      );
      await expect(firstChatCheckbox).toBeChecked();
      await expect(secondChatCheckbox).toBeChecked();
      await expect(pipelineCheckbox).toBeChecked();
      // The row's title is the checkbox's label.
      await expect(pipelineCheckbox).toHaveAccessibleName(
        'Usage-limited pipeline',
      );

      const confirmButton = window.getByTestId('usage-limit-resume-confirm');
      // CAN-4896: the button names what it resumes rather than a bare count.
      const ALL_SELECTED = 'Resume 2 chats and 1 workflow';
      await expect(confirmButton).toHaveText(ALL_SELECTED);

      // Toggle one workspace off -> the confirm button names the single
      // remaining chat.
      await firstWorkspaceCheckbox.click();
      await expect(firstChatCheckbox).not.toBeChecked();
      await expect(pipelineCheckbox).not.toBeChecked();
      await expect(confirmButton).toHaveText('Resume chat');

      // Restore full selection before exercising the select-all control, so
      // "click select-all to deselect all" below starts from a fully-checked
      // state (toggleAll flips to the opposite of "all selected").
      await firstWorkspaceCheckbox.click();
      await expect(firstChatCheckbox).toBeChecked();
      await expect(pipelineCheckbox).toBeChecked();
      await expect(confirmButton).toHaveText(ALL_SELECTED);

      const selectAll = window.getByTestId('usage-limit-resume-select-all');
      await expect(selectAll).toHaveText('Deselect all');
      await selectAll.click();
      await expect(firstChatCheckbox).not.toBeChecked();
      await expect(secondChatCheckbox).not.toBeChecked();
      await expect(pipelineCheckbox).not.toBeChecked();
      await expect(confirmButton).toBeDisabled();

      // Re-select all, then confirm.
      await expect(selectAll).toHaveText('Select all');
      await selectAll.click();
      await expect(firstChatCheckbox).toBeChecked();
      await expect(secondChatCheckbox).toBeChecked();
      await expect(pipelineCheckbox).toBeChecked();
      await expect(confirmButton).toHaveText(ALL_SELECTED);

      await confirmButton.click();
      await expect(modal).toBeHidden({ timeout: 20_000 });
      const queueRows = window.getByTestId('resume-queue-modal').locator('li');
      await expect(
        queueRows.filter({ hasText: 'Usage-limited pipeline' }),
      ).toContainText('Workflow · Claude');
      await expect(
        queueRows.filter({ hasText: first.chatTitle }),
      ).toContainText('Claude');
      await window
        .getByTestId('resume-queue-modal')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await expect(pausedPipelineCard).toContainText('running', {
        timeout: 30_000,
      });
      await expect
        .poll(
          () =>
            JSON.parse(
              readFileSync(
                path.join(
                  userDataDir,
                  'pipeline-executions',
                  `${PIPELINE_EXECUTION_ID}.json`,
                ),
                'utf8',
              ),
            ).status,
          { timeout: 5_000 },
        )
        .not.toBe('paused');

      // The resume IPC clears a registry entry only after its dispatch
      // succeeds, and the modal doesn't close until that IPC call resolves,
      // so by the time the modal is hidden both confirmed entries should be
      // gone from disk.
      const registry = readRegistry(userDataDir);
      expect(registry.entries).toEqual([]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('an empty registry never opens the modal', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-usage-limit-resume-modal-empty-'),
    );

    seedWorkspacesAndChats(userDataDir);
    seedUsageLimitedChats({ userDataDir, entries: [] });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await openResumeModal(window);

      // Bounded wait for the list IPC round trip to resolve (it returns `[]`,
      // and the store closes itself without ever rendering the modal) before
      // asserting absence, so this isn't a false-negative from checking
      // before the fetch even started.
      await window.waitForTimeout(1_500);

      await expect(window.getByTestId('usage-limit-resume-modal')).toBeHidden({
        timeout: 5_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
