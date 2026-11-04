import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeSlowGitShim as writeSharedSlowGitShim } from './slowGitShim.mjs';

// Queued-worktree send UX under REALISTIC git latency. The plain fixtures'
// `git worktree add` completes in milliseconds, which hid every regression in
// this flow for six fix rounds: with instant git, the message legitimately
// processes immediately and none of the queued-state UI is exercised. These
// specs make `git worktree add` artificially slow (a CANOPY_GIT_EXECUTABLE
// shim — repo hooks can't do it because the app runs git with
// `core.hooksPath=<null device>`), then pin the contract the Home composer's
// new-worktree send must keep on real repos:
//
//   1. The Home → Code transition happens ~immediately (never blocked on any
//      `git worktree add`, network fetch, or repo-shadow ensure). The
//      multi-repo phase A regression this guards: `createMultiRepoWorktree`
//      resolving the workspace through the full sidebar read, whose
//      script/hook baseline resolution serializes through the repo-shadow
//      per-repo lock (`getBaselineReadPath` → `ensureRepoShadow`).
//   2. The first populated chat frame shows the user's message as SENT, with
//      the shared setup status ("Setting up this chat's copy of …" and a
//      ticking clock) in its turn's starting slot, while main holds the send
//      for git setup. The composer offers Stop. No queued bubble and no setup
//      annotation (CAN-4981).
//   3. Once git setup completes, the same status reads "Starting…" and the
//      held message dispatches on its own, leaving no setup copy behind.
// The setup status from `TurnWorkHeader`, in the starting turn's slot.
const SETUP_STATUS =
  '[data-testid="turn-starting-status"][data-turn-header="setup"]';
const GIT_SLEEP_SECONDS = 8;
// Source-backed multi-repo setup performs more pre-checks before the actual
// worktree-add than the single-repo path. Keep the worktree add pending long
// enough for the renderer to finish tab/model initialization and visibly
// enter the queued state on slower CI hosts.
const MULTI_REPO_GIT_SLEEP_SECONDS = 30;
// The transition must be bounded by the reservation IPC alone (sub-second
// locally). Anything over the shim's sleep means a `worktree add` leaked into
// the response path; the generous margin below it absorbs CI slowness.
const MAX_TRANSITION_MS = 6_000;

function writeSlowGitShim(userDataDir, options = {}) {
  return writeSharedSlowGitShim(userDataDir, {
    worktreeSleepSeconds: GIT_SLEEP_SECONDS,
    ...options,
  });
}

function seedStaleRepoShadow(userDataDir, repoPath) {
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], {
    cwd: repoPath,
  });
  const shadowKey = createHash('sha256')
    .update(repoPath)
    .digest('hex')
    .slice(0, 16);
  const shadowDir = path.join(userDataDir, 'repo-shadows', shadowKey);
  const checkout = path.join(shadowDir, 'checkout');
  mkdirSync(shadowDir, { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', checkout, 'HEAD'], {
    cwd: repoPath,
  });
  writeFileSync(
    path.join(shadowDir, 'meta.json'),
    JSON.stringify({
      version: 1,
      repoPath,
      defaultBranch: branch,
      lastSyncAt: new Date('2000-01-01T00:00:00.000Z').toISOString(),
    }),
  );
}

/**
 * Drives a Home-composer chat-mode send to the "New worktree" target and
 * asserts the fast-transition + setup-hold stages. Returns the chat panel
 * locator and task text so callers can assert their own terminal stage
 * (normal dispatch at git-ready, or the needs-repair detour).
 */
async function sendAndAssertSetupState(
  window,
  workspaceName,
  { assertSetupFrame = true, workspaceId } = {},
) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });

  await window.getByTestId('sidebar-create-task').click();
  const homePage = window.getByTestId('page-home');
  await expect(homePage).toBeVisible();
  if (workspaceId) {
    await homePage.getByTestId('home-workspace-select').click();
    await window.getByTestId(`home-workspace-option-${workspaceId}`).click();
  }
  await expect(homePage.getByTestId('home-workspace-select')).toContainText(
    workspaceName,
  );

  const taskText = 'Probe the slow-git queued worktree flow.';
  await homePage.getByTestId('home-composer-editor').click();
  await homePage.getByTestId('home-composer-editor').fill(taskText);

  // Record every chat frame from the send onward: the sent prompt and its
  // setup status are what the chat shows, never a queued bubble.
  await window.evaluate((setupStatus) => {
    const seen = [];
    const record = () => {
      const chat = document.querySelector('[data-testid="panel-content-chat"]');
      if (!chat) return;
      if (
        !seen.includes('queued') &&
        chat.querySelector('[data-testid="queued-message-bubble"]')
      )
        seen.push('queued');
      if (!seen.includes('setup') && chat.querySelector(setupStatus))
        seen.push('setup');
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__homeSetupSendFrames = { seen, stop: () => observer.disconnect() };
  }, SETUP_STATUS);

  const sentAt = Date.now();
  await homePage.getByTestId('home-send-button').click();

  // Stage 1: single fast transition — Home unmounts and a usable chat (panel
  // plus composer) is present while `git worktree add` is still sleeping.
  // Requiring the composer, rather than only the outer panel, guards the
  // registration-time empty-chat regression.
  await expect(homePage).toHaveCount(0, { timeout: 30_000 });
  const transitionMs = Date.now() - sentAt;
  expect(transitionMs).toBeLessThan(MAX_TRANSITION_MS);
  const panel = window.getByTestId('panel-content-chat');
  try {
    await expect(panel).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    const handoff = await window
      .evaluate(async () => {
        const preferences = await window.api.loadPreferences();
        const rows = Array.from(
          document.querySelectorAll('[data-testid="worktree-row"]'),
        ).map((row) => ({
          projectId: row.getAttribute('data-project-id'),
          worktreeId: row.getAttribute('data-worktree-id'),
        }));
        return {
          lastActiveContext: preferences.lastActiveContext,
          scopes: await Promise.all(
            rows.map(async ({ projectId, worktreeId }) => ({
              projectId,
              worktreeId,
              state:
                projectId && worktreeId
                  ? await window.api.chat.getState({ projectId, worktreeId })
                  : null,
            })),
          ),
        };
      })
      .catch((diagnosticError) => ({
        diagnosticError: String(diagnosticError),
      }));
    await test.info().attach('home-setup-handoff.json', {
      body: Buffer.from(JSON.stringify(handoff, null, 2)),
      contentType: 'application/json',
    });
    throw error;
  }
  await expect(panel.getByRole('textbox').first()).toBeVisible({
    timeout: 15_000,
  });

  if (assertSetupFrame) {
    // Stage 2: the held send. With git sleeping for several more seconds
    // these must all be present together; if a regression makes the create
    // path block until git finishes, the setup status never renders.
    await expect(panel.getByText(taskText).first()).toBeVisible({
      timeout: 15_000,
    });
    const status = panel.locator(SETUP_STATUS);
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status.getByRole('status')).toHaveText(
      `Setting up this chat's copy of ${workspaceName}`,
    );
    const clock = status.locator('[data-turn-setup-clock]');
    await expect(clock).toHaveAttribute('aria-hidden', 'true');
    const firstReading = await clock.textContent();
    await expect
      .poll(() => clock.textContent(), { timeout: 7_000 })
      .not.toBe(firstReading);
    // The held turn is running as far as the composer is concerned.
    await expect(panel.getByTestId('chat-stop-generation')).toBeVisible();
    await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
    await expect(
      panel.getByText('Chat initiated before project setup'),
    ).toHaveCount(0);
    const seenFrames = await window.evaluate(() => {
      const frames = window.__homeSetupSendFrames;
      frames?.stop();
      return frames?.seen ?? [];
    });
    expect(seenFrames).toEqual(['setup']);
  }
  await window.evaluate(() => window.__homeSetupSendFrames?.stop());

  return { panel, taskText };
}

/**
 * Drives a Home-composer chat-mode send to the "New worktree" target and
 * asserts the setup-hold UX stages in order. Returns after the held message
 * has dispatched.
 */
async function assertHeldHomeSend(window, workspaceName, options) {
  const { panel, taskText } = await sendAndAssertSetupState(
    window,
    workspaceName,
    options,
  );

  // Stage 3: automatic dispatch at git-ready. The setup status leaves (the
  // same node reads "Starting…" until the reply) while the message text stays
  // in the transcript.
  await expect(panel.locator(SETUP_STATUS)).toHaveCount(0, {
    timeout: 120_000,
  });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(taskText).first()).toBeVisible();
  await expect(
    panel.getByText('Chat initiated before project setup'),
  ).toHaveCount(0);
}

async function assertEventuallyDispatchedHomeSend(
  window,
  workspaceName,
  shadowFetchCompletedMarkerPath,
) {
  const { panel, taskText } = await sendAndAssertSetupState(
    window,
    workspaceName,
  );

  // The refresh remains inside its delayed fetch throughout both the held
  // frame and automatic dispatch; message visibility alone cannot distinguish
  // those lifecycle stages.
  expect(existsSync(shadowFetchCompletedMarkerPath)).toBe(false);
  await expect(panel.locator(SETUP_STATUS)).toHaveCount(0, {
    timeout: 60_000,
  });
  expect(existsSync(shadowFetchCompletedMarkerPath)).toBe(false);
  await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
  await expect(panel.getByText(taskText).first()).toBeVisible();
}

test.describe('home composer send with slow git worktree add', () => {
  test('the model picker stays usable inside a chat while git setup is pending', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-slow-git-model-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir, {
          worktreeSleepSeconds: 30,
        }),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const { panel } = await sendAndAssertSetupState(
        window,
        'TypeScript pnpm Vite',
      );
      const picker = panel.getByTestId('chat-model-picker');
      await expect(picker).toBeEnabled();
      await picker.click();
      const option = window
        .getByTestId('chat-model-menu')
        .locator(
          '[data-model-id][aria-checked="false"]:not([aria-disabled="true"])',
        )
        .first();
      const chosen = await option.getAttribute('data-model-id');
      expect(chosen).toBeTruthy();
      await option.click();
      await expect(panel.locator(SETUP_STATUS)).toBeVisible();
      await picker.click();
      await expect(
        window
          .getByTestId('chat-model-menu')
          .locator('[data-model-id][aria-checked="true"]'),
      ).toHaveAttribute('data-model-id', chosen);
      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('branch mutations stay unavailable while git setup is pending', async () => {
    test.setTimeout(180_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-slow-git-branch-info-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir, {
          worktreeSleepSeconds: 30,
        }),
      },
    });

    try {
      const window = await electronApp.firstWindow();
      await sendAndAssertSetupState(window, 'TypeScript pnpm Vite');
      const row = window.getByTestId('worktree-row');
      await expect(row).toHaveCount(1);
      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-info').click();

      const dialog = window.getByRole('dialog', { name: 'Branch info' });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByTestId('branch-setup-pending-notice'),
      ).toContainText('Branch changes will be available when setup finishes.');
      await expect(
        dialog.getByRole('button', { name: 'Switch branch' }),
      ).toBeDisabled();
      await expect(dialog.getByLabel('Rename branch')).toBeDisabled();
      await expect(
        dialog.getByTestId('base-branch-dropdown-trigger'),
      ).toBeDisabled();
      await expect(
        dialog.getByText(/Error invoking remote method/),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('CAN-5422: Home shows the creation error, settles pending state and retries in the same app', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-git-retry-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    const creationError =
      'Selected Git executable cannot be used. Install Git, then recheck.';
    const prompt = 'Keep this task draft while Git is repaired.';
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      // Isolate renderer failure/retry from Linux discovery (covered by the
      // main regression). Fail once at the established creation IPC boundary,
      // then restore the REAL handler before retry. No provider is contacted.
      await electronApp.evaluate(({ ipcMain }, message) => {
        const create = ipcMain._invokeHandlers.get('worktree:create');
        const send = ipcMain._invokeHandlers.get('chat:send-message');
        if (!create || !send) throw new Error('Home IPC handlers unavailable');
        const state = { create, send, sends: [] };
        globalThis.__can5422HomeRetry = state;
        ipcMain.removeHandler('worktree:create');
        ipcMain.handle('worktree:create', async () => {
          await new Promise((resolve) => {
            state.releaseFailure = resolve;
          });
          ipcMain.removeHandler('worktree:create');
          ipcMain.handle('worktree:create', create);
          throw new Error(message);
        });
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', (_event, request) => {
          state.sends.push(request);
          return {};
        });
      }, creationError);

      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home).toBeVisible();
      await expect(home.getByTestId('home-workspace-select')).toContainText(
        'TypeScript pnpm Vite',
      );
      await home.getByTestId('home-composer-editor').fill(prompt);
      const send = home.getByTestId('home-send-button');
      await send.click();
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => typeof globalThis.__can5422HomeRetry.releaseFailure,
          ),
        )
        .toBe('function');
      await expect(send).toBeDisabled();
      await electronApp.evaluate(() =>
        globalThis.__can5422HomeRetry.releaseFailure(),
      );

      // This assertion goes red if Home replaces worktreeError with its
      // generic "Failed to create worktree" message again.
      await expect(home.getByTestId('home-composer-error')).toContainText(
        creationError,
      );
      await expect(send).toBeEnabled();
      await expect(
        window.getByLabel('Creating worktree', { exact: true }),
      ).toHaveCount(0);
      await expect(home.getByTestId('home-composer-editor')).toHaveText(prompt);
      await expect(window.getByTestId('worktree-row')).toHaveCount(0);
      expect(
        await electronApp.evaluate(() => globalThis.__can5422HomeRetry.sends),
      ).toEqual([]);

      // The same draft and same application use real worktree creation now.
      await send.click();
      await expect(home).toHaveCount(0, { timeout: 30_000 });
      const row = window.getByTestId('worktree-row');
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await expect(row).toBeVisible();
      await expect(
        window
          .getByTestId('panel-content-chat')
          .getByText(prompt, { exact: true }),
      ).toBeVisible();
      await expect(window.getByTestId('home-composer-error')).toHaveCount(0);
      await expect(
        window.getByLabel('Creating worktree', { exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__can5422HomeRetry.sends.length,
          ),
        )
        .toBe(1);
      const worktrees = JSON.parse(
        readFileSync(
          path.join(
            userDataDir,
            'workspaces',
            'demo-ts-pnpm-vite',
            'worktrees.json',
          ),
          'utf8',
        ),
      ).worktrees;
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0].id).toBe(await row.getAttribute('data-worktree-id'));
    } finally {
      await electronApp
        .evaluate(({ ipcMain }) => {
          const state = globalThis.__can5422HomeRetry;
          if (!state) return;
          state.releaseFailure?.();
          for (const [channel, handler] of [
            ['worktree:create', state.create],
            ['chat:send-message', state.send],
          ]) {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, handler);
          }
          delete globalThis.__can5422HomeRetry;
        })
        .catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('single-repo: immediate transition, held send with setup status, auto-dispatch', async () => {
    test.setTimeout(180_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-slow-git-single-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir) },
    });

    try {
      const window = await electronApp.firstWindow();
      await assertHeldHomeSend(window, 'TypeScript pnpm Vite');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a follow-up during setup is an ordinary queued row, locked behind the held turn', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-slow-git-follow-up-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir, {
          worktreeSleepSeconds: 30,
        }),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const { panel } = await sendAndAssertSetupState(
        window,
        'TypeScript pnpm Vite',
      );
      const followUp = 'Follow up after setup finishes.';
      await panel.getByRole('textbox').last().fill(followUp);
      await panel.getByRole('textbox').last().press('Enter');
      const row = panel.getByTestId('queued-message-bubble');
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await expect(row).toContainText(followUp);
      // The status line is the only setup explanation; the row has none.
      await expect(row).not.toContainText('Setting up');
      await expect(panel.locator(SETUP_STATUS)).toHaveCount(1);
      // Nothing may run ahead of the held turn: main projects the row
      // `forceLocked`, so Interrupt, Run now and Steer stay hidden. Edit and
      // Clear still work.
      await row.hover();
      await expect(row.getByTestId('queued-message-interrupt')).toHaveCount(0);
      await expect(row.getByTestId('queued-message-run-now')).toHaveCount(0);
      await expect(row.getByTestId('queued-message-steer')).toHaveCount(0);
      await expect(row.getByTestId('queued-message-more')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a failed git setup ends the held turn and the follow-up queued behind it', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-slow-git-failed-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir, {
          worktreeSleepSeconds: 20,
          worktreeExitCode: 128,
        }),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const { panel, taskText } = await sendAndAssertSetupState(
        window,
        'TypeScript pnpm Vite',
      );
      const followUp = 'Follow up that never runs.';
      await panel.getByRole('textbox').last().fill(followUp);
      await panel.getByRole('textbox').last().press('Enter');
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(1, {
        timeout: 15_000,
      });

      // The setup status leaves with the held turn, which ends failed. Main
      // ends the follow-up in the same commit: it leaves the queue and stays
      // in the transcript as its own failed turn, so its text is not lost.
      // The composer offers Send again.
      await expect(panel.locator(SETUP_STATUS)).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      await expect(panel.getByText(/^Failed after /)).toHaveCount(2);
      await expect(panel.getByText(taskText).first()).toBeVisible();
      await expect(panel.getByText(followUp).first()).toBeVisible();
      await expect(panel.getByTestId('chat-stop-generation')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Stop during setup ends the held turn before it reaches the agent', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-slow-git-stop-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir, {
          worktreeSleepSeconds: 30,
        }),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const { panel, taskText } = await sendAndAssertSetupState(
        window,
        'TypeScript pnpm Vite',
      );
      await panel.getByTestId('chat-stop-generation').click();
      await expect(panel.locator(SETUP_STATUS)).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(panel.getByTestId('chat-stop-generation')).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(panel.getByText(taskText).first()).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('single-repo: held send dispatches during an offline-slow base refresh', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-slow-base-refresh-'),
    );
    const seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    seedStaleRepoShadow(userDataDir, seed.workspaces[0].repoPath);
    const shadowFetchMarkerPath = path.join(
      userDataDir,
      'shadow-fetch-started',
    );
    const shadowFetchCompletedMarkerPath = path.join(
      userDataDir,
      'shadow-fetch-completed',
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir, {
          // Base maintenance starts after a 10-second grace period. Keep
          // worktree setup active across that boundary, while delaying only
          // the stale shadow's fetch—not canonical worktree Git operations.
          worktreeSleepSeconds: GIT_SLEEP_SECONDS,
          shadowFetchSleepSeconds: 20,
          shadowFetchMarkerPath,
          shadowFetchCompletedMarkerPath,
        }),
      },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await expect
        .poll(() => existsSync(shadowFetchMarkerPath), {
          timeout: 45_000,
          message: 'background base refresh entered its delayed shadow fetch',
        })
        .toBe(true);
      await assertEventuallyDispatchedHomeSend(
        window,
        'TypeScript pnpm Vite',
        shadowFetchCompletedMarkerPath,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('source-backed multi-repo: immediate transition, held send, auto-dispatch', async () => {
    test.setTimeout(240_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-slow-git-multi-'),
    );
    const seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['multi-repo-fullstack'],
      createWorktrees: false,
    });

    // The raw fixture's source repo fails workspace-root validation (its
    // `.gitignore` lacks the `repos/` entry), which would divert this run into
    // the needs-repair flow instead of the queued-send happy path. Bring the
    // root up to the validated shape the app itself writes on workspace
    // creation, and commit so the worktree checkout inherits it.
    const rootRepoPath = seed.workspaces[0].repoPath;
    appendFileSync(
      path.join(rootRepoPath, '.gitignore'),
      '\n# Canopy multi-repo child repositories\nrepos/\n',
    );
    writeFileSync(
      path.join(rootRepoPath, 'CLAUDE.md'),
      '# Project instructions\n',
    );
    try {
      symlinkSync('CLAUDE.md', path.join(rootRepoPath, 'AGENTS.md'));
    } catch {
      // already present in the fixture
    }
    execFileSync('git', ['add', '-A'], { cwd: rootRepoPath });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=E2E',
        '-c',
        'user.email=e2e@test',
        'commit',
        '-m',
        'validate project root',
      ],
      { cwd: rootRepoPath },
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir, {
          worktreeSleepSeconds: MULTI_REPO_GIT_SLEEP_SECONDS,
        }),
      },
    });

    try {
      const window = await electronApp.firstWindow();
      await assertHeldHomeSend(window, 'Multi Repo Fullstack');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('needs-repair detour: the held message survives the repair and auto-dispatches', async () => {
    test.setTimeout(240_000);

    // The RAW multi-repo fixture (no root patch) fails workspace-root
    // validation (`.gitignore` lacks `repos/`), so deferred Phase B ends in
    // the async needs-repair rollback instead of git-ready. The held message
    // must ride through: needs-repair keeps the git setup pending, so main's
    // hold survives; the repair modal repairs the same worktree id, and the
    // repair's ready outcome releases the send with no user re-entry.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-slow-git-repair-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['multi-repo-fullstack'],
      createWorktrees: false,
    });

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir, {
          worktreeSleepSeconds: MULTI_REPO_GIT_SLEEP_SECONDS,
        }),
      },
    });

    try {
      const window = await electronApp.firstWindow();
      const { panel, taskText } = await sendAndAssertSetupState(
        window,
        'Multi Repo Fullstack',
        {
          // The invalid source root can emit needs-repair before the renderer
          // paints the transient setup frame. The source-backed happy-path
          // case above owns that intermediate-state assertion; this case owns
          // the durability contract across rollback + repair.
          assertSetupFrame: false,
        },
      );

      // Phase B finishes the (slow) root checkout, validation flags the
      // blocking .gitignore issue, and the repair modal opens.
      await expect(
        window.getByRole('heading', { name: 'Repair project worktree' }),
      ).toBeVisible({ timeout: 120_000 });

      await expect(
        window.getByRole('checkbox', {
          name: 'Restore project instructions from the project source repo while repairing.',
        }),
      ).toBeChecked();

      await expect(
        panel.getByText('Chat initiated before project setup'),
      ).toHaveCount(0);

      await window.getByRole('button', { name: 'Repair worktree' }).click();

      // Repair recreates the same worktree id, re-selects it, and main
      // releases the held send: the message stays in the transcript and the
      // setup status clears. The user never had to resend.
      await expect(panel).toBeVisible({ timeout: 60_000 });
      await expect(panel.getByText(taskText).first()).toBeVisible({
        timeout: 120_000,
      });
      await expect(panel.locator(SETUP_STATUS)).toHaveCount(0, {
        timeout: 120_000,
      });
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      await expect(
        panel.getByText('Chat initiated before project setup'),
      ).toHaveCount(0);
      await expect(window.getByTestId('worktree-row')).toHaveCount(1, {
        timeout: 30_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

for (const layout of [
  'worktree directory',
  'worktree symbolic link',
  'source symbolic link',
]) {
  test(`repair keeps unsupported instructions non-blocking: ${layout}`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'instructions-optional-repair-'),
    );
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['multi-repo-fullstack'],
      createWorktrees: false,
      fixturesDir: path.join(userDataDir, 'fixtures'),
    });
    const workspace = seeded.workspaces[0];
    const source = workspace.repoPath;
    const guidance = '# Preserve unsupported project guidance\n';
    for (const name of ['AGENTS.md', 'CLAUDE.md'])
      rmSync(path.join(source, name), { force: true });
    if (layout === 'worktree directory') {
      mkdirSync(path.join(source, 'AGENTS.md'));
      writeFileSync(path.join(source, 'AGENTS.md', 'rules.md'), guidance);
    }
    if (layout === 'worktree symbolic link') {
      mkdirSync(path.join(source, 'docs'), { recursive: true });
      writeFileSync(path.join(source, 'docs', 'rules.md'), guidance);
      symlinkSync('docs/rules.md', path.join(source, 'AGENTS.md'));
    }
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync(
      'git',
      ['commit', '--allow-empty', '-m', 'Prepare optional instruction repair'],
      { cwd: source },
    );
    if (layout === 'source symbolic link') {
      mkdirSync(path.join(source, 'docs'), { recursive: true });
      writeFileSync(path.join(source, 'docs', 'rules.md'), guidance);
      symlinkSync('docs/rules.md', path.join(source, 'CLAUDE.md'));
    }
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      const taskText = 'Inspect the preserved project guidance.';
      await home.getByTestId('home-composer-editor').fill(taskText);
      await home.getByTestId('home-send-button').click();
      const dialog = window.getByRole('dialog', {
        name: 'Repair project worktree',
      });
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      if (layout.startsWith('worktree')) {
        await test.info().attach('instruction-repair-warnings.txt', {
          body: Buffer.from(await dialog.innerText()),
          contentType: 'text/plain',
        });
        await expect(
          dialog.getByText('AGENTS.md is missing from the project root', {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          dialog.getByText('AGENTS.md must mirror CLAUDE.md', {
            exact: true,
          }),
        ).toBeVisible();
      }
      await dialog
        .getByRole('button', { name: 'Repair worktree', exact: true })
        .click();
      try {
        await expect(dialog).toHaveCount(0, { timeout: 30_000 });
      } catch (error) {
        await test.info().attach('repair-dialog.txt', {
          body: Buffer.from(await dialog.innerText()),
          contentType: 'text/plain',
        });
        throw error;
      }
      await expect(window.getByTestId('worktree-row')).toHaveCount(1);
      await expect(
        window.getByText(taskText, { exact: true }).first(),
      ).toBeVisible();
      const roots = path.join(
        userDataDir,
        'workspaces',
        workspace.id,
        'worktrees',
      );
      const entries = readdirSync(roots, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory(),
      );
      expect(entries).toHaveLength(1);
      const root = path.join(roots, entries[0].name);
      expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain(
        'repos/',
      );
      if (layout === 'worktree directory') {
        expect(
          readFileSync(path.join(root, 'AGENTS.md', 'rules.md'), 'utf8'),
        ).toBe(guidance);
      } else if (layout === 'worktree symbolic link') {
        expect(readlinkSync(path.join(root, 'AGENTS.md'))).toBe(
          'docs/rules.md',
        );
        expect(readFileSync(path.join(root, 'docs', 'rules.md'), 'utf8')).toBe(
          guidance,
        );
      } else {
        expect(readlinkSync(path.join(source, 'CLAUDE.md'))).toBe(
          'docs/rules.md',
        );
        expect(
          readFileSync(path.join(source, 'docs', 'rules.md'), 'utf8'),
        ).toBe(guidance);
        expect(existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const layout of ['equal copies', 'reverse alias']) {
  test(`repair restores source instruction compatibility: ${layout}`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'instructions-repair-'),
    );
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['multi-repo-fullstack'],
      createWorktrees: false,
      fixturesDir: path.join(userDataDir, 'fixtures'),
    });
    const workspace = seeded.workspaces[0];
    const source = workspace.repoPath;
    // The committed root has no instructions; the source's local guidance
    // must be restored by the repair action, not inherited by git checkout.
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      rmSync(path.join(source, name), { force: true });
    }
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync(
      'git',
      ['commit', '--allow-empty', '-m', 'Remove root instructions'],
      { cwd: source },
    );
    const content = '# Restored project rules\nPreserve compatibility.\n';
    writeFileSync(path.join(source, 'AGENTS.md'), content);
    if (layout === 'reverse alias')
      symlinkSync('AGENTS.md', path.join(source, 'CLAUDE.md'));
    else writeFileSync(path.join(source, 'CLAUDE.md'), content);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await home
        .getByTestId('home-composer-editor')
        .fill('Inspect project guidance.');
      await home.getByTestId('home-send-button').click();
      const dialog = window.getByRole('dialog', {
        name: 'Repair project worktree',
      });
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await dialog
        .getByRole('button', { name: 'Repair worktree', exact: true })
        .click();
      await expect(dialog).toHaveCount(0, { timeout: 60_000 });
      const roots = path.join(
        userDataDir,
        'workspaces',
        workspace.id,
        'worktrees',
      );
      const entries = readdirSync(roots, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory(),
      );
      expect(entries).toHaveLength(1);
      const root = path.join(roots, entries[0].name);
      await expect
        .poll(() => existsSync(path.join(root, 'AGENTS.md')))
        .toBe(true);
      expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(content);
      expect(existsSync(path.join(root, 'CLAUDE.md'))).toBe(true);
      expect(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe(content);
      if (layout === 'reverse alias')
        expect(readlinkSync(path.join(root, 'CLAUDE.md'))).toBe('AGENTS.md');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
