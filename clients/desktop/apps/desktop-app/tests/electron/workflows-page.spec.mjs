// CAN-3981: the Workflows sidebar entry hosts Runs, Schedule and Library.
// Each tab keeps its own navigation page id (`workflows`,
// `workflows-schedule`, `workflows-library`), so Back/Forward, keyboard
// shortcuts and App Advisor `navigation.go_to_page` all land on a tab. The
// ids from before (`automations`, `pipelines`, `watchers`) and the legacy
// `canopy:automations-open-tab` event open the tab they became.
//
// Deterministic and offline: seeded pipelines, automations and watchers, the
// shared mock server for the one App Advisor turn, no live agents.

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  openWorkflowEditSection,
  workflowEditMenuItem,
  workflowEditTarget,
} from './canopyApp.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedAutomations,
  seedWatchers,
} from './seeders/index.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

const PIPELINE_ID = 'workflows-review';
const BUNDLED_PIPELINE_ID = 'bundled-code-review-multi-provider';
const BUNDLED_PIPELINE_NAME = 'Code Review (Multi-Provider)';
const ACTIVITY_ID = 'workflows-standup';
const WATCHER_ID = 'workflows-chat-watcher';
const RUNS = 'workflows';
const SCHEDULE = 'workflows-schedule';
const LIBRARY = 'workflows-library';
const TAB_IDS = [RUNS, SCHEDULE, LIBRARY];
const TAB_PANELS = {
  [RUNS]: 'page-workflows-runs',
  [SCHEDULE]: 'page-workflows-schedule',
  [LIBRARY]: 'page-workflows-library',
};
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const PIPELINE_AUTOMATION_ID = 'workflows-nightly-review';
const PIPELINE_AUTOMATION_NAME = 'Nightly workflows review';

/** An automation that runs the seeded pipeline, for its Trigger section. */
function pipelineAutomation() {
  return {
    version: 1,
    id: PIPELINE_AUTOMATION_ID,
    name: PIPELINE_AUTOMATION_NAME,
    // Disabled so nothing is scheduled while the spec runs.
    enabled: false,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      workspaceId: 'seeded-workspace',
      pipelineId: PIPELINE_ID,
      pipelineName: 'Workflows review',
      pipelineSource: 'user',
    },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    failureCount: 0,
  };
}

function seedWorkflows({ withPipelineAutomation = false } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-workflows-page-'),
  );
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: 'Workflows review',
    yaml: [
      'name: Workflows review',
      'on: dispatch',
      'scope: directory',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo review',
      '',
    ].join('\n'),
  });
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: ACTIVITY_ID,
        name: 'Workflows standup',
        // Disabled so nothing is scheduled while the spec runs.
        enabled: false,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: { type: 'app_advisor_prompt', prompt: 'Summarize the day.' },
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        failureCount: 0,
      },
      ...(withPipelineAutomation ? [pipelineAutomation()] : []),
    ],
  });
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: WATCHER_ID,
        label: 'Workflows chat watcher',
        trigger: 'worktree_chat_completion',
        target: {
          kind: 'worktree_chat',
          projectId: 'seeded-workspace',
          worktreeId: 'seeded-worktree',
          chatId: 'seeded-chat',
          chatTitle: 'Seeded chat',
        },
        destination: {
          projectId: 'seeded-workspace',
          worktreeId: 'seeded-worktree',
          chatId: 'seeded-chat',
          chatTitle: 'Seeded chat',
        },
      },
    ],
  });
  return userDataDir;
}

const WORKFLOWS_SUBTITLE =
  'Chain prompts and scripts, and run them by hand, on a schedule, or when something happens.';

/** Asserts the header's one subtitle reads exactly the approved copy. */
async function expectWorkflowsSubtitle(window) {
  const subtitle = window
    .getByTestId('page-workflows')
    .getByTestId('page-header')
    .getByTestId('page-header-description');
  await expect(subtitle).toHaveCount(1);
  await expect(subtitle).toBeVisible();
  // Raw text, so a whitespace or punctuation change still fails.
  await expect
    .poll(() => subtitle.evaluate((node) => node.textContent))
    .toBe(WORKFLOWS_SUBTITLE);
}

/** Asserts the open Workflows tab, its panel, and the selected sidebar row. */
async function expectWorkflowsTab(window, tab) {
  await expect(window.getByTestId('page-workflows')).toBeVisible();
  for (const id of TAB_IDS) {
    await expect(window.getByTestId(`workflows-tab-${id}`)).toHaveAttribute(
      'aria-selected',
      id === tab ? 'true' : 'false',
    );
  }
  await expect(window.getByTestId(TAB_PANELS[tab])).toBeVisible();
  // One Workflows row stays selected on every tab (`SidebarNavRow`).
  await expect(window.getByTestId('sidebar-nav-workflows')).toHaveClass(
    /\bbg-muted\b/,
  );
}

async function pressGlobalShortcut(window, key) {
  // Global page shortcuts ignore keystrokes aimed at a focused control.
  await window.waitForFunction(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    return true;
  });
  await window.keyboard.press(`${MOD}+${key}`);
}

/** The app history Back chord (⌘← on macOS, Alt+← elsewhere). */
async function pressHistoryBack(window) {
  // The chord keeps its text-editing meaning in a focused field.
  await window.waitForFunction(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    return true;
  });
  await window.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Alt+ArrowLeft',
  );
}

/**
 * Sends one App Advisor tool request straight to the main renderer's runtime
 * bridge, the way the main process does after it validates the action.
 */
async function requestAdvisorTool(electronApp, request) {
  return electronApp.evaluate(async ({ BrowserWindow, ipcMain }, request) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (window) => !window.webContents.getURL().includes('surface=app-advisor'),
    );
    if (!mainWindow) throw new Error('Main window missing');
    ipcMain.removeHandler('app-advisor:tool-response');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Advisor response timed out')),
        5000,
      );
      ipcMain.handle('app-advisor:tool-response', (_event, response) => {
        if (response?.requestId !== request.requestId) return;
        clearTimeout(timeout);
        resolve(response);
      });
      mainWindow.webContents.send('app-advisor:tool-request', request);
    });
  }, request);
}

async function goToPage(electronApp, requestId, action) {
  const response = await requestAdvisorTool(electronApp, {
    kind: 'dispatch_action',
    requestId,
    originWorktreeId: 'e2e-advisor',
    action: { type: 'navigation.go_to_page', ...action },
  });
  expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
}

test.describe('Workflows page', () => {
  test('the sidebar row, tabs, arrow keys, shortcuts and history all land on Workflows tabs', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      // One row stands for the whole page.
      const row = window.getByTestId('sidebar-nav-workflows');
      await expect(row).toHaveText('Workflows');
      await expect(window.getByTestId('sidebar-nav-automations')).toHaveCount(
        0,
      );
      await expect(window.getByTestId('sidebar-nav-pipelines')).toHaveCount(0);
      await expect(row).not.toHaveClass(/\bbg-muted\b/);

      // The row always opens Runs, under one "Workflows" heading.
      await row.click();
      await expectWorkflowsTab(window, RUNS);
      await expect(
        window
          .getByTestId('page-workflows')
          .getByRole('heading', { name: 'Workflows', exact: true }),
      ).toBeVisible();
      await expectWorkflowsSubtitle(window);
      const tablist = window.getByTestId('workflows-tabs');
      await expect(tablist).toHaveAttribute('role', 'tablist');
      // A tab's count follows its label, so match the label's start.
      await expect(tablist.getByRole('tab')).toHaveText([
        /^Runs/,
        /^Schedule/,
        /^Library/,
      ]);
      // The seeded watcher is watching, so it is a Runs row and counts as
      // active beside the tab's label.
      await expect(app.workflowsWatcherRunRow(WATCHER_ID)).toBeVisible();
      await expect(
        window.getByTestId('workflows-tab-count-workflows'),
      ).toHaveText('1');
      // With runs listed, the header offers New workflow alone (CAN-4318).
      const heading = window.getByTestId('page-header');
      await expect(heading.getByTestId('workflows-new-manual')).toHaveText(
        'New workflow',
      );
      await expect(heading.getByTestId('workflows-new-manual')).toHaveCount(1);
      await expect(heading.getByTestId('workflows-run-workflow')).toHaveCount(
        0,
      );

      // Clicking each tab opens its panel; the row stays selected.
      await window.getByTestId(`workflows-tab-${SCHEDULE}`).click();
      await expectWorkflowsTab(window, SCHEDULE);
      await expectWorkflowsSubtitle(window);
      await expect(window.getByTestId('automations-calendar')).toBeVisible();
      await window.getByTestId(`workflows-tab-${LIBRARY}`).click();
      await expectWorkflowsTab(window, LIBRARY);
      await expectWorkflowsSubtitle(window);
      // A pipeline and an automation are rows of the same table.
      await expect(app.workflowsLibraryPipelineRow(PIPELINE_ID)).toBeVisible();
      await expect(
        app.workflowsLibraryAutomationRow(ACTIVITY_ID),
      ).toBeVisible();

      // Back and Forward walk the tabs, since each one is its own page.
      const back = window.getByTestId('nav-history-back');
      const forward = window.getByTestId('nav-history-forward');
      await back.click();
      await expectWorkflowsTab(window, SCHEDULE);
      await back.click();
      await expectWorkflowsTab(window, RUNS);
      await forward.click();
      await expectWorkflowsTab(window, SCHEDULE);
      await forward.click();
      await expectWorkflowsTab(window, LIBRARY);
      await expect(forward).toBeDisabled();

      // Only the selected tab is in the Tab order; the arrow keys, Home and
      // End move between tabs and select the one they land on, and focus
      // stays on the selected tab.
      const libraryTab = window.getByTestId(`workflows-tab-${LIBRARY}`);
      const runsTab = window.getByTestId(`workflows-tab-${RUNS}`);
      await expect(libraryTab).toHaveAttribute('tabindex', '0');
      await expect(runsTab).toHaveAttribute('tabindex', '-1');
      await libraryTab.focus();
      await window.keyboard.press('ArrowRight');
      await expectWorkflowsTab(window, RUNS);
      await expect(runsTab).toBeFocused();
      await window.keyboard.press('ArrowLeft');
      await expectWorkflowsTab(window, LIBRARY);
      await expect(libraryTab).toBeFocused();
      await window.keyboard.press('Home');
      await expectWorkflowsTab(window, RUNS);
      await expect(runsTab).toBeFocused();
      await window.keyboard.press('End');
      await expectWorkflowsTab(window, LIBRARY);
      await expect(libraryTab).toBeFocused();
      await window.keyboard.press('Home');
      await window.keyboard.press('ArrowRight');
      await expectWorkflowsTab(window, SCHEDULE);
      await expect(
        window.getByTestId(`workflows-tab-${SCHEDULE}`),
      ).toBeFocused();

      // ⌘4 opens Workflows › Library and ⌘8 Workflows › Runs, from anywhere.
      await app.openPluginsPage();
      await expect(row).not.toHaveClass(/\bbg-muted\b/);
      await pressGlobalShortcut(window, '4');
      await expectWorkflowsTab(window, LIBRARY);
      await app.openPluginsPage();
      await pressGlobalShortcut(window, '8');
      await expectWorkflowsTab(window, RUNS);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a pipeline and an automation open in the edit shell in place of the Workflows chrome, and a watcher is cancelled from Runs', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      // Opening a pipeline row shows the edit shell (CAN-4072) in place of
      // the Workflows heading and tabs: Back, the name, the save state and
      // the actions, then its own Definition / Trigger / Runs tabs.
      await app.openWorkflowsTab(LIBRARY);
      await app
        .workflowsLibraryPipelineRow(PIPELINE_ID)
        .getByTestId('workflows-library-name')
        .click();
      const shell = window.getByTestId('workflow-edit-shell');
      await expect(shell).toBeVisible();
      await expect(shell).toHaveAttribute('data-kind', 'pipeline');
      await expect(shell).toHaveAttribute('data-readonly', 'false');
      await expect(shell).toHaveAttribute('data-dirty', 'false');
      await expect(window.getByTestId('workflows-tabs')).toHaveCount(0);
      await expect(
        window.getByRole('heading', { name: 'Workflows', exact: true }),
      ).toHaveCount(0);
      await expect(window.getByTestId('sidebar-nav-workflows')).toHaveClass(
        /\bbg-muted\b/,
      );
      const back = shell.getByTestId('pipeline-editor-back');
      await expect(back).toHaveText('Library');
      await expect(shell.getByTestId('workflow-edit-name')).toContainText(
        'Workflows review',
      );
      await expect(shell.getByTestId('workflow-edit-tabs')).toBeVisible();
      await expect(
        shell.getByTestId('workflow-edit-tabs').getByRole('tab'),
      ).toHaveText(['Definition', 'Trigger', 'Runs']);
      await expect(
        shell.getByTestId('workflow-edit-tab-definition'),
      ).toHaveAttribute('aria-selected', 'true');
      // The user's own pipeline: Save waits for an edit; Run and Share are
      // buttons; the ⋯ menu leads the bar with Turn off and Delete, and
      // offers no Duplicate.
      const actions = shell.getByTestId('workflow-edit-actions');
      await expect(actions.getByTestId('pipeline-save')).toBeDisabled();
      await expect(actions.getByTestId('pipeline-share')).toBeVisible();
      await expect(actions.locator('[data-testid]').first()).toHaveAttribute(
        'data-testid',
        'workflow-edit-more',
      );
      await expect(
        shell.getByTestId('workflow-edit-enabled-state'),
      ).toHaveCount(0);
      const menu = window.getByTestId('workflow-edit-menu');
      await expect(
        await workflowEditMenuItem(window, 'pipeline-editor-enabled'),
      ).toHaveText('Turn off');
      await expect(menu.getByRole('menuitem')).toHaveText([
        'Turn off',
        'Delete',
      ]);
      await expect(menu.getByTestId('pipeline-editor-duplicate')).toHaveCount(
        0,
      );
      await window.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      // Definition holds the editor under its own toolbar.
      const definition = shell.getByTestId('workflow-edit-section-definition');
      await expect(
        definition.getByTestId('pipeline-definition-toolbar'),
      ).toBeVisible();
      await expect(definition.getByTestId('pipeline-mode-raw')).toBeVisible();
      // No automation runs this pipeline, and it has never run.
      const trigger = await openWorkflowEditSection(window, 'trigger');
      await expect(
        trigger.getByTestId('pipeline-trigger-automations-empty'),
      ).toHaveText('No automations run this workflow.');
      await expect(definition).toBeHidden();
      const runs = await openWorkflowEditSection(window, 'runs');
      await expect(runs.getByTestId('pipeline-runs-section')).toBeVisible();
      await expect(runs.getByTestId('workflow-edit-no-runs')).toBeVisible();
      // Back with nothing edited leaves at once, for the Library.
      await backFromWorkflowEdit(window);
      await expectWorkflowsTab(window, LIBRARY);
      await expect(shell).toHaveCount(0);
      await expect(app.workflowsLibraryPipelineRow(PIPELINE_ID)).toBeVisible();

      // A pipeline started from another tab opens in the Library, where the
      // editor's assistant shortcuts apply, so Back returns there.
      await window.getByTestId(`workflows-tab-${SCHEDULE}`).click();
      await expectWorkflowsTab(window, SCHEDULE);
      await window.getByTestId('workflows-new').click();
      await window.getByTestId('workflows-new-build').click();
      await expect(shell).toHaveAttribute('data-kind', 'pipeline');
      await expect(shell.getByTestId('workflow-edit-save-state')).toHaveText(
        'New',
      );
      await backFromWorkflowEdit(window);
      await expectWorkflowsTab(window, LIBRARY);

      // Opening an automation row opens the same shell on that automation.
      await app
        .workflowsLibraryAutomationRow(ACTIVITY_ID)
        .getByTestId('workflows-library-name')
        .click();
      await expect(shell).toHaveAttribute('data-kind', 'automation');
      await expect(
        shell
          .getByTestId('workflow-edit-section-definition')
          .getByTestId('automations-form-name'),
      ).toHaveValue('Workflows standup');
      await expect(shell.getByTestId('workflow-edit-back')).toHaveText(
        'Library',
      );
      await backFromWorkflowEdit(window);
      await expect(shell).toHaveCount(0);
      await expectWorkflowsTab(window, LIBRARY);

      // Search narrows the one table to matching rows of either kind. The
      // field is the 32px page search filling its row: it counts the
      // matches while there is a query, and Escape clears it before it
      // leaves the field. The Filter and Sort dropdowns follow it.
      const librarySearch = window.getByTestId('workflows-library-search');
      const librarySearchField = window.getByTestId(
        'workflows-library-search-field',
      );
      await expect(librarySearchField).toHaveAttribute(
        'data-search-field',
        'md',
      );
      const libraryRow = await window
        .getByTestId('workflows-library-toolbar')
        .boundingBox();
      const libraryField = await librarySearchField.boundingBox();
      const librarySort = await window
        .getByTestId('workflows-library-sort')
        .boundingBox();
      expect(libraryField?.height).toBe(32);
      expect(librarySort?.height).toBe(28);
      // The field grows to fill the row; the sort ends it, its 8px end
      // inset hanging past the content edge so its chevron's ink meets it.
      expect(
        Math.round((librarySort?.x ?? 0) + (librarySort?.width ?? 0)),
      ).toBe(Math.round((libraryRow?.x ?? 0) + (libraryRow?.width ?? 0)) + 8);
      expect(libraryField?.width ?? 0).toBeGreaterThan(
        (libraryRow?.width ?? 0) / 2,
      );
      await expect(
        librarySearchField.locator('[data-search-field-count]'),
      ).toHaveCount(0);
      await librarySearch.fill('standup');
      await expect(
        app.workflowsLibraryAutomationRow(ACTIVITY_ID),
      ).toBeVisible();
      await expect(app.workflowsLibraryPipelineRow(PIPELINE_ID)).toHaveCount(0);
      await expect(
        librarySearchField.locator('[data-search-field-count]'),
      ).toHaveText(/^1 of \d+$/);
      await librarySearch.press('Escape');
      await expect(librarySearch).toHaveValue('');
      await expect(librarySearch).toBeFocused();
      await librarySearch.press('Escape');
      await expect(librarySearch).not.toBeFocused();
      await librarySearch.fill('standup');
      await window.getByTestId('workflows-library-search-clear').click();
      await expect(librarySearch).toHaveValue('');
      await expect(librarySearch).toBeFocused();
      // Four filters sit behind one Filter dropdown after the field, which
      // counts the filters on.
      const filterButton = window.getByTestId('workflows-library-filter');
      await expect(filterButton).not.toHaveAttribute('data-active', 'true');
      await expect(filterButton).toHaveText('Filter');
      await app.chooseWorkflowsLibraryFilter('source', 'mine');
      await expect(filterButton).toHaveAttribute('data-active', 'true');
      await expect(filterButton).toHaveText('Filter · 1');
      await app.chooseWorkflowsLibraryFilter('source', 'any');
      await expect(filterButton).not.toHaveAttribute('data-active', 'true');
      // A search with no matches offers one action that clears it: New
      // workflow stays in the page header.
      await librarySearch.fill('no such row');
      const noMatches = window.getByTestId('workflows-library-no-matches');
      await expect(noMatches).toBeVisible();
      await expect(noMatches.getByTestId('workflows-new')).toHaveCount(0);
      await expect(window.getByTestId('workflows-new')).toHaveCount(1);
      const clearSearch = noMatches.getByTestId(
        'workflows-library-empty-clear',
      );
      await expect(clearSearch).toHaveText('Clear search');
      await clearSearch.click();
      await expect(librarySearch).toHaveValue('');
      await expect(app.workflowsLibraryPipelineRow(PIPELINE_ID)).toBeVisible();

      // A watcher is cancelled from its Runs row, after a confirmation.
      await window.getByTestId(`workflows-tab-${RUNS}`).click();
      await expectWorkflowsTab(window, RUNS);
      const watcherRow = app.workflowsWatcherRunRow(WATCHER_ID);
      await expect(watcherRow).toContainText('Workflows chat watcher');
      await expect(watcherRow).toHaveAttribute('data-run-kind', 'watcher');
      // CAN-4651: the Kind column names each kind by how it starts.
      await expect(
        window.getByRole('columnheader', { name: 'Kind', exact: true }),
      ).toBeVisible();
      await expect(
        watcherRow.getByRole('cell', { name: 'Watcher', exact: true }),
      ).toBeVisible();
      await watcherRow.getByTestId('workflows-run-action-cancel').click();
      const confirm = window.getByTestId('workflows-runs-cancel-watcher');
      await expect(confirm).toBeVisible();
      await window.getByTestId('confirm-dialog-confirm').click();
      // A cancelled watcher leaves the feed.
      await expect(watcherRow).toHaveCount(0);
      // No runs, and a Library with something to run: the empty state
      // previews the Library with your own workflow first (CAN-4311), leads
      // with See your library, keeps Run a workflow, and the header still
      // offers New workflow.
      const empty = window.getByTestId('workflows-runs-empty');
      await expect(empty).toBeVisible();
      const preview = empty.getByTestId('workflows-runs-library-preview-row');
      await expect(preview).toHaveCount(3);
      await expect(preview.first()).toHaveAttribute(
        'data-row-key',
        `pipeline:user:${PIPELINE_ID}`,
      );
      await expect(
        empty.getByTestId('workflows-runs-empty-library'),
      ).toHaveText('See your library');
      await expect(empty.getByTestId('workflows-runs-empty-run')).toHaveText(
        'Run a workflow',
      );
      const heading = window.getByTestId('page-header');
      await expect(heading.getByTestId('workflows-new-manual')).toHaveText(
        'New workflow',
      );
      await expect(heading.getByTestId('workflows-new-manual')).toHaveCount(1);
      await expect(heading.getByTestId('workflows-run-workflow')).toHaveCount(
        0,
      );
      await expect(window.getByTestId('workflows-runs-footnote')).toHaveCount(
        0,
      );
      await expectWorkflowsTab(window, RUNS);
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('New workflow on Runs opens a new pipeline in the Library without a selected worktree', async () => {
    test.setTimeout(120_000);
    // Nothing seeded: no runs and no worktree to select. The bundled
    // pipelines still fill the Library, so first use has something to run.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-workflows-first-use-'),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      await window.getByTestId('sidebar-nav-workflows').click();
      await expectWorkflowsTab(window, RUNS);
      const empty = window.getByTestId('workflows-runs-empty');
      await expect(empty).toBeVisible();
      // The header offers creation with no runs; the empty state previews
      // the bundled workflows and offers Run a workflow behind the Library.
      const heading = window.getByTestId('page-header');
      const newWorkflow = heading.getByTestId('workflows-new-manual');
      await expect(newWorkflow).toHaveText('New workflow');
      await expect(heading.getByTestId('workflows-run-workflow')).toHaveCount(
        0,
      );
      await expect(heading.getByTestId('workflows-new')).toHaveCount(0);
      await expect(empty.getByTestId('workflows-runs-empty-run')).toHaveText(
        'Run a workflow',
      );
      await expect(
        empty.getByTestId('workflows-runs-library-preview-row'),
      ).toHaveCount(3);
      // The bundled workflows always fill the Library, so Customize is
      // offered beside Run a workflow rather than only with nothing to run.
      await expect(
        empty.getByTestId('workflows-runs-empty-marketplace'),
      ).toHaveText('Browse Customize');

      // It opens the manual pipeline editor directly: no creation menu, no
      // dispatch dialog, and no missing-worktree error.
      await newWorkflow.click();
      const shell = window.getByTestId('workflow-edit-shell');
      await expect(shell).toHaveAttribute('data-kind', 'pipeline');
      await expect(shell.getByTestId('workflow-edit-save-state')).toHaveText(
        'New',
      );
      expect(await workflowEditTarget(window)).toMatchObject({
        kind: 'pipeline',
        pipelineId: null,
      });
      await expect(window.getByTestId('workflows-new-build')).toHaveCount(0);
      await expect(window.getByTestId('pipeline-trigger-modal')).toHaveCount(0);
      await expect(
        window.getByText(
          'Open a worktree or chat first, then run a workflow in it.',
        ),
      ).toHaveCount(0);
      // The draft belongs to the Library, so Back returns there.
      await expect(shell.getByTestId('pipeline-editor-back')).toHaveText(
        'Library',
      );
      await backFromWorkflowEdit(window);
      await expectWorkflowsTab(window, LIBRARY);
      await expect(shell).toHaveCount(0);
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Runs with no runs previews the Library and opens it (CAN-4311)', async () => {
    test.setTimeout(120_000);
    // A fresh install: no runs, and the bundled pipelines fill the Library.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-workflows-runs-preview-'),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.getByTestId('sidebar-nav-workflows').click();
      await expectWorkflowsTab(window, RUNS);

      const empty = window.getByTestId('workflows-runs-empty');
      const preview = empty.getByTestId('workflows-runs-library-preview-row');
      await expect(preview).toHaveCount(3);
      for (const row of await preview.all()) {
        await expect(row).toContainText('Built-in');
      }
      // A previewed workflow opens marked in the full Library.
      await empty
        .locator(
          `[data-testid="workflows-runs-library-preview-row"][data-row-key="pipeline:bundled:${BUNDLED_PIPELINE_ID}"]`,
        )
        .click();
      await expectWorkflowsTab(window, LIBRARY);
      await expect(
        app.workflowsLibraryPipelineRow(BUNDLED_PIPELINE_ID, 'bundled'),
      ).toHaveAttribute('data-highlighted', 'true');
      // A reveal clears the Library search rather than filtering to one.
      await expect(window.getByTestId('workflows-library-search')).toHaveValue(
        '',
      );

      // See your library opens the whole Library, with no search carried in.
      await app.openWorkflowsTab(RUNS);
      await empty.getByTestId('workflows-runs-empty-library').click();
      await expectWorkflowsTab(window, LIBRARY);
      await expect(window.getByTestId('workflows-library-search')).toHaveValue(
        '',
      );
      await expect(
        app.workflowsLibraryPipelineRow(BUNDLED_PIPELINE_ID, 'bundled'),
      ).toBeVisible();

      // Browse Customize, offered last, leaves Workflows for Customize.
      await app.openWorkflowsTab(RUNS);
      await empty.getByTestId('workflows-runs-empty-marketplace').click();
      await app.expectPluginsPage();
      await expect(window.getByTestId('workflows-runs')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('New workflow remains on Runs with no runs or workflows and preserves the body creation action', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-workflows-empty-library-'),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      // Bundled pipelines normally populate a fresh install. Exercise the
      // plan's zero-workflow branch with an empty list response at the real
      // IPC seam, leaving all creation and editor handlers unchanged.
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('pipelines:list');
        ipcMain.handle('pipelines:list', () => ({ success: true, data: [] }));
      });
      const window = await electronApp.firstWindow();
      await window.reload();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.getByTestId('sidebar-nav-workflows').click();
      await expectWorkflowsTab(window, RUNS);
      await expect(
        window.getByTestId('workflows-tab-count-workflows-library'),
      ).toHaveCount(0);
      const empty = window.getByTestId('workflows-runs-empty');
      await expect(empty).toBeVisible();
      // An empty Library has nothing to preview.
      await expect(
        empty.getByTestId('workflows-runs-library-preview'),
      ).toHaveCount(0);
      await expect(empty.getByTestId('workflows-runs-empty-run')).toHaveCount(
        0,
      );
      await expect(empty.getByTestId('workflows-runs-empty-new')).toHaveText(
        'New workflow',
      );
      await expect(
        empty.getByTestId('workflows-runs-empty-marketplace'),
      ).toHaveText('Browse Customize');
      const heading = window.getByTestId('page-header');
      await expect(heading.getByTestId('workflows-new-manual')).toHaveCount(1);
      await expect(heading.getByTestId('workflows-new-manual')).toHaveText(
        'New workflow',
      );
      await expect(heading.getByTestId('workflows-run-workflow')).toHaveCount(
        0,
      );
      await heading.getByTestId('workflows-new-manual').click();
      const shell = window.getByTestId('workflow-edit-shell');
      await expect(shell).toHaveAttribute('data-kind', 'pipeline');
      await expect(shell.getByTestId('workflow-edit-save-state')).toHaveText(
        'New',
      );
      await backFromWorkflowEdit(window);
      await expectWorkflowsTab(window, LIBRARY);
      // Prove the list really is empty, rather than merely filtered on Runs.
      await expect(window.getByTestId('workflows-library-row')).toHaveCount(0);
      await app.openWorkflowsTab(RUNS);
      await empty.getByTestId('workflows-runs-empty-new').click();
      await expect(shell).toHaveAttribute('data-kind', 'automation');
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Library Run opens without a task and preselects the saved entry with a valid worktree', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openWorkflowsTab(LIBRARY);
      const run = app
        .workflowsLibraryPipelineRow(PIPELINE_ID)
        .getByTestId('workflows-library-run');
      await run.click();
      // Run needs no task (CAN-4542); a directory pipeline is simply not
      // offered until a task can run it.
      const noTask = window.getByTestId('pipeline-trigger-modal');
      await expect(noTask).toBeVisible();
      await expect(
        noTask.getByText('No workflows available for this context.'),
      ).toBeVisible();
      await expect(
        window.getByText(
          'Open a worktree or chat first, then run a workflow in it.',
        ),
      ).toHaveCount(0);
      await noTask.getByTestId('pipeline-trigger-modal-cancel').click();
      await expect(noTask).toHaveCount(0);

      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await app.openWorkflowsTab(LIBRARY);
      await run.click();
      const modal = window.getByTestId('pipeline-trigger-modal');
      await expect(modal).toBeVisible();
      const entry = modal
        .getByTestId('pipeline-trigger-modal-selector')
        .getByRole('button')
        .filter({ hasText: 'Workflows review' });
      await expect(entry).toHaveClass(/\bring-1\b/);
      await expect(
        modal.getByTestId('pipeline-trigger-modal-run'),
      ).toBeEnabled();
      await modal.getByTestId('pipeline-trigger-modal-cancel').click();
      await expect(modal).toHaveCount(0);
      await expectWorkflowsTab(window, LIBRARY);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a row switch names its action, and a read-only pipeline is duplicated into an editable copy', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openWorkflowsTab(LIBRARY);

      // The switch says what a press does: the pipeline is on, the
      // automation was seeded off.
      await app
        .workflowsLibraryPipelineRow(PIPELINE_ID)
        .getByTestId('workflows-library-toggle')
        .hover();
      await expect(
        window.getByRole('tooltip').filter({ hasText: 'Turn off' }),
      ).toBeVisible();
      await app
        .workflowsLibraryAutomationRow(ACTIVITY_ID)
        .getByTestId('workflows-library-toggle')
        .hover();
      await expect(
        window.getByRole('tooltip').filter({ hasText: 'Turn on' }),
      ).toBeVisible();
      // Automations another context holds are not counted under the table.
      await expect(
        window.getByTestId('workflows-library-hidden-in-context'),
      ).toHaveCount(0);

      // A bundled pipeline opens read-only in the edit shell. Its primary
      // action is Duplicate, which makes a copy and opens that copy ready to
      // edit in its place.
      await window
        .getByTestId('workflows-library-search')
        .fill(BUNDLED_PIPELINE_NAME);
      await app
        .workflowsLibraryPipelineRow(BUNDLED_PIPELINE_ID, 'bundled')
        .getByTestId('workflows-library-name')
        .click();
      const shell = window.getByTestId('workflow-edit-shell');
      await expect(shell).toHaveAttribute('data-kind', 'pipeline');
      await expect(shell).toHaveAttribute('data-readonly', 'true');
      await expect(shell.getByTestId('workflow-edit-save-state')).toHaveText(
        'Read-only',
      );
      await expect(shell.getByTestId('pipeline-save')).toHaveCount(0);
      await expect(shell.getByTestId('pipeline-editor-delete')).toHaveCount(0);
      await expect(shell.getByTestId('pipeline-mode-raw')).toHaveCount(0);
      const duplicate = shell
        .getByTestId('workflow-edit-actions')
        .getByTestId('pipeline-editor-duplicate');
      await expect(duplicate).toBeEnabled();
      await duplicate.click();
      await expect(shell).toHaveAttribute('data-readonly', 'false');
      await expect(shell.getByTestId('pipeline-save')).toBeVisible();
      await expect(shell.getByTestId('pipeline-editor-duplicate')).toHaveCount(
        0,
      );
      await expect(shell.getByTestId('pipeline-mode-raw')).toBeVisible();
      await expect(shell.getByTestId('workflow-edit-name')).toContainText(
        BUNDLED_PIPELINE_NAME,
      );
      expect(await workflowEditTarget(window)).toMatchObject({
        kind: 'pipeline',
      });
      expect((await workflowEditTarget(window)).pipelineId).not.toBe(
        BUNDLED_PIPELINE_ID,
      );

      // Back from the copy lists it beside the original.
      await backFromWorkflowEdit(window);
      await expectWorkflowsTab(window, LIBRARY);
      await expect(
        window
          .getByTestId('workflows-library-row')
          .filter({ hasText: BUNDLED_PIPELINE_NAME }),
      ).toHaveCount(2);
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a Library that partly failed and a failed row action each offer Try again', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      // Automations can't be listed until the test lets them; a held read
      // shows the Try again spin.
      await electronApp.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('automations:list');
        ipcMain.removeHandler('automations:list');
        globalThis.automationsUnavailable = true;
        ipcMain.handle('automations:list', async (event, request) => {
          if (globalThis.automationsUnavailable) {
            throw new Error('automations store unavailable');
          }
          await globalThis.automationsListGate;
          return original(event, request);
        });
      });
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openWorkflowsTab(LIBRARY);

      // Part of the Library failed: one notice above what did load.
      const notice = window.getByTestId('workflows-library-load-error');
      await expect(notice).toContainText(
        "Couldn't load some workflows. The rest are listed.",
      );
      await expect(notice).not.toContainText('automations store unavailable');
      await expect(app.workflowsLibraryPipelineRow(PIPELINE_ID)).toBeVisible();
      await expect(app.workflowsLibraryAutomationRow(ACTIVITY_ID)).toHaveCount(
        0,
      );

      await electronApp.evaluate(() => {
        globalThis.automationsUnavailable = false;
        globalThis.automationsListGate = new Promise((resolve) => {
          globalThis.releaseAutomationsList = resolve;
        });
      });
      await notice.getByRole('button', { name: 'Try again' }).click();
      // The notice stays, its capsule spinning, until the read settles.
      const busy = notice.getByRole('button', { name: 'Trying again…' });
      await expect(busy).toBeVisible();
      await expect(busy).toBeDisabled();
      await electronApp.evaluate(() => globalThis.releaseAutomationsList());
      await expect(notice).toHaveCount(0);
      await expect(
        app.workflowsLibraryAutomationRow(ACTIVITY_ID),
      ).toBeVisible();

      // A row action that fails raises a toast whose Try again runs it again.
      await electronApp.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('automations:update');
        ipcMain.removeHandler('automations:update');
        globalThis.updateFails = true;
        ipcMain.handle('automations:update', async (event, request) => {
          if (globalThis.updateFails) {
            return { ok: false, error: 'The automations file is locked.' };
          }
          return original(event, request);
        });
      });
      await app
        .workflowsLibraryAutomationRow(ACTIVITY_ID)
        .getByTestId('workflows-library-toggle')
        .click();
      const toast = window
        .getByTestId('toast-stack-card')
        .filter({ hasText: "Couldn't turn on Workflows standup" });
      await expect(toast).toBeVisible();
      await expect(toast).toContainText('The automations file is locked.');
      const toastRetry = toast.getByTestId('toast-action');
      await expect(toastRetry).toHaveText('Try again');

      await electronApp.evaluate(() => {
        globalThis.updateFails = false;
      });
      await toastRetry.click();
      await expect(toast).toHaveCount(0);
      await expect(
        app
          .workflowsLibraryAutomationRow(ACTIVITY_ID)
          .getByTestId('workflows-library-toggle'),
      ).toBeChecked();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('App Advisor pages and legacy ids open the Workflows tab they became', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      // The three tabs are App Advisor destinations under their own ids.
      await goToPage(electronApp, 'go-library', { page: LIBRARY });
      await expectWorkflowsTab(window, LIBRARY);
      await goToPage(electronApp, 'go-schedule', { page: SCHEDULE });
      await expectWorkflowsTab(window, SCHEDULE);
      await goToPage(electronApp, 'go-runs', { page: RUNS });
      await expectWorkflowsTab(window, RUNS);

      // `watchers` is Runs narrowed to watchers.
      await goToPage(electronApp, 'go-watchers', { page: 'watchers' });
      await expectWorkflowsTab(window, RUNS);
      await expect(
        window.getByTestId('workflows-runs-filter-kind'),
      ).toHaveAttribute('data-active', 'true');
      await expect(app.workflowsWatcherRunRow(WATCHER_ID)).toBeVisible();

      // `pipelines` is the Library narrowed to pipeline triggers, so the
      // scheduled automation is filtered out.
      await goToPage(electronApp, 'go-pipelines', { page: 'pipelines' });
      await expectWorkflowsTab(window, LIBRARY);
      await expect(app.workflowsLibraryPipelineRow(PIPELINE_ID)).toBeVisible();
      await expect(app.workflowsLibraryAutomationRow(ACTIVITY_ID)).toHaveCount(
        0,
      );

      // `automations` is the Library narrowed to scheduled and one-time
      // triggers. The preset replaces the pipeline filter.
      await goToPage(electronApp, 'go-automations', { page: 'automations' });
      await expectWorkflowsTab(window, LIBRARY);
      await expect(
        app.workflowsLibraryAutomationRow(ACTIVITY_ID),
      ).toBeVisible();
      await expect(app.workflowsLibraryPipelineRow(PIPELINE_ID)).toHaveCount(0);

      // Back after a legacy id lands on the tab that was open before it: the
      // legacy id itself is never a history entry.
      await goToPage(electronApp, 'go-runs-again', { page: RUNS });
      await goToPage(electronApp, 'go-pipelines-again', { page: 'pipelines' });
      await expectWorkflowsTab(window, LIBRARY);
      await window.getByTestId('nav-history-back').click();
      await expectWorkflowsTab(window, RUNS);

      await goToPage(electronApp, 'go-tab-watchers', {
        page: 'automations',
        tab: 'watchers',
      });
      await expectWorkflowsTab(window, RUNS);
      await goToPage(electronApp, 'go-tab-scheduled', {
        page: 'automations',
        tab: 'scheduled',
      });
      await expectWorkflowsTab(window, LIBRARY);

      // The retired Shared tab opens Marketplace › Automations filtered to
      // "Shared by me".
      await goToPage(electronApp, 'go-tab-shared', {
        page: 'automations',
        tab: 'shared',
      });
      await app.expectPluginsPage();
      await expect(
        window.getByTestId('plugins-type-tab-workflow'),
      ).toHaveAttribute('aria-selected', 'true');
      // An empty Shared by me focus does not hide local Installed rows.
      await expect(
        window
          .getByTestId('customize-section-installed')
          .getByTestId(`customize-row-automation:local:${ACTIVITY_ID}`),
      ).toBeVisible();

      // The pre-Workflows tab event still works while Workflows is open.
      await app.openWorkflowsTab(SCHEDULE);
      await window.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('canopy:automations-open-tab', {
            detail: { tab: 'watchers' },
          }),
        );
      });
      await expectWorkflowsTab(window, RUNS);
      await window.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('canopy:automations-open-tab', {
            detail: { tab: 'scheduled' },
          }),
        );
      });
      await expectWorkflowsTab(window, LIBRARY);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a saved calendar preference opens Schedule once, then the Library', async () => {
    test.setTimeout(90_000);
    const userDataDir = seedWorkflows();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      // The old Automations page stored its List/Calendar choice here.
      await window.evaluate(() => {
        localStorage.setItem('canopy.automations.viewMode', 'calendar');
      });

      await goToPage(electronApp, 'go-automations-calendar', {
        page: 'automations',
      });
      await expectWorkflowsTab(window, SCHEDULE);
      await expect(window.getByTestId('automations-calendar')).toBeVisible();
      expect(
        await window.evaluate(() =>
          localStorage.getItem('canopy.automations.viewMode'),
        ),
      ).toBeNull();

      await goToPage(electronApp, 'go-automations-library', {
        page: 'automations',
      });
      await expectWorkflowsTab(window, LIBRARY);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // Real composer → bundled Claude → HTTP model fixture → App Advisor's
  // action schema (which resolves `workflows` with a legacy tab to
  // `automations`) → main renderer. A deterministic provider contract, not
  // live inference.
  test('an App Advisor turn opens Runs on watchers through workflows and the legacy tab', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        appAdvisorModel: 'claude-sonnet-4-6',
        appAdvisorThinkingLevel: 'off',
        defaultAppAdvisorInterfaceMode: 'canopy',
        appAdvisorPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
    });
    const marker = 'Canopy-CWORKFLOWSALIAS';
    const reply = 'Workflows watchers are open.';
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'mcp__canopy_app_advisor__DispatchAction',
                input: {
                  action: {
                    type: 'navigation.go_to_page',
                    page: 'workflows',
                    tab: 'watchers',
                  },
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: reply, stopReason: 'end_turn' },
        ],
      },
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const advisor = await app.openAppAdvisorWindow(electronApp);
      const panel = advisor.getByTestId('app-advisor-workspace-surface');
      await panel
        .getByRole('textbox')
        .first()
        .fill(`[${marker}] Show my watchers.`);
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(reply, { exact: true }).first()).toBeVisible(
        { timeout: 45_000 },
      );
      await expect(composerIdleAction(panel)).toBeVisible();

      const transcripts = readdirSync(
        path.join(
          userDataDir,
          'app-workspaces',
          'app-advisor',
          'chat-storage-v2',
        ),
        { recursive: true },
      ).filter(
        (file) =>
          file.includes(`transcripts${path.sep}`) && file.endsWith('.jsonl'),
      );
      expect(transcripts).toHaveLength(1);
      const results = readFileSync(
        path.join(
          userDataDir,
          'app-workspaces',
          'app-advisor',
          'chat-storage-v2',
          transcripts[0],
        ),
        'utf8',
      )
        .trim()
        .split('\n')
        .flatMap((line) => JSON.parse(line).blocks ?? [])
        .filter((block) => block.type === 'tool_result');
      expect(results).toHaveLength(1);
      expect(results[0].isError, results[0].output).not.toBe(true);

      await expectWorkflowsTab(window, RUNS);
      await expect(
        new CanopyAppDriver(window).workflowsWatcherRunRow(WATCHER_ID),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
    }
  });

  test('a pipeline run on Runs is searched, opened and returned to, and hidden', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-workflows-runs-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const run = (id, pipelineName, status, minute) =>
      seedPipelineExecution({
        userDataDir,
        workspaceId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        execution: {
          id,
          pipelineName,
          status,
          startedAt: `2026-04-10T12:0${minute}:00.000Z`,
          completedAt: `2026-04-10T12:0${minute + 5}:00.000Z`,
        },
      });
    run('runs-failed', 'Nightly checks', 'failure', 1);
    run('runs-passed', 'Release notes', 'success', 2);

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openWorkflowsTab('runs');

      const runRow = (id) =>
        window.locator(
          `[data-testid="workflows-run-row"][data-run-key="pipeline-run:${id}"]`,
        );
      const failed = runRow('runs-failed');
      const passed = runRow('runs-passed');
      await expect(failed).toHaveAttribute('data-run-status', 'failure');
      await expect(passed).toHaveAttribute('data-run-status', 'success');
      // CAN-4651: a pipeline run's Kind reads On demand, never Pipeline.
      for (const row of [failed, passed]) {
        await expect(
          row.getByRole('cell', { name: 'On demand', exact: true }),
        ).toBeVisible();
      }
      // The colored dot names its status on hover.
      await failed.getByTestId('workflows-run-status').hover();
      await expect(
        window.getByRole('tooltip').filter({ hasText: 'Failed' }),
      ).toBeVisible();
      // A failed run offers Retry on the row; a finished one does not.
      await expect(
        failed.getByTestId('workflows-run-action-retry'),
      ).toBeVisible();
      await expect(
        passed.getByTestId('workflows-run-action-retry'),
      ).toHaveCount(0);

      // An idle search shows no hint line under the field.
      const hint = window.getByTestId('workflows-runs-hint');
      await expect(hint).toHaveCount(0);

      // A status token narrows the feed.
      const search = window.getByTestId('workflows-runs-search');
      await search.fill('status:failed');
      await expect(failed).toBeVisible();
      await expect(passed).toHaveCount(0);
      await expect(hint).toHaveCount(0);

      // An unknown token value matches nothing and names the valid values.
      await search.fill('status:fialed');
      await expect(
        window.getByTestId('workflows-runs-no-matches'),
      ).toBeVisible();
      await expect(hint).toContainText('status:fialed');
      await search.fill('status:failed');
      await expect(failed).toBeVisible();
      await expect(passed).toHaveCount(0);
      await expect(hint).toHaveCount(0);

      // Enter on the focused row opens the run; Back returns to Runs with the
      // search still applied.
      await failed.focus();
      await window.keyboard.press('Enter');
      await expect(
        window.locator(
          '[data-testid="pipeline-execution-panel"][data-execution-id="runs-failed"]',
        ),
      ).toBeVisible();
      await window.getByTestId('nav-history-back').click();
      await expectWorkflowsTab(window, RUNS);
      await expect(search).toHaveValue('status:failed');
      await expect(failed).toBeVisible();
      await expect(passed).toHaveCount(0);

      // Hide removes a finished run from the feed.
      await search.fill('');
      await expect(passed).toBeVisible();
      await passed.getByTestId('workflows-run-menu').click();
      await window.getByTestId('workflows-run-menu-item-hide').click();
      await expect(passed).toHaveCount(0);
      await expect(failed).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('leaving the pipeline editor with unsaved edits asks to save, discard or keep editing', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    const yamlPath = path.join(userDataDir, 'pipelines', `${PIPELINE_ID}.yaml`);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const sidebarRow = window.getByTestId('sidebar-nav-workflows');
      const dialog = window.getByTestId('workflows-unsaved-dialog');
      const shell = window.getByTestId('workflow-edit-shell');
      const rawYaml = shell
        .getByTestId('workflow-edit-section-definition')
        .getByTestId('pipeline-raw-yaml-textarea');
      const openEditor = async () => {
        await app.openWorkflowsTab(LIBRARY);
        await app.openWorkflowsLibraryRow(
          app.workflowsLibraryPipelineRow(PIPELINE_ID),
        );
        await expect(shell).toHaveAttribute('data-kind', 'pipeline');
        await expect(shell.getByTestId('pipeline-editor-back')).toBeVisible();
      };
      const openRawYaml = async () => {
        await openEditor();
        await shell.getByTestId('pipeline-mode-raw').click();
        await expect(rawYaml).toBeVisible();
      };
      const editCommand = async (from, to) => {
        const current = await rawYaml.inputValue();
        expect(current).toContain(from);
        await rawYaml.fill(current.replace(from, to));
        await expect(rawYaml).toHaveValue(new RegExp(to));
        await expect(shell).toHaveAttribute('data-dirty', 'true');
      };
      const expectEditorStillOpen = async () => {
        await expect(shell).toHaveAttribute('data-kind', 'pipeline');
        await expect(shell.getByTestId('pipeline-editor-back')).toBeVisible();
        await expect(window.getByTestId('workflows-tabs')).toHaveCount(0);
      };

      // ⌘8 opens Runs, which closes the editor. The Workflows row is the
      // current row on every Workflows tab, so clicking it returns Workflows
      // to its root, Runs, the same way (2026-10-22).
      const leaveForRuns = () => pressGlobalShortcut(window, '8');

      // An editor with no edits leaves at once, in visual and in raw mode.
      await openEditor();
      await sidebarRow.click();
      await expectWorkflowsTab(window, RUNS);
      await expect(dialog).toHaveCount(0);
      await openEditor();
      await leaveForRuns();
      await expectWorkflowsTab(window, RUNS);
      await expect(dialog).toHaveCount(0);
      await openRawYaml();
      await expect(rawYaml).toHaveValue(/echo review/);
      await leaveForRuns();
      await expectWorkflowsTab(window, RUNS);
      await expect(dialog).toHaveCount(0);

      // With an edit, leaving asks first and the editor stays behind the
      // prompt.
      await openRawYaml();
      await editCommand('echo review', 'echo discarded');
      await leaveForRuns();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Save changes to “Workflows review”?');
      await expectEditorStillOpen();

      // Escape keeps editing: the editor and the edit are both still there.
      await window.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expectEditorStillOpen();
      await expect(rawYaml).toHaveValue(/echo discarded/);

      // Another sidebar row asks too, and Cancel keeps editing here.
      await window.getByTestId('sidebar-nav-plugins').click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(window.getByTestId('page-plugins')).toHaveCount(0);
      await expectEditorStillOpen();
      await expect(rawYaml).toHaveValue(/echo discarded/);

      // The current Workflows row asks before it returns to Runs, and
      // closing the prompt stays in the editor with the edit.
      await sidebarRow.click();
      await expect(dialog).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expectEditorStillOpen();
      await expect(rawYaml).toHaveValue(/echo discarded/);

      // Discard leaves for Runs and drops the edit.
      await sidebarRow.click();
      await expect(dialog).toBeVisible();
      await window.getByTestId('workflows-unsaved-discard').click();
      await expect(dialog).toHaveCount(0);
      await expectWorkflowsTab(window, RUNS);
      expect(readFileSync(yamlPath, 'utf8')).toContain('echo review');
      await openRawYaml();
      await expect(rawYaml).toHaveValue(/echo review/);
      await expect(rawYaml).not.toHaveValue(/echo discarded/);

      // Save changes writes the edit, then leaves for Runs.
      await editCommand('echo review', 'echo saved');
      await leaveForRuns();
      await expect(dialog).toBeVisible();
      await window.getByTestId('workflows-unsaved-save').click();
      await expect(dialog).toHaveCount(0);
      await expectWorkflowsTab(window, RUNS);
      await expect
        .poll(() => readFileSync(yamlPath, 'utf8'))
        .toContain('echo saved');
      await openRawYaml();
      await expect(rawYaml).toHaveValue(/echo saved/);
      await expect(rawYaml).not.toHaveValue(/echo review/);

      // The saved editor is clean again, so it leaves without asking.
      await leaveForRuns();
      await expectWorkflowsTab(window, RUNS);
      await expect(dialog).toHaveCount(0);
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // Sergii's QA (2026-10-23): text typed into the Pipeline Assistant and not
  // sent is unsaved work, so any sidebar row asks first and Discard drops it.
  test('an unsent Pipeline Assistant draft asks before leaving, and Discard drops it', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const dialog = window.getByTestId('workflows-unsaved-dialog');
      const shell = window.getByTestId('workflow-edit-shell');
      const customizeRow = window.getByTestId('sidebar-nav-plugins');
      const composer = window
        .getByTestId('pipeline-chat-panel')
        .getByRole('textbox')
        .first();
      const openEditorWithAssistant = async () => {
        await app.openWorkflowsTab(LIBRARY);
        await app.openWorkflowsLibraryRow(
          app.workflowsLibraryPipelineRow(PIPELINE_ID),
        );
        await expect(shell).toHaveAttribute('data-kind', 'pipeline');
        const assistant = shell.getByTestId('workflow-edit-assistant');
        if ((await assistant.getAttribute('aria-pressed')) !== 'true') {
          await assistant.click();
        }
        await expect(composer).toBeVisible();
      };

      await openEditorWithAssistant();
      await composer.click();
      await window.keyboard.type('Add a lint step');
      await expect(composer).toContainText('Add a lint step');

      // The pipeline itself is unedited; the draft alone asks.
      await customizeRow.click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Save changes to “Workflows review”?');
      await window.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(window.getByTestId('page-plugins')).toHaveCount(0);
      await expect(composer).toContainText('Add a lint step');

      // Discard leaves for Customize and drops the draft.
      await customizeRow.click();
      await expect(dialog).toBeVisible();
      await window.getByTestId('workflows-unsaved-discard').click();
      await expect(dialog).toHaveCount(0);
      await expect(window.getByTestId('page-plugins')).toBeVisible();

      await openEditorWithAssistant();
      await expect(composer).not.toContainText('Add a lint step');
      await customizeRow.click();
      await expect(window.getByTestId('page-plugins')).toBeVisible();
      await expect(dialog).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Back and history Back ask about unsaved pipeline edits, and closing the prompt keeps the edit', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows();
    const yamlPath = path.join(userDataDir, 'pipelines', `${PIPELINE_ID}.yaml`);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const dialog = window.getByTestId('workflows-unsaved-dialog');
      const shell = window.getByTestId('workflow-edit-shell');
      const back = shell.getByTestId('pipeline-editor-back');
      const historyBack = window.getByTestId('nav-history-back');
      const rawYaml = shell
        .getByTestId('workflow-edit-section-definition')
        .getByTestId('pipeline-raw-yaml-textarea');
      const openAndEdit = async (to) => {
        await app.openWorkflowsTab(LIBRARY);
        await app.openWorkflowsLibraryRow(
          app.workflowsLibraryPipelineRow(PIPELINE_ID),
        );
        await expect(shell).toHaveAttribute('data-kind', 'pipeline');
        await shell.getByTestId('pipeline-mode-raw').click();
        await expect(rawYaml).toHaveValue(/echo review/);
        await expect(shell).toHaveAttribute('data-dirty', 'false');
        const current = await rawYaml.inputValue();
        await rawYaml.fill(current.replace('echo review', to));
        await expect(shell).toHaveAttribute('data-dirty', 'true');
        await expect(shell.getByTestId('workflow-edit-save-state')).toHaveText(
          'Unsaved changes',
        );
      };
      const expectStillEditing = async (text) => {
        await expect(dialog).toHaveCount(0);
        await expect(shell).toHaveAttribute('data-kind', 'pipeline');
        await expect(shell).toHaveAttribute('data-dirty', 'true');
        await expect(rawYaml).toHaveValue(new RegExp(text));
        await expect(window.getByTestId('workflows-tabs')).toHaveCount(0);
        expect(await workflowEditTarget(window)).toMatchObject({
          kind: 'pipeline',
          pipelineId: PIPELINE_ID,
        });
      };

      // Back with an edit asks first; the shell stays behind the prompt.
      await openAndEdit('echo back asks');
      await back.click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Save changes to “Workflows review”?');
      await expect(shell).toBeVisible();

      // Cancel keeps editing, and so does Escape.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expectStillEditing('echo back asks');
      await back.click();
      await expect(dialog).toBeVisible();
      await window.keyboard.press('Escape');
      await expectStillEditing('echo back asks');

      // Discard leaves for the Library and drops the edit.
      await back.click();
      await expect(dialog).toBeVisible();
      await window.getByTestId('workflows-unsaved-discard').click();
      await expect(dialog).toHaveCount(0);
      await expect(shell).toHaveCount(0);
      await expectWorkflowsTab(window, LIBRARY);
      expect(readFileSync(yamlPath, 'utf8')).toContain('echo review');
      expect(readFileSync(yamlPath, 'utf8')).not.toContain('echo back asks');

      // History Back (the titlebar arrow) asks too. Closing the prompt keeps
      // the shell and its edit, and history stays where it was.
      await openAndEdit('echo history asks');
      await expect(historyBack).toBeEnabled();
      await historyBack.click();
      await expect(dialog).toBeVisible();
      await window.keyboard.press('Escape');
      await expectStillEditing('echo history asks');
      await expect(historyBack).toBeEnabled();

      // The history shortcut asks the same way; Cancel keeps editing.
      await pressHistoryBack(window);
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expectStillEditing('echo history asks');

      // Discard lets history Back through, to the Library.
      await historyBack.click();
      await expect(dialog).toBeVisible();
      await window.getByTestId('workflows-unsaved-discard').click();
      await expect(dialog).toHaveCount(0);
      await expect(shell).toHaveCount(0);
      await expectWorkflowsTab(window, LIBRARY);
      expect(await workflowEditTarget(window)).toBeNull();
      expect(readFileSync(yamlPath, 'utf8')).not.toContain('echo history asks');
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('opening another item from a pipeline with unsaved edits asks, and Discard opens it', async () => {
    test.setTimeout(120_000);
    const userDataDir = seedWorkflows({ withPipelineAutomation: true });
    const yamlPath = path.join(userDataDir, 'pipelines', `${PIPELINE_ID}.yaml`);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const dialog = window.getByTestId('workflows-unsaved-dialog');
      const shell = window.getByTestId('workflow-edit-shell');
      const rawYaml = shell
        .getByTestId('workflow-edit-section-definition')
        .getByTestId('pipeline-raw-yaml-textarea');

      await app.openWorkflowsTab(LIBRARY);
      await app.openWorkflowsLibraryRow(
        app.workflowsLibraryPipelineRow(PIPELINE_ID),
      );
      await expect(shell).toHaveAttribute('data-kind', 'pipeline');
      await shell.getByTestId('pipeline-mode-raw').click();
      const current = await rawYaml.inputValue();
      await rawYaml.fill(current.replace('echo review', 'echo not kept'));
      await expect(shell).toHaveAttribute('data-dirty', 'true');

      // Trigger lists the automation that runs this pipeline. Opening it is
      // a different item, so the unsaved edit asks first.
      const trigger = await openWorkflowEditSection(window, 'trigger');
      const automationRow = trigger.locator(
        `[data-testid="pipeline-trigger-automation"][data-activity-id="${PIPELINE_AUTOMATION_ID}"]`,
      );
      await expect(automationRow).toContainText(PIPELINE_AUTOMATION_NAME);
      await expect(automationRow).toContainText('Off');
      await automationRow.click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Save changes to “Workflows review”?');

      // Escape keeps the pipeline and its edit, on the section it was on.
      await window.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(shell).toHaveAttribute('data-kind', 'pipeline');
      await expect(shell).toHaveAttribute('data-dirty', 'true');
      await expect(
        shell.getByTestId('workflow-edit-tab-trigger'),
      ).toHaveAttribute('aria-selected', 'true');
      await openWorkflowEditSection(window, 'definition');
      await expect(rawYaml).toHaveValue(/echo not kept/);

      // A different item opened another way (as App Advisor and the side
      // panel do) asks the same way; X keeps editing.
      await window.evaluate(
        (activityId) =>
          window.__canopyNavigationTestApi.openWorkflowEdit({
            kind: 'automation',
            activityId,
          }),
        ACTIVITY_ID,
      );
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(shell).toHaveAttribute('data-kind', 'pipeline');
      await expect(rawYaml).toHaveValue(/echo not kept/);

      // Discard opens the automation; its Back names the pipeline.
      await openWorkflowEditSection(window, 'trigger');
      await automationRow.click();
      await expect(dialog).toBeVisible();
      await window.getByTestId('workflows-unsaved-discard').click();
      await expect(dialog).toHaveCount(0);
      await expect(shell).toHaveAttribute('data-kind', 'automation');
      await expect(
        shell
          .getByTestId('workflow-edit-section-definition')
          .getByTestId('automations-form-name'),
      ).toHaveValue(PIPELINE_AUTOMATION_NAME);
      await expect(shell.getByTestId('workflow-edit-back')).toHaveText(
        'Workflow',
      );
      expect(readFileSync(yamlPath, 'utf8')).not.toContain('echo not kept');

      // Back returns to the pipeline's Trigger section, without the edit.
      await backFromWorkflowEdit(window);
      await expect(shell).toHaveAttribute('data-kind', 'pipeline');
      await expect(shell).toHaveAttribute('data-dirty', 'false');
      await expect(
        shell.getByTestId('workflow-edit-tab-trigger'),
      ).toHaveAttribute('aria-selected', 'true');
      await openWorkflowEditSection(window, 'definition');
      await shell.getByTestId('pipeline-mode-raw').click();
      await expect(rawYaml).toHaveValue(/echo review/);
      await expect(rawYaml).not.toHaveValue(/echo not kept/);
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a shared automation opens read-only, and Duplicate opens the add dialog', async () => {
    test.setTimeout(120_000);
    const key = 'csk_workflows_shared_automation_duplicate';
    const SHARE_ID = 'workflows-shared-review';
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      cloud: {
        sharedAutomations: [
          {
            id: SHARE_ID,
            name: 'Shared nightly review',
            description: '',
            triggerKind: 'cron',
            actionType: 'worktree_pipeline',
            contentHash: `${SHARE_ID}-hash`,
            shareScope: 'team',
            owner: { type: 'team', id: 'workflows-team', name: 'Platform' },
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
            createdBy: { id: 'workflows-author', name: 'Author', email: null },
            canUpdate: false,
            canDelete: false,
            publicShare: null,
          },
        ],
      },
    });
    const userDataDir = seedWorkflows();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connectMockCloudAccount(window, key);
      await app.openWorkflowsTab(LIBRARY);

      // A share that is not added yet is a Library row; opening it shows the
      // share read-only in the edit shell, with Duplicate as its one action.
      const row = window.locator(
        `[data-testid="workflows-library-row"][data-row-key="shared-automation:${SHARE_ID}"]`,
      );
      await expect(row).toBeVisible({ timeout: 15_000 });
      await app.openWorkflowsLibraryRow(row);
      const shell = window.getByTestId('workflow-edit-shell');
      await expect(shell).toHaveAttribute('data-kind', 'automation');
      await expect(shell).toHaveAttribute('data-readonly', 'true');
      await expect(shell).toHaveAttribute('data-dirty', 'false');
      await expect(shell.getByTestId('workflow-edit-save-state')).toHaveText(
        'Read-only',
      );
      expect(await workflowEditTarget(window)).toMatchObject({
        kind: 'shared-automation',
        remoteId: SHARE_ID,
      });
      await expect(shell.getByTestId('automations-form-submit')).toHaveCount(0);
      await expect(shell.getByTestId('automations-form-enabled')).toHaveCount(
        0,
      );
      await expect(shell.getByTestId('automation-details-delete')).toHaveCount(
        0,
      );
      await expect(shell.getByTestId('automations-form-name')).toHaveCount(0);
      const trigger = await openWorkflowEditSection(window, 'trigger');
      await expect(
        trigger.getByTestId('shared-automation-schedule'),
      ).toContainText(/^Scheduled · \S+ \S+ \S+ \S+ \S+$/);
      await openWorkflowEditSection(window, 'definition');

      const duplicate = shell
        .getByTestId('workflow-edit-actions')
        .getByTestId('shared-automation-duplicate');
      await expect(duplicate).toBeEnabled();
      await duplicate.click();
      const modal = window.getByTestId('install-shared-automation-modal');
      await expect(modal).toBeVisible();

      // Completing the copy is covered by automations-install-wizard; closing
      // the dialog adds nothing and keeps the share open.
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(shell).toHaveAttribute('data-readonly', 'true');
      expect(await workflowEditTarget(window)).toMatchObject({
        kind: 'shared-automation',
        remoteId: SHARE_ID,
      });

      // Back returns to the Library without asking.
      await backFromWorkflowEdit(window);
      await expectWorkflowsTab(window, LIBRARY);
      await expect(row).toBeVisible();
    } finally {
      await discardWorkflowEditIfOpen(electronApp);
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, key).catch(() => undefined);
    }
  });

  test('the Schedule Project filter narrows the calendar to one project and clears', async () => {
    test.setTimeout(90_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-workflows-schedule-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite', 'ts-npm-next'],
    });
    const VITE = 'demo-ts-pnpm-vite';
    const NEXT = 'demo-ts-npm-next';
    // Disabled so nothing is scheduled while the spec runs. A daily time puts
    // each one in every week the calendar can show.
    const activity = (id, name, hour, action) => ({
      version: 1,
      id,
      name,
      enabled: false,
      schedule: {
        kind: 'cron',
        expression: `0 ${hour} * * *`,
        timezone: 'local',
      },
      action,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      failureCount: 0,
    });
    seedAutomations({
      userDataDir,
      activities: [
        activity('schedule-vite', 'Vite checkup', 9, {
          type: 'worktree_prompt',
          workspaceId: VITE,
          prompt: 'Check the Vite app.',
        }),
        activity('schedule-next', 'Next checkup', 11, {
          type: 'worktree_prompt',
          workspaceId: NEXT,
          prompt: 'Check the Next app.',
        }),
        activity('schedule-advisor', 'Advisor summary', 14, {
          type: 'app_advisor_prompt',
          prompt: 'Summarize the day.',
        }),
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openWorkflowsTab('schedule');
      await expect(window.getByTestId('automations-calendar')).toBeVisible();

      const chips = (activityId) =>
        window.locator(
          `[data-testid="automations-calendar-event"][data-activity-id="${activityId}"]`,
        );
      const expectShown = async (shown) => {
        for (const id of ['schedule-vite', 'schedule-next', 'schedule-advisor'])
          if (shown.includes(id)) {
            await expect(chips(id).first()).toBeVisible();
          } else {
            await expect(chips(id)).toHaveCount(0);
          }
      };
      const filter = window.getByTestId('workflows-schedule-project');
      const pick = async (item) => {
        await filter.click();
        await expect(
          window.getByTestId('workflows-schedule-project-menu'),
        ).toBeVisible();
        await window.getByTestId(`workflows-schedule-project-${item}`).click();
        await expect(
          window.getByTestId('workflows-schedule-project-menu'),
        ).toHaveCount(0);
      };

      // Automations that are off stay out of the calendar until asked for.
      await expectShown([]);
      await window.getByTestId('automations-calendar-show-disabled').check();
      await expect(filter).toHaveAttribute('data-active', 'false');
      await expect(filter).toHaveText('Any project');
      await expectShown(['schedule-vite', 'schedule-next', 'schedule-advisor']);

      // One project leaves only that project's automation.
      await pick(`option-${VITE}`);
      await expect(filter).toHaveAttribute('data-active', 'true');
      await expectShown(['schedule-vite']);
      await pick(`option-${NEXT}`);
      await expect(filter).toHaveAttribute('data-active', 'true');
      await expectShown(['schedule-next']);

      // "No project" is what runs in no project: App Advisor.
      await pick('option-__none__');
      await expectShown(['schedule-advisor']);

      // "Any project" clears the filter and restores every automation.
      await pick('any');
      await expect(filter).toHaveAttribute('data-active', 'false');
      await expect(filter).toHaveText('Any project');
      await expectShown(['schedule-vite', 'schedule-next', 'schedule-advisor']);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Retry, Respond and Cancel on a pipeline run row act on that run', async () => {
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-workflows-run-actions-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const PAUSED_ID = 'runs-paused';
    const RUNNING_ID = 'runs-running';
    const RETRY_PIPELINE_ID = 'workflows-fails-once';
    const RETRY_NAME = 'Fails once';
    // Fails on its first run and passes on the next, so Retry has a real
    // failed run to start again.
    seedStoredPipeline({
      userDataDir,
      id: RETRY_PIPELINE_ID,
      name: RETRY_NAME,
      yaml: [
        `name: ${RETRY_NAME}`,
        'on: dispatch',
        'jobs:',
        '  main:',
        '    steps:',
        '      - id: fail_once',
        '        run: |',
        '          if [ ! -f .e2e-workflows-retry-once ]; then',
        '            touch .e2e-workflows-retry-once',
        '            exit 1',
        '          fi',
        '',
      ].join('\n'),
    });
    seedPipelineExecution({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      execution: {
        id: PAUSED_ID,
        pipelineName: 'Needs an answer',
        status: 'paused',
        jobs: [
          {
            id: 'review',
            name: 'Review',
            steps: [{ id: 'ask', name: 'Ask', run: 'echo ask' }],
          },
        ],
        pendingInput: {
          jobId: 'review',
          stepId: 'ask',
          title: 'Reviewer approval required',
          message: 'Enter the reviewer name to continue.',
          fields: [
            {
              key: 'reviewer',
              label: 'Reviewer',
              type: 'string',
              required: true,
            },
          ],
        },
      },
    });
    // A running run whose recorded owner is alive but is not this app: Cancel
    // has to end it rather than find it already gone.
    seedPipelineExecution({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      execution: {
        id: RUNNING_ID,
        pipelineName: 'Still going',
        status: 'running',
        stateOverrides: { owner_pid: process.pid },
      },
    });
    const persisted = (id) =>
      JSON.parse(
        readFileSync(
          path.join(userDataDir, 'pipeline-executions', `${id}.json`),
          'utf8',
        ),
      );

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // A pipeline runs in the selected worktree, so pick one, then start the
      // pipeline that fails once from its Library row.
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await app.openWorkflowsTab(LIBRARY);
      await app
        .workflowsLibraryPipelineRow(RETRY_PIPELINE_ID)
        .getByTestId('workflows-library-run')
        .click();
      await expect(
        window.getByTestId('pipeline-trigger-modal-body'),
      ).toBeVisible();
      await window.getByTestId('pipeline-trigger-modal-run').click();
      await expect(window.getByTestId('pipeline-trigger-modal')).toHaveCount(0);

      await app.openWorkflowsTab('runs');
      const runRow = (id) =>
        window.locator(
          `[data-testid="workflows-run-row"][data-run-key="pipeline-run:${id}"]`,
        );

      // Retry starts the failed run again, as the same run, and it passes.
      const dispatched = window
        .getByTestId('workflows-run-row')
        .filter({ hasText: RETRY_NAME });
      await expect(dispatched).toHaveCount(1);
      await expect(dispatched).toHaveAttribute('data-run-status', 'failure', {
        timeout: 60_000,
      });
      const retryKey = await dispatched.getAttribute('data-run-key');
      expect(retryKey).toMatch(/^pipeline-run:/);
      const retryId = retryKey.replace('pipeline-run:', '');
      const retried = runRow(retryId);
      await retried.getByTestId('workflows-run-action-retry').click();
      await expect(retried).toHaveAttribute('data-run-status', 'success', {
        timeout: 60_000,
      });
      await expect(
        retried.getByTestId('workflows-run-action-retry'),
      ).toHaveCount(0);
      await expect(dispatched).toHaveCount(1);
      expect(persisted(retryId).status).toBe('success');

      // Respond opens the waiting run on the question it is waiting on.
      const paused = runRow(PAUSED_ID);
      await expect(paused).toHaveAttribute('data-run-status', 'waiting');
      await paused.getByTestId('workflows-run-action-respond').click();
      const panel = window.locator(
        `[data-testid="pipeline-execution-panel"][data-execution-id="${PAUSED_ID}"]`,
      );
      await expect(panel).toBeVisible();
      const pausePanel = panel.getByTestId('pause-input-panel');
      await expect(pausePanel).toBeVisible({ timeout: 15_000 });
      await expect(pausePanel).toContainText('Reviewer approval required');
      await expect(panel.getByTestId('pause-field-reviewer')).toBeVisible();
      await window.getByTestId('nav-history-back').click();
      await expectWorkflowsTab(window, RUNS);
      // Opening the run did not answer it.
      await expect(paused).toHaveAttribute('data-run-status', 'waiting');

      // Cancel ends the running run.
      const running = runRow(RUNNING_ID);
      await expect(running).toHaveAttribute('data-run-status', 'running');
      await running.getByTestId('workflows-run-action-cancel').click();
      await expect(running).toHaveAttribute('data-run-status', 'canceled', {
        timeout: 30_000,
      });
      await expect(
        running.getByTestId('workflows-run-action-cancel'),
      ).toHaveCount(0);
      expect(persisted(RUNNING_ID).status).toBe('cancelled');
      expect(persisted(RUNNING_ID).completed_at).toBeTruthy();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

/**
 * Replaces the main-process handler for `channel` with one that waits for
 * `globalThis[releaseName]()` before answering, so a load stays in flight.
 */
async function holdIpc(electronApp, channel, releaseName) {
  await electronApp.evaluate(
    ({ ipcMain }, { channel, releaseName }) => {
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      let release = () => undefined;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      globalThis[releaseName] = release;
      ipcMain.handle(channel, async (...args) => {
        await held;
        return original(...args);
      });
    },
    { channel, releaseName },
  );
}

test.describe('Workflows Library loading', () => {
  test('a slow first load shows the table in skeleton, rows replace it, and Refresh keeps the rows', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-workflows-loading-'),
    );
    seedStoredPipeline({
      userDataDir,
      id: PIPELINE_ID,
      name: 'Workflows review',
      yaml: [
        'name: Workflows review',
        'on: dispatch',
        'scope: directory',
        'jobs:',
        '  main:',
        '    steps:',
        '      - run: echo review',
        '',
      ].join('\n'),
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await holdIpc(electronApp, 'pipelines:list', 'releasePipelineList');

      await app.openWorkflowsTab('library');
      const library = window.getByTestId('workflows-library');
      // Nothing flashes: the placeholder holds its box, then shows the
      // table's real column heads over rows whose values pulse.
      const placeholder = library.getByTestId('delayed-loading-placeholder');
      await expect(placeholder).toHaveAttribute('data-visible', 'true');
      const skeleton = placeholder.getByTestId('workflows-library-skeleton');
      await expect(skeleton).toBeVisible();
      await expect(skeleton.locator('thead th')).toHaveText([
        'Workflow',
        'Trigger',
        'Last run',
        'Next run',
        'On or off, and actions',
      ]);
      await expect(skeleton.locator('tbody tr')).toHaveCount(5);
      await expect(library).not.toContainText('Loading workflows…');
      // Nothing counts rows that have not arrived.
      await expect(
        library.getByTestId('workflows-library-pagination'),
      ).toHaveCount(0);
      await expect(placeholder.getByTestId('slow-load-note')).toHaveText('');
      const skeletonRowHeight = await skeleton
        .locator('tbody tr')
        .first()
        .evaluate((row) => row.getBoundingClientRect().height);

      await electronApp.evaluate(() => globalThis.releasePipelineList());
      const row = app.workflowsLibraryPipelineRow(PIPELINE_ID);
      await expect(row).toBeVisible();
      await expect(
        library.getByTestId('workflows-library-skeleton'),
      ).toHaveCount(0);
      // The skeleton rows stand at the height of a loaded row with its
      // summary line (a built-in workflow's "Built-in").
      const rowHeight = await library
        .getByTestId('workflows-library-row')
        .filter({ hasText: 'Built-in' })
        .first()
        .evaluate((element) => element.getBoundingClientRect().height);
      expect(Math.abs(rowHeight - skeletonRowHeight)).toBeLessThanOrEqual(1);

      // Refresh spins its own icon; the rows stay and no skeleton returns.
      await holdIpc(electronApp, 'pipelines:list', 'releasePipelineRefresh');
      const refresh = window.getByTestId('workflows-library-refresh');
      await refresh.click();
      await expect(refresh.locator('svg')).toHaveClass(/\banimate-spin\b/);
      await expect(row).toBeVisible();
      await expect(
        library.getByTestId('workflows-library-skeleton'),
      ).toHaveCount(0);
      await electronApp.evaluate(() => globalThis.releasePipelineRefresh());
      await expect(refresh.locator('svg')).not.toHaveClass(/\banimate-spin\b/);
      await expect(row).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
