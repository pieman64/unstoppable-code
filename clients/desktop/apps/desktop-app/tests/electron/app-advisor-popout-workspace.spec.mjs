import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedBrowserProfileState,
  readBrowserProfileState,
} from './seeders/browser-profile-state.mjs';

// App Advisor popout → full cowork workspace UX.
//
// The popout renders `AppAdvisorWorkspaceSurface`: a collapsible
// App Advisor-only nav (`app-advisor-nav*` testids) beside a persistent main
// column (top bar + panel grid keyed `(app-advisor, <workEntryId>)` + archive
// overlay + ask-user dock). This spec covers:
//
//  - workspace surface readiness + LAZY first-entry creation (a fresh profile
//    has no Work Entries; the scoped bootstrap creates/reuses one);
//  - entry create / rename / confirmed delete through the nav rows (the
//    shared `WorkEntryRow` with the `app-advisor-nav-entry` testid prefix);
//  - entry switching changing the active nav row (grid scope is keyed by the
//    active entry);
//  - nav collapse persistence through `PreferencesData.appAdvisorNavCollapsed`
//    across relaunch;
//  - fresh-profile window width matches the main app default (clamped to the
//    display work area), while manual resizing persists across relaunch;
//  - the in-popout settings modal (Defaults/Instructions/Advanced tabs) and a
//    CLAUDE.md save round-trip.
//
// The popout's window title is 'Orchestrator' (ORCHESTRATOR_LABEL from
// @canopy/protocol); main-process lookups below match it literally because
// `electronApp.evaluate` callbacks cannot close over imported constants.

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'canopy-app-advisor-workspace-'));
}

function seedPreferences(userDataDir, extra = {}) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  mkdirSync(userDataDir, { recursive: true });
  const preferences = {
    onboardingCompleted: ['v1'],
    ...extra,
  };
  writeFileSync(
    preferencesPath,
    `${JSON.stringify({ version: 1, preferences }, null, 2)}\n`,
    'utf8',
  );
}

function readPreferences(userDataDir) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  return JSON.parse(readFileSync(preferencesPath, 'utf8')).preferences;
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedArchiveFixture(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const tab = (id, title, text) => ({
    id,
    title,
    createdAt: timestamp,
    kind: 'chat',
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        blocks: [{ type: 'text', text }],
        timestamp: Date.parse(timestamp),
      },
    ],
  });

  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: 'entry-archive', createdAt: timestamp }],
  });
  writeJson(path.join(workspaceDir, 'chats', 'entry-archive.json'), {
    version: 1,
    activeTabId: 'scoped-chat',
    tabs: [tab('scoped-chat', 'Scoped archive chat', 'Scoped archive body')],
  });
  writeJson(path.join(workspaceDir, 'chat-archives', 'global.json'), {
    version: 1,
    archived: [
      {
        tab: tab('legacy-chat', 'Legacy archive chat', 'Legacy archive body'),
        archivedAt: timestamp,
        turnCount: 1,
      },
    ],
  });

  const containerDir = path.join(
    workspaceDir,
    'archived-containers',
    'deleted-entry',
  );
  writeJson(path.join(containerDir, 'chats.json'), {
    version: 1,
    activeTabId: 'deleted-chat',
    tabs: [tab('deleted-chat', 'Deleted entry chat', 'Deleted entry body')],
  });
  writeJson(path.join(containerDir, 'chat-archives.json'), {
    version: 1,
    archived: [],
  });
  writeJson(path.join(containerDir, 'container.json'), {
    version: 1,
    id: 'deleted-entry',
    kind: 'work-entry',
    projectId: 'app-advisor',
    name: 'Deleted entry',
    createdAt: timestamp,
    archivedAt: timestamp,
    retentionDays: 7,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
  });
}

/**
 * One Work Entry with two real (non-streaming) chats so ⌘/Ctrl+W has a tab to
 * close before the last one hides App Advisor (CAN-3952). Kept apart from
 * `seedArchiveFixture` so the archive tests keep their single-tab entry.
 */
function seedTwoTabEntryFixture(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const tab = (id, title, text) => ({
    id,
    title,
    createdAt: timestamp,
    kind: 'chat',
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        blocks: [{ type: 'text', text }],
        timestamp: Date.parse(timestamp),
      },
    ],
  });

  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: 'entry-tabs', createdAt: timestamp }],
  });
  writeJson(path.join(workspaceDir, 'chats', 'entry-tabs.json'), {
    version: 1,
    activeTabId: 'chat-b',
    tabs: [
      tab('chat-a', 'First advisor chat', 'First chat body'),
      tab('chat-b', 'Second advisor chat', 'Second chat body'),
    ],
  });
}

// The renderer survives reparenting between the full window and floating host.
function sendAdvisorEvent(electronApp, advisor, channel, payload) {
  return electronApp.evaluate(
    ({ webContents }, request) => {
      const matches = webContents
        .getAllWebContents()
        .filter(
          (contents) =>
            !contents.isDestroyed() &&
            contents.getURL() === request.rendererUrl,
        );
      if (matches.length !== 1) {
        throw new Error(
          `Expected one App Advisor renderer, found ${matches.length}`,
        );
      }
      matches[0].send(request.channel, request.payload);
    },
    { rendererUrl: advisor.url(), channel, payload },
  );
}

// Headless runs never show the advisor window on their own, so a visibility
// assertion needs an explicit show first (as the archive test above does).
function showAdvisorWindow(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const advisorWindow = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === 'Orchestrator',
    );
    if (!advisorWindow) throw new Error('App Advisor window not found');
    advisorWindow.show();
  });
}

function isAdvisorWindowVisible(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const advisorWindow = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === 'Orchestrator',
    );
    return advisorWindow?.isVisible() ?? false;
  });
}

/**
 * Vertical centres, in window points, of the App Advisor popout's live macOS
 * traffic lights and of every control in its header row. The lights are
 * native chrome outside the web contents, so they are read from main
 * (`getWindowButtonPosition()` is the top-left of the 14pt button frame) and
 * the controls' CSS rects are multiplied by the live zoom to compare.
 */
async function readAdvisorHeaderCenters(electronApp, advisor) {
  const lights = await electronApp.evaluate(({ BrowserWindow }) => {
    const advisorWindow = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === 'Orchestrator',
    );
    const position = advisorWindow?.getWindowButtonPosition?.();
    return position ? position.y + 14 / 2 : null;
  });
  const controls = await advisor.evaluate(() => {
    const zoom =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--ui-zoom',
        ),
      ) || 1;
    const centerOf = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return (rect.top + rect.height / 2) * zoom;
    };
    return {
      zoom,
      collapse: centerOf('[data-testid="app-advisor-nav-collapse"]'),
      settings: centerOf('[data-testid="app-advisor-nav-settings"]'),
      newEntry: centerOf('[data-testid="app-advisor-nav-new-entry"]'),
      topBar: centerOf('[data-testid="app-advisor-top-bar"]'),
    };
  });
  return { lights, ...controls };
}

async function dispatchMainAppAdvisorAction(electronApp, requestId, action) {
  await electronApp.evaluate(
    ({ BrowserWindow }, request) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() !== 'Orchestrator',
      );
      if (!mainWindow) throw new Error('Main window not found');
      mainWindow.webContents.send('app-advisor:tool-request', request);
    },
    {
      kind: 'dispatch_action',
      requestId,
      source: 'assistant',
      action,
    },
  );
}

async function getAdvisorUiState(electronApp) {
  const request = {
    kind: 'get_current_ui_state',
    requestId: `app-advisor-popout-ui-state-${Date.now()}`,
  };
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() !== 'Orchestrator',
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

/** Nav rows are shared `WorkEntryRow`s with ids `app-advisor-nav-entry-<id>`. */
function navEntryRows(advisor) {
  return advisor.locator(
    '[data-testid^="app-advisor-nav-entry-"][data-standalone-chat-id]',
  );
}

async function entryIdOtherThan(advisor, entryId) {
  const ids = await navEntryRows(advisor).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-standalone-chat-id')),
  );
  const others = ids.filter((id) => id !== entryId);
  expect(others).toHaveLength(1);
  return others[0];
}

// The row menu button only takes pointer events while its own row is hovered.
async function deleteNavEntry(advisor, entryId) {
  const row = advisor.getByTestId(`app-advisor-nav-entry-${entryId}`);
  await row.hover();
  await advisor.getByTestId(`app-advisor-nav-entry-${entryId}-menu`).click();
  await advisor.getByTestId(`app-advisor-nav-entry-${entryId}-delete`).click();
  // Still present until confirmed.
  await expect(row).toBeVisible();
  await advisor
    .getByTestId(`app-advisor-nav-entry-${entryId}-delete-dialog`)
    .getByTestId(`app-advisor-nav-entry-${entryId}-confirm-delete`)
    .click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
}

test.describe('app advisor popout project', () => {
  test('routes archive overview actions from the main bridge into the popout', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    seedArchiveFixture(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);

      await dispatchMainAppAdvisorAction(electronApp, 'open-overview', {
        type: 'archived.open_overview',
        workspaceId: 'app-advisor',
      });
      await expect(advisor.getByTestId('archived-overview-page')).toBeVisible({
        timeout: 15_000,
      });

      await dispatchMainAppAdvisorAction(electronApp, 'open-empty-trash', {
        type: 'archived.open_empty_trash',
        workspaceId: 'app-advisor',
      });
      await expect(
        advisor.getByTestId('archived-overview-empty-trash-dialog'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        advisor.getByTestId('archived-overview-empty-trash-list'),
      ).toContainText('Deleted entry');

      await advisor.getByTestId('archived-overview-empty-trash-cancel').click();
      await window.evaluate(() =>
        window.api.archivedContainers.delete({
          projectId: 'app-advisor',
          containerId: 'deleted-entry',
        }),
      );
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const containers = await window.api.archivedContainers.list({
              projectId: 'app-advisor',
            });
            return containers.length;
          }),
        )
        .toBe(0);

      const staleRequestId = 'stale-empty-trash-request';
      await window.evaluate((requestId) => {
        window.__appAdvisorArchiveRequestOutcome = new Promise((resolve) => {
          const unsubscribe = window.api.appAdvisor.onWindowUiStateChanged(
            (state) => {
              if (state.lastArchivedOverviewRequestId !== requestId) return;
              unsubscribe();
              resolve(state.lastArchivedOverviewConfirmationOpened);
            },
          );
        });
      }, staleRequestId);
      await sendAdvisorEvent(
        electronApp,
        advisor,
        'app-advisor:window-command',
        {
          type: 'open_archived_overview',
          openEmptyTrashConfirmation: true,
          requestId: staleRequestId,
        },
      );
      await expect(
        window.evaluate(() => window.__appAdvisorArchiveRequestOutcome),
      ).resolves.toBe(false);
      await expect(
        advisor.getByTestId('archived-overview-empty-trash-dialog'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('excludes stale archive state after the App Advisor popout is hidden', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    seedArchiveFixture(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);
      await electronApp.evaluate(({ BrowserWindow }) => {
        const advisorWindow = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === 'Orchestrator',
        );
        if (!advisorWindow) throw new Error('App Advisor window not found');
        advisorWindow.show();
      });

      await dispatchMainAppAdvisorAction(electronApp, 'open-hidden-overview', {
        type: 'archived.open_overview',
        workspaceId: 'app-advisor',
      });
      await dispatchMainAppAdvisorAction(electronApp, 'open-hidden-trash', {
        type: 'archived.open_empty_trash',
        workspaceId: 'app-advisor',
      });
      await expect(
        advisor.getByTestId('archived-overview-empty-trash-dialog'),
      ).toBeVisible({ timeout: 15_000 });

      await expect
        .poll(async () => {
          const response = await getAdvisorUiState(electronApp);
          return response.uiState?.snapshot.archivedContainers;
        })
        .toMatchObject({
          overviewOpen: true,
          workspaceId: 'app-advisor',
          emptyTrashConfirmationOpen: true,
        });

      await electronApp.evaluate(({ BrowserWindow }) => {
        const advisorWindow = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === 'Orchestrator',
        );
        if (!advisorWindow) throw new Error('App Advisor window not found');
        advisorWindow.close();
      });
      await expect
        .poll(() =>
          electronApp.evaluate(({ BrowserWindow }) => {
            const advisorWindow = BrowserWindow.getAllWindows().find(
              (candidate) => candidate.getTitle() === 'Orchestrator',
            );
            return advisorWindow?.isVisible() ?? false;
          }),
        )
        .toBe(false);

      const response = await getAdvisorUiState(electronApp);
      expect(response).toMatchObject({ ok: true });
      expect(response.uiState.snapshot.archivedContainers).toEqual({
        count: 0,
        viewerOpen: false,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('dismisses a visible ask-user question when main cancels it', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);
      const requestId = 'e2e-cancelled-question';

      await sendAdvisorEvent(electronApp, advisor, 'app-advisor:tool-request', {
        kind: 'ask_user_question',
        requestId,
        question: {
          header: 'Recovery check',
          question: 'Should this cancelled question remain visible?',
          options: ['No', 'Yes'],
        },
      });

      // The question asks in the chat's composer, as in other chats.
      const dock = advisor.getByTestId('chat-question-prompt');
      await expect(dock).toContainText(
        'Should this cancelled question remain visible?',
      );

      await sendAdvisorEvent(
        electronApp,
        advisor,
        'app-advisor:tool-request-cancelled',
        { requestId },
      );

      await expect(dock).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('asks an ask-user question in the composer and answers it on click', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);
      await expect(advisor.getByRole('textbox').first()).toBeVisible({
        timeout: 30_000,
      });

      await sendAdvisorEvent(electronApp, advisor, 'app-advisor:tool-request', {
        kind: 'ask_user_question',
        requestId: 'e2e-answered-question',
        question: {
          question: 'Which page should open?',
          options: ['Settings', 'Pipelines'],
        },
      });

      const composer = advisor.locator('[data-chat-composer-root]').first();
      const prompt = composer.getByTestId('chat-question-prompt');
      await expect(prompt).toContainText('Which page should open?');
      await expect(composer).toHaveAttribute('data-question-prompt', 'true');
      await expect(prompt.getByTestId('composer-prompt-pen')).toBeVisible();
      // A choice answers as soon as it is clicked.
      await prompt
        .getByRole('button', { name: 'Pipelines', exact: true })
        .click();
      await expect(prompt).toHaveCount(0);
      await expect(composer).toHaveAttribute('data-question-prompt', 'false');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('project surface boots with a lazily created entry, nav, and top bar', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const advisor = await app.openAppAdvisorWindow(electronApp);

      // The nav and top bar are mounted; a fresh profile lazily created its
      // first Work Entry, so exactly one entry row renders.
      await expect(advisor.getByTestId('app-advisor-nav')).toBeVisible();
      await expect(advisor.getByTestId('app-advisor-top-bar')).toBeVisible();
      await expect(navEntryRows(advisor)).toHaveCount(1, { timeout: 15_000 });

      // The panel grid materialized the entry's chat panel: a composer is
      // reachable in the main column.
      await expect(advisor.getByRole('textbox').first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('ControlOrMeta+W closes the active tab and hides App Advisor only when none is left (CAN-3952)', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    seedTwoTabEntryFixture(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);
      await showAdvisorWindow(electronApp);
      await expect.poll(() => isAdvisorWindowVisible(electronApp)).toBe(true);

      const firstTab = advisor.getByTestId('panel-tab-panel-chat-chat-a');
      const secondTab = advisor.getByTestId('panel-tab-panel-chat-chat-b');
      await expect(firstTab).toBeVisible({ timeout: 15_000 });
      await expect(secondTab).toBeVisible({ timeout: 15_000 });

      // Focus the grid through its tab chrome so the chord is the same on
      // every platform (no terminal owns Ctrl here).
      await secondTab.click();
      await advisor.keyboard.press('ControlOrMeta+w');

      await expect(secondTab).toHaveCount(0);
      await expect(firstTab).toBeVisible();
      await expect.poll(() => isAdvisorWindowVisible(electronApp)).toBe(true);
      expect(advisor.isClosed()).toBe(false);

      // Focus landed on the surviving chat, which is now the only chat: the
      // chord hides App Advisor rather than replacing (and archiving) it.
      await advisor.keyboard.press('ControlOrMeta+w');

      await expect.poll(() => isAdvisorWindowVisible(electronApp)).toBe(false);
      expect(advisor.isClosed()).toBe(false);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('header controls line up with the traffic lights at every interface scale', async () => {
    test.skip(process.platform !== 'darwin', 'macOS traffic lights only');
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);
      await expect(advisor.getByTestId('app-advisor-top-bar')).toBeVisible();

      // The whole header row zooms, so the lights follow its centre line
      // rather than the row padding itself around fixed native chrome.
      for (const scale of [100, 150, 200, 50]) {
        await window.evaluate(
          (value) => window.api.savePreferences({ uiScale: value }),
          scale,
        );
        await expect
          .poll(() =>
            advisor.evaluate(() =>
              getComputedStyle(document.documentElement)
                .getPropertyValue('--ui-zoom')
                .trim(),
            ),
          )
          .toBe(String(scale / 100));
        // Main moves the lights in the same step that sets the zoom, so
        // both have landed once the renderer reports the new zoom.
        const centers = await readAdvisorHeaderCenters(electronApp, advisor);
        for (const key of ['collapse', 'settings', 'newEntry', 'topBar']) {
          expect(
            Math.abs(centers[key] - centers.lights),
            `${key} at ${scale}%: ${JSON.stringify(centers)}`,
          ).toBeLessThanOrEqual(0.5);
        }
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('entries support rename, empty-entry reuse, and two-step deletion from the nav', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);
      await expect(navEntryRows(advisor)).toHaveCount(1, { timeout: 15_000 });

      const firstEntryId = (
        await navEntryRows(advisor).first().getAttribute('data-testid')
      ).replace('app-advisor-nav-entry-', '');

      // Rename the first entry through the row menu.
      await navEntryRows(advisor).first().hover();
      await advisor
        .getByTestId(`app-advisor-nav-entry-${firstEntryId}-menu`)
        .click();
      await advisor
        .getByTestId(`app-advisor-nav-entry-${firstEntryId}-rename`)
        .click();
      const renameInput = advisor.getByTestId(
        `app-advisor-nav-entry-${firstEntryId}-rename-input`,
      );
      await renameInput.fill('Renamed entry');
      await renameInput.press('Enter');
      await expect(
        advisor.getByTestId(`app-advisor-nav-entry-${firstEntryId}`),
      ).toContainText('Renamed entry', { timeout: 15_000 });

      // A renamed entry counts as customized even without messages, so `+`
      // keeps it and adds a fresh entry beside it.
      await advisor.getByTestId('app-advisor-nav-new-entry').click();
      await expect(navEntryRows(advisor)).toHaveCount(2, { timeout: 15_000 });
      await expect(
        advisor.getByTestId(`app-advisor-nav-entry-${firstEntryId}`),
      ).toContainText('Renamed entry');
      const freshEntryId = await entryIdOtherThan(advisor, firstEntryId);

      // `+` while the fresh entry is still untouched REUSES it instead of
      // piling up duplicates. The list stays at two rows.
      await advisor.getByTestId('app-advisor-nav-new-entry').click();
      await expect(navEntryRows(advisor)).toHaveCount(2, { timeout: 15_000 });
      expect(await entryIdOtherThan(advisor, firstEntryId)).toBe(freshEntryId);

      // Confirmed deletion: the menu's Delete opens the same confirm the
      // Chats section uses; only the confirm moves it to Deleted.
      await deleteNavEntry(advisor, firstEntryId);
      await expect(navEntryRows(advisor)).toHaveCount(1, { timeout: 15_000 });

      // Deleting the last entry auto-creates a fresh one (the workspace always
      // has an active entry), so the count stays at one with a DIFFERENT id.
      await deleteNavEntry(advisor, freshEntryId);
      await expect(navEntryRows(advisor)).toHaveCount(1, { timeout: 15_000 });
      const replacementEntryId = (
        await navEntryRows(advisor).first().getAttribute('data-testid')
      ).replace('app-advisor-nav-entry-', '');
      expect(replacementEntryId).not.toBe(firstEntryId);
      expect(replacementEntryId).not.toBe(freshEntryId);

      // The replacement entry's panel grid is live (composer reachable).
      await expect(advisor.getByRole('textbox').first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('nav collapse persists through appAdvisorNavCollapsed across relaunch', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);

    const firstLaunch = await launchCanopy({ userDataDir });
    try {
      const window = await firstLaunch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(firstLaunch.electronApp);

      const nav = advisor.getByTestId('app-advisor-nav');
      await expect(nav).toHaveAttribute('data-collapsed', 'false');

      // Collapse: width-only — the main column (top bar) stays mounted.
      await advisor.getByTestId('app-advisor-nav-collapse').click();
      await expect(nav).toHaveAttribute('data-collapsed', 'true');
      await expect(advisor.getByTestId('app-advisor-top-bar')).toBeVisible();

      // The preference write is fire-and-forget; poll the file.
      await expect
        .poll(() => readPreferences(userDataDir).appAdvisorNavCollapsed, {
          timeout: 10_000,
        })
        .toBe(true);
    } finally {
      await closeCanopy(firstLaunch.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    const secondLaunch = await launchCanopy({ userDataDir });
    try {
      const window = await secondLaunch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(secondLaunch.electronApp);
      await expect(advisor.getByTestId('app-advisor-nav')).toHaveAttribute(
        'data-collapsed',
        'true',
      );
      // Expanding restores the entry list.
      await advisor.getByTestId('app-advisor-nav-collapse').click();
      await expect(advisor.getByTestId('app-advisor-nav')).toHaveAttribute(
        'data-collapsed',
        'false',
      );
    } finally {
      await closeCanopy(secondLaunch.electronApp, userDataDir);
    }
  });

  test('fresh window width matches the main default and manual resizing persists', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    const resizedSize = { width: 900, height: 650 };
    let resizedBounds;

    const firstLaunch = await launchCanopy({ userDataDir });
    try {
      const window = await firstLaunch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openAppAdvisorWindow(firstLaunch.electronApp);

      const initial = await firstLaunch.electronApp.evaluate(
        ({ BrowserWindow, screen }) => {
          const advisorWindow = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.getTitle() === 'Orchestrator',
          );
          if (!advisorWindow) throw new Error('App Advisor window not found');
          return {
            width: advisorWindow.getBounds().width,
            expectedWidth: Math.max(
              360,
              Math.min(1400, screen.getPrimaryDisplay().workArea.width),
            ),
          };
        },
      );
      expect(initial.width).toBe(initial.expectedWidth);

      const positionedBounds = await firstLaunch.electronApp.evaluate(
        ({ BrowserWindow, screen }) => {
          const advisorWindow = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.getTitle() === 'Orchestrator',
          );
          if (!advisorWindow) throw new Error('App Advisor window not found');
          const workArea = screen.getPrimaryDisplay().workArea;
          const bounds = advisorWindow.getBounds();
          advisorWindow.setPosition(
            workArea.x +
              Math.max(0, Math.floor((workArea.width - bounds.width) / 2)),
            workArea.y +
              Math.max(0, Math.floor((workArea.height - bounds.height) / 2)),
          );
          return advisorWindow.getBounds();
        },
      );

      await expect
        .poll(() => readPreferences(userDataDir).appAdvisorDialogBounds, {
          timeout: 10_000,
        })
        .toEqual(positionedBounds);

      resizedBounds = await firstLaunch.electronApp.evaluate(
        ({ BrowserWindow }, size) => {
          const advisorWindow = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.getTitle() === 'Orchestrator',
          );
          if (!advisorWindow) throw new Error('App Advisor window not found');
          advisorWindow.setSize(size.width, size.height);
          return advisorWindow.getBounds();
        },
        resizedSize,
      );

      await expect
        .poll(() => readPreferences(userDataDir).appAdvisorDialogBounds, {
          timeout: 10_000,
        })
        .toMatchObject(resizedBounds);
    } finally {
      await closeCanopy(firstLaunch.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    const secondLaunch = await launchCanopy({ userDataDir });
    try {
      const window = await secondLaunch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openAppAdvisorWindow(secondLaunch.electronApp);

      const restoredBounds = await secondLaunch.electronApp.evaluate(
        ({ BrowserWindow }) => {
          const advisorWindow = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.getTitle() === 'Orchestrator',
          );
          if (!advisorWindow) throw new Error('App Advisor window not found');
          return advisorWindow.getBounds();
        },
      );
      expect(restoredBounds).toEqual(resizedBounds);
    } finally {
      await closeCanopy(secondLaunch.electronApp, userDataDir);
    }
  });

  test('settings modal saves CLAUDE.md through the App Advisor settings tabs', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);

      await advisor.getByTestId('app-advisor-nav-settings').click();
      const modal = advisor.getByTestId('app-advisor-settings-modal');
      await expect(modal).toBeVisible();

      // Defaults tab renders the model row + plugin picker.
      await expect(
        advisor.getByTestId('app-advisor-settings-tab-defaults'),
      ).toBeVisible();

      // Instructions: edit CLAUDE.md and save.
      await advisor
        .getByTestId('app-advisor-settings-tab-instructions')
        .click();
      const editor = advisor.getByTestId('app-advisor-settings-claude-md');
      await expect(editor).toBeEnabled({ timeout: 15_000 });
      await editor.fill('# Popout instructions\n\nBe concise.');
      await advisor.getByTestId('app-advisor-settings-save').click();
      // Save button disappears once the dirty state clears.
      await expect(
        advisor.getByTestId('app-advisor-settings-save'),
      ).toHaveCount(0, { timeout: 15_000 });

      // Advanced: deletion retention is always on — only the day count is
      // editable, there is no enable/disable control.
      await advisor.getByTestId('app-advisor-settings-tab-advanced').click();
      await expect(
        advisor.getByTestId('app-advisor-settings-retention'),
      ).toContainText('Deletion retention');
      await expect(
        advisor.getByTestId('app-advisor-settings-retention-days'),
      ).toBeVisible();
      await expect(
        advisor.getByTestId('app-advisor-settings-retention-toggle'),
      ).toHaveCount(0);
      await expect(
        advisor
          .getByTestId('app-advisor-settings-retention-card')
          .getByTestId('app-advisor-settings-auto-archive-toggle'),
      ).toBeVisible();
      await advisor
        .getByTestId('app-advisor-settings-auto-archive-toggle')
        .check();
      const autoArchiveDays = advisor.getByTestId(
        'app-advisor-settings-auto-archive-days',
      );
      await autoArchiveDays.fill('');
      await expect(autoArchiveDays).toHaveValue('7');
      await autoArchiveDays.fill('9');
      await advisor.getByTestId('app-advisor-settings-save').click();
      await expect(
        advisor.getByTestId('app-advisor-settings-save'),
      ).toHaveCount(0, { timeout: 15_000 });

      // Close and reopen — the saved CLAUDE.md round-trips.
      await advisor.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);
      await advisor.getByTestId('app-advisor-nav-settings').click();
      await advisor
        .getByTestId('app-advisor-settings-tab-instructions')
        .click();
      await expect(
        advisor.getByTestId('app-advisor-settings-claude-md'),
      ).toHaveValue(/Popout instructions/, { timeout: 15_000 });
      await advisor.getByTestId('app-advisor-settings-tab-advanced').click();
      await expect(
        advisor.getByTestId('app-advisor-settings-auto-archive-toggle'),
      ).toBeChecked();
      await expect(
        advisor.getByTestId('app-advisor-settings-auto-archive-days'),
      ).toHaveValue('9');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('archives and restores an entry chat and opens the legacy global archive', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    seedArchiveFixture(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);

      // Closing a non-empty chat archives it in its Work Entry and replaces
      // the live last tab with a fresh chat.
      const browserFixture = await seedBrowserProfileState(
        electronApp,
        advisor,
        {
          projectId: 'app-advisor',
          worktreeId: 'entry-archive',
        },
      );
      // Hover-revealed close control; see closePanelTab for the CI hit-test
      // race this guards against (CI runs 32456587191 attempts 1+3).
      await closePanelTab(advisor, 'panel-chat-scoped-chat');
      await expect(advisor.getByTestId('chat-tab-archive')).toBeVisible({
        timeout: 15_000,
      });
      expect(
        await readBrowserProfileState(electronApp, browserFixture),
      ).toEqual({ live: true, retained: true });

      // The scoped archive modal exposes the archived transcript and restores
      // it back into the same entry.
      await advisor.getByTestId('chat-tab-archive').click();
      await expect(advisor.getByTestId('archived-chats-modal')).toBeVisible();
      await expect(
        advisor.getByTestId('archived-chats-modal-row'),
      ).toContainText('Scoped archive chat');
      await advisor.getByTestId('archived-chat-restore').click();
      await expect(
        advisor.getByTestId('panel-tab-close-panel-chat-scoped-chat'),
      ).toBeVisible({ timeout: 15_000 });

      // The permanent pre-entry/global archive is listed on the "Archived and
      // deleted" overview (legacy section) and opens in the shared legacy
      // archive overlay.
      await advisor.getByTestId('app-advisor-nav-archived-link').click();
      await expect(advisor.getByTestId('archived-overview-page')).toBeVisible({
        timeout: 15_000,
      });
      await advisor
        .getByTestId('archived-overview-legacy-row-legacy-chat')
        .click();
      await expect(advisor.getByTestId('cowork-archive-overlay')).toBeVisible({
        timeout: 15_000,
      });
      await expect(advisor.getByTestId('cowork-archive-overlay')).toContainText(
        'Legacy archive chat',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
