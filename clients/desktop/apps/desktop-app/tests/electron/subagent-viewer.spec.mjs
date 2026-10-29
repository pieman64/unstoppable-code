import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  seedSubagentViewerTreeChat,
  SUBAGENT_VIEWER_CHAT_ID,
  SUBAGENT_VIEWER_FAILED_RUN_TEXT,
  SUBAGENT_VIEWER_TREE_IDS,
  SUBAGENT_VIEWER_TREE_TITLES,
} from './seeders/subagentViewerCapture.mjs';
import { expectLongDetailsScrollWithinPanel } from './subagentViewerDetails.mjs';
import {
  ACTIVITY_CHAT_ID,
  injectActivityEvents,
  openActivityChat,
  seedActivityChat,
} from './codexSubagentActivity.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';
import {
  seedSubagentViewerLongListChat,
  SUBAGENT_VIEWER_LONG_LIST_CHAT_ID,
  SUBAGENT_VIEWER_LONG_LIST_COUNT,
} from './seeders/subagentViewerLongList.mjs';
import {
  seedSubagentViewerWorkflowChat,
  SUBAGENT_VIEWER_WORKFLOW_CHAT_ID,
  SUBAGENT_VIEWER_WORKFLOW_CHAT_TITLE,
  SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT,
  SUBAGENT_VIEWER_WORKFLOW_RUNS,
} from './seeders/subagentViewerWorkflow.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const ROOT_SEND_SCENARIO = 'Canopy-CSUBAGENTVIEWERSEND';
const ROOT_SEND_REPLY = 'Root replied through the deterministic mock provider';
/** The seeded root chat's title (seedSubagentViewerTreeChat). */
const SUBAGENT_VIEWER_ROOT_TITLE = 'Demo parser subagent tree';

function seedViewerFixture(userDataDir) {
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedSubagentViewerTreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
  });
  return demo;
}

async function openRootChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  return { app, panel, window };
}

async function openSubagentsFromMenu(window) {
  await window.getByTestId('panel-add-panel-group-chat').click();
  const menu = window.getByTestId('panel-add-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('panel-add-menu-item-subagents').click();
  const panel = window.getByTestId('panel-content-subagents');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('subagents-panel')).toBeVisible();
  await expect(panel.getByTestId('subagents-root-picker')).toBeVisible();
  return panel;
}

function subagentChatFor(window, subagentId) {
  const titleEntry = Object.entries(SUBAGENT_VIEWER_TREE_IDS).find(
    ([, id]) => id === subagentId,
  );
  if (!titleEntry) {
    throw new Error(`No seeded subagent title exists for ${subagentId}`);
  }
  const title = SUBAGENT_VIEWER_TREE_TITLES[titleEntry[0]];
  return window.getByTestId('subagent-chat-panel').filter({
    // The banner has test IDs for the root and ancestors, but the current
    // subagent is a final <nav> span with its title (no self breadcrumb ID).
    has: window.locator(
      `[data-testid="subagent-chat-banner"] nav > span[title="${title}"]`,
    ),
  });
}

test('opens Subagents from the add menu and browses the seeded root tree', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedViewerFixture(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { window } = await openRootChat(electronApp);
    const panel = await openSubagentsFromMenu(window);

    await panel.getByTestId('subagents-root-picker').click();
    const rootOption = window.getByTestId(
      `subagents-root-option-${SUBAGENT_VIEWER_CHAT_ID}`,
    );
    await expect(rootOption).toBeVisible();
    await rootOption.click();

    await expect(panel.getByTestId('subagents-tree')).toBeVisible();
    await panel.getByTestId('subagents-view-list').click();
    await expect(panel.getByTestId('subagents-list')).toBeVisible();
    await panel.getByTestId('subagents-view-tree').click();
    await expect(panel.getByTestId('subagents-tree')).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('opens the seeded tree from View tree in Agent activity', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedViewerFixture(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { panel: rootPanel, window } = await openRootChat(electronApp);
    const activity = rootPanel.getByTestId('agent-activity-active');
    await expect(activity).toBeVisible();
    // Subagents view is off by default: no running count in the top bar.
    await expect(
      window
        .getByTestId('pr-status-bar')
        .getByTestId('running-subagents-button'),
    ).toHaveCount(0);
    const viewTree = activity.getByTestId('agent-activity-view-tree');
    await expect(viewTree).toBeVisible();
    await viewTree.click();

    const subagents = window.getByTestId('panel-content-subagents');
    await expect(subagents).toBeVisible();
    await expect(subagents.getByTestId('subagents-panel')).toBeVisible();
    await subagents.getByTestId('subagents-root-picker').click();
    const rootOption = window.getByTestId(
      `subagents-root-option-${SUBAGENT_VIEWER_CHAT_ID}`,
    );
    await expect(rootOption).toBeVisible();
    await rootOption.click();
    await expect(subagents.getByTestId('subagents-tree')).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('Subagents view: the top bar counts running subagents and opens Subagents on this chat', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedViewerFixture(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { panel: rootPanel, window } = await openRootChat(electronApp);
    // Settings → Labs → Subagents view; off by default.
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'subagents-view',
        enabled: true,
      }),
    );
    // Nothing is pinned above the composer under the view.
    await expect(rootPanel.getByTestId('agent-activity-active')).toHaveCount(0);
    const running = window
      .getByTestId('pr-status-bar')
      .getByTestId('running-subagents-button');
    // The count follows main's live delegation activity (the seeded tree is
    // only a transcript), so this pushes what main sends while six run.
    await expect(running).toHaveCount(0);
    await electronApp.evaluate(
      ({ BrowserWindow }, activity) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('managed-delegation:activity-changed', activity);
        }
      },
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: SUBAGENT_VIEWER_CHAT_ID,
        live: 5,
        queued: 1,
      },
    );
    await expect(running).toBeVisible();
    await expect(running).toHaveText('6 running');
    await expect(running.locator('.canopy-text-shimmer')).toHaveCount(1);
    if (process.env.SUBAGENTS_TOP_BAR_CAPTURE) {
      await window.screenshot({ path: process.env.SUBAGENTS_TOP_BAR_CAPTURE });
    }

    await running.click();
    const subagents = window.getByTestId('panel-content-subagents');
    await expect(subagents).toBeVisible();
    await expect(subagents.getByTestId('subagents-panel')).toBeVisible();
    // It opens beside the chat, not in the chat's own group.
    await expect(
      window
        .getByTestId('panel-group-group-chat')
        .getByTestId('panel-content-subagents'),
    ).toHaveCount(0);
    // On the current chat, filtered to Active, in the one-row toolbar.
    await expect(subagents.getByTestId('subagents-root-picker')).toContainText(
      SUBAGENT_VIEWER_ROOT_TITLE,
    );
    await expect(
      subagents.getByTestId('subagents-filter-active'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(subagents.getByTestId('subagents-view-list')).toHaveAttribute(
      'aria-label',
      'List',
    );
    if (process.env.SUBAGENTS_TOP_BAR_CAPTURE) {
      await window.screenshot({
        path: process.env.SUBAGENTS_TOP_BAR_CAPTURE.replace(
          /\.png$/,
          '-open.png',
        ),
      });
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('Active and Needs attention filters project live descendants and failures', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedViewerFixture(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { window } = await openRootChat(electronApp);
    const panel = await openSubagentsFromMenu(window);
    await panel.getByTestId('subagents-view-list').click();

    await panel.getByTestId('subagents-filter-active').click();
    await expect(
      panel.getByTestId(
        `subagents-list-row-${SUBAGENT_VIEWER_TREE_IDS.idleParent}`,
      ),
    ).toHaveCount(0);
    const liveChild = panel.getByTestId(
      `subagents-list-row-${SUBAGENT_VIEWER_TREE_IDS.liveChild}`,
    );
    await expect(liveChild).toBeVisible();
    await expect(liveChild).toContainText('via Finished parser review');
    await panel.getByTestId('subagents-view-tree').click();
    await expect(
      panel
        .getByTestId('subagents-canvas')
        .getByText('via Finished parser review'),
    ).toBeVisible();

    await panel.getByTestId('subagents-filter-attention').click();
    await panel.getByTestId('subagents-view-list').click();
    await expect(
      panel.getByTestId(
        `subagents-list-row-${SUBAGENT_VIEWER_TREE_IDS.failed}`,
      ),
    ).toBeVisible();
    await expect(
      panel.getByTestId(
        `subagents-list-row-${SUBAGENT_VIEWER_TREE_IDS.liveChild}`,
      ),
    ).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('managed activity and managed/native transcript cards open their chats', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedViewerFixture(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { panel: rootPanel, window } = await openRootChat(electronApp);
    const activity = rootPanel.getByTestId('agent-activity-active');
    await expect(
      activity.getByTestId('agent-activity-view-tree'),
    ).toBeVisible();

    const managedActivityCard = activity.locator(
      `[data-testid="chat-delegated-agent"][data-delegation-id="${SUBAGENT_VIEWER_TREE_IDS.liveChild}"]`,
    );
    await expect(managedActivityCard).toBeVisible();
    await managedActivityCard
      .getByRole('button', { name: 'Expand delegated task' })
      .click();
    await managedActivityCard.getByTestId('agent-card-open-chat').click();
    await expect(
      subagentChatFor(window, SUBAGENT_VIEWER_TREE_IDS.liveChild),
    ).toBeVisible();

    // The settled root turn keeps its delegation and native agent cards in the
    // collapsed "Agent steps" row; expand it before looking for those cards.
    const transcript = rootPanel.getByTestId('chat-message-list-content');
    await transcript
      .getByRole('button', { name: /^Agent steps:/, expanded: false })
      .first()
      .click();
    const managedTranscriptCard = transcript.locator(
      `[data-testid="chat-delegated-agent"][data-delegation-id="${SUBAGENT_VIEWER_TREE_IDS.idleParent}"]`,
    );
    await expect(managedTranscriptCard).toBeVisible();
    await managedTranscriptCard
      .getByRole('button', { name: 'Expand delegated task' })
      .click();
    await managedTranscriptCard.getByTestId('agent-card-open-chat').click();
    await expect(
      subagentChatFor(window, SUBAGENT_VIEWER_TREE_IDS.idleParent),
    ).toBeVisible();

    // The seeded native Claude Agent has a final result and is intentionally
    // historical rather than live activity; its transcript card still offers
    // Open chat. Activity coverage above targets a managed live delegation.
    const nativeTranscriptCard = transcript
      .getByTestId('agent-block')
      .filter({ hasText: 'Review the native parser card' });
    await expect(nativeTranscriptCard).toBeVisible();
    await nativeTranscriptCard.locator('button[aria-expanded]').first().click();
    // Expanded, the card header shows "Agent · Explore" instead of the
    // description, so address the only native card's action directly.
    const nativeOpenChat = transcript
      .getByTestId('agent-block')
      .getByTestId('agent-card-open-chat');
    await expect(nativeOpenChat).toHaveCount(1);
    await nativeOpenChat.click();
    await expect(
      subagentChatFor(window, SUBAGENT_VIEWER_TREE_IDS.native),
    ).toBeVisible();
    await expect(rootPanel).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('inspector opens a lineage-aware chat; To order, Interrupt gating, and root send work', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedViewerFixture(userDataDir);
  let electronApp;
  try {
    await registerScenario(DEFAULT_MOCK_BASE_URL, ROOT_SEND_SCENARIO, {
      llm: {
        steps: [{ text: ROOT_SEND_REPLY, stopReason: 'end_turn' }],
      },
    });
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    ));
    const { panel: rootPanel, window } = await openRootChat(electronApp);
    const subagents = await openSubagentsFromMenu(window);
    await subagents.getByTestId('subagents-view-list').click();
    await subagents
      .getByTestId(
        `subagents-list-select-${SUBAGENT_VIEWER_TREE_IDS.liveGrandchild}`,
      )
      .click();
    const inspector = subagents.getByTestId('subagents-inspector');
    await expect(inspector).toBeVisible();
    await inspector.getByTestId('subagents-inspector-open-chat').click();

    const chat = subagentChatFor(
      window,
      SUBAGENT_VIEWER_TREE_IDS.liveGrandchild,
    );
    await expect(chat).toBeVisible();
    // Subagents was added as a tab in the root chat's group, so the root chat
    // stays open behind it while the subagent chat opens in a group beside it.
    await expect(rootPanel).toBeAttached();
    await expect(window.getByTestId('subagents-panel')).toBeVisible();
    const banner = chat.getByTestId('subagent-chat-banner');
    await expect(
      banner.getByTestId(`subagent-chat-breadcrumb-${SUBAGENT_VIEWER_CHAT_ID}`),
    ).toBeVisible();
    await expect(
      banner.getByTestId(
        `subagent-chat-breadcrumb-${SUBAGENT_VIEWER_TREE_IDS.liveChild}`,
      ),
    ).toBeVisible();
    await expect(
      banner.getByTestId(
        `subagent-chat-breadcrumb-${SUBAGENT_VIEWER_TREE_IDS.idleParent}`,
      ),
    ).toBeVisible();
    await banner.getByTestId('subagent-chat-details-toggle').click();
    await expect(chat.getByTestId('subagent-chat-details-setup')).toBeVisible();
    await expect(
      chat.getByTestId('subagent-chat-details-lineage'),
    ).toBeVisible();
    await expectLongDetailsScrollWithinPanel(chat);

    const composer = chat.getByTestId('subagent-composer');
    await expect(
      composer.getByTestId('subagent-composer-interrupt'),
    ).toBeVisible();
    await composer.getByTestId('subagent-composer-to').click();
    const recipientOptions = window.locator(
      '[data-testid^="subagent-composer-to-option-"]',
    );
    await expect(recipientOptions).toHaveCount(4);
    await expect
      .poll(() =>
        recipientOptions.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-testid')),
        ),
      )
      .toEqual([
        `subagent-composer-to-option-${SUBAGENT_VIEWER_TREE_IDS.liveGrandchild}`,
        `subagent-composer-to-option-${SUBAGENT_VIEWER_TREE_IDS.liveChild}`,
        `subagent-composer-to-option-${SUBAGENT_VIEWER_TREE_IDS.idleParent}`,
        `subagent-composer-to-option-${SUBAGENT_VIEWER_CHAT_ID}`,
      ]);
    await recipientOptions.nth(1).click();
    await expect(
      composer.getByTestId('subagent-composer-interrupt'),
    ).toHaveCount(0);

    await composer.getByTestId('subagent-composer-to').click();
    await window
      .getByTestId(
        `subagent-composer-to-option-${SUBAGENT_VIEWER_TREE_IDS.liveGrandchild}`,
      )
      .click();
    await expect(
      composer.getByTestId('subagent-composer-interrupt'),
    ).toBeVisible();
    const input = composer.getByTestId('subagent-composer-input');
    await input.fill('A non-empty draft hides Interrupt.');
    await expect(
      composer.getByTestId('subagent-composer-interrupt'),
    ).toHaveCount(0);
    await expect(composer.getByTestId('subagent-composer-send')).toBeVisible();
    await input.fill('');

    await composer.getByTestId('subagent-composer-to').click();
    await window
      .getByTestId(`subagent-composer-to-option-${SUBAGENT_VIEWER_CHAT_ID}`)
      .click();
    await expect(
      composer.getByTestId('subagent-composer-interrupt'),
    ).toHaveCount(0);
    const userMessage = `[${ROOT_SEND_SCENARIO}] Please review this delegate from the root chat.`;
    await input.fill(userMessage);
    await composer.getByTestId('subagent-composer-send').click();

    await expect(rootPanel.getByTestId('subagent-reference-chip')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      rootPanel.getByText('Please review this delegate from the root chat.'),
    ).toBeVisible();
    await expect(rootPanel.getByText(ROOT_SEND_REPLY)).toBeVisible({
      timeout: 90_000,
    });
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      cleanupDemoWorkspaces(demo);
      await clearScenario(DEFAULT_MOCK_BASE_URL, ROOT_SEND_SCENARIO).catch(
        () => {},
      );
    }
  }
});

test('isolated delegate shows retained worktree status and a completed self has no Interrupt', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedViewerFixture(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { window } = await openRootChat(electronApp);
    const subagents = await openSubagentsFromMenu(window);
    await subagents.getByTestId('subagents-view-list').click();
    await subagents
      .getByTestId(`subagents-list-open-${SUBAGENT_VIEWER_TREE_IDS.isolated}`)
      .click();

    const chat = subagentChatFor(window, SUBAGENT_VIEWER_TREE_IDS.isolated);
    await expect(chat).toBeVisible();
    const composer = chat.getByTestId('subagent-composer');
    await expect(
      composer.getByTestId('subagent-composer-interrupt'),
    ).toHaveCount(0);
    await chat.getByTestId('subagent-chat-details-toggle').click();
    const worktree = chat.getByTestId('subagent-chat-details-worktree');
    await expect(worktree).toBeVisible();
    // The fake record has an isolated revision but intentionally no checkout;
    // the real read-only summary must report the missing checkout, not an error.
    await expect(worktree).toContainText('Isolated · missing');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('a followed-up delegate keeps every run, and a watcher run hides its payload', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedViewerFixture(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { window } = await openRootChat(electronApp);
    const subagents = await openSubagentsFromMenu(window);
    await subagents.getByTestId('subagents-view-list').click();

    // The list starts at the root chat's subagents, and a parent's toggle
    // hides and shows its children.
    await expect(subagents.getByTestId('subagents-list-root')).toHaveCount(0);
    const parentToggle = subagents.getByTestId(
      `subagents-list-toggle-${SUBAGENT_VIEWER_TREE_IDS.idleParent}`,
    );
    const childRow = subagents.getByTestId(
      `subagents-list-row-${SUBAGENT_VIEWER_TREE_IDS.liveChild}`,
    );
    await expect(parentToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(childRow).toBeVisible();
    await parentToggle.click();
    await expect(parentToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(childRow).toHaveCount(0);
    await parentToggle.click();
    await expect(childRow).toBeVisible();

    // Show changes diffs an isolated delegate's own checkout, so a delegate
    // that shared the parent's worktree has none.
    await subagents
      .getByTestId(`subagents-list-row-${SUBAGENT_VIEWER_TREE_IDS.failed}`)
      .click();
    await expect(subagents.getByTestId('subagents-inspector')).toBeVisible();
    await expect(
      subagents.getByTestId('subagents-inspector-show-changes'),
    ).toHaveCount(0);
    await subagents
      .getByTestId(`subagents-list-row-${SUBAGENT_VIEWER_TREE_IDS.isolated}`)
      .click();
    await expect(
      subagents.getByTestId('subagents-inspector-show-changes'),
    ).toBeVisible();

    await subagents
      .getByTestId(`subagents-list-open-${SUBAGENT_VIEWER_TREE_IDS.failed}`)
      .click();
    const chat = subagentChatFor(window, SUBAGENT_VIEWER_TREE_IDS.failed);
    await expect(chat).toBeVisible();
    await expect(chat).toContainText(SUBAGENT_VIEWER_FAILED_RUN_TEXT.first);
    await expect(chat).toContainText(
      'Delegate watch completed watcher has fired',
    );
    await expect(chat).toContainText(
      SUBAGENT_VIEWER_FAILED_RUN_TEXT.watcherLabel,
    );
    await expect(chat).toContainText(SUBAGENT_VIEWER_FAILED_RUN_TEXT.watcher);
    await expect(chat).toContainText(SUBAGENT_VIEWER_FAILED_RUN_TEXT.followUp);
    await expect(chat).toContainText('Run 2');
    await expect(chat).toContainText('Run 3');
    await expect(chat).not.toContainText('system_instruction');
    await expect(chat).not.toContainText('subagent-viewer-watcher');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('a long Subagents list keeps full-height rows and scrolls', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedSubagentViewerLongListChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { window } = await openRootChat(electronApp);
    const panel = await openSubagentsFromMenu(window);
    await panel.getByTestId('subagents-root-picker').click();
    await window
      .getByTestId(`subagents-root-option-${SUBAGENT_VIEWER_LONG_LIST_CHAT_ID}`)
      .click();
    await panel.getByTestId('subagents-view-list').click();
    const list = panel.getByTestId('subagents-list');
    await expect(list).toBeVisible();
    const rows = list.locator('[data-testid^="subagents-list-row-"]');
    await expect(rows).toHaveCount(SUBAGENT_VIEWER_LONG_LIST_COUNT);

    // Rows are `h-9` (2.25rem). When they overflow the panel they must keep
    // that height and the list must scroll, not squeeze every row to fit.
    const layout = await list.evaluate((element) => {
      const rootFontSize = Number.parseFloat(
        getComputedStyle(element.ownerDocument.documentElement).fontSize,
      );
      const rowElements = Array.from(
        element.querySelectorAll('[data-testid^="subagents-list-row-"]'),
      );
      const scroller = rowElements[0]?.parentElement ?? null;
      return {
        expectedRowHeight: rootFontSize * 2.25,
        rowHeights: rowElements.map((row) =>
          Number.parseFloat(getComputedStyle(row).height),
        ),
        scrollHeight: scroller?.scrollHeight ?? 0,
        clientHeight: scroller?.clientHeight ?? 0,
      };
    });
    for (const height of layout.rowHeights) {
      expect(height).toBeCloseTo(layout.expectedRowHeight, 0);
    }
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

const FINISHED_RUN_ID = SUBAGENT_VIEWER_WORKFLOW_RUNS.finished.runId;
const RUNNING_RUN_ID = SUBAGENT_VIEWER_WORKFLOW_RUNS.running.runId;
const OPEN_AGENT_NODE_ID = `workflow-agent:${SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.runId}:${SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.agentId}`;
const OPEN_AGENT_PHASE_NODE_ID = `workflow-phase:${SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.runId}:${encodeURIComponent(SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.phase)}`;
const FINISHED_FIRST_PHASE_NODE_ID = `workflow-phase:${SUBAGENT_VIEWER_WORKFLOW_RUNS.finished.runId}:${encodeURIComponent(SUBAGENT_VIEWER_WORKFLOW_RUNS.finished.phases[0])}`;

function seedWorkflowFixture(userDataDir) {
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedSubagentViewerWorkflowChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
  });
  return demo;
}

async function openWorkflowRoot(electronApp) {
  const { window } = await openRootChat(electronApp);
  const panel = await openSubagentsFromMenu(window);
  await panel.getByTestId('subagents-root-picker').click();
  const rootOption = window.getByTestId(
    `subagents-root-option-${SUBAGENT_VIEWER_WORKFLOW_CHAT_ID}`,
  );
  await expect(rootOption).toBeVisible({ timeout: 15_000 });
  await rootOption.click();
  return { panel, window };
}

test('workflow runs show as run, phase and agent nodes, and a finished run starts folded', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedWorkflowFixture(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { panel, window } = await openWorkflowRoot(electronApp);

    const tree = panel.getByTestId('subagents-tree');
    await expect(tree).toBeVisible();
    await expect(
      tree.getByTestId(`subagents-tree-node-workflow-run:${RUNNING_RUN_ID}`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      tree.getByTestId(`subagents-tree-node-workflow-run:${FINISHED_RUN_ID}`),
    ).toBeVisible();

    // The running run is open: its phases are on the canvas.
    await expect(
      tree.getByTestId(`subagents-tree-node-${OPEN_AGENT_PHASE_NODE_ID}`),
    ).toBeVisible();

    // The finished run starts folded behind a stub.
    const finishedStub = tree.getByTestId(
      `subagents-tree-stub-workflow-run:${FINISHED_RUN_ID}`,
    );
    await expect(finishedStub).toBeVisible();
    await expect(
      tree.getByTestId(`subagents-tree-node-${FINISHED_FIRST_PHASE_NODE_ID}`),
    ).toHaveCount(0);

    // List: both runs are rows; the folded run hides its agents.
    await panel.getByTestId('subagents-view-list').click();
    const list = panel.getByTestId('subagents-list');
    await expect(list).toBeVisible();
    await expect(
      list.getByTestId(`subagents-list-row-workflow-run:${FINISHED_RUN_ID}`),
    ).toBeVisible();
    await expect(
      list.getByTestId(`subagents-list-row-workflow-run:${RUNNING_RUN_ID}`),
    ).toBeVisible();
    await expect(
      list.getByTestId(`subagents-list-row-${OPEN_AGENT_NODE_ID}`),
    ).toBeVisible();
    await expect(
      list.getByTestId(
        `subagents-list-row-workflow-agent:${FINISHED_RUN_ID}:b770100000000003`,
      ),
    ).toHaveCount(0);

    // Open workflow from the run's inspector shows the workflow view.
    await list
      .getByTestId(`subagents-list-row-workflow-run:${FINISHED_RUN_ID}`)
      .click();
    const inspector = panel.getByTestId('subagents-inspector');
    await expect(inspector).toBeVisible();
    await inspector.getByTestId('subagents-inspector-open-workflow').click();
    const dialog = window.getByTestId('subagent-workflow-dialog');
    await expect(dialog).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Back on the tree, the folded run's stub opens its phases and agents.
    await panel.getByTestId('subagents-view-tree').click();
    await expect(tree).toBeVisible();
    await tree
      .getByTestId(`subagents-tree-stub-workflow-run:${FINISHED_RUN_ID}`)
      .click();
    await expect(
      tree.getByTestId(`subagents-tree-node-${FINISHED_FIRST_PHASE_NODE_ID}`),
    ).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('a workflow agent opens in a read-only subagent chat with its run and phase', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedWorkflowFixture(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { panel, window } = await openWorkflowRoot(electronApp);

    await panel.getByTestId('subagents-view-list').click();
    const openAgent = panel.getByTestId(
      `subagents-list-open-${OPEN_AGENT_NODE_ID}`,
    );
    await expect(openAgent).toBeVisible({ timeout: 15_000 });
    await openAgent.click();

    const chat = window.getByTestId('subagent-chat-panel');
    await expect(chat).toBeVisible();
    const banner = chat.getByTestId('subagent-chat-banner');
    await expect(
      banner.getByTestId(
        `subagent-chat-breadcrumb-${SUBAGENT_VIEWER_WORKFLOW_CHAT_ID}`,
      ),
    ).toBeVisible();
    await expect(
      banner.getByTestId(
        `subagent-chat-breadcrumb-workflow-run:${RUNNING_RUN_ID}`,
      ),
    ).toBeVisible();
    await expect(
      banner.getByTestId(
        `subagent-chat-breadcrumb-${OPEN_AGENT_PHASE_NODE_ID}`,
      ),
    ).toBeVisible();
    await expect(
      banner.locator(
        `nav > span[title="${SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.label}"]`,
      ),
    ).toBeVisible();

    // The agent's own transcript loads: its task and its final answer.
    await expect(chat).toContainText(SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.task, {
      timeout: 15_000,
    });
    await expect(chat).toContainText(
      SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.result,
    );

    await banner.getByTestId('subagent-chat-details-toggle').click();
    await expect(
      chat.getByTestId('subagent-chat-details-workflow'),
    ).toBeVisible();
    await expect(chat.getByTestId('subagent-chat-details-cost')).toHaveCount(0);

    // Workflow agents are read-only: the composer targets the root chat.
    const composer = chat.getByTestId('subagent-composer');
    await expect(composer).toBeVisible();
    await expect(
      composer.getByTestId('subagent-composer-interrupt'),
    ).toHaveCount(0);
    const to = composer.getByTestId('subagent-composer-to');
    await expect(to).toContainText(SUBAGENT_VIEWER_WORKFLOW_CHAT_TITLE);
    await to.click();
    const options = window.locator(
      '[data-testid^="subagent-composer-to-option-"]',
    );
    await expect(options).toHaveCount(1);
    await expect(
      window.getByTestId(
        `subagent-composer-to-option-${SUBAGENT_VIEWER_WORKFLOW_CHAT_ID}`,
      ),
    ).toBeVisible();
    await window.keyboard.press('Escape');

    // The breadcrumb's run opens the Subagents panel focused on that run.
    await banner
      .getByTestId(`subagent-chat-breadcrumb-workflow-run:${RUNNING_RUN_ID}`)
      .click();
    await expect(window.getByTestId('panel-content-subagents')).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

// CAN-4051: a failed Claude subagent carries its error, and a background one
// settles when its process ends, not at its launch receipt.
test('a failed Claude subagent shows its error and a background one settles when it ends', async () => {
  test.setTimeout(180_000);
  const chatId = 'claude-subagent-outcomes';
  const failedId = 'toolu_fix_date_test';
  const backgroundId = 'toolu_watch_logs';
  const failure = 'Could not make test/date.test.ts pass without changing it.';
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Fix and watch', providerType: 'claude' }],
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { window } = await openRootChat(electronApp);
    const inject = (data) =>
      injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId,
        providerType: 'claude',
        data,
      });
    const spawn = (uuid, id, input) =>
      inject({
        type: 'assistant',
        uuid,
        message: {
          id: `msg-${uuid}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'tool_use', id, name: 'Agent', input }],
        },
      });
    const result = (uuid, toolUseId, content, isError) =>
      inject({
        type: 'user',
        uuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content,
              ...(isError ? { is_error: true } : {}),
            },
          ],
        },
      });
    const task = (subtype, taskId, toolUseId, fields) =>
      inject({
        type: 'system',
        subtype,
        task_id: taskId,
        tool_use_id: toolUseId,
        ...fields,
      });

    await inject({
      type: 'canopy_user_prompt',
      original_text: 'Fix the date test and watch the dev server logs.',
      user_message_id: 'user-outcomes-1',
    });
    await spawn('outcomes-1', failedId, {
      subagent_type: 'general-purpose',
      description: 'Fix the date test',
      prompt: 'Make test/date.test.ts pass.',
    });
    await task('task_started', 'task-fix', failedId, {
      description: 'Fix the date test',
      is_backgrounded: false,
    });
    await result('outcomes-2', failedId, failure, true);
    await spawn('outcomes-3', backgroundId, {
      subagent_type: 'general-purpose',
      description: 'Watch the dev server logs',
      prompt: 'Report the first request.',
      run_in_background: true,
    });
    await task('task_started', 'task-watch', backgroundId, {
      description: 'Watch the dev server logs',
      is_backgrounded: true,
    });
    await result(
      'outcomes-4',
      backgroundId,
      'Async agent launched successfully.\nagentId: task-watch',
      false,
    );
    // The background agent runs for a few seconds after its launch receipt.
    await window.waitForTimeout(3_000);
    await task('task_notification', 'task-watch', backgroundId, {
      status: 'completed',
      summary: 'The first request was GET /health.',
    });
    await inject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: 'claude-outcomes-session',
    });

    const subagents = await openSubagentsFromMenu(window);
    await subagents.getByTestId('subagents-root-picker').click();
    await window.getByTestId(`subagents-root-option-${chatId}`).click();
    await subagents.getByTestId('subagents-view-list').click();
    const watcher = subagents.getByTestId(`subagents-list-row-${backgroundId}`);
    await expect(watcher).toContainText('Done');
    // Its run spans the work after the receipt, and stops counting at the end.
    const elapsed = watcher.getByRole('gridcell').filter({ hasText: /^\d+s$/ });
    await expect(elapsed).toHaveText(/^([3-9]|\d{2})s$/);
    const settled = await elapsed.innerText();
    await window.waitForTimeout(2_000);
    await expect(elapsed).toHaveText(settled);

    const failed = subagents.getByTestId(`subagents-list-row-${failedId}`);
    await expect(failed).toContainText('Failed');
    await subagents.getByTestId(`subagents-list-open-${failedId}`).click();
    const banner = window
      .getByTestId('subagent-chat-panel')
      .getByTestId('subagent-chat-banner');
    await expect(banner).toContainText('Failed');
    await expect(banner).toContainText(failure);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

// CAN-4049: the Codex follow-up calls and child turns the cloud fold mirrors.
// Wait, sendInput, resumeAgent and closeAgent refresh the cards their
// receivers belong to, and a child that settles and starts again keeps its
// card and tree node.
test('Codex follow-ups and a reopened child keep the same cards and tree nodes', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'subagent-viewer-'));
  seedActivityChat(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const { panel: chat, window } = await openActivityChat(electronApp);
    await injectActivityEvents(electronApp);
    const inject = (event) =>
      injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: ACTIVITY_CHAT_ID,
        data: { type: 'codex', event },
      });
    const collab = (threadId, id, tool, receivers, states) =>
      inject({
        type: 'item.completed',
        thread_id: threadId,
        turn_id: `${threadId}-turn`,
        item: {
          id,
          type: 'collab_agent_tool_call',
          tool,
          status: 'completed',
          sender_thread_id: threadId,
          receiver_thread_ids: receivers,
          prompt: tool === 'sendInput' ? 'Check the install notes too.' : '',
          agents_states: states,
        },
      });
    const turn = (threadId, type) =>
      inject({ type, thread_id: threadId, turn_id: `${threadId}-reopen` });

    const research = chat.getByRole('button', { name: /Agent · Tesla/ });
    await expect(research).toBeVisible();
    const cards = chat.getByTestId('agent-block');
    await expect(cards).toHaveCount(1);
    await research.click();
    const desktop = chat.getByRole('button', { name: /Agent · Raman/ });
    await expect(desktop).toBeVisible();
    await expect(cards).toHaveCount(2);

    const subagents = await openSubagentsFromMenu(window);
    await subagents.getByTestId('subagents-root-picker').click();
    await window
      .getByTestId(`subagents-root-option-${ACTIVITY_CHAT_ID}`)
      .click();
    const nodes = subagents.locator('[data-testid^="subagents-tree-node-"]');
    const researchNode = subagents.getByTestId('subagents-tree-node-research');
    const desktopNode = subagents.getByTestId('subagents-tree-node-desktop');
    await expect(nodes).toHaveCount(2);
    await expect(researchNode).toContainText('Tesla');
    await expect(desktopNode).toContainText('Raman');
    await expect(researchNode).toContainText('Done');
    // The list keeps every row on screen while the states change.
    await subagents.getByTestId('subagents-view-list').click();
    const rows = subagents.locator('[data-testid^="subagents-list-row-"]');
    const researchRow = subagents.getByTestId('subagents-list-row-research');
    const desktopRow = subagents.getByTestId('subagents-list-row-desktop');
    await expect(rows).toHaveCount(2);

    // Follow-ups, one of them multi-receiver and one issued by a child.
    await collab('root', 'wait-both', 'wait', ['research', 'desktop'], {
      research: { status: 'completed', message: null },
      desktop: { status: 'completed', message: null },
    });
    await collab('research', 'send-desktop', 'sendInput', ['desktop'], {
      desktop: { status: 'running', message: null },
    });
    await expect(desktopRow).toContainText('Running');
    await collab('root', 'resume-desktop', 'resumeAgent', ['desktop'], {
      desktop: { status: 'running', message: null },
    });
    await collab('root', 'close-desktop', 'closeAgent', ['desktop'], {
      desktop: { status: 'shutdown', message: null },
    });
    await expect(desktopRow).toContainText('Interrupted');

    // While the root runs again, the reviewer starts again and settles.
    // Subagents shares the chat's tab group, so switch tabs to see each.
    const chatTab = window.getByTestId(
      `panel-tab-panel-chat-${ACTIVITY_CHAT_ID}`,
    );
    const subagentsTab = window.getByRole('tab', { name: /^Subagents/ });
    const spinner = cards
      .first()
      .getByLabel('Thinking', { exact: true })
      .first();
    await turn('root', 'turn.started');
    await turn('research', 'turn.started');
    await expect(researchRow).toContainText('Running');
    await chatTab.click();
    await expect(spinner).toBeVisible();
    await turn('research', 'turn.completed');
    await expect(spinner).toHaveCount(0);
    await turn('root', 'turn.completed');

    // Same cards, same nodes, same nesting throughout. The tab switch
    // remounted the chat, so the card starts collapsed again.
    await expect(cards).toHaveCount(1);
    await research.click();
    await expect(desktop).toBeVisible();
    await expect(cards).toHaveCount(2);
    await subagentsTab.click();
    await expect(researchRow).toContainText('Done');
    await expect(rows).toHaveCount(2);
    await subagents.getByTestId('subagents-view-tree').click();
    await expect(nodes).toHaveCount(2);
    await subagents.getByTestId('subagents-view-list').click();
    await subagents.getByTestId('subagents-list-select-desktop').click();
    await expect(
      subagents
        .getByTestId('subagents-inspector')
        .or(subagents.getByTestId('subagents-drawer')),
    ).toContainText('Tesla');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
