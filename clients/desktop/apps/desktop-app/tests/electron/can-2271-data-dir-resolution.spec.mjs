import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

// CAN-2271 — data-dir flip on relaunch: a stray cache write recreated the
// brand-primary data directory as a near-empty skeleton, and first-existing
// resolution then hijacked an install living in the fallback directory (all
// workspaces "disappeared"). Resolution is now data-aware: a candidate
// containing `workspaces/index.json` wins over one that merely exists, and
// the explicit Settings "Use primary folder" flow seeds an empty workspace
// index so that deliberate switch keeps winning after relaunch.
//
// These launch-resolution flows can only be exercised WITHOUT the harness's
// `CANOPY_DATA_DIR` override (an override short-circuits candidate
// resolution), so each launch blanks the override and points `HOME` at a
// throwaway home directory holding both brand candidates (`.canopy-dev`
// primary, `.unstoppable-code-dev` fallback — the E2E build runs the
// `canopy` brand in dev mode; see `brands/canopy/brand.json` `dataDirNames`).
//
// Deterministic + offline: seeded cowork workspace state only, no live
// agents, no network beyond the suite-wide mock defaults. Run with:
//   pnpm run build:e2e
//   pnpm exec playwright test can-2271-data-dir-resolution.spec.mjs --reporter=line

const PRIMARY_DIR_NAME = '.canopy-dev';
const FALLBACK_DIR_NAME = '.unstoppable-code-dev';
const FALLBACK_WORKSPACE_NAME = 'Fallback Rescue';
const FALLBACK_WORKSPACE_ROW_TESTID =
  'sidebar-cowork-project-fallback-rescue-toggle';

/**
 * Seed a real install into the fallback candidate: a unified workspace index
 * with one cowork workspace (no git repos needed), mirroring the minimal
 * shape `unified-sidebar.spec.mjs` seeds against the same readers.
 */
function seedFallbackInstall(fallbackDataDir) {
  const createdAt = '2026-05-01T12:00:00.000Z';
  writeJson(path.join(fallbackDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: 'fallback-rescue',
        name: FALLBACK_WORKSPACE_NAME,
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: true,
        order: 0,
      },
    ],
  });
  const workspaceDir = path.join(
    fallbackDataDir,
    'workspaces',
    'fallback-rescue',
  );
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: {
      createdAt,
      defaultModel: 'gpt-6-luna',
      searchIndexingEnabled: true,
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'chats', 'home.json'), {
    version: 1,
    activeTabId: 'rescue-chat',
    tabs: [
      {
        id: 'rescue-chat',
        title: 'Rescue Chat',
        description: 'Seeded fallback conversation',
        createdAt,
        providerType: 'codex',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: [
          {
            id: 'rescue-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Hello from the fallback dir.' }],
            timestamp: Date.parse(createdAt),
          },
        ],
      },
    ],
  });
}

/**
 * Recreate the incident's stray-write skeleton: the primary candidate exists
 * but contains only the model-catalog cache file — no install data.
 */
function seedSkeletonPrimary(primaryDataDir) {
  writeJson(
    path.join(primaryDataDir, '.cache', 'model-catalog', 'ai-gateway-v1.json'),
    { version: 1, models: [] },
  );
}

let nextElectronProfileOrdinal = 0;

function makeIncidentHome() {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2271-home-'));
  const primaryDataDir = path.join(fakeHome, PRIMARY_DIR_NAME);
  const fallbackDataDir = path.join(fakeHome, FALLBACK_DIR_NAME);
  seedSkeletonPrimary(primaryDataDir);
  seedFallbackInstall(fallbackDataDir);
  return { fakeHome, primaryDataDir, fallbackDataDir };
}

function resolutionEnv(fakeHome) {
  // Blank the harness data-dir override so the app resolves the brand
  // candidates inside the throwaway HOME, exactly like a production launch.
  // Each launch gets its own private Electron profile root: blanking
  // `CANOPY_DATA_DIR` skips the harness's usual userData redirect, and a
  // profile directory shared with a concurrent (or just-closed) instance
  // hangs window creation.
  nextElectronProfileOrdinal += 1;
  const electronUserDataDir = path.join(
    fakeHome,
    `electron-user-data-${nextElectronProfileOrdinal}`,
  );
  mkdirSync(electronUserDataDir, { recursive: true });
  return {
    CANOPY_DATA_DIR: '',
    CANOPY_E2E_USER_DATA_DIR: electronUserDataDir,
    HOME: fakeHome,
  };
}

test.describe('CAN-2271 data-dir resolution', () => {
  test('launches into the data-bearing fallback when a skeleton primary exists', async () => {
    test.setTimeout(120_000);
    const { fakeHome, primaryDataDir, fallbackDataDir } = makeIncidentHome();

    let electronApp;
    try {
      // `userDataDir: fallbackDataDir` routes the harness's onboarding/legal
      // seed into the install the app should resolve; the env override below
      // is what actually controls resolution.
      ({ electronApp } = await launchCanopy({
        userDataDir: fallbackDataDir,
        env: resolutionEnv(fakeHome),
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      // The install's workspaces must survive the stray skeleton primary.
      const fallbackRow = window.getByTestId(FALLBACK_WORKSPACE_ROW_TESTID);
      await expect(fallbackRow).toBeVisible();
      await expect(fallbackRow).toContainText(FALLBACK_WORKSPACE_NAME);

      // The skeleton primary must not have been promoted to a real install.
      expect(
        existsSync(path.join(primaryDataDir, 'workspaces', 'index.json')),
      ).toBe(false);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, fallbackDataDir, { keepUserData: true });
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test('explicit Settings switch to the primary folder stays durable across relaunch', async () => {
    // Two full app launches plus the Settings flow — same budget as the
    // other relaunch specs (see onboarding-settings-relaunch.spec.mjs).
    test.setTimeout(180_000);
    const { fakeHome, primaryDataDir, fallbackDataDir } = makeIncidentHome();

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir: fallbackDataDir,
        env: resolutionEnv(fakeHome),
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await expect(
        window.getByTestId(FALLBACK_WORKSPACE_ROW_TESTID),
      ).toBeVisible();

      // Walk the realistic user flow: Settings → Canopy → "Use primary
      // folder" → confirm. In dev builds `restartApp` declines (returns
      // false), so the flow deterministically lands on the created-notice
      // message instead of quitting the app under test.
      await app.openSettings();
      await app.openSettingsSection('canopy');
      await expect(
        window.getByTestId('settings-data-dir-fallback-notice'),
      ).toBeVisible();
      await window.getByTestId('settings-data-dir-create-primary').click();
      await window.getByTestId('settings-data-dir-confirm-create').click();
      await expect(
        window.getByTestId('settings-data-dir-primary-created'),
      ).toBeVisible({ timeout: 30_000 });

      // The switch must seed the adoption marker and workspace index that
      // keep the explicitly chosen primary winning data-aware resolution.
      expect(
        existsSync(path.join(primaryDataDir, 'data-dir-adopted.json')),
      ).toBe(true);
      const seededIndexPath = path.join(
        primaryDataDir,
        'workspaces',
        'index.json',
      );
      expect(existsSync(seededIndexPath)).toBe(true);
      expect(JSON.parse(readFileSync(seededIndexPath, 'utf8'))).toEqual({
        version: 1,
        workspaces: [],
      });

      await closeCanopy(electronApp, fallbackDataDir, { keepUserData: true });
      electronApp = undefined;

      // Relaunch resolving the same candidates: the seeded primary must win
      // even though the fallback still holds the old install's data.
      ({ electronApp } = await launchCanopy({
        userDataDir: primaryDataDir,
        env: resolutionEnv(fakeHome),
      }));
      const window2 = await electronApp.firstWindow();
      const app2 = new CanopyAppDriver(window2);
      await app2.waitForShell();

      await expect(window2.getByTestId('app-sidebar')).toBeVisible();
      await expect(
        window2.getByTestId(FALLBACK_WORKSPACE_ROW_TESTID),
      ).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, fallbackDataDir, { keepUserData: true });
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
