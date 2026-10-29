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
import { seedTrackedPlans } from './seeders/index.mjs';

const WORKTREE_ID = 'demo-main';
const CREATED_AT = '2026-07-27T12:00:00.000Z';
const DRAFT = 'Plan bootstrap keeps every startup keystroke.';
const SHARED_REMOTE_ID = '33333333-3333-4333-8333-333333333333';

const WORKSPACES = [
  {
    appId: 'ts-npm-next',
    id: 'demo-ts-npm-next',
    sharedPlanId: 'next-shared-plan',
    sharedTitle: 'Next shared startup plan',
    localPlanId: 'next-local-plan',
    localTitle: 'Next local startup plan',
  },
  {
    appId: 'ts-pnpm-vite',
    id: 'demo-ts-pnpm-vite',
    sharedPlanId: 'vite-shared-plan',
    sharedTitle: 'Vite shared startup plan',
    localPlanId: 'vite-local-plan',
    localTitle: 'Vite local startup plan',
  },
];

function makePlan(workspace, shared) {
  const id = shared ? workspace.sharedPlanId : workspace.localPlanId;
  const title = shared ? workspace.sharedTitle : workspace.localTitle;
  return {
    id,
    projectId: workspace.id,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title,
    content: `# ${title}\n\nStartup plan bootstrap fixture.`,
    reviewStatus: 'pending',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content: `# ${title}\n\nStartup plan bootstrap fixture.`,
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: CREATED_AT,
      },
    ],
    linkedExecutionIds: [],
    ...(shared
      ? {
          share: {
            serverId: 'canopy-cloud',
            // Both worktrees deliberately reference one remote plan. Startup
            // must preserve both local tuples while deduplicating realtime by
            // remote id.
            remoteId: SHARED_REMOTE_ID,
            shareScope: 'private',
            syncStatus: 'synced',
            lastSyncedAt: CREATED_AT,
            lastSyncedLocalRevisionNumber: 1,
            lastSyncedRemoteRevisionNumber: 1,
            lastSyncedSnapshotHash: 'e2e-startup-snapshot',
          },
        }
      : {}),
  };
}

function worktreeRow(window, workspaceId) {
  return window.locator(
    `[data-testid="worktree-row"][data-project-id="${workspaceId}"][data-worktree-id="${WORKTREE_ID}"]`,
  );
}

test('startup plan bootstrap preserves shared/local rows across worktrees and remains responsive', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-startup-plan-bootstrap-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: WORKSPACES.map((workspace) => workspace.appId),
  });
  for (const workspace of WORKSPACES) {
    seedTrackedPlans({
      userDataDir,
      workspaceId: workspace.id,
      worktreeId: WORKTREE_ID,
      plans: [makePlan(workspace, true), makePlan(workspace, false)],
    });
  }

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const editor = window
      .getByTestId('page-home')
      .getByTestId('home-composer-editor');
    await editor.click();
    await editor.pressSequentially(DRAFT, { delay: 15 });
    await expect(editor).toContainText(DRAFT);

    await app.openMainPage();
    for (const workspace of WORKSPACES) {
      const row = worktreeRow(window, workspace.id);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();

      const plansSection = window.getByTestId('activity-plans-section');
      await expect(plansSection).toBeVisible({ timeout: 30_000 });
      await expect(
        window.getByTestId(`activity-plan-row-${workspace.sharedPlanId}`),
      ).toContainText(workspace.sharedTitle);
      await expect(
        window.getByTestId(`activity-plan-row-${workspace.localPlanId}`),
      ).toContainText(workspace.localTitle);

      // Read through the same preload/IPC boundary that populated the UI. A
      // cloud credential is intentionally absent, so startup may transition
      // the shared row to an error status, but it must retain the remote
      // identity while the local-only row remains unshared.
      const plans = await window.evaluate(
        async ({ projectId, worktreeId }) =>
          window.api.activity.plans.list({ projectId, worktreeId }),
        { projectId: workspace.id, worktreeId: WORKTREE_ID },
      );
      expect(
        plans.find((plan) => plan.id === workspace.sharedPlanId)?.share
          ?.remoteId,
      ).toBe(SHARED_REMOTE_ID);
      expect(
        plans.find((plan) => plan.id === workspace.localPlanId)?.share,
      ).toBeUndefined();
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(seed);
  }
});
