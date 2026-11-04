import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

// CAN-5056: a finished turn whose fourth Bash step exited 1 on a zsh glob
// says "1 error" on its summary. Hovering the warning names the step and the
// zsh line (or, for a paged turn, only the count) and never the exit code;
// clicking it opens the turn, lands on the step and rings it. The fixture
// only records the results; no command runs.

const T = Date.parse('2026-10-24T12:00:00.000Z');
const USER_ID = 'turn-1-user';
const ERROR_ID = 'toolu_outcome_mcp_files';
const ZSH_LINE = 'zsh: no matches found: /Users/fixture/.claude/mcp-*.json';

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

function bashStep(index, toolUseId, input, output, isError) {
  return {
    id: `turn-1-step-${index}`,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_use',
        toolUseId,
        toolName: 'Bash',
        input: JSON.stringify(input),
      },
      {
        type: 'tool_result',
        toolUseId,
        toolName: 'Bash',
        output,
        isError,
      },
    ],
    timestamp: T + index * 1_000,
  };
}

function buildMessages(paged) {
  return [
    {
      id: USER_ID,
      role: 'user',
      blocks: [{ type: 'text', text: 'Check the MCP connections.' }],
      timestamp: T,
    },
    ...(paged
      ? Array.from({ length: 1_100 }, (_, index) =>
          bashStep(
            index - 1_110,
            `history-${index}`,
            { command: 'git status' },
            'clean',
            false,
          ),
        )
      : []),
    bashStep(
      1,
      'toolu_outcome_status',
      { command: 'git status' },
      'clean',
      false,
    ),
    bashStep(2, 'toolu_outcome_pwd', { command: 'pwd' }, '/repo', false),
    bashStep(3, 'toolu_outcome_ls', { command: 'ls' }, 'README.md', false),
    bashStep(
      4,
      ERROR_ID,
      {
        command: 'ls ~/.claude/mcp-*.json',
        description: 'List MCP connection files',
      },
      `Exit code 1\n${ZSH_LINE}`,
      true,
    ),
    {
      id: 'turn-1-final',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'There are no MCP connection files.' }],
      timestamp: T + 5_000,
    },
    {
      id: 'turn-1-timer',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: T, completedAt: T + 6_000 }],
      timestamp: T + 6_000,
    },
  ];
}

function seedStandaloneChat(userDataDir, paged) {
  const rootDir = path.join(userDataDir, 'standalone-chat');
  const projectDir = path.join(rootDir, 'default');
  const createdAt = '2026-10-24T12:00:00.000Z';

  writeJson(path.join(rootDir, 'projects.json'), {
    version: 1,
    projects: [
      {
        id: 'default',
        name: 'Default',
        createdAt,
        color: '#7C9B6D',
        defaultModel: 'gpt-6-luna',
      },
    ],
  });
  writeJson(path.join(projectDir, 'project.json'), {
    version: 1,
    id: 'default',
    name: 'Default',
    createdAt,
    color: '#7C9B6D',
    description: 'Turn outcome fixture',
    defaultModel: 'gpt-6-luna',
  });
  writeText(
    path.join(projectDir, 'CLAUDE.md'),
    'Turn outcome fixture instructions.\n',
  );
  writeJson(path.join(projectDir, 'chat-tabs.json'), {
    version: 1,
    activeTabId: 'chat-outcome',
    tabs: [
      {
        id: 'chat-outcome',
        title: 'MCP files',
        description: 'Errored step summary coverage',
        createdAt,
        providerType: 'claude',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: buildMessages(paged),
      },
    ],
  });
}

async function openFixture(paged) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-turn-error-'));
  seedStandaloneChat(userDataDir, paged);
  const { electronApp } = await launchCanopy({ userDataDir }).catch((error) => {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await window.evaluate(() =>
    window.api.savePreferences({ chatDetail: 'compact' }),
  );
  await app.openChatPage();
  const page = window.getByTestId('page-chat');
  await expect(page).toBeVisible();
  const turn = page.locator(`[data-chat-turn-group="${USER_ID}"]`);
  const summary = turn.getByRole('button', {
    name: `Agent steps: Ran ${paged ? 1_104 : 4} commands, 1 error`,
    exact: true,
  });
  await expect(summary).toBeVisible();
  return { electronApp, userDataDir, window, turn, summary };
}

for (const paged of [false, true]) {
  test(`${paged ? 'paged' : 'loaded'}: names the errored step and jumps to it`, async ({}, testInfo) => {
    const { electronApp, userDataDir, window, turn, summary } =
      await openFixture(paged);
    try {
      const outcome = turn.getByTestId('turn-outcome-control');
      await expect(outcome).toHaveText('1 error');
      await expect(outcome).toHaveAttribute('data-turn-failed', '1');
      // The warning sits beside the toggle, never inside it.
      await expect(summary.locator('[data-turn-outcomes]')).toHaveCount(0);
      await expect(turn).not.toContainText(/\bfailed\b/i);

      await outcome.hover();
      const tooltip = window.getByTestId('turn-outcome-tooltip-surface');
      await expect(tooltip).toBeVisible();
      if (paged) {
        await expect(tooltip).toHaveText(
          '1 step ran into an errorEffect on the result is unknown',
        );
      } else {
        // The step keeps its description; the reason below explains the error.
        await expect(tooltip).toContainText('List MCP connection files');
        await expect(tooltip).toContainText(ZSH_LINE);
        // It says what the error did to the result, here that it's unknown.
        await expect(tooltip).toContainText('Effect on the result is unknown');
      }
      await expect(tooltip).not.toContainText(/exit code/i);
      await window.screenshot({
        path: testInfo.outputPath('turn-outcome-error-tooltip.png'),
      });

      // Clicking the warning opens the turn (loading a paged one) and lands.
      await outcome.click();
      await expect(tooltip).toBeHidden();
      await expect(summary).toHaveAttribute('aria-expanded', 'true');
      const errorRow = turn.locator(`[data-tool-use-id="${ERROR_ID}"]`);
      const errorToggle = errorRow.locator('button[aria-expanded]').first();
      await expect(errorToggle).toBeFocused();
      await expect(errorRow).toBeInViewport();
      await expect(errorRow).toHaveAttribute('data-chat-call-focus', 'true');
      const rowTop = await errorRow.evaluate(
        (row) => row.getBoundingClientRect().top,
      );
      const summaryBottom = await summary.evaluate(
        (button) =>
          (
            button.closest('[data-turn-summary-row]') ?? button
          ).getBoundingClientRect().bottom,
      );
      expect(rowTop).toBeGreaterThanOrEqual(summaryBottom);
      await window.screenshot({
        path: testInfo.outputPath('turn-outcome-error-landed.png'),
      });

      // The stable description and explicit outcome remain readable without color.
      await expect(errorRow).toContainText('List MCP connection files');
      await expect(errorRow.getByTestId('tool-call-failed')).toHaveText(
        'Failed',
      );

      // From the open turn, a second click lands again.
      await expect(errorRow).not.toHaveAttribute(
        'data-chat-call-focus',
        'true',
        { timeout: 5_000 },
      );
      await window.mouse.move(0, 0);
      await outcome.click();
      await expect(summary).toHaveAttribute('aria-expanded', 'true');
      await expect(errorRow).toHaveAttribute('data-chat-call-focus', 'true');
      await expect(errorToggle).toBeFocused();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('the warning opens by keyboard and Enter jumps', async () => {
  const { electronApp, userDataDir, window, turn, summary } =
    await openFixture(false);
  try {
    const outcome = turn.getByTestId('turn-outcome-control');
    await summary.focus();
    await window.keyboard.press('Tab');
    await expect(outcome).toBeFocused();
    const tooltip = window.getByTestId('turn-outcome-tooltip-surface');
    await expect(tooltip).toContainText(ZSH_LINE);
    await window.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await expect(outcome).toBeFocused();

    await window.keyboard.press('Enter');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    const errorRow = turn.locator(`[data-tool-use-id="${ERROR_ID}"]`);
    await expect(
      errorRow.locator('button[aria-expanded]').first(),
    ).toBeFocused();
    await expect(errorRow).toHaveAttribute('data-chat-call-focus', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
