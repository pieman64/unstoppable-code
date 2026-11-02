// CAN-4789: in a Cowork Work Entry, every way of opening a file (Cmd+P, a
// file tab's tree, a Created files chip, an inline mention, a markdown link)
// lands in one documents group beside the chat. The conversation, its
// Created files chips and the composer stay visible throughout.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getActiveGroupId, getLayout } from './panelHarness.mjs';
import {
  CREATED_FILES_CHAT,
  CREATED_FILES_TURN,
  openCreatedFiles,
  seedCreatedFiles,
} from './createdFilesFixture.mjs';

import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

const CHAT_PANEL_ID = `panel-chat-${CREATED_FILES_CHAT}`;

/** The panel id of the open file tab titled `name`. */
async function filePanelId(window, name) {
  const tab = window
    .locator('[data-testid^="panel-tab-panel-file-"]')
    .filter({ hasText: name });
  await expect(tab).toHaveCount(1);
  const testId = await tab.getAttribute('data-testid');
  return testId.replace(/^panel-tab-/, '');
}

function leafHolding(layout, panelId) {
  return collectLeaves(layout.root).find((leaf) =>
    leaf.panels.some((panel) => panel.panelId === panelId),
  );
}

function filePanelCount(layout) {
  return collectLeaves(layout.root).flatMap((leaf) =>
    leaf.panels.filter((panel) => panel.kind === 'file-diff'),
  ).length;
}

/**
 * After every open: the file is selected in the documents group, the chat
 * stays selected in its own group (holding no files), focus is on the file,
 * and the composer is visible and editable.
 */
async function expectFileBesideChat(window, chat, name, documentsGroupId) {
  const panelId = await filePanelId(window, name);
  let layout = null;
  await expect
    .poll(async () => {
      layout = await getLayout(window);
      const fileLeaf = layout ? leafHolding(layout, panelId) : undefined;
      const chatLeaf = layout ? leafHolding(layout, CHAT_PANEL_ID) : undefined;
      return {
        fileSelected: fileLeaf?.activePanelId === panelId,
        chatSelected: chatLeaf?.activePanelId === CHAT_PANEL_ID,
        chatGroupHoldsFiles:
          chatLeaf?.panels.some((panel) => panel.kind === 'file-diff') ?? true,
        separateGroups:
          fileLeaf !== undefined && fileLeaf.groupId !== chatLeaf?.groupId,
      };
    })
    .toEqual({
      fileSelected: true,
      chatSelected: true,
      chatGroupHoldsFiles: false,
      separateGroups: true,
    });
  const fileGroupId = leafHolding(layout, panelId).groupId;
  if (documentsGroupId !== undefined) {
    expect(fileGroupId).toBe(documentsGroupId);
  }
  // The documents group sits to the right of the chat.
  const chatBox = await window
    .getByTestId(`panel-group-${leafHolding(layout, CHAT_PANEL_ID).groupId}`)
    .boundingBox();
  const fileBox = await window
    .getByTestId(`panel-group-${fileGroupId}`)
    .boundingBox();
  expect(fileBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width - 2);
  await expect.poll(() => getActiveGroupId(window)).toBe(fileGroupId);
  await expect
    .poll(() =>
      window.evaluate((groupId) => {
        const group = document.querySelector(
          `[data-testid="panel-group-${groupId}"]`,
        );
        return group?.contains(document.activeElement) ?? false;
      }, fileGroupId),
    )
    .toBe(true);
  await expect(chat).toBeVisible();
  const composer = chat.locator('[data-chat-textarea][contenteditable="true"]');
  await expect(composer).toBeVisible();
  await expect(composer).toBeEditable();
  return { fileGroupId, layout };
}

test('Cowork opens files in one documents group beside a visible chat', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-file-placement-'),
  );
  const fixture = seedCreatedFiles(userDataDir, true, { markdownLink: true });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);

    // 1. Cmd+P.
    await window.keyboard.press(
      `${process.platform === 'darwin' ? 'Meta' : 'Control'}+p`,
    );
    const palette = window.getByTestId('file-search-palette');
    await expect(palette).toBeVisible();
    await palette.getByTestId('file-search-palette-input').fill('summary.txt');
    await expect(
      palette.getByTestId('file-search-palette-result').first(),
    ).toHaveAttribute('data-path', 'outputs/summary.txt');
    await palette.getByTestId('file-search-palette-input').press('Enter');
    await expect(palette).toHaveCount(0);
    const { fileGroupId: documentsGroupId } = await expectFileBesideChat(
      window,
      chat,
      'summary.txt',
    );

    // 2. The open file tab's tree.
    const summaryPanel = window.locator(
      `[data-testid="panel-content-file-diff"][data-panel-id="${await filePanelId(window, 'summary.txt')}"]`,
    );
    await summaryPanel.getByTestId('file-tab-tree-toggle').click();
    const treeRow = summaryPanel
      .getByTestId('file-tab-tree')
      .locator('[data-testid="files-tree-row"][data-path="outputs/page.html"]');
    await expect(treeRow).toBeVisible({ timeout: 20_000 });
    await treeRow.click();
    await expectFileBesideChat(window, chat, 'page.html', documentsGroupId);

    // 3. A Created files chip.
    const summary = chat.locator(
      `[data-testid="turn-files"][data-turn-id="${CREATED_FILES_TURN}"]`,
    );
    const chip = summary.getByRole('button', { name: 'Open analysis.py' });
    await chip.click();
    await expectFileBesideChat(window, chat, 'analysis.py', documentsGroupId);
    // The chip places its batch beside the chat only after the tab's creation
    // is acknowledged; wait for that so it cannot reselect its file over the
    // next open.
    await expect(chip).toHaveAttribute('aria-busy', 'false');
    // The reply and its chips stay in view, not just the composer.
    await expect(
      chat.getByText('The quarterly report and supporting files are ready.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(summary.getByTestId('turn-file-chip').first()).toBeVisible();

    // 4. A markdown link opens a new file; an inline mention and the same
    // link then reopen existing files without adding panels.
    const link = chat
      .getByTestId('chat-local-file-link')
      .filter({ hasText: 'the budget' });
    await link.click();
    const { layout } = await expectFileBesideChat(
      window,
      chat,
      'budget.csv',
      documentsGroupId,
    );
    const openedCount = filePanelCount(layout);
    const mention = chat
      .locator('button[aria-label^="Open "]')
      .filter({ hasText: 'outputs/summary.txt' });
    await mention.click();
    const remention = await expectFileBesideChat(
      window,
      chat,
      'summary.txt',
      documentsGroupId,
    );
    expect(filePanelCount(remention.layout)).toBe(openedCount);
    await link.click();
    const reopened = await expectFileBesideChat(
      window,
      chat,
      'budget.csv',
      documentsGroupId,
    );
    expect(filePanelCount(reopened.layout)).toBe(openedCount);

    // 5. The user can return to the composer and type without the layout
    // changing.
    const before = JSON.stringify(
      collectLeaves((await getLayout(window)).root).map((leaf) => leaf.groupId),
    );
    const composer = chat.locator(
      '[data-chat-textarea][contenteditable="true"]',
    );
    await composer.click();
    await window.keyboard.type('Thanks');
    await expect(composer).toContainText('Thanks');
    expect(
      JSON.stringify(
        collectLeaves((await getLayout(window)).root).map(
          (leaf) => leaf.groupId,
        ),
      ),
    ).toBe(before);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('background ShowFiles honors its chat origin before asynchronous creation settles', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-background-origin-'),
  );
  const fixture = seedCreatedFiles(userDataDir, true);
  const persisted = JSON.parse(
    readFileSync(
      path.join(
        userDataDir,
        'workspaces',
        fixture.workspaceId,
        'chats',
        `${fixture.worktreeId}.json`,
      ),
      'utf8',
    ),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: fixture.workspaceId,
    worktreeId: fixture.worktreeId,
    activeTabId: CREATED_FILES_CHAT,
    tabs: [
      ...persisted.tabs,
      { id: 'background-origin', title: 'Background origin', messages: [] },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);
    const layout = await getLayout(window);
    const chatGroupId = leafHolding(layout, CHAT_PANEL_ID).groupId;
    const originGroupId = await window.evaluate(
      ({ groupId, chatPanelId }) => {
        const api = window.__canopyPanelTestApi;
        const originGroup = api.splitPanel(groupId, 'right');
        api.movePanel('panel-chat-background-origin', originGroup, 'center');
        api.focusPanel(groupId, chatPanelId);
        return originGroup;
      },
      { groupId: chatGroupId, chatPanelId: CHAT_PANEL_ID },
    );
    const composer = chat.locator(
      '[data-chat-textarea][contenteditable="true"]',
    );
    await composer.click();
    const result = await window.evaluate(
      (target) =>
        window.__canopyPanelTestApi.showFiles({
          target,
          origin: { ...target, chatTabId: 'background-origin' },
          intent: 'agent',
          presentation: 'background',
          files: [{ path: 'outputs/summary.txt' }],
        }),
      { projectId: fixture.workspaceId, worktreeId: fixture.worktreeId },
    );
    expect(result).toMatchObject({ opened: 1, failed: 0, activated: false });
    const fileId = await filePanelId(window, 'summary.txt');
    const placed = await getLayout(window);
    const fileGroupId = leafHolding(placed, fileId).groupId;
    const originBox = await window
      .getByTestId(`panel-group-${originGroupId}`)
      .boundingBox();
    const fileBox = await window
      .getByTestId(`panel-group-${fileGroupId}`)
      .boundingBox();
    expect(fileBox.x).toBeGreaterThanOrEqual(originBox.x + originBox.width - 2);
    await expect(composer).toBeFocused();
    expect(leafHolding(placed, CHAT_PANEL_ID).activePanelId).toBe(
      CHAT_PANEL_ID,
    );
    expect(
      leafHolding(placed, 'panel-chat-background-origin').activePanelId,
    ).toBe('panel-chat-background-origin');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('ShowFiles removes a refused new file when selection changes during reading', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-selection-race-'),
  );
  const fixture = seedCreatedFiles(userDataDir, true);
  const entriesPath = path.join(
    userDataDir,
    'workspaces',
    fixture.workspaceId,
    'work-entries.json',
  );
  const entries = JSON.parse(readFileSync(entriesPath, 'utf8'));
  entries.entries.push({
    id: 'other-entry',
    createdAt: '2026-09-02T12:00:00.000Z',
  });
  writeFileSync(entriesPath, JSON.stringify(entries));
  seedWorktreeChat({
    userDataDir,
    workspaceId: fixture.workspaceId,
    worktreeId: 'other-entry',
    activeTabId: 'other-chat',
    tabs: [
      {
        id: 'other-chat',
        title: 'Other task',
        messages: [
          {
            id: 'other-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Keep this task separate.' }],
            timestamp: 1,
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  let window;
  try {
    window = await electronApp.firstWindow();
    await openCreatedFiles(window, fixture);
    await electronApp.evaluate(
      ({ ipcMain }, absolutePath) => {
        const channel = 'file:read-content';
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('File read handler not found');
        const gate = { started: false, release: null, original };
        ipcMain.__can4789ReadGate = gate;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          if (!gate.started && args[1]?.absolutePath === absolutePath) {
            gate.started = true;
            await new Promise((resolve) => {
              gate.release = resolve;
            });
          }
          return original(...args);
        });
      },
      path.join(fixture.root, 'outputs/summary.txt'),
    );
    await window.evaluate(
      (target) => {
        window.__can4789Opening = window.__canopyPanelTestApi.showFiles({
          target,
          origin: { ...target, chatTabId: 'created-files-chat' },
          intent: 'agent',
          presentation: 'background',
          files: [{ path: 'outputs/summary.txt' }],
        });
      },
      { projectId: fixture.workspaceId, worktreeId: fixture.worktreeId },
    );
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ ipcMain }) => ipcMain.__can4789ReadGate.started,
        ),
      )
      .toBe(true);
    await window.getByTestId('sidebar-work-entry-other-entry').click();
    await expect(
      window.getByTestId('panel-tab-panel-chat-other-chat'),
    ).toBeVisible();
    await electronApp.evaluate(({ ipcMain }) =>
      ipcMain.__can4789ReadGate.release(),
    );
    expect(await window.evaluate(() => window.__can4789Opening)).toMatchObject({
      opened: 0,
      failed: 1,
      activated: false,
    });
    await expect
      .poll(() =>
        window.evaluate(
          async (scope) => {
            const snapshot = await window.api.chat.getState(scope);
            return snapshot.tabsFile.tabs.some((tab) => tab.kind === 'file');
          },
          { projectId: fixture.workspaceId, worktreeId: fixture.worktreeId },
        ),
      )
      .toBe(false);
    await window
      .getByTestId(`sidebar-work-entry-${fixture.worktreeId}`)
      .click();
    await expect(
      window.locator('[data-testid^="panel-tab-panel-file-"]'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-tab-${CHAT_PANEL_ID}`),
    ).toBeVisible();
  } finally {
    await electronApp
      .evaluate(({ ipcMain }) => {
        const gate = ipcMain.__can4789ReadGate;
        gate?.release?.();
        if (gate) {
          ipcMain.removeHandler('file:read-content');
          ipcMain.handle('file:read-content', gate.original);
        }
      })
      .catch(() => {});
    if (window)
      await window
        .evaluate(async () => {
          await window.__can4789Opening?.catch(() => {});
        })
        .catch(() => {});
    await closeCanopy(electronApp, userDataDir);
  }
});

test('first background open keeps the focused right-hand terminal visible', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-background-terminal-'),
  );
  const fixture = seedCreatedFiles(userDataDir, true);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openCreatedFiles(window, fixture);
    const initial = await getLayout(window);
    const chatGroupId = leafHolding(initial, CHAT_PANEL_ID).groupId;
    const terminalId = collectLeaves(initial.root)
      .flatMap((leaf) => leaf.panels)
      .find((panel) => panel.kind === 'terminal').panelId;
    await window.evaluate(
      ({ terminalId, chatGroupId }) => {
        const api = window.__canopyPanelTestApi;
        api.closeGroup('group-activity');
        api.movePanel(terminalId, chatGroupId, 'right');
      },
      { terminalId, chatGroupId },
    );
    const terminalGroupId = leafHolding(
      await getLayout(window),
      terminalId,
    ).groupId;
    const terminal = window.getByTestId(`panel-group-${terminalGroupId}`);
    await terminal.locator('[role="tab"][tabindex="0"]').click();
    await expect(terminal.getByTestId('panel-content-terminal')).toBeVisible();
    const result = await window.evaluate(
      (target) =>
        window.__canopyPanelTestApi.showFiles({
          target,
          origin: { ...target, chatTabId: 'created-files-chat' },
          intent: 'agent',
          presentation: 'background',
          files: [{ path: 'outputs/summary.txt' }],
        }),
      { projectId: fixture.workspaceId, worktreeId: fixture.worktreeId },
    );
    expect(result).toMatchObject({ opened: 1, failed: 0, activated: false });
    await expect(terminal.getByTestId('panel-content-terminal')).toBeVisible();
    expect(await getActiveGroupId(window)).toBe(terminalGroupId);
    await expect(
      window.getByTestId(`panel-collapsed-bar-${terminalGroupId}`),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        terminal.evaluate((element) =>
          element.contains(element.ownerDocument.activeElement),
        ),
      )
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Cowork opens more than twenty files and reuses existing panels', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-file-capacity-'),
  );
  const fixture = seedCreatedFiles(userDataDir, true);
  const paths = Array.from(
    { length: 21 },
    (_, index) => `outputs/capacity-${String(index).padStart(2, '0')}.txt`,
  );
  for (const name of paths) writeFileSync(path.join(fixture.root, name), name);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);
    const response = await electronApp.evaluate(
      async ({ BrowserWindow, ipcMain }, request) => {
        const main = BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.webContents.getURL().includes('surface=app-advisor'),
        );
        if (!main) throw new Error('Main window not found');
        ipcMain.removeHandler('app-advisor:tool-response');
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('ShowFiles response timed out')),
            45_000,
          );
          ipcMain.handle('app-advisor:tool-response', (_event, result) => {
            if (result.requestId === request.requestId) {
              clearTimeout(timer);
              resolve(result);
            }
          });
          main.webContents.send('app-advisor:tool-request', request);
        });
      },
      {
        kind: 'show_files',
        requestId: 'can-4789-capacity',
        payload: {
          target: {
            projectId: fixture.workspaceId,
            worktreeId: fixture.worktreeId,
          },
          origin: {
            projectId: fixture.workspaceId,
            worktreeId: fixture.worktreeId,
            chatTabId: CREATED_FILES_CHAT,
          },
          intent: 'user',
          files: paths.map((file) => ({ path: file })),
        },
      },
    );
    expect(response).toMatchObject({
      ok: true,
      result: { opened: 21, failed: 0 },
    });
    const placed = await expectFileBesideChat(window, chat, 'capacity-00.txt');
    expect(filePanelCount(placed.layout)).toBe(21);
    await window.keyboard.press(
      `${process.platform === 'darwin' ? 'Meta' : 'Control'}+p`,
    );
    const palette = window.getByTestId('file-search-palette');
    await palette
      .getByTestId('file-search-palette-input')
      .fill('capacity-00.txt');
    await palette.getByTestId('file-search-palette-input').press('Enter');
    await expect(palette).toHaveCount(0);
    const reopened = await expectFileBesideChat(
      window,
      chat,
      'capacity-00.txt',
      placed.fileGroupId,
    );
    expect(filePanelCount(reopened.layout)).toBe(21);
    // Model a saved legacy placement, then reopen another existing file.
    // Revealing the existing legacy panel must work without
    // duplicating it, evicting a document, or creating an overflow group.
    const legacyPanelId = await filePanelId(window, 'capacity-00.txt');
    const chatGroupId = leafHolding(reopened.layout, CHAT_PANEL_ID).groupId;
    await window.evaluate(
      ({ panelId, groupId }) =>
        window.__canopyPanelTestApi.movePanel(panelId, groupId, 'center'),
      { panelId: legacyPanelId, groupId: chatGroupId },
    );
    for (const name of ['capacity-20.txt', 'capacity-00.txt']) {
      await window.keyboard.press(
        `${process.platform === 'darwin' ? 'Meta' : 'Control'}+p`,
      );
      const search = window.getByTestId('file-search-palette');
      await search.getByTestId('file-search-palette-input').fill(name);
      await search.getByTestId('file-search-palette-input').press('Enter');
      await expect(search).toHaveCount(0);
      await expect(
        window.getByTestId(`panel-tab-${await filePanelId(window, name)}`),
      ).toHaveAttribute('data-active', 'true');
    }
    const repaired = await expectFileBesideChat(
      window,
      chat,
      'capacity-00.txt',
      placed.fileGroupId,
    );
    expect(await filePanelId(window, 'capacity-00.txt')).toBe(legacyPanelId);
    expect(filePanelCount(repaired.layout)).toBe(21);
    expect(collectLeaves(repaired.layout.root)).toHaveLength(
      collectLeaves(placed.layout.root).length,
    );
    // Foreground and background agent reopens repair the same inactive legacy
    // panel; background preserves both group selections and focus.
    for (const presentation of ['foreground', 'background']) {
      await window.evaluate(
        ({ panelId, groupId, chatPanelId }) => {
          window.__canopyPanelTestApi.movePanel(panelId, groupId, 'center');
          window.__canopyPanelTestApi.focusPanel(groupId, chatPanelId);
        },
        {
          panelId: legacyPanelId,
          groupId: chatGroupId,
          chatPanelId: CHAT_PANEL_ID,
        },
      );
      const beforeAgentOpen = await getLayout(window);
      const selectedDocument = collectLeaves(beforeAgentOpen.root).find(
        (leaf) => leaf.groupId === placed.fileGroupId,
      ).activePanelId;
      const composer = chat.locator(
        '[data-chat-textarea][contenteditable="true"]',
      );
      await composer.click();
      const agentReopen = await window.evaluate(
        ({ target, presentation }) =>
          window.__canopyPanelTestApi.showFiles({
            target,
            origin: { ...target, chatTabId: 'created-files-chat' },
            intent: 'agent',
            presentation,
            files: [{ path: 'outputs/capacity-00.txt' }],
          }),
        {
          target: {
            projectId: fixture.workspaceId,
            worktreeId: fixture.worktreeId,
          },
          presentation,
        },
      );
      expect(agentReopen).toMatchObject({
        opened: 1,
        failed: 0,
        activated: presentation === 'foreground',
      });
      if (presentation === 'foreground') {
        await expectFileBesideChat(
          window,
          chat,
          'capacity-00.txt',
          placed.fileGroupId,
        );
      } else {
        const settled = await getLayout(window);
        expect(leafHolding(settled, legacyPanelId).groupId).toBe(
          placed.fileGroupId,
        );
        expect(leafHolding(settled, legacyPanelId).activePanelId).toBe(
          selectedDocument,
        );
        expect(leafHolding(settled, CHAT_PANEL_ID).activePanelId).toBe(
          CHAT_PANEL_ID,
        );
        await expect(composer).toBeFocused();
        expect(await getActiveGroupId(window)).toBe(chatGroupId);
      }
      expect(await filePanelId(window, 'capacity-00.txt')).toBe(legacyPanelId);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
