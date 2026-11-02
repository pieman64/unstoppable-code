// Deterministic archive/activity contention using the real lock and IPC handler.
// Shared by the durable archived-container spec and its visual evidence.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  ftruncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from '../canopyApp.mjs';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from '../launchCanopy.mjs';
import { chatPanelLocator } from '../panelHarness.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';
import { configureArchiveFixture } from './largeArchiveFixture.mjs';

function runGit(repoPath, args) {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
}
function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
function seedPreferences(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      defaultWorktreeProvider: 'claude',
    },
  });
}

export function seedArchiveActivityFixture({
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-archive-activity-')),
  archivePayloadBytes = 0,
  includeIndependentWorkspace = false,
} = {}) {
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: [
      'ts-pnpm-vite',
      ...(includeIndependentWorkspace ? ['ts-npm-next'] : []),
    ],
  });
  seedPreferences(userDataDir);
  const workspace = seeded.workspaces[0];
  configureArchiveFixture(userDataDir, workspace.id);
  const workspaceRoot = path.join(userDataDir, 'workspaces', workspace.id);
  const worktreesPath = path.join(workspaceRoot, 'worktrees.json');
  const worktrees = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  const original = worktrees.worktrees[0];
  // Include local Git state in the retained container alongside the chat.
  const localPackagePath = path.join(workspace.worktreePath, 'package.json');
  writeFileSync(
    localPackagePath,
    `${readFileSync(localPackagePath, 'utf8')}\n`,
  );
  if (archivePayloadBytes > 0) {
    const payloadPath = path.join(
      workspace.worktreePath,
      'archive-payload.bin',
    );
    const handle = openSync(payloadPath, 'w');
    try {
      ftruncateSync(handle, archivePayloadBytes);
    } finally {
      closeSync(handle);
    }
  }
  const otherId = 'activity-other';
  const otherPath = path.join(workspaceRoot, 'worktrees', otherId);
  runGit(workspace.repoPath, [
    'worktree',
    'add',
    '-b',
    'feature/activity-other',
    otherPath,
  ]);
  worktrees.worktrees.push({
    ...original,
    id: otherId,
    branchName: 'feature/activity-other',
    createdAt: new Date().toISOString(),
  });
  writeJson(worktreesPath, worktrees);
  for (const id of [original.id, otherId]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: workspace.id,
      worktreeId: id,
      providerType: 'claude',
      tabs: [
        {
          id: `${id}-chat`,
          title: `${id} retained chat`,
          model: 'opus[1m]',
        },
      ],
    });
  }
  return {
    userDataDir,
    workspace,
    workspaceRoot,
    worktreesPath,
    original,
    otherId,
    independentWorkspace: seeded.workspaces[1] ?? null,
  };
}

export async function launchArchiveActivityFixture(
  queueBackgroundActivity = true,
  {
    buildKind,
    activityMode = 'queued-touch',
    holdArchiveAtCapture = false,
    preloadSibling = true,
    archivePayloadBytes = 0,
    env,
  } = {},
) {
  const seededFixture = seedArchiveActivityFixture({ archivePayloadBytes });
  const {
    userDataDir,
    workspace,
    workspaceRoot,
    worktreesPath,
    original,
    otherId,
  } = seededFixture;
  const launched = await launchCanopy({ userDataDir, buildKind, env });
  const { electronApp } = launched;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    if (preloadSibling) {
      // Most archive regressions keep their original eager fixture behavior.
      // Responsiveness coverage disables this so navigation also proves cold
      // sibling hydration while archive capture remains held.
      await app.selectWorktree(otherId);
      await expect(chatPanelLocator(window)).toBeVisible();
    }
    await app.selectWorktree(original.id);
    await expect(chatPanelLocator(window)).toBeVisible();
    if (buildKind !== 'production')
      await electronApp.evaluate(
        (
          { ipcMain },
          { queueActivity, activityMode, scope, holdArchiveAtCapture },
        ) => {
          const activity = globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__;
          const originalHandler =
            ipcMain._invokeHandlers.get('worktree:archive');
          if (!activity || typeof originalHandler !== 'function') {
            throw new Error('Archive/activity test seam is unavailable');
          }
          const { AsyncResource } =
            process.getBuiltinModule('node:async_hooks');
          // Construct outside the archive's AsyncLocalStorage context, just
          // like terminal output arriving while an archive is in progress.
          const background = new AsyncResource('archive-background-activity');
          const observation = {
            entered: false,
            completed: false,
            touchCompleted: !queueActivity,
            touchCompletedBeforeArchive: false,
            captureBarrierEntered: false,
            modelChangeEntered: false,
            modelChangeCompleted: false,
          };
          globalThis.__archiveActivityObservation = observation;
          let releaseCaptureBarrier = () => {};
          const captureBarrier = new Promise((resolve) => {
            releaseCaptureBarrier = resolve;
          });
          globalThis.__releaseArchiveActivityBarrier = () => {
            releaseCaptureBarrier();
          };
          const originalModelChangeHandler =
            ipcMain._invokeHandlers.get('chat:model-change');
          if (typeof originalModelChangeHandler === 'function') {
            ipcMain.removeHandler('chat:model-change');
            ipcMain.handle('chat:model-change', async (event, request) => {
              observation.modelChangeEntered = true;
              try {
                const result = await originalModelChangeHandler(event, request);
                observation.modelChangeResult = result;
                return result;
              } catch (error) {
                observation.modelChangeError = String(error);
                throw error;
              } finally {
                observation.modelChangeCompleted = true;
              }
            });
          }
          const targetsScope = (name, args) => {
            if (name === 'captureStorageScope') {
              return (
                args[0]?.projectId === scope.projectId &&
                args[0]?.worktreeId === scope.worktreeId
              );
            }
            return args[0] === scope.projectId && args[1] === scope.worktreeId;
          };
          let releaseAdmission = () => {};
          if (queueActivity && activityMode === 'admitted') {
            const admissionGate = new Promise((resolve) => {
              releaseAdmission = resolve;
            });
            void activity
              .getChatStateService()
              .runWithScopeActivity(scope, async () => {
                await admissionGate;
                await activity.touchWorkspaceTarget(
                  scope.projectId,
                  scope.worktreeId,
                  Date.now() + 61_000,
                );
                observation.touchCompleted = true;
              })
              .catch((error) => {
                observation.error = String(error);
              });
          }
          ipcMain.removeHandler('worktree:archive');
          ipcMain.handle('worktree:archive', (event, request) => {
            if (holdArchiveAtCapture) {
              const service = activity.getChatStateService();
              const originalCapture = service.captureStorageScope.bind(service);
              let held = false;
              service.captureStorageScope = async (...args) => {
                if (!held && targetsScope('captureStorageScope', args)) {
                  held = true;
                  observation.captureBarrierEntered = true;
                  await captureBarrier;
                }
                return originalCapture(...args);
              };
            }
            if (['provider-commit', 'settings-commit'].includes(activityMode)) {
              const service = activity.getChatStateService();
              const repository = service.repository;
              const originalObserver = repository.onCommit;
              let releaseCommit;
              let commitReady;
              const gate = new Promise((resolve) => {
                releaseCommit = resolve;
              });
              const ready = new Promise((resolve) => {
                commitReady = resolve;
              });
              let first = true;
              repository.setCommitListener(async (commit) => {
                if (
                  first &&
                  commit.projectId === scope.projectId &&
                  commit.worktreeId === scope.worktreeId
                ) {
                  first = false;
                  observation.commitEntered = true;
                  commitReady();
                  await gate;
                }
                // Exercise the real observer outside its minute-long coalescing
                // interval, without advancing the rest of the app's clock.
                const realNow = Date.now;
                let pending;
                try {
                  Date.now = () => realNow() + 121_000;
                  pending = originalObserver(commit);
                } finally {
                  Date.now = realNow;
                }
                await pending;
              });
              for (const name of [
                'flushScope',
                'flushScopeForArchivedContainerCaptureDuringDeletion',
                'captureStorageScope',
              ]) {
                const originalFlush = service[name].bind(service);
                service[name] = (...args) => {
                  if (targetsScope(name, args) && observation.entered) {
                    observation.captureEntered = true;
                    releaseCommit();
                  }
                  return originalFlush(...args);
                };
              }
              const writer =
                activityMode === 'provider-commit'
                  ? service.ingestProviderEvent({
                      ...scope,
                      chatId: `${scope.worktreeId}-chat`,
                      mutationId: 'archive-provider-commit',
                      data: {
                        type: 'claude_terminal_transcript_sync',
                        messages: [
                          {
                            id: 'archive-provider-message',
                            role: 'assistant',
                            blocks: [
                              {
                                type: 'text',
                                text: 'Provider output retained during deletion',
                              },
                            ],
                            timestamp: Date.now(),
                          },
                        ],
                      },
                    })
                  : service.command({
                      schemaVersion: 1,
                      commandId: 'archive-settings-commit',
                      ...scope,
                      command: {
                        type: 'chat.patch_tab_settings',
                        tabId: `${scope.worktreeId}-chat`,
                        patch: { title: 'Renamed before deletion' },
                      },
                    });
              void writer
                .then(() => {
                  observation.touchCompleted = true;
                })
                .catch((error) => {
                  observation.error = String(error);
                });
              return ready.then(async () => {
                observation.entered = true;
                const archive = originalHandler(event, request);
                if (activityMode === 'settings-commit') {
                  // Settings commands hold a runtime-start reservation until
                  // their commit observer returns. Archive drains that
                  // reservation before capture, so release this held commit
                  // after the archive request enters, not from a capture hook.
                  await new Promise((resolve) => setImmediate(resolve));
                  releaseCommit();
                }
                const result = await archive;
                observation.completed = true;
                return result;
              });
            }
            if (queueActivity && activityMode === 'admitted') {
              observation.entered = true;
              setImmediate(releaseAdmission);
              return originalHandler(event, request).then((result) => {
                observation.completed = true;
                return result;
              });
            }
            if (queueActivity) {
              // Queue external activity once archive capture actually holds
              // the project lock, rather than adding an artificial outer lock
              // around the entire IPC handler (including admission drain).
              const service = activity.getChatStateService();
              let queued = false;
              for (const name of ['flushScope', 'captureStorageScope']) {
                const originalCapture = service[name].bind(service);
                service[name] = async (...args) => {
                  if (!queued && targetsScope(name, args)) {
                    queued = true;
                    void background
                      .runInAsyncScope(() =>
                        activity.touchWorkspaceTarget(
                          scope.projectId,
                          scope.worktreeId,
                          Date.now() + 61_000,
                        ),
                      )
                      .then(() => {
                        observation.touchCompletedBeforeArchive =
                          !observation.completed;
                        observation.touchCompleted = true;
                      });
                    await new Promise((resolve) => setImmediate(resolve));
                  }
                  return originalCapture(...args);
                };
              }
            }
            observation.entered = true;
            return originalHandler(event, request).then((result) => {
              observation.completed = true;
              return result;
            });
          });
        },
        {
          queueActivity: queueBackgroundActivity,
          activityMode,
          holdArchiveAtCapture,
          scope: { projectId: workspace.id, worktreeId: original.id },
        },
      );
    return {
      electronApp,
      userDataDir,
      window,
      app,
      workspace,
      workspaceRoot,
      worktreesPath,
      original,
      otherId,
      buildKind,
      supervisedTreePid: launched.supervisedTreePid,
    };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir);
    throw error;
  }
}

export async function releaseArchiveActivityBarrier(electronApp) {
  await electronApp.evaluate(() => {
    globalThis.__releaseArchiveActivityBarrier?.();
  });
}

export async function installArchiveCaptureBarrier(
  electronApp,
  { projectId, worktreeId },
) {
  await electronApp.evaluate(
    ({ ipcMain }, scope) => {
      const activity = globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__;
      const originalHandler = ipcMain._invokeHandlers.get('worktree:archive');
      if (!activity || typeof originalHandler !== 'function') {
        throw new Error('Archive/activity performance seam is unavailable');
      }
      const observation = {
        entered: false,
        completed: false,
        captureBarrierEntered: false,
        modelChangeEntered: false,
        modelChangeCompleted: false,
      };
      globalThis.__archiveActivityObservation = observation;
      let releaseCaptureBarrier = () => {};
      const captureBarrier = new Promise((resolve) => {
        releaseCaptureBarrier = resolve;
      });
      globalThis.__releaseArchiveActivityBarrier = releaseCaptureBarrier;
      const originalModelChangeHandler =
        ipcMain._invokeHandlers.get('chat:model-change');
      if (typeof originalModelChangeHandler === 'function') {
        ipcMain.removeHandler('chat:model-change');
        ipcMain.handle('chat:model-change', async (event, request) => {
          observation.modelChangeEntered = true;
          try {
            const result = await originalModelChangeHandler(event, request);
            observation.modelChangeResult = result;
            return result;
          } catch (error) {
            observation.modelChangeError = String(error);
            throw error;
          } finally {
            observation.modelChangeCompleted = true;
          }
        });
      }
      ipcMain.removeHandler('worktree:archive');
      ipcMain.handle('worktree:archive', async (event, request) => {
        const service = activity.getChatStateService();
        const originalCapture = service.captureStorageScope.bind(service);
        let held = false;
        service.captureStorageScope = async (...args) => {
          const requestScope = args[0];
          if (
            !held &&
            requestScope?.projectId === scope.projectId &&
            requestScope?.worktreeId === scope.worktreeId
          ) {
            held = true;
            observation.captureBarrierEntered = true;
            await captureBarrier;
          }
          return originalCapture(...args);
        };
        observation.entered = true;
        try {
          return await originalHandler(event, request);
        } finally {
          observation.completed = true;
        }
      });
    },
    { projectId, worktreeId },
  );
}

export async function commitArchiveSiblingProviderMarker(
  electronApp,
  { projectId, worktreeId, chatId, text },
) {
  await electronApp.evaluate(
    async (_electron, marker) => {
      const activity = globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__;
      await activity.getChatStateService().ingestProviderEvent({
        projectId: marker.projectId,
        worktreeId: marker.worktreeId,
        chatId: marker.chatId,
        mutationId: `archive-sibling-${Date.now()}`,
        data: {
          type: 'claude_terminal_transcript_sync',
          messages: [
            {
              id: `archive-sibling-message-${Date.now()}`,
              role: 'assistant',
              blocks: [{ type: 'text', text: marker.text }],
              timestamp: Date.now(),
            },
          ],
        },
      });
    },
    { projectId, worktreeId, chatId, text },
  );
}

export async function deleteArchiveActivityWorktree({
  window,
  electronApp,
  original,
  workspace,
  buildKind,
}) {
  const archiveRow = window.locator(
    `[data-testid="worktree-row"][data-worktree-id="${original.id}"]${workspace ? `[data-project-id="${workspace.id}"]` : ''}`,
  );
  await archiveRow.hover();
  await archiveRow.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-delete').click();
  const dialog = window.getByRole('dialog', { name: /^Delete worktree/ });
  // A known clean/done worktree can delete directly. Otherwise confirm its
  // branch handling; only then check authoritative completion in the caller.
  await expect
    .poll(
      async () =>
        (await dialog.isVisible()) || (await archiveRow.count()) === 0,
    )
    .toBe(true);
  if (await dialog.isVisible()) {
    if (buildKind === 'production') {
      // Automation-only test IDs are absent from the release bundle.
      // The branch switch keeps the local branch by default.
      await dialog
        .getByRole('button', { name: 'Delete worktree', exact: true })
        .click();
    } else {
      await dialog.getByTestId('worktree-removal-preserve-branch').click();
    }
  }
  if (buildKind !== 'production')
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.__archiveActivityObservation.entered,
        ),
      )
      .toBe(true);
  return archiveRow;
}

export async function closeArchiveActivityFixture({
  electronApp,
  userDataDir,
}) {
  await releaseArchiveActivityBarrier(electronApp).catch(() => undefined);
  // A red regression run intentionally wedges main's archive queue.
  // Exit only this isolated harness process so cleanup cannot hang.
  const blocked = await electronApp
    .evaluate(
      () =>
        globalThis.__archiveActivityObservation?.entered &&
        !globalThis.__archiveActivityObservation?.completed,
    )
    .catch(() => false);
  if (blocked)
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closeCanopy(electronApp, userDataDir);
}
