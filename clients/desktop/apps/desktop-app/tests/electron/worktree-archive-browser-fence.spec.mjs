// A crashed worktree deletion leaves that worktree's browser profile fenced
// (retirement_pending with a dead initiator) and, when its checkout is also
// gone, the fence's outcome is uncertain. That uncertainty must stay scoped to
// its own worktree: startup recovery of the affected worktree adopts the
// crashed retirement, and deleting any other worktree succeeds, instead of
// every deletion failing with "The browser task archive outcome is uncertain".
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  captureDaemonDryRunEvidence,
  closeCanopy,
  launchCanopy,
} from './launchCanopy.mjs';
import { chatPanelLocator } from './panelHarness.mjs';
import { seedArchiveActivityFixture } from './seeders/archiveActivityFixture.mjs';
import { seedBrowserProfileState } from './seeders/browser-profile-state.mjs';

function worktreeRow(window, workspaceId, worktreeId) {
  return window.locator(
    `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"][data-project-id="${workspaceId}"]`,
  );
}

async function requestWorktreeDeletion(window, row) {
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-delete').click();
  const dialog = window.getByRole('dialog', { name: /^Delete worktree/ });
  // A clean worktree can delete directly; otherwise confirm branch handling.
  const confirmationRequired = await dialog
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (confirmationRequired) {
    await dialog.getByTestId('worktree-removal-preserve-branch').click();
  }
}

test('a crashed deletion fences only its own browser profile and never blocks worktree deletion', async () => {
  test.setTimeout(240_000);
  const { userDataDir, workspace, original, otherId } =
    seedArchiveActivityFixture();
  const first = await launchCanopy({ userDataDir });
  try {
    const window = await first.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    for (const worktreeId of [otherId, original.id]) {
      await app.selectWorktree(worktreeId);
      await expect(chatPanelLocator(window)).toBeVisible();
      const browser = await seedBrowserProfileState(first.electronApp, window, {
        projectId: workspace.id,
        worktreeId,
      });
      // The profile slot persists; close the tab so the next seed's fixture
      // URL is unambiguous.
      await window.evaluate(
        (browserId) => window.api.browser.destroy({ browserId }),
        browser.browserId,
      );
    }

    // Hold the deletion after browser retirement is prepared, then crash.
    await first.electronApp.evaluate(
      (_electron, scope) => {
        const activity = globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__;
        if (!activity) throw new Error('Archive activity seam is unavailable');
        const service = activity.getChatStateService();
        const capture = service.captureStorageScope.bind(service);
        globalThis.__browserFenceArchiveHeld = false;
        service.captureStorageScope = async (target, ...rest) => {
          if (
            target?.projectId === scope.projectId &&
            target?.worktreeId === scope.worktreeId
          ) {
            globalThis.__browserFenceArchiveHeld = true;
            await new Promise(() => {});
          }
          return capture(target, ...rest);
        };
      },
      { projectId: workspace.id, worktreeId: original.id },
    );
    await requestWorktreeDeletion(
      window,
      worktreeRow(window, workspace.id, original.id),
    );
    await expect
      .poll(
        () =>
          first.electronApp.evaluate(
            () => globalThis.__browserFenceArchiveHeld,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await captureDaemonDryRunEvidence(first.electronApp);
    const mainPid = await first.electronApp.evaluate(() => process.pid);
    process.kill(mainPid, 'SIGKILL');
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // The interrupted deletion had removed the checkout; the registry row stays.
  rmSync(workspace.worktreePath, { recursive: true, force: true });

  const second = await launchCanopy({ userDataDir });
  try {
    const window = await second.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const uncertain = window.getByText(/archive outcome is uncertain/);

    // Startup recovery retries the interrupted deletion of the missing
    // checkout; it adopts the crashed browser retirement and completes.
    const stuckRow = worktreeRow(window, workspace.id, original.id);
    await expect(stuckRow).toHaveCount(0, { timeout: 60_000 });

    const otherRow = worktreeRow(window, workspace.id, otherId);
    await expect(otherRow).toBeVisible({ timeout: 30_000 });
    await requestWorktreeDeletion(window, otherRow);
    await expect(otherRow).toHaveCount(0, { timeout: 60_000 });
    await expect(uncertain).toHaveCount(0);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

// A deletion holds its project's operation lock for its whole run and, once
// its container is committed, commits the browser profile retirement under the
// profile writer lease. A tab opened in a sibling worktree checks its binding
// under that lease and saves under the same operation lock. When the save ran
// inside the lease, the tab held the lease waiting for the lock and the
// deletion held the lock waiting for the lease, and every later deletion in the
// project queued behind them.
test('a browser tab opened in a sibling worktree does not wedge a deletion in progress', async () => {
  test.setTimeout(240_000);
  const { userDataDir, workspace, worktreesPath, original, otherId } =
    seedArchiveActivityFixture();
  const persistedWorktreeIds = () =>
    JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees.map(
      (worktree) => worktree.id,
    );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    // Both worktrees get a profile slot. The sibling ends up selected.
    for (const worktreeId of [original.id, otherId]) {
      await app.selectWorktree(worktreeId);
      await expect(chatPanelLocator(window)).toBeVisible();
      const browser = await seedBrowserProfileState(electronApp, window, {
        projectId: workspace.id,
        worktreeId,
      });
      await window.evaluate(
        (browserId) => window.api.browser.destroy({ browserId }),
        browser.browserId,
      );
    }

    // Pause the deletion while it captures chat storage: inside the operation
    // lock, after its retirement is prepared and before it is committed.
    await electronApp.evaluate(
      (_electron, scope) => {
        const activity = globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__;
        if (!activity) throw new Error('Archive activity seam is unavailable');
        const service = activity.getChatStateService();
        const capture = service.captureStorageScope.bind(service);
        globalThis.__siblingTabArchiveHeld = false;
        let release = () => undefined;
        const released = new Promise((resolve) => {
          release = resolve;
        });
        globalThis.__releaseSiblingTabArchive = release;
        service.captureStorageScope = async (target, ...rest) => {
          if (
            target?.projectId === scope.projectId &&
            target?.worktreeId === scope.worktreeId
          ) {
            globalThis.__siblingTabArchiveHeld = true;
            await released;
          }
          return capture(target, ...rest);
        };
      },
      { projectId: workspace.id, worktreeId: original.id },
    );
    await requestWorktreeDeletion(
      window,
      worktreeRow(window, workspace.id, original.id),
    );
    await expect
      .poll(
        () => electronApp.evaluate(() => globalThis.__siblingTabArchiveHeld),
        { timeout: 60_000 },
      )
      .toBe(true);

    // Saving browser state reserves its worktree, then waits for the
    // operation lock. With the deletion holding that lock, a reservation on
    // the sibling means the tab's save is queued behind it. Runtime starts
    // reserve the worktree too, so wait until the sibling is idle first.
    const siblingSaveIsQueued = () =>
      electronApp.evaluate(
        (_electron, scope) => {
          const activity = globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__;
          if (!activity)
            throw new Error('Archive activity seam is unavailable');
          return activity.isWorkspaceTargetRuntimeStartReserved(
            scope.projectId,
            scope.worktreeId,
          );
        },
        { projectId: workspace.id, worktreeId: otherId },
      );
    await expect.poll(siblingSaveIsQueued, { timeout: 30_000 }).toBe(false);

    // Open the sibling's tab while the deletion holds the lock, wait for its
    // save to reach the lock, then let the deletion continue to its commit.
    await window.evaluate(
      (request) => {
        window.__siblingTabOpened = window.api.browser.create(request).then(
          (browser) => ({ worktreeId: browser.worktreeId }),
          (error) => ({ error: String(error) }),
        );
      },
      { projectId: workspace.id, worktreeId: otherId },
    );
    await expect.poll(siblingSaveIsQueued, { timeout: 30_000 }).toBe(true);
    await electronApp.evaluate(() => globalThis.__releaseSiblingTabArchive());

    // A deadlock never settles, so bound the wait and report it as a result.
    const opened = await window.evaluate(
      (timeoutMs) =>
        Promise.race([
          window.__siblingTabOpened,
          new Promise((resolve) =>
            setTimeout(() => resolve({ timedOut: true }), timeoutMs),
          ),
        ]),
      45_000,
    );
    expect(opened).toEqual({ worktreeId: otherId });
    await expect
      .poll(() => persistedWorktreeIds(), { timeout: 60_000 })
      .not.toContain(original.id);
    await expect(worktreeRow(window, workspace.id, original.id)).toHaveCount(0);

    // Nothing is left holding the project: the sibling deletes too.
    const otherRow = worktreeRow(window, workspace.id, otherId);
    await expect(otherRow).toBeVisible();
    await requestWorktreeDeletion(window, otherRow);
    await expect(otherRow).toHaveCount(0, { timeout: 60_000 });
    await expect
      .poll(() => persistedWorktreeIds(), { timeout: 60_000 })
      .not.toContain(otherId);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Concurrent archives (for example an Auto Delete sweep) queue on the same
// browser profile metadata, so one archive's first profile call can outlast its
// five-second deadline and then answer seconds later. That archive used to
// skip every later profile call and finish with two persistent warnings, that
// browser tab state could not be removed and that browser data would be
// cleared at the next start, although the profile was retired a moment later.
const BROWSER_WARNING_TEXTS = [
  'Failed to remove browser tab state',
  'Browser data for this worktree will be cleared',
];

function browserRetirementState(userDataDir, workspaceId, worktreeId) {
  const catalogPath = path.join(
    userDataDir,
    'browser-profiles',
    'catalog.json',
  );
  if (!existsSync(catalogPath)) return null;
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const states = Object.values(catalog.retirements ?? {})
    .filter(
      (entry) =>
        entry.scope?.kind === 'worktree' &&
        entry.scope.projectId === workspaceId &&
        entry.scope.worktreeId === worktreeId,
    )
    .map((entry) => entry.state);
  return states.includes('committed') ? 'committed' : (states[0] ?? null);
}

/**
 * Holds this worktree's profile metadata, so the deletion's prepare outlasts
 * its deadline, and holds the deletion while it captures chat storage, after
 * that prepare and before its commit.
 */
async function holdMetadataAndDeletion(electronApp, scope) {
  await electronApp.evaluate((_electron, target) => {
    const activity = globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__;
    if (!activity) throw new Error('Archive activity seam is unavailable');
    const repository = activity.getBrowserProfileService().repository;
    const getTask = repository.getTask.bind(repository);
    let releaseMetadata = () => undefined;
    const metadataReleased = new Promise((resolve) => {
      releaseMetadata = resolve;
    });
    globalThis.__deadlineMetadataHeld = false;
    globalThis.__releaseDeadlineMetadata = releaseMetadata;
    repository.getTask = async (taskScope, ...rest) => {
      if (
        taskScope?.kind === 'worktree' &&
        taskScope.projectId === target.projectId &&
        taskScope.worktreeId === target.worktreeId
      ) {
        globalThis.__deadlineMetadataHeld = true;
        await metadataReleased;
      }
      return getTask(taskScope, ...rest);
    };
    const service = activity.getChatStateService();
    const capture = service.captureStorageScope.bind(service);
    let releaseDeletion = () => undefined;
    const deletionReleased = new Promise((resolve) => {
      releaseDeletion = resolve;
    });
    globalThis.__deadlineDeletionHeld = false;
    globalThis.__releaseDeadlineDeletion = releaseDeletion;
    service.captureStorageScope = async (captureTarget, ...rest) => {
      if (
        captureTarget?.projectId === target.projectId &&
        captureTarget?.worktreeId === target.worktreeId
      ) {
        globalThis.__deadlineDeletionHeld = true;
        await deletionReleased;
      }
      return capture(captureTarget, ...rest);
    };
  }, scope);
}

async function launchArchiveFixture() {
  const { userDataDir, workspace, worktreesPath, original } =
    seedArchiveActivityFixture();
  const { electronApp } = await launchCanopy({ userDataDir });
  return {
    electronApp,
    userDataDir,
    scope: { projectId: workspace.id, worktreeId: original.id },
    persistedWorktreeIds: () =>
      JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees.map(
        (worktree) => worktree.id,
      ),
    retirementState: () =>
      browserRetirementState(userDataDir, workspace.id, original.id),
  };
}

/** Gives the worktree a live profile slot, then closes its tab. */
async function openWithBrowserProfile(launched) {
  const { electronApp, scope } = launched;
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(scope.worktreeId);
  await expect(chatPanelLocator(window)).toBeVisible();
  const browser = await seedBrowserProfileState(electronApp, window, scope);
  await window.evaluate(
    (browserId) => window.api.browser.destroy({ browserId }),
    browser.browserId,
  );
  return {
    ...launched,
    window,
    row: worktreeRow(window, scope.projectId, scope.worktreeId),
  };
}

async function deleteWithExpiredPrepare(opened) {
  const { electronApp, window, scope, row } = opened;
  await holdMetadataAndDeletion(electronApp, scope);
  await requestWorktreeDeletion(window, row);
  // The deletion reaches chat capture only once its prepare has expired.
  await expect
    .poll(
      () =>
        electronApp.evaluate(() => ({
          metadataHeld: globalThis.__deadlineMetadataHeld,
          deletionHeld: globalThis.__deadlineDeletionHeld,
        })),
      { timeout: 60_000 },
    )
    .toEqual({ metadataHeld: true, deletionHeld: true });
  expect(opened.retirementState()).toBeNull();
}

async function expectDeletedWithoutBrowserWarnings(opened) {
  const { window, scope, row } = opened;
  await expect(row).toHaveCount(0, { timeout: 60_000 });
  await expect
    .poll(() => opened.persistedWorktreeIds(), { timeout: 60_000 })
    .not.toContain(scope.worktreeId);
  for (const text of BROWSER_WARNING_TEXTS) {
    expect(
      await window.getByTestId('toast-card').filter({ hasText: text }).count(),
    ).toBe(0);
  }
}

async function finishDeletionAfterRendererResponse(opened) {
  const { electronApp, window } = opened;
  const trailingLoadCount = await window.evaluate(() =>
    window.__canopyArchivedContainersTestApi.getTrailingLoadRequestCount(),
  );
  await electronApp.evaluate(() => globalThis.__releaseDeadlineDeletion());
  // performArchive requests this trailing load after processing the archive
  // response and adding any warning toasts. The row and persisted record can
  // disappear earlier, while deferred profile retirement is still running.
  await expect
    .poll(
      () =>
        window.evaluate(() =>
          window.__canopyArchivedContainersTestApi.getTrailingLoadRequestCount(),
        ),
      { timeout: 60_000 },
    )
    .toBe(trailingLoadCount + 1);
}

test('a profile call that outlasts its deadline leaves no browser warning once metadata answers again', async () => {
  test.setTimeout(240_000);
  const launched = await launchArchiveFixture();
  const { electronApp, userDataDir } = launched;
  try {
    const opened = await openWithBrowserProfile(launched);
    await deleteWithExpiredPrepare(opened);

    // The abandoned prepare answers while the deletion is still running.
    await electronApp.evaluate(() => globalThis.__releaseDeadlineMetadata());
    await expect
      .poll(() => opened.retirementState(), { timeout: 30_000 })
      .toBe('prepared');
    // Let the abandoned call finish closing views after its fence is written.
    await opened.window.waitForTimeout(1_000);
    await finishDeletionAfterRendererResponse(opened);

    await expectDeletedWithoutBrowserWarnings(opened);
    await expect
      .poll(() => opened.retirementState(), { timeout: 30_000 })
      .toBe('committed');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a deletion whose profile metadata stays unavailable finishes without browser warnings and retires the profile later', async () => {
  test.setTimeout(240_000);
  const launched = await launchArchiveFixture();
  const { electronApp, userDataDir } = launched;
  try {
    const opened = await openWithBrowserProfile(launched);
    await deleteWithExpiredPrepare(opened);
    await finishDeletionAfterRendererResponse(opened);

    await expectDeletedWithoutBrowserWarnings(opened);
    expect(opened.retirementState()).toBeNull();

    // Once metadata answers, the abandoned prepare retires the removed owner.
    await electronApp.evaluate(() => globalThis.__releaseDeadlineMetadata());
    await expect
      .poll(() => opened.retirementState(), { timeout: 30_000 })
      .toBe('committed');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
