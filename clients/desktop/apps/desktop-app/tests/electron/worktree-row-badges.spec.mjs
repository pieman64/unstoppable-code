import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedScriptRun } from './seeders/seedScriptRun.mjs';
import { seedWatchers, seedWorktreeChat, writeJson } from './seeders/index.mjs';
import {
  injectScriptRunEvent,
  injectScriptCompleteEvent,
} from './seeders/injectScriptRunEvent.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Doc 2 — Spec 8b: worktree-row status badges + stale-run popover (PR 794).
//
// The worktree-row badge cluster (rocket script badge, hook badge, pipeline
// badge, terminal badge, PR badge, unread badge) lives in
// `packages/ui-shared/src/components/WorktreeRow.tsx` (testids:
// `worktree-row-script-badge`, `-hook-badge`, `-pipeline-badge`,
// `-terminal-badge`, `-pr-badge`, `-unread`) and is wired from
// `apps/desktop-app/src/renderer/src/components/worktree/WorktreeItem.tsx`.
//
// FINDING — a seeded RUNNING script-run snapshot does NOT light up the rocket
// badge, neither at launch nor on worktree selection. Two layers conspire:
//
//   1. Store hydration is selection-gated. `WorktreeItem` derives
//      `hasRunningScript` from `useScriptsStore().runs[wtKey]`
//      (wtKey = `${projectId}/${worktreeId}`). The store starts empty;
//      persisted snapshots are backfilled only by `loadWorktreeRuns`
//      (scriptsStore.ts), which `ActivityPanel.tsx` calls solely when a
//      worktree is selected. There is no startup all-worktree hydration.
//
//   2. STALE-RUN RECONCILIATION (the PR 794 behavior). Even once selected, the
//      backfill IPC (`loadWorktreeScriptRuns` ->
//      `scripts-service.ts:resolveScriptRunLogStatus`) downgrades any persisted
//      `running` run to `cancelled` when no live tracked shell process exists
//      (`isTrackedShellScriptRunning` is false for a seeded snapshot — there is
//      no real OS process). So the snapshot arrives in the renderer as
//      `cancelled`, `isScriptRunActive` is false, `sharedScriptStatus` stays
//      `undefined`, and the badge never renders.
//
// What that means for this spec: lighting up the live rocket badge + its
// "Scripts running" popover requires a RUNTIME script-event injection (a live
// `scriptStarted`/`scriptOutput` IPC sequence from the main process that
// registers a tracked shell run), for which the harness has no app seam today.
// A seeded-disk snapshot cannot reach that state by design.
//
// This spec therefore asserts what IS reachable from seeded state, without
// faking a passing badge assertion:
//   - the worktree row renders and is selectable;
//   - on a clean seed, the entire badge cluster is ABSENT (negative baseline
//     pinning all six badge testids);
//   - the seeded `running` script-run snapshot IS persisted and read back, but
//     the main-process stale-run reconciliation reports it as `cancelled`
//     (the PR 794 behavior), which is exactly why the badge stays absent;
//   - with no active run, the `worktree-row-script-popover` is not rendered.
//
// Determinism: no live agents, no network, no PTY, no live script execution.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const BADGE_TESTIDS = [
  'worktree-row-script-badge',
  'worktree-row-hook-badge',
  'worktree-row-pipeline-badge',
  'worktree-row-terminal-badge',
  'worktree-row-pr-badge',
  'worktree-row-unread',
];

const WATCHER_CHAT_ID = 'idle-watcher-chat';

function idleWorktreeWatcher({
  id = 'seeded-idle-chat-watcher',
  label = 'Seeded idle chat watcher',
  status = 'active',
} = {}) {
  return {
    id,
    label,
    status,
    trigger: 'worktree_chat_completion',
    target: {
      kind: 'worktree_chat',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: WATCHER_CHAT_ID,
      chatTitle: 'Release follow-up',
    },
    destination: {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: WATCHER_CHAT_ID,
      chatTitle: 'Release follow-up',
    },
  };
}

function seedIdleWorktreeWatchers(
  userDataDir,
  watchers = [idleWorktreeWatcher()],
) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: WATCHER_CHAT_ID,
        title: 'Release follow-up',
        providerType: 'codex',
      },
    ],
  });
  seedWatchers({
    userDataDir,
    watchers,
  });
}

test.describe('idle watcher worktree-row indicator', () => {
  test('opens its chat popover on hover and focus and dismisses on Escape and blur', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-wt-idle-watchers-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedIdleWorktreeWatchers(userDataDir);

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      const indicator = row.getByTestId('worktree-row-watchers');
      const heading = window.getByText('Chats with Watchers', { exact: true });

      await expect(indicator).toBeVisible({ timeout: 10_000 });
      await indicator.hover();
      await expect(heading).toBeVisible();
      await expect(window.getByText('1 watcher registered')).toBeVisible();
      await row.hover();
      await expect(heading).toHaveCount(0);

      await indicator.focus();
      await expect(heading).toBeVisible();
      await indicator.press('Escape');
      await expect(heading).toHaveCount(0);

      await indicator.focus();
      await expect(heading).toBeVisible();
      await indicator.evaluate((element) => element.blur());
      await expect(heading).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('clears after the last active watcher is deleted while retaining failed diagnostics in history', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-wt-cleared-watchers-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const activeWatcherId = 'seeded-active-chat-watcher';
    const failedWatcherId = 'seeded-failed-chat-watcher';
    seedIdleWorktreeWatchers(userDataDir, [
      idleWorktreeWatcher({ id: activeWatcherId }),
      idleWorktreeWatcher({
        id: failedWatcherId,
        label: 'Failed diagnostic watcher',
        status: 'delivery_failed',
      }),
    ]);

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      const indicator = row.getByTestId('worktree-row-watchers');
      await expect(indicator).toBeVisible({ timeout: 10_000 });
      await indicator.hover();
      await expect(window.getByText('1 watcher registered')).toBeVisible();

      const deleteResult = await window.evaluate(
        async (watcherId) => window.api.appAdvisor.deleteWatcher(watcherId),
        activeWatcherId,
      );
      expect(deleteResult).toEqual({ ok: true });
      await expect(indicator).toHaveCount(0);

      const snapshots = await window.evaluate(async () => {
        const [active, completed] = await Promise.all([
          window.api.appAdvisor.listWatchers(),
          window.api.appAdvisor.listCompletedWatchers(),
        ]);
        return { active, completed };
      });
      expect(snapshots.active.map((watcher) => watcher.id)).not.toContain(
        failedWatcherId,
      );
      expect(snapshots.completed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: failedWatcherId,
            label: 'Failed diagnostic watcher',
            status: 'delivery_failed',
          }),
        ]),
      );

      // Runs lists finished watchers too: the failed one stays as history,
      // and the deleted active one is gone.
      await app.openWatchersPage();
      await expect(app.workflowsWatcherRunRow(failedWatcherId)).toHaveAttribute(
        'data-run-status',
        'delivery-failed',
      );
      await expect(app.workflowsWatcherRunRow(activeWatcherId)).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('stays visible on a done worktree and outranks the checkmark fallback', async () => {
    // Done is the quiet-state fallback, not an override: with idle watcher
    // chats and nothing higher-priority active, the watcher icon is still
    // promoted into the leading slot on a done row and the purple checkmark
    // yields (see docs/sidebar-worktree-status.md).
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-wt-done-watchers-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedIdleWorktreeWatchers(userDataDir);
    markWorktreeDone(userDataDir);

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();
      await expect(row.getByTestId('worktree-row-watchers')).toBeVisible({
        timeout: 10_000,
      });
      // The promoted watcher icon owns the leading slot; the done checkmark
      // (aria-labelled with the done label) is not rendered.
      await expect(row.locator('[aria-label="Done"]')).toHaveCount(0);
      // The subtitle still carries the purple Done label, so completion
      // stays visible while the watcher icon wins the slot.
      await expect(row).toContainText('Done');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('done rows keep attention dots; the checkmark is the quiet-state fallback', async () => {
    // Durable regression coverage for the done-fallback indicator change:
    // a done worktree with a pending question and unread chats keeps the
    // question glyph + orange dot (the checkmark yields), while a done
    // worktree with nothing else active falls back to the checkmark.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-wt-done-dots-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    markWorktreeDone(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      tabs: [
        { id: 'done-question-chat', title: 'Release checklist' },
        { id: 'done-unread-chat', title: 'Changelog draft', unread: true },
      ],
      pendingQuestions: [
        {
          requestId: 'done-question-request',
          chatId: 'done-question-chat',
          questions: [
            {
              header: 'Release',
              question: 'Tag the release now?',
              options: ['Yes', 'Wait'],
              multiSelect: false,
            },
          ],
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();
      // The waiting question claims both the leading glyph and the trailing
      // orange dot on the done row.
      await expect(row.getByTestId('worktree-row-question-glyph')).toBeVisible({
        timeout: 10_000,
      });
      await expect(row.getByTestId('worktree-row-question')).toBeVisible();
      await expect(row.locator('[aria-label="Done"]')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

/** Flip the demo worktree's persisted status to done before launch. */
function markWorktreeDone(userDataDir) {
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees.json',
  );
  const worktreesConfig = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  worktreesConfig.worktrees = worktreesConfig.worktrees.map((worktree) =>
    worktree.id === WORKTREE_ID ? { ...worktree, status: 'done' } : worktree,
  );
  writeJson(worktreesPath, worktreesConfig);
}

test.describe('worktree-row badges (Spec 8b / PR 794)', () => {
  test('renders the row, keeps the badge cluster absent on a clean seed, and reconciles a seeded running script-run to cancelled (stale-run)', async () => {
    // Two-phase seeding: build an isolated CANOPY_DATA_DIR, seed the demo
    // workspace + worktree, then seed a persisted RUNNING script-run snapshot
    // into it BEFORE launching the app.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-wt-badges-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const seeded = seedScriptRun({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      status: 'running',
    });
    // The on-disk snapshot is persisted as `running` (active dev server).
    expect(seeded.meta.status).toBe('running');

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      // Baseline: at launch the store is empty (selection-gated hydration) and
      // the seed has no hooks/pipelines/terminals/PRs/unread chats, so the
      // entire badge cluster is absent. Pins all six badge testids.
      for (const id of BADGE_TESTIDS) {
        await expect(window.getByTestId(id)).toHaveCount(0);
      }

      // Select the worktree. This mounts ActivityPanel, whose effect calls
      // `loadWorktreeRuns`, triggering the backfill IPC for this worktree.
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // The backfill IPC reads the seeded snapshot but the main-process
      // stale-run reconciliation downgrades the persisted `running` status to
      // `cancelled` (PR 794) because no live tracked shell process exists for a
      // seeded snapshot. Assert that directly via the same IPC the store uses.
      const snapshots = await window.evaluate(
        async ({ projectId, worktreeId }) =>
          window.api.loadWorktreeScriptRuns({
            projectId,
            worktreeId,
            maxLines: 200,
          }),
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].script.scriptKey).toBe('launch:project');
      // The persisted-disk status was `running`; the reconciled snapshot is
      // `cancelled` — the stale-run behavior under test.
      expect(snapshots[0].status).toBe('cancelled');

      // Because the reconciled run is not active, `sharedScriptStatus` stays
      // undefined: the rocket badge is NOT rendered even after selection, and
      // with no active run the hover popover slot is never produced.
      await expect(window.getByTestId('worktree-row-script-badge')).toHaveCount(
        0,
      );
      await expect(
        window.getByTestId('worktree-row-script-popover'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // The complement of the test above: a LIVE `script:started` event lights the
  // rocket badge. This is exactly the path a seeded-disk snapshot canNOT reach
  // (it gets reconciled to `cancelled`). `injectScriptRunEvent` emits the same
  // `script:started` IPC event the main-process script runner broadcasts, which
  // drives `scriptsStore.startRunFromEvent` -> a `running` run keyed by
  // `${projectId}/${worktreeId}` -> `script.scriptKey`. In `WorktreeItem.tsx`
  // that makes `hasRunningScript` true, `sharedScriptStatus = 'running'`, and
  // the shared `WorktreeRow` renders `worktree-row-script-badge`.
  //
  // CRITICAL PRECONDITION (see injectScriptRunEvent.mjs header):
  // `startRunFromEvent` is gated on `loadedWorktreeKeys`, which is populated
  // only after the worktree is SELECTED (mounting ActivityPanel ->
  // `loadWorktreeRuns`). So this test selects the worktree BEFORE injecting,
  // otherwise the event is silently dropped.
  test('lights the rocket script badge + popover from a live script:started event and clears it on completion', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-wt-badges-live-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      // Baseline: no script run yet, the rocket badge is absent.
      await expect(window.getByTestId('worktree-row-script-badge')).toHaveCount(
        0,
      );

      // REQUIRED: select the worktree first so its scripts are loaded
      // (`loadedWorktreeKeys` gate) before injecting the live event.
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // Inject a live RUNNING script event (a dev-server launch script) plus an
      // output line. This bypasses disk reconciliation and registers an active
      // run directly in `scriptsStore`.
      const { script } = await injectScriptRunEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        script: {
          scriptKey: 'launch:project',
          scriptName: 'launch',
          label: 'Dev Server',
          command: 'npm run dev',
          lifecycle: 'launch',
          target: 'project',
        },
        invocation: 'manual-lifecycle',
        outputLines: ['VITE ready in 312 ms', 'Local: http://localhost:5173/'],
      });

      // CORE SIGNAL: the lit rocket badge appears on the worktree row. It only
      // renders when `sharedScriptStatus === 'running'` (driven by the live
      // injected run), which is precisely the gap a seeded snapshot can't close.
      const scriptBadge = window.getByTestId('worktree-row-script-badge');
      await expect(scriptBadge).toBeVisible({ timeout: 10_000 });
      // The shared WorktreeRow labels the running script badge "Scripts running".
      await expect(scriptBadge).toHaveAttribute(
        'aria-label',
        'Scripts running',
      );

      // Popover: it is hover/focus-gated (`scriptHoverRect && hasRunningScript`)
      // and rendered via a portal into document.body with testid
      // `worktree-row-script-popover`. Hover the badge to surface it, then
      // assert its "Scripts running" heading + the injected run's label row.
      await scriptBadge.hover();
      const scriptPopover = window.getByTestId('worktree-row-script-popover');
      await expect(scriptPopover).toBeVisible({ timeout: 10_000 });
      await expect(scriptPopover).toContainText('Scripts running');
      // RunBadgePopover renders one row per active run using `run.label`.
      await expect(scriptPopover).toContainText(script.label);

      // The live Scripts activity ribbon exposes the detected dev-server URL
      // as an accessible Open button with the shared globe icon. Activating it
      // routes the loopback URL into the standalone Browser panel.
      const openDevServerButton = window.getByRole('button', {
        name: 'Open dev server http://localhost:5173/',
      });
      await expect(openDevServerButton).toBeVisible();
      await expect(openDevServerButton.locator('svg')).toHaveAttribute(
        'aria-hidden',
        'true',
      );
      await openDevServerButton.click();
      await expect(window.getByTestId('panel-content-browser')).toBeVisible();
      await expect(window.getByTestId('browser-url-input')).toHaveValue(
        'http://localhost:5173/',
      );

      // Move the pointer off the badge so the hover popover hides before we
      // assert the badge clears (the popover unmounts when there is no active
      // run regardless, but this keeps the post-completion assertions tight).
      await row.hover();

      // Complete the run. `injectScriptCompleteEvent` drives
      // `scriptsStore.completeRunFromEvent`, transitioning the active run to
      // `success`, so `hasRunningScript` becomes false and the badge clears.
      await injectScriptCompleteEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        script: {
          scriptKey: 'launch:project',
          scriptName: 'launch',
          label: 'Dev Server',
          lifecycle: 'launch',
          target: 'project',
        },
        invocation: 'manual-lifecycle',
        success: true,
      });

      await expect(window.getByTestId('worktree-row-script-badge')).toHaveCount(
        0,
        { timeout: 10_000 },
      );
      await expect(
        window.getByTestId('worktree-row-script-popover'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
