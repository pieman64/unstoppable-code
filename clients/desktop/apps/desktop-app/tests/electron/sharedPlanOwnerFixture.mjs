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
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/registerScenario.mjs';
import { readSharedPlanRequests } from './seeders/sharedPlanCloud.mjs';
import { seedTrackedPlans } from './seeders/seedTrackedPlans.mjs';
import { SEEDED_SHARED_PLAN_SNAPSHOT_HASH } from './seeders/trackedPlanFixtures.mjs';

/**
 * Launch a desktop owner whose shared plans are live from startup.
 *
 * The shared-plan realtime subscription is created once, at startup, from the
 * tracked-plan inventory. Without a cloud credential at that moment it stops
 * quietly and is not revived by a later sign-in, so a spec that connects the
 * account after launch never receives `plan.detail` signals. The owner is
 * therefore launched twice against one data directory:
 *
 *   1. launch, connect the mock cloud account (the key persists in
 *      `${userDataDir}-secure`), and close while keeping the data;
 *   2. seed the tracked plans while the app is closed;
 *   3. launch again, so startup sync and realtime run with credentials.
 *
 * Other local state the owner needs goes in `beforeFirstLaunch`, which runs
 * once, after the demo workspaces are seeded and before the first launch.
 * Chat tabs must be seeded there, not between the launches: the first launch
 * already reads every worktree's chats, which moves them into canonical chat
 * storage, and a legacy chat file written after that is never read again.
 *
 * Register the shared-plan scenario for `apiKey` first
 * (`registerSharedPlanScenario`). Release everything with
 * `closeSharedPlanOwner`, which also clears the scenario.
 */

export const SHARED_PLAN_OWNER_WORKSPACE_ID = 'demo-ts-pnpm-vite';
export const SHARED_PLAN_OWNER_WORKTREE_ID = 'demo-main';

/**
 * @param {{
 *   apiKey: string,
 *   workspaceId?: string,
 *   worktreeId?: string,
 *   plans: object[],
 *   beforeFirstLaunch?: (context: { userDataDir: string }) => void,
 *   env?: Record<string, string>,
 *   viewportSize?: { width: number, height: number },
 *   recordVideoDir?: string,
 * }} options
 */
export async function launchSharedPlanOwner({
  apiKey,
  workspaceId = SHARED_PLAN_OWNER_WORKSPACE_ID,
  worktreeId = SHARED_PLAN_OWNER_WORKTREE_ID,
  plans,
  beforeFirstLaunch,
  env,
  viewportSize,
  recordVideoDir,
}) {
  if (typeof apiKey !== 'string' || !apiKey.startsWith('csk_')) {
    throw new Error('launchSharedPlanOwner requires a csk_ mock cloud key');
  }
  if (!Array.isArray(plans)) {
    throw new Error('launchSharedPlanOwner requires plans');
  }
  // The E2E build bakes the default mock origin as its cloud URL. Point the
  // owner at the mock these helpers drive, so a run isolated with
  // `CANOPY_E2E_MOCK_BASE_URL` keeps the app and the scenario together.
  const launchEnv = {
    CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    ...env,
  };
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-shared-plan-owner-'),
  );
  let demoSeed = null;
  let electronApp;
  try {
    demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    beforeFirstLaunch?.({ userDataDir });

    const first = await launchCanopy({
      userDataDir,
      env: launchEnv,
      viewportSize,
    });
    try {
      const firstWindow = await first.electronApp.firstWindow();
      await new CanopyAppDriver(firstWindow).waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(firstWindow, apiKey);
    } finally {
      await closeCanopy(first.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    seedTrackedPlans({ userDataDir, workspaceId, worktreeId, plans });

    const second = await launchCanopy({
      userDataDir,
      env: launchEnv,
      viewportSize,
      ...(recordVideoDir ? { recordVideoDir } : {}),
    });
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
 * Close the owner (if it launched), clear the key's mock scenario, and remove
 * the demo fixtures. Safe to call with an `owner` that never launched.
 */
export async function closeSharedPlanOwner(owner, apiKey) {
  try {
    if (owner) {
      await closeCanopy(owner.electronApp, owner.userDataDir);
    }
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => undefined);
    if (owner) cleanupDemoWorkspaces(owner.demoSeed);
  }
}

/** Read one tracked plan through the same preload IPC the renderer uses. */
export function readTrackedPlan(window, { projectId, worktreeId, planId }) {
  return window.evaluate((ref) => window.api.activity.plans.get(ref), {
    projectId,
    worktreeId,
    planId,
  });
}

/**
 * Wait until startup has enrolled the seeded share: the mock received
 * `expectedPuts` full-content updates and the plan's share state reflects the
 * server's reply (synced, with the desktop's real snapshot hash replacing the
 * seeded placeholder). Returns the recorded requests and the synced plan.
 *
 * @param {import('@playwright/test').Page} window
 * @param {{
 *   apiKey: string,
 *   remoteId: string,
 *   projectId?: string,
 *   worktreeId?: string,
 *   planId: string,
 *   expectedPuts?: number,
 *   timeout?: number,
 * }} options
 */
export async function waitForSharedPlanStartupSync(
  window,
  {
    apiKey,
    remoteId,
    projectId = SHARED_PLAN_OWNER_WORKSPACE_ID,
    worktreeId = SHARED_PLAN_OWNER_WORKTREE_ID,
    planId,
    expectedPuts = 1,
    timeout = 30_000,
  },
) {
  let requests;
  await expect
    .poll(
      async () => {
        requests = await readSharedPlanRequests(apiKey, remoteId);
        return requests.puts.length;
      },
      {
        timeout,
        message: `startup sync should send ${expectedPuts} shared-plan PUT(s)`,
      },
    )
    .toBe(expectedPuts);
  let plan;
  await expect
    .poll(
      async () => {
        plan = await readTrackedPlan(window, { projectId, worktreeId, planId });
        return {
          syncStatus: plan?.share?.syncStatus,
          replacedSeededHash:
            typeof plan?.share?.lastSyncedSnapshotHash === 'string' &&
            plan.share.lastSyncedSnapshotHash !==
              SEEDED_SHARED_PLAN_SNAPSHOT_HASH,
        };
      },
      { timeout, message: 'startup sync should settle the share state' },
    )
    .toEqual({ syncStatus: 'synced', replacedSeededHash: true });
  return { requests, plan };
}
