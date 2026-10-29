// Workspace Automations panel — the `automations` panel kind added through the
// add-panel menu's "Automations" submenu (same nested-flyout UX as Usage).
//
// Covers: the four variant rows in the submenu; adding the full panel; its
// three sections (Upcoming / Overview / Completed) with seeded automations,
// watchers, run history, and a completed watcher fire; the worktree-scope
// toggle (on by default, widening to the whole workspace when toggled); the
// entry click → the automation's Runs section in the main window's Workflows
// edit shell, and its Definition form; the add button's prefilled draft in the
// shell, including from an auxiliary window (which focuses the main window);
// watcher-modal ownership in the auxiliary window; variant dedupe in the submenu; and the single-section
// `upcoming` preset variant.
//
// Seeding is two-phase (demo workspace + automations/watchers files written
// before launch, `seedDemoWorkspaces: false` so launch does not re-seed); the
// E2E build never starts the automations scheduler, so seeded state is
// deterministic.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  openWorkflowEditSection,
} from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  seedAutomations,
  seedWatchers,
  seedWorktreeChat,
} from './seeders/index.mjs';
import {
  DEFAULT_GROUP_IDS,
  seedPanelWorktree,
  SEEDED_CHAT_TAB_ID,
} from './panelHarness.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

const WT_AUTOMATION_ID = 'panel-wt-automation';
const WS_AUTOMATION_ID = 'panel-ws-automation';
const RUN_ID = 'panel-run-1';
const ACTIVE_WATCHER_ID = 'panel-active-watcher';
const FIRED_WATCHER_ID = 'panel-fired-watcher';

function seedPanelAutomationsState(userDataDir) {
  const archivedRuns = Array.from({ length: 55 }, (_, index) => ({
    id: index === 0 ? RUN_ID : `panel-run-${index + 1}`,
    activityId: WT_AUTOMATION_ID,
    activityName: 'Worktree digest',
    scheduledFor: new Date(
      Date.parse('2026-08-29T09:00:00.000Z') - index * 60_000,
    ).toISOString(),
    manual: false,
    trigger: 'scheduled',
    executionLocation: 'local',
    status: 'success',
    startedAt: new Date(
      Date.parse('2026-08-29T09:00:00.000Z') - index * 60_000,
    ).toISOString(),
    completedAt: new Date(
      Date.parse('2026-08-29T09:00:05.000Z') - index * 60_000,
    ).toISOString(),
    durationMs: 5_000,
    target: { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  }));
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: WT_AUTOMATION_ID,
        name: 'Worktree digest',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: {
          type: 'worktree_prompt',
          workspaceId: WORKSPACE_ID,
          existingWorktreeId: WORKTREE_ID,
          prompt: 'Summarize the branch.',
        },
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
        failureCount: 0,
      },
      {
        version: 1,
        id: WS_AUTOMATION_ID,
        name: 'Project sweep',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_prompt',
          workspaceId: WORKSPACE_ID,
          prompt: 'Sweep the project.',
        },
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
        failureCount: 0,
      },
    ],
    recentRuns: [archivedRuns[0]],
    archivedRunsByActivity: { [WT_AUTOMATION_ID]: archivedRuns },
  });
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: ACTIVE_WATCHER_ID,
        label: 'Chat completion watcher',
        trigger: 'worktree_chat_completion',
        target: {
          kind: 'worktree_chat',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: SEEDED_CHAT_TAB_ID,
          chatTitle: 'Chat',
        },
        destination: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: SEEDED_CHAT_TAB_ID,
        },
      },
      {
        id: FIRED_WATCHER_ID,
        label: 'Fired pipeline watcher',
        trigger: 'worktree_pipeline_completion',
        status: 'fired',
        firedAt: '2026-08-29T12:00:00.000Z',
        target: {
          kind: 'worktree_pipeline',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          executionId: 'exec-1',
        },
        destination: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: SEEDED_CHAT_TAB_ID,
        },
      },
      ...Array.from({ length: 55 }, (_, index) => ({
        id: `panel-pending-watcher-${index}`,
        label: `Pending watcher ${index}`,
        trigger: 'worktree_chat_completion',
        status: 'firing',
        // Keep seeded pending deliveries in the current process's live window.
        updatedAt: '2099-01-01T00:00:00.000Z',
        target: {
          kind: 'worktree_chat',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: SEEDED_CHAT_TAB_ID,
        },
        destination: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: SEEDED_CHAT_TAB_ID,
        },
      })),
    ],
  });
}

async function openAutomationsSubmenu(window) {
  await window.getByTestId('panel-add-panel-group-chat').click();
  await expect(window.getByTestId('panel-add-menu')).toBeVisible();
  await window.getByTestId('panel-add-menu-automations-submenu').click();
  await expect(
    window.getByTestId('panel-add-menu-automations-group'),
  ).toBeVisible();
}

async function getAdvisorUiState(electronApp) {
  const request = {
    kind: 'get_current_ui_state',
    requestId: `automations-panel-ui-state-${Date.now()}`,
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

/** The panel opens the shell in the main window; Back, then the worktree. */
async function returnToWorktreeFromShell(window) {
  await backFromWorkflowEdit(window);
  const app = new CanopyAppDriver(window);
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
}

/**
 * Counts the main window's `window.focus()` calls. Headless E2E windows are
 * hidden, so OS focus is not observable; the request the pop-out makes is.
 */
async function trackMainWindowFocusRequests(window) {
  await window.evaluate(() => {
    const original = window.focus.bind(window);
    window.__can4072FocusRequests = 0;
    window.focus = () => {
      window.__can4072FocusRequests += 1;
      original();
    };
  });
  return () => window.evaluate(() => window.__can4072FocusRequests);
}

test('automations panel: submenu variants, sections, scope toggle, runs in the edit shell, and prefilled create', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automations-panel-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Chat' }],
  });
  seedPanelAutomationsState(userDataDir);

  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });

  try {
    // --- 1. The Automations submenu offers all four variants.
    await openAutomationsSubmenu(window);
    for (const variant of ['full', 'upcoming', 'overview', 'completed']) {
      await expect(
        window.getByTestId(`panel-add-menu-item-automations-${variant}`),
      ).toBeVisible();
    }

    // --- 2. Add the full panel: content mounts with all three sections.
    await window.getByTestId('panel-add-menu-item-automations-full').click();
    const fullPanel = window.locator(
      '[data-testid="automations-panel"][data-variant="full"]',
    );
    await expect(fullPanel).toBeVisible();
    for (const section of ['upcoming', 'overview', 'completed']) {
      await expect(
        fullPanel.getByTestId(`automations-panel-section-${section}`),
      ).toBeVisible();
    }

    // --- 3. Worktree scope is ON by default: only the worktree-targeting
    // automation shows; the workspace-level one appears after toggling.
    const toggle = fullPanel.getByTestId('automations-panel-worktree-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(
      fullPanel.getByTestId(
        `automations-panel-overview-automation-${WT_AUTOMATION_ID}`,
      ),
    ).toBeVisible();
    await expect(
      fullPanel.getByTestId(
        `automations-panel-overview-automation-${WS_AUTOMATION_ID}`,
      ),
    ).toHaveCount(0);
    await expect(
      fullPanel.getByTestId(
        `automations-panel-overview-watcher-${ACTIVE_WATCHER_ID}`,
      ),
    ).toBeVisible();

    // The panel content is adopted into the auxiliary document without a
    // remount. Watcher details must portal into that owner document and bind
    // Escape there rather than opening in the main window.
    const auxWindowPromise = electronApp.waitForEvent('window');
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    await window
      .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    const aux = await auxWindowPromise;
    const auxFullPanel = aux.locator(
      '[data-testid="automations-panel"][data-variant="full"]',
    );
    await expect(auxFullPanel).toBeVisible();
    await auxFullPanel
      .getByTestId(`automations-panel-overview-watcher-${ACTIVE_WATCHER_ID}`)
      .click();
    await expect(aux.getByTestId('watcher-management-modal')).toBeVisible();
    await expect(window.getByTestId('watcher-management-modal')).toHaveCount(0);
    await aux.keyboard.press('Escape');
    await expect(aux.getByTestId('watcher-management-modal')).toBeHidden();

    // New, from the pop-out, opens the seeded draft in the main window's
    // Workflows edit shell (CAN-4072) and brings the main window forward.
    const focusRequests = await trackMainWindowFocusRequests(window);
    await auxFullPanel.getByTestId('automations-panel-add').click();
    const draftShell = window.getByTestId('workflow-edit-shell');
    await expect(draftShell).toBeVisible();
    await expect(draftShell).toHaveAttribute('aria-label', 'New automation');
    await expect(aux.getByTestId('workflow-edit-shell')).toHaveCount(0);
    await expect(
      draftShell.getByTestId('automations-form-run-in-existing_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect.poll(focusRequests).toBe(1);
    // The untouched seeded draft is clean, so Back leaves without asking.
    await returnToWorktreeFromShell(window);

    // Merge-back closes the auxiliary page from inside the click handler, so
    // Playwright can lose its target before the click action reports success.
    // That specific rejection is expected; the close assertion below remains
    // the source of truth for whether merge-back completed.
    await aux
      .getByTestId('panel-aux-window-merge-back')
      .click()
      .catch((error) => {
        if (!String(error).includes('has been closed')) {
          throw error;
        }
      });
    await expect.poll(() => aux.isClosed()).toBe(true);
    await expect(fullPanel).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(
      fullPanel.getByTestId(
        `automations-panel-overview-automation-${WS_AUTOMATION_ID}`,
      ),
    ).toBeVisible();
    await toggle.click();

    // --- 4. Upcoming lists the cron automation's future fires; Completed
    // merges the recorded run with the fired watcher.
    await expect(
      fullPanel
        .locator(
          `[data-testid^="automations-panel-upcoming-${WT_AUTOMATION_ID}"]`,
        )
        .first(),
    ).toBeVisible();
    await expect(
      fullPanel.getByTestId(`automations-panel-completed-run:${RUN_ID}`),
    ).toBeVisible();
    await expect(
      fullPanel.getByTestId(
        `automations-panel-completed-watcher:${FIRED_WATCHER_ID}`,
      ),
    ).toBeVisible();

    // --- 5. Entry click opens the automation's Runs section in the
    // Workflows edit shell: its run history in the shared runs list, with no
    // recap of the definition. Its Definition tab holds the edit form.
    await fullPanel
      .getByTestId(`automations-panel-overview-automation-${WT_AUTOMATION_ID}`)
      .click();
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('aria-label', 'Worktree digest');
    await expect(shell.getByTestId('workflow-edit-tab-runs')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const runsSection = shell.getByTestId('automation-runs-section');
    await expect(runsSection).toBeVisible();
    await expect(shell.getByTestId('automation-details-next-run')).toHaveCount(
      0,
    );
    await expect(
      runsSection.locator(`[data-run-key="automation-run:${RUN_ID}"]`),
    ).toBeVisible();
    // Opening reads the automation's own archive past the hot window, one
    // page at a time.
    const runRows = runsSection.getByTestId('workflows-run-row');
    await expect(runRows).toHaveCount(50);
    await runsSection.getByTestId('workflows-runs-load-more').click();
    await expect(
      runsSection.getByTestId('workflows-runs-load-more'),
    ).toHaveCount(0);
    await expect(runRows).toHaveCount(55);
    const definition = await openWorkflowEditSection(window, 'definition');
    await expect(definition.getByTestId('automations-form-name')).toHaveValue(
      'Worktree digest',
    );
    await expect(shell).toHaveAttribute('data-dirty', 'false');
    await returnToWorktreeFromShell(window);

    // --- 6. The add button opens a new draft in the edit shell prefilled
    // to this workspace and worktree: an Existing-chat destination that
    // opens a new chat in this worktree each run.
    await fullPanel.getByTestId('automations-panel-add').click();
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('aria-label', 'New automation');
    // From the main window itself there is nothing to bring forward.
    expect(await focusRequests()).toBe(1);
    await expect(
      shell.getByTestId('automations-form-run-in-existing_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      shell.getByTestId('automations-form-chat-target-worktree'),
    ).toContainText('New Task');
    await expect(
      shell.getByTestId('automations-form-chat-target-chat'),
    ).toContainText('New chat');
    await expect(shell.getByTestId('workflow-edit-tab-runs')).toBeVisible();
    await shell.getByTestId('workflow-edit-tab-runs').click();
    await expect(shell.getByTestId('workflow-edit-no-runs')).toBeVisible();
    await returnToWorktreeFromShell(window);

    // --- 7. The submenu drops the just-added full variant but still offers
    // the others; adding Upcoming mounts its single-section preset.
    await openAutomationsSubmenu(window);
    await expect(
      window.getByTestId('panel-add-menu-item-automations-full'),
    ).toHaveCount(0);
    await window
      .getByTestId('panel-add-menu-item-automations-upcoming')
      .click();
    const upcomingPanel = window.locator(
      '[data-testid="automations-panel"][data-variant="upcoming"]',
    );
    await expect(upcomingPanel).toBeVisible();
    await expect(
      upcomingPanel.locator('[data-testid^="automations-panel-section-"]'),
    ).toHaveCount(0);
    await expect(
      upcomingPanel
        .locator(
          `[data-testid^="automations-panel-upcoming-${WT_AUTOMATION_ID}"]`,
        )
        .first(),
    ).toBeVisible();
    await expect(
      upcomingPanel.getByTestId('automations-panel-worktree-toggle'),
    ).toBeVisible();
    await expect(
      upcomingPanel.getByTestId('automations-panel-add'),
    ).toBeVisible();

    // Each non-singleton panel contributes its own sanitized UI-state entry.
    await expect
      .poll(async () => {
        const response = await getAdvisorUiState(electronApp);
        return response.uiState?.snapshot.automations?.panels
          ?.map((panel) => panel.variant)
          .sort();
      })
      .toEqual(['full', 'upcoming']);

    // App Advisor is represented by a pseudo-workspace that cannot execute a
    // cowork standalone_prompt automation, so its panel must not offer create.
    const app = new CanopyAppDriver(window);
    const advisor = await app.openAppAdvisorWindow(electronApp);
    await openAutomationsSubmenu(advisor);
    await advisor.getByTestId('panel-add-menu-item-automations-full').click();
    const advisorAutomationsPanel = advisor.locator(
      '[data-testid="automations-panel"][data-variant="full"]',
    );
    await expect(advisorAutomationsPanel).toBeVisible();
    await expect(
      advisorAutomationsPanel.getByTestId('automations-panel-add'),
    ).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('automations-panel.png'),
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations panel: failed hydration shows a retry instead of false empty rows', async () => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('automations:list');
      ipcMain.handle('automations:list', () => {
        throw new Error('Injected automations hydration failure.');
      });
    });

    // Reload after replacing the handler so the renderer stores return to
    // their unhydrated initial state before the panel first mounts.
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();

    await openAutomationsSubmenu(window);
    await window.getByTestId('panel-add-menu-item-automations-full').click();
    const panel = window.locator(
      '[data-testid="automations-panel"][data-variant="full"]',
    );
    const loadError = panel.getByTestId('automations-panel-load-error');
    await expect(loadError).toContainText(
      'Injected automations hydration failure.',
    );
    await expect(panel).not.toContainText('No upcoming automation triggers.');

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('automations:list');
      ipcMain.handle('automations:list', () => ({
        activities: [],
        recentRuns: [],
      }));
    });
    await panel.getByTestId('automations-panel-retry').click();
    await expect(loadError).toBeHidden();
    await expect(
      panel.getByTestId('automations-panel-section-overview'),
    ).toBeVisible();
    await expect(panel).toContainText('No automations or watchers match.');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
