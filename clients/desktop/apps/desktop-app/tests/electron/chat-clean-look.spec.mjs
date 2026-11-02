import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  injectChatEvent,
  publishTurnLifecycle,
  seedWorktreeChat,
  turnEventInjector,
} from './seeders/index.mjs';
import { assertVisibleReplyCopy } from './fixtures/chat-message-copy.mjs';

/**
 * Clean chat (the only chat look): the transcript reads like the Codex app.
 * A running turn opens with "Working for …", a failed command says
 * "Couldn't run …" without color or code chips, and a finished turn folds its
 * steps under "Worked for …", with the steps in words on hover, and its reply
 * row offers Copy and a "•••" menu with Good / Bad response.
 *
 * Determinism: no live agent and no network. Every provider event goes
 * through the E2E chat-event ingress, which commits through main exactly as a
 * real provider session does.
 */

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'clean-chat-look-chat';
const TURN_ID = 'clean-chat-look-turn';
const TURN_STARTED_AT = Date.parse('2026-10-21T12:00:00.000Z');

function assistant(id, content) {
  return { type: 'assistant', message: { id, role: 'assistant', content } };
}

function result(id, content, isError = false) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, is_error: isError },
      ],
    },
  };
}

test('Clean chat reads steps in words and folds a finished turn', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-clean-chat-look-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Clean chat look' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Chat detail "Compact" folds the steps between replies into one line.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'compact' }),
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible();

    const turn = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      turnUserMessageId: TURN_ID,
    };
    const inject = turnEventInjector(electronApp, turn);

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 1,
        messages: [
          {
            id: TURN_ID,
            role: 'user',
            timestamp: TURN_STARTED_AT,
            blocks: [{ type: 'text', text: 'Add the robot glyph' }],
          },
        ],
      },
    });
    await publishTurnLifecycle(electronApp, {
      ...turn,
      phase: 'start',
      atMs: TURN_STARTED_AT,
    });
    await expect(panel.getByText('Add the robot glyph')).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByTestId('turn-work-header')).toContainText(
      'Working for',
    );

    // A failed command says so in its verb, and carries no code chip.
    await inject(
      assistant('clean-bash', [
        {
          type: 'tool_use',
          id: 'bash-1',
          name: 'Bash',
          input: { command: 'pnpm test icons', description: 'Run the tests' },
        },
      ]),
    );
    await inject(result('bash-1', 'FAIL AppIcons.test.tsx', true));
    // The step folds into the turn's work line; opening it shows the step.
    await panel
      .getByTestId('chat-tool-step-group')
      .first()
      .getByRole('button')
      .first()
      .click();
    const failedRow = panel.locator('[data-tool-status="error"]').first();
    await expect(failedRow).toContainText('Couldn’t run pnpm test icons');
    await expect(failedRow.locator('.font-mono')).toHaveCount(0);
    await expect(failedRow.locator('.fg-destructive')).toHaveCount(0);

    // Opening it shows the command, not the raw JSON input.
    await failedRow.getByRole('button').first().click();
    const details = failedRow.locator('pre').first();
    await expect(details).toHaveText('pnpm test icons');
    await expect(failedRow.getByText('"command"')).toHaveCount(0);

    await inject(
      assistant('clean-reads', [
        {
          type: 'tool_use',
          id: 'read-1',
          name: 'Read',
          input: { file_path: '/repo/src/icons.ts' },
        },
        {
          type: 'tool_use',
          id: 'read-2',
          name: 'Read',
          input: { file_path: '/repo/src/manifest.json' },
        },
      ]),
    );
    await inject(result('read-1', 'ok'));
    await inject(result('read-2', 'ok'));

    // The finished turn folds its steps under "Worked for", with what they
    // did in words on hover.
    await inject(
      assistant('clean-answer', [{ type: 'text', text: 'Added the glyph.' }]),
    );
    await inject({ type: 'result', is_error: false, result: 'Added.' });
    await expect(panel.getByText('Added the glyph.')).toBeVisible();
    // The header's toggle; its errored step is a control of its own beside it.
    const header = panel
      .getByTestId('turn-work-header')
      .getByRole('button', { name: /^Agent steps/ });
    await expect(header).toContainText('Worked', { timeout: 30_000 });
    await expect(
      header.locator('[title="Ran 1 command, read 2 files"]'),
    ).toHaveCount(1);

    // The reply row: Copy, then "•••" with Good / Bad response, then the time.
    await expect(panel.getByTestId('turn-copy-message')).toBeVisible();
    await assertVisibleReplyCopy(
      window,
      panel.getByTestId('turn-copy-message'),
      {
        markdown: 'Added the glyph.',
        readClipboard: () =>
          electronApp.evaluate(({ clipboard }) => clipboard.readText()),
        writeClipboard: (text) =>
          electronApp.evaluate(
            ({ clipboard }, value) => clipboard.writeText(value),
            text,
          ),
      },
    );
    const more = panel.getByTestId('turn-more-actions');
    await expect(more).toBeVisible();
    await more.click();
    const menu = window.getByTestId('turn-more-actions-menu');
    await expect(
      menu.getByRole('menuitemcheckbox', { name: 'Good response' }),
    ).toBeVisible();
    await expect(
      menu.getByRole('menuitemcheckbox', { name: 'Bad response' }),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Clean chat folds the work between replies into one line that never moves', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-clean-chat-steps-'),
  );
  const chatId = 'clean-chat-steps-chat';
  const turnId = 'clean-chat-steps-turn';
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Clean chat steps' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'compact' }),
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    await expect(panel).toBeVisible();

    const turn = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      turnUserMessageId: turnId,
    };
    const inject = turnEventInjector(electronApp, turn);
    const tool = async (id, name, input, output, isError = false) => {
      await inject(
        assistant(`${id}-msg`, [{ type: 'tool_use', id, name, input }]),
      );
      await inject(result(id, output, isError));
    };

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 1,
        messages: [
          {
            id: turnId,
            role: 'user',
            timestamp: TURN_STARTED_AT,
            blocks: [{ type: 'text', text: 'Audit the browser panel' }],
          },
        ],
      },
    });
    await publishTurnLifecycle(electronApp, {
      ...turn,
      phase: 'start',
      atMs: TURN_STARTED_AT,
    });
    await expect(panel.getByText('Audit the browser panel')).toBeVisible({
      timeout: 30_000,
    });
    // Before any step, the live line says the agent is thinking.
    await expect(panel.getByTestId('turn-timer')).toContainText('Thinking');

    await tool('b1', 'Bash', { command: 'git status' }, 'fatal', true);
    await tool('r1', 'Read', { file_path: '/repo/a.ts' }, 'ok');
    await inject(
      assistant('think-1', [
        { type: 'thinking', thinking: 'Check the toolbar.' },
      ]),
    );
    await tool('b2', 'Bash', { command: 'git log' }, 'ok');
    await inject(
      assistant('reply-1', [{ type: 'text', text: 'Reading the toolbar.' }]),
    );
    await expect(panel.getByText('Reading the toolbar.')).toBeVisible();

    // Step lines in the transcript; the row under the reply holds the live
    // "Thinking" line, which is not one of them.
    const lines = panel.locator(
      '[data-testid="chat-tool-step-group"]:not([data-testid="turn-timer"] *)',
    );
    // Four steps, one line, with the failure counted quietly.
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toContainText('Ran 2 commands, read 1 file');
    await expect(lines.first()).toContainText('1 error');
    await expect(panel.locator('[data-tool-status]')).toHaveCount(0);

    // Record where the line and the reply sit, then stream more work and
    // finish the turn: neither may move, and the row under the reply keeps
    // its place from the live line to the finished reply's actions.
    const tops = () =>
      panel.evaluate((root) => {
        const scroller = root.querySelector(
          '[data-testid="chat-message-list-scroll"]',
        );
        const base =
          (scroller?.getBoundingClientRect().top ?? 0) -
          (scroller?.scrollTop ?? 0);
        const top = (el) =>
          el ? Math.round(el.getBoundingClientRect().top - base) : null;
        return {
          line: top(root.querySelector('[data-testid="chat-tool-step-group"]')),
          reply: top(
            Array.from(
              root.querySelectorAll(
                '[data-testid="chat-message-content"], .prose',
              ),
            ).find((el) => el.textContent?.includes('Reading the toolbar.')),
          ),
        };
      });
    const before = await tops();
    await tool('r2', 'Read', { file_path: '/repo/toolbar.ts' }, 'ok');
    await tool('g1', 'Grep', { pattern: 'h-7', path: '/repo' }, '3 matches');
    await expect(lines).toHaveCount(2);
    expect(await tops()).toEqual(before);

    await inject(
      assistant('final', [{ type: 'text', text: 'Here is the audit.' }]),
    );
    await expect(panel.getByText('Here is the audit.')).toBeVisible();
    const timerTop = () =>
      panel
        .getByTestId('turn-timer')
        .evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const liveTimerTop = await timerTop();
    await inject({ type: 'result', is_error: false, result: 'Done.' });
    await expect(panel.getByTestId('turn-work-header')).toContainText('Worked');
    // The finished turn stays open where it was; nothing above the reply
    // folds away, and the reply row takes the live line's place.
    await expect(panel.getByText('Reading the toolbar.')).toBeVisible();
    expect(await tops()).toEqual(before);
    expect(await timerTop()).toBe(liveTimerTop);
    await expect(panel.getByTestId('turn-copy-message')).toBeVisible();
    // The reply row is in view at rest, not only on hover.
    await window.mouse.move(0, 0);
    const opacities = await panel
      .locator(
        '[data-testid="turn-actions"], [data-testid="turn-actions-reveal"], [data-testid="turn-timer-relative"]',
      )
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity));
    expect(opacities.length).toBeGreaterThan(1);
    expect(opacities.every((value) => value === '1')).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Clean chat says wrote plan for a plan-file write and never counts it as an edit (CAN-5355)', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-clean-chat-plan-write-'),
  );
  const chatId = 'clean-chat-plan-write-chat';
  const turnId = 'clean-chat-plan-write-turn';
  const planPath = path.join(
    os.homedir(),
    '.claude',
    'plans',
    'robot-glyph.md',
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Clean chat plan write' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'compact' }),
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    await expect(panel).toBeVisible();

    const turn = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      turnUserMessageId: turnId,
    };
    const inject = turnEventInjector(electronApp, turn);
    const tool = async (id, name, input, output, isError = false) => {
      await inject(
        assistant(`${id}-msg`, [{ type: 'tool_use', id, name, input }]),
      );
      await inject(result(id, output, isError));
    };

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 1,
        messages: [
          {
            id: turnId,
            role: 'user',
            timestamp: TURN_STARTED_AT,
            blocks: [{ type: 'text', text: 'Plan the robot glyph' }],
          },
        ],
      },
    });
    await publishTurnLifecycle(electronApp, {
      ...turn,
      phase: 'start',
      atMs: TURN_STARTED_AT,
    });
    await expect(panel.getByText('Plan the robot glyph')).toBeVisible({
      timeout: 30_000,
    });

    // Grep, then the plan file: the line says it wrote the plan, with no
    // project-edit count and no error.
    await tool('g1', 'Grep', { pattern: 'RobotIcon' }, 'src/icons.ts');
    await inject(
      assistant('plan-1-msg', [
        {
          type: 'tool_use',
          id: 'plan-1',
          name: 'Write',
          input: { file_path: planPath, content: '# Robot glyph plan' },
        },
      ]),
    );
    await inject(
      assistant('reply-1', [{ type: 'text', text: 'Drafted the plan.' }]),
    );
    await expect(panel.getByText('Drafted the plan.')).toBeVisible();
    await expect(
      panel.getByTestId('chat-tool-step-group').first(),
    ).toContainText('Searched once, writing plan');
    await inject(result('plan-1', `File created successfully at: ${planPath}`));
    const lines = panel.locator(
      '[data-testid="chat-tool-step-group"]:not([data-testid="turn-timer"] *)',
    );
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toContainText('Searched once, wrote plan');
    await expect(lines.first()).not.toContainText(/edited|error/);
    await tool('plan-exit', 'ExitPlanMode', {}, 'canopy_plan_handoff', true);
    await expect(
      panel.getByTestId('turn-work-header').getByTestId('turn-outcome-control'),
    ).toHaveCount(0);

    // A failed plan write next to a project edit: the edit is counted, the
    // plan write never reads as written, and the error stays visible.
    await tool(
      'plan-2',
      'Write',
      { file_path: planPath, content: '# Robot glyph plan v2' },
      'EACCES: permission denied',
      true,
    );
    await tool(
      'e1',
      'Edit',
      { file_path: '/repo/src/icons.ts', old_string: 'a', new_string: 'b' },
      'ok',
    );
    await inject(
      assistant('final', [{ type: 'text', text: 'Here is the plan.' }]),
    );
    await expect(panel.getByText('Here is the plan.')).toBeVisible();
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(1)).toContainText(
      "Couldn't write plan, edited 1 file",
    );
    await expect(lines.nth(1)).toContainText('1 error');

    await inject({ type: 'result', is_error: false, result: 'Done.' });
    const header = panel.getByTestId('turn-work-header');
    await expect(header).toContainText('Worked', { timeout: 30_000 });
    // The header counts the project edit, not the plan writes, and its one
    // error names the failing step and its unknown effect on the result.
    await expect(
      header.locator('[title="Edited 1 file, searched 1 time"]'),
    ).toHaveCount(1);
    const outcome = header.getByTestId('turn-outcome-control');
    await expect(outcome).toHaveText('1 error');
    await outcome.hover();
    const tooltip = window.getByTestId('turn-outcome-tooltip-surface');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('robot-glyph.md');
    await expect(tooltip).toContainText('Effect on the result is unknown');
    await window.mouse.move(1, 1);
    const failedRunToggle = lines.nth(1).getByRole('button').first();
    if ((await failedRunToggle.getAttribute('aria-expanded')) === 'false')
      await failedRunToggle.click();
    const failedPlan = panel.locator(
      '[data-tool-use-id="plan-2"][data-tool-status="error"]',
    );
    await expect(failedPlan).toContainText('robot-glyph.md');
    await failedPlan.getByRole('button').first().click();
    await expect(failedPlan.getByTestId('tool-call-error-impact')).toHaveText(
      'Effect on the result is unknown',
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      header.locator('[title="Edited 1 file, searched 1 time"]'),
    ).toHaveCount(1);
    await expect(header.getByTestId('turn-outcome-control')).toHaveText(
      '1 error',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
