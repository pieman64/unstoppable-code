import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { writeJson } from './seeders/index.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { injectApprovalRequestEvent } from './seeders/injectApprovalRequestEvent.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';

// ---------------------------------------------------------------------------
// Task 12 — Electron UI automation coverage for the tool-approval flow
// (`ToolApprovalCard.tsx`, `ApprovalModePicker.tsx`, `ApprovalsTab.tsx`).
//
// Three scenarios:
//
//  1. A LIVE pending approval — injected into an already-running app via
//     `injectApprovalRequestEvent`, the same `approval:request` IPC event
//     `apps/desktop-app/src/main/approvals/prompt-bridge.ts` sends for a real
//     agent tool call — renders as `tool-approval-card` inside the
//     `tool-approval-dock` above the composer, and clicking
//     `tool-approval-allow` clears it. The dock renders directly from live
//     `pendingApprovals` state (`ToolApprovalDock.tsx`) — no transcript-block
//     matching is involved.
//
//     This scenario intentionally does NOT pre-seed `pendingApprovals` in the
//     persisted `ChatTabsFile` and rely on hydration to restore it on launch:
//     commit 034edc2e9 ("fix: close approval policy bypasses") made
//     hydration compare persisted request IDs against the main process's
//     live pending registry (`pendingApprovalRequests()` in
//     `apps/desktop-app/src/main/approvals/pending-approvals.ts`) and discard
//     any persisted approval with no live backing promise
//     (`reconcileLivePendingApprovals` in `stores/chat/pending-approvals.ts`;
//     see `docs/tool-approvals.md` "Renderer cancellation"). A fresh
//     Electron process always starts with an empty pending registry, so a
//     disk-only seeded approval with no real agent behind it is exactly the
//     spoofed/stale case that fix closes — it is correctly scrubbed on load,
//     every time, by design. Injecting the event into a running app (like a
//     real approval prompt arriving mid-session) is the only way to get an
//     actionable card without driving a real agent tool call.
//
//  2. `ApprovalModePicker` (composer chip) defaults to "Full access"
//     (`full-access`) and persists a mode change to "Ask" across an app
//     relaunch reusing the same `userDataDir`, via the tab's persisted
//     `approvalMode` field.
//
//  3. Settings → Approvals (`settings-approvals-section`) renders the three
//     per-surface default selects at 'full-access' for a new user and
//     persists a changed worktree default across relaunch, via
//     `PreferencesData.approvalDefaults`.
//
//  4. An existing preferences file without the one-time migration marker is
//     upgraded so all three per-surface defaults render as Full Access.
//
//  5. A cold Cowork default lookup shows a neutral loading state instead of
//     presenting Ask before the configured Full value resolves.
//
// Determinism: no live agents, no network. Everything is static persisted
// JSON, renderer-only preference writes, and a local delayed IPC response.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKTREE_ID = 'demo-main';

// Wait for canonical on-disk metadata before closing the app, so the
// relaunch assertion verifies a durably acknowledged approval change.
function readTabApprovalMode(userDataDir, workspaceId, worktreeId, tabId) {
  try {
    return readChatStorageIndexes(
      path.join(userDataDir, 'workspaces', workspaceId),
      worktreeId,
    ).live.tabs.find((tab) => tab.id === tabId)?.approvalMode;
  } catch {
    return undefined;
  }
}

// `savePreferences` writes are async IPC round trips; polling the on-disk
// `preferences.json` before closing the app avoids a race between that write
// and Electron shutdown (mirrors the canonical metadata guard above).
function readWorktreeApprovalDefault(userDataDir) {
  const filePath = path.join(userDataDir, 'preferences.json');
  let file;
  try {
    file = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
  return file.preferences?.approvalDefaults?.worktree;
}

function seedExistingApprovalDefaults(userDataDir) {
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          approvalDefaults: {
            worktree: 'ask',
            cowork: 'auto',
            appAdvisor: 'ask',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function dismissApprovalsUpgradeNoticeIfPresent(window) {
  const dismiss = window.getByTestId('approvals-upgrade-notice-dismiss');
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
    await expect(window.getByTestId('approvals-upgrade-notice')).toHaveCount(0);
  }
}

test.describe('tool approvals', () => {
  test('renders a persisted pending approval card and clears it on Allow once', async ({}, testInfo) => {
    const TAB_ID = 'seeded-approval-chat';
    const COMMAND_TEXT = 'npm run build';

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-tool-approval-'),
    );

    let electronApp;
    try {
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        activeTabId: TAB_ID,
        tabs: [
          {
            id: TAB_ID,
            title: 'Approval Coverage',
            providerType: 'claude',
          },
        ],
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;

      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      await dismissApprovalsUpgradeNoticeIfPresent(window);

      // Inject the approval live (see file header) — hydration would discard
      // this same event if it were only pre-seeded on disk, since a fresh
      // Electron process has no matching live entry in the main process's
      // pending-approval registry.
      await injectApprovalRequestEvent(electronApp, {
        requestId: 'approval-req-1',
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: TAB_ID,
        provider: 'claude',
        title: 'Run shell command',
        details: { kind: 'command', command: COMMAND_TEXT },
        suggestedTarget: { kind: 'command', pattern: COMMAND_TEXT },
      });

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText(COMMAND_TEXT);
      await expect(card).toContainText('Run shell command');

      await window.screenshot({
        path: testInfo.outputPath('tool-approval-card-visible.png'),
      });

      await window.getByTestId('tool-approval-allow').click();

      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('approval mode picker defaults to Full and persists an Ask switch across relaunch', async ({}, testInfo) => {
    const TAB_ID = 'seeded-mode-picker-chat';

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-mode-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: TAB_ID,
      tabs: [
        { id: TAB_ID, title: 'Mode Picker Coverage', providerType: 'claude' },
      ],
    });

    const first = await launchCanopy({ userDataDir });

    try {
      const window = await first.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      await dismissApprovalsUpgradeNoticeIfPresent(window);

      const picker = window.getByTestId('approval-mode-picker');
      await expect(picker).toBeVisible();
      // Full Access is the product default now (CAN-3055), so the switch that
      // proves per-chat persistence is the de-escalation to Ask.
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );

      await picker.click();
      await window.getByTestId('approval-mode-option-ask').click();

      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );

      await window.screenshot({
        path: testInfo.outputPath('approval-mode-picker-ask.png'),
      });

      // Wait out the 500ms debounced chat-tab save so the relaunch below
      // reads the persisted `approvalMode` instead of racing app shutdown.
      await expect
        .poll(() =>
          readTabApprovalMode(userDataDir, WORKSPACE_ID, WORKTREE_ID, TAB_ID),
        )
        .toBe('ask');
    } finally {
      // Keep the seeded preferences/chat so the relaunch can read them.
      await closeCanopy(first.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    const second = await launchCanopy({ userDataDir });

    try {
      const window = await second.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const picker = window.getByTestId('approval-mode-picker');
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );

      await window.screenshot({
        path: testInfo.outputPath('approval-mode-picker-persisted.png'),
      });
    } finally {
      await closeCanopy(second.electronApp, userDataDir);
    }
  });

  test('an open unstamped chat follows a changed worktree default', async () => {
    const TAB_ID = 'legacy-unstamped-approval-chat';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-default-refresh-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: TAB_ID,
      tabs: [
        {
          id: TAB_ID,
          title: 'Legacy Approval Default',
          providerType: 'claude',
        },
      ],
    });

    const launched = await launchCanopy({ userDataDir });
    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await dismissApprovalsUpgradeNoticeIfPresent(window);

      const picker = window.getByTestId('approval-mode-picker');
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );
      expect(
        readTabApprovalMode(userDataDir, WORKSPACE_ID, WORKTREE_ID, TAB_ID),
      ).toBeUndefined();

      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();
      await window.getByTestId('approval-default-worktree').selectOption('ask');
      await expect
        .poll(() => readWorktreeApprovalDefault(userDataDir))
        .toBe('ask');

      await app.closeSettings();
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );
      expect(
        readTabApprovalMode(userDataDir, WORKSPACE_ID, WORKTREE_ID, TAB_ID),
      ).toBeUndefined();
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });

  test('a Cowork picker returns to loading and resolves the current default after invalidation', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cowork-home-approval-default-'),
    );
    const coworkId = 'approval-default-cowork';
    const workspaceDir = path.join(userDataDir, 'workspaces', coworkId);
    writeJson(path.join(userDataDir, 'migrations.json'), {
      version: 1,
      approval_defaults_full_access: true,
    });
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        approvalDefaults: {
          worktree: 'full-access',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      },
    });
    writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        {
          id: coworkId,
          name: 'Approval Default Cowork',
          type: 'cowork',
          color: '#7C9B6D',
          collapsed: false,
          order: 0,
          cowork: { createdAt: '2026-09-03T12:00:00.000Z' },
        },
      ],
    });
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      cowork: { createdAt: '2026-09-03T12:00:00.000Z' },
    });
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries: [],
    });

    const launched = await launchCanopy({ userDataDir });
    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await launched.electronApp.evaluate(({ ipcMain }) => {
        let lookupCount = 0;
        ipcMain.removeHandler('approval:resolved-default');
        ipcMain.handle('approval:resolved-default', async () => {
          lookupCount += 1;
          if (lookupCount === 1) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            return 'ask';
          }
          if (lookupCount === 2) return 'full-access';
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          return 'auto';
        });
      });
      const toggle = window.getByTestId(
        `sidebar-cowork-project-${coworkId}-toggle`,
      );
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
        await toggle.click();
      }

      const home = await app.openHomeForProject(coworkId);
      await expect(
        home.getByTestId('home-approval-mode-loading'),
      ).toBeVisible();
      await expect(home.getByTestId('approval-mode-picker')).toHaveCount(0);
      await launched.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          'preferences:synced',
          { inAppBrowserLocalServersOnly: false },
        );
      });
      await expect(home.getByTestId('approval-mode-picker')).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );
      await expect(home.getByTestId('home-approval-mode-loading')).toHaveCount(
        0,
      );

      await launched.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          'preferences:synced',
          { inAppBrowserLocalServersOnly: false },
        );
      });
      await expect(
        home.getByTestId('home-approval-mode-loading'),
      ).toBeVisible();
      await expect(home.getByTestId('approval-mode-picker')).toHaveCount(0);
      await expect(home.getByTestId('approval-mode-picker')).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Accept edits',
      );
      await expect(home.getByTestId('home-approval-mode-loading')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });

  test('a failed Cowork default lookup exits loading and offers Ask', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cowork-home-approval-fallback-'),
    );
    const coworkId = 'approval-fallback-cowork';
    const workspaceDir = path.join(userDataDir, 'workspaces', coworkId);
    writeJson(path.join(userDataDir, 'migrations.json'), {
      version: 1,
      approval_defaults_full_access: true,
    });
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        approvalDefaults: {
          worktree: 'full-access',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      },
    });
    writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        {
          id: coworkId,
          name: 'Approval Fallback Cowork',
          type: 'cowork',
          color: '#7C9B6D',
          collapsed: false,
          order: 0,
          cowork: { createdAt: '2026-09-03T12:00:00.000Z' },
        },
      ],
    });
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      cowork: { createdAt: '2026-09-03T12:00:00.000Z' },
    });
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries: [],
    });

    const launched = await launchCanopy({ userDataDir });
    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      // Hold the lookup open until this test releases it, instead of racing a
      // fixed 1s sleep. The renderer only paints `home-approval-mode-loading`
      // while the lookup is in flight, and on a loaded CI runner the Home
      // surface finished mounting AFTER a 1s sleep had already elapsed — the
      // panel came up settled and the assertion waited 15s for a state that
      // was already gone. A gate makes the window last exactly as long as the
      // assertion needs, with no timing assumption.
      await launched.electronApp.evaluate(({ ipcMain }) => {
        globalThis.__canopyApprovalGate = new Promise((resolve) => {
          globalThis.__canopyReleaseApprovalGate = resolve;
        });
        ipcMain.removeHandler('approval:resolved-default');
        ipcMain.handle('approval:resolved-default', async () => {
          await globalThis.__canopyApprovalGate;
          throw new Error('approval defaults unavailable');
        });
      });
      const toggle = window.getByTestId(
        `sidebar-cowork-project-${coworkId}-toggle`,
      );
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
        await toggle.click();
      }

      const home = await app.openHomeForProject(coworkId);
      await expect(
        home.getByTestId('home-approval-mode-loading'),
      ).toBeVisible();
      // Let the lookup fail now that the loading state has been observed.
      await launched.electronApp.evaluate(() => {
        globalThis.__canopyReleaseApprovalGate?.();
      });
      await expect(home.getByTestId('approval-mode-picker')).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );
      await expect(home.getByTestId('home-approval-mode-loading')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });

  test('a Full Access default stays attached to a created worktree and retains per-chat choices', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-default-retention-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    const launched = await launchCanopy({ userDataDir });

    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();
      await window
        .getByTestId('approval-default-worktree')
        .selectOption('full-access');
      await expect
        .poll(() => readWorktreeApprovalDefault(userDataDir))
        .toBe('full-access');
      await expect(
        window.evaluate(
          (projectId) => window.api.approvals.getResolvedDefault({ projectId }),
          WORKSPACE_ID,
        ),
      ).resolves.toBe('full-access');
      await app.closeSettings();

      const workspaceHeader = app.workspaceHeader(WORKSPACE_NAME);
      await expect(workspaceHeader).toBeVisible({ timeout: 15_000 });
      if (
        (await workspaceHeader.getAttribute('aria-label')) ===
        `Expand ${WORKSPACE_NAME}`
      ) {
        await workspaceHeader.click();
      }
      await workspaceHeader.hover();
      const workspaceRows = window.locator(
        `[data-testid="worktree-row"][data-project-id="${WORKSPACE_ID}"]`,
      );
      const existingWorktreeIds = new Set(
        await workspaceRows.evaluateAll((rows) =>
          rows
            .map((row) => row.getAttribute('data-worktree-id'))
            .filter((id) => id !== null),
        ),
      );
      const createButton = window.getByRole('button', {
        name: `Create worktree for ${WORKSPACE_NAME}`,
      });
      await expect(createButton).toBeVisible();
      await window.evaluate(() => {
        window.__approvalModeLabelsSeen = [];
        const recordApprovalModeLabel = () => {
          const picker = document.querySelector(
            '[data-testid="approval-mode-picker"]',
          );
          const label = picker?.getAttribute('aria-label');
          if (label && !window.__approvalModeLabelsSeen.includes(label)) {
            window.__approvalModeLabelsSeen.push(label);
          }
        };
        new MutationObserver(recordApprovalModeLabel).observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true,
          attributeFilter: ['aria-label'],
        });
      });
      // Worktree creation auto-selects the newly observed row. Install the
      // collector before creating it so the initial picker mount is observed.
      await createButton.click();

      let createdWorktreeId = null;
      await expect
        .poll(async () => {
          const currentIds = await workspaceRows.evaluateAll((rows) =>
            rows
              .map((row) => row.getAttribute('data-worktree-id'))
              .filter((id) => id !== null),
          );
          createdWorktreeId =
            currentIds.find((id) => !existingWorktreeIds.has(id)) ?? null;
          return createdWorktreeId;
        })
        .not.toBeNull();
      await window
        .locator(
          `[data-testid="worktree-row"][data-worktree-id="${createdWorktreeId}"]`,
        )
        .click();

      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await dismissApprovalsUpgradeNoticeIfPresent(window);
      await expect(
        window.evaluate(
          ([projectId, worktreeId]) =>
            window.api.approvals.getResolvedDefault({
              projectId,
              worktreeId,
            }),
          [WORKSPACE_ID, createdWorktreeId],
        ),
      ).resolves.toBe('full-access');

      await expect
        .poll(() =>
          window.evaluate(
            ([projectId, worktreeId]) =>
              window.api.chat
                .getState({ projectId, worktreeId })
                .then(
                  (snapshot) =>
                    snapshot.tabsFile.tabs[0]?.approvalMode ?? 'missing',
                ),
            [WORKSPACE_ID, createdWorktreeId],
          ),
        )
        .toBe('full-access');

      const picker = window.getByTestId('approval-mode-picker');
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );
      expect(
        await window.evaluate(() => window.__approvalModeLabelsSeen),
      ).toEqual(['Tool approval mode, current mode Full access']);

      const chatTabs = window.locator(
        '[data-testid^="panel-tab-panel-chat-"]:not([data-testid*="panel-tab-close"])',
      );
      await expect(chatTabs).toHaveCount(1);
      const initialTabTestId = await chatTabs
        .first()
        .getAttribute('data-testid');
      if (!initialTabTestId) throw new Error('Initial chat tab is missing');

      await window.getByTestId('panel-add-tab-group-chat').click();
      await expect(chatTabs).toHaveCount(2);
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );

      const addedTabTestId = await chatTabs.last().getAttribute('data-testid');
      if (!addedTabTestId) throw new Error('Added chat tab is missing');

      await picker.click();
      await window.getByTestId('approval-mode-option-ask').click();
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );

      await window.getByTestId(initialTabTestId).click();
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );

      await window.getByTestId(addedTabTestId).click();
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );
      await expect(
        window.getByTestId('chat-state-command-failed-notice'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });

  test('Settings > Approvals shows Full Access defaults and persists a worktree default change across relaunch', async ({}, testInfo) => {
    const first = await launchCanopy();
    const userDataDir = first.userDataDir;

    try {
      const window = await first.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell();
      await app.openMainPage();
      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();

      const section = window.getByTestId('settings-approvals-section');
      await expect(section).toBeVisible();

      const worktreeDefault = window.getByTestId('approval-default-worktree');
      const coworkDefault = window.getByTestId('approval-default-cowork');
      const appAdvisorDefault = window.getByTestId(
        'approval-default-app-advisor',
      );

      await expect(worktreeDefault).toHaveValue('full-access');
      await expect(coworkDefault).toHaveValue('full-access');
      await expect(appAdvisorDefault).toHaveValue('full-access');

      await worktreeDefault.selectOption('auto');
      await expect(worktreeDefault).toHaveValue('auto');

      await window.screenshot({
        path: testInfo.outputPath('settings-approvals-defaults.png'),
      });

      await expect
        .poll(() => readWorktreeApprovalDefault(userDataDir))
        .toBe('auto');
    } finally {
      // Keep the saved preferences so the relaunch can read them.
      await closeCanopy(first.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    const second = await launchCanopy({ userDataDir });

    try {
      const window = await second.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell();
      await app.openMainPage();
      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();

      await expect(
        window.getByTestId('settings-approvals-section'),
      ).toBeVisible();
      await expect(window.getByTestId('approval-default-worktree')).toHaveValue(
        'auto',
      );
      await expect(window.getByTestId('approval-default-cowork')).toHaveValue(
        'full-access',
      );
      await expect(
        window.getByTestId('approval-default-app-advisor'),
      ).toHaveValue('full-access');

      await window.screenshot({
        path: testInfo.outputPath('settings-approvals-persisted.png'),
      });
    } finally {
      await closeCanopy(second.electronApp, userDataDir);
    }
  });

  test('Settings > Approvals migrates all three defaults to Full Access for an existing user', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-defaults-migration-'),
    );
    seedExistingApprovalDefaults(userDataDir);
    const launched = await launchCanopy({ userDataDir });

    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();

      await expect(window.getByTestId('approval-default-worktree')).toHaveValue(
        'full-access',
      );
      await expect(window.getByTestId('approval-default-cowork')).toHaveValue(
        'full-access',
      );
      await expect(
        window.getByTestId('approval-default-app-advisor'),
      ).toHaveValue('full-access');
      await expect
        .poll(() => readWorktreeApprovalDefault(userDataDir))
        .toBe('full-access');
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
});
