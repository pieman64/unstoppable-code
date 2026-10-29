// Shared-plan comment flow helpers (plan workspace panels SC3, SC4, SC9–SC12).
//
// Builds on `sharedPlanOwnerFixture.mjs` and the shared-plan mock route
// (`mock-server/routes/shared-plans.mjs`) without changing either:
//
//   - runtime failure controls for one remote plan: fail (or restore) its
//     detail GET, and drop its open realtime streams like a lost connection;
//   - an owner launched across two demo workspaces, for flows where two local
//     plans (or two worktrees) are involved;
//   - selecting one workspace's `demo-main` worktree when both workspaces have
//     one (`CanopyAppDriver.selectWorktree('demo-main')` would take the first);
//   - reading what a plan's diagram reveals.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import {
  closeCanopy,
  launchCanopy,
  removeTestDataDir,
} from './launchCanopy.mjs';
import { expandDefaultActivityRail } from './panelHarness.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import { DEFAULT_MOCK_BASE_URL } from './seeders/registerScenario.mjs';
import { readSharedPlanRequests } from './seeders/sharedPlanCloud.mjs';
import { seedTrackedPlans } from './seeders/seedTrackedPlans.mjs';

/** The second demo workspace (its worktree is also `demo-main`). */
export const OTHER_WORKSPACE_ID = 'demo-ts-npm-next';

async function sharedPlanControl(apiKey, remoteId, suffix, body) {
  const url = `${DEFAULT_MOCK_BASE_URL.replace(/\/+$/, '')}/__mock/shared-plans/${encodeURIComponent(apiKey)}/${encodeURIComponent(remoteId)}${suffix}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Shared-plan mock control ${url} responded ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

/**
 * Make the remote plan's detail GET answer `getError` (`{ status, body? }`)
 * until it is restored with `null`.
 */
export function setSharedPlanGetFault(apiKey, remoteId, getError) {
  return sharedPlanControl(apiKey, remoteId, '/faults', { getError });
}

/** End the remote plan's open realtime streams, like a dropped connection. */
export function closeSharedPlanStreams(apiKey, remoteId) {
  return sharedPlanControl(apiKey, remoteId, '/streams/close', {});
}

/** The mock's request counters for one remote plan. */
export async function sharedPlanCounters(apiKey, remoteId) {
  const { gets, puts, streamConnections, openStreams } =
    await readSharedPlanRequests(apiKey, remoteId);
  return { gets, puts: puts.length, streamConnections, openStreams };
}

/** Poll until the remote plan's detail GET count is `expected`. */
export async function waitForSharedPlanGets(
  apiKey,
  remoteId,
  expected,
  { timeout = 30_000, message } = {},
) {
  await expect
    .poll(async () => (await readSharedPlanRequests(apiKey, remoteId)).gets, {
      timeout,
      ...(message ? { message } : {}),
    })
    .toBe(expected);
}

/**
 * `launchSharedPlanOwner` across both demo workspaces: `plansByWorkspace`
 * maps a workspace id to the plans seeded into its `demo-main` worktree. The
 * owner launches twice against one data directory so its credential exists
 * when startup enrolls the shared plans for sync and realtime (see
 * `sharedPlanOwnerFixture.mjs`). Release it with `closeSharedPlanOwner`.
 *
 * @param {{
 *   apiKey: string,
 *   plansByWorkspace: Record<string, object[]>,
 *   beforeFirstLaunch?: (context: { userDataDir: string }) => void,
 * }} options
 */
export async function launchSharedPlanOwnerInWorkspaces({
  apiKey,
  plansByWorkspace,
  beforeFirstLaunch,
}) {
  const launchEnv = {
    CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
  };
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-shared-plan-owners-'),
  );
  let demoSeed = null;
  let electronApp;
  try {
    demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite', 'ts-npm-next'],
    });
    beforeFirstLaunch?.({ userDataDir });

    const first = await launchCanopy({ userDataDir, env: launchEnv });
    try {
      const firstWindow = await first.electronApp.firstWindow();
      await new CanopyAppDriver(firstWindow).waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(firstWindow, apiKey);
    } finally {
      await closeCanopy(first.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    for (const [workspaceId, plans] of Object.entries(plansByWorkspace)) {
      seedTrackedPlans({
        userDataDir,
        workspaceId,
        worktreeId: 'demo-main',
        plans,
      });
    }

    const second = await launchCanopy({ userDataDir, env: launchEnv });
    electronApp = second.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    return { electronApp, window, app, userDataDir, demoSeed };
  } catch (error) {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    } else {
      await removeTestDataDir(userDataDir).catch(() => undefined);
      await removeTestDataDir(`${userDataDir}-secure`).catch(() => undefined);
    }
    cleanupDemoWorkspaces(demoSeed);
    throw error;
  }
}

/**
 * Select `workspaceId`'s `demo-main` worktree in the sidebar and wait for its
 * panel grid, like `CanopyAppDriver.selectWorktree` but by workspace.
 */
export async function selectWorkspaceWorktree(window, workspaceId) {
  const row = window
    .locator(
      `[data-testid="worktree-row"][data-project-id="${workspaceId}"][data-worktree-id="demo-main"]`,
    )
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  // The canonical row can sit under a pinned copy of the selected row, so
  // dispatch the click to it directly (see `CanopyAppDriver.selectWorktree`).
  await row.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('Expected a worktree row element');
    }
    element.click();
  });
  await expect(
    window.locator('[data-sidebar-selected-item]').filter({ has: row }),
  ).toHaveCount(1);
  await expect(window.getByTestId('worktree-part')).toBeVisible();
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
  await expandDefaultActivityRail(window, {
    optional: true,
    hydrationTimeout: 2_000,
  });
}

/** Ids of the diagram nodes `scope` currently shows as revealed. */
export function revealedDiagramNodeIds(scope) {
  return scope
    .locator('.react-flow__node')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.querySelector('.ring-2') !== null)
        .map((node) => node.getAttribute('data-id')),
    );
}

/** `[id, author, body, staged]` per comment of one persisted thread. */
export function threadComments(plan, threadId) {
  const thread = plan?.commentThreads?.find(
    (candidate) => candidate.id === threadId,
  );
  return (thread?.comments ?? []).map((comment) => [
    comment.id,
    comment.author,
    comment.body,
    comment.staged === true,
  ]);
}
