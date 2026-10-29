import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chatPanelLocator } from './panelHarness.mjs';

// ---------------------------------------------------------------------------
// Archive worktree chats — closing a chat that has sent ≥1 message archives it
// (instead of hard-deleting), surfacing an archive icon left of "+". Hovering
// shows a popover of recently-archived chats; the full modal
// (`archived-chats-modal`) offers Restore / Summarize. Restore brings the chat
// back with its provider session intact. Summarize leaves the archived chat in
// place and opens a fresh active tab with a handoff draft.
//
// Determinism: the send-message leg uses the live composer path but only
// asserts the authored user message; the summarize helper is answered by the
// mock helper fingerprint. Archive / restore / read exercise the real
// main-process IPC handlers.
//
// `restorable` is computed main-side as `createdAt` within the 7-day restore
// window, so the seeded tab's `createdAt` is stamped at real "now" to keep the
// Restore action available whenever this spec runs.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const ARCHIVE_TAB_ID = 'archive-me';
const SUMMARIZE_TAB_ID = 'summarize-me';
const KEEPER_TAB_ID = 'keeper';
const DESCRIBED_TAB_ID = 'described-me';
// A chat whose literal `title` is the command it was created from and whose
// generated summary landed on `description` — the shape that made every
// archive surface read back the raw title instead of the generated one.
const DESCRIBED_RAW_TITLE = '$builtin-gh:handle-pr-checks';
const DESCRIBED_GENERATED_TITLE = 'Handle pull request checks';
const CONVERSATION_MARKER = 'Canopy-CARCHIVE';
const USER_MESSAGE = `[${CONVERSATION_MARKER}] Please record this archive test.`;
const HISTORICAL_ARCHIVE_MARKER =
  'Unique archived historical transcript marker';

const T = Date.parse('2026-04-10T12:00:00.000Z');

// A `user → assistant` pair so the tab has `messages.length > 0` (the renderer
// proxy for "the user sent ≥1 message" that routes close → archive).
function buildMessages(label) {
  return [
    {
      id: `${label}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: `Question for ${label}.` }],
      timestamp: T,
    },
    {
      id: `${label}-assistant`,
      role: 'assistant',
      blocks: [{ type: 'text', text: `Answer for ${label}.` }],
      timestamp: T + 10_000,
    },
  ];
}

function buildLargeArchivedHistory(turnCount = 120) {
  return Array.from({ length: turnCount }, (_, index) => {
    const label = `archive-history-${index + 1}`;
    const messages = buildMessages(label);
    if (index === 0) {
      messages[0].blocks[0].text = [
        'Archived prompt context row one.',
        'Archived prompt context row two.',
        'Archived prompt context row three.',
        'Archived prompt context row four.',
        HISTORICAL_ARCHIVE_MARKER,
      ].join('\n');
    }
    return messages;
  }).flat();
}

// Archived rows are located by their stable `data-archived-chat-id` hook, not
// by text: the row label leads with the generated title, and the UI send in
// the archive test can generate one before the chat is archived.
function archivedChatRow(scope, rowTestId, chatId) {
  return scope.locator(
    `[data-testid="${rowTestId}"][data-archived-chat-id="${chatId}"]`,
  );
}

function buildSeededChat(userDataDir) {
  // Stamp `createdAt` at real "now" so the archived chat stays within the
  // main-process 7-day restore window and the Restore action is offered.
  const nowIso = new Date().toISOString();
  return seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: ARCHIVE_TAB_ID,
    tabs: [
      {
        id: ARCHIVE_TAB_ID,
        title: 'Archive Me',
        providerType: 'claude',
        createdAt: nowIso,
        messages: buildLargeArchivedHistory(),
      },
      {
        id: SUMMARIZE_TAB_ID,
        title: 'Summarize Me',
        providerType: 'claude',
        createdAt: nowIso,
        sdkSessionId: 'claude-session-summarize-me',
        messages: buildLargeArchivedHistory(300),
      },
      {
        id: KEEPER_TAB_ID,
        title: 'Keeper',
        providerType: 'claude',
        createdAt: nowIso,
        messages: buildMessages(KEEPER_TAB_ID),
      },
      {
        id: DESCRIBED_TAB_ID,
        title: DESCRIBED_RAW_TITLE,
        description: DESCRIBED_GENERATED_TITLE,
        providerType: 'claude',
        createdAt: nowIso,
        messages: buildMessages(DESCRIBED_TAB_ID),
      },
    ],
  });
}

// Hand-write `preferences.json` so onboarding is complete and the worktree
// model default resolves in the composer (mirrors chat-transcript-actions).
function seedPreferences(userDataDir) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    preferencesPath,
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'claude',
          defaultChatProvider: 'claude',
          canopyBackgroundProcessesMode: 'canopy',
          // Off-default port so the live composer send never trips the MCP
          // proxy port-in-use error against another running Canopy instance
          // (same rationale as launchCanopy's seeded ephemeral port).
          mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function launchArchiveCanopy() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-archive-'));
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    buildSeededChat(userDataDir);
    const launched = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    return { ...launched, seededUserDataDir: userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }
}

for (const bulk of [false, true]) {
  test(`archives unloaded background chats on close (bulk: ${bulk})`, async () => {
    const { electronApp, seededUserDataDir } = await launchArchiveCanopy();
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const backgroundTab = window.getByTestId(
        `panel-tab-panel-chat-${SUMMARIZE_TAB_ID}`,
      );
      await expect(backgroundTab).toBeVisible();
      // Never select this tab: its history remains deferred when it is closed.
      if (bulk) {
        await window
          .getByTestId(`panel-tab-panel-chat-${ARCHIVE_TAB_ID}`)
          .click({ button: 'right' });
        await window.getByTestId('panel-tab-context-close-others').click();
      } else {
        await closePanelTab(window, `panel-chat-${SUMMARIZE_TAB_ID}`);
      }
      await expect(window.getByTestId('chat-tab-archive-count')).toHaveText(
        bulk ? '3' : '1',
      );
      await expect(backgroundTab).toHaveCount(0);
      await window.getByTestId('chat-tab-archive').click();
      const row = window
        .getByTestId('archived-chats-modal-row')
        .filter({ hasText: 'Summarize Me' });
      await row.getByText('Summarize Me').click();
      const viewer = window.getByTestId('archived-chat-transcript-modal');
      await expect(
        viewer.getByText('Answer for archive-history-300.'),
      ).toBeVisible();
      await viewer.getByTestId('archived-chat-transcript-restore').click();
      await expect(backgroundTab).toBeVisible();
      await expect(
        chatPanelLocator(window).getByText('Answer for archive-history-300.'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, seededUserDataDir);
    }
  });
}

test('archives a worktree chat on close and restores it from the archive modal', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const { electronApp, seededUserDataDir } = await launchArchiveCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // Every open chat tab keeps its content frame mounted (three tabs are
    // seeded), so address the ACTIVE tab's visible panel.
    const chatPanel = chatPanelLocator(window);
    await expect(chatPanel).toBeVisible();

    // Send a real UI-authored message through the composer before closing the
    // large seeded history so the close path archives user-created chat
    // content, not only seeded JSON.
    // Chat tabs render as per-tab panel tabs (`panel-tab-panel-chat-<id>`)
    // in the chat group's strip; the archive control lives in the worktree
    // header's action cluster (PrStatusBar).
    const archiveTab = window.getByTestId(
      `panel-tab-panel-chat-${ARCHIVE_TAB_ID}`,
    );
    await expect(archiveTab).toBeVisible();
    await expect(window.getByTestId('worktree-top-bar')).toBeVisible();
    const archiveIcon = window.getByTestId('chat-tab-archive');
    await expect(archiveIcon).toHaveCount(0);

    // Scope the composer + send button to the visible chat panel: every
    // mounted chat panel renders its own composer.
    const composer = chatPanel.getByRole('textbox').first();
    await expect(composer).toBeVisible();
    await composer.click();
    await composer.fill(USER_MESSAGE);
    await chatPanel.getByRole('button', { name: 'Send message' }).click();
    await expect(chatPanel.getByText(USER_MESSAGE).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(chatPanel.getByText(/Completed in/).first()).toBeVisible({
      timeout: 30_000,
    });

    // Close the sent chat → it is archived (not hard-deleted) and the archive
    // control appears in the worktree HEADER's action cluster (not a panel
    // tab strip): an icon-only 28×28 button carrying the count in a corner
    // badge, ahead of the `Open in` split control. Exactly one instance
    // mounts, so splitting or popping out groups cannot move or duplicate it.
    await window
      .getByTestId(`panel-tab-close-panel-chat-${ARCHIVE_TAB_ID}`)
      // Closing the tab is setup for the archive-viewer assertions below.
      // Force the control because the independently covered active-tab reveal
      // overlay can temporarily win pointer hit-testing over this button.
      .click({ force: true });
    await expect(archiveTab).toHaveCount(0);
    await expect(archiveIcon).toBeVisible({ timeout: 15_000 });
    await expect(archiveIcon).toHaveCount(1);
    await expect(window.getByTestId('chat-tab-archive-count')).toHaveText('1');
    const archiveBox = await archiveIcon.boundingBox();
    expect(archiveBox?.width, 'archive control width').toBe(28);
    expect(archiveBox?.height, 'archive control height').toBe(28);
    await expect(
      window.getByTestId('pr-status-bar').getByTestId('chat-tab-archive'),
    ).toHaveCount(1);
    await expect(
      window
        .locator('[data-testid^="panel-group-title-"]')
        .locator('[data-testid="chat-tab-archive"]'),
    ).toHaveCount(0);
    const openTriggerBox = await window
      .getByTestId('worktree-open-trigger')
      .boundingBox();
    expect(
      openTriggerBox !== null && archiveBox !== null,
      'header hosts both the archive control and the Open in control',
    ).toBe(true);
    expect(
      archiveBox.x < openTriggerBox.x,
      'archive control leads the Open in control',
    ).toBe(true);

    // Hover the icon → the popover lists the archived chat.
    await archiveIcon.hover();
    const popoverRow = archivedChatRow(
      window,
      'chat-tab-archive-popover-row',
      ARCHIVE_TAB_ID,
    );
    await expect(popoverRow).toBeVisible();
    const chatPanelBox = await chatPanel.boundingBox();
    expect(chatPanelBox, 'visible chat panel bounding box').not.toBeNull();
    await window.mouse.move(
      chatPanelBox.x + chatPanelBox.width / 2,
      chatPanelBox.y + chatPanelBox.height / 2,
    );
    await expect(popoverRow).toHaveCount(0);

    // Archive a second chat so Restore and Summarize can both be exercised in
    // one test without restoring the only archived entry.
    const summarizeTab = window.getByTestId(
      `panel-tab-panel-chat-${SUMMARIZE_TAB_ID}`,
    );
    await expect(summarizeTab).toBeVisible();
    await window
      .getByTestId(`panel-tab-close-panel-chat-${SUMMARIZE_TAB_ID}`)
      .click({ force: true });
    await expect(summarizeTab).toHaveCount(0);

    // Open the full modal and restore from it (a stable overlay, unaffected by
    // pointer-leave timing on the hover popover).
    await archiveIcon.click();
    const modal = window.getByTestId('archived-chats-modal');
    await expect(modal).toBeVisible();
    const modalRow = archivedChatRow(
      modal,
      'archived-chats-modal-row',
      ARCHIVE_TAB_ID,
    );
    await expect(modalRow).toBeVisible();

    // Clicking the row body (not an action button) opens the read-only
    // transcript viewer for that archived chat, stacked over the list modal.
    await modalRow.locator('p[title]').first().click();
    const viewer = window.getByTestId('archived-chat-transcript-modal');
    await expect(viewer).toBeVisible();
    // The full transcript renders, including the message authored above. Assert
    // it is actually VISIBLE (not merely present in the DOM): the transcript
    // area fills its parent via absolute positioning and contributes no
    // intrinsic height, so the dialog must give it a definite height or the body
    // collapses to zero and only the header shows.
    await expect(
      viewer.getByText('Please record this archive test.'),
    ).toBeVisible({ timeout: 15_000 });
    // Restore / Summarize remain available from the viewer header.
    await expect(
      viewer.getByTestId('archived-chat-transcript-restore'),
    ).toBeVisible();
    await expect(
      viewer.getByTestId('archived-chat-transcript-summarize'),
    ).toBeVisible();

    // The search box is always present in the viewer; Cmd+F focuses its input.
    const viewerSearch = viewer.getByTestId('content-search-bar');
    await expect(viewerSearch).toBeVisible();
    const viewerSearchInput = viewerSearch.getByRole('textbox');
    await window.keyboard.press('ControlOrMeta+f');
    await expect(viewerSearchInput).toBeFocused();
    await viewerSearchInput.fill(HISTORICAL_ARCHIVE_MARKER);
    await expect(
      viewerSearch.getByText('1 of 1', { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.getByText(HISTORICAL_ARCHIVE_MARKER, { exact: false }),
    ).toBeVisible();
    await expect(
      viewer
        .getByTestId('user-message-content')
        .filter({ hasText: HISTORICAL_ARCHIVE_MARKER }),
    ).toHaveAttribute('data-collapsed', 'false');

    // Closing the viewer (opened from the list modal) returns to that modal.
    await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await expect(modal).toBeVisible();

    await modalRow.getByTestId('archived-chat-restore').click();

    // The chat tab returns to the strip. The archive icon remains because the
    // second chat is still archived for the Summarize flow.
    const restoredArchiveTab = window.getByTestId(
      `panel-tab-panel-chat-${ARCHIVE_TAB_ID}`,
    );
    await expect(restoredArchiveTab).toHaveCount(1);
    await expect(restoredArchiveTab).toBeVisible({
      timeout: 15_000,
    });
    await expect(archiveIcon).toBeVisible();

    await archiveIcon.click();
    const summarizeModal = window.getByTestId('archived-chats-modal');
    await expect(summarizeModal).toBeVisible();
    const summarizeRow = archivedChatRow(
      summarizeModal,
      'archived-chats-modal-row',
      SUMMARIZE_TAB_ID,
    );
    await expect(summarizeRow).toBeVisible();
    const fullSummarizeTranscript = await window.evaluate(
      ({ projectId, worktreeId, chatId }) =>
        window.api.chat.readArchive({
          projectId,
          worktreeId,
          chatId,
          fullTranscript: true,
        }),
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: SUMMARIZE_TAB_ID,
      },
    );
    expect(JSON.stringify(fullSummarizeTranscript.tab.messages)).toContain(
      HISTORICAL_ARCHIVE_MARKER,
    );
    await summarizeRow.getByTestId('archived-chat-summarize').click();
    await expect(summarizeModal).toHaveCount(0);

    // The summarize handoff draft lands in the freshly-opened ACTIVE tab's
    // composer — hidden sibling panels keep their own (empty) composers
    // mounted, so resolve through the visible panel.
    const draftComposer = chatPanelLocator(window).getByRole('textbox').first();
    await expect(draftComposer).toContainText('[SESSION HANDOFF]', {
      timeout: 30_000,
    });
    await expect(draftComposer).toContainText(
      'Deterministic archival summary for UI automation.',
    );
    await expect(archiveIcon).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('archive-worktree-chat.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});

// ---------------------------------------------------------------------------
// Generated title precedence — a chat's literal `title` stays whatever it was
// created with (here, the slash command), while the agent-generated summary
// lands on `description`. Every archive surface must lead with the generated
// title and drop the raw one, matching the live chat tab bar.
// ---------------------------------------------------------------------------
test('leads with the generated title in every archived-chat surface', async () => {
  test.setTimeout(120_000);

  const { electronApp, seededUserDataDir } = await launchArchiveCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // The live tab already leads with the generated title; archiving must not
    // regress to the raw one.
    const describedTab = window.getByTestId(
      `panel-tab-panel-chat-${DESCRIBED_TAB_ID}`,
    );
    await expect(describedTab).toContainText(DESCRIBED_GENERATED_TITLE);

    await closePanelTab(window, `panel-chat-${DESCRIBED_TAB_ID}`);
    await expect(describedTab).toHaveCount(0);

    const archiveIcon = window
      .getByTestId('pr-status-bar')
      .getByTestId('chat-tab-archive');
    await expect(archiveIcon).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId('chat-tab-archive-count')).toHaveText('1');

    // 1. Hover popover.
    await archiveIcon.hover();
    const popoverRow = window.getByTestId('chat-tab-archive-popover-row');
    await expect(popoverRow).toBeVisible();
    await expect(popoverRow).toContainText(DESCRIBED_GENERATED_TITLE);
    await expect(popoverRow).not.toContainText(DESCRIBED_RAW_TITLE);

    // 2. Full list modal.
    await archiveIcon.click();
    const modal = window.getByTestId('archived-chats-modal');
    await expect(modal).toBeVisible();
    const modalRow = modal.getByTestId('archived-chats-modal-row');
    await expect(modalRow).toContainText(DESCRIBED_GENERATED_TITLE);
    await expect(modalRow).not.toContainText(DESCRIBED_RAW_TITLE);

    // 3. Single archived-chat transcript viewer.
    await modalRow.getByText(DESCRIBED_GENERATED_TITLE).click();
    const viewer = window.getByTestId('archived-chat-transcript-modal');
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText(DESCRIBED_GENERATED_TITLE);
    await expect(viewer).not.toContainText(DESCRIBED_RAW_TITLE);
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});
