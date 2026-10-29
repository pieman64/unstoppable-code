// Cloud Cowork session rows are repoless even though the shared snapshot
// carries a synthetic `branch: "cloud"` value. This regression drives the real
// Electron renderer and shared sidebar: an injected untitled Cloud session
// must use session copy everywhere, while a seeded code worktree keeps its
// repository-backed branch metadata and actions.

import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const SOURCE_WORKSPACE_ID = 'demo-ts-npm-next';
const SOURCE_WORKTREE_ID = 'demo-main';
const CLOUD_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const CLOUD_SESSION_ID = 'cloud-cowork-session';
const SHARED_SIDEBAR_STORAGE_KEY = 'canopy.desktop.sharedSidebar';

async function installCloudCoworkFixture(electronApp, window) {
  const liveSnapshot = await window.evaluate(() =>
    window.api.getDesktopSessionSnapshot({}),
  );
  const sourceWorkspace = liveSnapshot.workspaces.find(
    (workspace) => workspace.localId === SOURCE_WORKSPACE_ID,
  );
  const sourceWorktree = liveSnapshot.worktrees.find(
    (worktree) =>
      worktree.workspaceLocalId === SOURCE_WORKSPACE_ID &&
      worktree.localId === SOURCE_WORKTREE_ID,
  );
  const cloudTemplateWorkspace = liveSnapshot.workspaces.find(
    (workspace) => workspace.localId === CLOUD_WORKSPACE_ID,
  );
  const cloudTemplateWorktree = liveSnapshot.worktrees.find(
    (worktree) => worktree.workspaceLocalId === CLOUD_WORKSPACE_ID,
  );
  if (
    !sourceWorkspace ||
    !sourceWorktree ||
    !cloudTemplateWorkspace ||
    !cloudTemplateWorktree
  ) {
    throw new Error('Cloud Cowork branch fixture did not hydrate');
  }

  const cloudWorkspace = {
    ...cloudTemplateWorkspace,
    name: 'Cloud Cowork',
    type: 'cowork',
    layout: 'tree',
    backend: 'cloud',
    collapsed: false,
  };
  const cloudSession = {
    ...cloudTemplateWorktree,
    localId: CLOUD_SESSION_ID,
    workspaceLocalId: CLOUD_WORKSPACE_ID,
    branch: 'cloud',
    label: undefined,
    status: 'done',
    backend: 'cloud',
  };
  const snapshot = {
    ...liveSnapshot,
    workspaces: [sourceWorkspace, cloudWorkspace],
    worktrees: [sourceWorktree, cloudSession],
    standaloneChats: [],
  };

  await electronApp.evaluate(({ BrowserWindow, ipcMain }, nextSnapshot) => {
    globalThis.__CLOUD_COWORK_BRANCH_SNAPSHOT__ = nextSnapshot;
    globalThis.__CLOUD_COWORK_CREATE_CALLS__ = [];
    ipcMain.removeHandler('desktop:session-snapshot');
    ipcMain.handle(
      'desktop:session-snapshot',
      () => globalThis.__CLOUD_COWORK_BRANCH_SNAPSHOT__,
    );
    ipcMain.removeHandler('worktree:create');
    ipcMain.handle(
      'worktree:create',
      (_event, request) =>
        new Promise((resolve) => {
          globalThis.__CLOUD_COWORK_CREATE_CALLS__.push(request);
          globalThis.__CLOUD_COWORK_RESOLVE_CREATE__ = resolve;
        }),
    );
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed()) {
        target.webContents.send('desktop:session-snapshot-stale');
      }
    }
  }, snapshot);

  return {
    sourceBranch: sourceWorktree.branch,
    sourceWorkspaceName: sourceWorkspace.name,
  };
}

async function setCloudCoworkLabel(electronApp, label) {
  await electronApp.evaluate(
    ({ BrowserWindow }, fixture) => {
      const snapshot = globalThis.__CLOUD_COWORK_BRANCH_SNAPSHOT__;
      globalThis.__CLOUD_COWORK_BRANCH_SNAPSHOT__ = {
        ...snapshot,
        worktrees: snapshot.worktrees.map((worktree) =>
          worktree.localId === fixture.localId
            ? { ...worktree, label: fixture.label }
            : worktree,
        ),
      };
      for (const target of BrowserWindow.getAllWindows()) {
        if (!target.isDestroyed()) {
          target.webContents.send('desktop:session-snapshot-stale');
        }
      }
    },
    { localId: CLOUD_SESSION_ID, label },
  );
}

async function openActionsMenu(window, row) {
  const trigger = row.getByTestId('worktree-actions-menu-button');
  await trigger.focus();
  await window.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const menu = window.getByTestId('worktree-actions-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test('Cloud Cowork sessions hide synthetic branch metadata and render archive snapshots', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite', 'ts-npm-next'],
    viewportSize: { width: 1100, height: 760 },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate((key) => {
      window.localStorage.setItem(key, '1');
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await expect(window.getByTestId('sidebar-workspaces-list')).toBeVisible({
      timeout: 30_000,
    });

    const { sourceBranch, sourceWorkspaceName } =
      await installCloudCoworkFixture(electronApp, window);
    const sidebar = window.getByTestId('app-sidebar');
    const cloudWorkspace = sidebar.locator(
      `[data-workspace-id="${CLOUD_WORKSPACE_ID}"]`,
    );
    await cloudWorkspace
      .getByTestId('workspace-section-actions')
      .locator('xpath=../..')
      .hover();
    const cloudCreate = cloudWorkspace.getByRole('button', {
      name: 'Create chat for Cloud Cowork',
    });
    await expect(cloudCreate).toBeVisible();
    // The shared tooltip follows `:focus-visible` semantics and opens only for
    // keyboard-driven focus. A Tab press first puts the renderer in keyboard
    // modality, so the focus() that follows reads like continued Tab
    // traversal (see `focusToggleViaKeyboard` in sidebar-hover-preview).
    await window.keyboard.press('Tab');
    await cloudCreate.focus();
    await expect(
      window.getByRole('tooltip', { name: 'Create chat' }),
    ).toBeVisible();
    await cloudCreate.click();
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.__CLOUD_COWORK_CREATE_CALLS__?.length ?? 0,
        ),
      )
      .toBe(1);
    const pending = cloudWorkspace.getByRole('status', {
      name: 'Creating chat',
    });
    await expect(pending).toContainText('Creating chat…');

    const sourceWorkspace = sidebar.locator(
      `[data-workspace-id="${SOURCE_WORKSPACE_ID}"]`,
    );
    await sourceWorkspace
      .getByTestId('workspace-section-actions')
      .locator('xpath=../..')
      .hover();
    await expect(
      sourceWorkspace.getByRole('button', {
        name: `Create worktree for ${sourceWorkspaceName}`,
      }),
    ).toBeVisible();

    await electronApp.evaluate(() => {
      globalThis.__CLOUD_COWORK_RESOLVE_CREATE__?.({
        id: 'cloud-cowork-created-session',
        branchName: 'New session',
        createdAt: '2026-08-28T12:00:00.000Z',
        setupPhase: 'git-pending',
      });
      delete globalThis.__CLOUD_COWORK_RESOLVE_CREATE__;
    });

    const cloudRow = sidebar.locator(
      `[data-worktree-id="${CLOUD_SESSION_ID}"]`,
    );
    await expect(cloudRow).toBeVisible();

    const cloudTitle = cloudRow.getByTestId('worktree-row-title');
    await expect(cloudTitle).toHaveText('Session');
    expect(await cloudTitle.getAttribute('title')).toBeNull();

    await setCloudCoworkLabel(electronApp, 'Planning session');
    await expect(cloudTitle).toHaveText('Planning session');

    // Every desktop row action (label, pin, hide, delete, reorder) persists
    // into the local projects store, which holds no cloud session. The desktop
    // offers none it could not perform: no hover shortcut, no actions menu,
    // and no reorder handle.
    await cloudRow.hover();
    await expect(cloudRow.getByTestId('worktree-archive-button')).toHaveCount(
      0,
    );
    await expect(
      cloudRow.getByTestId('worktree-actions-menu-button'),
    ).toHaveCount(0);
    await expect(cloudRow.getByRole('button', { name: /^Move / })).toHaveCount(
      0,
    );

    const codeRow = sidebar.locator(
      `[data-worktree-id="${SOURCE_WORKTREE_ID}"]`,
    );
    await expect(codeRow).toBeVisible();
    await expect(codeRow.getByTestId('worktree-row-title')).toHaveAttribute(
      'title',
      sourceBranch,
    );
    const codeMenu = await openActionsMenu(window, codeRow);
    await expect(
      codeMenu.getByTestId('worktree-actions-menu-info'),
    ).toBeVisible();
    await expect(
      codeMenu.getByTestId('worktree-actions-menu-set-label'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    // The local row keeps its reorder handle, so the cloud row's absence
    // above is the withheld action rather than a missing control.
    await expect(codeRow.getByRole('button', { name: /^Move / })).toHaveCount(
      1,
    );

    // REG-3022: exercise the browser-safe snapshot contract in the real
    // Electron shared sidebar. Local desktop archive runs use
    // running-teardown; the cloud adapter owns running-archive. This fixture
    // tests its rendering, not a desktop execution of the cloud backend.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const snapshot = globalThis.__CLOUD_COWORK_BRANCH_SNAPSHOT__;
      globalThis.__CLOUD_COWORK_BRANCH_SNAPSHOT__ = {
        ...snapshot,
        worktrees: snapshot.worktrees.map((worktree) =>
          worktree.localId === 'cloud-cowork-session'
            ? { ...worktree, setupPhase: 'running-archive' }
            : worktree,
        ),
      };
      for (const target of BrowserWindow.getAllWindows())
        if (!target.isDestroyed())
          target.webContents.send('desktop:session-snapshot-stale');
    });
    await expect(
      cloudRow.getByLabel('Archiving worktree…', { exact: true }).first(),
    ).toBeVisible();
    await expect(cloudRow).not.toContainText('Running teardown');
    await expect(cloudRow.getByTestId('worktree-archive-button')).toHaveCount(
      0,
    );
    await expect(
      cloudRow.getByTestId('worktree-actions-menu-button'),
    ).toHaveCount(0);
    await cloudRow.click();
    await expect(cloudRow).toBeVisible();
    // A completed cloud archive leaves the active listing. The local row is
    // still present, so removing the cloud row cannot blank the sidebar.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const snapshot = globalThis.__CLOUD_COWORK_BRANCH_SNAPSHOT__;
      globalThis.__CLOUD_COWORK_BRANCH_SNAPSHOT__ = {
        ...snapshot,
        worktrees: snapshot.worktrees.filter(
          (worktree) => worktree.localId !== 'cloud-cowork-session',
        ),
      };
      for (const target of BrowserWindow.getAllWindows())
        if (!target.isDestroyed())
          target.webContents.send('desktop:session-snapshot-stale');
    });
    await expect(cloudRow).toHaveCount(0);
    await expect(codeRow).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
