import { selectModelOption } from './model-selection-fixture.mjs';
import {
  readChatStorageIndexes,
  readChatStorageTabs,
} from './readChatStorage.mjs';
import {
  continueRestoredAutoDeleteChat,
  useBundledAutoDeleteTestRuntime,
} from './autoDeleteFixture.mjs';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  closeCanopy,
  launchCanopy,
  removeTestDataDir,
} from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import {
  seedBrowserProfileState,
  readBrowserProfileState,
  openRestoredBrowserProfileState,
  measureEntryProfileIsolation,
} from './seeders/browser-profile-state.mjs';
import {
  launchArchiveActivityFixture,
  deleteArchiveActivityWorktree,
  closeArchiveActivityFixture,
  commitArchiveSiblingProviderMarker,
  releaseArchiveActivityBarrier,
} from './seeders/archiveActivityFixture.mjs';
import { chatPanelLocator } from './panelHarness.mjs';
import {
  seedLargeArchiveRepository,
  configureArchiveFixture,
  confirmWorktreeDeletion,
} from './seeders/largeArchiveFixture.mjs';

const NOW = new Date().toISOString();
const EXPIRES = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedPreferences(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
}

function runGit(repoPath, args) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function runGitRaw(repoPath, args) {
  return execFileSync('git', args, { cwd: repoPath });
}

function chatTab(id, title) {
  return {
    id,
    title,
    kind: 'chat',
    providerType: 'claude',
    createdAt: NOW,
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        blocks: [{ type: 'text', text: `Retained transcript for ${title}` }],
        timestamp: Date.parse(NOW),
      },
    ],
  };
}

function seedArchivedContainer({
  workspaceRoot,
  projectId,
  containerId,
  kind,
  name,
  branchName,
  workspaceType,
  messageCount = 1,
}) {
  const containerDir = path.join(
    workspaceRoot,
    'archived-containers',
    containerId,
  );
  const tab = chatTab(`${containerId}-chat`, `${name} chat`);
  tab.messages = Array.from({ length: messageCount }, (_, index) => ({
    id: `${tab.id}-message-${index}`,
    role: 'user',
    blocks: [
      {
        type: 'text',
        text:
          index === messageCount - 1
            ? `Retained transcript for ${name} chat`
            : index === 0
              ? `Earliest retained transcript for ${name} chat`
              : `Retained transcript ${index} for ${name} chat`,
      },
    ],
    timestamp: Date.parse(NOW) + index,
  }));
  writeJson(path.join(containerDir, 'chats.json'), {
    version: 1,
    activeTabId: tab.id,
    tabs: [tab],
  });
  writeJson(path.join(containerDir, 'chat-archives.json'), {
    version: 1,
    archived: [],
  });
  writeJson(path.join(containerDir, 'container.json'), {
    version: 1,
    id: containerId,
    kind,
    projectId,
    name,
    createdAt: NOW,
    archivedAt: NOW,
    retentionDays: 7,
    expiresAt: EXPIRES,
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
    ...(branchName ? { branchName } : {}),
    ...(workspaceType ? { workspaceType } : {}),
  });
}

/**
 * Seed a version-2 archived worktree manifest with immutable archive-time
 * pull-request metadata. Commits/refs are fabricated but shape-valid: the
 * sidebar badge, viewer header, and PR section read only the manifest
 * summary, so no Git object needs to exist unless the Changes explorer is
 * opened (these specs never open it for seeded archives).
 */
function seedVersion2ArchivedContainer({
  workspaceRoot,
  projectId,
  containerId,
  name,
  branchName,
  workspaceType,
  repositories,
}) {
  const containerDir = path.join(
    workspaceRoot,
    'archived-containers',
    containerId,
  );
  const tab = chatTab(`${containerId}-chat`, `${name} chat`);
  writeJson(path.join(containerDir, 'chats.json'), {
    version: 1,
    activeTabId: tab.id,
    tabs: [tab],
  });
  writeJson(path.join(containerDir, 'chat-archives.json'), {
    version: 1,
    archived: [],
  });
  const hex = (digit) => String(digit).repeat(40);
  writeJson(path.join(containerDir, 'container.json'), {
    version: 2,
    id: containerId,
    kind: 'worktree',
    projectId,
    name,
    createdAt: NOW,
    archivedAt: NOW,
    retentionDays: 7,
    expiresAt: EXPIRES,
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
    branchName,
    workspaceType,
    originalWorktree: { id: containerId, branchName, createdAt: NOW },
    gitState: {
      version: 1,
      diffFormatVersion: 1,
      repositories: repositories.map((repository, index) => ({
        repoId: repository.repoId,
        repoName: repository.repoName,
        relativePath:
          repository.repoId === '__single_repo__'
            ? '.'
            : `repos/${repository.repoId}`,
        referenceRepoPath: `/tmp/${repository.repoName}`,
        branchName,
        comparisonBaseBranch: 'main',
        baseBranchCommit: hex((index + 9) % 10),
        comparisonBaseCommit: hex((index + 1) % 10),
        headCommit: hex((index + 2) % 10),
        indexSnapshotCommit: hex((index + 3) % 10),
        worktreeSnapshotCommit: hex((index + 4) % 10),
        snapshotRef: `refs/app/archived-containers/${projectId}/${containerId}/${repository.repoId}`,
      })),
    },
    gitChanges: {
      status: 'complete',
      capturedAt: NOW,
      fileCount: repositories.length * 2,
      insertions: repositories.length * 6,
      deletions: repositories.length * 2,
      repositories: repositories.map((repository) => ({
        repoId: repository.repoId,
        repoName: repository.repoName,
        fileCount: 2,
        insertions: 6,
        deletions: 2,
      })),
    },
    pullRequestMetadata: {
      capturedAt: NOW,
      repositories: repositories.map((repository) => ({
        repoId: repository.repoId,
        repoName: repository.repoName,
        ...(repository.pullRequest === 'unavailable'
          ? { status: 'unavailable' }
          : {
              status: 'complete',
              pullRequest: repository.pullRequest ?? null,
            }),
      })),
    },
  });
}

/**
 * Records whether the archive fixture's queued touch waited for the archive
 * to release the project lock. The fixture queues the touch while archive
 * capture holds that lock, so a waiter queued just ahead of the touch runs as
 * soon as the archive releases it and before the touch's own turn. The archive
 * IPC returns later, after work it does outside the lock, so comparing the
 * touch against that return depends on timing.
 */
async function observeQueuedTouchAgainstArchiveLock(electronApp) {
  await electronApp.evaluate(() => {
    const activity = globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__;
    const touchWorkspaceTarget = activity.touchWorkspaceTarget;
    const observation = { lockReleased: false, touchBeforeLockRelease: null };
    globalThis.__archiveQueuedTouchLockObservation = observation;
    activity.touchWorkspaceTarget = (projectId, ...rest) => {
      activity.touchWorkspaceTarget = touchWorkspaceTarget;
      void activity.withArchivedWorkspaceOperationLock(projectId, async () => {
        observation.lockReleased = true;
      });
      return touchWorkspaceTarget(projectId, ...rest).then(() => {
        observation.touchBeforeLockRelease = !observation.lockReleased;
      });
    };
  });
}

async function expandCoworkWorkspace(window, workspaceId) {
  const toggle = window.getByTestId(
    `sidebar-cowork-project-${workspaceId}-toggle`,
  );
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
}

async function deleteWorkEntry(window, prefix, entryId) {
  const row = window.getByTestId(`${prefix}-${entryId}`);
  await row.hover();
  await window.getByTestId(`${prefix}-${entryId}-menu`).click();
  await window.getByTestId(`${prefix}-${entryId}-delete`).click();
  const dialog = window.getByTestId(`${prefix}-${entryId}-delete-dialog`);
  const dialogVisible = await dialog
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (dialogVisible) {
    await dialog.getByTestId(`${prefix}-${entryId}-confirm-delete`).click();
  } else {
    await row.getByRole('button', { name: /^(Archive|Delete)\?$/ }).click();
  }
  await expect(row).toHaveCount(0, { timeout: 15_000 });
}

async function deleteWorktreeWithOptionalConfirmation(window, row) {
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-delete').click();
  // A clean worktree can skip the confirmation once Git stats have loaded.
  const dialog = window.getByRole('dialog', { name: 'Delete worktree?' });
  const needsConfirmation = await dialog
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (needsConfirmation) {
    await dialog.getByTestId('worktree-removal-preserve-branch').click();
  }
}

test.describe('archived containers', () => {
  test('retries an incomplete Windows archive and restores its chat and worktree files', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-windows-archive-retry-'),
    );
    let electronApp;
    try {
      const {
        workspaces: [workspace],
      } = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedPreferences(userDataDir);
      configureArchiveFixture(userDataDir, workspace.id);
      const workspaceMetaDir = path.join(
        userDataDir,
        'workspaces',
        workspace.id,
      );
      const worktreesPath = path.join(workspaceMetaDir, 'worktrees.json');
      const worktreeId = JSON.parse(readFileSync(worktreesPath, 'utf8'))
        .worktrees[0].id;
      const retainedText =
        'Retained conversation after an incomplete Windows archive.';
      seedWorktreeChat({
        userDataDir,
        workspaceId: workspace.id,
        worktreeId,
        activeTabId: 'retry-chat',
        tabs: [
          {
            id: 'retry-chat',
            title: 'Retry chat',
            providerType: 'claude',
            messages: [
              {
                id: 'retry-message',
                role: 'user',
                timestamp: Date.now(),
                blocks: [{ type: 'text', text: retainedText }],
              },
            ],
          },
        ],
      });
      writeFileSync(
        path.join(workspace.worktreePath, 'retained.txt'),
        'Retained working-tree bytes.\n',
      );
      const observationPath = path.join(
        userDataDir,
        'windows-reset-observation.json',
      );
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      // Wrap only the archive utility entry in this isolated fixture. On a Mac,
      // emulate Windows for reset-directory alone, using the real filesystem
      // and unchanged worker/engine; Git and all other operations stay native.
      // On Windows the same fixture exercises the native cleanup branch.
      await electronApp.evaluate(
        ({ utilityProcess }, { userDataDir, observationPath }) => {
          const fs = process.getBuiltinModule('node:fs');
          const path = process.getBuiltinModule('node:path');
          const fork = utilityProcess.fork.bind(utilityProcess);
          utilityProcess.fork = (modulePath, args, options) => {
            if (options?.serviceName !== 'archive-io')
              return fork(modulePath, args, options);
            const wrapper = path.join(userDataDir, 'archive-windows-reset.cjs');
            fs.writeFileSync(
              wrapper,
              `
const fs = require('node:fs');
const port = process.parentPort;
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const observation = { completedResets: 0, error: null };
let requestId;
port.on('message', (event) => {
  const request = event.data ?? event;
  if (request.type === 'reset-directory') {
    requestId = request.requestId;
    observation.error = null;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  }
});
const post = port.postMessage.bind(port);
port.postMessage = (message) => {
  if (message.requestId === requestId) {
    if (message.type === 'error') observation.error = { code: message.code, message: message.message };
    if (message.type === 'cleanup-complete') {
      Object.defineProperty(process, 'platform', platform);
      requestId = undefined;
      observation.completedResets += 1;
      fs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify(observation));
    }
  }
  return post(message);
};
require(${JSON.stringify(modulePath)});
`,
            );
            return fork(wrapper, args, options);
          };
        },
        { userDataDir, observationPath },
      );

      // A failed first capture leaves managed payloads without container.json.
      // Stage that state after startup so only the user's retry consumes it.
      const archiveDir = path.join(
        workspaceMetaDir,
        'archived-containers',
        worktreeId,
      );
      writeJson(path.join(archiveDir, 'summary.json'), {
        version: 1,
        summary: { description: 'Stale partial capture' },
      });
      mkdirSync(path.join(archiveDir, 'attachments'), { recursive: true });
      writeFileSync(path.join(archiveDir, 'attachments', 'stale.txt'), 'stale');
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
      );
      await row.click();
      await expect(
        chatPanelLocator(window).getByText(retainedText),
      ).toBeVisible();
      await deleteWorktreeWithOptionalConfirmation(window, row);
      await expect
        .poll(() =>
          existsSync(observationPath)
            ? JSON.parse(readFileSync(observationPath, 'utf8')).completedResets
            : 0,
        )
        .toBe(1);
      expect(
        JSON.parse(readFileSync(observationPath, 'utf8')).error,
      ).toBeNull();
      await expect(row).toHaveCount(0, { timeout: 45_000 });
      await expect
        .poll(() => existsSync(path.join(archiveDir, 'container.json')), {
          timeout: 60_000,
        })
        .toBe(true);
      expect(
        existsSync(path.join(archiveDir, 'attachments', 'stale.txt')),
      ).toBe(false);
      await window
        .getByTestId(`sidebar-project-${workspace.id}-archived-link`)
        .click();
      await window.getByTestId(`archived-overview-open-${worktreeId}`).click();
      const viewer = window.getByTestId('archived-container-view');
      await viewer.getByTestId('archived-chat-row-retry-chat').click();
      await expect(viewer.getByText(retainedText)).toBeVisible();
      await viewer.getByTestId('archived-restore').click();
      await expect(viewer).toBeHidden({ timeout: 60_000 });
      const restored = JSON.parse(
        readFileSync(worktreesPath, 'utf8'),
      ).worktrees;
      expect(restored).toHaveLength(1);
      expect(restored[0].id).not.toBe(worktreeId);
      expect(
        readFileSync(
          path.join(
            workspaceMetaDir,
            'worktrees',
            restored[0].id,
            'retained.txt',
          ),
          'utf8',
        ),
      ).toBe('Retained working-tree bytes.\n');
      await expect(
        chatPanelLocator(window).getByText(retainedText),
      ).toBeVisible();
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      else rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  for (const bulkCleanup of [false, true]) {
    test(
      bulkCleanup
        ? 'archives a slow dependency tree without a Git removal timeout or retry'
        : 'preserves a timed-out single-repository archive and completes it on retry',
      async () => {
        test.skip(process.platform !== 'darwin', 'macOS timeout recovery');
        test.setTimeout(300_000);

        const userDataDir = mkdtempSync(
          path.join(os.tmpdir(), 'canopy-archive-git-timeout-'),
        );
        let electronApp;
        try {
          const {
            workspaces: [workspace],
          } = seedDemoWorkspaces({
            userDataDir,
            apps: ['ts-pnpm-vite'],
          });
          seedPreferences(userDataDir);
          configureArchiveFixture(userDataDir, workspace.id);
          const workspaceMetaDir = path.join(
            userDataDir,
            'workspaces',
            workspace.id,
          );
          const worktrees = JSON.parse(
            readFileSync(path.join(workspaceMetaDir, 'worktrees.json'), 'utf8'),
          ).worktrees;
          const worktreeId = worktrees[0].id;
          const retainedText =
            'Retained conversation after Git removal timed out.';
          seedWorktreeChat({
            userDataDir,
            workspaceId: workspace.id,
            worktreeId,
            activeTabId: 'timeout-chat',
            tabs: [
              {
                id: 'timeout-chat',
                title: 'Timeout recovery chat',
                providerType: 'claude',
                messages: [
                  {
                    id: 'timeout-chat-message',
                    role: 'user',
                    timestamp: Date.now(),
                    blocks: [{ type: 'text', text: retainedText }],
                  },
                ],
              },
            ],
          });

          if (bulkCleanup) {
            const dependencies = path.join(
              workspace.worktreePath,
              'node_modules',
            );
            mkdirSync(dependencies, { recursive: true });
            writeFileSync(
              path.join(dependencies, 'archive-bulk-fixture.txt'),
              'ignored dependency',
            );
          }

          // The archive worker kills this command after the configured Git
          // worktree-deletion timeout. Every other Git command delegates to the
          // host binary so capture and verification use the production path.
          const shimPath = path.join(userDataDir, 'git-remove-timeout.sh');
          const attemptLogPath = path.join(
            userDataDir,
            'git-remove-attempts.log',
          );
          const allowRemovalPath = path.join(userDataDir, 'allow-git-removal');
          writeFileSync(
            shimPath,
            '#!/bin/sh\ncase "$*" in\n  "worktree remove --force "*)\n    printf "attempt\\n" >> "$CANOPY_E2E_GIT_REMOVE_ATTEMPT_LOG"\n    if [ "$CANOPY_E2E_BULK_CLEANUP" = "1" ]; then\n      if [ -d "$4/node_modules" ]; then sleep 120; fi\n    elif [ ! -f "$CANOPY_E2E_ALLOW_GIT_REMOVAL" ]; then sleep 120; fi\n    ;;\nesac\nexec /usr/bin/git "$@"\n',
          );
          chmodSync(shimPath, 0o755);

          ({ electronApp } = await launchCanopy({
            userDataDir,
            env: {
              CANOPY_E2E_BULK_CLEANUP: bulkCleanup ? '1' : '0',
              CANOPY_GIT_EXECUTABLE: shimPath,
              CANOPY_WORKTREE_DELETE_TIMEOUT_MS: '1000',
              CANOPY_E2E_GIT_REMOVE_ATTEMPT_LOG: attemptLogPath,
              CANOPY_E2E_ALLOW_GIT_REMOVAL: allowRemovalPath,
            },
          }));
          const window = await electronApp.firstWindow();
          const app = new CanopyAppDriver(window);
          await app.waitForShell({ timeout: 30_000 });
          await app.openMainPage();
          const row = window.locator(
            '[data-testid="worktree-row"][data-branch="demo-main"]',
          );
          await row.click();
          await expect(
            chatPanelLocator(window).getByText(retainedText),
          ).toBeVisible({
            timeout: 30_000,
          });
          await deleteWorktreeWithOptionalConfirmation(window, row);

          const archiveDir = path.join(
            workspaceMetaDir,
            'archived-containers',
            worktreeId,
          );
          if (!bulkCleanup) {
            const failureToast = window
              .getByTestId('toast-card')
              .filter({ hasText: /timed out/i });
            await expect(failureToast).toBeVisible({ timeout: 150_000 });
            await expect(row).toBeVisible();
            expect(
              readFileSync(attemptLogPath, 'utf8').trim().split('\n'),
            ).toHaveLength(1);
            const descriptor = JSON.parse(
              readFileSync(
                path.join(archiveDir, 'git-state.staged.json'),
                'utf8',
              ),
            );
            expect(descriptor.status).toBe('ready');
            expect(descriptor.teardown.phase).toBe('verified');
            expect(descriptor.repositories[0].repoId).toBe('__single_repo__');
            expect(existsSync(descriptor.teardown.quarantinePath)).toBe(true);
            expect(
              JSON.parse(
                readFileSync(
                  path.join(workspaceMetaDir, 'worktrees.json'),
                  'utf8',
                ),
              ).worktrees.some((worktree) => worktree.id === worktreeId),
            ).toBe(true);

            // Release the exact command that timed out, then retry from the same
            // sidebar action. This must resume the verified archive journal.
            writeFileSync(allowRemovalPath, 'allowed\n');
            await deleteWorktreeWithOptionalConfirmation(window, row);
          }
          await expect(row).toHaveCount(0, { timeout: 45_000 });
          await expect
            .poll(
              () =>
                JSON.parse(
                  readFileSync(
                    path.join(workspaceMetaDir, 'worktrees.json'),
                    'utf8',
                  ),
                ).worktrees.some((worktree) => worktree.id === worktreeId),
              { timeout: 45_000 },
            )
            .toBe(false);
          expect(
            readFileSync(attemptLogPath, 'utf8').trim().split('\n'),
          ).toHaveLength(bulkCleanup ? 1 : 2);
          const manifest = JSON.parse(
            readFileSync(path.join(archiveDir, 'container.json'), 'utf8'),
          );
          expect(manifest.kind).toBe('worktree');
          expect(manifest.gitState.repositories[0].repoId).toBe(
            '__single_repo__',
          );
          expect(existsSync(workspace.worktreePath)).toBe(false);

          const archivedLink = window.getByTestId(
            `sidebar-project-${workspace.id}-archived-link`,
          );
          await expect(archivedLink).toHaveText('Archived and deleted 1');
          await archivedLink.click();
          await window
            .getByTestId(`archived-overview-open-${worktreeId}`)
            .click();
          const viewer = window.getByTestId('archived-container-view');
          await expect(viewer).toBeVisible();
          await viewer.getByTestId('archived-chat-row-timeout-chat').click();
          await expect(viewer.getByText(retainedText)).toBeVisible();
        } finally {
          if (electronApp) await closeCanopy(electronApp, userDataDir);
          else rmSync(userDataDir, { recursive: true, force: true });
        }
      },
    );
  }

  test('labels a restored files-only archive as a Git cleanup retry', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archive-git-cleanup-label-'),
    );
    let electronApp;
    try {
      const {
        workspaces: [workspace],
      } = seedDemoWorkspaces({
        userDataDir,
        apps: ['ts-pnpm-vite'],
        createWorktrees: false,
      });
      seedPreferences(userDataDir);
      const containerId = 'cleanup-only-archive';
      const workspaceMetaDir = path.join(
        userDataDir,
        'workspaces',
        workspace.id,
      );
      writeJson(
        path.join(
          workspaceMetaDir,
          'archived-containers',
          containerId,
          'container.json',
        ),
        {
          version: 3,
          id: containerId,
          kind: 'worktree',
          projectId: workspace.id,
          name: 'Recovered files',
          createdAt: NOW,
          archivedAt: NOW,
          retentionDays: 7,
          expiresAt: EXPIRES,
          chatCount: 0,
          archivedChatCount: 0,
          executionCount: 0,
          branchName: 'feature/recovered-files',
          workspaceType: 'single-repo',
          originalWorktree: {
            id: containerId,
            branchName: 'feature/recovered-files',
            createdAt: NOW,
          },
          recovery: {
            kind: 'files-only',
            source: 'partial',
            digest: 'a'.repeat(64),
            payloadId: '11111111-1111-4111-8111-111111111111',
            gitCleanupPending: true,
          },
          restoredTo: {
            kind: 'worktree',
            id: 'restored-files-worktree',
            restoredAt: NOW,
          },
        },
      );

      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await window
        .getByTestId(`sidebar-project-${workspace.id}-archived-link`)
        .click();
      await window.getByTestId(`archived-overview-open-${containerId}`).click();

      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();
      await expect(viewer.getByTestId('archived-restore')).toHaveText(
        'Retry Git cleanup',
      );
      await expect(
        viewer.getByTestId('archived-file-recovery-banner'),
      ).toContainText('Git registration cleanup is still pending');
      await expect(
        viewer.getByTestId('archived-partial-restore-banner'),
      ).toHaveCount(0);
      await expect(
        viewer.getByTestId('archived-container-tab-chats'),
      ).toHaveCount(0);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('labels concurrent pipeline restore and Git cleanup as a pipeline retry', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archive-combined-retry-label-'),
    );
    let electronApp;
    try {
      const {
        workspaces: [workspace],
      } = seedDemoWorkspaces({
        userDataDir,
        apps: ['ts-pnpm-vite'],
        createWorktrees: false,
      });
      seedPreferences(userDataDir);
      const containerId = 'combined-retry-archive';
      writeJson(
        path.join(
          userDataDir,
          'workspaces',
          workspace.id,
          'archived-containers',
          containerId,
          'container.json',
        ),
        {
          version: 3,
          id: containerId,
          kind: 'worktree',
          projectId: workspace.id,
          name: 'Recovered files with pipelines',
          createdAt: NOW,
          archivedAt: NOW,
          retentionDays: 7,
          expiresAt: EXPIRES,
          chatCount: 0,
          archivedChatCount: 0,
          executionCount: 1,
          executionRestorePending: true,
          branchName: 'feature/recovered-files',
          workspaceType: 'single-repo',
          originalWorktree: {
            id: containerId,
            branchName: 'feature/recovered-files',
            createdAt: NOW,
          },
          recovery: {
            kind: 'files-only',
            source: 'partial',
            digest: 'a'.repeat(64),
            payloadId: '11111111-1111-4111-8111-111111111111',
            gitCleanupPending: true,
          },
          restoredTo: {
            kind: 'worktree',
            id: 'restored-files-worktree',
            restoredAt: NOW,
          },
        },
      );

      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await window
        .getByTestId(`sidebar-project-${workspace.id}-archived-link`)
        .click();
      await window.getByTestId(`archived-overview-open-${containerId}`).click();

      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer.getByTestId('archived-restore')).toHaveText(
        'Retry pipeline import',
      );
      await expect(
        viewer.getByTestId('archived-partial-restore-banner'),
      ).toHaveText('Partially restored — pipeline runs pending');
      await expect(
        viewer.getByTestId('archived-file-recovery-banner'),
      ).toContainText('Git registration cleanup is still pending');
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('deletes and restores a worktree with more than 8 MiB of Git attributes', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-3089-'));
    let electronApp;
    try {
      const {
        workspaces: [workspace],
      } = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedPreferences(userDataDir);
      configureArchiveFixture(userDataDir, workspace.id);
      const { paths } = seedLargeArchiveRepository(workspace.worktreePath);
      const expectedHead = runGit(workspace.worktreePath, [
        'rev-parse',
        'HEAD',
      ]);
      seedWorktreeChat({
        userDataDir,
        workspaceId: workspace.id,
        worktreeId: 'demo-main',
        tabs: [chatTab('large-archive-chat', 'Large repository')],
      });
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      const row = window.getByTestId('worktree-row').first();
      await row.click();
      await expect(
        chatPanelLocator(window).getByText(
          'Retained transcript for Large repository',
        ),
      ).toBeVisible();
      await confirmWorktreeDeletion(window, row);
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(() => existsSync(workspace.worktreePath), { timeout: 30_000 })
        .toBe(false);
      await window
        .getByTestId(`sidebar-project-${workspace.id}-archived-link`)
        .click();
      await window.getByTestId('archived-overview-open-demo-main').click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();
      await viewer.getByTestId('archived-restore').click();
      await expect(window.getByTestId('worktree-row')).toHaveCount(1, {
        timeout: 60_000,
      });
      // The live row appears while the checkout is still being restored.
      await expect(viewer).toHaveCount(0, { timeout: 60_000 });
      const workspaceDir = path.join(userDataDir, 'workspaces', workspace.id);
      const restored = JSON.parse(
        readFileSync(path.join(workspaceDir, 'worktrees.json'), 'utf8'),
      ).worktrees[0];
      const restoredPath = path.join(workspaceDir, 'worktrees', restored.id);
      expect(runGit(restoredPath, ['rev-parse', 'HEAD'])).toBe(expectedHead);
      expect(runGit(restoredPath, ['status', '--porcelain'])).toBe('');
      const restoredPaths = new Set(
        runGit(restoredPath, ['ls-files']).split('\n'),
      );
      expect(paths.filter((filePath) => !restoredPaths.has(filePath))).toEqual(
        [],
      );
      expect(readFileSync(path.join(restoredPath, paths.at(-1)), 'utf8')).toBe(
        'retained content\n',
      );
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await removeTestDataDir(userDataDir);
    }
  });

  for (const surface of ['cowork', 'app-advisor']) {
    test(`startup Auto Delete retains, restores, and expires ${surface} entries independently`, async () => {
      test.setTimeout(180_000);
      useBundledAutoDeleteTestRuntime();
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-auto-entry-'),
      );
      seedPreferences(userDataDir);
      const projectId =
        surface === 'app-advisor' ? 'app-advisor' : 'auto-cowork';
      const root = path.join(
        userDataDir,
        surface === 'app-advisor' ? 'app-workspaces' : 'workspaces',
        projectId,
      );
      if (surface === 'cowork') {
        writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
          version: 1,
          workspaces: [
            {
              id: projectId,
              name: 'Auto Cowork',
              type: 'cowork',
              color: '#7C9B6D',
              collapsed: false,
              order: 0,
            },
          ],
        });
        writeJson(path.join(root, 'workspace.json'), {
          version: 1,
          type: 'cowork',
          repos: [],
          cowork: {
            createdAt: NOW,
            autoArchiveDays: 7,
            archiveRetentionDays: 7,
          },
        });
      } else {
        writeJson(path.join(root, 'settings.json'), {
          version: 1,
          autoArchiveDays: 7,
          archiveRetentionDays: 7,
        });
      }
      const old = '2026-01-01T00:00:00.000Z';
      writeJson(path.join(root, 'work-entries.json'), {
        version: 1,
        entries: ['restore-entry', 'expire-entry', 'recent-entry'].map(
          (id) => ({
            id,
            title: id,
            createdAt: old,
            lastTouchedAt: id === 'recent-entry' ? NOW : old,
          }),
        ),
      });
      for (const id of ['restore-entry', 'expire-entry', 'recent-entry']) {
        writeJson(path.join(root, 'chats', `${id}.json`), {
          version: 1,
          activeTabId: `${id}-chat`,
          tabs: [
            {
              ...chatTab(`${id}-chat`, id),
              hasStartedSession: true,
              model: 'sonnet',
            },
          ],
        });
      }
      let { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await expect
          .poll(
            () =>
              JSON.parse(
                readFileSync(path.join(root, 'work-entries.json'), 'utf8'),
              ).entries.map((entry) => entry.id),
            { timeout: 30_000 },
          )
          .toEqual(['recent-entry']);
        const page =
          surface === 'app-advisor'
            ? await app.openAppAdvisorWindow(electronApp)
            : window;
        if (surface === 'cowork') await expandCoworkWorkspace(page, projectId);
        await page
          .getByTestId(
            surface === 'app-advisor'
              ? 'app-advisor-nav-archived-link'
              : `sidebar-cowork-project-${projectId}-archived-link`,
          )
          .click();
        await page.getByTestId('archived-overview-open-restore-entry').click();
        const viewer = page.getByTestId('archived-container-view');
        await expect(viewer).toContainText('restore-entry');
        await viewer.getByTestId('archived-restore').click();
        await expect(viewer).toHaveCount(0, { timeout: 30_000 });
        await expect(page.getByTestId('panel-content-chat')).toContainText(
          'Retained transcript for restore-entry',
        );
        const entries = JSON.parse(
          readFileSync(path.join(root, 'work-entries.json'), 'utf8'),
        ).entries;
        expect(entries).toHaveLength(2);
        const restored = entries.find((entry) => entry.id !== 'recent-entry');
        expect(Date.parse(restored.lastTouchedAt)).toBeGreaterThan(
          Date.parse(old),
        );
        await continueRestoredAutoDeleteChat(
          page,
          surface === 'cowork' ? 'Canopy-CADCOWORK' : 'Canopy-CADADVISOR',
        );
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        electronApp = null;
        const expirePath = path.join(
          root,
          'archived-containers',
          'expire-entry',
          'container.json',
        );
        const expired = JSON.parse(readFileSync(expirePath, 'utf8'));
        expect(expired.chatCount).toBe(1);
        expired.expiresAt = old;
        writeJson(expirePath, expired);
        ({ electronApp } = await launchCanopy({ userDataDir }));
        const relaunched = await electronApp.firstWindow();
        await new CanopyAppDriver(relaunched).waitForShell({ timeout: 30_000 });
        await expect
          .poll(() => existsSync(expirePath), { timeout: 30_000 })
          .toBe(false);
        expect(
          JSON.parse(readFileSync(path.join(root, 'work-entries.json'), 'utf8'))
            .entries,
        ).toHaveLength(2);
      } finally {
        if (electronApp) await closeCanopy(electronApp, userDataDir);
        else rmSync(userDataDir, { recursive: true, force: true });
      }
    });
  }

  test('reloads projects and completes chats in sibling and independent worktrees while archive capture is held', async () => {
    test.setTimeout(120_000);
    const marker = 'Canopy-CARCHIVERELOAD';
    const reply = `Chat completed before archive recovery finished ${marker}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
    });
    const fixture = await launchArchiveActivityFixture(false, {
      holdArchiveAtCapture: true,
      preloadSibling: false,
    });
    const {
      electronApp,
      window,
      app,
      otherId,
      original,
      workspace,
      workspaceRoot,
    } = fixture;
    try {
      const independentWorkspace = seedDemoWorkspaces({
        userDataDir: fixture.userDataDir,
        apps: ['ts-npm-next'],
        force: false,
      }).workspaces[0];
      seedWorktreeChat({
        userDataDir: fixture.userDataDir,
        workspaceId: independentWorkspace.id,
        worktreeId: path.basename(independentWorkspace.worktreePath),
        providerType: 'claude',
        tabs: [{ id: 'independent-chat', title: 'Independent project chat' }],
      });
      await deleteArchiveActivityWorktree(fixture);
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__archiveActivityObservation.captureBarrierEntered,
          ),
        )
        .toBe(true);
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      const sibling = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${otherId}"]`,
      );
      await expect(sibling).toBeVisible({ timeout: 10_000 });
      await app.selectWorktree(otherId);
      const independent = window.locator(
        `[data-testid="worktree-row"][data-project-id="${independentWorkspace.id}"]`,
      );
      await expect(independent).toBeVisible();
      for (const target of ['sibling', 'independent']) {
        if (target === 'independent') {
          await independent.evaluate((element) => element.click());
          await expect(
            window
              .locator('[data-sidebar-selected-item]')
              .filter({ has: independent }),
          ).toHaveCount(1);
          await expect(window.getByTestId('worktree-part')).toBeVisible();
          await expect(window.getByTestId('panel-grid-root')).toBeVisible();
        }
        const panel = chatPanelLocator(window);
        await expect(panel).toBeVisible();
        await window.getByTestId('panel-add-tab-group-chat').click();
        await panel
          .getByRole('textbox')
          .first()
          .fill(`[${marker}] Use the ${target} while archival is held.`);
        await panel
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
        await expect(panel.getByText(reply).first()).toBeVisible({
          timeout: 10_000,
        });
        await expect(panel.getByTestId('chat-stop-generation')).toHaveCount(0, {
          timeout: 10_000,
        });
        // Verify the response belongs to the selected project's persisted
        // chat, rather than accepting a still-visible panel from navigation.
        await expect
          .poll(() =>
            JSON.stringify(
              readChatStorageTabs(
                target === 'sibling'
                  ? workspaceRoot
                  : path.join(
                      fixture.userDataDir,
                      'workspaces',
                      independentWorkspace.id,
                    ),
                target === 'sibling'
                  ? otherId
                  : path.basename(independentWorkspace.worktreePath),
              ),
            ).includes(reply),
          )
          .toBe(true);
        expect(
          await electronApp.evaluate(
            () => globalThis.__archiveActivityObservation.completed,
          ),
        ).toBe(false);
      }
      await releaseArchiveActivityBarrier(electronApp);
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              () => globalThis.__archiveActivityObservation.completed,
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect
        .poll(() =>
          existsSync(
            path.join(
              workspaceRoot,
              'archived-containers',
              original.id,
              'container.json',
            ),
          ),
        )
        .toBe(true);
      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-project-id="${workspace.id}"][data-worktree-id="${original.id}"]`,
        ),
      ).toHaveCount(0);
      await expect(sibling).toBeVisible();
    } finally {
      await closeArchiveActivityFixture(fixture);
    }
  });

  test('keeps sibling output, model changes, and a fresh turn live while archive capture is held', async () => {
    test.setTimeout(120_000);
    const marker = 'Canopy-CARCHIVEHELD';
    const providerMarker = 'Provider output committed while archive is held';
    const reply = `Fresh sibling completed while archive is held ${marker}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
    });
    const fixture = await launchArchiveActivityFixture(false, {
      holdArchiveAtCapture: true,
      preloadSibling: false,
    });
    const { electronApp, window, app, workspace, original, otherId } = fixture;
    try {
      await deleteArchiveActivityWorktree(fixture);
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              () =>
                globalThis.__archiveActivityObservation.captureBarrierEntered,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      const assertArchivePending = async () => {
        expect(
          await electronApp.evaluate(
            () => globalThis.__archiveActivityObservation.completed,
          ),
        ).toBe(false);
      };

      await app.selectWorktree(otherId);
      const panel = chatPanelLocator(window);
      await expect(panel).toBeVisible();
      await Promise.race([
        commitArchiveSiblingProviderMarker(electronApp, {
          projectId: workspace.id,
          worktreeId: otherId,
          chatId: `${otherId}-chat`,
          text: providerMarker,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Sibling provider commit exceeded 5s')),
            5_000,
          ),
        ),
      ]);
      await expect(panel.getByText(providerMarker).first()).toBeVisible({
        timeout: 5_000,
      });
      await assertArchivePending();

      const picker = panel.getByTestId('chat-model-picker');
      await picker.click();
      await selectModelOption(window, 'sonnet');
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              () =>
                globalThis.__archiveActivityObservation?.modelChangeCompleted ??
                false,
            ),
          { timeout: 5_000 },
        )
        .toBe(true);
      expect(
        await electronApp.evaluate(
          () => globalThis.__archiveActivityObservation?.modelChangeResult,
        ),
      ).toBe(true);
      await expect(picker).toContainText('Sonnet', { timeout: 5_000 });
      await assertArchivePending();

      await window.getByTestId('panel-add-tab-group-chat').click();
      const composer = panel.getByRole('textbox').first();
      await composer.fill(`[${marker}] Start while archival remains blocked.`);
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(panel.getByText(reply).first()).toBeVisible({
        timeout: 5_000,
      });
      await assertArchivePending();

      await releaseArchiveActivityBarrier(electronApp);
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              () => globalThis.__archiveActivityObservation.completed,
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(
        existsSync(
          path.join(
            fixture.workspaceRoot,
            'archived-containers',
            original.id,
            'container.json',
          ),
        ),
      ).toBe(true);
    } finally {
      await closeArchiveActivityFixture(fixture);
    }
  });

  for (const { queueBackgroundActivity, activityMode, suffix, markerId } of [
    {
      queueBackgroundActivity: false,
      activityMode: 'queued-touch',
      suffix: '',
      markerId: 'CONTROL',
    },
    {
      queueBackgroundActivity: true,
      activityMode: 'queued-touch',
      suffix: ' with activity queued behind the archive lock',
      markerId: 'QUEUED',
    },
    {
      queueBackgroundActivity: true,
      activityMode: 'admitted',
      suffix: ' with an admitted chat operation',
      markerId: 'ADMITTED',
    },
    {
      queueBackgroundActivity: true,
      activityMode: 'provider-commit',
      suffix: ' with an in-flight provider commit',
      markerId: 'PROVIDER',
    },
    {
      queueBackgroundActivity: true,
      activityMode: 'settings-commit',
      suffix: ' with an in-flight settings commit',
      markerId: 'SETTINGS',
    },
  ]) {
    test(`deleting a worktree leaves another worktree's new-chat model and send usable${suffix}`, async () => {
      test.setTimeout(120_000);
      const marker = `Canopy-CARCHIVEACTIVITY${markerId}`;
      const reply = `New chat completed after archive ${marker}`;
      await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
        llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
      });
      const fixture = await launchArchiveActivityFixture(
        queueBackgroundActivity,
        { activityMode },
      );
      const {
        electronApp,
        window,
        app,
        workspace,
        workspaceRoot,
        worktreesPath,
        original,
        otherId,
      } = fixture;
      const queuedTouch =
        queueBackgroundActivity && activityMode === 'queued-touch';
      try {
        if (queuedTouch)
          await observeQueuedTouchAgainstArchiveLock(electronApp);
        const archiveRow = await deleteArchiveActivityWorktree(fixture);
        await expect(archiveRow).toHaveCount(0, { timeout: 15_000 });
        await expect
          .poll(
            () =>
              electronApp.evaluate(
                () => globalThis.__archiveActivityObservation,
              ),
            { timeout: 30_000 },
          )
          .toMatchObject({ completed: true });
        await expect
          .poll(
            () =>
              electronApp.evaluate(
                () => globalThis.__archiveActivityObservation.touchCompleted,
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
        if (queuedTouch) {
          expect(
            await electronApp.evaluate(
              () => globalThis.__archiveQueuedTouchLockObservation,
            ),
          ).toEqual({ lockReleased: true, touchBeforeLockRelease: false });
        }
        expect(
          JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees.map(
            (tree) => tree.id,
          ),
        ).toEqual([otherId]);
        expect(
          existsSync(
            path.join(
              workspaceRoot,
              'archived-containers',
              original.id,
              'container.json',
            ),
          ),
        ).toBe(true);
        if (
          activityMode === 'provider-commit' ||
          activityMode === 'settings-commit'
        ) {
          const retainedChats = JSON.stringify(
            readChatStorageTabs(
              path.join(workspaceRoot, 'archived-containers', original.id),
              original.id,
            ),
          );
          expect(retainedChats).toContain(
            activityMode === 'provider-commit'
              ? 'Provider output retained during deletion'
              : 'Renamed before deletion',
          );
        }
        await app.selectWorktree(otherId);
        await expect(chatPanelLocator(window)).toBeVisible();
        await window.getByTestId('panel-add-tab-group-chat').click();
        const panel = chatPanelLocator(window);
        const picker = panel.getByTestId('chat-model-picker');
        await picker.click();
        await selectModelOption(window, 'sonnet');
        await expect(picker).toContainText('Sonnet');
        const composer = panel.getByRole('textbox').first();
        await composer.fill(
          `[${marker}] Send from a fresh chat after deletion.`,
        );
        const send = panel.getByRole('button', {
          name: 'Send message',
          exact: true,
        });
        await expect(send).toBeEnabled({ timeout: 15_000 });
        await send.click();
        await expect(panel.getByText(reply).first()).toBeVisible({
          timeout: 30_000,
        });
        await expect
          .poll(async () => {
            const state = await window.evaluate(
              (projectId) =>
                window.api.chat.getState({
                  projectId,
                  worktreeId: 'activity-other',
                }),
              workspace.id,
            );
            const active = state.tabsFile.tabs.find(
              (tab) => tab.id === state.tabsFile.activeTabId,
            );
            return { count: state.tabsFile.tabs.length, model: active?.model };
          })
          .toEqual({ count: 2, model: 'sonnet' });
      } finally {
        await closeArchiveActivityFixture(fixture);
      }
    });
  }

  test('archives a worktree, refreshes the sidebar, shows all viewer tabs, and restores with Windows-compatible file flushing', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-worktree-'),
    );
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    seedPreferences(userDataDir);

    const workspace = seeded.workspaces[0];
    configureArchiveFixture(userDataDir, workspace.id);
    const branchName = 'feature/archive-e2e';
    execFileSync('git', ['branch', '-m', branchName], {
      cwd: workspace.worktreePath,
    });
    const worktreesPath = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'worktrees.json',
    );
    const worktrees = JSON.parse(readFileSync(worktreesPath, 'utf8'));
    worktrees.worktrees[0].branchName = branchName;
    writeJson(worktreesPath, worktrees);

    // Build a mixed Git state whose exact HEAD/index/worktree shape must
    // survive branch deletion and archive restore.
    writeFileSync(
      path.join(workspace.worktreePath, '.gitignore'),
      'archive-e2e-ignored.txt\n',
    );
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-both.txt'),
      'base\n',
    );
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-delete.txt'),
      'delete me\n',
    );
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-rename.txt'),
      'renamed content\n',
    );
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-mode.sh'),
      '',
      { mode: 0o644 },
    );
    runGit(workspace.worktreePath, ['add', '.']);
    runGit(workspace.worktreePath, ['commit', '-m', 'archive e2e base']);
    // Make the fixture files part of the comparison base so the later staged
    // rename has a real old side, then add a separate local-only commit.
    runGit(workspace.repoPath, [
      'update-ref',
      'refs/heads/main',
      runGit(workspace.worktreePath, ['rev-parse', 'HEAD']),
    ]);
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-local-commit.txt'),
      'local-only commit\n',
    );
    runGit(workspace.worktreePath, ['add', 'archive-e2e-local-commit.txt']);
    runGit(workspace.worktreePath, ['commit', '-m', 'archive e2e local']);

    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-staged.txt'),
      'staged add\n',
    );
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-both.txt'),
      'staged value\n',
    );
    runGit(workspace.worktreePath, [
      'add',
      'archive-e2e-staged.txt',
      'archive-e2e-both.txt',
    ]);
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-both.txt'),
      'working value\n',
    );
    rmSync(path.join(workspace.worktreePath, 'archive-e2e-delete.txt'));
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-untracked.txt'),
      'untracked value\n',
    );
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-ignored.txt'),
      'ignored value\n',
    );
    runGit(workspace.worktreePath, [
      'mv',
      'archive-e2e-rename.txt',
      'archive-e2e-renamed.txt',
    ]);
    writeFileSync(
      path.join(workspace.worktreePath, 'archive-e2e-binary.bin'),
      Buffer.from([0, 1, 2, 3, 4]),
    );
    runGit(workspace.worktreePath, ['add', 'archive-e2e-binary.bin']);
    chmodSync(path.join(workspace.worktreePath, 'archive-e2e-mode.sh'), 0o755);

    const expectedHead = runGit(workspace.worktreePath, ['rev-parse', 'HEAD']);
    const expectedStatus = runGitRaw(workspace.worktreePath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    const expectedStagedBoth = runGitRaw(workspace.worktreePath, [
      'show',
      ':archive-e2e-both.txt',
    ]);
    const expectedStagedAdd = runGitRaw(workspace.worktreePath, [
      'show',
      ':archive-e2e-staged.txt',
    ]);

    // Live attachment + tracked plan the archive must capture and the
    // restore must carry into the replacement worktree.
    const worktreeId = worktrees.worktrees[0].id;
    const workspaceMetaDir = path.join(userDataDir, 'workspaces', workspace.id);
    seedWorktreeChat({
      userDataDir,
      workspaceId: workspace.id,
      worktreeId,
      tabs: [
        {
          id: 'legacy-plugin-chat',
          title: 'Legacy plugin selections',
          providerType: 'claude',
          messages: [
            {
              id: 'retained-chat-message',
              role: 'user',
              timestamp: Date.parse(NOW),
              blocks: [
                {
                  type: 'text',
                  text: 'History retained across Windows archive and restore.',
                },
              ],
            },
          ],
          pluginSelections: {
            bundleIds: ['legacy-collection'],
            skillRefs: [],
            pluginRefs: [
              {
                marketplaceId: 'legacy-marketplace',
                pluginName: 'legacy-plugin',
              },
            ],
            mcpServerRefs: [],
          },
        },
      ],
      activeTabId: 'legacy-plugin-chat',
    });
    const attachmentsDir = path.join(
      workspaceMetaDir,
      'attachments',
      worktreeId,
    );
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(
      path.join(attachmentsDir, 'design-notes.txt'),
      'retained attachment\n',
    );
    writeJson(path.join(workspaceMetaDir, 'plans', `${worktreeId}.json`), {
      version: 1,
      plans: [
        {
          id: 'plan-e2e',
          projectId: workspace.id,
          worktreeId,
          source: 'claude',
          title: 'Archive E2E plan',
          content: '# Archive E2E plan\n\nRetained plan body.',
          reviewStatus: 'approved',
          createdAt: NOW,
          updatedAt: NOW,
          latestRevisionNumber: 1,
          revisions: [],
          linkedExecutionIds: [],
        },
      ],
    });

    const fileSyncObservationPath = path.join(
      userDataDir,
      'archive-worker-file-sync-observation.json',
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_ARCHIVE_FILE_SYNC_OBSERVATION: JSON.stringify({
          workspaceRoot: workspaceMetaDir,
          observationPath: fileSyncObservationPath,
        }),
      },
    });
    let completed = false;
    let mainOutput = '';
    const collectMainOutput = (chunk) => {
      mainOutput = (mainOutput + chunk.toString()).slice(-1024 * 1024);
    };
    electronApp.process().stdout?.on('data', collectMainOutput);
    electronApp.process().stderr?.on('data', collectMainOutput);
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${branchName}"]`,
      );
      await row.click();
      await expect(window.getByRole('textbox').first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(window.getByText('Canopy hit a renderer error')).toHaveCount(
        0,
      );

      const browserFixture = await seedBrowserProfileState(
        electronApp,
        window,
        { projectId: workspace.id, worktreeId },
      );
      // Reproduce Windows FlushFileBuffers access rules inside the utility
      // process that owns archive storage copying and teardown. Also inject a
      // short-lived directory sharing violation at quarantine admission; the
      // worker's real retry path must still finish the same UI flow.

      // Hold an archive-summary read after the backend has returned its stale
      // pre-archive snapshot but before the renderer applies it. The archive
      // action must wait for this request and then issue a trailing read; the
      // old request-deduping behavior reused only this stale response.
      await window.evaluate((workspaceId) => {
        window.__canopyArchivedContainersTestApi.holdNextLoadAfterRead();
        window.__canopyArchivedContainersTestApi.loadForWorkspace(workspaceId);
      }, workspace.id);
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.waitForHeldLoad(),
      );
      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.disableChangedRefresh(),
      );
      const staleReadCount = await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.getListReadCount(),
      );
      const trailingLoadRequestCount = await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.getTrailingLoadRequestCount(),
      );

      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      // Delete keeps the worktree for the retention window (the default
      // removal); Archive is a separate menu item that locks the container.
      await window.getByTestId('worktree-actions-menu-delete').click();
      const confirmDialog = window.getByRole('dialog', {
        name: 'Delete worktree?',
      });
      await expect(confirmDialog).toBeVisible();
      await confirmDialog
        .getByTestId('worktree-removal-preserve-branch')
        .click();
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(
          () =>
            window.evaluate(() =>
              window.__canopyArchivedContainersTestApi.getTrailingLoadRequestCount(),
            ),
          { timeout: 60_000 },
        )
        .toBe(trailingLoadRequestCount + 1);

      await window.evaluate(() =>
        window.__canopyArchivedContainersTestApi.releaseHeldLoad(),
      );
      await expect
        .poll(
          () =>
            window.evaluate(() =>
              window.__canopyArchivedContainersTestApi.getListReadCount(),
            ),
          { timeout: 5_000 },
        )
        .toBe(staleReadCount + 1);

      // Regression coverage for the post-archive read-after-write race: as
      // soon as the live row is removed, the initiating renderer must perform
      // a trailing authoritative archive-summary read. Do not wait for
      // filesystem verification below, because that would give the debounced
      // changed-event refresh time to mask a stale in-flight response.
      const archivedLink = window.getByTestId(
        `sidebar-project-${workspace.id}-archived-link`,
      );
      await expect(archivedLink).toHaveText('Archived and deleted 1', {
        timeout: 15_000,
      });

      await expect(() => {
        const { live: archivedChats } = readChatStorageIndexes(
          path.join(workspaceMetaDir, 'archived-containers', worktreeId),
          worktreeId,
        );
        expect(archivedChats.tabs[0].pluginSelections).toEqual({
          collectionIds: ['legacy-collection'],
          skillRefs: [],
          pluginRefs: [
            {
              marketplaceId: 'legacy-marketplace',
              pluginName: 'legacy-plugin',
            },
          ],
          mcpServerRefs: [],
        });
      }).toPass({ timeout: 15_000 });

      const archivedManifest = JSON.parse(
        readFileSync(
          path.join(
            workspaceMetaDir,
            'archived-containers',
            worktreeId,
            'container.json',
          ),
          'utf8',
        ),
      );
      expect(archivedManifest.version).toBe(2);
      expect(archivedManifest.gitState.repositories).toHaveLength(1);
      expect(
        archivedManifest.gitState.repositories[0].comparisonBaseBranch,
      ).toBe('main');
      expect(archivedManifest.gitState.repositories[0].baseBranchCommit).toBe(
        archivedManifest.gitState.repositories[0].comparisonBaseCommit,
      );
      expect(archivedManifest.gitState.repositories[0].headCommit).toBe(
        expectedHead,
      );
      expect(
        runGit(workspace.repoPath, [
          'rev-parse',
          archivedManifest.gitState.repositories[0].snapshotRef,
        ]),
      ).toBe(archivedManifest.gitState.repositories[0].worktreeSnapshotCommit);
      await archivedLink.click();
      // The link opens the full-page overview (left nav stays visible).
      // GitHub is unreachable here, so the capture records no confirmed PR:
      // the overview row must stay visually absent of a PR badge instead of
      // inferring one from cached live state.
      await expect(window.getByTestId('archived-overview-page')).toBeVisible();
      await expect(
        window.getByTestId('archived-overview-row-demo-main'),
      ).toBeVisible();
      await expect(
        window.getByTestId('archived-overview-state-demo-main'),
      ).toHaveAttribute('data-state', 'deleted');
      await expect(
        window.getByTestId('archived-overview-pr-demo-main'),
      ).toHaveCount(0);
      await window.getByTestId('archived-overview-open-demo-main').click();

      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();
      await expect(
        viewer.getByTestId('archived-base-branch-__single_repo__'),
      ).toContainText(
        `Base main @ ${archivedManifest.gitState.repositories[0].baseBranchCommit.slice(0, 8)}`,
      );
      await expect(
        viewer.getByTestId('archived-container-tab-chats'),
      ).toBeVisible();
      await viewer.getByTestId('archived-container-tab-pipelines').click();
      await expect(viewer).toContainText('No pipeline runs were retained');

      await viewer.getByTestId('archived-container-tab-changes').click();
      await expect(
        viewer.getByTestId(
          'diff-file-tree-row-__single_repo__:archive-e2e-renamed.txt',
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        viewer.getByTestId('archived-changes-summary-count'),
      ).toHaveText(`${archivedManifest.gitChanges.fileCount} changed files`);
      await expect(viewer.getByTestId('archived-changes-view')).toContainText(
        `+${archivedManifest.gitChanges.insertions}`,
      );
      await expect(viewer.getByTestId('archived-changes-view')).toContainText(
        `-${archivedManifest.gitChanges.deletions}`,
      );
      // The shared code-review tree shows the leaf name; the full rename path
      // stays available as the row's title/accessible name.
      const renamedRow = viewer.getByTestId(
        'diff-file-tree-row-__single_repo__:archive-e2e-renamed.txt',
      );
      await expect(renamedRow).toContainText('archive-e2e-renamed.txt');
      // CAN-2799: the rename path is the row's accessible name, not a title.
      await expect(renamedRow).toHaveAttribute(
        'aria-label',
        /archive-e2e-rename\.txt → archive-e2e-renamed\.txt/,
      );
      await viewer
        .getByTestId('diff-file-tree-row-__single_repo__:archive-e2e-both.txt')
        .click();
      await expect(
        viewer.getByTestId('archived-changes-diff-pane'),
      ).toContainText('working value', { timeout: 30_000 });

      await viewer.getByTestId('archived-container-tab-attachments').click();
      await expect(
        viewer.getByTestId('archived-attachment-row-design-notes.txt'),
      ).toBeVisible();

      await viewer.getByTestId('archived-container-tab-plans').click();
      await expect(
        viewer.getByTestId('archived-plan-row-plan-e2e'),
      ).toBeVisible();
      await expect(viewer.getByTestId('archived-plan-content')).toContainText(
        'Retained plan body.',
      );

      // Ensure the archived branch exists in the source repo to force a real
      // reusable branch (a local-only commit may already make archive's safe
      // `-d` cleanup retain it). Restore should reuse it when it still contains
      // the archived head and is not checked out elsewhere.
      try {
        runGit(workspace.repoPath, [
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${branchName}`,
        ]);
      } catch {
        runGit(workspace.repoPath, ['branch', branchName, expectedHead]);
      }
      // The captured base tip remains in main while main advances. Restore
      // must accept it and persist main as the new worktree's tracked base.
      runGit(workspace.repoPath, [
        'update-ref',
        'refs/heads/main',
        expectedHead,
      ]);
      await viewer.getByTestId('archived-restore').click();
      // Creating the replacement worktree publishes its sidebar row before
      // the restore IPC has replayed the archived index and working tree.
      // Wait for the viewer-to-destination navigation, which happens only
      // after the restore response, before inspecting the restored Git state.
      await expect(window.getByTestId('archived-container-view')).toBeHidden({
        timeout: 60_000,
      });
      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-branch="${branchName}"]`,
        ),
      ).toBeVisible({ timeout: 60_000 });

      // The restored worktree gets the captured attachment and a re-bound
      // tracked plan under its NEW worktree id.
      const restoredWorktrees = JSON.parse(
        readFileSync(worktreesPath, 'utf8'),
      ).worktrees.filter((worktree) => worktree.id !== worktreeId);
      expect(restoredWorktrees).toHaveLength(1);
      expect(restoredWorktrees[0].trackedBaseBranch).toBe('main');
      const restoredId = restoredWorktrees[0].id;
      expect(
        await readBrowserProfileState(electronApp, browserFixture),
      ).toEqual({ live: false, retained: false });
      const restoredBrowser = await openRestoredBrowserProfileState(
        electronApp,
        window,
        { projectId: workspace.id, worktreeId: restoredId },
        browserFixture,
      );
      expect(restoredBrowser.retained).toBe(false);
      expect(restoredBrowser.profile.resolvedProfileId).not.toBe(
        browserFixture.profile.resolvedProfileId,
      );
      expect(restoredBrowser.profile.taskIncarnationId).not.toBe(
        browserFixture.profile.taskIncarnationId,
      );
      const restoredPath = path.join(workspaceMetaDir, 'worktrees', restoredId);
      expect(runGit(restoredPath, ['rev-parse', 'HEAD'])).toBe(expectedHead);
      expect(
        runGitRaw(restoredPath, [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
        ]),
      ).toEqual(expectedStatus);
      expect(
        runGitRaw(restoredPath, ['show', ':archive-e2e-both.txt']),
      ).toEqual(expectedStagedBoth);
      expect(
        runGitRaw(restoredPath, ['show', ':archive-e2e-staged.txt']),
      ).toEqual(expectedStagedAdd);
      expect(
        readFileSync(path.join(restoredPath, 'archive-e2e-both.txt'), 'utf8'),
      ).toBe('working value\n');
      expect(
        readFileSync(
          path.join(restoredPath, 'archive-e2e-untracked.txt'),
          'utf8',
        ),
      ).toBe('untracked value\n');
      expect(
        existsSync(path.join(restoredPath, 'archive-e2e-ignored.txt')),
      ).toBe(false);
      expect(runGit(workspace.repoPath, ['cat-file', '-t', expectedHead])).toBe(
        'commit',
      );
      expect(
        existsSync(
          path.join(
            workspaceMetaDir,
            'attachments',
            restoredId,
            'design-notes.txt',
          ),
        ),
      ).toBe(true);
      const restoredPlans = JSON.parse(
        readFileSync(
          path.join(workspaceMetaDir, 'plans', `${restoredId}.json`),
          'utf8',
        ),
      );
      expect(restoredPlans.plans[0]).toMatchObject({
        id: 'plan-e2e',
        worktreeId: restoredId,
      });
      await app.selectWorktree(restoredId);
      await expect(
        chatPanelLocator(window).getByText(
          'History retained across Windows archive and restore.',
        ),
      ).toBeVisible();
      const flushes = JSON.parse(readFileSync(fileSyncObservationPath, 'utf8'));
      expect(flushes.flushedFiles).toBeGreaterThan(0);
      expect(flushes.rejectedReadOnlyFlushes).toBe(0);
      // Windows uses fs.rename for quarantine admission; Unix uses /bin/mv,
      // which bypasses the injected fs.rename sharing violation.
      expect(flushes.quarantineSharingViolations).toBe(
        process.platform === 'win32' ? 1 : 0,
      );
      completed = true;
    } finally {
      try {
        const observation = existsSync(fileSyncObservationPath)
          ? JSON.parse(readFileSync(fileSyncObservationPath, 'utf8'))
          : null;
        await testInfo.attach('windows-file-flush-observation', {
          body: JSON.stringify(observation ?? null),
          contentType: 'application/json',
        });
      } catch {
        // Diagnostics are best-effort when the Electron process has exited.
      } finally {
        if (!completed) {
          await testInfo.attach('archive-main-output', {
            body: mainOutput,
            contentType: 'text/plain',
          });
          await testInfo.attach('archive-fixture-path', {
            body: JSON.stringify({ userDataDir }),
            contentType: 'application/json',
          });
        }
        await closeCanopy(electronApp, userDataDir, {
          keepUserData:
            !completed &&
            process.env.CANOPY_E2E_RETAIN_FAILED_ARCHIVE_FIXTURE === '1',
        });
      }
    }
  });

  test('renders immutable archived PR metadata in the sidebar and viewer without any GitHub lookup', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-pr-metadata-'),
    );
    seedPreferences(userDataDir);
    const projectId = 'archived-pr-e2e';
    const workspaceDir = path.join(userDataDir, 'workspaces', projectId);
    const repoPath = path.join(userDataDir, 'pr-source-repo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, 'README.md'), 'pr metadata fixture\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repoPath });
    writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        {
          id: projectId,
          name: 'Archived PR Metadata',
          type: 'multi-repo',
          color: '#2563EB',
          collapsed: false,
          order: 0,
        },
      ],
    });
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'source', name: 'Source', repoPath }],
      sourceRepoPath: repoPath,
      alwaysShow: true,
      archiveRetentionDays: 7,
    });
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: [],
    });
    // Single-repository archive with one confirmed open PR: the sidebar must
    // show the state-colored `#42` next to the `+/-` diff badge.
    seedVersion2ArchivedContainer({
      workspaceRoot: workspaceDir,
      projectId,
      containerId: 'pr-single',
      name: 'Single PR worktree',
      branchName: 'feature/pr-single',
      workspaceType: 'single-repo',
      repositories: [
        {
          repoId: '__single_repo__',
          repoName: 'client',
          pullRequest: {
            number: 42,
            url: 'https://github.com/acme/client/pull/42',
            title: 'Preserve archived pull request metadata',
            state: 'open',
            baseRefName: 'main',
            updatedAt: NOW,
          },
        },
      ],
    });
    // Mixed multi-repository archive: confirmed draft + merged PRs, one
    // confirmed-none repo, one unavailable lookup.
    seedVersion2ArchivedContainer({
      workspaceRoot: workspaceDir,
      projectId,
      containerId: 'pr-multi',
      name: 'Multi PR worktree',
      branchName: 'feature/pr-multi',
      workspaceType: 'multi-repo',
      repositories: [
        {
          repoId: 'api',
          repoName: 'service-api',
          pullRequest: {
            number: 101,
            url: 'https://github.com/acme/service-api/pull/101',
            title: 'Archive API changes',
            state: 'draft',
            updatedAt: NOW,
          },
        },
        {
          repoId: 'web',
          repoName: 'service-web',
          pullRequest: {
            number: 88,
            url: 'https://github.com/acme/service-web/pull/88',
            title: 'Archive web changes',
            state: 'merged',
            updatedAt: NOW,
          },
        },
        { repoId: 'docs', repoName: 'service-docs', pullRequest: null },
        {
          repoId: 'infra',
          repoName: 'service-infra',
          pullRequest: 'unavailable',
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      // The fixture has no GitHub auth, no remotes, and fabricated PR URLs, so
      // the viewer's on-demand live refresh resolves nothing and everything
      // below renders from the immutable archived manifest summary.
      const archivedLink = window.getByTestId(
        `sidebar-project-${projectId}-archived-link`,
      );
      await expect(archivedLink).toHaveText('Archived and deleted 2', {
        timeout: 15_000,
      });
      await archivedLink.click();

      // Overview: an archive with any confirmed PR shows one plain PR icon —
      // no number chip, no state color — with the numbers on hover only.
      const singleRow = window.getByTestId('archived-overview-row-pr-single');
      const singleIndicator = singleRow.getByTestId(
        'archived-overview-pr-pr-single',
      );
      await expect(singleIndicator).toHaveText('');
      await expect(singleIndicator).toHaveAttribute('title', 'PR #42');
      await expect(singleIndicator.locator('svg')).toHaveCount(1);
      await expect(
        singleRow.getByTestId('archived-overview-diff-pr-single'),
      ).toContainText('+6');
      await expect(
        singleRow.getByTestId('archived-overview-diff-pr-single'),
      ).toContainText('-2');
      const multiRow = window.getByTestId('archived-overview-row-pr-multi');
      const multiIndicator = multiRow.getByTestId(
        'archived-overview-pr-pr-multi',
      );
      await expect(multiIndicator).toHaveText('');
      await expect(multiIndicator).toHaveAttribute(
        'title',
        'service-api: PR #101\nservice-web: PR #88',
      );

      // Viewer (single-repo): the PR badge sits in the top bar itself, left of
      // the diff stats, with no repository name and no mutable PR control.
      await singleRow.click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();
      await expect(viewer.getByTestId('archived-pr-section')).toHaveCount(0);
      const singleBadge = viewer.getByTestId('archived-pr-__single_repo__');
      await expect(singleBadge).toHaveText('#42');
      await expect(singleBadge).not.toContainText('client');
      await expect(singleBadge.locator('button')).toHaveCount(0);
      // The captured URL is the badge's own external link.
      await expect(singleBadge.locator('a')).toHaveAttribute(
        'href',
        'https://github.com/acme/client/pull/42',
      );

      // Viewer (multi-repo): one badge per confirmed association including the
      // repository name; confirmed-none and unavailable repos get no badge.
      await viewer.getByTestId('archived-container-view-close').click();
      await multiRow.click();
      await expect(viewer).toBeVisible();
      const apiBadge = viewer.getByTestId('archived-pr-api');
      await expect(apiBadge).toContainText('service-api');
      await expect(apiBadge).toContainText('#101');
      const webBadge = viewer.getByTestId('archived-pr-web');
      await expect(webBadge).toContainText('service-web');
      await expect(webBadge).toContainText('#88');
      await expect(viewer.getByTestId('archived-pr-docs')).toHaveCount(0);
      await expect(viewer.getByTestId('archived-pr-infra')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('cowork entry deletion opens a read-only archive above the composer', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-cowork-'),
    );
    seedPreferences(userDataDir);
    const workspaceDir = path.join(
      userDataDir,
      'workspaces',
      'cowork-archive-e2e',
    );
    writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        {
          id: 'cowork-archive-e2e',
          name: 'Archive Cowork',
          type: 'cowork',
          color: '#7C9B6D',
          collapsed: false,
          order: 0,
          cowork: { createdAt: NOW, archiveRetentionDays: null },
        },
      ],
    });
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { createdAt: NOW, archiveRetentionDays: null },
    });
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries: [
        { id: 'cowork-entry', title: 'Cowork retained entry', createdAt: NOW },
      ],
    });
    writeJson(path.join(workspaceDir, 'chats', 'cowork-entry.json'), {
      version: 1,
      activeTabId: 'cowork-chat',
      tabs: [chatTab('cowork-chat', 'Cowork retained entry')],
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await expandCoworkWorkspace(window, 'cowork-archive-e2e');
      await window.getByTestId('sidebar-work-entry-cowork-entry').click();
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible({ timeout: 30_000 });

      const browserFixture = await seedBrowserProfileState(
        electronApp,
        window,
        { projectId: 'cowork-archive-e2e', worktreeId: 'cowork-entry' },
      );

      const isolation = await measureEntryProfileIsolation(
        electronApp,
        window,
        { projectId: 'cowork-archive-e2e', worktreeId: 'cowork-entry' },
        browserFixture,
      );
      expect(isolation[0]).toEqual({
        profileId: browserFixture.profile.resolvedProfileId,
        retained: true,
      });
      expect(isolation[1].retained).toBe(false);
      expect(isolation[1].profileId).not.toBe(isolation[0].profileId);

      // A durability flush failure aborts removal and must retire the pending
      // archive placeholder before the user retries.
      await window.evaluate(() =>
        window.__canopyStandaloneChatTestApi.failNextWorkEntryFlush(),
      );
      const workEntryRow = window.getByTestId(
        'sidebar-work-entry-cowork-entry',
      );
      await workEntryRow.hover();
      await window.getByTestId('sidebar-work-entry-cowork-entry-menu').click();
      await window
        .getByTestId('sidebar-work-entry-cowork-entry-delete')
        .click();
      const failedDeleteDialog = window.getByTestId(
        'sidebar-work-entry-cowork-entry-delete-dialog',
      );
      const failedDeleteDialogVisible = await failedDeleteDialog
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (failedDeleteDialogVisible) {
        await failedDeleteDialog
          .getByTestId('sidebar-work-entry-cowork-entry-confirm-delete')
          .click();
      } else {
        await workEntryRow.getByRole('button', { name: 'Delete?' }).click();
      }
      await expect(workEntryRow).toBeVisible();
      await expect
        .poll(() =>
          window.evaluate(() =>
            window.__canopyArchivedContainersTestApi.getPendingContainerCount(
              'cowork-archive-e2e',
            ),
          ),
        )
        .toBe(0);

      expect(
        (await readBrowserProfileState(electronApp, browserFixture)).retained,
      ).toBe(true);
      // Clearing the native cache can fail after the owner removal commits.
      // Retirement still succeeds, and the user must see the pending status.
      await electronApp.evaluate(({ webContents }, id) => {
        const native = webContents.fromId(id).session;
        const clearCache = native.clearCache.bind(native);
        native.clearCache = async () => {
          native.clearCache = clearCache;
          throw new Error('Synthetic native cache cleanup failure');
        };
      }, browserFixture.webContentsId);
      await deleteWorkEntry(window, 'sidebar-work-entry', 'cowork-entry');
      await expect(
        window.getByText(
          'Browser profile retired; physical storage cleanup is pending.',
          { exact: true },
        ),
      ).toBeVisible();
      expect(
        await readBrowserProfileState(electronApp, browserFixture),
      ).toEqual({ live: false, retained: false });
      const archivedLink = window.getByTestId(
        'sidebar-cowork-project-cowork-archive-e2e-archived-link',
      );
      await expect(archivedLink).toHaveText('Archived and deleted 1', {
        timeout: 15_000,
      });
      await archivedLink.click();
      // CAN-3054 premise: the OVERVIEW is not page-like on cowork — CoworkTopBar
      // (which carries its own collapsed-titlebar spacer) stays above it, so the
      // overview header must NOT reserve the corner a second time. Only the
      // container viewer below unmounts that bar.
      await expect(window.getByTestId('archived-overview-page')).toBeVisible();
      await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
      await expect(
        window
          .getByTestId('archived-overview-titlebar')
          .getByTestId('page-titlebar-spacer'),
      ).toHaveCount(0);
      await window.getByTestId('archived-overview-open-cowork-entry').click();

      const overlay = window.getByTestId('cowork-archive-overlay');
      await expect(overlay).toBeVisible();
      await expect(overlay).toHaveClass(/z-30/);
      // Page-like: the entry-scoped cowork top bar must not render above the
      // archive UI (Code-page parity — the viewer covers the top bar there).
      await expect(window.getByTestId('cowork-top-bar')).toHaveCount(0);
      await expect(
        composer.click({ trial: true, timeout: 1_000 }),
      ).rejects.toThrow();
      await overlay.getByTestId('archived-restore').click();
      await expect(overlay).toHaveCount(0, { timeout: 30_000 });
      const restoredEntry = JSON.parse(
        readFileSync(path.join(workspaceDir, 'work-entries.json'), 'utf8'),
      ).entries.find((entry) => entry.title === 'Cowork retained entry');
      expect(restoredEntry).toBeTruthy();
      const restoredBrowser = await openRestoredBrowserProfileState(
        electronApp,
        window,
        { projectId: 'cowork-archive-e2e', worktreeId: restoredEntry.id },
        browserFixture,
      );
      expect(restoredBrowser.retained).toBe(false);
      expect(restoredBrowser.profile.resolvedProfileId).not.toBe(
        browserFixture.profile.resolvedProfileId,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('App Advisor popout archives, views, and restores a work entry', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-advisor-'),
    );
    seedPreferences(userDataDir);
    const workspaceDir = path.join(
      userDataDir,
      'app-workspaces',
      'app-advisor',
    );
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries: [
        {
          id: 'advisor-entry',
          title: 'Advisor retained entry',
          createdAt: NOW,
        },
      ],
    });
    writeJson(path.join(workspaceDir, 'chats', 'advisor-entry.json'), {
      version: 1,
      activeTabId: 'advisor-chat',
      tabs: [chatTab('advisor-chat', 'Advisor retained entry')],
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);

      const browserFixture = await seedBrowserProfileState(
        electronApp,
        advisor,
        { projectId: 'app-advisor', worktreeId: 'advisor-entry' },
      );
      const isolation = await measureEntryProfileIsolation(
        electronApp,
        advisor,
        { projectId: 'app-advisor', worktreeId: 'advisor-entry' },
        browserFixture,
      );
      expect(isolation[0]).toEqual({
        profileId: browserFixture.profile.resolvedProfileId,
        retained: true,
      });
      expect(isolation[1].retained).toBe(false);
      expect(isolation[1].profileId).not.toBe(isolation[0].profileId);
      await deleteWorkEntry(advisor, 'app-advisor-nav-entry', 'advisor-entry');
      await expect(
        advisor.getByText(
          'Browser profile retired; physical storage cleanup is pending.',
          { exact: true },
        ),
      ).toBeVisible();
      expect(
        await readBrowserProfileState(electronApp, browserFixture),
      ).toEqual({ live: false, retained: false });
      await advisor.getByTestId('app-advisor-nav-archived-link').click();
      await advisor.getByTestId('archived-overview-open-advisor-entry').click();
      const viewer = advisor.getByTestId('archived-container-view');
      await expect(viewer).toContainText('Advisor retained entry');
      // Page-like: the entry-scoped top bar must not render above the archive
      // UI, while the persistent titlebar-corner controls stay reachable.
      await expect(advisor.getByTestId('app-advisor-top-bar')).toHaveCount(0);
      await expect(
        advisor.getByTestId('app-advisor-nav-new-entry'),
      ).toBeVisible();

      // "New work entry" from the corner is explicit navigation to a live
      // target: it must dismiss the viewer and land on the fresh entry.
      await advisor.getByTestId('app-advisor-nav-new-entry').click();
      await expect(viewer).toHaveCount(0, { timeout: 15_000 });
      await expect(advisor.getByTestId('app-advisor-top-bar')).toBeVisible();
      await expect(advisor.getByRole('textbox').first()).toBeVisible({
        timeout: 15_000,
      });

      // Reopen the archived entry (via the overview) for the restore leg.
      await advisor.getByTestId('app-advisor-nav-archived-link').click();
      await advisor.getByTestId('archived-overview-open-advisor-entry').click();
      await expect(viewer).toContainText('Advisor retained entry');
      await viewer.getByTestId('archived-restore').click();
      await expect(
        advisor.getByTestId('archived-overview-open-advisor-entry'),
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        advisor
          .locator(
            '[data-testid^="app-advisor-nav-entry-"][data-standalone-chat-id]',
          )
          .filter({
            hasText: 'Advisor retained entry',
          }),
      ).toBeVisible({ timeout: 15_000 });
      const restoredEntry = JSON.parse(
        readFileSync(path.join(workspaceDir, 'work-entries.json'), 'utf8'),
      ).entries.find((entry) => entry.title === 'Advisor retained entry');
      expect(restoredEntry).toBeTruthy();
      const restoredBrowser = await openRestoredBrowserProfileState(
        electronApp,
        advisor,
        { projectId: 'app-advisor', worktreeId: restoredEntry.id },
        browserFixture,
      );
      expect(restoredBrowser.retained).toBe(false);
      expect(restoredBrowser.profile.resolvedProfileId).not.toBe(
        browserFixture.profile.resolvedProfileId,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('switches directly between retained worktree transcripts without reusing chat state', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-switch-'),
    );
    seedPreferences(userDataDir);
    const projectId = 'archived-switch-e2e';
    const workspaceDir = path.join(userDataDir, 'workspaces', projectId);
    const repoPath = path.join(userDataDir, 'archived-switch-source');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, 'README.md'), 'archive switch fixture\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repoPath });
    writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        {
          id: projectId,
          name: 'Archived Switch',
          type: 'multi-repo',
          color: '#7C3AED',
          collapsed: false,
          order: 0,
        },
      ],
    });
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'source', name: 'Source', repoPath }],
      sourceRepoPath: repoPath,
      alwaysShow: true,
      archiveRetentionDays: 7,
    });
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: [],
    });
    for (const [containerId, name] of [
      ['retained-one', 'Retained One'],
      ['retained-two', 'Retained Two'],
    ]) {
      seedArchivedContainer({
        workspaceRoot: workspaceDir,
        projectId,
        containerId,
        kind: 'worktree',
        name,
        workspaceType: 'multi-repo',
        messageCount: containerId === 'retained-one' ? 510 : 1,
      });
    }

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_ARCHIVED_CHAT_LIST_DELAY_CONTAINER_ID: 'retained-two',
        CANOPY_E2E_ARCHIVED_CHAT_LIST_DELAY_MS: '3000',
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const workspaceSection = window
        .getByTestId(`sidebar-project-header-${projectId}`)
        .locator('xpath=ancestor::section[1]');
      const link = workspaceSection.getByTestId(
        `sidebar-project-${projectId}-archived-link`,
      );
      await expect(link).toHaveText('Archived and deleted 2');
      await link.click();

      await window.getByTestId('archived-overview-open-retained-one').click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toContainText(
        'Retained transcript for Retained One chat',
      );
      await expect(
        viewer.getByText('Earliest retained transcript for Retained One chat', {
          exact: true,
        }),
      ).toHaveCount(0);
      // Earlier pages load as the user reaches the top of the scrollport.
      const transcriptScroller = viewer.getByTestId('chat-message-list-scroll');
      await expect
        .poll(async () => {
          await transcriptScroller.evaluate((element) => {
            element.scrollTop = 0;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
          return viewer.textContent();
        })
        .toContain('Earliest retained transcript for Retained One chat');

      // Back lands on the overview list; open the second archive from there.
      await window.getByTestId('archived-container-view-close').click();
      await expect(window.getByTestId('archived-overview-page')).toBeVisible();
      await window.getByTestId('archived-overview-open-retained-two').click();
      await window.waitForTimeout(250);
      expect(await viewer.getByTestId('archived-chat-nav').count()).toBe(0);
      expect(await viewer.textContent()).not.toContain(
        'Archived chat is unavailable.',
      );
      expect(await viewer.textContent()).not.toContain(
        'Retained transcript for Retained One chat',
      );
      await expect(viewer).toContainText(
        'Retained transcript for Retained Two chat',
      );
      await expect(viewer).not.toContainText(
        'Retained transcript for Retained One chat',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('temporary project remains for its retained container and disappears after permanent deletion push', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archived-temporary-'),
    );
    seedPreferences(userDataDir);
    const projectId = 'temporary-archive-e2e';
    const workspaceDir = path.join(userDataDir, 'workspaces', projectId);
    const repoPath = path.join(userDataDir, 'temporary-source-repo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(
      path.join(repoPath, 'README.md'),
      'temporary archive fixture\n',
    );
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repoPath });
    writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        {
          id: projectId,
          name: 'Temporary Archive',
          type: 'multi-repo',
          color: '#7C3AED',
          collapsed: false,
          order: 0,
        },
      ],
    });
    const workspaceConfig = {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'source', name: 'Source', repoPath }],
      sourceRepoPath: repoPath,
      alwaysShow: true,
      archiveRetentionDays: 7,
    };
    writeJson(path.join(workspaceDir, 'workspace.json'), workspaceConfig);
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: [],
    });
    seedArchivedContainer({
      workspaceRoot: workspaceDir,
      projectId,
      containerId: 'retained-worktree',
      kind: 'worktree',
      name: 'Retained temporary worktree',
      workspaceType: 'multi-repo',
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      const workspaceRow = window
        .getByTestId(`sidebar-project-header-${projectId}`)
        .locator('xpath=ancestor::section[1]');
      await expect(workspaceRow).toBeVisible();
      const link = workspaceRow.getByTestId(
        `sidebar-project-${projectId}-archived-link`,
      );
      await expect(link).toHaveText('Archived and deleted 1');
      await link.click();
      const archivedRow = window.getByTestId(
        'archived-overview-row-retained-worktree',
      );
      await archivedRow.hover();
      await window
        .getByTestId('archived-overview-retained-worktree-actions')
        .click();
      const archiveMenu = window.getByTestId(
        'archived-overview-retained-worktree-menu',
      );
      // A Deleted item offers Restore, Archive (keep until deleted), and
      // Permanent (below a divider); the old Lock/Unlock wording is gone.
      await expect(
        archiveMenu.getByText('Restore', { exact: true }),
      ).toBeVisible();
      await expect(
        archiveMenu.getByText('Archive', { exact: true }),
      ).toBeVisible();
      await expect(archiveMenu.getByText('Lock', { exact: true })).toHaveCount(
        0,
      );
      // Same labels and order as the web overview: the two recoverable
      // actions first, Permanent last below the divider.
      await expect(archiveMenu.getByRole('menuitem')).toHaveText([
        'Restore',
        'Archive',
        'Permanent',
      ]);
      await archiveMenu.getByText('Permanent', { exact: true }).click();
      const rowDeleteConfirmation = window.getByTestId(
        'archived-overview-retained-worktree-delete-confirmation',
      );
      await expect(rowDeleteConfirmation).toBeVisible();
      await expect(rowDeleteConfirmation).toContainText('Delete permanently?');
      await rowDeleteConfirmation
        .getByRole('button', { name: 'Cancel' })
        .click();
      await window
        .getByTestId('archived-overview-open-retained-worktree')
        .click();

      const viewer = window.getByTestId('archived-container-view');
      await viewer.getByTestId('archived-delete-permanently').click();
      // Switch the already-rendered fixture to the same persisted temporary
      // state produced by the one-off multi-repo creator, which writes
      // `alwaysShow: false` (an explicit true keeps an empty combination,
      // #4863). The purge-side refresh must now filter it once its final
      // retained container is gone.
      writeJson(path.join(workspaceDir, 'workspace.json'), {
        ...workspaceConfig,
        temporary: true,
        alwaysShow: false,
      });
      await window.evaluate(
        ({ workspaceId, containerId }) =>
          window.api.archivedContainers.delete({
            projectId: workspaceId,
            containerId,
          }),
        { workspaceId: projectId, containerId: 'retained-worktree' },
      );

      // The main-process purge broadcasts archived-containers:changed. The
      // renderer refresh observes zero containers and removes the deferred
      // temporary workspace without a reload.
      await expect(workspaceRow).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
