import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import {
  injectChatEvent,
  publishTurnLifecycle,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedCreatedFiles,
  openCreatedFiles,
  CREATED_FILES_TURN,
  CREATED_FILES_CHAT,
  CREATED_FILE_NAMES,
  DIFFED_FILE_NAMES,
  MISSING_FILE_NAME,
  OUTSIDE_FILE_NAME,
} from './createdFilesFixture.mjs';

for (const cowork of [false, true]) {
  test(`created files fold into the turn summary and open beside ${cowork ? 'Cowork' : 'Code'} chat`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-created-files-'),
    );
    const fixture = seedCreatedFiles(userDataDir, cowork);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const chat = await openCreatedFiles(window, fixture, {
        expandSummary: false,
      });
      const summary = chat.locator(
        `[data-testid="turn-files"][data-turn-id="${CREATED_FILES_TURN}"]`,
      );
      await expect(summary).toBeVisible();
      // One summary per turn; the created files no longer get a second shelf.
      await expect(chat.getByTestId('turn-files')).toHaveCount(1);
      const toggle = summary.locator('button[aria-expanded]');
      const chips = summary.getByTestId('turn-file-chip');
      // A historical turn starts collapsed, like its diff summary always has.
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(chips.first()).toBeHidden();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      if (cowork) {
        await expect(toggle).toHaveText(`${CREATED_FILE_NAMES.length} files`);
        await expect(chips).toHaveCount(CREATED_FILE_NAMES.length);
      } else {
        await expect(toggle).toContainText(`${DIFFED_FILE_NAMES.length} files`);
        await expect(toggle).toContainText(
          `${CREATED_FILE_NAMES.length - DIFFED_FILE_NAMES.length} other files`,
        );
        await expect(chips).toHaveCount(
          CREATED_FILE_NAMES.length - DIFFED_FILE_NAMES.length,
        );
        for (const name of DIFFED_FILE_NAMES) {
          await expect(
            summary.getByRole('button', {
              name: `outputs/${name}`,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            summary.getByRole('button', { name: `Open ${name}` }),
          ).toHaveCount(0);
        }
      }
      // A recorded file that is missing, or outside every workspace root, is
      // not presented at all instead of failing when opened.
      await expect(
        summary.getByRole('button', { name: `Open ${MISSING_FILE_NAME}` }),
      ).toHaveCount(0);
      await expect(
        summary.getByRole('button', { name: `Open ${OUTSIDE_FILE_NAME}` }),
      ).toHaveCount(0);
      await expect(summary.getByText(OUTSIDE_FILE_NAME)).toHaveCount(0);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(chips.first()).toBeHidden();
      await toggle.click();
      const tile = summary.getByRole('button', {
        name: 'Open Quarterly report.md',
      });
      await tile.focus();
      await tile.press('Enter');
      await expect(window.getByTestId('file-viewer')).toBeVisible();
      await expect(
        window
          .getByTestId('file-viewer')
          .getByRole('heading', { name: 'Quarterly report', exact: true }),
      ).toBeVisible();
      await expect(chat).toBeVisible();
      // Opening a file can remount the historical summary in its collapsed
      // state. Reopen it before exercising repeat-open and focus return.
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
        await toggle.click();
      }
      await expect(tile).toBeInViewport();
      await tile.click();
      const layout = await getLayout(window);
      const matches = collectLeaves(layout.root)
        .flatMap((leaf) => leaf.panels)
        .filter(
          (panel) =>
            panel.kind === 'file-diff' &&
            panel.instance?.filePath ===
              path.join(fixture.root, 'outputs', 'Quarterly report.md'),
        );
      expect(matches).toHaveLength(1);
      await window.getByTestId(`panel-tab-${matches[0].panelId}`).hover();
      await window.getByTestId(`panel-tab-close-${matches[0].panelId}`).click();
      await expect(tile).toBeFocused();
      const pageTile = summary.getByRole('button', { name: 'Open page.html' });
      await pageTile.click();
      const browserTabs = window.locator(
        '[role="tab"][data-panel-kind="browser"]',
      );
      await expect(browserTabs).toHaveCount(1);
      await pageTile.click();
      await expect(pageTile).toHaveAttribute('aria-busy', 'false');
      await expect(browserTabs).toHaveCount(1);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await pageTile.click();
      await expect(browserTabs).toHaveCount(1);
      await browserTabs.hover();
      await browserTabs.getByRole('button', { name: /^Close / }).click();
      await expect(browserTabs).toHaveCount(0);
      await expect(pageTile).toBeFocused();
      await pageTile.click();
      await expect(pageTile).toHaveAttribute('aria-busy', 'false');
      await expect(browserTabs).toHaveCount(1);
      await toggle.click();
      await expect(pageTile).toBeHidden();
      await browserTabs.hover();
      await browserTabs.getByRole('button', { name: /^Close / }).click();
      await expect(browserTabs).toHaveCount(0);
      await expect(toggle).toBeFocused();
      await window.reload();
      const reloaded = await openCreatedFiles(window, fixture);
      const reloadedSummary = reloaded.getByTestId('turn-files');
      await expect(reloadedSummary).toHaveCount(1);
      const reloadedToggle = reloadedSummary.locator('button[aria-expanded]');
      if ((await reloadedToggle.getAttribute('aria-expanded')) !== 'true')
        await reloadedToggle.click();
      await expect(reloadedSummary.getByTestId('turn-file-chip')).toHaveCount(
        cowork
          ? CREATED_FILE_NAMES.length
          : CREATED_FILE_NAMES.length - DIFFED_FILE_NAMES.length,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('file chips reconcile live creation, repeated terminal events and an app restart', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-live-files-'));
  const fixture = seedCreatedFiles(userDataDir);
  const turnId = 'live-files-user';
  seedWorktreeChat({
    userDataDir,
    workspaceId: fixture.workspaceId,
    worktreeId: fixture.worktreeId,
    providerType: 'codex',
    activeTabId: CREATED_FILES_CHAT,
    tabs: [
      {
        id: CREATED_FILES_CHAT,
        title: 'Live files',
        messages: [
          {
            id: turnId,
            role: 'user',
            timestamp: Date.now(),
            blocks: [{ type: 'text', text: 'Create a report.' }],
          },
        ],
      },
    ],
  });
  let launched = await launchCanopy({ userDataDir });
  const open = async () => {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(fixture.worktreeId);
    // The seeded prompt renders only from main's chat snapshot. Before the
    // injection this orders the load's snapshot read ahead of the turn; after
    // the restart it confirms the chat has loaded.
    await expect(
      window
        .locator(
          `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CREATED_FILES_CHAT}"]`,
        )
        .getByText('Create a report.', { exact: true }),
    ).toBeVisible();
    return window;
  };
  const send = (data) =>
    injectChatEvent(launched.electronApp, {
      projectId: fixture.workspaceId,
      worktreeId: fixture.worktreeId,
      chatId: CREATED_FILES_CHAT,
      providerType: 'codex',
      turnUserMessageId: turnId,
      data: { ...data, canopy_turn_user_message_id: turnId },
    });
  try {
    const window = await open();
    // Main settles a running turn with no live host whenever it reads the
    // chat's snapshot, for example for the Activity rail's Cost card. A real
    // turn holds the host queue gate, so hold it for this one. The restart
    // below discards the synthetic gate after lifecycle settlement.
    await launched.electronApp.evaluate(
      async (_, target) => globalThis.__CANOPY_E2E_HOLD_CHAT_TURN__(target),
      {
        projectId: fixture.workspaceId,
        worktreeId: fixture.worktreeId,
        chatId: CREATED_FILES_CHAT,
        turnUserMessageId: turnId,
      },
    );
    await send({
      type: 'canopy_user_prompt',
      original_text: 'Create a report.',
    });
    await publishTurnLifecycle(launched.electronApp, {
      projectId: fixture.workspaceId,
      worktreeId: fixture.worktreeId,
      chatId: CREATED_FILES_CHAT,
      turnUserMessageId: turnId,
      phase: 'start',
    });
    await send({
      type: 'codex',
      event: {
        type: 'turn.started',
        thread_id: 'live-files-thread',
        turn_id: 'live-files-turn',
      },
    });
    const item = {
      id: 'live-report',
      type: 'file_change',
      changes: [
        {
          kind: 'add',
          path: path.join(fixture.root, 'outputs', 'Quarterly report.md'),
        },
      ],
      status: 'inProgress',
    };
    await send({ type: 'codex', event: { type: 'item.started', item } });
    const summary = window.getByTestId('turn-files');
    await expect(summary).toContainText('Creating…');
    await expect(
      summary.getByRole('button', { name: 'Creating Quarterly report.md' }),
    ).toHaveAttribute('aria-disabled', 'true');
    const completed = {
      type: 'codex',
      event: { type: 'item.completed', item: { ...item, status: 'completed' } },
    };
    await send(completed);
    await send(completed);
    await expect(summary.getByTestId('turn-file-chip')).toHaveCount(1);
    await expect(
      summary.getByRole('button', { name: 'Open Quarterly report.md' }),
    ).toHaveAttribute('aria-disabled', 'false');
    await publishTurnLifecycle(launched.electronApp, {
      projectId: fixture.workspaceId,
      worktreeId: fixture.worktreeId,
      chatId: CREATED_FILES_CHAT,
      turnUserMessageId: turnId,
      phase: 'end',
    });
    await send({ type: 'codex', event: { type: 'turn.completed' } });
    await expect(summary.getByTestId('turn-file-chip')).toHaveCount(1);
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = await launchCanopy({ userDataDir });
    const restarted = await open();
    await expect(
      restarted.getByTestId('turn-files').getByTestId('turn-file-chip'),
    ).toHaveCount(1);
    await restarted
      .getByRole('button', { name: 'Open Quarterly report.md' })
      .click();
    await expect(restarted.getByTestId('file-viewer')).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

for (const cowork of [false, true]) {
  test(`App Advisor file chips reveal their ${cowork ? 'Cowork' : 'Code'} workspace and restore focus`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-advisor-files-'),
    );
    const fixture = seedCreatedFiles(userDataDir, cowork);
    const workspace = {
      projectId: fixture.workspaceId,
      worktreeId: fixture.worktreeId,
    };
    const files = ['Quarterly report.md', 'page.html'].map((name) => ({
      path: path.join(fixture.root, 'outputs', name),
    }));
    const advisorDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
    writeJson(path.join(advisorDir, 'work-entries.json'), {
      version: 1,
      entries: [
        {
          id: 'file-entry',
          createdAt: '2026-09-01T12:00:00.000Z',
          title: 'Workspace files',
        },
      ],
    });
    writeJson(path.join(advisorDir, 'chats', 'file-entry.json'), {
      version: 1,
      activeTabId: 'advisor-files',
      tabs: [
        {
          id: 'advisor-files',
          title: 'Workspace files',
          providerType: 'claude',
          model: 'sonnet',
          createdAt: '2026-09-01T12:00:00.000Z',
          messages: [
            {
              id: 'request',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Open the workspace report.' }],
            },
            {
              id: 'show',
              role: 'assistant',
              timestamp: 2,
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'show',
                  toolName: 'app_advisor_show_files',
                  input: JSON.stringify({ files, workspace }),
                },
              ],
            },
            {
              id: 'result',
              role: 'system',
              timestamp: 3,
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: 'show',
                  toolName: 'app_advisor_show_files',
                  output: JSON.stringify({
                    opened: 2,
                    failed: 0,
                    files: files.map((file) => ({
                      ...file,
                      absolutePath: file.path,
                      ok: true,
                    })),
                  }),
                  isError: false,
                },
              ],
            },
            {
              id: 'done',
              role: 'assistant',
              timestamp: 4,
              blocks: [{ type: 'text', text: 'The report is ready.' }],
            },
            {
              id: 'timer',
              role: 'system',
              timestamp: 5,
              blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 5 }],
            },
          ],
        },
      ],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const main = await electronApp.firstWindow();
      await openCreatedFiles(main, fixture);
      const advisor = await new CanopyAppDriver(main).openAppAdvisorWindow(
        electronApp,
      );
      // Keep the headless fixture in the standard floating layout. A hidden
      // full window reopens floating on the close relay and remounts the chip
      // whose focus this test is checking.
      await advisor.evaluate(() =>
        window.api.appAdvisor.openWindow({ layout: 'floating', focus: true }),
      );
      await expect(advisor.getByTestId('app-advisor-floating')).toBeVisible();
      const tile = advisor.getByRole('button', {
        name: 'Open Quarterly report.md',
      });
      await expect(tile).toBeVisible();
      await new CanopyAppDriver(main).openHomeForProject(fixture.workspaceId);
      await tile.click();
      await expect(
        main
          .getByTestId('file-viewer')
          .getByRole('heading', { name: 'Quarterly report', exact: true }),
      ).toBeVisible();
      await expect(tile).toHaveAttribute('aria-busy', 'false');
      await advisor.reload();
      await expect(tile).toBeVisible();
      await tile.click();
      await expect(tile).toHaveAttribute('aria-busy', 'false');
      const layout = await getLayout(main);
      expect(
        collectLeaves(layout.root)
          .flatMap((leaf) => leaf.panels)
          .filter(
            (panel) =>
              panel.kind === 'file-diff' &&
              panel.instance?.filePath === files[0].path,
          ),
      ).toHaveLength(1);
      const filePanel = collectLeaves(layout.root)
        .flatMap((leaf) => leaf.panels)
        .find(
          (panel) =>
            panel.kind === 'file-diff' &&
            panel.instance?.filePath === files[0].path,
        );
      // Hidden Electron windows retain DOM focus when another window opens.
      // Clear that retained focus so this assertion requires the close relay.
      await tile.evaluate((element) => element.blur());
      await expect(tile).not.toBeFocused();
      await main.getByTestId(`panel-tab-${filePanel.panelId}`).hover();
      await main.getByTestId(`panel-tab-close-${filePanel.panelId}`).click();
      await expect(tile).toBeFocused();
      const pageTile = advisor.getByRole('button', { name: 'Open page.html' });
      await pageTile.click();
      await expect(pageTile).toHaveAttribute('aria-busy', 'false');
      await expect(
        main.locator('[role="tab"][data-panel-kind="browser"]'),
      ).toHaveCount(1);
      await pageTile.click();
      await expect(pageTile).toHaveAttribute('aria-busy', 'false');
      await expect(
        main.locator('[role="tab"][data-panel-kind="browser"]'),
      ).toHaveCount(1);
      const browserTab = main.locator(
        '[role="tab"][data-panel-kind="browser"]',
      );
      await pageTile.evaluate((element) => element.blur());
      await expect(pageTile).not.toBeFocused();
      await browserTab.hover();
      await browserTab.getByRole('button', { name: /^Close / }).click();
      await expect(pageTile).toBeFocused();
      await expect(
        advisor.getByTestId('turn-files').getByRole('status'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
