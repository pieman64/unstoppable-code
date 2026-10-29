import { readChatStorageIndexes } from './readChatStorage.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';

// "Split project": dissolve a temporary multi-repo workspace worktree back
// into per-repo single-repo worktrees.
//
// Seed: two distinct single-repo demo workspaces (`ts-pnpm-vite` and
// `go-cli`), each with the default `demo-main` worktree. Every test first
// builds a REAL temporary multi-repo workspace through the production
// combine flow (actions menu → "Add project" → Existing Worktrees → join),
// then exercises the new "Split project" action on the combined worktree.
//
// Coverage across the tests below:
//   - menu gating (entry absent for single-repo worktrees, present for
//     temporary multi-repo worktrees)
//   - modal defaults (all repos default to Split) and Cancel inertness
//   - all-split: both repos become single-repo worktrees again, the
//     temporary workspace disappears, navigation lands on the first split
//     worktree (chat panel mounts)
//   - split + archive removal (destination retention enabled): removed repo
//     leaves an archived container in its destination workspace, no live
//     worktree
//   - split + delete removal (destination retention disabled → the toggle
//     reads "Delete"): removed repo is hard-deleted, no container
//   - all-archive: no split target → navigation falls back to the first
//     archive's workspace (main page, no selected worktree)
//   - all-delete: nothing survives → navigation falls back to the home screen
//
// Determinism: no live agents, no network. Combines and splits are real git
// work (worktree moves, archives, teardown) inside the per-test
// CANOPY_DATA_DIR, hence the generous step timeouts.

const SOURCE_APP_ID = 'ts-pnpm-vite';
const JOIN_APP_ID = 'go-cli';

/**
 * Read a workspace's persisted worktrees.json. Absent file → empty list;
 * unparsable content (a read racing the main process mid-write) → null so
 * pollers can retry instead of crashing.
 */
function readWorktreesFileRaw(userDataDir, workspaceId) {
  const filePath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktrees.json',
  );
  if (!fs.existsSync(filePath)) {
    return { worktrees: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Settled-state variant for direct assertions (mid-write reads → empty). */
function readWorktreesFile(userDataDir, workspaceId) {
  return readWorktreesFileRaw(userDataDir, workspaceId) ?? { worktrees: [] };
}

/** List archived container ids for a workspace ([] when none). */
function listArchivedContainers(userDataDir, workspaceId) {
  const dirPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'archived-containers',
  );
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Disable archived-container retention so removal means hard delete. */
function disableArchiveRetention(userDataDir, workspaceId) {
  const filePath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'workspace.json',
  );
  const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  config.archiveRetentionDays = null;
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Launch with both demo workspaces seeded and return the driver plus the two
 * seeded workspace summaries.
 */
async function launchWithTwoWorkspaces() {
  const { electronApp, userDataDir, demoSeed } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [SOURCE_APP_ID, JOIN_APP_ID],
  });
  const sourceWorkspace = demoSeed.workspaces.find(
    (workspace) => workspace.id === `demo-${SOURCE_APP_ID}`,
  );
  const joinWorkspace = demoSeed.workspaces.find(
    (workspace) => workspace.id === `demo-${JOIN_APP_ID}`,
  );
  expect(sourceWorkspace, 'seeded source project').toBeTruthy();
  expect(joinWorkspace, 'seeded join project').toBeTruthy();

  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await expect(app.workspaceHeaderLabel(sourceWorkspace.name)).toBeVisible();
  await expect(app.workspaceHeaderLabel(joinWorkspace.name)).toBeVisible();

  return {
    electronApp,
    userDataDir,
    window,
    app,
    sourceWorkspace,
    joinWorkspace,
  };
}

/** Open the hover-revealed actions menu for a worktree row. */
async function openWorktreeActionsMenu(window, row) {
  await row.hover();
  const actionsButton = row.getByTestId('worktree-actions-menu-button');
  await expect(actionsButton).toBeVisible();
  await actionsButton.click();
  await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
}

/** Locator for the named workspace's sidebar/list section. */
function workspaceSectionLocator(window, workspaceName) {
  return window
    .locator('section')
    .filter({ has: window.getByText(workspaceName) })
    .first();
}

/**
 * Combine the two seeded single-repo worktrees into a temporary multi-repo
 * worktree through the production join-existing flow, and return the
 * resulting combined worktree row (the only remaining `demo-main` row).
 */
async function combineIntoTemporaryWorkspace(
  window,
  sourceWorkspace,
  joinWorkspace,
) {
  const sourceBranch = path.basename(sourceWorkspace.worktreePath);
  const joinWorktreeId = path.basename(joinWorkspace.worktreePath);

  const sourceSection = window
    .locator('section')
    .filter({ has: window.getByText(sourceWorkspace.name) });
  const sourceRow = sourceSection.locator(
    `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
  );
  await expect(sourceRow).toBeVisible();

  await sourceRow.hover();
  const actionsButton = sourceSection.getByTestId(
    'worktree-actions-menu-button',
  );
  await expect(actionsButton).toBeVisible();
  await actionsButton.click();
  await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
  await window.getByTestId('worktree-actions-menu-add-repo').click();

  const modal = window.getByTestId('add-repo-to-worktree-modal');
  await expect(modal).toBeVisible();
  await modal.getByTestId('add-repo-to-worktree-modal-pill-existing').click();
  const pickerList = window.getByTestId('existing-worktree-picker-list');
  await expect(pickerList).toBeVisible({ timeout: 30_000 });
  const candidateOption = pickerList.getByTestId(
    `existing-worktree-picker-option-${joinWorkspace.id}-${joinWorktreeId}`,
  );
  await expect(candidateOption).toBeVisible();
  await candidateOption.click();
  const submitButton = window.getByTestId('add-repo-to-worktree-modal-submit');
  await expect(submitButton).toBeEnabled();
  await submitButton.click();
  await expect(modal).toHaveCount(0, { timeout: 60_000 });
  await expect(
    window.getByTestId('add-repo-to-worktree-modal-error'),
  ).toHaveCount(0);

  // Both originals were consumed; the single remaining `demo-main` row is the
  // combined worktree in the new temporary multi-repo workspace.
  const combinedRow = window.locator(
    `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
  );
  await expect(combinedRow).toHaveCount(1, { timeout: 30_000 });
  return combinedRow;
}

/** Open the Split workspace modal from a combined temporary worktree row. */
async function openSplitModal(window, combinedRow) {
  await openWorktreeActionsMenu(window, combinedRow);
  const splitEntry = window.getByTestId(
    'worktree-actions-menu-split-workspace',
  );
  await expect(splitEntry).toBeVisible();
  await splitEntry.click();
  const modal = window.getByTestId('split-workspace-modal');
  await expect(modal).toBeVisible();
  // Rows render instantly from the workspace record — no preview round-trip
  // is needed for the list itself.
  await expect(
    modal.locator(
      '[data-testid^="split-workspace-modal-repo-"][data-testid$="-split"]',
    ),
  ).toHaveCount(2);
  // The destination mapping loads in the background and gates the confirm
  // button; wait for it so subsequent label/mode assertions see final data.
  await expect(modal.getByTestId('split-workspace-modal-confirm')).toBeEnabled({
    timeout: 30_000,
  });
  return modal;
}

/** Arm the authoritative terminal event before clicking the split button. */
async function armSplitCompletion(window, temporaryWorkspaceId, worktreeId) {
  await window.evaluate(
    ({ workspaceId, sourceWorktreeId }) => {
      window.__canopyE2eSplitToasts = [];
      window.__canopyE2eSplitEvents = [];
      window.__canopyE2eSplitObserver?.disconnect();
      window.__canopyE2eSplitObserver = new MutationObserver(() => {
        for (const card of document.querySelectorAll(
          '[data-testid="toast-card"]',
        )) {
          const text = card.textContent;
          if (text && !window.__canopyE2eSplitToasts.includes(text))
            window.__canopyE2eSplitToasts.push(text);
        }
      });
      window.__canopyE2eSplitObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      window.__canopyE2eSplitCompletion = new Promise((resolve) => {
        const unsubscribe = window.api.onWorkspaceSplitTemporaryComplete(
          (event) => {
            window.__canopyE2eSplitEvents.push(event);
            if (
              event.workspaceId !== workspaceId ||
              event.worktreeId !== sourceWorktreeId
            ) {
              return;
            }
            unsubscribe();
            resolve(event);
          },
        );
      });
    },
    { workspaceId: temporaryWorkspaceId, sourceWorktreeId: worktreeId },
  );
}

/**
 * Wait for the background split phase to finish. The terminal IPC event is
 * authoritative; the empty source worktrees file is then a persisted-state
 * assertion instead of an indirect completion probe.
 */
async function waitForSplitCompletion(
  window,
  userDataDir,
  temporaryWorkspaceId,
) {
  const completion = await window.evaluate(() =>
    Promise.race([
      window.__canopyE2eSplitCompletion,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Project split did not complete: ${JSON.stringify({ toasts: window.__canopyE2eSplitToasts, events: window.__canopyE2eSplitEvents })}`,
              ),
            ),
          90_000,
        ),
      ),
    ]),
  );
  expect(completion, JSON.stringify(completion, null, 2)).toMatchObject({
    success: true,
  });

  await expect
    .poll(
      () => {
        const file = readWorktreesFileRaw(userDataDir, temporaryWorkspaceId);
        // A mid-write read must keep polling rather than count as "empty".
        return file === null ? -1 : file.worktrees.length;
      },
      { timeout: 90_000 },
    )
    .toBe(0);
}

test.describe('split temporary multi-repo project worktree', () => {
  test('menu gating, split defaults, cancel, and all-split with navigation', async () => {
    test.setTimeout(300_000);
    const { electronApp, userDataDir, window, sourceWorkspace, joinWorkspace } =
      await launchWithTwoWorkspaces();
    try {
      const sourceBranch = path.basename(sourceWorkspace.worktreePath);

      // A 3-line untracked file gives the source repo a non-zero diff so the
      // modal's per-repo diff badge has something to show. It rides along
      // through the combine (checkout moves preserve working-tree state).
      fs.writeFileSync(
        path.join(sourceWorkspace.worktreePath, 'SPLIT_DIFF_PROBE.txt'),
        'one\ntwo\nthree\n',
        'utf8',
      );

      // Gating: a single-repo workspace worktree offers "Add project" but
      // never "Split project".
      const sourceSection = window
        .locator('section')
        .filter({ has: window.getByText(sourceWorkspace.name) });
      const sourceRow = sourceSection.locator(
        `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
      );
      await openWorktreeActionsMenu(window, sourceRow);
      await expect(
        window.getByTestId('worktree-actions-menu-add-repo'),
      ).toBeVisible();
      await expect(
        window.getByTestId('worktree-actions-menu-split-workspace'),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('worktree-actions-menu')).toHaveCount(0);

      const combinedRow = await combineIntoTemporaryWorkspace(
        window,
        sourceWorkspace,
        joinWorkspace,
      );

      // The temporary multi-repo worktree offers the split entry; the modal
      // defaults every repo to "Split".
      let modal = await openSplitModal(window, combinedRow);
      const splitToggles = modal.locator(
        '[data-testid^="split-workspace-modal-repo-"][data-testid$="-split"]',
      );
      await expect(splitToggles.nth(0)).toHaveAttribute('aria-pressed', 'true');
      await expect(splitToggles.nth(1)).toHaveAttribute('aria-pressed', 'true');

      // Per-repo diff stats render inline and are scoped to each repo's own
      // checkout: the probed source repo shows a nonzero + count while the
      // untouched join repo stays at +0 (rather than both showing the
      // worktree-wide total).
      const diffBadges = modal.locator('[data-testid$="-diff"]');
      await expect(diffBadges).toHaveCount(2, { timeout: 30_000 });
      await expect(diffBadges.filter({ hasText: /\+[1-9]/ })).toHaveCount(1);
      await expect(diffBadges.filter({ hasText: '+0' })).toHaveCount(1);

      // Cancel is inert: the modal closes, the combined worktree stays, and
      // no destination worktrees appear.
      await modal.getByTestId('split-workspace-modal-cancel').click();
      await expect(modal).toHaveCount(0);
      await expect(combinedRow).toHaveCount(1);
      expect(
        readWorktreesFile(userDataDir, sourceWorkspace.id).worktrees,
      ).toHaveLength(0);
      expect(
        readWorktreesFile(userDataDir, joinWorkspace.id).worktrees,
      ).toHaveLength(0);

      // Confirm the default all-split. The label spells out the action, the
      // non-destructive selection keeps the accent styling, and confirming
      // closes the modal immediately — the split continues in the background.
      modal = await openSplitModal(window, combinedRow);
      const temporaryWorkspaceId =
        await combinedRow.getAttribute('data-project-id');
      const confirmButton = modal.getByTestId('split-workspace-modal-confirm');
      await expect(confirmButton).toHaveText('Split 2 and Archive 1');
      await expect(confirmButton).toHaveAttribute('data-danger', 'false');
      await armSplitCompletion(window, temporaryWorkspaceId, 'demo-main');
      await confirmButton.click();
      await expect(modal).toHaveCount(0, { timeout: 2_000 });

      // Optimistic landing: the destination worktree is selected (chat panel
      // mounts, in its setting-up state) as soon as the fast phase returns —
      // without waiting for the background split or a full sidebar reload.
      await expect(
        window.locator('[data-testid="panel-content-chat"]:visible'),
      ).toBeVisible({ timeout: 10_000 });

      // Both repos are single-repo worktrees again, each in its own
      // workspace section; the temporary workspace section is gone.
      const branchRows = window.locator(
        `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
      );
      await expect(branchRows).toHaveCount(2, { timeout: 30_000 });
      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-project-id="${sourceWorkspace.id}"]`,
        ),
      ).toHaveCount(1);
      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-project-id="${joinWorkspace.id}"]`,
        ),
      ).toHaveCount(1);

      await waitForSplitCompletion(window, userDataDir, temporaryWorkspaceId);
      expect(
        readWorktreesFile(userDataDir, sourceWorkspace.id).worktrees,
      ).toHaveLength(1);
      expect(
        readWorktreesFile(userDataDir, joinWorkspace.id).worktrees,
      ).toHaveLength(1);
      expect(listArchivedContainers(userDataDir, sourceWorkspace.id)).toEqual(
        [],
      );
      expect(listArchivedContainers(userDataDir, joinWorkspace.id)).toEqual([]);

      // The success toast details what completed instead of a bare
      // "Project split".
      await expect(
        window.getByText(/Project split: Moved .* to their own projects/),
      ).toBeVisible({ timeout: 15_000 });

      // Navigation: the first split worktree is selected, mounting its chat
      // panel.
      await expect(
        window.locator('[data-testid="panel-content-chat"]:visible'),
      ).toBeVisible({ timeout: 30_000 });

      // Regression (join → split → join again): combining the split-out
      // source worktree with the same join workspace used to fail with git's
      // "branch is already checked out" — the split left the join repo's
      // branch checked out at its own destination worktree. The combine now
      // falls back to a fresh branch at the same commit.
      const splitSourceRow = window.locator(
        `[data-testid="worktree-row"][data-project-id="${sourceWorkspace.id}"]`,
      );
      await openWorktreeActionsMenu(window, splitSourceRow);
      await window.getByTestId('worktree-actions-menu-add-repo').click();
      const rejoinModal = window.getByTestId('add-repo-to-worktree-modal');
      await expect(rejoinModal).toBeVisible();
      const rejoinOption = rejoinModal.getByTestId(
        `add-repo-to-worktree-modal-option-${joinWorkspace.id}`,
      );
      await expect(rejoinOption).toBeVisible({ timeout: 30_000 });
      await rejoinOption.click();
      await rejoinModal
        .getByTestId('add-repo-to-worktree-modal-submit')
        .click();
      // The modal only closes on success; the previous behavior surfaced the
      // git error inline and stayed open.
      await expect(rejoinModal).toHaveCount(0, { timeout: 60_000 });
      await expect(
        window.getByTestId('add-repo-to-worktree-modal-error'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('split one repo and archive the other, moving repo-scoped chats and archiving root items', async () => {
    test.setTimeout(300_000);
    // Seed legacy chats before the first launch. Once startup has selected
    // native storage, writing a legacy file cannot replace its canonical data.
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-split-transcripts-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: [SOURCE_APP_ID, JOIN_APP_ID],
    });
    const sourceWorkspace = demoSeed.workspaces.find(
      (workspace) => workspace.id === `demo-${SOURCE_APP_ID}`,
    );
    const joinWorkspace = demoSeed.workspaces.find(
      (workspace) => workspace.id === `demo-${JOIN_APP_ID}`,
    );
    expect(sourceWorkspace, 'seeded source project').toBeTruthy();
    expect(joinWorkspace, 'seeded join project').toBeTruthy();

    // The chat seeded into the source worktree becomes repo-scoped after the
    // combine (the renderer migration stamps `selectedRepoId`), so the split
    // modal must count it on the source repo's row and migrate it to the
    // split destination.
    // The open file tab must migrate with the repo (by file path) but stay
    // out of the modal's chat counters.
    seedWorktreeChat({
      userDataDir,
      workspaceId: sourceWorkspace.id,
      worktreeId: path.basename(sourceWorkspace.worktreePath),
      providerType: 'claude',
      tabs: [
        {
          id: 'seeded-split-chat',
          title: 'Seeded Split Chat',
          blocks: [{ type: 'text', text: 'Seeded transcript content' }],
        },
        {
          id: 'seeded-file-tab',
          title: 'Seeded File Tab',
          kind: 'file',
          filePath: path.join(sourceWorkspace.worktreePath, 'package.json'),
        },
      ],
    });

    let { electronApp } = await launchCanopy({ userDataDir });
    try {
      let window = await electronApp.firstWindow();
      let app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await expect(
        app.workspaceHeaderLabel(sourceWorkspace.name),
      ).toBeVisible();

      const sourceBranch = path.basename(sourceWorkspace.worktreePath);
      let combinedRow = await combineIntoTemporaryWorkspace(
        window,
        sourceWorkspace,
        joinWorkspace,
      );
      const temporaryWorkspaceId =
        await combinedRow.getAttribute('data-project-id');
      const temporaryWorktreeId =
        await combinedRow.getAttribute('data-worktree-id');
      const temporaryWorktreeRoot = path.join(
        userDataDir,
        'workspaces',
        temporaryWorkspaceId,
        'worktrees',
        temporaryWorktreeId,
      );
      // The destination row is published before the two source-chat
      // migrations finish. Wait for the migrated chat's actual UI handoff
      // before shutting down; row creation alone is not migration completion.
      await expect(
        window
          .locator('[data-testid^="panel-tab-panel-chat-"]')
          .filter({ hasText: 'Seeded Split Chat' }),
      ).toBeVisible({ timeout: 30_000 });

      // Shut down before augmenting the combined chat fixture. The split
      // preview durably flushes the renderer's in-memory chat state first, so
      // a disk-only edit made while the app is running is intentionally
      // overwritten. Relaunching below hydrates the pending question through
      // the real renderer persistence path before the preview flushes it.
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = undefined;

      const unmanagedRepoPayloadPath = path.join(
        temporaryWorktreeRoot,
        'repos',
        'personal-notes',
        'idea.txt',
      );
      fs.mkdirSync(path.dirname(unmanagedRepoPayloadPath), {
        recursive: true,
      });
      fs.writeFileSync(unmanagedRepoPayloadPath, 'preserve this\n', 'utf8');

      // A worktree attachment is tied to the workspace root, so the modal
      // must show the leading "Project Root" row (Archive default).
      const attachmentsDir = path.join(
        userDataDir,
        'workspaces',
        temporaryWorkspaceId,
        'attachments',
        temporaryWorktreeId,
      );
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(attachmentsDir, 'root-note.txt'),
        'root attachment\n',
        'utf8',
      );

      // An archived chat scoped to the source repo must appear in the chat
      // counter (marked archived) and migrate with the split. It is created
      // through canonical chat commands after relaunch below.
      const temporaryConfig = JSON.parse(
        fs.readFileSync(
          path.join(
            userDataDir,
            'workspaces',
            temporaryWorkspaceId,
            'workspace.json',
          ),
          'utf8',
        ),
      );
      const sourceRepoInTemp = temporaryConfig.repos.find(
        (repo) => repo.repoPath === sourceWorkspace.repoPath,
      );
      expect(sourceRepoInTemp, 'source repo inside temp project').toBeTruthy();
      const { live: temporaryChats } = readChatStorageIndexes(
        path.join(userDataDir, 'workspaces', temporaryWorkspaceId),
        temporaryWorktreeId,
      );
      const migratedChatId = temporaryChats.tabs.find(
        (tab) => tab.title === 'Seeded Split Chat',
      )?.id;
      expect(migratedChatId, 'combined chat id').toBeTruthy();
      // Model a retained question from an interrupted historical session.
      // Seed while the app is stopped: the provider upsert ingress also
      // creates an active awaiting_input turn, which correctly blocks split.
      fs.writeFileSync(
        path.join(
          userDataDir,
          'workspaces',
          temporaryWorkspaceId,
          'chat-storage-v2',
          temporaryWorktreeId,
          'live-index.json',
        ),
        JSON.stringify({
          ...temporaryChats,
          runtimeByChatId: {
            ...temporaryChats.runtimeByChatId,
            [migratedChatId]: {
              ...temporaryChats.runtimeByChatId[migratedChatId],
              status: 'interrupted',
              queuedMessageIds: [],
            },
          },
          pendingQuestions: [
            {
              requestId: 'seeded-split-question',
              chatId: migratedChatId,
              questions: [],
            },
          ],
        }),
      );
      // Dirty the to-be-archived repo's checkout (untracked file) so the
      // archive teardown exercises the forced worktree removal path — a
      // proper archive must clean the checkout up regardless.
      const joinCheckoutInTemp = path.join(
        userDataDir,
        'workspaces',
        temporaryWorkspaceId,
        'worktrees',
        temporaryWorktreeId,
        'repos',
        temporaryConfig.repos.find(
          (repo) => repo.repoPath !== sourceWorkspace.repoPath,
        ).id,
      );
      fs.writeFileSync(
        path.join(joinCheckoutInTemp, 'ARCHIVE_DIRTY_PROBE.txt'),
        'dirty before archive\n',
        'utf8',
      );

      ({ electronApp } = await launchCanopy({ userDataDir }));
      window = await electronApp.firstWindow();
      app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      combinedRow = window.locator(
        `[data-testid="worktree-row"][data-project-id="${temporaryWorkspaceId}"][data-worktree-id="${temporaryWorktreeId}"]`,
      );
      await expect(combinedRow).toBeVisible({ timeout: 30_000 });
      await app.selectWorktree(temporaryWorktreeId);
      await expect(
        window.locator('[data-testid="panel-content-chat"]:visible'),
      ).toBeVisible({ timeout: 30_000 });

      // Relaunch hydrates the pending question into both the renderer and the
      // canonical main-owned state before the split preview flushes the scope.
      await expect
        .poll(
          () =>
            window.evaluate(
              async ({ projectId, worktreeId }) =>
                (await window.api.chat.getState({ projectId, worktreeId }))
                  .tabsFile.pendingQuestions,
              {
                projectId: temporaryWorkspaceId,
                worktreeId: temporaryWorktreeId,
              },
            ),
          { timeout: 30_000 },
        )
        .toEqual([
          {
            requestId: 'seeded-split-question',
            chatId: migratedChatId,
            questions: [],
          },
        ]);

      // Seed the archived sibling through canonical commands; a migrated
      // scope must never read a newly written legacy archive snapshot.
      const archiveSeedResults = await window.evaluate(
        async ({ projectId, worktreeId, selectedRepoId }) => {
          const results = [];
          for (const command of [
            {
              type: 'chat.create_tab',
              tabId: 'seeded-archived-chat',
              title: 'Seeded Archived Chat',
              selectedRepoId,
            },
            {
              type: 'chat.close_tab',
              tabId: 'seeded-archived-chat',
              mode: 'archive',
            },
          ]) {
            results.push(
              await window.api.chat.command({
                schemaVersion: 1,
                commandId: crypto.randomUUID(),
                projectId,
                worktreeId,
                command,
              }),
            );
          }
          return results;
        },
        {
          projectId: temporaryWorkspaceId,
          worktreeId: temporaryWorktreeId,
          selectedRepoId: sourceRepoInTemp.id,
        },
      );
      expect(archiveSeedResults.map((result) => result.outcome)).toEqual([
        'applied',
        'applied',
      ]);

      const modal = await openSplitModal(window, combinedRow);

      // The source repo row counts its migrated chat; hovering the counter
      // lists the chat title in the badge-popover tooltip.
      const sourceRepoRow = modal
        .locator('[data-testid^="split-workspace-modal-repo-"]')
        .filter({ hasText: sourceWorkspace.name })
        .first();
      const chatCounter = sourceRepoRow.locator('[data-testid$="-chats"]');
      await expect(chatCounter).toBeVisible();
      await chatCounter.hover();
      const chatTooltip = window.getByRole('tooltip');
      await expect(chatTooltip.getByText('Seeded Split Chat')).toBeVisible();
      // The archived chat is listed too, marked with the archive icon…
      await expect(chatTooltip.getByText('Seeded Archived Chat')).toBeVisible();
      await expect(
        chatTooltip.getByTestId('split-workspace-modal-tooltip-archived'),
      ).toHaveCount(1);
      // …while the open file tab is intentionally not shown as a chat.
      await expect(chatTooltip.getByText('Seeded File Tab')).toHaveCount(0);
      await window.mouse.move(0, 0);

      // Workspace Root row: first entry, Archive selected by default, with
      // the attachment counted.
      const rootRow = modal.getByTestId('split-workspace-modal-root');
      await expect(rootRow).toBeVisible();
      await expect(
        modal
          .locator(
            '[data-testid="split-workspace-modal-root"], [data-testid^="split-workspace-modal-repo-"]:not([data-testid$="-split"]):not([data-testid$="-remove"]):not([data-testid$="-destination"]):not([data-testid$="-diff"]):not([data-testid$="-chats"]):not([data-testid$="-pipelines"]):not([data-testid$="-plans"])',
          )
          .first(),
      ).toHaveAttribute('data-testid', 'split-workspace-modal-root');
      await expect(
        rootRow.getByTestId('split-workspace-modal-root-attachments'),
      ).toHaveText('1');
      const rootArchiveToggle = rootRow.getByTestId(
        'split-workspace-modal-root-archive',
      );
      await expect(rootArchiveToggle).toHaveAttribute('aria-label', 'Archive');
      await expect(rootArchiveToggle).toHaveAttribute('data-selected', 'true');

      // The join workspace keeps default retention, so its removal toggle is
      // the Archive icon.
      const joinRepoRow = modal
        .locator('[data-testid^="split-workspace-modal-repo-"]')
        .filter({ hasText: joinWorkspace.name })
        .first();
      await expect(joinRepoRow).toBeVisible();
      const removeToggle = joinRepoRow.locator('[data-testid$="-remove"]');
      await expect(removeToggle).toHaveAttribute('aria-label', 'Archive');
      await removeToggle.click();
      await expect(removeToggle).toHaveAttribute('aria-pressed', 'true');
      await expect(removeToggle).toHaveAttribute('data-selected', 'true');

      // Counts: source repo split, join repo archived, root archived.
      const confirmButton = modal.getByTestId('split-workspace-modal-confirm');
      await expect(confirmButton).toHaveText('Split 1 and Archive 2');
      await expect(confirmButton).toHaveAttribute('data-danger', 'false');
      await armSplitCompletion(
        window,
        temporaryWorkspaceId,
        temporaryWorktreeId,
      );
      await confirmButton.click();
      await expect(modal).toHaveCount(0, { timeout: 2_000 });

      // The split repo lives on as a single-repo worktree; the archived repo
      // has no live worktree but leaves an archived container in its
      // destination workspace.
      await waitForSplitCompletion(window, userDataDir, temporaryWorkspaceId);
      const branchRows = window.locator(
        `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
      );
      await expect(branchRows).toHaveCount(1, { timeout: 30_000 });
      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-project-id="${sourceWorkspace.id}"]`,
        ),
      ).toHaveCount(1);

      const destinationWorktrees = readWorktreesFile(
        userDataDir,
        sourceWorkspace.id,
      ).worktrees;
      expect(destinationWorktrees).toHaveLength(1);
      expect(
        readWorktreesFile(userDataDir, joinWorkspace.id).worktrees,
      ).toHaveLength(0);
      const joinContainers = listArchivedContainers(
        userDataDir,
        joinWorkspace.id,
      );
      expect(joinContainers).toHaveLength(1);

      // A proper archive tears the checkout down: the archived repo's
      // destination checkout directory is gone…
      const archivedCheckoutPath = path.join(
        userDataDir,
        'workspaces',
        joinWorkspace.id,
        'worktrees',
        joinContainers[0],
      );
      await expect
        .poll(() => fs.existsSync(archivedCheckoutPath), { timeout: 15_000 })
        .toBe(false);
      // …and git no longer registers any checkout under the destination
      // workspace, so the branch is free to check out again (the re-join
      // scenario).
      const worktreeListOutput = execFileSync(
        'git',
        ['-C', joinWorkspace.repoPath, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8' },
      );
      expect(worktreeListOutput).not.toContain(
        path.join('workspaces', joinWorkspace.id, 'worktrees'),
      );

      // The repo-scoped chat migrated to the split destination worktree's
      // chat store, re-rooted (no multi-repo selectedRepoId left behind).
      const destinationRoot = path.join(
        userDataDir,
        'workspaces',
        sourceWorkspace.id,
      );
      const { live: destinationChats, archive: destinationArchives } =
        readChatStorageIndexes(destinationRoot, destinationWorktrees[0].id);
      expect(destinationChats.tabs.map((chatTab) => chatTab.title)).toContain(
        'Seeded Split Chat',
      );
      expect(
        destinationChats.tabs.every(
          (chatTab) => chatTab.selectedRepoId === undefined,
        ),
      ).toBe(true);
      await expect
        .poll(
          () =>
            window.evaluate(
              async ({ projectId, worktreeId }) =>
                (await window.api.chat.getState({ projectId, worktreeId }))
                  .tabsFile.pendingQuestions,
              {
                projectId: sourceWorkspace.id,
                worktreeId: destinationWorktrees[0].id,
              },
            ),
          { timeout: 30_000 },
        )
        .toEqual([
          {
            requestId: 'seeded-split-question',
            chatId: migratedChatId,
            questions: [],
          },
        ]);

      // The open file tab moved with the repo, its path rewritten into the
      // destination worktree checkout.
      const destinationWorktreePath = path.join(
        userDataDir,
        'workspaces',
        sourceWorkspace.id,
        'worktrees',
        destinationWorktrees[0].id,
      );
      const migratedFileTab = destinationChats.tabs.find(
        (chatTab) => chatTab.kind === 'file',
      );
      expect(migratedFileTab, 'migrated file tab').toBeTruthy();
      expect(migratedFileTab.filePath.startsWith(destinationWorktreePath)).toBe(
        true,
      );

      // The archived chat migrated into the destination worktree's archives,
      // re-rooted like live chats.
      expect(
        destinationArchives.archived.map((entry) => entry.tab.title),
      ).toContain('Seeded Archived Chat');
      expect(
        destinationArchives.archived.every(
          (entry) => entry.tab.selectedRepoId === undefined,
        ),
      ).toBe(true);

      // Root Archive: the temporary workspace keeps an archived entry holding
      // only the root-tied items (here, the attachment).
      const rootContainers = listArchivedContainers(
        userDataDir,
        temporaryWorkspaceId,
      );
      expect(rootContainers).toHaveLength(1);
      const archivedWorkspaceRoot = path.join(
        userDataDir,
        'workspaces',
        temporaryWorkspaceId,
        'archived-containers',
        rootContainers[0],
        'workspace-root',
      );
      expect(
        fs.readFileSync(
          path.join(
            archivedWorkspaceRoot,
            'repos',
            'personal-notes',
            'idea.txt',
          ),
          'utf8',
        ),
      ).toBe('preserve this\n');
      expect(
        fs.existsSync(
          path.join(archivedWorkspaceRoot, 'repos', sourceRepoInTemp.id),
        ),
      ).toBe(false);

      // Navigation lands on the split worktree.
      await expect(
        window.locator('[data-testid="panel-content-chat"]:visible'),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      }
    }
  });

  test('split one repo and archive the other even when its destination carries a legacy retention-off setting', async () => {
    test.setTimeout(300_000);
    const { electronApp, userDataDir, window, sourceWorkspace, joinWorkspace } =
      await launchWithTwoWorkspaces();
    try {
      const sourceBranch = path.basename(sourceWorkspace.worktreePath);
      const combinedRow = await combineIntoTemporaryWorkspace(
        window,
        sourceWorkspace,
        joinWorkspace,
      );

      // Deletion retention is always on: a legacy "retention off" value on
      // the join workspace no longer turns its removal into a hard delete.
      // Written after the combine so no sidebar rewrite races it, and before
      // the modal opens so the preview reads the persisted value.
      disableArchiveRetention(userDataDir, joinWorkspace.id);

      const modal = await openSplitModal(window, combinedRow);
      const joinRepoRow = modal
        .locator('[data-testid^="split-workspace-modal-repo-"]')
        .filter({ hasText: joinWorkspace.name })
        .first();
      await expect(joinRepoRow).toBeVisible();
      const removeToggle = joinRepoRow.locator('[data-testid$="-remove"]');
      await expect(removeToggle).toHaveAttribute('aria-label', 'Archive');
      await removeToggle.click();

      const temporaryWorkspaceId =
        await combinedRow.getAttribute('data-project-id');
      const confirmButton = modal.getByTestId('split-workspace-modal-confirm');
      await expect(confirmButton).toHaveText('Split 1 and Archive 2');
      await expect(confirmButton).toHaveAttribute('data-danger', 'false');
      await armSplitCompletion(window, temporaryWorkspaceId, 'demo-main');
      await confirmButton.click();
      await expect(modal).toHaveCount(0, { timeout: 2_000 });

      // The removed repo leaves a retained container in its destination
      // workspace (kept for the default window); the split repo survives.
      const branchRows = window.locator(
        `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
      );
      await expect(branchRows).toHaveCount(1, { timeout: 30_000 });
      await waitForSplitCompletion(window, userDataDir, temporaryWorkspaceId);
      expect(
        readWorktreesFile(userDataDir, sourceWorkspace.id).worktrees,
      ).toHaveLength(1);
      expect(
        readWorktreesFile(userDataDir, joinWorkspace.id).worktrees,
      ).toHaveLength(0);
      expect(
        listArchivedContainers(userDataDir, joinWorkspace.id),
      ).toHaveLength(1);

      await expect(
        window.locator('[data-testid="panel-content-chat"]:visible'),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('all-archive removals navigate to the first archive destination project', async () => {
    test.setTimeout(300_000);
    const { electronApp, userDataDir, window, sourceWorkspace, joinWorkspace } =
      await launchWithTwoWorkspaces();
    try {
      const sourceBranch = path.basename(sourceWorkspace.worktreePath);
      const combinedRow = await combineIntoTemporaryWorkspace(
        window,
        sourceWorkspace,
        joinWorkspace,
      );

      const modal = await openSplitModal(window, combinedRow);
      const removeToggles = modal.locator(
        '[data-testid^="split-workspace-modal-repo-"][data-testid$="-remove"]',
      );
      await expect(removeToggles).toHaveCount(2);
      await removeToggles.nth(0).click();
      await removeToggles.nth(1).click();

      const temporaryWorkspaceId =
        await combinedRow.getAttribute('data-project-id');
      const confirmButton = modal.getByTestId('split-workspace-modal-confirm');
      await expect(confirmButton).toHaveText('Archive 3');
      await expect(confirmButton).toHaveAttribute('data-danger', 'false');
      await armSplitCompletion(window, temporaryWorkspaceId, 'demo-main');
      await confirmButton.click();
      await expect(modal).toHaveCount(0, { timeout: 2_000 });

      // No live worktrees remain anywhere; both destination workspaces hold
      // an archived container.
      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
        ),
      ).toHaveCount(0, { timeout: 30_000 });
      await waitForSplitCompletion(window, userDataDir, temporaryWorkspaceId);
      expect(
        readWorktreesFile(userDataDir, sourceWorkspace.id).worktrees,
      ).toHaveLength(0);
      expect(
        readWorktreesFile(userDataDir, joinWorkspace.id).worktrees,
      ).toHaveLength(0);
      expect(
        listArchivedContainers(userDataDir, sourceWorkspace.id),
      ).toHaveLength(1);
      expect(
        listArchivedContainers(userDataDir, joinWorkspace.id),
      ).toHaveLength(1);

      // With no split target, navigation falls back to the first archive's
      // destination workspace: the main page stays up with the workspace
      // sections visible and no worktree selected.
      await expect(
        workspaceSectionLocator(window, sourceWorkspace.name),
      ).toBeVisible();
      await expect(window.getByTestId('page-home')).not.toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('archiving every repo while deleting the root keeps the retained containers and lands on the first archive destination', async () => {
    test.setTimeout(300_000);
    const { electronApp, userDataDir, window, sourceWorkspace, joinWorkspace } =
      await launchWithTwoWorkspaces();
    try {
      const sourceBranch = path.basename(sourceWorkspace.worktreePath);
      const combinedRow = await combineIntoTemporaryWorkspace(
        window,
        sourceWorkspace,
        joinWorkspace,
      );

      // Legacy retention-off values on BOTH destinations: removals still
      // archive (deletion retention is always on); only the workspace root
      // can be hard-deleted, and that is an explicit per-split choice.
      disableArchiveRetention(userDataDir, sourceWorkspace.id);
      disableArchiveRetention(userDataDir, joinWorkspace.id);

      const modal = await openSplitModal(window, combinedRow);
      const removeToggles = modal.locator(
        '[data-testid^="split-workspace-modal-repo-"][data-testid$="-remove"]',
      );
      await expect(removeToggles).toHaveCount(2);
      await expect(removeToggles.nth(0)).toHaveAttribute(
        'aria-label',
        'Archive',
      );
      await expect(removeToggles.nth(1)).toHaveAttribute(
        'aria-label',
        'Archive',
      );
      await removeToggles.nth(0).click();
      await removeToggles.nth(1).click();
      const rootDeleteToggle = modal.getByTestId(
        'split-workspace-modal-root-delete',
      );
      await rootDeleteToggle.click();
      await expect(rootDeleteToggle).toHaveAttribute('data-selected', 'true');

      const temporaryWorkspaceId =
        await combinedRow.getAttribute('data-project-id');
      const confirmButton = modal.getByTestId('split-workspace-modal-confirm');
      await expect(confirmButton).toHaveText('Archive 2 and Delete 1');
      await expect(confirmButton).toHaveAttribute('data-danger', 'true');
      await armSplitCompletion(window, temporaryWorkspaceId, 'demo-main');
      await confirmButton.click();
      await expect(modal).toHaveCount(0, { timeout: 2_000 });

      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-branch="${sourceBranch}"]`,
        ),
      ).toHaveCount(0, { timeout: 30_000 });
      await waitForSplitCompletion(window, userDataDir, temporaryWorkspaceId);
      // No live worktrees remain; both destinations hold a retained
      // container even though their persisted retention was the legacy 0.
      expect(
        readWorktreesFile(userDataDir, sourceWorkspace.id).worktrees,
      ).toHaveLength(0);
      expect(
        readWorktreesFile(userDataDir, joinWorkspace.id).worktrees,
      ).toHaveLength(0);
      expect(
        listArchivedContainers(userDataDir, sourceWorkspace.id),
      ).toHaveLength(1);
      expect(
        listArchivedContainers(userDataDir, joinWorkspace.id),
      ).toHaveLength(1);
      await expect(
        workspaceSectionLocator(window, sourceWorkspace.name),
      ).toBeVisible();
      await expect(window.getByTestId('page-home')).not.toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
