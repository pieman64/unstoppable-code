import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

// CAN-4810: a finished turn that folds four Bash steps, the last one refused
// by the safety check, names the refusal on its summary, and expanding the
// summary lands on the refused step. The fixture only records the refusal;
// no command runs.

const T = Date.parse('2026-10-24T12:00:00.000Z');
const USER_ID = 'turn-1-user';
const DENIED_ID = 'toolu_outcome_push';

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

function bashStep(index, toolUseId, command, output, isError) {
  return {
    id: `turn-1-step-${index}`,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_use',
        toolUseId,
        toolName: 'Bash',
        input: JSON.stringify({ command }),
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

function buildMessages(
  paged,
  longReply = false,
  lateReceipt = false,
  omitReceipt = false,
) {
  const messages = [
    {
      id: USER_ID,
      role: 'user',
      blocks: [{ type: 'text', text: 'Publish the branch.' }],
      timestamp: T,
    },
    ...(paged
      ? Array.from({ length: 1_100 }, (_, index) =>
          bashStep(
            index - 1_110,
            `history-${index}`,
            'git status',
            'clean',
            false,
          ),
        )
      : []),
    bashStep(1, 'toolu_outcome_status', 'git status', 'clean', false),
    bashStep(2, 'toolu_outcome_add', 'git add -A', '', false),
    bashStep(3, 'toolu_outcome_commit', 'git commit -m wip', 'done', false),
    bashStep(
      4,
      DENIED_ID,
      'git push --force origin HEAD',
      'Denied by the safety check',
      true,
    ),
    {
      id: 'turn-1-safety-receipt',
      role: 'system',
      blocks: [
        {
          type: 'approval_safety_denied_info',
          receiptId: 'turn-1-safety-receipt',
          timestamp: T + 4_500,
          reason: 'force-push',
          command: 'git push --force origin HEAD',
          mode: 'ask',
          toolUseId: DENIED_ID,
          turnUserMessageId: USER_ID,
        },
      ],
      timestamp: T + 4_500,
    },
    {
      id: 'turn-1-final',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: longReply
            ? Array.from(
                { length: 40 },
                (_, index) =>
                  `Reply paragraph ${index + 1}: The force-push was blocked.`,
              ).join('\n\n')
            : 'The force-push was blocked.',
        },
      ],
      timestamp: T + 5_000,
    },
    {
      id: 'turn-1-timer',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: T, completedAt: T + 6_000 }],
      timestamp: T + 6_000,
    },
  ];
  if (lateReceipt) {
    const receiptIndex = messages.findIndex(
      (message) => message.id === 'turn-1-safety-receipt',
    );
    const [receipt] = messages.splice(receiptIndex, 1);
    messages.push(
      {
        id: 'turn-2-user',
        role: 'user',
        timestamp: T + 7_000,
        blocks: [{ type: 'text', text: 'Check the branch again.' }],
      },
      {
        ...bashStep(5, DENIED_ID, 'git status', 'clean', false),
        id: 'turn-2-step',
      },
      receipt,
      ...(omitReceipt
        ? Array.from({ length: 1_100 }, (_, index) => ({
            ...bashStep(
              20 + index,
              `next-history-${index}`,
              'git status',
              'clean',
              false,
            ),
            id: `next-history-${index}`,
          }))
        : []),
      {
        id: 'turn-2-final',
        role: 'assistant',
        timestamp: T + 8_000,
        blocks: [{ type: 'text', text: 'The branch is clean.' }],
      },
      {
        id: 'turn-2-timer',
        role: 'system',
        timestamp: T + 9_000,
        blocks: [{ type: 'turn_timer', completedAt: T + 9_000 }],
      },
    );
  }
  return messages;
}

function seedStandaloneChat(
  userDataDir,
  paged,
  longReply = false,
  lateReceipt = false,
  omitReceipt = false,
) {
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
        title: 'Blocked push',
        description: 'Blocked step summary coverage',
        createdAt,
        providerType: 'claude',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: buildMessages(paged, longReply, lateReceipt, omitReceipt),
      },
    ],
  });
}

for (const paged of [false, true]) {
  test(`${paged ? 'paged' : 'loaded'}: names the blocked step and lands on it`, async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-turn-outcome-'),
    );
    seedStandaloneChat(userDataDir, paged);
    const { electronApp } = await launchCanopy({ userDataDir }).catch(
      (error) => {
        rmSync(userDataDir, { recursive: true, force: true });
        throw error;
      },
    );

    try {
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
        name: `Agent steps: Ran ${paged ? 1_104 : 4} commands, 1 blocked`,
        exact: true,
      });
      await expect(summary).toBeVisible();
      await expect(turn.getByTestId('turn-work-header')).toContainText(
        'Worked for',
      );
      // The outcome is its own control beside the toggle (CAN-5056).
      await expect(turn.locator('[data-turn-blocked="1"]')).toHaveText(
        /1 blocked/,
      );
      await expect(summary.locator('[data-turn-outcomes]')).toHaveCount(0);
      await expect(turn.locator('[data-turn-failed]')).toHaveCount(0);
      await expect(
        summary.locator(`[data-turn-step-count="${paged ? 1_104 : 4}"]`),
      ).toHaveCount(1);
      await window.screenshot({
        path: testInfo.outputPath('turn-outcome-collapsed.png'),
      });

      await summary.focus();
      await window.keyboard.press('Enter');
      await expect(summary).toHaveAttribute('aria-expanded', 'true');

      const deniedRow = turn.locator(`[data-tool-use-id="${DENIED_ID}"]`);
      const deniedToggle = deniedRow.locator('button[aria-expanded]').first();
      await expect(deniedToggle).toBeFocused();
      await expect(deniedRow).toBeInViewport();

      // The row sits below the pinned prompt and summary, not under them.
      const rowTop = await deniedRow.evaluate(
        (row) => row.getBoundingClientRect().top,
      );
      const summaryBottom = await summary.evaluate(
        (button) => button.getBoundingClientRect().bottom,
      );
      expect(rowTop).toBeGreaterThanOrEqual(summaryBottom);
      await window.screenshot({
        path: testInfo.outputPath('turn-outcome-landed.png'),
      });

      // Collapsing does not land anywhere.
      await summary.click();
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await expect(summary).toBeFocused();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('a pinned summary in a narrow viewport lands below overlays', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-turn-pinned-'),
  );
  seedStandaloneChat(userDataDir, false, true);
  const { electronApp } = await launchCanopy({ userDataDir }).catch((error) => {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.emulateMedia({ reducedMotion: 'reduce' });
    // Chat detail "Detailed": the landing reaches the step's own row.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openChatPage();
    if (await window.getByTestId('app-sidebar').isVisible()) {
      await window.getByTestId('sidebar-toggle').click();
    }
    await window.setViewportSize({ width: 430, height: 932 });
    expect(await window.evaluate(() => window.innerWidth)).toBe(430);
    const page = window.getByTestId('page-chat');
    const turn = page.locator(`[data-chat-turn-group="${USER_ID}"]`);
    await turn
      .getByText('Reply paragraph 30:', { exact: false })
      .scrollIntoViewIfNeeded();
    const pinned = turn.locator(
      '[data-testid="sticky-turn-summary"][data-pinned]',
    );
    await expect(pinned).toBeVisible();
    const summary = pinned.getByRole('button', {
      name: 'Agent steps: Ran 4 commands, 1 blocked',
      exact: true,
    });
    // The outcome is its own control beside the toggle (CAN-5056).
    const outcome = pinned.getByTestId('turn-outcome-control');
    await expect(outcome).toHaveText('1 blocked');
    for (const element of [summary, outcome]) {
      const bounds = await element.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(430);
    }
    await window.screenshot({
      path: testInfo.outputPath('desktop-pinned-narrow.png'),
    });
    await summary.focus();
    await window.keyboard.press('Enter');
    const denied = turn.locator(`[data-tool-use-id="${DENIED_ID}"]`);
    await expect(denied.locator('button[aria-expanded]').first()).toBeFocused();
    await expect(denied).toBeInViewport();
    const activeSummary = turn
      .getByRole('button', {
        name: 'Agent steps: Ran 4 commands, 1 blocked',
        exact: true,
      })
      .filter({ visible: true });
    const rowTop = await denied.evaluate(
      (row) => row.getBoundingClientRect().top,
    );
    const summaryBottom = await activeSummary.evaluate(
      (button) => button.getBoundingClientRect().bottom,
    );
    expect(rowTop).toBeGreaterThanOrEqual(summaryBottom);
    await window.screenshot({
      path: testInfo.outputPath('desktop-pinned-narrow-landed.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a paged summary keeps a late denial on its originating turn', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-turn-late-receipt-'),
  );
  seedStandaloneChat(userDataDir, true, false, true);
  const { electronApp } = await launchCanopy({ userDataDir }).catch((error) => {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openChatPage();
    const page = window.getByTestId('page-chat');
    const first = page.locator(`[data-chat-turn-group="${USER_ID}"]`);
    await expect(
      first.getByRole('button', {
        name: 'Agent steps: Ran 1104 commands, 1 blocked',
        exact: true,
      }),
    ).toBeVisible();
    const next = page.locator('[data-chat-turn-group="turn-2-user"]');
    await expect(
      next.getByRole('button', {
        name: 'Agent steps: Ran 1 command',
        exact: true,
      }),
    ).toBeVisible();
    await expect(next.locator('[data-turn-blocked]')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a fully loaded owner retains a blocked outcome and landing when its receipt is omitted elsewhere', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-turn-omitted-receipt-'),
  );
  seedStandaloneChat(userDataDir, false, false, true, true);
  const { electronApp } = await launchCanopy({ userDataDir }).catch((error) => {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await app.openChatPage();
    const first = window
      .getByTestId('page-chat')
      .locator(`[data-chat-turn-group="${USER_ID}"]`);
    const summary = first.getByRole('button', {
      name: 'Agent steps: Ran 4 commands, 1 blocked',
      exact: true,
    });
    await expect(summary).toBeVisible();
    await summary.focus();
    await window.keyboard.press('Enter');
    await expect(
      first
        .locator(`[data-tool-use-id="${DENIED_ID}"] button[aria-expanded]`)
        .first(),
    ).toBeFocused();
    await expect(first.getByTestId('chat-transcript-paging')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('wheel input during history loading cancels outcome landing', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-turn-wheel-'));
  seedStandaloneChat(userDataDir, true);
  const { electronApp } = await launchCanopy({ userDataDir }).catch((error) => {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await app.openChatPage();
    const turn = window
      .getByTestId('page-chat')
      .locator(`[data-chat-turn-group="${USER_ID}"]`);
    const summary = turn.getByRole('button', {
      name: 'Agent steps: Ran 1104 commands, 1 blocked',
      exact: true,
    });
    await expect(summary).toBeVisible();
    // Hold the real page response until the reader has scrolled. The original
    // handler still supplies the transcript; no rows or results are fabricated.
    await electronApp.evaluate(({ ipcMain }, turnId) => {
      const channel = 'chat:get-transcript-page';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Missing transcript page handler');
      globalThis.__can4810PagePending = false;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        if (request.turnId === turnId) {
          await new Promise((resolve) => {
            globalThis.__can4810ReleasePage = resolve;
            globalThis.__can4810PagePending = true;
          });
        }
        return original(event, request);
      });
    }, USER_ID);
    await summary.focus();
    await window.keyboard.press('Enter');
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__can4810PagePending))
      .toBe(true);
    await window.mouse.move(900, 450);
    await window.mouse.wheel(0, 120);
    // A renderer round trip ensures the wheel event precedes page completion.
    await window.evaluate(() => new Promise(requestAnimationFrame));
    await electronApp.evaluate(() => globalThis.__can4810ReleasePage());
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    const deniedToggle = turn
      .locator(`[data-tool-use-id="${DENIED_ID}"] button[aria-expanded]`)
      .first();
    await expect(deniedToggle).toBeAttached();
    await window.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(summary).toBeFocused();
    await expect(deniedToggle).not.toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
