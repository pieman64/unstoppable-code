import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, waitForStableLocator } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedChatsSectionFixture,
  CHATS_SECTION_CODE_WORKSPACE_ID,
} from './seeders/index.mjs';

/**
 * The left nav defaults to manual order at every level: activity never moves
 * a project or its rows unless the user opts into Last updated.
 *
 * Recency ordering is implemented by the legacy rail; the shared rail
 * (CAN-3053) renders the persisted order in either mode, with pinned projects
 * lifted to the top as on the legacy rail. The ordering test
 * therefore runs on the legacy rail, through the same escape hatch users have.
 */

const SHARED_SIDEBAR_STORAGE_KEY = 'canopy.desktop.sharedSidebar';

const DEMO_APPS = ['ts-pnpm-vite', 'ts-npm-next', 'ts-yarn-cli'];
const DEMO_PROJECT_IDS = DEMO_APPS.map((app) => `demo-${app}`);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Record fresh activity on every worktree of one project. */
function touchProjectWorktrees(userDataDir, projectId) {
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    projectId,
    'worktrees.json',
  );
  const file = readJson(worktreesPath);
  const touchedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  writeJson(worktreesPath, {
    ...file,
    worktrees: file.worktrees.map((worktree) => ({
      ...worktree,
      lastTouchedAt: touchedAt,
    })),
  });
}

/** Project ids in on-screen order, top to bottom. */
async function renderedProjectOrder(window) {
  let positions;
  // A header can be visible and then have no box a moment later: on slow CI
  // hosts the project headers lose their layout for up to half a second
  // shortly after the shell is ready. Read every position again rather than
  // fail on that gap; the order is what the callers assert.
  await expect(async () => {
    positions = await Promise.all(
      DEMO_PROJECT_IDS.map(async (projectId) => {
        const header = window
          .getByTestId(`sidebar-project-header-${projectId}`)
          .first();
        await expect(header).toBeVisible();
        const box = await header.boundingBox();
        expect(box, `Expected a box for ${projectId}`).not.toBeNull();
        return { projectId, y: box.y };
      }),
    );
  }).toPass({ timeout: 15_000 });
  return positions
    .sort((left, right) => left.y - right.y)
    .map(({ projectId }) => projectId);
}

async function useLegacyRail(window) {
  await window.evaluate((key) => {
    window.localStorage.setItem(key, '0');
  }, SHARED_SIDEBAR_STORAGE_KEY);
  await window.reload();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
}

async function openProjectsSortMenu(window) {
  await window.getByTestId('sidebar-section-code-toggle').hover();
  await window.getByTestId('sidebar-section-code-more').click();
}

async function openProjectOptionsMenu(window, projectId) {
  const header = window.getByTestId(`sidebar-project-header-${projectId}`);
  await expect(header).toBeVisible();
  await waitForStableLocator(window, header);
  await header.hover();
  const optionsButton = header.getByTestId('workspace-project-options-button');
  await expect(optionsButton).toBeVisible();
  await optionsButton.focus();
  await window.keyboard.press('Enter');
}

test('shared worktree rows preserve manual defaults and pins when opting into recency', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-row-recency-'),
  );
  const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 4,
    chatEntryCount: 1,
  });
  const projectId = CHATS_SECTION_CODE_WORKSPACE_ID;
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    projectId,
    'worktrees.json',
  );
  const stored = readJson(worktreesPath);
  writeJson(worktreesPath, {
    ...stored,
    worktrees: stored.worktrees.map((worktree, index) => ({
      ...worktree,
      order: index,
      pinned: index === 0,
      // Keep every row's recency ahead of startup's live activity watermark,
      // so the entire unpinned tail has a deterministic descending order.
      lastTouchedAt: [
        '2099-01-01T00:00:00.000Z',
        '2099-01-02T00:00:00.000Z',
        '2099-01-04T00:00:00.000Z',
        '2099-01-03T00:00:00.000Z',
      ][index],
    })),
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await expect(window.getByTestId('sidebar-shared-rail')).toBeVisible();
    const rows = window
      .getByTestId(`sidebar-project-${projectId}`)
      .getByTestId('worktree-row');
    const rowIds = () =>
      rows.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-worktree-id')),
      );
    await expect.poll(rowIds).toEqual(worktreeIds);
    // Grouped rails (#4573) wrap every row in a drag source and mark the ones
    // the current sort cannot reorder.
    const sortableRows = window
      .getByTestId(`sidebar-project-${projectId}`)
      .locator('[data-sidebar-group-drag-source]:not([data-drag-disabled])');
    await expect(sortableRows).toHaveCount(4);
    await openProjectOptionsMenu(window, projectId);
    await expect(
      window.getByTestId('workspace-item-sort-manual'),
    ).toHaveAttribute('aria-checked', 'true');
    await window.getByTestId('workspace-item-sort-last-updated').click();
    await expect
      .poll(
        () =>
          readJson(
            path.join(userDataDir, 'workspaces', projectId, 'workspace.json'),
          ).itemSortMode,
      )
      .toBe('last-updated');
    await expect
      .poll(rowIds)
      .toEqual([
        worktreeIds[0],
        worktreeIds[2],
        worktreeIds[3],
        worktreeIds[1],
      ]);
    // Recency still lets every row change group membership (#4521: "recency
    // mode changes membership while preserving canonical order"), so each
    // row stays a drag source; the order assertions above own recency.
    await expect(sortableRows).toHaveCount(4);
    await openProjectOptionsMenu(window, projectId);
    await window.getByTestId('workspace-item-sort-manual').click();
    await expect.poll(rowIds).toEqual(worktreeIds);
    await expect(sortableRows).toHaveCount(4);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('fresh activity does not move a project in the default manual order', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'sidebar-sort-'));
  const first = await launchCanopy({
    userDataDir,
    seedDemoWorkspaces: true,
    demoWorkspaceApps: DEMO_APPS,
  });
  let manualOrder;
  try {
    const window = await first.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await useLegacyRail(window);
    manualOrder = await renderedProjectOrder(window);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // The bottom project becomes the most recently active one, as it does when
  // the user creates a worktree in it.
  const bottomProjectId = manualOrder.at(-1);
  touchProjectWorktrees(userDataDir, bottomProjectId);

  const second = await launchCanopy({ userDataDir });
  try {
    const window = await second.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    // localStorage lives in the reused profile, so the legacy rail persists.
    await expect(window.getByTestId('sidebar-shared-rail')).toHaveCount(0);

    await expect.poll(() => renderedProjectOrder(window)).toEqual(manualOrder);

    // Projects section: Manual order is the checked choice.
    await openProjectsSortMenu(window);
    await expect(
      window.getByTestId('sidebar-projects-sort-manual'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId('sidebar-projects-sort-last-updated'),
    ).toHaveAttribute('aria-checked', 'false');

    // Opting into Last updated still works and moves the active project up.
    await window.getByTestId('sidebar-projects-sort-last-updated').click();
    await expect
      .poll(async () => (await renderedProjectOrder(window))[0])
      .toBe(bottomProjectId);
    await expect
      .poll(
        () =>
          readJson(path.join(userDataDir, 'preferences.json')).preferences
            .sidebarProjectSortMode,
      )
      .toBe('last-updated');
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('project rows default to manual order and persist an opt-in to Last updated', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-yarn-cli'],
  });

  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });

    await openProjectOptionsMenu(window, 'demo-ts-yarn-cli');
    const manual = window.getByTestId('workspace-item-sort-manual');
    const lastUpdated = window.getByTestId('workspace-item-sort-last-updated');
    await expect(manual).toHaveAttribute('aria-checked', 'true');
    await expect(lastUpdated).toHaveAttribute('aria-checked', 'false');

    await lastUpdated.click();
    const configPath = path.join(
      userDataDir,
      'workspaces',
      'demo-ts-yarn-cli',
      'workspace.json',
    );
    await expect
      .poll(() => readJson(configPath).itemSortMode)
      .toBe('last-updated');

    await openProjectOptionsMenu(window, 'demo-ts-yarn-cli');
    await expect(lastUpdated).toHaveAttribute('aria-checked', 'true');
    await manual.click();
    await expect.poll(() => readJson(configPath).itemSortMode).toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an upgrading profile moves from Last updated to manual order once', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'sidebar-sort-up-'));
  // Every profile from the recency-default era serialized `last-updated`.
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { sidebarProjectSortMode: 'last-updated' },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });

    await openProjectsSortMenu(window);
    await expect(
      window.getByTestId('sidebar-projects-sort-manual'),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      readJson(path.join(userDataDir, 'preferences.json')).preferences
        .sidebarProjectSortMode,
    ).toBe('manual');
    expect(
      readJson(path.join(userDataDir, 'migrations.json'))
        .sidebar_manual_sort_default,
    ).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a new worktree lands at the top of its project in manual order', async () => {
  const projectId = 'demo-ts-yarn-cli';
  const projectName = 'TypeScript Yarn CLI';
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-yarn-cli'],
  });

  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });

    const section = window.getByTestId(`sidebar-project-${projectId}`);
    const rowIds = () =>
      section
        .locator('[data-testid="worktree-row"]')
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-worktree-id')),
        );
    await expect.poll(rowIds).toHaveLength(1);
    const [existingId] = await rowIds();

    const header = window.getByTestId(`sidebar-project-header-${projectId}`);
    await waitForStableLocator(window, header);
    await header.hover();
    await window
      .getByRole('button', { name: `Create worktree for ${projectName}` })
      .click();

    const selected = window
      .locator('[data-sidebar-selected-item] [data-testid="worktree-row"]')
      .first();
    await expect(selected).toBeVisible({ timeout: 30_000 });
    const createdId = await selected.getAttribute('data-worktree-id');
    expect(createdId).not.toBe(existingId);

    await expect.poll(rowIds).toEqual([createdId, existingId]);
    await expect
      .poll(() =>
        readJson(
          path.join(userDataDir, 'workspaces', projectId, 'worktrees.json'),
        ).worktrees.map((worktree) => worktree.id),
      )
      .toEqual([createdId, existingId]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
