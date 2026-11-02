// Agent Ledger panel flows in the real desktop app, for all three work scopes.
//
// Entries are seeded after launch through the E2E-only main-process hook
// (`__CANOPY_E2E_LEDGER__`, `ledger/e2e-ledger-seeder.ts`), which writes
// through the desktop dispatcher exactly as the panel and agent tools do, as
// the local user, a seeded chat or the agent of a seeded pipeline run.
// Nothing touches the Ledger store directly, and no agent runs.
//
// The panel is one column in a tab named Feed: the composer prompt on top,
// then one row per thread, each with its corrections as replies. A standalone
// details action opens one entry at a time; an open-status row changes its
// status and owner in place. Independent correction drafts stay in boxes
// under their threads while the new-entry draft remains separate.
//
// The first Code worktree test covers the read path: the add-panel entry,
// rows with each type's icon, status and author, search by the start of each
// word, a type filter before the search, a details toggle with its source,
// opening the recording chat and a reference file and returning to the same
// open row, a live change, App Advisor awareness, and a detached window that
// keeps the panel's scope. Others open the panel in a Cowork and an App
// Advisor Work Entry, reopen a closed panel, and open a pipeline agent's run
// at its job. A row's avatar is its type, and the glyph of what recorded it
// (a person, a chat, a pipeline agent, a delegate's subagent glyph) sits
// beside the author's name. A managed delegate's row has an Open chat action
// that opens its subagent chat without opening the row's details;
// once the chat that started it is archived, the action opens the archived
// chat and says so with an archive icon and a tooltip.
//
// The write tests add an entry (owned by "You"), focus its Content field,
// assign it to a chat (named by its generated description) and take it back,
// change its status, close it and correct it. App Advisor opens the entry
// without moving the correction draft; another flow keeps two correction
// drafts and a new-entry draft independent. Other flows add a title-less
// entry while its provisional title is pending, refuse a stale revision and
// a paused pipeline agent whose run resumed while the owner picker was open,
// keep the narrow-panel composer and rows in the column, and correct the
// newest reply in a nested correction thread. A long list windows its rows
// and keeps the reading position across a correction.
//
// The sync test runs against the shared mock server's Ledger mirror: a
// worktree first used signed out stays on this device after sign-in, a Cowork
// task stays on this device until summaries sharing is on, then waits while
// ingest is off and syncs once the mirror takes it, a
// title-less entry waits for its title before it syncs, another writer can
// hold its scope in repair, and an organization's summaries prohibition
// stops syncing.
//
// The E2E launcher seeds flags from the LaunchDarkly-unavailable map, where
// `canopy-ledger-enabled` is off, so each test turns it on explicitly.

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedPipelineExecution, seedWorktreeChat } from './seeders/index.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import {
  SUBAGENT_VIEWER_CHAT_ID,
  SUBAGENT_VIEWER_TREE_IDS,
  SUBAGENT_VIEWER_TREE_TITLES,
  seedSubagentViewerTreeChat,
} from './seeders/subagentViewerCapture.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  clearScenario,
  getScenarioActivity,
  registerScenario,
} from './seeders/registerScenario.mjs';
import {
  DEFAULT_GROUP_IDS,
  SEEDED_CHAT_TAB_ID,
  chatPanelLocator,
  collectLeaves,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';
import { waitForChatPanel } from './chatPanelReady.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const COWORK_ID = 'cowork-ledger';
const COWORK_ENTRY_ID = 'entry-ledger';
const ADVISOR_ENTRY_ID = 'advisor-ledger';
const LEDGER_ON = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-ledger-enabled': true,
  }),
};
/** The Ledger on, with sync's quick E2E timing. */
const LEDGER_SYNC_ON = { ...LEDGER_ON, CANOPY_E2E_LEDGER_SYNC_FAST: '1' };
/** The mirror names accounts by UUID, so a syncing account needs one. */
const LEDGER_SYNC_ACCOUNT = { id: '00000000-0000-4000-8000-0000000e2e01' };
const LEDGER_SYNC_ORGANIZATION = {
  id: '00000000-0000-4000-8000-0000000e2e02',
  name: 'Acme Ledger',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const USER = { kind: 'user' };
const SEEDED_CHAT = {
  kind: 'chat',
  chatId: SEEDED_CHAT_TAB_ID,
  displayName: 'Parser fixes',
};
const PIPELINE_EXECUTION_ID = 'ledger-release-checks';
const REVIEW_AGENT = {
  kind: 'pipeline',
  executionId: PIPELINE_EXECUTION_ID,
  jobId: 'review',
  stepId: 'agent',
  displayName: 'Release review',
};

/** Adds an entry through the desktop dispatcher; resolves with the entry. */
function addLedgerEntry(electronApp, request) {
  return electronApp.evaluate(async (_electron, payload) => {
    const ledger = globalThis.__CANOPY_E2E_LEDGER__;
    if (!ledger) throw new Error('The E2E Ledger seeder is unavailable');
    return ledger.addEntry(payload);
  }, request);
}

/** Updates an entry through the desktop dispatcher; resolves with it. */
function updateLedgerEntry(electronApp, request) {
  return electronApp.evaluate(async (_electron, payload) => {
    const ledger = globalThis.__CANOPY_E2E_LEDGER__;
    if (!ledger) throw new Error('The E2E Ledger seeder is unavailable');
    return ledger.updateEntry(payload);
  }, request);
}

/** Records a paused pipeline agent, as the pipeline host does. */
function pausePipelineAgent(electronApp, agent) {
  return electronApp.evaluate(async (_electron, payload) => {
    const ledger = globalThis.__CANOPY_E2E_LEDGER__;
    if (!ledger) throw new Error('The E2E Ledger seeder is unavailable');
    ledger.pausePipelineAgent(payload);
  }, agent);
}

/** Resumes an execution's paused agents, as a saved resume does. */
function resumePipelineExecution(electronApp, executionId) {
  return electronApp.evaluate(async (_electron, id) => {
    const ledger = globalThis.__CANOPY_E2E_LEDGER__;
    if (!ledger) throw new Error('The E2E Ledger seeder is unavailable');
    await ledger.resumePipelineExecution(id);
  }, executionId);
}

/** Adds the Ledger panel to a group through the add-panel menu. */
async function addLedgerPanel(page, groupId) {
  await page.getByTestId(`panel-add-tab-${groupId}`).click();
  await expect(page.getByTestId('panel-add-menu')).toBeVisible();
  await page.getByTestId('panel-add-menu-item-ledger').click();
  const panel = page.getByTestId('ledger-panel');
  await expect(panel).toBeVisible();
  return panel;
}

function rowTitled(panel, title) {
  return panel.getByTestId('ledger-entry-row').filter({ hasText: title });
}

function rowContainingContent(panel, content) {
  return panel.getByTestId('ledger-entry-row').filter({ hasText: content });
}

/** LedgerEntryPost renders its own action bar before its reply children. */
function rootDetailsToggle(row) {
  return row.getByTestId('ledger-entry-details-toggle').first();
}

/** A root row's own Add correction, never one of its replies'. */
function rootAddCorrection(row) {
  return row.locator(
    'xpath=.//*[@data-testid="ledger-entry-add-correction"][not(ancestor::*[@data-testid="ledger-entry-correction"])]',
  );
}

function replyDetailsToggle(reply) {
  return reply.getByTestId('ledger-entry-details-toggle');
}

let advisorRequestSequence = 0;

async function dispatchAdvisorAction(electronApp, requestId, action) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, request) => {
      const responseChannel = 'app-advisor:tool-response';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor tool')),
          10_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== request.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send('app-advisor:tool-request', request);
      });
    },
    {
      kind: 'dispatch_action',
      requestId,
      originWorktreeId: 'e2e-advisor-entry',
      action,
    },
  );
}

async function openInLedger(electronApp, scope, entryId) {
  const response = await dispatchAdvisorAction(
    electronApp,
    `ledger-open-${++advisorRequestSequence}`,
    {
      type: 'ledger.open',
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      entryId,
    },
  );
  expect(response).toMatchObject({
    ok: true,
    result: {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      entryId,
    },
  });
  return response;
}

async function rowIntersectsListPane(panel, row) {
  const [paneBox, rowBox] = await Promise.all([
    panel.getByTestId('ledger-list-pane').boundingBox(),
    row.boundingBox(),
  ]);
  return (
    paneBox !== null &&
    rowBox !== null &&
    rowBox.x + rowBox.width > paneBox.x &&
    rowBox.x < paneBox.x + paneBox.width &&
    rowBox.y + rowBox.height > paneBox.y &&
    rowBox.y < paneBox.y + paneBox.height
  );
}

async function scrollLedgerPaneToRow(panel, title) {
  const pane = panel.getByTestId('ledger-list-pane');
  const row = panel
    .getByText(title, { exact: true })
    .locator('xpath=ancestor::article[@data-testid="ledger-entry-row"]');
  for (let step = 0; step < 100; step += 1) {
    if ((await row.count()) > 0 && (await rowIntersectsListPane(panel, row))) {
      return row;
    }
    const atBottom = await pane.evaluate(
      (element) =>
        element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    );
    if (atBottom) break;
    await pane.evaluate((element) => {
      element.scrollTop = Math.min(
        element.scrollTop + element.clientHeight,
        element.scrollHeight,
      );
    });
    await pane.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    );
  }
  throw new Error(`Could not scroll the Ledger list to "${title}"`);
}

/**
 * The demo worktree with one seeded chat, and any `moreTabs`, launched with
 * the Ledger on.
 */
async function launchCodeWorktree(userDataDir, env = LEDGER_ON, moreTabs = []) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Parser fixes' }, ...moreTabs],
  });
  const launched = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env,
  });
  // The harness waits for the chat panel only when it seeds the profile
  // itself. Without this, a late chat tab takes focus from a Ledger panel
  // the test has already added.
  await waitForChatPanel(launched.window, { chatTabId: SEEDED_CHAT_TAB_ID });
  return launched;
}

async function ledgerPanelId(page) {
  const layout = await getLayout(page);
  const panel = collectLeaves(layout.root)
    .flatMap((leaf) => leaf.panels)
    .find((candidate) => candidate.kind === 'ledger');
  if (!panel) throw new Error('No Ledger panel in the layout');
  return panel.panelId;
}

async function getAdvisorUiState(electronApp) {
  const request = {
    kind: 'get_current_ui_state',
    requestId: `ledger-panel-ui-state-${++advisorRequestSequence}`,
  };
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor UI state')),
          5_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== rendererRequest.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send(requestChannel, rendererRequest);
      });
    },
    request,
  );
}

test('Code worktree Ledger: generated chat descriptions name rows before the owner picker opens', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-label-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const original =
    'when opening the Feed page, automatically refresh its entries';
  const generated = 'Auto refresh Feed when opened';
  const { electronApp, window } = await launchCodeWorktree(
    userDataDir,
    LEDGER_ON,
    [{ id: 'chat-feed-refresh', title: original, description: generated }],
  );
  try {
    await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: {
        kind: 'chat',
        chatId: 'chat-feed-refresh',
        displayName: original,
      },
      params: {
        type: 'TASK',
        title: 'Refresh entries on navigation',
        content: 'Read the newest entries when the Feed opens.',
      },
    });
    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    const row = rowTitled(panel, 'Refresh entries on navigation');
    await expect(row).toContainText(generated);
    await expect(row).not.toContainText(original);
    await rootDetailsToggle(row).click();
    await expect(
      row
        .getByTestId('ledger-entry-details')
        .locator('dt')
        .filter({ hasText: /^Added by$/ })
        .locator('..')
        .locator('dd'),
    ).toHaveText(generated);
    await expect(row.getByTestId('ledger-entry-detail-owner')).toHaveText(
      generated,
    );

    await window.getByTestId('sidebar-nav-feed').click();
    const feed = window.getByTestId('page-feed').getByTestId('ledger-feed');
    const feedRow = rowTitled(feed, 'Refresh entries on navigation');
    await expect(feedRow).toContainText(generated);
    await expect(feedRow).not.toContainText(original);
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-chat-label-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: browse, search, filter, detail, sources, live changes and a detached window', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await launchCodeWorktree(userDataDir);

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    await addLedgerEntry(electronApp, {
      scope,
      author: USER,
      params: {
        type: 'TASK',
        title: 'Write the release notes',
        content: 'Cover the Ledger panel.',
      },
    });
    await addLedgerEntry(electronApp, {
      scope,
      author: SEEDED_CHAT,
      params: {
        type: 'DECISION',
        title: 'Keep one ledger writer',
        content: 'Only the local core commits entries.',
        highlights: ['Single writer'],
      },
    });
    await addLedgerEntry(electronApp, {
      scope,
      author: SEEDED_CHAT,
      params: {
        type: 'TASK',
        title: 'Update parser recovery',
        content: 'Preserve incomplete events after reconnection.',
        status: 'BLOCKED',
        referenceFiles: [
          { rootId: WORKSPACE_ID, path: 'package.json', startLine: 2 },
        ],
      },
    });

    // --- 1. The add-panel menu offers the Ledger; its rows read plainly.
    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    await expect(panel).toHaveAttribute('data-project-id', WORKSPACE_ID);
    await expect(panel).toHaveAttribute('data-worktree-id', WORKTREE_ID);
    const ledgerTab = window.getByTestId(
      `panel-tab-${await ledgerPanelId(window)}`,
    );
    await expect(ledgerTab.locator('.canopy-panel-tab-title')).toHaveText(
      'Feed',
    );
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(3);
    const blocked = rowTitled(panel, 'Update parser recovery');
    await expect(blocked).toContainText('Task');
    // Each type keeps its own icon beside its name.
    await expect(blocked.getByTestId('ledger-entry-type-icon')).toHaveAttribute(
      'data-type',
      'TASK',
    );
    await expect(
      rowTitled(panel, 'Keep one ledger writer').getByTestId(
        'ledger-entry-type-icon',
      ),
    ).toHaveAttribute('data-type', 'DECISION');
    // An open status of this device changes in place, on the row itself.
    await expect(
      blocked.getByTestId('ledger-status-control').first(),
    ).toHaveAttribute('data-status', 'BLOCKED');
    await expect(
      blocked.getByTestId('ledger-status-control').first(),
    ).toContainText('Blocked');
    await expect(blocked).toContainText('Parser fixes');
    await expect(rowTitled(panel, 'Write the release notes')).toContainText(
      'You',
    );

    // --- 2. Search narrows the list once typing settles. Every word must
    // match, each by its start, as the person types it.
    await panel.getByTestId('ledger-search').fill('update pars');
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(1);
    await expect(blocked).toBeVisible();
    await panel.getByTestId('ledger-search').fill('arser');
    await expect(panel.getByTestId('ledger-empty-filtered')).toBeVisible();
    await panel.getByTestId('ledger-search').fill('');
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(3);

    // --- 3. A type filter narrows it, with a dot on the trigger. The filter
    // sits before the search.
    const filterBox = await panel
      .getByTestId('ledger-filter-trigger')
      .boundingBox();
    const searchBox = await panel.getByTestId('ledger-search').boundingBox();
    expect(filterBox?.x ?? Infinity).toBeLessThan(searchBox?.x ?? -Infinity);
    await panel.getByTestId('ledger-filter-trigger').click();
    await window.getByTestId('ledger-filter-type-decision').click();
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(1);
    await expect(rowTitled(panel, 'Keep one ledger writer')).toBeVisible();
    await expect(panel.getByTestId('ledger-filter-active-dot')).toBeVisible();
    await window.getByTestId('ledger-filter-type-decision').click();
    await window.keyboard.press('Escape');
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(3);

    // --- 4. The standalone details action opens the entry in place.
    const blockedDetailsToggle = rootDetailsToggle(blocked);
    await blockedDetailsToggle.click();
    await expect(blocked).toHaveAttribute('aria-current', 'true');
    await expect(blockedDetailsToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(blockedDetailsToggle).toHaveText('Hide details');
    const details = blocked.getByTestId('ledger-entry-details');
    await expect(details).toBeVisible();
    await expect(details).toContainText('Recorded in a chat.');
    const openSource = blocked.getByTestId('ledger-entry-source-open').first();
    await expect(openSource).toHaveText('Open chat');

    // --- 5. Opening the chat activates it; the Ledger tab comes back to the
    // same selection.
    await openSource.click();
    await expect(chatPanelLocator(window, SEEDED_CHAT_TAB_ID)).toBeVisible();
    await expect(panel).toBeHidden();
    await window
      .getByTestId(`panel-tab-${await ledgerPanelId(window)}`)
      .click();
    await expect(panel).toBeVisible();
    await expect(blocked).toHaveAttribute('aria-current', 'true');
    await expect(blocked.getByTestId('ledger-entry-details')).toBeVisible();

    // --- 6. A reference file opens in the file panel.
    await blocked.getByTestId('ledger-entry-file-ref').click();
    await expect
      .poll(async () => {
        const layout = await getLayout(window);
        return collectLeaves(layout.root)
          .flatMap((leaf) => leaf.panels)
          .some(
            (candidate) =>
              candidate.kind === 'file-diff' &&
              /[\\/]package\.json$/.test(candidate.instance?.filePath ?? ''),
          );
      })
      .toBe(true);
    await window
      .getByTestId(`panel-tab-${await ledgerPanelId(window)}`)
      .click();
    await expect(panel).toBeVisible();

    // --- 7. A change committed elsewhere arrives without a reload.
    await addLedgerEntry(electronApp, {
      scope,
      author: SEEDED_CHAT,
      params: {
        type: 'OBSERVATION',
        title: 'Reconnects drop one frame',
        content: 'Seen twice in the soak test.',
      },
    });
    await expect(rowTitled(panel, 'Reconnects drop one frame')).toBeVisible();
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(4);

    // --- 8. App Advisor knows the panel by scope and counts, never text.
    await expect
      .poll(async () => {
        const response = await getAdvisorUiState(electronApp);
        const ledgerPanels = response.uiState?.snapshot.ledgerPanels ?? [];
        return ledgerPanels.map((ledgerPanel) => ({
          projectId: ledgerPanel.projectId,
          worktreeId: ledgerPanel.worktreeId,
          entryCount: ledgerPanel.entryCount,
        }));
      })
      .toEqual([
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, entryCount: 4 },
      ]);

    // --- 9. Popped out, the panel keeps its own scope and content.
    const auxWindowPromise = electronApp.waitForEvent('window');
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    await window
      .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    const aux = await auxWindowPromise;
    const auxPanel = aux.getByTestId('ledger-panel');
    await expect(auxPanel).toBeVisible();
    await expect(auxPanel).toHaveAttribute('data-project-id', WORKSPACE_ID);
    await expect(auxPanel).toHaveAttribute('data-worktree-id', WORKTREE_ID);
    await expect(auxPanel.getByTestId('ledger-entry-row')).toHaveCount(4);
    await aux
      .getByTestId('panel-aux-window-merge-back')
      .click()
      .catch((error) => {
        if (!String(error).includes('has been closed')) throw error;
      });
    await expect.poll(() => aux.isClosed()).toBe(true);
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-code-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** A Cowork project with one Work Entry and one chat. */
function seedCoworkWorkEntry(userDataDir) {
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: COWORK_ID,
        name: 'Research',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
      },
    ],
  });
  const workspaceDir = path.join(userDataDir, 'workspaces', COWORK_ID);
  // A Cowork workspace.json carries no `repos` (docs/cowork-workspaces.md).
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: '2026-09-01T10:00:00.000Z',
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: COWORK_ENTRY_ID, createdAt: '2026-09-01T10:00:00.000Z' }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${COWORK_ENTRY_ID}.json`), {
    version: 1,
    activeTabId: 'chat-cowork-ledger',
    tabs: [
      {
        id: 'chat-cowork-ledger',
        title: 'New Chat',
        description: 'Market notes',
        createdAt: '2026-09-01T10:05:00.000Z',
        kind: 'chat',
        messages: [
          {
            id: 'chat-cowork-ledger-m1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Collect the market notes.' }],
            timestamp: Date.parse('2026-09-01T10:05:00.000Z'),
          },
        ],
      },
    ],
  });
}

/** An App Advisor Work Entry with one chat. */
function seedAdvisorWorkEntry(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  const createdAt = '2026-09-02T09:00:00.000Z';
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: ADVISOR_ENTRY_ID, createdAt, title: 'Ledger panel' }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${ADVISOR_ENTRY_ID}.json`), {
    version: 1,
    activeTabId: 'chat-advisor-ledger',
    tabs: [
      {
        id: 'chat-advisor-ledger',
        title: 'Advisor chat',
        createdAt,
        providerType: 'claude',
        messages: [],
      },
    ],
  });
}

/** The Cowork project beside the demo workspace in the sidebar. */
function seedCoworkBesideDemo(userDataDir) {
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const demoIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  seedCoworkWorkEntry(userDataDir);
  const coworkIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  writeJson(indexPath, {
    ...demoIndex,
    workspaces: [
      ...demoIndex.workspaces,
      ...coworkIndex.workspaces.map((workspace) => ({
        ...workspace,
        order: demoIndex.workspaces.length,
      })),
    ],
  });
}

/** How many of one kind of request the mock Ledger mirror has seen. */
async function ledgerMirrorActivity(apiKey, field) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey);
  return activity[field] ?? 0;
}

test('Ledger sync: saved on this device, waiting, synced, needing repair and off by policy', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const apiKey = `csk_ledger_sync_e2e_${Date.now()}`;
  const titleMarker = 'Canopy-CLEDGERTITLE';
  const cloud = { account: LEDGER_SYNC_ACCOUNT };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { ...cloud, ledger: { ingest: 'disabled' } },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-sync-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCoworkBesideDemo(userDataDir);
  const { electronApp, window } = await launchCodeWorktree(
    userDataDir,
    LEDGER_SYNC_ON,
  );

  try {
    // --- 1. A worktree first used signed out keeps its Ledger on this
    // device (LD02).
    await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: USER,
      params: {
        type: 'TASK',
        title: 'Draft the rollout plan',
        content: 'Written before signing in.',
      },
    });
    const worktreePanel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    const signedOut = rowTitled(worktreePanel, 'Draft the rollout plan');
    await expect(signedOut.getByTestId('ledger-entry-row-sync')).toHaveText(
      'Saved on this device',
    );

    // --- 2. Signing in never moves it to the account.
    await connectMockCloudAccount(window, apiKey);
    await expect(signedOut.getByTestId('ledger-entry-row-sync')).toHaveText(
      'Saved on this device',
    );

    // --- 3. A Cowork task used signed in is this account's to sync, but
    // stays on this device while summaries sharing is off, where every account
    // starts.
    await window.getByTestId(`sidebar-work-entry-${COWORK_ENTRY_ID}`).click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    const coworkScope = { projectId: COWORK_ID, worktreeId: COWORK_ENTRY_ID };
    await addLedgerEntry(electronApp, {
      scope: coworkScope,
      author: USER,
      params: {
        type: 'DECISION',
        title: 'Survey three vendors',
        content: 'Two quotes are not enough to compare.',
      },
    });
    const coworkPanel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    const decision = rowTitled(coworkPanel, 'Survey three vendors');
    await expect(decision.getByTestId('ledger-entry-row-sync')).toHaveText(
      'Saved on this device',
    );

    // --- Sharing summaries with the account ("Just me") lets the scope sync.
    // It waits while ingest is off.
    await window.evaluate(() =>
      window.api.savePreferences({
        telemetrySharing: {
          transcripts: 'off',
          plans: 'off',
          metadata: 'off',
          summaries: 'private',
        },
      }),
    );
    await expect(decision.getByTestId('ledger-entry-row-sync')).toHaveText(
      'Waiting to sync',
    );
    await expect
      .poll(() => ledgerMirrorActivity(apiKey, 'ledgerRegister'))
      .toBeGreaterThan(0);

    // --- 4. Once the mirror takes it, only its details say Synced.
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, { cloud });
    await expect(decision.getByTestId('ledger-entry-row-sync')).toHaveCount(0, {
      timeout: 15_000,
    });
    expect(await ledgerMirrorActivity(apiKey, 'ledgerEvents')).toBeGreaterThan(
      0,
    );
    await rootDetailsToggle(decision).click();
    await expect(decision.getByTestId('ledger-entry-detail-sync')).toHaveText(
      'Synced',
    );

    // --- A title-less entry waits to sync until its helper resolves the
    // provisional title. The marker scenario also pins the topic-summary
    // helper response so the pending window is observable.
    const titleScenarioStep = {
      text: 'Release notes plan',
      streamMs: 7_000,
      stopReason: 'end_turn',
    };
    await registerScenario(DEFAULT_MOCK_BASE_URL, titleMarker, {
      llm: {
        steps: [titleScenarioStep],
        helperStepsById: { 'topic-summary': titleScenarioStep },
      },
    });
    const eventsBeforePendingTitle = await ledgerMirrorActivity(
      apiKey,
      'ledgerEvents',
    );
    const addEntry = coworkPanel.getByTestId('ledger-add-entry');
    await addEntry.click();
    const form = coworkPanel.getByTestId('ledger-entry-form');
    await expect(
      form.getByText('Title (optional)', { exact: true }),
    ).toBeVisible();
    const contentField = form.getByTestId('ledger-entry-form-content');
    await expect(contentField).toBeFocused();
    const provisionalContent = `[${titleMarker}] Draft the package cut release summary.`;
    await contentField.fill(provisionalContent);
    await form.getByTestId('ledger-entry-form-save').click();
    await expect(form).toBeHidden();
    const titlelessRow = rowContainingContent(coworkPanel, titleMarker);
    await expect(titlelessRow).toBeVisible();
    // VERIFY AT INTEGRATION: if helper model routing bypasses this mock
    // scenario, the expected fallback is the provisional title from the
    // content prefix rather than "Release notes plan".
    await expect(
      titlelessRow.getByTestId('ledger-entry-row-title'),
    ).toHaveCount(0);
    const pendingCorrection = titlelessRow.getByTestId(
      'ledger-entry-add-correction',
    );
    await expect(pendingCorrection).toBeDisabled();
    await expect(pendingCorrection).toHaveAttribute(
      'aria-description',
      'Its title is still being written.',
    );
    // A disabled button takes no pointer events: the pointer lands on the
    // tooltip's wrapper, so hover that (hovering the button itself would wait
    // until it is enabled again).
    await pendingCorrection.locator('xpath=..').hover();
    await expect(window.getByRole('tooltip')).toHaveText(
      'Its title is still being written.',
    );
    await expect(titlelessRow.getByTestId('ledger-entry-row-sync')).toHaveText(
      'Waiting to sync',
    );
    expect(await ledgerMirrorActivity(apiKey, 'ledgerEvents')).toBe(
      eventsBeforePendingTitle,
    );
    await expect(titlelessRow.getByTestId('ledger-entry-row-title')).toHaveText(
      'Release notes plan',
      { timeout: 20_000 },
    );
    await expect(
      titlelessRow.getByTestId('ledger-entry-add-correction'),
    ).toBeEnabled();
    await expect(titlelessRow.getByTestId('ledger-entry-row-sync')).toHaveCount(
      0,
      { timeout: 20_000 },
    );
    await expect
      .poll(() => ledgerMirrorActivity(apiKey, 'ledgerEvents'), {
        timeout: 20_000,
      })
      .toBeGreaterThan(eventsBeforePendingTitle);

    // --- 5. When another writer holds the scope, a new entry needs repair.
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: { ...cloud, ledger: { push: 'stale_writer' } },
    });
    await addLedgerEntry(electronApp, {
      scope: coworkScope,
      author: USER,
      params: {
        type: 'OBSERVATION',
        title: 'Vendor B missed the deadline',
        content: 'Their quote arrived a day late.',
      },
    });
    const late = rowTitled(coworkPanel, 'Vendor B missed the deadline');
    await expect(late.getByTestId('ledger-entry-row-sync')).toHaveText(
      'Needs repair',
      { timeout: 15_000 },
    );

    // --- 6. An organization's summaries prohibition turns sync off, and the
    // label says so. What already synced stays synced.
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        ...cloud,
        organizations: [LEDGER_SYNC_ORGANIZATION],
        enforcedSettings: [
          {
            organizationId: LEDGER_SYNC_ORGANIZATION.id,
            organizationName: LEDGER_SYNC_ORGANIZATION.name,
            policies: [
              {
                kind: 'telemetry-sync',
                scopes: {},
                prohibitedScopes: { summaries: true },
              },
            ],
          },
        ],
      },
    });
    await connectMockCloudAccount(window, apiKey);
    await expect(late.getByTestId('ledger-entry-row-sync')).toHaveText(
      'Sync off for this workspace',
      { timeout: 15_000 },
    );
    await expect(decision.getByTestId('ledger-entry-row-sync')).toHaveCount(0);
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-sync-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => undefined);
    await clearScenario(DEFAULT_MOCK_BASE_URL, titleMarker).catch(
      () => undefined,
    );
  }
});

test('Cowork and App Advisor Work Entries each show their own Ledger', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-entries-'),
  );
  seedCoworkWorkEntry(userDataDir);
  seedAdvisorWorkEntry(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir, env: LEDGER_ON });

  let window;
  try {
    window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await addLedgerEntry(electronApp, {
      scope: { projectId: 'app-advisor', worktreeId: ADVISOR_ENTRY_ID },
      author: USER,
      params: {
        type: 'TASK',
        title: 'Review the advisor shortcuts',
        content: 'Check every shortcut still opens its page.',
      },
    });

    // --- Cowork Work Entry.
    await window.getByTestId(`sidebar-work-entry-${COWORK_ENTRY_ID}`).click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    // Main learns a project's type from the sidebar's first read, which has
    // happened once the Work Entry is open.
    await addLedgerEntry(electronApp, {
      scope: { projectId: COWORK_ID, worktreeId: COWORK_ENTRY_ID },
      author: USER,
      params: {
        type: 'DECISION',
        title: 'Survey three vendors',
        content: 'Two quotes are not enough to compare.',
      },
    });
    const coworkPanel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    await expect(coworkPanel).toHaveAttribute('data-project-id', COWORK_ID);
    await expect(coworkPanel).toHaveAttribute(
      'data-worktree-id',
      COWORK_ENTRY_ID,
    );
    await expect(coworkPanel.getByTestId('ledger-entry-row')).toHaveCount(1);
    await expect(rowTitled(coworkPanel, 'Survey three vendors')).toBeVisible();

    // --- App Advisor Work Entry, in the App Advisor window.
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const advisorPanel = await addLedgerPanel(advisor, DEFAULT_GROUP_IDS.chat);
    await expect(advisorPanel).toHaveAttribute(
      'data-project-id',
      'app-advisor',
    );
    await expect(advisorPanel).toHaveAttribute(
      'data-worktree-id',
      ADVISOR_ENTRY_ID,
    );
    await expect(advisorPanel.getByTestId('ledger-entry-row')).toHaveCount(1);
    await expect(
      rowTitled(advisorPanel, 'Review the advisor shortcuts'),
    ).toBeVisible();
  } catch (error) {
    await window
      ?.screenshot({ path: testInfo.outputPath('ledger-entries-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: a reopened panel shows what was recorded while it was closed', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await launchCodeWorktree(userDataDir);

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    await addLedgerEntry(electronApp, {
      scope,
      author: USER,
      params: {
        type: 'TASK',
        title: 'Write the release notes',
        content: 'Cover the Ledger panel.',
      },
    });
    let panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(1);

    // A closed panel hears no changes.
    await window
      .getByTestId(`panel-tab-close-${await ledgerPanelId(window)}`)
      .click({ force: true });
    await expect(window.getByTestId('ledger-panel')).toHaveCount(0);
    await addLedgerEntry(electronApp, {
      scope,
      author: SEEDED_CHAT,
      params: {
        type: 'OBSERVATION',
        title: 'Reconnects drop one frame',
        content: 'Seen twice in the soak test.',
      },
    });

    // Reopened, it catches up instead of showing the list it kept.
    panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    await expect(rowTitled(panel, 'Reconnects drop one frame')).toBeVisible();
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(2);
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-reopen-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test("Code worktree Ledger: a pipeline agent's entry opens its run at the agent's job", async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: PIPELINE_EXECUTION_ID,
      pipelineName: 'Release checks',
      status: 'success',
      startedAt: '2026-09-30T10:00:00.000Z',
      completedAt: '2026-09-30T10:05:00.000Z',
      jobs: [
        {
          id: 'build',
          name: 'Build',
          steps: [{ id: 'compile', name: 'Compile', run: 'npm run build' }],
        },
        {
          id: 'review',
          name: 'Review',
          steps: [{ id: 'agent', name: 'Review changes', run: 'echo review' }],
        },
      ],
    },
  });
  const { electronApp, window } = await launchCodeWorktree(userDataDir);

  try {
    await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: REVIEW_AGENT,
      params: {
        type: 'OBSERVATION',
        title: 'Two parser tests are flaky',
        content: 'Both pass on retry.',
      },
    });
    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    const row = rowTitled(panel, 'Two parser tests are flaky');
    await expect(row).toContainText('Release review');
    await rootDetailsToggle(row).click();
    await expect(row.getByTestId('ledger-entry-details')).toContainText(
      'Recorded by a workflow agent.',
    );
    const openSource = row.getByTestId('ledger-entry-source-open').first();
    await expect(openSource).toHaveText('Open run');

    // The run opens at the job the agent ran in, not at its summary.
    await openSource.click();
    await expect(window.getByTestId('pipeline-details-nav')).toBeVisible();
    await expect(window.getByTestId('pipeline-job-view-review')).toBeVisible();
    await expect(window.getByTestId('pipeline-summary-view')).toHaveCount(0);
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-pipeline-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ledger Feed: an App Advisor delegate opens in the App Advisor renderer', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-advisor-delegate-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedAdvisorWorkEntry(userDataDir);
  // App Advisor reads its chats from `app-workspaces`; seeding the default
  // root would leave the entry's chat without the delegate this test opens.
  seedSubagentViewerTreeChat({
    userDataDir,
    workspaceId: 'app-advisor',
    worktreeId: ADVISOR_ENTRY_ID,
    chatId: 'chat-advisor-ledger',
    storageRoot: 'app-workspaces',
  });
  const { electronApp } = await launchCanopy({ userDataDir, env: LEDGER_ON });
  const window = await electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Hydrate App Advisor once, then initiate navigation from the main Feed.
    const advisor = await app.openAppAdvisorWindow(electronApp);
    await addLedgerEntry(electronApp, {
      scope: { projectId: 'app-advisor', worktreeId: ADVISOR_ENTRY_ID },
      author: {
        kind: 'delegate',
        delegationId: SUBAGENT_VIEWER_TREE_IDS.idleParent,
        displayName: SUBAGENT_VIEWER_TREE_TITLES.idleParent,
        rootChatId: 'chat-advisor-ledger',
        rootChatName: 'Advisor review',
      },
      params: {
        type: 'TASK',
        title: 'Review the advisor delegate',
        content: 'Read the shortcuts.',
        status: 'COMPLETED',
      },
    });
    await window.getByTestId('sidebar-nav-feed').click();
    const feed = window.getByTestId('page-feed').getByTestId('ledger-feed');
    await feed.getByTestId('ledger-feed-audience-this_device').click();
    const row = rowTitled(feed, 'Review the advisor delegate');
    await expect(row).toBeVisible();
    await row.getByTestId('ledger-entry-source-open').first().click();
    await expect(advisor.getByTestId('subagent-chat-panel')).toBeVisible();
    await expect(advisor.getByTestId('subagent-chat-banner')).toContainText(
      SUBAGENT_VIEWER_TREE_TITLES.idleParent,
    );
    await expect(window.getByTestId('subagent-chat-panel')).toHaveCount(0);
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-advisor-delegate-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test("Code worktree Ledger: a delegate's entry opens its subagent chat from the row", async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedSubagentViewerTreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
  });
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: PIPELINE_EXECUTION_ID,
      pipelineName: 'Release checks',
      status: 'success',
      startedAt: '2026-09-30T10:00:00.000Z',
      completedAt: '2026-09-30T10:05:00.000Z',
      jobs: [
        {
          id: 'review',
          name: 'Review',
          steps: [{ id: 'agent', name: 'Review changes', run: 'echo review' }],
        },
      ],
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir, env: LEDGER_ON });
  const window = await electronApp.firstWindow();

  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    const delegateTitle = SUBAGENT_VIEWER_TREE_TITLES.idleParent;
    await addLedgerEntry(electronApp, {
      scope,
      author: REVIEW_AGENT,
      params: {
        type: 'OBSERVATION',
        title: 'Two parser tests are flaky',
        content: 'Both pass on retry.',
      },
    });
    await addLedgerEntry(electronApp, {
      scope,
      author: {
        kind: 'delegate',
        delegationId: SUBAGENT_VIEWER_TREE_IDS.idleParent,
        displayName: delegateTitle,
        rootChatId: SUBAGENT_VIEWER_CHAT_ID,
        rootChatName: 'Parser review',
      },
      params: {
        type: 'TASK',
        title: 'Review the parser recovery path',
        content: 'Read the recovery path and its tests.',
        status: 'COMPLETED',
      },
    });

    await addLedgerEntry(electronApp, {
      scope,
      author: USER,
      params: {
        type: 'TASK',
        title: 'Write the release notes',
        content: 'Cover the Ledger panel.',
      },
    });

    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    const row = rowTitled(panel, 'Review the parser recovery path');
    await expect(row).toContainText(delegateTitle);

    // The row's avatar is its type. What recorded it sits beside its name:
    // a delegate has the subagent glyph, not the pipeline agent's.
    await expect(row.getByTestId('ledger-entry-type-avatar')).toHaveAttribute(
      'data-type',
      'TASK',
    );
    await expect(row.getByTestId('ledger-actor-avatar')).toHaveCount(0);
    const delegateGlyph = row.getByTestId('ledger-entry-row-author-icon');
    await expect(delegateGlyph).toHaveAttribute(
      'data-actor-kind',
      'managed_delegation',
    );
    const pipelineRow = rowTitled(panel, 'Two parser tests are flaky');
    await expect(
      pipelineRow.getByTestId('ledger-entry-type-avatar'),
    ).toHaveAttribute('data-type', 'OBSERVATION');
    const pipelineGlyph = pipelineRow.getByTestId(
      'ledger-entry-row-author-icon',
    );
    await expect(pipelineGlyph).toHaveAttribute(
      'data-actor-kind',
      'pipeline_agent',
    );
    expect(await delegateGlyph.locator('svg').innerHTML()).not.toBe(
      await pipelineGlyph.locator('svg').innerHTML(),
    );
    // An entry a person added has the person glyph beside "You".
    const userRow = rowTitled(panel, 'Write the release notes');
    await expect(userRow.getByTestId('ledger-entry-row-author')).toHaveText(
      'You',
    );
    await expect(
      userRow.getByTestId('ledger-entry-row-author-icon'),
    ).toHaveAttribute('data-actor-kind', 'user');

    // The type heads the row and the status sits at its trailing edge.
    await expect(row.getByTestId('ledger-entry-type')).toHaveText('Task');
    await expect(row.getByTestId('ledger-entry-row-status')).toHaveText(
      'Completed',
    );

    // Open chat is on the row itself: its details stay closed.
    const openSource = row.getByTestId('ledger-entry-source-open').first();
    await expect(openSource).toHaveText('Open chat');
    await expect(rootDetailsToggle(row)).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // It opens the delegate's own chat, not the chat that started it.
    await openSource.click();
    const subagentChat = window.getByTestId('subagent-chat-panel').filter({
      has: window.locator(
        `[data-testid="subagent-chat-banner"] nav > span[title="${delegateTitle}"]`,
      ),
    });
    await expect(subagentChat).toBeVisible();
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-delegate-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: an archived chat and a delegate it started say so and open the archived chat', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const archivedChatId = 'ledger-archived-chat';
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await launchCodeWorktree(
    userDataDir,
    LEDGER_ON,
    [
      {
        id: archivedChatId,
        title: 'Old parser notes',
        createdAt: new Date().toISOString(),
        messages: [
          {
            id: 'ledger-archived-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Where does recovery start?' }],
            timestamp: Date.now() - 20_000,
          },
          {
            id: 'ledger-archived-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Recovery starts in the reader.' }],
            timestamp: Date.now() - 10_000,
          },
        ],
      },
    ],
  );

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    await addLedgerEntry(electronApp, {
      scope,
      author: {
        kind: 'chat',
        chatId: archivedChatId,
        displayName: 'Old parser notes',
      },
      params: {
        type: 'DECISION',
        title: 'Start recovery in the reader',
        content: 'The reader already knows the last complete event.',
      },
    });
    await addLedgerEntry(electronApp, {
      scope,
      author: {
        kind: 'delegate',
        delegationId: 'ledger-archived-delegate',
        displayName: 'Check the reader offsets',
        rootChatId: archivedChatId,
        rootChatName: 'Old parser notes',
      },
      params: {
        type: 'OBSERVATION',
        title: 'Offsets reset after a reconnect',
        content: 'The reader keeps the offset of the last complete event.',
      },
    });

    // Closing the chat archives it.
    await closePanelTab(window, `panel-chat-${archivedChatId}`);
    await expect(window.getByTestId('chat-tab-archive-count')).toHaveText('1');

    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);

    // The chat's own row says its chat is archived.
    const chatRow = rowTitled(panel, 'Start recovery in the reader');
    const chatSource = chatRow.getByTestId('ledger-entry-source-open').first();
    await expect(chatSource).toHaveText('Open archived chat');
    await expect(chatSource).toHaveAttribute('data-source-archived', 'true');
    await chatSource.hover();
    await expect(window.getByRole('tooltip')).toHaveText(
      'This chat is archived. It opens read-only.',
    );
    await window.mouse.move(0, 0);
    await expect(window.getByRole('tooltip')).toHaveCount(0);

    // So does the row of the delegate that chat started.
    const delegateRow = rowTitled(panel, 'Offsets reset after a reconnect');
    const delegateSource = delegateRow
      .getByTestId('ledger-entry-source-open')
      .first();
    await expect(delegateSource).toHaveText('Open archived chat');
    await expect(delegateSource).toHaveAttribute(
      'data-source-archived',
      'true',
    );
    await delegateSource.hover();
    await expect(window.getByRole('tooltip')).toHaveText(
      'The chat that started this delegate is archived. It opens read-only.',
    );

    // With no live chat to show a subagent panel in, the archived chat opens.
    await delegateSource.click();
    const viewer = window.getByTestId('archived-chat-transcript-modal');
    await expect(
      viewer.getByText('Recovery starts in the reader.'),
    ).toBeVisible();
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-archived-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: add an entry, assign it and take it back, close it and correct it', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  // A chat created from a plan, then named by what it is about.
  const { electronApp, window } = await launchCodeWorktree(
    userDataDir,
    LEDGER_ON,
    [
      {
        id: 'chat-plan-auth',
        title: 'Plan: auth overhaul',
        description: 'Fix login redirect',
      },
    ],
  );

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    await expect(panel.getByTestId('ledger-empty')).toBeVisible();
    const addEntry = panel.getByTestId('ledger-add-entry');
    await expect(addEntry).toHaveText('Add a task, decision or finding');

    // --- The composer opens in its place above the rows, while the toolbar
    // remains available.
    await addEntry.click();
    const form = panel.getByTestId('ledger-entry-form');
    await expect(form).toBeVisible();
    await expect(form.getByTestId('ledger-entry-form-content')).toBeFocused();
    await expect(
      form.getByText('Title (optional)', { exact: true }),
    ).toBeVisible();
    await expect(panel.getByTestId('ledger-toolbar')).toBeVisible();
    await expect(addEntry).toHaveCount(0);
    await expect(
      panel.getByTestId('ledger-list-pane').getByTestId('ledger-entry-form'),
    ).toBeVisible();
    await expect(
      form
        .getByTestId('ledger-entry-form-type')
        .getByTestId('ledger-entry-type-icon'),
    ).toHaveAttribute('data-type', 'TASK');
    await expect(form.getByTestId('ledger-entry-form-author')).toHaveText(
      'Added by you',
    );
    await expect(form.getByTestId('ledger-owner-picker')).toHaveText('You');
    await form
      .getByTestId('ledger-entry-form-title')
      .fill('Write the release notes');
    await form
      .getByTestId('ledger-entry-form-content')
      .fill('Cover the Ledger panel and its sources.');
    await form.getByTestId('ledger-entry-form-save').click();
    await expect(form).toBeHidden();
    await expect(addEntry).toBeVisible();
    await expect(addEntry).toHaveText('Add a task, decision or finding');
    const row = rowTitled(panel, 'Write the release notes');
    await expect(row).toBeVisible();
    // Saving opens nothing; the entry's details open from its own toggle.
    await expect(row).not.toHaveAttribute('aria-current', 'true');
    await expect(rootDetailsToggle(row)).toHaveText('Show details');
    await rootDetailsToggle(row).click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    const entryId = await row.getAttribute('data-entry-id');
    expect(entryId).not.toBeNull();
    const owner = row.getByTestId('ledger-owner-picker').first();
    await expect(owner).toContainText('You');

    // --- Assigned to a chat, then taken back. Chats read as their tabs do:
    // by the name generated for them, not the plan they started from.
    await owner.click();
    const menu = window.getByTestId('ledger-owner-menu');
    await expect(menu).toContainText(
      'Assigning this entry does not start the session.',
    );
    await expect(
      menu
        .getByTestId('ledger-owner-option')
        .filter({ hasText: 'Fix login redirect' }),
    ).toHaveCount(1);
    await expect(menu).not.toContainText('Plan: auth overhaul');
    await menu
      .getByTestId('ledger-owner-option')
      .filter({ hasText: 'Parser fixes' })
      .click();
    await expect(owner).toContainText('Parser fixes');
    await expect(row.getByTestId('ledger-entry-detail-owner')).toHaveText(
      'Parser fixes',
    );
    await owner.click();
    await window.getByTestId('ledger-owner-option-you').click();
    await expect(owner).toContainText('You');
    await expect(row.getByTestId('ledger-entry-detail-owner')).toHaveText(
      'You',
    );

    // --- The status changes in place; a closing status locks the entry.
    const status = row.getByTestId('ledger-status-control').first();
    await status.click();
    await window.getByTestId('ledger-status-option-in_progress').click();
    await expect(status).toHaveText('In progress');
    await expect(
      row.getByTestId('ledger-entry-activity').first(),
    ).toBeVisible();
    await status.click();
    await window.getByTestId('ledger-status-option-completed').click();
    await expect(row.getByTestId('ledger-entry-closed')).toHaveText(
      "Completed entries can't change. Add a correction to record something new.",
    );
    await expect(row.getByTestId('ledger-entry-row-status').first()).toHaveText(
      'Completed',
    );
    await expect(panel.getByTestId('ledger-status-control')).toHaveCount(0);
    await expect(panel.getByTestId('ledger-owner-picker')).toHaveCount(0);

    // --- A correction starts under the root without opening details. App
    // Advisor can open the entry without moving or hiding that independent
    // correction draft.
    await rootDetailsToggle(row).click();
    await expect(row).not.toHaveAttribute('aria-current', 'true');
    await expect(rootDetailsToggle(row)).toHaveText('Show details');
    await row.getByTestId('ledger-entry-add-correction').click();
    const correctionBox = row.getByTestId('ledger-correction-box');
    await expect(correctionBox).toBeVisible();
    await expect(
      correctionBox.getByTestId('ledger-correction-input'),
    ).toBeFocused();
    await expect(
      correctionBox.getByTestId('ledger-correction-more'),
    ).toHaveText('More options');
    await expect(
      correctionBox.getByTestId('ledger-correction-discard'),
    ).toHaveText('Cancel');
    await expect(
      correctionBox.getByTestId('ledger-correction-save'),
    ).toHaveText('Add correction');
    await correctionBox
      .getByTestId('ledger-correction-input')
      .fill('Also cover the Feed.');
    await expect(addEntry).toBeEnabled();
    await openInLedger(electronApp, scope, entryId);
    await expect(correctionBox).toBeVisible();
    await expect(
      correctionBox.getByTestId('ledger-correction-input'),
    ).toHaveValue('Also cover the Feed.');
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(rootDetailsToggle(row)).toHaveText('Hide details');
    await expect(addEntry).toBeEnabled();
    await expect
      .poll(async () => {
        const response = await getAdvisorUiState(electronApp);
        const ledgerPanel = response.uiState?.snapshot.ledgerPanels?.find(
          (candidate) =>
            candidate.projectId === scope.projectId &&
            candidate.worktreeId === scope.worktreeId,
        );
        return ledgerPanel === undefined
          ? null
          : {
              selectedEntryId: ledgerPanel.selectedEntryId,
              draft: ledgerPanel.draft ?? null,
            };
      })
      // App Advisor knows a correction is being written there, never its text.
      .toEqual({ selectedEntryId: entryId, draft: 'shown' });
    await rootDetailsToggle(row).click();
    await expect(row).not.toHaveAttribute('aria-current', 'true');
    await correctionBox.getByTestId('ledger-correction-more').click();
    await expect(form).toBeVisible();
    await expect(form.locator('h2')).toHaveText('Correction');
    await expect(form.getByTestId('ledger-entry-form-discard')).toHaveText(
      'Cancel',
    );
    await expect(form.getByTestId('ledger-entry-form-content')).toHaveValue(
      'Also cover the Feed.',
    );
    await form.getByTestId('ledger-entry-form-save').click();
    await expect(form).toBeHidden();
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(1);
    const correction = row.getByTestId('ledger-entry-correction');
    await expect(correction).toHaveCount(1);
    await expect(correction).toContainText('Also cover the Feed.');
    await expect(row).not.toHaveAttribute('aria-current', 'true');
    await expect(correction).not.toHaveAttribute('aria-current', 'true');
    await expect(rootDetailsToggle(row)).toHaveText('Show details');
    await expect(rootDetailsToggle(row)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(replyDetailsToggle(correction)).toHaveText('Show details');
    await expect(replyDetailsToggle(correction)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(rootAddCorrection(row)).toHaveCount(0);
    await expect(
      correction.getByTestId('ledger-entry-add-correction'),
    ).toHaveCount(1);
    await rootDetailsToggle(row).click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(correction).not.toHaveAttribute('aria-current', 'true');
    await expect(row.getByTestId('ledger-entry-row-status').first()).toHaveText(
      'Completed',
    );
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-write-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: correction drafts stay independent from each other and the new-entry draft', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await launchCodeWorktree(userDataDir);

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    for (const [title, content] of [
      ['Update parser retries', 'Keep the retry path observable.'],
      ['Clarify release checks', 'Explain which checks gate a release.'],
    ]) {
      await addLedgerEntry(electronApp, {
        scope,
        author: USER,
        params: { type: 'TASK', title, content },
      });
    }

    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    const firstRow = rowTitled(panel, 'Update parser retries');
    const secondRow = rowTitled(panel, 'Clarify release checks');
    const addEntry = panel.getByTestId('ledger-add-entry');

    // Regression: the old single correction draft blocked/replaced the
    // second box and disabled Add entry while the first draft was waiting.
    await firstRow.getByTestId('ledger-entry-add-correction').click();
    const firstBox = firstRow.getByTestId('ledger-correction-box');
    await expect(firstBox).toBeVisible();
    await firstBox
      .getByTestId('ledger-correction-input')
      .fill('Add a retry warning to the notes.');
    await expect(addEntry).toBeEnabled();

    const secondAddCorrection = secondRow.getByTestId(
      'ledger-entry-add-correction',
    );
    await expect(secondAddCorrection).toBeEnabled();
    await secondAddCorrection.click();
    const secondBox = secondRow.getByTestId('ledger-correction-box');
    await expect(secondBox).toBeVisible();
    await secondBox
      .getByTestId('ledger-correction-input')
      .fill('Name the release gate in the notes.');
    await expect(firstBox.getByTestId('ledger-correction-input')).toHaveValue(
      'Add a retry warning to the notes.',
    );
    await expect(secondBox.getByTestId('ledger-correction-input')).toHaveValue(
      'Name the release gate in the notes.',
    );
    await expect(addEntry).toBeEnabled();

    await addEntry.click();
    const form = panel.getByTestId('ledger-entry-form');
    await expect(form).toBeVisible();
    const titleField = form.getByTestId('ledger-entry-form-title');
    const contentField = form.getByTestId('ledger-entry-form-content');
    await expect(contentField).toBeFocused();
    await titleField.fill('Review generated release summary');
    await contentField.fill('Keep this as a separate new-entry draft.');
    await expect(firstBox).toBeVisible();
    await expect(secondBox).toBeVisible();

    await firstBox.getByTestId('ledger-correction-save').click();
    await expect(firstBox).toBeHidden();
    await expect(secondBox).toBeVisible();
    await expect(secondBox.getByTestId('ledger-correction-input')).toHaveValue(
      'Name the release gate in the notes.',
    );
    await expect(form).toBeVisible();
    await expect(titleField).toHaveValue('Review generated release summary');
    await expect(contentField).toHaveValue(
      'Keep this as a separate new-entry draft.',
    );
    await expect(
      panel.locator(
        '[data-testid="ledger-entry-row"][aria-current="true"], [data-testid="ledger-entry-correction"][aria-current="true"]',
      ),
    ).toHaveCount(0);
    await expect(rootDetailsToggle(firstRow)).toHaveText('Show details');
    await expect(rootDetailsToggle(secondRow)).toHaveText('Show details');

    const savedCorrection = firstRow
      .getByTestId('ledger-entry-correction')
      .filter({ hasText: 'Add a retry warning to the notes.' });
    await expect(savedCorrection).toBeVisible();
    await expect(replyDetailsToggle(savedCorrection)).toHaveText(
      'Show details',
    );
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-independent-drafts-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: a stale revision and a resumed pipeline agent are refused', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await launchCodeWorktree(userDataDir);

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    const entry = await addLedgerEntry(electronApp, {
      scope,
      author: SEEDED_CHAT,
      params: {
        type: 'TASK',
        title: 'Update parser recovery',
        content: 'Preserve incomplete events after reconnection.',
      },
    });
    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    const row = rowTitled(panel, 'Update parser recovery');
    await rootDetailsToggle(row).click();
    const status = row.getByTestId('ledger-status-control').first();
    const owner = row.getByTestId('ledger-owner-picker').first();
    const notice = row.getByTestId('ledger-entry-change-notice');
    await expect(status).toContainText('To do');

    // --- Another writer changed the entry before the panel heard of it.
    await updateLedgerEntry(electronApp, {
      scope,
      author: SEEDED_CHAT,
      quiet: true,
      params: {
        entryId: entry.entryId,
        expectedRevision: 1,
        status: 'BLOCKED',
      },
    });
    await status.click();
    await window.getByTestId('ledger-status-option-in_progress').click();
    await expect(notice).toContainText(
      'This entry changed. Review the latest version.',
    );
    await expect(status).toContainText('Blocked');

    // --- A picker opened before the run resumed cannot assign its agent.
    await pausePipelineAgent(electronApp, {
      scope,
      executionId: PIPELINE_EXECUTION_ID,
      jobId: 'review',
      stepId: 'agent',
      displayName: 'Review changes',
      checkpointId: 'checkpoint-1',
    });
    await expect(owner).toContainText('Parser fixes');
    await owner.click();
    const agent = window
      .getByTestId('ledger-owner-option')
      .filter({ hasText: 'Review changes' });
    await expect(agent).toContainText('job review, step agent');
    await resumePipelineExecution(electronApp, PIPELINE_EXECUTION_ID);
    await agent.click();
    await expect(notice).toContainText(
      "That owner can't be assigned anymore. Choose another.",
    );
    await expect(owner).toContainText('Parser fixes');
    await owner.click();
    await expect(window.getByTestId('ledger-owner-option-you')).toBeVisible();
    await expect(
      window
        .getByTestId('ledger-owner-option')
        .filter({ hasText: 'Review changes' }),
    ).toHaveCount(0);
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-refusal-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: in a narrow panel, the composer and rows fit the column, and a draft set aside continues', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await launchCodeWorktree(userDataDir);

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    const entry = await addLedgerEntry(electronApp, {
      scope,
      author: SEEDED_CHAT,
      params: {
        type: 'TASK',
        title: 'Update parser recovery',
        content: 'Preserve incomplete events after reconnection.',
      },
    });
    await window.setViewportSize({ width: 820, height: 900 });
    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    const list = panel.getByTestId('ledger-list-pane');
    const row = rowTitled(panel, 'Update parser recovery');
    await rootDetailsToggle(row).click();
    await expect(row.getByTestId('ledger-entry-details')).toBeVisible();
    await expect
      .poll(() =>
        list.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      )
      .toBe(true);

    // --- The composer takes its place above the row without hiding the
    // toolbar or widening the list.
    await panel.getByTestId('ledger-add-entry').click();
    const form = panel.getByTestId('ledger-entry-form');
    await expect(form).toBeVisible();
    await expect(panel.getByTestId('ledger-toolbar')).toBeVisible();
    await expect(row).toBeVisible();
    const formPrecedesRow = await form.evaluate(
      (formElement, rowElement) =>
        Boolean(
          formElement.compareDocumentPosition(rowElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      await row.elementHandle(),
    );
    expect(formPrecedesRow).toBe(true);
    await expect
      .poll(() =>
        list.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      )
      .toBe(true);
    await form
      .getByTestId('ledger-entry-form-title')
      .fill('Check the reconnect test');
    await openInLedger(electronApp, scope, entry.entryId);
    await expect(form).toBeHidden();
    await expect(panel.getByTestId('ledger-toolbar')).toBeVisible();
    await expect(panel.getByTestId('ledger-add-entry')).toHaveText(
      'Continue draft',
    );
    await expect(row).toHaveAttribute('aria-current', 'true');

    await panel.getByTestId('ledger-add-entry').click();
    await expect(form.getByTestId('ledger-entry-form-title')).toHaveValue(
      'Check the reconnect test',
    );
    await expect(form.getByTestId('ledger-entry-form-discard')).toHaveText(
      'Cancel',
    );
    await form.getByTestId('ledger-entry-form-discard').click();
    await expect(form).toBeHidden();
    await expect(panel.getByTestId('ledger-add-entry')).toHaveText(
      'Add a task, decision or finding',
    );
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-narrow-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: the newest correction can be corrected, and replies open in place', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await launchCodeWorktree(userDataDir);

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    const rootEntry = await addLedgerEntry(electronApp, {
      scope,
      author: USER,
      params: {
        type: 'TASK',
        title: 'Ship the parser fix',
        content: 'Ship the tested parser change.',
      },
    });
    const replyBEntry = await addLedgerEntry(electronApp, {
      scope,
      author: USER,
      params: {
        type: 'TASK',
        title: 'Ship the parser fix',
        content: 'Also cover the reconnect path.',
        status: 'TODO',
        supersedesEntryId: rootEntry.entryId,
      },
    });
    const replyCEntry = await addLedgerEntry(electronApp, {
      scope,
      author: SEEDED_CHAT,
      params: {
        type: 'OBSERVATION',
        title: 'Ship the parser fix',
        content: 'The reconnect path already has a test.',
        supersedesEntryId: replyBEntry.entryId,
      },
    });

    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(1);
    const thread = panel.locator(
      `[data-testid="ledger-entry-thread"][data-root-entry-id="${rootEntry.entryId}"]`,
    );
    const rootRow = thread.getByTestId('ledger-entry-row');
    const replies = thread.getByTestId('ledger-entry-correction');
    await expect(replies).toHaveCount(2);
    const replyB = thread.locator(
      `[data-testid="ledger-entry-correction"][data-entry-id="${replyBEntry.entryId}"]`,
    );
    const replyC = thread.locator(
      `[data-testid="ledger-entry-correction"][data-entry-id="${replyCEntry.entryId}"]`,
    );
    await expect(
      replyC.getByTestId('ledger-entry-correction-target'),
    ).toHaveText('Corrects a reply');
    await expect(
      replyB.getByTestId('ledger-entry-correction-target'),
    ).toHaveCount(0);
    await expect(rootAddCorrection(rootRow)).toHaveCount(0);
    await expect(replyB.getByTestId('ledger-entry-add-correction')).toHaveCount(
      0,
    );
    await expect(replyC.getByTestId('ledger-entry-add-correction')).toHaveCount(
      1,
    );

    // --- Each reply opens independently; its own status and owner controls
    // remain on that reply.
    await replyDetailsToggle(replyB).click();
    await expect(replyB).toHaveAttribute('aria-current', 'true');
    await expect(rootRow).not.toHaveAttribute('aria-current', 'true');
    await expect(rootDetailsToggle(rootRow)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(replyDetailsToggle(replyB)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(replyDetailsToggle(replyB)).toHaveText('Hide details');
    await expect(replyB.getByTestId('ledger-entry-details')).toBeVisible();
    const replyStatus = replyB.getByTestId('ledger-status-control').first();
    await replyStatus.click();
    await window.getByTestId('ledger-status-option-in_progress').click();
    await expect(replyStatus).toHaveText('In progress');
    const replyOwner = replyB.getByTestId('ledger-owner-picker').first();
    await replyOwner.click();
    await window
      .getByTestId('ledger-owner-option')
      .filter({ hasText: 'Parser fixes' })
      .click();
    await expect(replyOwner).toContainText('Parser fixes');

    // --- Only the newest correction, C, can start another correction. It
    // stays on that reply and does not open details.
    await replyDetailsToggle(replyB).click();
    await expect(replyB).not.toHaveAttribute('aria-current', 'true');
    await expect(replyDetailsToggle(replyB)).toHaveText('Show details');
    await replyC.getByTestId('ledger-entry-add-correction').click();
    const correctionBox = thread.getByTestId('ledger-correction-box');
    await expect(correctionBox).toBeVisible();
    await correctionBox
      .getByTestId('ledger-correction-input')
      .fill('The reconnect path is covered now.');
    await expect(rootRow).not.toHaveAttribute('aria-current', 'true');
    await expect(replyC).not.toHaveAttribute('aria-current', 'true');
    await correctionBox.getByTestId('ledger-correction-save').click();
    await expect(replies).toHaveCount(3);
    const replyD = replies.filter({
      hasText: 'The reconnect path is covered now.',
    });
    await expect(
      replyD.getByTestId('ledger-entry-correction-target'),
    ).toHaveText('Corrects a reply');
    await expect(replyD).toContainText('The reconnect path is covered now.');
    await expect(rootAddCorrection(rootRow)).toHaveCount(0);
    await expect(replyC.getByTestId('ledger-entry-add-correction')).toHaveCount(
      0,
    );
    await expect(replyD.getByTestId('ledger-entry-add-correction')).toHaveCount(
      1,
    );
    await expect(rootRow).not.toHaveAttribute('aria-current', 'true');
    await expect(replyD).not.toHaveAttribute('aria-current', 'true');
    await expect(rootDetailsToggle(rootRow)).toHaveText('Show details');
    await expect(rootDetailsToggle(rootRow)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(replyDetailsToggle(replyD)).toHaveText('Show details');
    await expect(replyDetailsToggle(replyD)).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // --- App Advisor can select any nested reply in the same thread.
    await openInLedger(electronApp, scope, replyCEntry.entryId);
    await expect(replyC).toHaveAttribute('aria-current', 'true');
    await expect(replyB).not.toHaveAttribute('aria-current', 'true');
    await expect(replyD).not.toHaveAttribute('aria-current', 'true');
    await expect(rootDetailsToggle(rootRow)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(replyDetailsToggle(replyC)).toHaveText('Hide details');
    await expect(replyDetailsToggle(replyC)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(replyDetailsToggle(replyB)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(replyDetailsToggle(replyD)).toHaveText('Show details');
    await expect(replyC.getByTestId('ledger-entry-details')).toBeVisible();
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-correction-thread-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: a long list windows its rows and keeps the reading position across a correction', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await launchCodeWorktree(userDataDir);

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    await electronApp.evaluate(
      async (_electron, payload) => {
        const ledger = globalThis.__CANOPY_E2E_LEDGER__;
        if (!ledger) throw new Error('The E2E Ledger seeder is unavailable');
        for (let n = 1; n <= 130; n += 1) {
          await ledger.addEntry({
            scope: payload.scope,
            author: payload.author,
            params: {
              type: 'TASK',
              title: `Check parser case ${n}`,
              content: `Review parser case ${n}.`,
              status: 'TODO',
            },
          });
        }
      },
      { scope, author: USER },
    );

    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    const list = panel.getByTestId('ledger-entry-list');
    await expect(list).toHaveAttribute('data-entry-count', '30');
    while (Number(await list.getAttribute('data-entry-count')) < 130) {
      const previousCount = Number(await list.getAttribute('data-entry-count'));
      const loadMore = panel.getByTestId('ledger-load-more');
      await expect(loadMore).toBeVisible();
      await loadMore.click();
      await expect
        .poll(async () => Number(await list.getAttribute('data-entry-count')))
        .toBe(Math.min(previousCount + 30, 130));
    }
    await expect(list).toHaveAttribute('data-entry-count', '130');
    await expect(list).toHaveAttribute('data-virtualized', 'true');
    expect(await panel.getByTestId('ledger-entry-row').count()).toBeLessThan(
      60,
    );

    const row = await scrollLedgerPaneToRow(panel, 'Check parser case 10');
    await expect(row).toBeVisible();
    await expect.poll(() => rowIntersectsListPane(panel, row)).toBe(true);
    await rootDetailsToggle(row).click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(row.getByTestId('ledger-entry-details')).toBeVisible();
    const pane = panel.getByTestId('ledger-list-pane');
    const scrollBeforeSave = await pane.evaluate(
      (element) => element.scrollTop,
    );
    expect(scrollBeforeSave).toBeGreaterThan(1000);

    await row.getByTestId('ledger-entry-add-correction').click();
    const correctionBox = row.getByTestId('ledger-correction-box');
    await expect(correctionBox).toBeVisible();
    await correctionBox
      .getByTestId('ledger-correction-input')
      .fill('Keep the disconnected parser case covered.');
    await correctionBox.getByTestId('ledger-correction-save').click();
    await expect(row.getByTestId('ledger-entry-correction')).toContainText(
      'Keep the disconnected parser case covered.',
    );
    const scrollAfterSave = await pane.evaluate((element) => element.scrollTop);
    expect(scrollAfterSave).toBeGreaterThan(1000);
    await expect.poll(() => rowIntersectsListPane(panel, row)).toBe(true);
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-long-list-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code worktree Ledger: a slow first read shows entry rows in skeleton, then the entries in place', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-ledger-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await launchCodeWorktree(userDataDir);

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    await addLedgerEntry(electronApp, {
      scope,
      author: USER,
      params: {
        type: 'TASK',
        title: 'Write the release notes',
        content: 'Cover the loading pattern.',
      },
    });
    // Hold the panel's first list read until the test lets it go.
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'ledger:search-entries';
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      const held = new Promise((resolve) => {
        globalThis.releaseLedgerSearch = resolve;
      });
      ipcMain.handle(channel, async (event, request) => {
        await held;
        return original(event, request);
      });
    });

    const panel = await addLedgerPanel(window, DEFAULT_GROUP_IDS.chat);
    // No "Loading Feed…" or "Loading entries…" copy: rows in skeleton, in
    // the shared delayed placeholder, shown once the delay passes.
    const placeholder = panel.getByTestId('delayed-loading-placeholder');
    await expect(placeholder).toHaveAttribute('data-visible', 'true');
    const skeleton = placeholder.getByTestId('ledger-thread-list-skeleton');
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute('data-density', 'panel');
    await expect(panel).not.toContainText('Loading entries…');
    await expect(panel).not.toContainText('Loading Feed…');
    await expect(panel.getByTestId('ledger-entry-row')).toHaveCount(0);
    // The note waits for a slow read.
    await expect(placeholder.getByTestId('slow-load-note')).toHaveText('');
    const skeletonRowHeight = await skeleton
      .getByTestId('ledger-thread-list-skeleton-row')
      .first()
      .evaluate((row) => row.getBoundingClientRect().height);
    // The placeholder fills only the room under the composer, so the pane
    // never scrolls and the composer keeps its width when the entries land.
    const listPane = panel.getByTestId('ledger-list-pane');
    const paneOverflow = () =>
      listPane.evaluate((pane) => pane.scrollHeight - pane.clientHeight);
    expect(await paneOverflow()).toBeLessThanOrEqual(0);
    const composerWidth = () =>
      panel
        .getByTestId('ledger-add-entry')
        .evaluate((pill) => pill.getBoundingClientRect().width);
    const loadingComposerWidth = await composerWidth();

    await electronApp.evaluate(() => globalThis.releaseLedgerSearch());
    await expect(rowTitled(panel, 'Write the release notes')).toBeVisible();
    expect(await composerWidth()).toBe(loadingComposerWidth);
    // A skeleton row stands at a one-line entry's height.
    const rowHeight = await rowTitled(
      panel,
      'Write the release notes',
    ).evaluate((row) => row.getBoundingClientRect().height);
    expect(Math.abs(rowHeight - skeletonRowHeight)).toBeLessThanOrEqual(2);
    await expect(panel.getByTestId('ledger-thread-list-skeleton')).toHaveCount(
      0,
    );
    await expect(panel.getByTestId('slow-load-note')).toHaveCount(0);
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-loading-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
