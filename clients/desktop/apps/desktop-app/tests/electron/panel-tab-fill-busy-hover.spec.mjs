import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  injectChatEvent,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { publishTurnLifecycle } from './seeders/publishTurnLifecycle.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

// Early access (the `fill` panel tabs; the classic tabs are covered by
// `chat-tab-busy-hover.spec.mjs`).
//
// Hovering a panel tab reveals its close button at the tab's right end, and
// the leading icon stays put. On a chat tab running a turn that icon is the
// thinking spinner — the only place the tab strip reports that work is in
// flight — and it must survive the hover.
//
// A busy tab keeps its spinner on hover and withholds the close button, so a
// stray click does not close running work; closing stays on the context
// menu. This spec
// drives a REAL Claude turn against the shared mock provider with a slow
// stream (same seam as `chat-cancel-escape-confirm.spec.mjs`) so the renderer
// holds a genuine streaming frame, then compares hover behavior on the busy
// tab against an idle sibling and against the same tab once the turn ends.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const BUSY_TAB_ID = 'busy-chat';
const IDLE_TAB_ID = 'idle-chat';
// Mock-server scenario markers must match /\[(Canopy-C[A-Za-z0-9_-]+)\]/
// (control-plane.mjs markerFromText) — the 'Canopy-C' prefix is mandatory.
const CONVERSATION_MARKER = 'Canopy-CBUSYTABHOVER';

/**
 * Hover a tab and run `assertions` while the pointer sits on it, retrying the
 * pair until both stick. Chromium drops `:hover` when a re-render replaces the
 * node under a stationary CDP pointer (see `closePanelTab` in canopyApp.mjs),
 * and a streaming tab re-renders constantly.
 */
async function withHover(window, panelId, assertions, timeout = 30_000) {
  const tab = window.getByTestId(`panel-tab-${panelId}`);
  await expect(async () => {
    await tab.hover({ timeout: 2_000 });
    await assertions();
  }).toPass({ timeout });
}

async function waitForBox(locator, label, timeout = 30_000) {
  let box = null;
  await expect
    .poll(
      async () => {
        box = await locator.boundingBox();
        return box !== null;
      },
      { message: `${label} geometry becomes available`, timeout },
    )
    .toBe(true);
  return box;
}

/** Inject a background task, then finish its owning provider turn. */
async function startIdleChatWithTask(
  electronApp,
  window,
  { chatId, taskId, toolUseId, taskType },
) {
  const turnId = `${chatId}-turn`;
  const startedAt = Date.now();
  const prompt = `Start a background ${taskType} task.`;
  const inject = (data) =>
    injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      providerType: 'claude',
      turnUserMessageId: turnId,
      data: { ...data, canopy_turn_user_message_id: turnId },
    });

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
          timestamp: startedAt,
          blocks: [{ type: 'text', text: prompt }],
        },
      ],
    },
  });
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel.getByText(prompt)).toBeVisible({ timeout: 30_000 });
  // Canonical root turns start and end only from lifecycle receipts (35c5d).
  const turn = {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId,
    turnUserMessageId: turnId,
  };
  await publishTurnLifecycle(electronApp, {
    ...turn,
    phase: 'start',
    atMs: startedAt,
  });

  await inject({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    task_type: taskType,
    is_backgrounded: true,
    description: `Background ${taskType} task for ${chatId}`,
  });
  // Keep the task live while making the chat itself idle. Close behavior must
  // follow task type, not the old running-turn spinner state.
  await publishTurnLifecycle(electronApp, { ...turn, phase: 'end' });
  await inject({ type: 'result', is_error: false, result: 'Turn completed.' });

  await expect
    .poll(
      () =>
        window.evaluate(
          async ({ projectId, worktreeId, targetChatId }) => {
            const state = await window.api.chat.getState({
              projectId,
              worktreeId,
            });
            const status = state.runtimeByChatId[targetChatId]?.status ?? null;
            return ![
              'queued',
              'starting',
              'streaming',
              'awaiting_input',
              'completing',
            ].includes(status);
          },
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            targetChatId: chatId,
          },
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        window.evaluate(
          async ({
            projectId,
            worktreeId,
            targetChatId,
            targetTaskId,
            targetTaskType,
          }) => {
            const snapshot = await window.api.activity.listLiveBgTasks({
              projectId,
              worktreeId,
            });
            return (
              snapshot.chats[targetChatId]?.liveTasks?.some(
                (task) =>
                  task.taskId === targetTaskId &&
                  task.taskType === targetTaskType,
              ) ?? false
            );
          },
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            targetChatId: chatId,
            targetTaskId: taskId,
            targetTaskType: taskType,
          },
        ),
      { timeout: 30_000 },
    )
    .toBe(true);

  return { inject };
}

test.describe('fill tabs: busy chat tab hover (spinner stays, close is withheld)', () => {
  test('a streaming tab keeps its spinner and withholds close; an idle tab offers close at its right end', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-busy-tab-hover-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        { id: BUSY_TAB_ID, title: 'Working' },
        { id: IDLE_TAB_ID, title: 'Idle' },
      ],
      activeTabId: BUSY_TAB_ID,
    });
    seedEarlyAccess({ userDataDir });
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: 'slow streaming turn', streamMs: 120_000 }],
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

      const busyPanelId = `panel-chat-${BUSY_TAB_ID}`;
      const idlePanelId = `panel-chat-${IDLE_TAB_ID}`;
      const busyTab = window.getByTestId(`panel-tab-${busyPanelId}`);
      const idleTab = window.getByTestId(`panel-tab-${idlePanelId}`);
      await expect(busyTab).toBeVisible({ timeout: 30_000 });
      await expect(idleTab).toBeVisible();

      const busySpinner = busyTab.locator('[aria-label="Thinking"]');
      const busyClose = window.getByTestId(`panel-tab-close-${busyPanelId}`);
      const idleIcon = idleTab.locator('.canopy-panel-tab-icon');
      const idleClose = window.getByTestId(`panel-tab-close-${idlePanelId}`);

      // Baseline: not hovered, no turn running — the tab shows its number
      // and no spinner. The first chat is tab 1 in this seeded strip.
      await expect(busySpinner).toHaveCount(0);
      await expect(busyTab.getByTestId('panel-tab-number')).toHaveText('1');

      const composer = window.getByRole('textbox').last();
      await composer.fill(`[${CONVERSATION_MARKER}] start a slow turn`);
      await composer.press('Enter');

      // The streaming-only stop control proves the turn is live.
      const stopButton = window.getByTestId('chat-stop-generation');
      await expect(stopButton).toBeVisible({ timeout: 30_000 });
      await expect(busySpinner).toBeVisible();

      // Hovering the working tab must not hide the spinner, and its close
      // button stays withheld while the turn runs.
      await withHover(window, busyPanelId, async () => {
        await expect(busySpinner).toBeVisible({ timeout: 2_000 });
        await expect(busyClose).toBeHidden({ timeout: 2_000 });
      });

      // Control: a tab that is not working keeps its icon and offers its
      // close button.
      await withHover(window, idlePanelId, async () => {
        await expect(idleIcon).toBeVisible({ timeout: 2_000 });
        await expect(idleClose).toBeVisible({ timeout: 2_000 });
      });

      // No jitter: the leading slot is one fixed box and the close button's
      // space is kept while it is hidden, so neither the spinner nor the close
      // button may move the label or resize the tab. Measured while
      // streaming, then again once idle.
      const measure = async () => {
        const [icon, label, tab] = await Promise.all([
          busyTab.locator('.canopy-panel-tab-icon').boundingBox(),
          busyTab.locator('.canopy-panel-tab-title').boundingBox(),
          busyTab.boundingBox(),
        ]);
        if (!icon || !label || !tab)
          throw new Error('tab geometry unavailable');
        return { icon, label, tab };
      };
      const streamingBox = await measure();
      const spinnerBox = await waitForBox(busySpinner, 'spinner');

      // Suppression is transient: once the turn stops, the working tab is an
      // ordinary tab again and its close button comes back.
      await stopButton.click();
      await expect(stopButton).toBeHidden({ timeout: 30_000 });
      await expect(busySpinner).toHaveCount(0);

      // Move off the tab before measuring its restored tab number.
      await composer.hover();
      const numberBox = await waitForBox(
        busyTab.getByTestId('panel-tab-number'),
        'tab number',
      );

      let idleBox;
      let closeBox;
      await withHover(window, busyPanelId, async () => {
        await expect(busyTab.locator('.canopy-panel-tab-icon')).toBeVisible({
          timeout: 2_000,
        });
        await expect(busyClose).toBeVisible({ timeout: 2_000 });
        // Capture both boxes in the same hover frame. A later re-render may
        // clear :hover even though the preceding visibility assertion passed.
        idleBox = await measure();
        closeBox = await busyClose.boundingBox();
        expect(closeBox, 'hovered close button geometry').not.toBeNull();
      });

      // Sub-pixel tolerance only; a whole-pixel difference is visible drift.
      const shifted = (a, b) => Math.abs(a - b);
      expect
        .soft(
          shifted(idleBox.icon.width, streamingBox.icon.width),
          `leading slot width: streaming ${streamingBox.icon.width} vs idle ${idleBox.icon.width}`,
        )
        .toBeLessThanOrEqual(0.5);
      expect
        .soft(
          shifted(idleBox.label.x, streamingBox.label.x),
          `label start: streaming ${streamingBox.label.x} vs idle ${idleBox.label.x}`,
        )
        .toBeLessThanOrEqual(0.5);
      expect
        .soft(
          shifted(idleBox.tab.width, streamingBox.tab.width),
          `tab width: streaming ${streamingBox.tab.width} vs idle ${idleBox.tab.width}`,
        )
        .toBeLessThanOrEqual(0.5);

      // Fill tabs draw the spinner smaller than the fixed number box; both
      // center on the same point of the leading slot.
      expect(spinnerBox.width).toBeLessThan(numberBox.width);
      expect(
        shifted(
          spinnerBox.x + spinnerBox.width / 2,
          numberBox.x + numberBox.width / 2,
        ),
        'spinner and tab number share a center',
      ).toBeLessThanOrEqual(0.5);

      // The close button sits at the tab's right end, inset 2px from the
      // right, top, and bottom edges of the tile.
      const tabRight = idleBox.tab.x + idleBox.tab.width;
      const closeRight = closeBox.x + closeBox.width;
      expect(
        shifted(tabRight - closeRight, 2),
        `close right inset: ${tabRight - closeRight}`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        shifted(closeBox.y - idleBox.tab.y, 2),
        `close top inset: ${closeBox.y - idleBox.tab.y}`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        shifted(
          idleBox.tab.y + idleBox.tab.height - (closeBox.y + closeBox.height),
          2,
        ),
        'close bottom inset',
      ).toBeLessThanOrEqual(0.5);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

test('background work: an idle fill tab with a live workflow withholds close until it completes', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-workflow-fill-close-blocked-'),
  );
  const chatId = 'provider-workflow-fill-close-blocked';
  const keeperId = 'provider-workflow-fill-close-keeper';
  const taskId = 'provider-workflow-fill-close-task';
  const toolUseId = 'provider-workflow-fill-close-tool';
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      { id: chatId, title: 'Workflow task' },
      { id: keeperId, title: 'Keeper' },
    ],
    activeTabId: chatId,
  });
  seedEarlyAccess({ userDataDir });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const panelId = `panel-chat-${chatId}`;
    const tab = window.getByTestId(`panel-tab-${panelId}`);
    const close = window.getByTestId(`panel-tab-close-${panelId}`);
    await expect(tab).toBeVisible({ timeout: 30_000 });
    const { inject } = await startIdleChatWithTask(electronApp, window, {
      chatId,
      taskId,
      toolUseId,
      taskType: 'local_workflow',
    });

    // 38c names background work on the image wrapper; its inner spinner
    // retains "Thinking", but this is not the foreground turn indicator.
    await expect(
      // The tab icon is aria-hidden, so match the glyph's label directly.
      tab.locator('[role="img"][aria-label$="background task running"]'),
    ).toHaveCount(1);
    await expect(
      tab.locator('[role="img"] [aria-label="Thinking"]'),
    ).toHaveCount(1);
    await expect(tab.locator('[aria-label="Thinking"]')).toHaveCount(1);
    await withHover(window, panelId, async () => {
      await expect(close).toBeHidden({ timeout: 2_000 });
    });

    await inject({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: toolUseId,
      status: 'completed',
    });
    await expect
      .poll(
        () =>
          window.evaluate(
            async ({ projectId, worktreeId, targetChatId, targetTaskId }) => {
              const snapshot = await window.api.activity.listLiveBgTasks({
                projectId,
                worktreeId,
              });
              return (
                snapshot.chats[targetChatId]?.liveTasks?.some(
                  (task) => task.taskId === targetTaskId,
                ) ?? false
              );
            },
            {
              projectId: WORKSPACE_ID,
              worktreeId: WORKTREE_ID,
              targetChatId: chatId,
              targetTaskId: taskId,
            },
          ),
        { timeout: 30_000 },
      )
      .toBe(false);
    await withHover(window, panelId, async () => {
      await expect(close).toBeVisible({ timeout: 2_000 });
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('background work: an idle fill tab with only a live local_bash task offers close', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-bash-fill-close-allowed-'),
  );
  const chatId = 'local-bash-fill-close-allowed';
  const keeperId = 'local-bash-fill-close-keeper';
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      { id: chatId, title: 'Shell task' },
      { id: keeperId, title: 'Keeper' },
    ],
    activeTabId: chatId,
  });
  seedEarlyAccess({ userDataDir });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const panelId = `panel-chat-${chatId}`;
    const tab = window.getByTestId(`panel-tab-${panelId}`);
    const close = window.getByTestId(`panel-tab-close-${panelId}`);
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await startIdleChatWithTask(electronApp, window, {
      chatId,
      taskId: 'local-bash-fill-close-task',
      toolUseId: 'local-bash-fill-close-tool',
      taskType: 'local_bash',
    });

    await expect(
      // The tab icon is aria-hidden, so match the glyph's label directly.
      tab.locator('[role="img"][aria-label$="background task running"]'),
    ).toHaveCount(1);
    await expect(
      tab.locator('[role="img"] [aria-label="Thinking"]'),
    ).toHaveCount(1);
    await expect(tab.locator('[aria-label="Thinking"]')).toHaveCount(1);
    await withHover(window, panelId, async () => {
      await expect(close).toBeVisible({ timeout: 2_000 });
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// A fill tab draws unread as its trailing dot, so its background spinner keeps
// the quiet ink while the tab is unread.
test('background work: an unread idle fill tab keeps its quiet spinner and shows the unread dot', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-background-fill-unread-'),
  );
  const chatId = 'background-fill-unread';
  const keeperId = 'background-fill-unread-keeper';
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      { id: chatId, title: 'Background task' },
      { id: keeperId, title: 'Keeper' },
    ],
    activeTabId: chatId,
  });
  seedEarlyAccess({ userDataDir });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const tab = window.getByTestId(`panel-tab-panel-chat-${chatId}`);
    const keeper = window.getByTestId(`panel-tab-panel-chat-${keeperId}`);
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await startIdleChatWithTask(electronApp, window, {
      chatId,
      taskId: 'background-fill-unread-task',
      toolUseId: 'background-fill-unread-tool',
      taskType: 'local_bash',
    });

    const glyph = tab.locator(
      '[role="img"][aria-label="1 background task running"]',
    );
    const spinner = glyph.locator('[aria-label="Thinking"]');
    const unreadDot = window.getByTestId(`panel-tab-unread-dot-${chatId}`);
    await expect(glyph).toHaveCount(1);
    await expect(spinner).toHaveClass(/(^|\s)fg-tertiary(\s|$)/);
    await expect(unreadDot).toHaveCount(0);

    await tab.click({ button: 'right' });
    await expect(window.getByTestId('panel-tab-context-menu')).toBeVisible();
    await window.getByTestId('panel-tab-context-mark-unread').click();
    await expect(window.getByTestId('panel-tab-context-menu')).toBeHidden();

    await expect(unreadDot).toBeVisible();
    await expect(glyph).toHaveCount(1);
    await expect(spinner).toHaveClass(/(^|\s)fg-tertiary(\s|$)/);
    await expect(spinner).not.toHaveClass(/(^|\s)fg-info(\s|$)/);

    await keeper.click();
    await expect(keeper).toHaveAttribute('aria-selected', 'true');
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(unreadDot).toHaveCount(0);
    await expect(glyph).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
