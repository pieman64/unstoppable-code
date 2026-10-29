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
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectScriptRunEvent, seedWorktreeChat } from './seeders/index.mjs';

// Doc 3 — Supplemental gap plan, gaps G1, G5, and G6.
//
// Reworked for the unified sidebar (T1–T8): worktree rows now live in the
// always-visible left sidebar's Code Workspaces section instead of an in-page
// aside, and Kanban is a "More"-menu page destination (which auto-hides the
// sidebar) rather than an in-page view toggle.
//
// Seed B1: a single demo workspace (`ts-pnpm-vite`) with a default `demo-main`
// worktree. The seeded workspace id is `demo-ts-pnpm-vite` and the worktree
// branch is `demo-main` (demo-apps/seed-canopy-data.mjs). `selectWorktree`
// matches the `[data-testid="worktree-row"]` whose `data-branch="demo-main"`.
//
//   G1 — Worktree-row selection mounts ChatPanel + ChatTabBar.
//   G5 — Worktree actions menu items, toggle-hidden round-trip, and the delete
//        confirm UI (without confirming the delete).
//   G6 — Kanban page (via More menu): board, status columns, seeded card, and
//        return to the worktree page.
//
// Determinism: no live agents, no network, and no PTY. The `ts-pnpm-vite`
// fixture is plain (no setup/launch scripts — see demo-workspaces.spec.mjs),
// so the seeded worktree stays idle. The deletion-fence regression uses an
// E2E-only cleanup checkpoint to place a real renderer flush inside cleanup.

// Reserve the other catalog names in the create request so reuse is deterministic.
const animalCatalog = readFileSync(
  new URL(
    '../../../../packages/protocol/src/worktree-branch-names/animal-names.ts',
    import.meta.url,
  ),
  'utf8',
)
  .split('export const ANIMAL_NAMES = [')[1]
  .split('] as const')[0];
const ANIMAL_NAMES = Array.from(
  animalCatalog.matchAll(/'([^']+)'/g),
  (match) => match[1],
);

const WORKTREE_BRANCH = 'demo-main';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';

/**
 * Whether main's desktop session snapshot lists the worktree. The portal
 * overview is built by the same enumerator, so this is what a paired browser
 * would be shown.
 */
async function sessionSnapshotListsWorktree(window, workspaceId, worktreeId) {
  return window.evaluate(
    async ({ workspaceId, worktreeId }) => {
      const snapshot = await window.api.getDesktopSessionSnapshot({});
      return snapshot.worktrees.some(
        (worktree) =>
          worktree.workspaceLocalId === workspaceId &&
          worktree.localId === worktreeId,
      );
    },
    { workspaceId, worktreeId },
  );
}

/**
 * A row the sidebar reads as clean deletes at once; any other asks first.
 * Which one a row mid-setup gets depends on what the renderer has loaded for
 * it, so the removal specs accept both.
 */
async function confirmWorktreeDeleteIfAsked(window) {
  const deleteDialog = window.getByRole('dialog', { name: 'Delete worktree?' });
  const asked = await deleteDialog
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(
      () => true,
      () => false,
    );
  if (asked) await deleteDialog.getByRole('button').last().click();
}

function persistedWorktreeIds(userDataDir, workspaceId) {
  return JSON.parse(
    readFileSync(
      path.join(userDataDir, 'workspaces', workspaceId, 'worktrees.json'),
      'utf8',
    ),
  ).worktrees.map((worktree) => worktree.id);
}

test.describe('worktree lifecycle (G1/G5/G6)', () => {
  // Every W5 registry write is decided and applied by the commit-log worker
  // (CAN-3805): main posts it one commit and awaits the answer, and the
  // worker installs the file by atomic rename, so a reader sees either the
  // previous or the new registry, never a partial one. Main-thread fs hooks
  // no longer see the write. The overlap variant holds a label write at the
  // host-to-worker boundary, so it is in flight while archive runs: archive
  // must not deadlock behind it, must not fail on the registry once it
  // lands, and must not drop the label. The label goes to a neighbouring
  // worktree that survives the archive, so a registry rewrite from a stale
  // snapshot would visibly lose it.
  for (const overlap of [false, true])
    test(`archive succeeds ${overlap ? 'while' : 'after'} a worktree metadata write is publishing`, async () => {
      test.setTimeout(120_000);
      const { electronApp, userDataDir } = await launchCanopy({
        seedDemoWorkspaces: true,
        demoWorkspaceApps: ['ts-pnpm-vite'],
      });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await app.openMainPage();
        const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
        const registry = path.join(workspaceDir, 'worktrees.json');
        const readRegistry = () =>
          JSON.parse(readFileSync(registry, 'utf8')).worktrees;
        const { repoPath } = JSON.parse(
          readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8'),
        );
        const neighbour = await window.evaluate(
          (request) => window.api.createWorktree(request),
          {
            projectId: WORKSPACE_ID,
            repoPath,
            existingWorktreeIds: [WORKTREE_BRANCH],
            branchName: 'archive-overlap-neighbour',
          },
        );
        await expect(
          window.locator(
            `[data-testid="worktree-row"][data-worktree-id="${neighbour.id}"]`,
          ),
        ).toBeVisible({ timeout: 30_000 });
        await expect
          .poll(() => persistedWorktreeIds(userDataDir, WORKSPACE_ID), {
            timeout: 30_000,
          })
          .toContain(neighbour.id);

        const label = 'Archive overlap';
        await electronApp.evaluate(
          ({ ipcMain }, { target, overlap, worktreeId, label }) => {
            const { Worker } = process.getBuiltinModule('node:worker_threads');
            const post = Worker.prototype.postMessage;
            const archive = ipcMain._invokeHandlers.get('worktree:archive');
            const setLabel = ipcMain._invokeHandlers.get('worktree:set-label');
            let release;
            const gate = new Promise((resolve) => {
              release = resolve;
            });
            let markHeld;
            const held = new Promise((resolve) => {
              markHeld = resolve;
            });
            const probe = { held: undefined, labelResult: undefined };
            globalThis.__archiveOverlapProbe = probe;
            // The commit-log host's only route to its worker. Holding the
            // label's commit here leaves it submitted but unanswered, with
            // the registry on disk still the previous version.
            Worker.prototype.postMessage = function (message, ...rest) {
              const commit =
                message?.method === 'commit' ? message.args?.[0] : undefined;
              const file = commit?.files?.find(
                (entry) => entry.path === target,
              );
              if (
                overlap &&
                !probe.held &&
                commit?.operation === 'core.worktree.update' &&
                typeof file?.contents === 'string'
              ) {
                probe.held = JSON.parse(file.contents).worktrees;
                markHeld();
                void gate.then(() => post.call(this, message, ...rest));
                return undefined;
              }
              return post.call(this, message, ...rest);
            };
            // Start the label inside the archive request, after the
            // renderer's pre-archive teardown has published its own registry
            // update; holding the label before that step would block the
            // archive request from being sent at all.
            ipcMain.removeHandler('worktree:archive');
            ipcMain.handle('worktree:archive', async (...args) => {
              const labelWrite = setLabel(args[0], {
                projectId: args[1].projectId,
                worktreeId,
                label,
              }).then(
                () => {
                  probe.labelResult = { ok: true };
                },
                (error) => {
                  probe.labelResult = { ok: false, message: error.message };
                },
              );
              // Overlap: archive starts once the label's commit is held.
              await (overlap ? Promise.race([held, labelWrite]) : labelWrite);
              globalThis.__archiveStarted = true;
              try {
                const result = await archive(...args);
                globalThis.__archiveRegistryResult = { ok: true };
                return result;
              } catch (error) {
                globalThis.__archiveRegistryResult = {
                  ok: false,
                  message: error.message,
                };
                throw error;
              } finally {
                release();
                await labelWrite;
              }
            });
            globalThis.__releaseArchiveOverlap = release;
            globalThis.__restoreArchiveOverlapProbe = () => {
              release();
              Worker.prototype.postMessage = post;
              ipcMain.removeHandler('worktree:archive');
              ipcMain.handle('worktree:archive', archive);
            };
          },
          { target: registry, overlap, worktreeId: neighbour.id, label },
        );

        const row = window.locator(
          `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
        );
        await row.hover();
        await row.getByTestId('worktree-archive-button').click();
        if (overlap) {
          await expect
            .poll(() =>
              electronApp.evaluate(() => globalThis.__archiveStarted === true),
            )
            .toBe(true);
          expect(
            await electronApp.evaluate(
              (_electron, id) =>
                globalThis.__archiveOverlapProbe.held?.find(
                  (entry) => entry.id === id,
                )?.label,
              neighbour.id,
            ),
          ).toBe(label);
          // Archive is under way with the label write submitted but not
          // answered. Its locked registry read and its own publication both
          // wait for that write, so give it time to reach them: neither may
          // finish until the write is released.
          await window.waitForTimeout(1_000);
          expect(
            await electronApp.evaluate(() => ({
              archive: globalThis.__archiveRegistryResult,
              label: globalThis.__archiveOverlapProbe.labelResult,
            })),
          ).toEqual({ archive: undefined, label: undefined });
          // Submitted but unanswered: the published registry is still the
          // previous, complete version.
          expect(
            Object.fromEntries(
              readRegistry().map((entry) => [entry.id, entry.label ?? null]),
            ),
          ).toEqual({ [WORKTREE_BRANCH]: null, [neighbour.id]: null });
          await electronApp.evaluate(() =>
            globalThis.__releaseArchiveOverlap(),
          );
        }
        await expect
          .poll(
            () =>
              electronApp.evaluate(() => globalThis.__archiveRegistryResult),
            { timeout: 60_000 },
          )
          .toBeDefined();
        expect(
          await electronApp.evaluate(() => ({
            archive: globalThis.__archiveRegistryResult,
            label: globalThis.__archiveOverlapProbe.labelResult,
          })),
        ).toEqual({ archive: { ok: true }, label: { ok: true } });
        await expect(row).toHaveCount(0);
        const persisted = readRegistry();
        expect(
          persisted.some(
            (entry) => entry.id === WORKTREE_BRANCH && !entry.archived,
          ),
        ).toBe(false);
        expect(
          persisted.find((entry) => entry.id === neighbour.id)?.label,
        ).toBe(label);
      } finally {
        await electronApp
          .evaluate(() => globalThis.__restoreArchiveOverlapProbe?.())
          .catch(() => undefined);
        await closeCanopy(electronApp, userDataDir);
      }
    });

  for (const sendEarly of [false, true])
    test(`a newly created empty worktree supports ${sendEarly ? 'sending' : 'drafting'} with resolved defaults before chat hydration completes`, async () => {
      const { electronApp, userDataDir } = await launchCanopy({
        seedDemoWorkspaces: true,
        demoWorkspaceApps: ['ts-pnpm-vite'],
      });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await app.openMainPage();
        await electronApp.evaluate(({ ipcMain }) => {
          const create = ipcMain._invokeHandlers.get('chat:command');
          ipcMain.removeHandler('chat:command');
          ipcMain.handle('chat:command', async (event, request) => {
            const result = await create(event, request);
            if (request.command.type === 'chat.create_tab')
              globalThis.__eagerStarterCreated = true;
            return result;
          });
          const original = ipcMain._invokeHandlers.get('chat:get-state');
          const gate = new Promise((resolve) => {
            globalThis.__releaseEagerNewChat = resolve;
          });
          ipcMain.removeHandler('chat:get-state');
          ipcMain.handle('chat:get-state', async (event, request) => {
            if (
              request.projectId === 'demo-ts-pnpm-vite' &&
              request.worktreeId !== 'demo-main'
            ) {
              globalThis.__eagerNewChatHeld = true;
              await gate;
            }
            return original(event, request);
          });
          ipcMain.removeHandler('chat:send-message');
          ipcMain.handle('chat:send-message', async (event, request) => {
            const state = await original(event, {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
            });
            globalThis.__eagerSentChatExists = state.tabsFile.tabs.some(
              (tab) => tab.id === request.chatId,
            );
            return {};
          });
          ipcMain.removeHandler('approval:resolved-default');
          ipcMain.handle('approval:resolved-default', () => 'full-access');
        });
        await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
        await window
          .getByRole('button', {
            name: `Create worktree for ${WORKSPACE_NAME}`,
          })
          .click();
        await expect
          .poll(() => electronApp.evaluate(() => globalThis.__eagerNewChatHeld))
          .toBe(true);
        const panel = window.getByTestId('panel-content-chat');
        const editor = panel.locator('[data-slate-editor="true"]');
        await expect(editor).toBeVisible();
        await editor.fill('Draft while the new chat loads');
        await expect(panel.getByTestId('chat-model-picker')).toBeVisible();
        await expect(panel.getByTestId('approval-mode-icon')).toHaveAttribute(
          'data-approval-mode',
          'full-access',
        );
        if (sendEarly) {
          await editor.press('Enter');
          await expect(editor).not.toContainText(
            'Draft while the new chat loads',
          );
          await expect(
            panel.getByText('Draft while the new chat loads', { exact: true }),
          ).toHaveCount(1);
          await expect(panel.getByTestId('turn-timer-label')).toHaveText(
            'Working…',
          );
          await expect(
            panel.getByTestId('turn-timer').getByRole('button'),
          ).toHaveCount(0);
          expect(
            await electronApp.evaluate(() => globalThis.__eagerSentChatExists),
          ).toBeUndefined();
        }
        await electronApp.evaluate(() => globalThis.__releaseEagerNewChat());
        await expect
          .poll(() =>
            electronApp.evaluate(() => globalThis.__eagerStarterCreated),
          )
          .toBe(true);
        if (sendEarly) {
          await expect
            .poll(() =>
              electronApp.evaluate(() => globalThis.__eagerSentChatExists),
            )
            .toBe(true);
          await expect(
            panel.getByText('Draft while the new chat loads', { exact: true }),
          ).toHaveCount(1);
        } else {
          await expect(editor).toContainText('Draft while the new chat loads');
        }
        await expect(panel.getByTestId('approval-mode-icon')).toHaveAttribute(
          'data-approval-mode',
          'full-access',
        );
      } finally {
        await electronApp
          .evaluate(() => globalThis.__releaseEagerNewChat?.())
          .catch(() => {});
        await closeCanopy(electronApp, userDataDir);
      }
    });

  test('a later send retries eager tab creation after the hydration attempt is rejected', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await electronApp.evaluate(({ ipcMain }) => {
        const command = ipcMain._invokeHandlers.get('chat:command');
        ipcMain.removeHandler('chat:command');
        ipcMain.handle('chat:command', async (event, request) => {
          if (request.command.type === 'chat.create_tab') {
            globalThis.__eagerCreateAttempts =
              (globalThis.__eagerCreateAttempts ?? 0) + 1;
            if (globalThis.__eagerCreateAttempts === 1) {
              return {
                commandId: request.commandId,
                revision: request.expectedRevision,
                outcome: 'rejected',
                reason: 'E2E injected first-attempt rejection',
              };
            }
          }
          return command(event, request);
        });
        const getState = ipcMain._invokeHandlers.get('chat:get-state');
        const gate = new Promise((resolve) => {
          globalThis.__releaseRejectedEagerHydration = resolve;
        });
        ipcMain.removeHandler('chat:get-state');
        ipcMain.handle('chat:get-state', async (event, request) => {
          if (
            request.projectId === 'demo-ts-pnpm-vite' &&
            request.worktreeId !== 'demo-main'
          ) {
            globalThis.__rejectedEagerHydrationHeld = true;
            await gate;
          }
          return getState(event, request);
        });
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', (_event, request) => {
          globalThis.__eagerRetrySentText = request.text;
          return {};
        });
      });

      await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
      await window
        .getByRole('button', {
          name: `Create worktree for ${WORKSPACE_NAME}`,
        })
        .click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__rejectedEagerHydrationHeld),
        )
        .toBe(true);

      const panel = window.getByTestId('panel-content-chat');
      const editor = panel.locator('[data-slate-editor="true"]');
      await expect(editor).toBeVisible();
      await electronApp.evaluate(() =>
        globalThis.__releaseRejectedEagerHydration(),
      );
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__eagerCreateAttempts ?? 0),
        )
        .toBe(1);

      await editor.fill('Retry after creation failure');
      await editor.press('Enter');

      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__eagerCreateAttempts ?? 0),
        )
        .toBe(2);
      await expect
        .poll(() => electronApp.evaluate(() => globalThis.__eagerRetrySentText))
        .toBe('Retry after creation failure');
      await expect(editor).not.toContainText('Retry after creation failure');
      await expect(
        panel.getByText('Retry after creation failure', { exact: true }),
      ).toHaveCount(1);
    } finally {
      await electronApp
        .evaluate(() => globalThis.__releaseRejectedEagerHydration?.())
        .catch(() => {});
      await closeCanopy(electronApp, userDataDir);
    }
  });

  for (const [appId, lifecycle] of [
    'ts-pnpm-vite',
    'multi-repo-fullstack',
  ].flatMap((id) => ['restore', 'expire'].map((mode) => [id, mode]))) {
    test(`startup Auto Delete runs configured teardown, retains the conversation, and ${lifecycle}s it (${appId})`, async () => {
      test.setTimeout(180_000);
      useBundledAutoDeleteTestRuntime();
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-auto-delete-'),
      );
      const {
        workspaces: [workspace],
      } = seedDemoWorkspaces({ userDataDir, apps: [appId] });
      const root = path.join(userDataDir, 'workspaces', workspace.id);
      const listPath = path.join(root, 'worktrees.json');
      const readWorktreeCount = () => {
        try {
          return JSON.parse(readFileSync(listPath, 'utf8')).worktrees.length;
        } catch {
          return null;
        } // A raw read can overlap a registry rewrite.
      };
      const list = JSON.parse(readFileSync(listPath, 'utf8'));
      const worktree = list.worktrees[0];
      if (appId === 'ts-pnpm-vite') {
        const reusablePath = path.join(
          path.dirname(workspace.worktreePath),
          'dev-aardvark',
        );
        execFileSync(
          'git',
          ['worktree', 'move', workspace.worktreePath, reusablePath],
          {
            cwd: JSON.parse(
              readFileSync(path.join(root, 'workspace.json'), 'utf8'),
            ).repoPath,
          },
        );
        workspace.worktreePath = reusablePath;
        worktree.id = 'dev-aardvark';
      }

      worktree.createdAt = '2026-01-01T00:00:00.000Z';
      worktree.lastTouchedAt = new Date(
        Date.now() - 2 * 86400000,
      ).toISOString();
      writeFileSync(listPath, JSON.stringify(list));
      const configPath = path.join(root, 'workspace.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const marker = path.join(userDataDir, 'teardown-ran');
      config.autoArchiveDays = 1;
      config.archiveRetentionDays = 7;
      config.scripts =
        config.type === 'multi-repo'
          ? {
              ...config.scripts,
              'before-teardown': `echo before > '${marker}'`,
              'after-teardown': `echo after >> '${marker}'`,
            }
          : { ...config.scripts, teardown: `echo finished > '${marker}'` };
      if (config.type === 'multi-repo') {
        for (const repo of config.repos)
          repo.scripts = {
            ...repo.scripts,
            teardown: `echo ${repo.id} >> '${marker}'`,
          };
      }
      if (config.type === 'multi-repo') {
        // The demo root predates managed repos/. Commit a valid root baseline so
        // restore can check out its branch before replaying the saved changes.
        const ignorePath = path.join(workspace.worktreePath, '.gitignore');
        writeFileSync(
          ignorePath,
          `${readFileSync(ignorePath, 'utf8')}\nrepos/\n`,
        );
        execFileSync('git', ['add', '.gitignore'], {
          cwd: workspace.worktreePath,
        });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=E2E',
            '-c',
            'user.email=e2e@example.test',
            'commit',
            '-m',
            'Initialize managed root',
          ],
          { cwd: workspace.worktreePath },
        );
        for (const repo of config.repos)
          repo.scripts = { ...repo.scripts, setup: null, launch: null };
      }
      config.scripts = {
        ...config.scripts,
        setup: null,
        launch: null,
        'before-setup': null,
        'after-setup': null,
      };
      writeFileSync(configPath, JSON.stringify(config));
      seedWorktreeChat({
        userDataDir,
        workspaceId: workspace.id,
        worktreeId: worktree.id,
        tabs: [
          {
            id: 'retained-chat',
            title: 'Retained automatic deletion chat',
            providerType: 'claude',
            hasStartedSession: true,
            model: 'sonnet',
            createdAt: worktree.createdAt,
            messages: [
              {
                id: 'retained-message',
                role: 'user',
                blocks: [
                  { type: 'text', text: 'Keep this original conversation.' },
                ],
                timestamp: Date.parse(worktree.lastTouchedAt),
              },
            ],
          },
        ],
      });
      const browserDir = path.join(root, 'worktree-data', worktree.id);
      mkdirSync(browserDir, { recursive: true });
      writeFileSync(
        path.join(browserDir, 'browser-state.json'),
        JSON.stringify({
          version: 1,
          browserOrder: ['old-browser-1', 'old-browser-2'],
          activeBrowserId: 'old-browser-1',
          browsers: ['old-browser-1', 'old-browser-2'].map((id) => ({
            id,
            projectId: workspace.id,
            worktreeId: worktree.id,
            createdAt: 1,
            updatedAt: 2,
            url: 'http://localhost/',
            title: id,
            status: 'ready',
            canGoBack: false,
            canGoForward: false,
            loading: false,
            themeMode: 'light',
            pickMode: false,
            recording: false,
          })),
        }),
      );
      const reuseFreedName = async (page) => {
        if (appId === 'ts-pnpm-vite') {
          const reused = await page.evaluate(
            (request) => window.api.createWorktree(request),
            {
              projectId: workspace.id,
              repoPath: config.repoPath,
              existingWorktreeIds: ANIMAL_NAMES.filter(
                (name) => name !== 'aardvark',
              ).map((name) => `dev-${name}`),
              branchName: 'after-auto-delete',
            },
          );
          expect(reused.id).toBe('dev-aardvark');
          await expect
            .poll(() => existsSync(path.join(workspace.worktreePath, '.git')), {
              timeout: 30_000,
            })
            .toBe(true);
        }
      };
      let { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await expect.poll(readWorktreeCount, { timeout: 30_000 }).toBe(0);
        const browserError = await window.evaluate(
          async ({ projectId, worktreeId }) => {
            try {
              await window.api.browser.setActive({
                projectId,
                worktreeId,
                browserId: 'old-browser-1',
              });
              return null;
            } catch (error) {
              return String(error);
            }
          },
          { projectId: workspace.id, worktreeId: worktree.id },
        );
        expect(browserError).toContain('does not belong');
        expect(existsSync(marker)).toBe(true);
        if (config.type === 'multi-repo') {
          const lines = readFileSync(marker, 'utf8').trim().split('\n');
          expect(lines[0]).toBe('before');
          expect(lines.at(-1)).toBe('after');
          expect(lines.slice(1, -1).sort()).toEqual(
            config.repos.map((repo) => repo.id).sort(),
          );
        }
        expect(existsSync(workspace.worktreePath)).toBe(false);
        const archivePath = path.join(
          root,
          'archived-containers',
          worktree.id,
          'container.json',
        );
        const manifest = JSON.parse(readFileSync(archivePath, 'utf8'));
        expect(
          Date.parse(manifest.expiresAt) - Date.parse(manifest.archivedAt),
        ).toBe(7 * 86400000);
        if (lifecycle === 'expire') {
          await closeCanopy(electronApp, userDataDir, { keepUserData: true });
          electronApp = null;
          manifest.expiresAt = '2026-01-01T00:00:00.000Z';
          writeFileSync(archivePath, JSON.stringify(manifest));
          ({ electronApp } = await launchCanopy({ userDataDir }));
          const relaunched = await electronApp.firstWindow();
          await new CanopyAppDriver(relaunched).waitForShell({
            timeout: 30_000,
          });
          await expect
            .poll(() => existsSync(archivePath), { timeout: 30_000 })
            .toBe(false);
          expect(readWorktreeCount()).toBe(0);
          await reuseFreedName(relaunched);
          return;
        }
        await window
          .getByTestId(`sidebar-project-${workspace.id}-archived-link`)
          .click();
        await window
          .getByTestId(`archived-overview-open-${worktree.id}`)
          .click();
        const viewer = window.getByTestId('archived-container-view');
        await expect(viewer).toBeVisible();
        await expect(viewer).toContainText('Retained automatic deletion chat');
        await viewer.getByTestId('archived-restore').click();
        await expect.poll(readWorktreeCount, { timeout: 60_000 }).toBe(1);
        await app.selectWorktree(worktree.branchName);
        await expect(window.getByTestId('panel-content-chat')).toContainText(
          'Keep this original conversation.',
        );
        await continueRestoredAutoDeleteChat(
          window,
          appId === 'ts-pnpm-vite' ? 'Canopy-CADCODE' : 'Canopy-CADMULTI',
        );
        await reuseFreedName(window);
      } finally {
        if (electronApp) await closeCanopy(electronApp, userDataDir);
        else rmSync(userDataDir, { recursive: true, force: true });
      }
    });
  }

  test('code workspace settings persist Auto Delete inactivity and branch cleanup', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.selectWorktree(WORKTREE_BRANCH);

      await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
      await app.workspaceSettingsButton(WORKSPACE_NAME).click();
      let dialog = window
        .locator('[role="dialog"]')
        .filter({ has: window.locator('#project-settings-title') });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Deletion retention');
      await expect(dialog).toContainText('Auto delete');
      await expect(
        dialog.getByTestId('project-settings-retention-toggle'),
      ).toHaveCount(0);
      await expect(
        dialog
          .getByTestId('project-settings-retention-card')
          .getByTestId('project-settings-auto-archive-toggle'),
      ).toBeVisible();
      await dialog.getByTestId('project-settings-auto-archive-toggle').check();
      await dialog.getByTestId('project-settings-auto-archive-days').fill('11');
      await dialog
        .getByTestId('project-settings-auto-archive-delete-branch')
        .check();
      await dialog
        .getByRole('button', { name: 'Save local', exact: true })
        .click();
      await expect(dialog).toHaveCount(0);

      await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
      await app.workspaceSettingsButton(WORKSPACE_NAME).click();
      dialog = window
        .locator('[role="dialog"]')
        .filter({ has: window.locator('#project-settings-title') });
      await expect(
        dialog.getByTestId('project-settings-auto-archive-toggle'),
      ).toBeChecked();
      await expect(
        dialog.getByTestId('project-settings-auto-archive-days'),
      ).toHaveValue('11');
      await expect(
        dialog.getByTestId('project-settings-auto-archive-delete-branch'),
      ).toBeChecked();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Auto Delete does not expose legacy Lock or Unlock actions', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.selectWorktree(WORKTREE_BRANCH);

      await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
      await app.workspaceSettingsButton(WORKSPACE_NAME).click();
      const dialog = window
        .locator('[role="dialog"]')
        .filter({ has: window.locator('#project-settings-title') });
      await dialog.getByTestId('project-settings-auto-archive-toggle').check();
      await dialog
        .getByRole('button', { name: 'Save local', exact: true })
        .click();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').click();
      await expect(
        window.getByTestId('worktree-actions-menu-auto-archive-lock'),
      ).toHaveCount(0);
      await expect(window.getByRole('menu')).not.toContainText('Unlock');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Auto Delete completion removes the selected worktree from the renderer', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const worktreesFile = path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'worktrees.json',
      );
      const persisted = JSON.parse(readFileSync(worktreesFile, 'utf8'));
      const archivedWorktree = persisted.worktrees[0];
      persisted.worktrees = [];
      writeFileSync(worktreesFile, `${JSON.stringify(persisted, null, 2)}\n`);

      await electronApp.evaluate(
        ({ BrowserWindow }, notification) => {
          for (const browserWindow of BrowserWindow.getAllWindows()) {
            browserWindow.webContents.send(
              'auto-archive:completed',
              notification,
            );
          }
        },
        {
          workspaceId: WORKSPACE_ID,
          workspaceName: WORKSPACE_NAME,
          targetId: archivedWorktree.id,
          targetName: archivedWorktree.branchName,
          surface: 'single-repo',
          inactivityDays: 7,
          status: 'success',
        },
      );

      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
        ),
      ).toHaveCount(0);
      await expect(window.getByTestId('panel-content-chat')).toHaveCount(0);
      await expect(
        window.getByText(
          `“${WORKTREE_BRANCH}” was automatically deleted after 7 days of inactivity.`,
        ),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('G1: selecting a worktree row mounts the chat panel and tab bar', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });

      // Worktree rows live in the sidebar's always-visible Code Workspaces
      // section; the seeded workspace header confirms it rendered.
      await expect(window.getByTestId('sidebar-section-code')).toBeVisible();
      await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();

      // Before selecting a worktree, WorktreePart shows its no-selection
      // placeholder — the panel grid (and therefore the chat panel's
      // `panel-content-chat` frame) only mounts once a worktree is selected
      // (Phase 3 panel cutover, WorktreePart.tsx).
      await expect(window.getByTestId('panel-content-chat')).toHaveCount(0);

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      // Selecting the sidebar row navigates to the main page and mounts
      // ChatPanel (chat-panel) and, because the seeded worktree has a default
      // chat tab, the ChatTabBar (chat-tab-bar).
      await app.selectWorktree(WORKTREE_BRANCH);
      await app.expectMainPage();

      // Selecting the row mounts the panel grid with the chat surface
      // (panel-content-chat) and the persistent worktree top bar
      // (worktree-top-bar).
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await expect(window.getByTestId('worktree-top-bar')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('branch mutations stay unavailable while setup scripts are running', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-running-setup-branch-info-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      await injectScriptRunEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        script: {
          scriptKey: 'setup:project',
          scriptName: 'setup',
          label: 'Setup',
          command: 'npm install',
          lifecycle: 'setup',
          target: 'project',
        },
        invocation: 'automatic-setup',
      });

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-info').click();

      const dialog = window.getByRole('dialog', { name: 'Branch info' });
      await expect(
        dialog.getByTestId('branch-setup-pending-notice'),
      ).toContainText('Branch changes will be available when setup finishes.');
      await expect(
        dialog.getByRole('button', { name: 'Switch branch' }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole('button', { name: 'Rename branch' }),
      ).toBeDisabled();
      await expect(
        dialog.getByTestId('base-branch-dropdown-trigger'),
      ).toBeDisabled();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('multi-repo Branch Info keeps branch actions contextual without idle setup spacing', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['multi-repo-fullstack'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-info').click();

      const dialog = window.getByRole('dialog', { name: 'Repo branches' });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('div.mt-2:empty')).toHaveCount(0);
      await expect(
        dialog.getByRole('button', {
          name: `Switch branch ${WORKTREE_BRANCH}`,
        }),
      ).toHaveCount(3);
      await expect(
        dialog.getByRole('button', { name: 'Switch branch', exact: true }),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  for (const harness of ['claude', 'cursor']) {
    test(`Branch from carries ${harness} open tabs into and selects the new worktree`, async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-electron-branch-open-tabs-'),
      );
      const demoSeed = seedDemoWorkspaces({
        userDataDir,
        apps: ['ts-pnpm-vite'],
      });
      // The branched worktree runs setup. Keep that lifecycle real and local:
      // the demo's pnpm install can otherwise outlive the missing-file check.
      const configPath = path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'workspace.json',
      );
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.scripts.setup = 'node -e "process.exit(0)"';
      writeFileSync(configPath, JSON.stringify(config));
      const worktreePath = demoSeed.workspaces[0]?.worktreePath;
      expect(worktreePath, 'seeded worktree path').toBeTruthy();
      const dirtyFileName = 'CANOPY_E2E_BRANCH_AS_IS.txt';
      writeFileSync(
        path.join(worktreePath, dirtyFileName),
        'leave this change in the source worktree\n',
        'utf8',
      );
      const missingFilePath = path.join(worktreePath, 'branch-missing.md');
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        providerType: harness,
        tabs: [
          {
            id: 'source-chat',
            model: harness === 'cursor' ? 'cursor-default' : 'sonnet',
            // Stamped below the Full Access default (CAN-3055) so the
            // renderer-supplied `full-access` seed further down is a real
            // escalation main must refuse, not a no-op.
            approvalMode: 'ask',
            executionHarness: harness,
            sdkSessionId:
              harness === 'cursor' ? 'cursor-existing-session' : undefined,
            title: 'Open branch context',
            messages: [
              {
                id: 'source-message',
                role: 'assistant',
                blocks: [
                  {
                    type: 'text',
                    text: 'Context copied into the branched worktree',
                  },
                ],
                timestamp: Date.parse('2026-07-31T12:00:00.000Z'),
              },
            ],
          },
          {
            id: 'source-missing-file',
            title: 'branch-missing.md',
            kind: 'file',
            filePath: missingFilePath,
            fileViewMode: 'raw',
            description: missingFilePath,
            messages: [],
          },
        ],
      });

      const { electronApp } = await launchCanopy({ userDataDir });

      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);

        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_BRANCH);
        // Wait for the renderer's first Git-status projection before invoking
        // Branch from. For this local-only fixture, the idle Commit button is the
        // user-visible signal that the seeded untracked file has been observed.
        await expect(
          window.getByTestId('pr-status-bar-local-commit'),
        ).toBeVisible({ timeout: 15_000 });

        const rows = window.getByTestId('worktree-row');
        const sourceRow = window.locator(
          `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_BRANCH}"]`,
        );
        await expect(
          window.getByText('Context copied into the branched worktree').first(),
        ).toBeVisible({ timeout: 30_000 });
        const rowCountBefore = await rows.count();

        // Record even a one-frame phantom starter. The destination's canonical
        // scope is initially empty, so eager hydration used to create a local
        // "New Chat" while the source tabs were still being forked; the fork
        // commit then removed it as soon as the user clicked it.
        await window.evaluate(() => {
          window.__branchFromSawPhantomStarter = false;
          const recordVisibleStarter = () => {
            const visibleStarter = Array.from(
              document.querySelectorAll('[role="tab"]'),
            ).some(
              (element) =>
                element.textContent?.trim() === 'New Chat' &&
                element.getClientRects().length > 0,
            );
            if (visibleStarter) window.__branchFromSawPhantomStarter = true;
          };
          recordVisibleStarter();
          const observer = new MutationObserver(recordVisibleStarter);
          observer.observe(document.body, { childList: true, subtree: true });
          window.__branchFromStarterObserver = observer;
        });

        await sourceRow.hover();
        await sourceRow.getByTestId('worktree-actions-menu-button').click();
        await window.getByTestId('worktree-actions-menu-create-branch').click();

        const warning = window.getByTestId('branch-from-uncommitted-warning');
        await expect(warning).toBeVisible();
        await expect(rows).toHaveCount(rowCountBefore);
        await warning.getByRole('button', { name: 'Continue' }).click();
        await expect(
          window.getByRole('menuitem', { name: 'Commit first' }),
        ).toBeVisible();
        await window.getByRole('menuitem', { name: 'Do not commit' }).click();

        await expect
          .poll(async () => rows.count(), { timeout: 30_000 })
          .toBe(rowCountBefore + 1);
        const destinationRow = window
          .locator(
            `[data-testid="worktree-row"]:not([data-worktree-id="${WORKTREE_BRANCH}"])`,
          )
          .last();
        await expect(destinationRow).toHaveClass(/bg-muted/);
        await expect(sourceRow).not.toHaveClass(/bg-muted/);
        await expect(
          window.getByText('Context copied into the branched worktree').first(),
        ).toBeVisible({ timeout: 30_000 });
        await expect(window.getByRole('tab', { name: 'New Chat' })).toHaveCount(
          0,
        );
        expect(
          await window.evaluate(() => {
            window.__branchFromStarterObserver?.disconnect();
            return window.__branchFromSawPhantomStarter;
          }),
        ).toBe(false);
        const branchedId = await window
          .locator(
            `[data-testid="worktree-row"]:not([data-worktree-id="${WORKTREE_BRANCH}"])`,
          )
          .last()
          .getAttribute('data-worktree-id');
        expect(branchedId, 'destination worktree id').toBeTruthy();
        const branchState = await window.evaluate(
          async (scope) => window.api.chat.getState(scope),
          { projectId: WORKSPACE_ID, worktreeId: branchedId },
        );
        const branchChats = branchState.tabsFile.tabs.filter(
          (tab) => tab.kind !== 'file',
        );
        expect(branchChats.length).toBeGreaterThan(0);
        for (const chat of branchChats) {
          const instruction = chat.pendingSystemInstructions?.find(
            (item) => item.id === 'worktree-relocation',
          );
          expect(instruction?.text).toContain('read-only reference');
          expect(instruction?.text).toContain(
            'Limit all changes to the new working directory',
          );
          expect(instruction?.text).toContain(worktreePath);
          expect(instruction?.text).toContain(
            'Originating branch: "demo-main"',
          );
          expect(instruction?.text).not.toContain('Follow-up instruction');
          expect(
            chat.pendingSystemInstructions?.some(
              (item) => item.id === 'independent-agent-start',
            ),
          ).toBe(false);
          expect(
            chat.messages.some((message) =>
              message.blocks.some(
                (block) =>
                  block.type === 'text' &&
                  block.text.includes('read-only reference'),
              ),
            ),
          ).toBe(false);
        }
        // Branch-from clones file tabs with a renderer-only setup recheck marker.
        // Once checkout/setup settles, a file that was never created must leave
        // the neutral loading state and surface the normal missing-file UI.
        const destinationFileTab = window
          .locator('[data-testid^="panel-tab-panel-file-"]')
          .first();
        await expect(destinationFileTab).toBeVisible({ timeout: 30_000 });
        await destinationFileTab.click();
        const missingState = window.getByTestId('file-viewer-missing');
        await expect(missingState).toBeVisible({ timeout: 120_000 });
        await expect(missingState).toContainText('File does not exist');
        await expect(missingState).toContainText('branch-missing.md');
        if (harness === 'claude') {
          // Exercise the real preload-to-main trust boundary with a
          // structurally valid but compromised renderer seed. Main must
          // preserve branch metadata while refusing host-owned approval and
          // lifecycle state.
          await window.evaluate(
            async ({ projectId, sourceWorktreeId, destinationWorktreeId }) => {
              await window.api.chat.forkOpenWorktreeTabs({
                projectId,
                sourceWorktreeId,
                destinationWorktreeId,
                selectedTab: {
                  sourceTabId: 'source-chat',
                  destinationTab: {
                    id: 'renderer-supplied-branch',
                    title: 'Renderer supplied branch',
                    messages: [],
                    createdAt: '2026-09-09T00:00:00.000Z',
                    providerType: 'claude',
                    approvalMode: 'full-access',
                    sessionApprovalRules: [
                      {
                        id: 'renderer-injected-rule',
                        behavior: 'allow',
                        target: { kind: 'command', pattern: '*' },
                        createdAt: '2026-09-09T00:00:00.000Z',
                        origin: 'prompt',
                      },
                    ],
                    sharedRun: {
                      externalId: 'renderer-injected-run',
                      shareScope: 'team',
                      sharedAt: '2026-09-09T00:00:00.000Z',
                    },
                    readOnly: true,
                    unread: true,
                    pendingRevertAttachmentPath:
                      '/tmp/renderer-injected-revert.md',
                    newChatStartedWatcherPending: false,
                  },
                },
              });
            },
            {
              projectId: WORKSPACE_ID,
              sourceWorktreeId: WORKTREE_BRANCH,
              destinationWorktreeId: branchedId,
            },
          );
          const persistedRendererBranch = await window.evaluate(
            async ({ projectId, worktreeId }) => {
              const state = await window.api.chat.getState({
                projectId,
                worktreeId,
              });
              return state.tabsFile.tabs.find(
                (tab) => tab.id === 'renderer-supplied-branch',
              );
            },
            { projectId: WORKSPACE_ID, worktreeId: branchedId },
          );
          expect(persistedRendererBranch).toBeTruthy();
          expect(persistedRendererBranch).toHaveProperty('approvalMode', 'ask');
          expect(persistedRendererBranch).not.toHaveProperty(
            'sessionApprovalRules',
          );
          expect(persistedRendererBranch).not.toHaveProperty('sharedRun');
          expect(persistedRendererBranch).not.toHaveProperty('readOnly');
          expect(persistedRendererBranch).not.toHaveProperty('unread');
          expect(persistedRendererBranch).not.toHaveProperty(
            'pendingRevertAttachmentPath',
          );
          expect(persistedRendererBranch).toHaveProperty(
            'newChatStartedWatcherPending',
            true,
          );
        }
        const sourceStatus = execFileSync(
          'git',
          ['-C', worktreePath, 'status', '--short', '--', dirtyFileName],
          { encoding: 'utf8' },
        );
        expect(sourceStatus).toContain(`?? ${dirtyFileName}`);
        if (harness === 'cursor') {
          // The forked tab keeps the Cursor selection but must not carry the
          // source's provider session id into a different worktree directory:
          // Cursor history is keyed by chat and cwd, so a copied id would
          // point at a session the new worktree's profile cannot load.
          const forkedChat = branchChats.find(
            (tab) => tab.title === 'Open branch context',
          );
          expect(forkedChat).toMatchObject({
            model: 'cursor-default',
            executionHarness: 'cursor',
          });
          expect(forkedChat.sdkSessionId).toBeUndefined();
        }
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('G5: worktree actions menu exposes items, toggles hidden, and archives', async () => {
    // Seed manually so we can dirty the worktree checkout BEFORE the app
    // launches. Without uncommitted changes the seeded worktree's diff stats
    // load as zero and the Delete action bypasses the confirmation dialog,
    // archiving the worktree immediately (worktree-delete-action.ts
    // `getDeleteAction` → 'archive'). Writing an untracked file makes
    // `hasUncommittedChanges` true on the first diff-stats refresh, so the
    // delete deterministically routes through the confirm dialog and we never
    // actually delete the worktree.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-g5-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const worktreePath = demoSeed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();
    writeFileSync(
      path.join(worktreePath, 'CANOPY_E2E_DIRTY.txt'),
      'uncommitted change to force the delete confirmation dialog\n',
      'utf8',
    );

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      // The actions trigger lives inside the row's hover-revealed cluster.
      // Hover the row so the More-actions button is interactable, then open it.
      await row.hover();
      const actionsButton = window.getByTestId('worktree-actions-menu-button');
      await expect(actionsButton).toBeVisible();
      await actionsButton.click();

      // The menu is portalled to document.body (createPortal in
      // WorktreeItem.tsx). Assert each item the gap plan calls out.
      const menu = window.getByTestId('worktree-actions-menu');
      await expect(menu).toBeVisible();
      await expect(
        window.getByTestId('worktree-actions-menu-info'),
      ).toBeVisible();
      await expect(
        window.getByTestId('worktree-actions-menu-create-branch'),
      ).toBeVisible();
      await expect(
        window.getByTestId('worktree-actions-menu-toggle-hidden'),
      ).toBeVisible();
      await expect(
        window.getByTestId('worktree-actions-menu-archive'),
      ).toBeVisible();
      await expect(
        window.getByTestId('worktree-actions-menu-delete'),
      ).toBeVisible();

      // No hidden worktree yet, so the list-view hidden section is absent.
      await expect(window.getByTestId('hidden-worktrees-section')).toHaveCount(
        0,
      );

      // Toggle the worktree hidden. The menu closes on click, the row moves into
      // the collapsed "Hidden Worktrees" section (ProjectSection.tsx).
      await window.getByTestId('worktree-actions-menu-toggle-hidden').click();
      await expect(menu).toHaveCount(0);
      await expect(
        window.getByTestId('hidden-worktrees-section'),
      ).toBeVisible();

      // Expand the hidden section and show the worktree again via its inline
      // "Show" button (worktree-show-button), restoring the list to its
      // un-hidden state.
      await window.getByTestId('hidden-worktrees-section').click();
      await row.hover();
      const showButton = window.getByTestId('worktree-show-button');
      await expect(showButton).toBeVisible();
      await showButton.click();
      await expect(window.getByTestId('hidden-worktrees-section')).toHaveCount(
        0,
      );

      // Re-open the actions menu and archive the worktree. Archive keeps the
      // retained worktree until it is deleted; Delete (below) keeps it for
      // the retention window.
      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
      await window.getByTestId('worktree-actions-menu-archive').click();

      const confirmDialog = window.getByRole('dialog', {
        name: 'Archive worktree?',
      });
      await expect(confirmDialog).toBeVisible();
      await expect(confirmDialog.getByText('Has local changes')).toBeVisible();
      await expect(confirmDialog).toContainText(
        'Kept until you delete the archive.',
      );
      await expect(confirmDialog).toContainText(
        'Choose whether to keep the local Git branch.',
      );
      // The full retention explanation moved behind the info button.
      await expect(confirmDialog).not.toContainText(
        'restoring recreates that state in a new worktree.',
      );
      await confirmDialog
        .getByRole('button', { name: 'About restoring this worktree' })
        .hover();
      await expect(window.getByRole('tooltip')).toContainText(
        'When a restorable archive can be created, its commits and local changes are kept too',
      );
      await expect(confirmDialog.getByRole('button')).toHaveText([
        '',
        'Cancel',
        'Preserve local',
        'Delete local',
      ]);
      await expect(confirmDialog).not.toContainText('changes will be lost');
      await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirmDialog).toHaveCount(0);
      await expect(row).toBeVisible();

      // Delete routes through the same confirmation with retention copy.
      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-delete').click();
      const deleteDialog = window.getByRole('dialog', {
        name: 'Delete worktree?',
      });
      await expect(deleteDialog).toBeVisible();
      await expect(deleteDialog).toContainText(
        'Restorable for 7 days when an archive can be created.',
      );
      await expect(deleteDialog).not.toContainText('changes will be lost');
      await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(deleteDialog).toHaveCount(0);
      await expect(row).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('G5: archiving fences a late chat flush from recreating sidecars', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-archive-chat-fence-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const { filePath: chatTabsPath } = seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      providerType: 'claude',
      tabs: [
        {
          id: 'chat-before-archive',
          title: 'Chat before archive',
          messages: [
            {
              id: 'message-before-archive',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Persisted before archive' }],
              timestamp: Date.parse('2026-09-01T12:00:00.000Z'),
            },
          ],
        },
      ],
    });
    const chatArchivesPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-archives',
      `${WORKTREE_BRANCH}.json`,
    );
    const chatJournalPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-journals',
      `${WORKTREE_BRANCH}.jsonl`,
    );

    const nativeScopePath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-storage-v2',
      WORKTREE_BRANCH,
    );
    const nativeManifestPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-storage-manifests',
      `${WORKTREE_BRANCH}.json`,
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_WORKTREE_CLEANUP_FENCE_DELAY_MS: '2000' },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByText('Persisted before archive')).toBeVisible({
        timeout: 30_000,
      });
      expect(existsSync(nativeScopePath)).toBe(true);
      expect(existsSync(nativeManifestPath)).toBe(true);

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await row.hover();
      await row.getByTestId('worktree-archive-button').click();

      // Cleanup has removed the live sidecar but is paused before metadata
      // teardown, so this renderer request is guaranteed to arrive while the
      // scope-deletion fence is held. Before the fence fix, it recreated the
      // just-deleted chat files.
      await expect
        .poll(() => existsSync(nativeScopePath), { timeout: 30_000 })
        .toBe(false);
      await expect(
        window.evaluate(
          async ({ projectId, worktreeId }) => {
            await window.api.chat.flushScope({ projectId, worktreeId });
          },
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_BRANCH },
        ),
      ).rejects.toThrow('Chat state repository is draining');

      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(
          () =>
            [
              chatTabsPath,
              chatArchivesPath,
              chatJournalPath,
              nativeScopePath,
              nativeManifestPath,
            ].every((filePath) => !existsSync(filePath)),
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('archive stays removed when a pre-teardown reload finishes during cleanup', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archive-reload-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = seeded.workspaces[0];
    const configPath = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'workspace.json',
    );
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.scripts.teardown =
      'node -e "setTimeout(() => process.exit(0), 1500)"';
    writeFileSync(configPath, JSON.stringify(config));
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_WORKTREE_CLEANUP_FENCE_DELAY_MS: '10000' },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      const row = window.locator(
        '[data-testid="worktree-row"][data-branch="demo-main"]',
      );
      await expect(row).toBeVisible();
      expect(
        await sessionSnapshotListsWorktree(window, workspace.id, 'demo-main'),
      ).toBe(true);
      await window.evaluate(() => {
        window.__canopyProjectsTestApi.holdNextLoadAfterRead();
        window.__canopyProjectsTestApi.loadProjects();
      });
      await window.evaluate(() =>
        window.__canopyProjectsTestApi.waitForHeldLoad(),
      );
      await row.hover();
      await row.getByTestId('worktree-archive-button').click();
      await expect(row).toContainText(/teardown/i);
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      // The sidebar hid the row optimistically; main must agree for as long as
      // the removal runs, or a paired browser keeps a row the desktop dropped.
      // The cleanup fence keeps the row persisted, so this reads the
      // removal-pending mark and not the finished archive.
      await expect
        .poll(
          () => sessionSnapshotListsWorktree(window, workspace.id, 'demo-main'),
          { timeout: 5_000 },
        )
        .toBe(false);
      expect(persistedWorktreeIds(userDataDir, workspace.id)).toContain(
        'demo-main',
      );
      await window.evaluate(() =>
        window.__canopyProjectsTestApi.releaseHeldLoad(),
      );
      // The response was read while the worktree existed. It must not resurrect
      // the row during the real backend's deliberately held cleanup phase.
      expect(await row.count()).toBe(0);
      await expect
        .poll(
          () =>
            persistedWorktreeIds(userDataDir, workspace.id).includes(
              'demo-main',
            ),
          { timeout: 30_000 },
        )
        .toBe(false);
      await expect(row).toHaveCount(0);
      expect(
        await sessionSnapshotListsWorktree(window, workspace.id, 'demo-main'),
      ).toBe(false);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('G5: deleting a worktree cancels its running setup and removes it promptly', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-delete-during-setup-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const workspace = demoSeed.workspaces[0];
    const setupPidPath = path.join(userDataDir, 'setup-pid');
    const setupAtTeardownPath = path.join(userDataDir, 'setup-at-teardown');
    const configPath = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'workspace.json',
    );
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    // A setup that would outlive the test unless the removal cancels it, and
    // a teardown that records whether setup was still running beside it.
    config.scripts = {
      ...config.scripts,
      setup: `echo $$ > '${setupPidPath}'; exec sleep 300`,
      teardown: `if kill -0 "$(cat '${setupPidPath}')" 2>/dev/null; then echo running; else echo cancelled; fi > '${setupAtTeardownPath}'`,
      launch: null,
    };
    writeFileSync(configPath, JSON.stringify(config));
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const { electronApp } = await launchCanopy({ userDataDir });
    let setupPid = null;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const created = await window.evaluate(
        (request) => window.api.createWorktree(request),
        {
          projectId: workspace.id,
          repoPath: workspace.repoPath,
          existingWorktreeIds: [WORKTREE_BRANCH],
          branchName: 'feature/delete-during-setup',
        },
      );
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${created.id}"]`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => existsSync(setupPidPath), { timeout: 30_000 })
        .toBe(true);
      setupPid = Number(readFileSync(setupPidPath, 'utf8').trim());
      expect(isAlive(setupPid)).toBe(true);

      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').first().click();
      const deleteItem = window.getByTestId('worktree-actions-menu-delete');
      await expect(deleteItem).toBeEnabled();
      const startedAt = Date.now();
      await deleteItem.click();
      await confirmWorktreeDeleteIfAsked(window);

      // The removal takes priority: setup is cancelled and the worktree is
      // removed without waiting for setup to finish on its own.
      await expect(row).toHaveCount(0, { timeout: 15_000 });
      await expect
        .poll(() => isAlive(setupPid), { timeout: 15_000 })
        .toBe(false);
      await expect
        .poll(() => persistedWorktreeIds(userDataDir, workspace.id), {
          timeout: 30_000,
        })
        .not.toContain(created.id);
      expect(Date.now() - startedAt).toBeLessThan(30_000);
      await expect(
        window.getByRole('dialog', { name: 'Teardown failed' }),
      ).toHaveCount(0);
      // Setup was cancelled before teardown started, not left running under it.
      expect(readFileSync(setupAtTeardownPath, 'utf8').trim()).toBe(
        'cancelled',
      );
    } finally {
      if (setupPid !== null && isAlive(setupPid)) {
        process.kill(setupPid, 'SIGKILL');
      }
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('G5: deleting a multi-repo worktree stops its setup sequence before the next step starts', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-delete-during-repo-setup-'),
    );
    const fixtures = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-multi-repo-setup-')),
    );
    const git = (cwd, args) =>
      execFileSync(
        'git',
        ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', ...args],
        { cwd, encoding: 'utf8' },
      );
    const initRepo = (repoPath) => {
      mkdirSync(repoPath, { recursive: true });
      git(repoPath, ['init', '-q', '-b', 'main']);
      writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n');
      git(repoPath, ['add', 'README.md']);
      git(repoPath, ['commit', '-q', '-m', 'init']);
      return repoPath;
    };
    const childSource = initRepo(path.join(fixtures, 'child-source'));
    const childRemote = path.join(fixtures, 'child.git');
    git(fixtures, ['clone', '-q', '--bare', childSource, childRemote]);
    const sourceRepo = initRepo(path.join(fixtures, 'suite'));
    const repoSetupPidPath = path.join(fixtures, 'repo-setup-pid');
    const afterSetupMarker = path.join(fixtures, 'after-setup-started');
    const setupAtTeardownPath = path.join(fixtures, 'setup-at-teardown');
    // Setup is a sequence: the repo setup would outlive the test, and
    // after-setup follows it. A removal must end the sequence, not just the
    // step that happens to be running.
    writeFileSync(
      path.join(sourceRepo, 'canopy.json'),
      `${JSON.stringify(
        {
          version: 1,
          scripts: {
            'after-setup': `touch '${afterSetupMarker}'; sleep 300`,
            // Teardown runs between cancelling setup and the archive itself,
            // long enough for a surviving sequence to start its next step.
            'before-teardown': `if kill -0 "$(cat '${repoSetupPidPath}')" 2>/dev/null; then echo running; else echo cancelled; fi > '${setupAtTeardownPath}'; sleep 3`,
          },
          repos: [
            {
              id: 'child',
              name: 'child',
              url: childRemote,
              scripts: {
                setup: `echo $$ > '${repoSetupPidPath}'; exec sleep 300`,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(path.join(sourceRepo, '.gitignore'), 'repos/\n');
    git(sourceRepo, ['add', 'canopy.json', '.gitignore']);
    git(sourceRepo, ['commit', '-q', '-m', 'manifest']);
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const { electronApp } = await launchCanopy({ userDataDir });
    let repoSetupPid = null;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const imported = await window.evaluate(
        (request) => window.api.importWorkspaceFromRepo(request),
        { repoPath: sourceRepo },
      );
      const workspaceId = imported.workspace.id;
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const created = await window.evaluate(
        (request) => window.api.createWorkspaceWorktree(request),
        { workspaceId, existingWorktreeIds: [], baseBranch: 'main' },
      );
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${created.id}"]`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => existsSync(repoSetupPidPath), { timeout: 60_000 })
        .toBe(true);
      repoSetupPid = Number(readFileSync(repoSetupPidPath, 'utf8').trim());
      expect(isAlive(repoSetupPid)).toBe(true);

      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').first().click();
      const deleteItem = window.getByTestId('worktree-actions-menu-delete');
      await expect(deleteItem).toBeEnabled();
      await deleteItem.click();
      await confirmWorktreeDeleteIfAsked(window);

      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(() => isAlive(repoSetupPid), { timeout: 15_000 })
        .toBe(false);
      await expect
        .poll(() => persistedWorktreeIds(userDataDir, workspaceId), {
          timeout: 30_000,
        })
        .not.toContain(created.id);
      // Setup was cancelled before teardown started, not left running under it.
      expect(readFileSync(setupAtTeardownPath, 'utf8').trim()).toBe(
        'cancelled',
      );
      // The cancelled repo setup did not hand over to after-setup.
      expect(existsSync(afterSetupMarker)).toBe(false);
    } finally {
      if (repoSetupPid !== null && isAlive(repoSetupPid)) {
        process.kill(repoSetupPid, 'SIGKILL');
      }
      await closeCanopy(electronApp, userDataDir);
      rmSync(fixtures, { recursive: true, force: true });
    }
  });

  test('G5: deleting a worktree during its Git setup removes it without waiting for the checkout', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-delete-during-git-setup-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const workspace = demoSeed.workspaces[0];
    const configPath = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'workspace.json',
    );
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.scripts = { ...config.scripts, setup: null, teardown: null };
    writeFileSync(configPath, JSON.stringify(config));
    // `git worktree add` far outlasts the removal's own budget below.
    const worktreeAddStarted = path.join(userDataDir, 'worktree-add-started');
    const gitShim = path.join(userDataDir, 'git-slow-shim.sh');
    writeFileSync(
      gitShim,
      `#!/bin/sh\ncase "$*" in *"worktree add"*) touch '${worktreeAddStarted}'; sleep 60;; esac\nexec /usr/bin/git "$@"\n`,
    );
    chmodSync(gitShim, 0o755);

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_GIT_EXECUTABLE: gitShim },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const created = await window.evaluate(
        (request) => window.api.createWorktree(request),
        {
          projectId: workspace.id,
          repoPath: workspace.repoPath,
          existingWorktreeIds: [WORKTREE_BRANCH],
          branchName: 'feature/delete-during-git-setup',
        },
      );
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${created.id}"]`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => existsSync(worktreeAddStarted), { timeout: 30_000 })
        .toBe(true);

      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').first().click();
      const deleteItem = window.getByTestId('worktree-actions-menu-delete');
      await expect(deleteItem).toBeEnabled();
      const startedAt = Date.now();
      await deleteItem.click();
      await confirmWorktreeDeleteIfAsked(window);

      await expect(row).toHaveCount(0, { timeout: 15_000 });
      await expect
        .poll(() => persistedWorktreeIds(userDataDir, workspace.id), {
          timeout: 20_000,
        })
        .not.toContain(created.id);
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      // The removal stays: the row does not come back with a failure.
      await window.waitForTimeout(2_000);
      await expect(row).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('G5: removal control disables during teardown and re-enables after failure', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-archive-gating-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-npm-next'],
    });
    const workspace = demoSeed.workspaces[0];
    const teardownCommand = 'node -e "setTimeout(() => process.exit(1), 3000)"';
    const workspaceConfigPath = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'workspace.json',
    );
    const workspaceConfig = JSON.parse(
      readFileSync(workspaceConfigPath, 'utf8'),
    );
    workspaceConfig.scripts.teardown = teardownCommand;
    writeFileSync(
      workspaceConfigPath,
      `${JSON.stringify(workspaceConfig, null, 2)}\n`,
    );

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        '[data-testid="worktree-row"][data-branch="demo-main"]',
      );
      await expect(row).toBeVisible();
      await row.hover();

      const archiveButton = row.getByTestId('worktree-archive-button');
      await expect(archiveButton).toBeVisible();
      // While removal cannot run (teardown in flight), the button is REMOVED
      // from the hover rail rather than rendered greyed out. Observe the DOM
      // before triggering the async action so the short-lived removal window
      // cannot be missed by Playwright's next poll.
      const transition = await archiveButton.evaluate(
        (button) =>
          new Promise((resolve, reject) => {
            let sawRemoved = false;
            const timeout = setTimeout(() => {
              observer.disconnect();
              reject(new Error('Archive button did not hide and reappear'));
            }, 15_000);
            const observer = new MutationObserver(() => {
              const currentButton = document.querySelector(
                '[data-testid="worktree-row"][data-branch="demo-main"] [data-testid="worktree-archive-button"]',
              );
              if (!currentButton) {
                sawRemoved = true;
                return;
              }
              if (sawRemoved) {
                clearTimeout(timeout);
                observer.disconnect();
                resolve({ sawRemoved });
              }
            });
            observer.observe(document.body, {
              attributes: true,
              childList: true,
              subtree: true,
              attributeFilter: ['aria-label', 'disabled'],
            });
            button.click();
          }),
      );
      expect(transition).toEqual({ sawRemoved: true });
      await expect(
        window.getByRole('dialog', { name: 'Teardown failed' }),
      ).toBeVisible({ timeout: 15_000 });
      // After the failure the action renders again (the failure dialog is
      // still up, so assert DOM presence rather than hover-revealed
      // visibility — hover would be intercepted by the dialog).
      await expect(archiveButton).toHaveCount(1, { timeout: 15_000 });
      await expect(archiveButton).toBeEnabled();
      await expect(row).toBeVisible();
      // The teardown script runs in the renderer before the archive request,
      // so a failed teardown never starts a removal in main: the snapshot
      // keeps the row the sidebar is still showing.
      expect(
        await sessionSnapshotListsWorktree(window, workspace.id, 'demo-main'),
      ).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  for (const variant of ['clean', 'done']) {
    test(`G5: a ${variant} row mutes and hides its actions while its removal runs teardown`, async () => {
      test.setTimeout(120_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), `canopy-electron-removal-muted-${variant}-`),
      );
      const demoSeed = seedDemoWorkspaces({
        userDataDir,
        apps: ['ts-pnpm-vite'],
      });
      const workspace = demoSeed.workspaces[0];
      const workspaceRoot = path.join(userDataDir, 'workspaces', workspace.id);
      const workspaceConfigPath = path.join(workspaceRoot, 'workspace.json');
      const workspaceConfig = JSON.parse(
        readFileSync(workspaceConfigPath, 'utf8'),
      );
      workspaceConfig.scripts.teardown =
        'node -e "setTimeout(() => process.exit(0), 15000)"';
      writeFileSync(
        workspaceConfigPath,
        `${JSON.stringify(workspaceConfig, null, 2)}\n`,
      );
      if (variant === 'done') {
        // A done (merged) row offers the Delete chip regardless of its local
        // Git state, so it must be gated by the in-flight removal itself.
        const worktreesPath = path.join(workspaceRoot, 'worktrees.json');
        const worktreesFile = JSON.parse(readFileSync(worktreesPath, 'utf8'));
        worktreesFile.worktrees = worktreesFile.worktrees.map((entry) =>
          entry.branchName === WORKTREE_BRANCH
            ? { ...entry, status: 'done' }
            : entry,
        );
        writeFileSync(
          worktreesPath,
          `${JSON.stringify(worktreesFile, null, 2)}\n`,
        );
      }

      const { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();

        const row = window.locator(
          `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
        );
        const frame = row.locator(
          'xpath=ancestor::*[@data-sidebar-variant][1]',
        );
        await expect(row).toBeVisible();
        await row.hover();
        const deleteButton = row.getByTestId('worktree-archive-button');
        await expect(deleteButton).toBeVisible({ timeout: 15_000 });
        await expect(deleteButton).toHaveAttribute('aria-label', /^Delete /);
        await deleteButton.click();

        // While teardown runs the row stays listed, labelled, muted and inert,
        // and its Delete chip is gone even with the pointer still over it.
        await expect(row).toContainText(/teardown/i, { timeout: 10_000 });
        // Checked at once, not polled: the chip must already be gone by the
        // time the teardown label paints.
        expect(await deleteButton.count()).toBe(0);
        expect(
          await row.evaluate((el) => getComputedStyle(el).pointerEvents),
        ).toBe('none');
        // The hover-revealed actions stay transparent under the pointer
        // (Playwright counts opacity 0 as visible, so read it directly).
        await row.hover({ force: true });
        expect(
          await row
            .getByTestId('worktree-actions-menu-button')
            .evaluate((el) => getComputedStyle(el).opacity),
        ).toBe('0');
        await expect(
          row.locator('.opacity-50').first(),
          'row content is faded',
        ).toBeVisible();
        await expect(frame).toHaveAttribute('aria-disabled', 'true');
        await expect(frame).toHaveAttribute('inert', '');
        const moreButton = row.getByTestId('worktree-actions-menu-button');
        await moreButton.focus();
        await expect(moreButton).not.toBeFocused();
        await window.keyboard.press('Enter');
        await expect(window.getByTestId('worktree-actions-menu')).toHaveCount(
          0,
        );
        await expect(frame).not.toHaveAttribute('data-selected', 'true');
        await frame.click({ force: true });
        await expect(frame).not.toHaveAttribute('data-selected', 'true');
        await expect(row).toContainText(/teardown/i);
        await expect(deleteButton).toHaveCount(0);

        await expect(row).toHaveCount(0, { timeout: 60_000 });
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('G5: set-label action opens Branch Info with label edit active', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
      await window.getByTestId('worktree-actions-menu-set-label').click();

      const dialog = window.getByRole('dialog', { name: 'Branch info' });
      await expect(dialog).toBeVisible();
      const labelInput = dialog.getByTestId('label-field-input');
      await expect(labelInput).toBeVisible();
      await expect(labelInput).toBeFocused();
      await expect(labelInput).toHaveValue('');

      await labelInput.fill('Release Candidate');
      await dialog.getByTestId('label-field-save').click();
      await expect(dialog.getByTestId('label-field-display')).toHaveText(
        'Release Candidate',
      );
      await expect(row).toContainText('Release Candidate');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('G5: archive action remains available for unpushed local commits', async () => {
    // Seed manually so we can create a clean worktree with committed local
    // branch changes before the app launches. A local bare origin gives the
    // branch an upstream; the extra commit then drives both `hasCommitsAhead`
    // and `hasUnpushedCommits` without relying on a dirty checkout.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-g5-unpushed-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const workspace = demoSeed.workspaces[0];
    const repoPath = workspace?.repoPath;
    const worktreePath = workspace?.worktreePath;
    expect(repoPath, 'seeded source repo path').toBeTruthy();
    expect(worktreePath, 'seeded worktree path').toBeTruthy();

    const bareOriginPath = path.join(userDataDir, 'g5-unpushed-origin.git');
    execFileSync('git', ['init', '--bare', bareOriginPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync(
      'git',
      ['-C', repoPath, 'remote', 'add', 'origin', bareOriginPath],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    execFileSync('git', ['-C', repoPath, 'push', 'origin', 'main'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync(
      'git',
      ['-C', worktreePath, 'push', '-u', 'origin', 'demo-main'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );

    writeFileSync(
      path.join(worktreePath, 'CANOPY_E2E_UNPUSHED.txt'),
      'committed local change to force the delete confirmation dialog\n',
      'utf8',
    );
    execFileSync(
      'git',
      ['-C', worktreePath, 'add', 'CANOPY_E2E_UNPUSHED.txt'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    execFileSync(
      'git',
      [
        '-C',
        worktreePath,
        '-c',
        'user.name=Canopy E2E',
        '-c',
        'user.email=canopy-e2e@example.invalid',
        'commit',
        '-m',
        'Add unpushed E2E fixture',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const status = execFileSync(
      'git',
      ['-C', worktreePath, 'status', '--short'],
      {
        encoding: 'utf8',
      },
    );
    expect(status.trim(), 'worktree should be clean after local commit').toBe(
      '',
    );

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
      await expect(
        window.getByTestId('worktree-actions-menu-archive'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('G6: kanban page renders the board, columns, and seeded card, then returns', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });

      // The sidebar Code Workspaces section shows the seeded row; the kanban
      // board is not mounted until the kanban page is opened.
      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
        ),
      ).toBeVisible();
      await expect(window.getByTestId('worktree-kanban-board')).toHaveCount(0);

      // Open the Kanban page from the "More" popover. The unified sidebar
      // remains visible beside the board.
      await app.openKanbanPage();
      await expect(window.getByTestId('app-sidebar')).toBeVisible();

      const board = window.getByTestId('worktree-kanban-board');
      await expect(board).toBeVisible();

      // All five status columns render (WORKTREE_UI_STATUSES in
      // lib/worktree-status.ts).
      for (const status of ['idle', 'planning', 'working', 'unread', 'done']) {
        await expect(
          window.getByTestId(`worktree-kanban-column-${status}`),
        ).toBeVisible();
      }

      // The seeded idle worktree appears as a card in the kanban board. The row
      // testid + data-branch is reused inside each kanban card
      // (WorktreeItemAdapter, displayMode="kanban"), and the idle worktree lands
      // in the Idle column.
      const kanbanCard = board.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(kanbanCard).toBeVisible();
      await expect(
        window
          .getByTestId('worktree-kanban-column-idle')
          .locator(
            `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
          ),
      ).toBeVisible();

      // Return to the worktree page via the global shortcut; the board is torn
      // down and the sidebar auto-restores (kanban's hide is transient, and the
      // persisted preference is "visible"), so no manual toggle is needed for
      // the Code Workspaces row to be available again.
      await app.openMainPage();
      await expect(window.getByTestId('worktree-kanban-board')).toHaveCount(0);
      await expect(window.getByTestId('app-sidebar')).toBeVisible();
      await expect(
        window.locator(
          `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
        ),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('G6: kanban Branch from warns for uncommitted changes', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-kanban-branch-warning-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const worktreePath = demoSeed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();
    writeFileSync(
      path.join(worktreePath, 'CANOPY_E2E_KANBAN_DIRTY.txt'),
      'dirty kanban branch source\n',
      'utf8',
    );

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(
        window.getByTestId('pr-status-bar-local-commit'),
      ).toBeVisible({ timeout: 15_000 });
      await app.openKanbanPage();

      const board = window.getByTestId('worktree-kanban-board');
      const card = board.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(card).toBeVisible();
      await card.hover();
      await card.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-create-branch').click();

      const warning = window.getByTestId('branch-from-uncommitted-warning');
      await expect(warning).toBeVisible();
      await warning.getByRole('button', { name: 'Cancel' }).click();
      await expect(warning).toHaveCount(0);
      await expect(card).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Delete glyph rendering.
//
// The trash icon used to be a "masked" glyph: a solid `currentColor` rect cut
// by an inline SVG `<mask>` whose shared id resolved to a layout-less copy in
// a `display: none` container, so the row's Delete chip and the actions-menu
// Delete item rendered as solid squares. App icons are now plain filled
// Material Symbols with no mask; the pixel check keeps the user-visible
// contract pinned.
//
// Determinism: the seeded `ts-pnpm-vite` worktree is idle, so the Delete chip
// is available at rest; the pixel check reads a clip of the real renderer
// paint, decoded without third-party dependencies.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Minimal decoder for Playwright's screenshots: 8-bit RGB/RGBA, non-interlaced.
function decodePng(buffer) {
  expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature').toBe(
    true,
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      expect(bitDepth, 'PNG bit depth').toBe(8);
      expect(interlace, 'PNG interlace').toBe(0);
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      expect(channels, `PNG color type ${colorType}`).toBeGreaterThan(0);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) {
      throw new Error(`Unsupported PNG scanline filter: ${filter}`);
    }
    const line = Uint8Array.from(
      raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
    );
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + left) & 0xff;
      else if (filter === 2) line[i] = (line[i] + up) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4)
        line[i] = (line[i] + paethPredictor(left, up, upLeft)) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      rgba[dst] = line[src];
      rgba[dst + 1] = line[src + 1];
      rgba[dst + 2] = line[src + 2];
      rgba[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    previous = line;
  }
  return { width, height, rgba };
}

// Fraction of the glyph box painted in a color other than the surrounding
// background. A correctly drawn 14px trash glyph covers well under half of
// its box; a solid square covers all of it.
async function measureGlyphInkCoverage(window, glyph) {
  const box = await glyph.boundingBox();
  expect(box, 'glyph bounding box').not.toBeNull();
  const pad = 2;
  const clip = {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
  const png = await window.screenshot({ clip, animations: 'disabled' });
  const image = decodePng(png);
  const scale = image.width / clip.width;
  const inset = Math.round(pad * scale);
  const pixel = (x, y) => {
    const index = (y * image.width + x) * 4;
    return [image.rgba[index], image.rgba[index + 1], image.rgba[index + 2]];
  };
  const background = pixel(0, 0);
  let inked = 0;
  let total = 0;
  for (let y = inset; y < image.height - inset; y += 1) {
    for (let x = inset; x < image.width - inset; x += 1) {
      const [r, g, b] = pixel(x, y);
      const distance = Math.max(
        Math.abs(r - background[0]),
        Math.abs(g - background[1]),
        Math.abs(b - background[2]),
      );
      total += 1;
      if (distance > 48) inked += 1;
    }
  }
  return inked / total;
}

test.describe('worktree Delete glyph rendering', () => {
  test('the Delete chip and menu item draw the trash glyph, not a solid square', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();

      // Selecting the worktree portals a pinned copy of its row (Delete chip
      // included) into the sticky pin-top host, which precedes every workspace
      // row in the DOM and stays `hidden` until the selection scrolls out of
      // view. That layout-less copy is the first trash glyph in the
      // document — the state the user hits right after picking a worktree.
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      const pinTop = window.getByTestId('sidebar-selected-pin-top');
      await expect(pinTop).toHaveAttribute('hidden', '');
      await expect(
        pinTop.locator(
          '[data-testid="worktree-archive-button-pin-top"] svg[data-app-icon="true"]',
        ),
      ).toHaveCount(1);

      await row.hover();

      const chip = row.getByTestId('worktree-archive-button');
      await expect(chip).toHaveAttribute('aria-label', /^Delete /, {
        timeout: 15_000,
      });
      await expect(chip).toBeVisible();
      const chipGlyph = chip.locator('svg[data-app-icon="true"]');
      await expect(chipGlyph).toHaveCount(1);

      // The painted pixels are the user-visible contract.
      const chipCoverage = await measureGlyphInkCoverage(window, chipGlyph);
      expect(chipCoverage, 'chip glyph paints something').toBeGreaterThan(0.05);
      expect(chipCoverage, 'chip glyph is not a solid square').toBeLessThan(
        0.6,
      );
      await expect(chipGlyph).toHaveAttribute('data-glyph', 'trash-2');

      await row.getByTestId('worktree-actions-menu-button').click();
      const menu = window.getByTestId('worktree-actions-menu');
      await expect(menu).toBeVisible();
      const deleteItem = window.getByTestId('worktree-actions-menu-delete');
      await expect(deleteItem).toHaveText('Delete');
      const menuGlyph = deleteItem.locator('svg[data-app-icon="true"]');
      await expect(menuGlyph).toHaveCount(1);

      const menuCoverage = await measureGlyphInkCoverage(window, menuGlyph);
      expect(menuCoverage, 'menu glyph paints something').toBeGreaterThan(0.05);
      expect(menuCoverage, 'menu glyph is not a solid square').toBeLessThan(
        0.6,
      );
      await expect(menuGlyph).toHaveAttribute('data-glyph', 'trash-2');

      await window.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
