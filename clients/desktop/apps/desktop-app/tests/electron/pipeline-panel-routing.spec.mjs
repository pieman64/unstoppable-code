// Phase 03 (pipeline workspace panels — execution panel) routing coverage:
// every live entry point that is NOT the panel-grid placement/reveal
// mechanics already covered by `pipeline-panel-placement.spec.mjs`.
//
//   1. A pipeline completion/failure/pause toast never navigates merely by
//      arriving; clicking it navigates to the run's OWNING worktree (from
//      another page, and from another worktree) and opens its panel.
//   2. A run owned by a Cowork Work Entry opens in that exact entry's Cowork
//      layout, not the selected Code worktree.
//   3. App Advisor's `pipeline.open_run` action (dispatched over the real
//      `app-advisor:tool-request`/`app-advisor:tool-response` IPC envelope,
//      the same wire shape `show-files-existing-tab.spec.mjs` and
//      `worktree-panels-tabs.spec.mjs` use to drive it in isolation) resolves
//      successfully only once the panel is actually revealed, and returns a
//      structured `not_found` for a missing execution without creating a
//      tab.
//   4. An ownerless run (no `project_id`/`worktree_id`) opens in the
//      app-level `pipeline-execution-compat-host`, never a workspace panel.
//   5. A stale open is superseded: opening run A and then, before it
//      resolves, run B leaves focus on B and never lets A's slower
//      resolution steal it back.
//
// Overview's "mark seen and open at the job" entry point is NOT covered here:
// its pipeline projection (`pipelineSummariesByWorktree`) is derived overview
// aggregation state, not something these file-fixture seeders can produce
// deterministically without a live run — see the skipped placeholder test
// below for the recorded reason.
//
// Determinism: seeded executions/chats/cowork fixtures, injected execution
// events for toast routing, and the E2E panel test API's real opener
// (`openPipelineExecution`) for entry points with no UI yet. No live agents,
// no network, no PTY, no fixed sleeps.

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { injectPipelineExecutionEvent } from './seeders/injectPipelineExecutionEvent.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { expectPipelineRunPanel } from './pipelineUi.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const OTHER_WORKSPACE_ID = 'demo-go-cli';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Selects a worktree row scoped to `projectId`, avoiding branch-name collisions across workspaces. */
async function selectWorktreeInProject(window, projectId, worktreeId) {
  const row = window.locator(
    `[data-testid="worktree-row"][data-project-id="${projectId}"][data-worktree-id="${worktreeId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const selectedRowFrame = window
    .locator('[data-sidebar-selected-item]')
    .filter({ has: row });
  await expect(selectedRowFrame).toHaveCount(1);
}

/**
 * Delivers the exact IPC envelope App Advisor's tool runtime sends the main
 * window (`app-advisor:tool-request` / `app-advisor:tool-response`), the
 * same pattern `worktree-panels-tabs.spec.mjs` (`dispatchCursorUsage`) and
 * `show-files-existing-tab.spec.mjs` use to drive one action in isolation.
 * Only the response sink is replaced in this ephemeral app; the preload,
 * bridge, dispatcher, and the real opener all run production code.
 */
async function dispatchAppAdvisorAction(electronApp, action, requestId) {
  return electronApp.evaluate(
    ({ BrowserWindow, ipcMain }, { id, action: dispatchedAction }) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ipcMain.removeHandler(responseChannel);
          reject(new Error('App Advisor action did not respond'));
        }, 15_000);
        ipcMain.handleOnce(responseChannel, (_event, response) => {
          clearTimeout(timer);
          resolve(response);
        });
        mainWindow.webContents.send(requestChannel, {
          requestId: id,
          kind: 'dispatch_action',
          action: dispatchedAction,
        });
      });
    },
    { id: requestId, action },
  );
}

test.describe('toast routing', () => {
  const TOAST_CASES = [
    {
      name: 'success',
      type: 'execution.completed',
      status: 'success',
      toastText: 'completed',
      from: 'page',
    },
    {
      name: 'failure',
      type: 'execution.failed',
      status: 'failure',
      toastText: 'failed',
      from: 'worktree',
    },
    {
      name: 'paused',
      type: 'execution.paused',
      status: 'paused',
      toastText: 'paused',
      from: 'page',
    },
  ];

  for (const toastCase of TOAST_CASES) {
    test(`clicking a ${toastCase.name} toast from another ${toastCase.from} opens the run in its owning worktree`, async () => {
      test.setTimeout(150_000);
      const EXECUTION_ID = `e2e-toast-${toastCase.name}`;
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), `canopy-pipeline-toast-${toastCase.name}-`),
      );
      const apps =
        toastCase.from === 'worktree'
          ? ['ts-pnpm-vite', 'go-cli']
          : ['ts-pnpm-vite'];
      seedDemoWorkspaces({ userDataDir, apps });
      const { state } = seedPipelineExecution({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: {
          id: EXECUTION_ID,
          pipelineName: `Toast ${toastCase.name} pipeline`,
          status: toastCase.status,
        },
      });

      const { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();

        if (toastCase.from === 'page') {
          await app.openOverviewPage();
          await expect(window.getByTestId('overview-page')).toBeVisible();
        } else {
          await selectWorktreeInProject(
            window,
            OTHER_WORKSPACE_ID,
            WORKTREE_ID,
          );
        }

        await injectPipelineExecutionEvent(electronApp, {
          state,
          type: toastCase.type,
        });

        const toast = window
          .getByTestId('toast-card')
          .filter({ hasText: toastCase.toastText });
        await expect(toast).toBeVisible({ timeout: 15_000 });
        await toast.click();

        await expectPipelineRunPanel(window, EXECUTION_ID);
        await expect(
          window.getByTestId('pipeline-execution-detail'),
        ).toBeVisible();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('receiving a pipeline toast never navigates on its own', async () => {
    test.setTimeout(150_000);
    const EXECUTION_ID = 'e2e-toast-no-navigate';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-pipeline-toast-no-navigate-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const { state } = seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: EXECUTION_ID,
        pipelineName: 'No Navigate Pipeline',
        status: 'success',
      },
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.openOverviewPage();
      await expect(window.getByTestId('overview-page')).toBeVisible();

      await injectPipelineExecutionEvent(electronApp, {
        state,
        type: 'execution.completed',
      });
      const toast = window
        .getByTestId('toast-card')
        .filter({ hasText: 'completed' });
      await expect(toast).toBeVisible({ timeout: 15_000 });

      // Merely receiving it never navigates or opens the panel.
      await expect(window.getByTestId('overview-page')).toBeVisible();
      await expect(window.getByTestId('pipeline-execution-panel')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

test('a run owned by a Cowork Work Entry opens in that exact entry’s Cowork layout', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-cowork-owned';
  const COWORK_WORKSPACE_ID = 'cowork-routing';
  const ENTRY_ID = 'routing-entry';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-cowork-routing-'),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  expect(demoSeed.ok).toBe(true);

  // Append a cowork workspace + one Work Entry beside the already-seeded
  // code workspace (mirrors `cowork-panels-grid.spec.mjs`'s fixture, merged
  // onto the existing `workspaces/index.json` instead of overwriting it).
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const existingIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  writeJson(indexPath, {
    ...existingIndex,
    workspaces: [
      ...existingIndex.workspaces,
      {
        id: COWORK_WORKSPACE_ID,
        name: 'Routing Cowork',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: existingIndex.workspaces.length,
        cowork: {
          createdAt: '2026-06-01T10:00:00.000Z',
          archiveRetentionDays: null,
        },
      },
    ],
  });
  const coworkDir = path.join(userDataDir, 'workspaces', COWORK_WORKSPACE_ID);
  writeJson(path.join(coworkDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: ENTRY_ID, createdAt: '2026-06-01T10:00:00.000Z' }],
  });
  writeJson(path.join(coworkDir, 'chats', `${ENTRY_ID}.json`), {
    version: 1,
    activeTabId: 'routing-entry-chat',
    tabs: [
      {
        id: 'routing-entry-chat',
        title: 'Routing entry chat',
        description: 'Routing entry chat',
        createdAt: '2026-06-01T10:00:00.000Z',
        messages: [
          {
            id: 'routing-entry-chat-m1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Run the pipeline here.' }],
            timestamp: Date.parse('2026-06-01T10:00:30.000Z'),
          },
        ],
      },
    ],
  });

  seedPipelineExecution({
    userDataDir,
    workspaceId: COWORK_WORKSPACE_ID,
    worktreeId: ENTRY_ID,
    execution: { id: EXECUTION_ID, pipelineName: 'Cowork Routing Pipeline' },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    // Start on the CODE worktree so the test API is installed and the run
    // opens across an actual page/layout transition, not from an
    // already-mounted Cowork grid.
    await app.selectWorktree(WORKTREE_ID, { expandDefaultActivityRail: false });
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => Boolean(window.__canopyPanelTestApi)), {
        timeout: 15_000,
      })
      .toBe(true);

    const result = await window.evaluate(
      (id) =>
        window.__canopyPanelTestApi.openPipelineExecution({ executionId: id }),
      EXECUTION_ID,
    );
    expect(result.status).toBe('applied');
    expect(result.ownerKey).toBe(`${COWORK_WORKSPACE_ID}/${ENTRY_ID}`);

    // Navigation landed on the Cowork page, in the exact entry.
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    await expectPipelineRunPanel(window, EXECUTION_ID);
    await expect(window.getByTestId('pipeline-execution-detail')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test.describe('App Advisor pipeline.open_run', () => {
  test('resolves successfully only after the panel is actually revealed', async () => {
    test.setTimeout(150_000);
    const EXECUTION_ID = 'e2e-advisor-open-run';
    let seeded = null;
    const { electronApp, userDataDir, window } = await seedPanelWorktree({
      onBeforeLaunch: ({ userDataDir: dir }) => {
        seeded = seedPipelineExecution({
          userDataDir: dir,
          workspaceId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          execution: { id: EXECUTION_ID, pipelineName: 'Advisor Open Run' },
        });
      },
    });
    if (seeded === null) throw new Error('pipeline execution was not seeded');
    try {
      const response = await dispatchAppAdvisorAction(
        electronApp,
        { type: 'pipeline.open_run', executionId: EXECUTION_ID },
        'advisor-open-run-1',
      );
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        host: 'panel',
        ownerKey: `${WORKSPACE_ID}/${WORKTREE_ID}`,
      });

      // The underlying store mutations that reveal the panel (navigation,
      // placement/reveal) already ran synchronously inside the awaited
      // action; only React's own commit is still pending. Assert with a
      // short bound (not the suite's normal 15s) so this stays a meaningful
      // "already revealed, not merely eventually" check rather than a
      // generic wait.
      await expect(
        window.locator(
          `[data-testid="pipeline-execution-panel"][data-execution-id="${EXECUTION_ID}"]`,
        ),
      ).toHaveAttribute('data-detail-state', 'active', { timeout: 1_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('returns a structured not_found for a missing execution, without creating a tab', async () => {
    test.setTimeout(150_000);
    const { electronApp, userDataDir, window } = await seedPanelWorktree();
    try {
      const response = await dispatchAppAdvisorAction(
        electronApp,
        { type: 'pipeline.open_run', executionId: 'does-not-exist' },
        'advisor-open-run-missing',
      );
      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({ code: 'not_found' });
      await expect(window.getByTestId('pipeline-execution-panel')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

test('an ownerless run opens in the app-level compatibility host', async () => {
  test.setTimeout(150_000);
  const EXECUTION_ID = 'e2e-ownerless';
  let seeded = null;
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      // No workspaceId/worktreeId: the persisted state carries neither
      // `project_id` nor `worktree_id`.
      seeded = seedPipelineExecution({
        userDataDir: dir,
        execution: { id: EXECUTION_ID, pipelineName: 'Ownerless Pipeline' },
      });
    },
  });
  if (seeded === null) throw new Error('pipeline execution was not seeded');
  try {
    const result = await window.evaluate(
      (id) =>
        window.__canopyPanelTestApi.openPipelineExecution({ executionId: id }),
      EXECUTION_ID,
    );
    expect(result.status).toBe('ownerless');
    expect(result.reason).toBe('no-owner');

    const host = window.getByTestId('pipeline-execution-compat-host');
    await expect(host).toBeVisible({ timeout: 15_000 });
    await expect(host.getByTestId('pipeline-details-nav')).toBeVisible();
    // Never acquired a workspace panel tab.
    await expect(window.getByTestId('pipeline-execution-panel')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a stale open is superseded by a newer one; the older run never steals focus back', async () => {
  test.setTimeout(150_000);
  const EXECUTION_A = 'e2e-supersede-a';
  const EXECUTION_B = 'e2e-supersede-b';
  const { electronApp, userDataDir, window } = await seedPanelWorktree({
    onBeforeLaunch: ({ userDataDir: dir }) => {
      seedPipelineExecution({
        userDataDir: dir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: { id: EXECUTION_A, pipelineName: 'Supersede A' },
      });
      seedPipelineExecution({
        userDataDir: dir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: { id: EXECUTION_B, pipelineName: 'Supersede B' },
      });
    },
  });
  try {
    // Both opens are issued in the SAME synchronous browser turn: the
    // opener's `open()` records the newest request's token/id SYNCHRONOUSLY
    // (before either request's first internal `await`), so calling it twice
    // back-to-back deterministically makes B "latest" the instant it is
    // called — regardless of whether A's owner read resolves from cache or a
    // real IPC round trip. A's slower resolution must see it is stale and
    // resolve `superseded` without ever touching focus or placement.
    const [resultA, resultB] = await window.evaluate(
      ({ a, b }) => {
        const api = window.__canopyPanelTestApi;
        const pendingA = api.openPipelineExecution({ executionId: a });
        const pendingB = api.openPipelineExecution({ executionId: b });
        return Promise.all([pendingA, pendingB]);
      },
      { a: EXECUTION_A, b: EXECUTION_B },
    );
    expect(resultA.status).toBe('error');
    expect(resultA.code).toBe('superseded');
    expect(resultB.status).toBe('applied');

    // B is shown; A never acquired a tab at all.
    await expectPipelineRunPanel(window, EXECUTION_B);
    const panelA = window.locator(
      `[data-testid="pipeline-execution-panel"][data-execution-id="${EXECUTION_A}"]`,
    );
    await expect(panelA).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Overview's row/job open ("mark seen, open at the job") is not covered here.
// Its pipeline projection (`pipelineSummariesByWorktree` in
// `OverviewPage.tsx`) is derived overview-aggregation state built from the
// live pipeline runs store's cross-worktree summaries plus "hidden count"
// bookkeeping that only a real dispatched/observed run populates; there is
// no file-fixture seeder for it (unlike `seedPipelineExecution`, which only
// seeds the persisted execution the runs list/detail read from). Reaching a
// deterministic Overview row would require either a live pipeline dispatch
// or new production seeding surface, both out of scope for this harness-only
// change. Skipped rather than faked.
test.skip('Overview row/job open marks seen and opens the panel at the job', () => {});
