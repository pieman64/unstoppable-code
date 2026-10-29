import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  buildPrStatusData,
  buildPrStatusEvent,
  injectGithubPrStatus,
} from './seeders/index.mjs';

// Doc 2 — Spec 13: git / PR / worktree state, deterministic slice.
//
// Spec 13 nominally covers PRs 823, 737, 712, 718, 735. The Zustand stores are
// NOT exposed on `window` in the renderer build (verified: no
// `window.useGitHubStore` / `window.__CANOPY*` seam exists), so DIRECT store
// injection is not available. The PR-status surfaces are instead driven through
// the SUPPORTED IPC seam: the `injectGithubPrStatus` seeder emits the same
// `github:pr-status-event` the main-process PR poller broadcasts, which the
// renderer `githubStore.subscribeToEvents()` consumes — keying
// `prStatuses['${projectId}/${worktreeId}']` (drives `PrStatusBar`'s PR badge)
// and `projectsStore.setWorktreeLastKnownPrStatus(...)` (drives the sidebar
// `worktree-row-pr-badge`). See `seeders/injectGithubPrStatus.mjs`.
//
// Coverage map:
//   - 823 (open-PR badge): COVERED — inject `kind:'open-pr'` (prNumber 823) and
//     assert the `pr-status-bar` shows `#823` + `CI passing`, and the
//     sidebar `worktree-row-pr-badge` lights with `PR #823`.
//   - 735 (stale-after-rename PR): COVERED for the PR-status surface — inject
//     `kind:'stale-after-rename'` (prNumber 735) and assert the still-open PR
//     remains visible with a failing/conflict signal in the bar. The "Merge
//     conflict detected" detail card lives in the (collapsible) activity-panel
//     `PullRequestSection`, not the always-visible bar, so it is not asserted
//     here.
//   - 737 (PR badge clears on branch rename): the open→none transition this
//     injector can reach IS covered by the dedicated `no-pr` test (inject a PR,
//     then inject `kind:'no-pr'` and assert both badge surfaces clear). The
//     rename ACTION itself (which would normally trigger the clear) is a
//     `projectsStore` branch-rename flow, not drivable through this PR-status
//     channel — STILL BLOCKED for the action half.
//   - 718 (repo-mismatch / branch-not-renamed warning): STILL BLOCKED.
//     `PrStatusBar` derives this from `shouldWarnBranchNotRenamed(...)`, whose
//     inputs come from `projectsStore` branch state (`worktreeBranchName`,
//     `hasBranchBeenPushed`, `repoBranches`), NOT from the PR-status event. The
//     injector author documents this explicitly; it is not faked here.
//   - CAN-3053 finding 9 (sidebar creating/merging chips): both are COVERED.
//     The MERGING chip (`worktree-row-pr-merging`, `WorktreePrMergingIndicator`)
//     is asserted in the "merge PR progress tooltip" test below, which clicks
//     the real merge button behind `installPendingMergePrIpcMock`. The
//     CREATING chip (`worktree-row-pr-creating`, `WorktreePrCreatingIndicator`)
//     is asserted in "clicking … lights the sidebar row creating chip" below:
//     with the default preference (`reviewCommitMessage: false`),
//     `useGitHubStore.createPr` sets `creatingPr` SYNCHRONOUSLY, before any
//     IPC round trip, then calls the ONE `github:create-pr` IPC directly — no
//     local commit/push runs in the renderer action first. Mocking that
//     single handler (the same shape `installPendingMergePrIpcMock` uses for
//     merge) makes the click deterministic without ever touching the bare
//     origin, so the real-push risk the CTA-structure test above avoids by
//     never clicking does not apply once that one call is mocked.
//
// This file owns only the DETERMINISTIC parts reachable WITHOUT a GitHub
// remote/token, real push, or store-injection seam:
//
//   1. PR 712 — Settings → Git "Agent Rebase and Auto Stash Resolution" toggle
//      (`settings-git-agent-rebase-toggle`) renders, flips its `aria-checked`
//      state, reveals the resolution model select
//      (`settings-git-agent-rebase-model`) only when enabled, and the enabled
//      state survives a relaunch (reuse `userDataDir`). The toggle is flipped
//      ONLY through the settings UI (per task constraint).
//
//   2. PR-status-bar structure — with a seeded `ts-pnpm-vite` worktree
//      (`demo-main`) selected, `pr-status-bar` (PrStatusBar.tsx) renders, and
//      its primary action (`pr-status-bar-primary-action`) renders with the
//      deterministic no-PR "Commit, push & create PR" label.
//
//      The primary-action button (the "Create PR" CTA) is conditionally
//      rendered: it only appears when `getSingleRepoGitAction(...) ===
//      'create-pr'` (githubBranchActions.ts), which requires the repo to have
//      an `origin` remote AND local changes AND no open PR. The demo seed has
//      NO origin remote (seed-canopy-data.mjs never runs `git remote add`), so
//      the seeded worktree is local-only and the bar would otherwise show the
//      "Commit"/"Merge" local-only buttons instead of the create-PR CTA.
//
//      To reach the create-PR structure deterministically and WITHOUT any
//      network, we attach a LOCAL BARE repo as `origin` to the source repo
//      (visible from the worktree via shared git config) and write one
//      untracked file into the worktree checkout before launch. That makes
//      `hasOriginRemote === true` and `uncommittedChanges === true`, so the
//      single-repo action resolves to `create-pr` and the label resolves to
//      `getCreatePrLabel({ uncommittedChanges: true, hasUnpushedCommits:
//      false }) === 'Commit, push & create PR'`. We never click the button (a
//      click would attempt a real push) and never push to the bare origin.
//
// Determinism: no live agents, no network, no PTY, no real push/PR creation.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const OTHER_WORKSPACE_ID = 'demo-ts-npm-next';
const WORKTREE_BRANCH = 'demo-main';

function seedBuiltinGhApprovalPreferences(userDataDir) {
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
          legalConsentTosVersion: '2026-07-06',
          defaultWorktreeProvider: 'claude',
          defaultChatProvider: 'claude',
          defaultChatInterfaceMode: 'canopy',
          defaultWorktreeModelByProvider: {
            claude: {
              model: 'claude-haiku-4-5-20251001',
              thinkingLevel: 'off',
            },
          },
          providerModelConfigDefaults: {
            claude: { thinkingLevel: 'off' },
          },
          approvalDefaults: {
            worktree: 'auto',
            cowork: 'ask',
            appAdvisor: 'ask',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    path.join(userDataDir, 'migrations.json'),
    `${JSON.stringify(
      { version: 1, approval_defaults_full_access: true },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function mergeablePrStatus(options) {
  const { prNumber, unresolvedReviewThreadCount = 0 } = options;
  return {
    ...buildPrStatusData({ prNumber }),
    reviewStatus: 'approved',
    mergeableState: 'clean',
    unresolvedReviewThreadCount,
  };
}

function failingPrStatus(prNumber) {
  return {
    ...buildPrStatusData({ prNumber, checkStatus: 'failing' }),
    reviewStatus: 'approved',
    checkDetails: [
      {
        name: 'test',
        status: 'failing',
        url: `https://github.com/canopy-e2e/repo/actions/runs/${prNumber}`,
      },
    ],
  };
}

async function installPrActionIpcMocks(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const calls = [];
    globalThis.__CANOPY_E2E_PR_ACTION_CALLS__ = calls;

    const channels = [
      'github:merge-pr',
      'github:start-merge-conflict-resolution',
      'github:start-ci-check-fix',
    ];
    for (const channel of channels) {
      ipcMain.removeHandler(channel);
    }

    const verifiedRepos = [
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        prNumber: 901,
        prUrl: 'https://github.com/canopy-e2e/repo-a/pull/901',
        mergeable: true,
        usesMergeQueue: true,
        // The default merge queue setting with no `pr:queue:removed` hook.
        startsAgentChat: true,
        unresolvedReviewThreadCount: 2,
      },
      {
        repoId: 'repo-b',
        repoName: 'Repo B',
        prNumber: 902,
        prUrl: 'https://github.com/canopy-e2e/repo-b/pull/902',
        mergeable: true,
        startsAgentChat: false,
        unresolvedReviewThreadCount: 0,
      },
    ];

    ipcMain.handle('github:merge-pr', (_event, request) => {
      calls.push({ channel: 'github:merge-pr', request });

      if (request.dryRun) {
        return {
          dryRun: true,
          verifiedRepos,
          mergedRepos: [],
          requiresUnresolvedConfirmation: [],
          failedRepos: [],
        };
      }

      if (!request.confirmUnresolvedComments) {
        const repo = verifiedRepos[0];
        return {
          dryRun: false,
          verifiedRepos: [repo],
          mergedRepos: [],
          requiresUnresolvedConfirmation: [repo],
          failedRepos: [],
        };
      }

      return {
        dryRun: false,
        verifiedRepos,
        mergedRepos: verifiedRepos
          .filter(
            (repo) =>
              !Array.isArray(request.repoIds) ||
              request.repoIds.includes(repo.repoId),
          )
          .map((repo) => ({
            repoId: repo.repoId,
            repoName: repo.repoName,
            prNumber: repo.prNumber,
            prUrl: repo.prUrl,
            mergeMethod: 'squash',
            mergeCommitSha: 'e2e-merge-sha',
            status: 'merged',
          })),
        requiresUnresolvedConfirmation: [],
        failedRepos: [],
      };
    });

    ipcMain.handle(
      'github:start-merge-conflict-resolution',
      (_event, request) => {
        calls.push({
          channel: 'github:start-merge-conflict-resolution',
          request,
        });
        return { chatId: 'conflict-resolution-chat' };
      },
    );

    ipcMain.handle('github:start-ci-check-fix', (_event, request) => {
      calls.push({ channel: 'github:start-ci-check-fix', request });
      return { chatId: 'ci-fix-chat' };
    });
  });
}

/**
 * Merge IPC mock for a base branch that requires a GitHub merge queue: dry
 * runs report the PR as mergeable, real merges report it `enqueued`.
 */
async function installEnqueueMergePrIpcMock(electronApp, prNumber) {
  await electronApp.evaluate(
    ({ ipcMain }, { repoId, prNumber: queuedPrNumber }) => {
      const calls = [];
      globalThis.__CANOPY_E2E_PR_ACTION_CALLS__ = calls;
      const prUrl = `https://github.com/canopy-e2e/repo/pull/${queuedPrNumber}`;
      const verifiedRepo = {
        repoId,
        repoName: 'repo',
        prNumber: queuedPrNumber,
        prUrl,
        mergeable: true,
        unresolvedReviewThreadCount: 0,
      };

      ipcMain.removeHandler('github:merge-pr');
      ipcMain.handle('github:merge-pr', (_event, request) => {
        calls.push({ channel: 'github:merge-pr', request });
        return {
          dryRun: request.dryRun === true,
          verifiedRepos: [verifiedRepo],
          mergedRepos:
            request.dryRun === true
              ? []
              : [
                  {
                    repoId,
                    repoName: 'repo',
                    prNumber: queuedPrNumber,
                    prUrl,
                    mergeMethod: 'merge',
                    mergeCommitSha: null,
                    status: 'enqueued',
                    queuePosition: 2,
                  },
                ],
          requiresUnresolvedConfirmation: [],
          failedRepos: [],
        };
      });
    },
    { repoId: WORKSPACE_ID, prNumber },
  );
}

async function installControllableMultiRepoCheckIpcMock(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const calls = [];
    globalThis.__CANOPY_E2E_PR_ACTION_CALLS__ = calls;
    globalThis.__CANOPY_E2E_PENDING_MULTI_REPO_CHECK__ = undefined;

    ipcMain.removeHandler('github:merge-pr');
    ipcMain.handle('github:merge-pr', (_event, request) => {
      calls.push({ channel: 'github:merge-pr', request });
      if (!request.dryRun) {
        throw new Error('Expected a dry-run multi-repo check');
      }

      return new Promise((resolve, reject) => {
        globalThis.__CANOPY_E2E_PENDING_MULTI_REPO_CHECK__ = {
          resolve,
          reject,
        };
      });
    });
  });
}

async function settleMultiRepoCheck(electronApp, outcome) {
  await electronApp.evaluate((_electron, result) => {
    const pending = globalThis.__CANOPY_E2E_PENDING_MULTI_REPO_CHECK__;
    if (!pending) {
      throw new Error('No pending multi-repo check');
    }
    globalThis.__CANOPY_E2E_PENDING_MULTI_REPO_CHECK__ = undefined;

    if (result === 'reject') {
      pending.reject(new Error('GitHub check failed'));
      return;
    }

    pending.resolve({
      dryRun: true,
      verifiedRepos: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          prNumber: 901,
          prUrl: 'https://github.com/canopy-e2e/repo-a/pull/901',
          mergeable: true,
          unresolvedReviewThreadCount: 0,
        },
        {
          repoId: 'repo-b',
          repoName: 'Repo B',
          prNumber: 902,
          prUrl: 'https://github.com/canopy-e2e/repo-b/pull/902',
          mergeable: true,
          unresolvedReviewThreadCount: 0,
        },
      ],
      mergedRepos: [],
      requiresUnresolvedConfirmation: [],
      failedRepos: [],
    });
  }, outcome);
}

async function getPrActionIpcCalls(electronApp) {
  return electronApp.evaluate(
    () => globalThis.__CANOPY_E2E_PR_ACTION_CALLS__ ?? [],
  );
}

async function installPendingMergePrIpcMock(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const calls = [];
    globalThis.__CANOPY_E2E_PR_ACTION_CALLS__ = calls;
    globalThis.__CANOPY_E2E_RELEASE_MERGE_PR__ = undefined;

    ipcMain.removeHandler('github:merge-pr');
    ipcMain.removeHandler('github:cancel-git-action');
    ipcMain.handle('github:cancel-git-action', (_event, request) => {
      calls.push({ channel: 'github:cancel-git-action', request });
      return { accepted: true, reason: 'cancel_requested' };
    });
    ipcMain.handle('github:merge-pr', async (_event, request) => {
      calls.push({ channel: 'github:merge-pr', request });
      return await new Promise((resolve) => {
        globalThis.__CANOPY_E2E_RELEASE_MERGE_PR__ = () => {
          resolve({
            dryRun: false,
            verifiedRepos: [
              {
                repoId: 'demo-ts-pnpm-vite',
                repoName: 'repo',
                prNumber: 904,
                prUrl: 'https://github.com/canopy-e2e/repo/pull/904',
                mergeable: true,
                unresolvedReviewThreadCount: 0,
              },
            ],
            mergedRepos: [
              {
                repoId: 'demo-ts-pnpm-vite',
                repoName: 'repo',
                prNumber: 904,
                prUrl: 'https://github.com/canopy-e2e/repo/pull/904',
                mergeMethod: 'squash',
                mergeCommitSha: 'e2e-merge-sha',
                status: 'merged',
              },
            ],
            requiresUnresolvedConfirmation: [],
            failedRepos: [],
          });
        };
      });
    });
  });
}

async function installControllableUnresolvedMergePrIpcMock(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const calls = [];
    let firstWarningReleased = false;
    globalThis.__CANOPY_E2E_PR_ACTION_CALLS__ = calls;
    globalThis.__CANOPY_E2E_RELEASE_UNRESOLVED_MERGE__ = undefined;

    const unresolvedResponse = {
      dryRun: false,
      verifiedRepos: [],
      mergedRepos: [],
      requiresUnresolvedConfirmation: [
        {
          repoId: 'demo-ts-pnpm-vite',
          repoName: 'repo',
          prNumber: 905,
          prUrl: 'https://github.com/canopy-e2e/repo/pull/905',
          unresolvedReviewThreadCount: 2,
        },
      ],
      failedRepos: [],
    };

    ipcMain.removeHandler('github:merge-pr');
    ipcMain.handle('github:merge-pr', (_event, request) => {
      calls.push({ channel: 'github:merge-pr', request });

      if (request.confirmUnresolvedComments) {
        return {
          dryRun: false,
          verifiedRepos: [],
          mergedRepos: [
            {
              repoId: 'demo-ts-pnpm-vite',
              repoName: 'repo',
              prNumber: 905,
              prUrl: 'https://github.com/canopy-e2e/repo/pull/905',
              mergeMethod: 'squash',
              mergeCommitSha: 'e2e-merge-sha',
              status: 'merged',
            },
          ],
          requiresUnresolvedConfirmation: [],
          failedRepos: [],
        };
      }

      if (firstWarningReleased) {
        return unresolvedResponse;
      }

      return new Promise((resolve) => {
        globalThis.__CANOPY_E2E_RELEASE_UNRESOLVED_MERGE__ = () => {
          firstWarningReleased = true;
          globalThis.__CANOPY_E2E_RELEASE_UNRESOLVED_MERGE__ = undefined;
          resolve(unresolvedResponse);
        };
      });
    });
  });
}

async function releaseUnresolvedMergePr(electronApp) {
  await electronApp.evaluate(() => {
    const release = globalThis.__CANOPY_E2E_RELEASE_UNRESOLVED_MERGE__;
    if (!release) {
      throw new Error('No pending unresolved-comment merge');
    }
    release();
  });
}

async function releasePendingMergePr(electronApp) {
  await electronApp.evaluate(() => {
    globalThis.__CANOPY_E2E_RELEASE_MERGE_PR__?.();
  });
}

async function injectMergePrProgress(electronApp, event) {
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) {
      throw new Error('No BrowserWindow available to receive merge progress');
    }
    windows[0].webContents.send('github:merge-pr-progress', payload);
  }, event);
}

async function clickInjectedPrStatusButton(
  electronApp,
  payload,
  button,
  { timeout = 10_000 } = {},
) {
  await expect
    .poll(
      async () => {
        await injectGithubPrStatus(electronApp, payload);
        try {
          await button.click({ timeout: 1_000 });
          return 'clicked';
        } catch {
          return 'retry';
        }
      },
      { timeout, intervals: [100, 250, 500] },
    )
    .toBe('clicked');
}

// ---------------------------------------------------------------------------
// PR 712 — Settings → Git agent-rebase toggle + model select, with persistence.
// ---------------------------------------------------------------------------

test.describe('Git settings — agent-rebase resolution toggle (PR 712)', () => {
  test('renders, flips, reveals the model select when enabled, and persists across relaunch', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-git-pr-'),
    );

    // ---- First launch: assert default-off, flip on via the UI. ----
    const first = await launchCanopy({ userDataDir });
    try {
      const win = await first.electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('git');

      const toggle = win.getByTestId('settings-git-agent-rebase-toggle');
      await expect(toggle).toBeVisible();

      // The toggle is a `role="switch"` button exposing `aria-checked`
      // (GitTab.tsx), not a native checkbox. Default is OFF
      // (`agentRebaseResolutionEnabled: false`), and the resolution-model
      // select is gated behind the enabled state, so it is absent while OFF.
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(
        win.getByTestId('settings-git-agent-rebase-model'),
      ).toHaveCount(0);

      // Flip ON through the UI only.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      // Enabling reveals the resolution-model select.
      const modelSelect = win.getByTestId('settings-git-agent-rebase-model');
      await expect(modelSelect).toBeVisible();
      // It defaults to the "Project default" sentinel (value "").
      await expect(modelSelect).toHaveValue('');

      // Flip OFF again and confirm the select disappears, then ON to persist.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(
        win.getByTestId('settings-git-agent-rebase-model'),
      ).toHaveCount(0);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(
        win.getByTestId('settings-git-agent-rebase-model'),
      ).toBeVisible();
    } finally {
      // Keep the data dir so the relaunch can read the persisted preference.
      await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
    }

    // ---- Relaunch (reuse userDataDir): assert the enabled state persisted. ----
    const second = await launchCanopy({ userDataDir });
    try {
      const win = await second.electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('git');

      const toggle = win.getByTestId('settings-git-agent-rebase-toggle');
      await expect(toggle).toBeVisible();
      // Persisted ON: the toggle is checked and the model select is shown.
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(
        win.getByTestId('settings-git-agent-rebase-model'),
      ).toBeVisible();
    } finally {
      await closeCanopy(second.electronApp, userDataDir, {
        keepUserData: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// PR-status-bar structure — primary action renders with the no-PR label.
// ---------------------------------------------------------------------------

test.describe('PR status bar structure (Spec 13)', () => {
  test('renders the bar and its primary "Commit, push & create PR" action for a dirty, origin-backed worktree (no click)', async () => {
    // Two-phase seeding: build an isolated CANOPY_DATA_DIR and seed the demo
    // `ts-pnpm-vite` workspace, then — before launching — attach a LOCAL bare
    // `origin` to the source repo (so `hasOriginRemote` is true from the
    // worktree's shared git config) and dirty the worktree checkout with one
    // untracked file (so `uncommittedChanges` is true). Together these drive
    // the single-repo action to `create-pr`, which renders
    // `pr-status-bar-primary-action`. No network and no push are involved.
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-prbar-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    const workspace = (seed.workspaces ?? []).find(
      (entry) => entry.id === WORKSPACE_ID,
    );
    expect(workspace).toBeTruthy();
    const repoPath = workspace.repoPath;
    const worktreePath = workspace.worktreePath;
    expect(repoPath).toBeTruthy();
    expect(worktreePath).toBeTruthy();

    // Attach a local bare repo as `origin` to the source repo. A git worktree
    // shares the parent repo's config, so `getRemoteUrl` resolves it from the
    // worktree path. This is purely local — nothing is ever pushed.
    const bareOriginPath = path.join(userDataDir, 'prbar-origin.git');
    execFileSync('git', ['init', '--bare', bareOriginPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync(
      'git',
      ['-C', repoPath, 'remote', 'add', 'origin', bareOriginPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    // Sanity: the worktree sees the origin URL.
    const originUrl = execFileSync(
      'git',
      ['-C', worktreePath, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8' },
    ).trim();
    expect(originUrl).toBe(bareOriginPath);

    // Dirty the worktree so `uncommittedChanges` becomes true on first refresh.
    writeFileSync(
      path.join(worktreePath, 'PR_BAR_DIRTY.txt'),
      'dirty for create-pr label\n',
      'utf8',
    );

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await expect(row).toBeVisible();

      // Selecting the worktree mounts ChatPanel, which renders PrStatusBar.
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // The PR status bar renders.
      const prBar = window.getByTestId('pr-status-bar');
      await expect(prBar).toBeVisible();

      // The primary action (Create PR CTA) renders. With origin + uncommitted
      // changes + no open PR, the single-repo action resolves to `create-pr`
      // and `getCreatePrActionName` returns the deterministic no-PR label
      // "Commit, push & create PR". We assert structure + label only and never
      // click it (a click would attempt a real push to the bare origin).
      //
      // Assert the ACCESSIBLE NAME, not the text: the button carries both
      // copies in the DOM and swaps them with a container query (`PR` when
      // the bar is tight, the full outcome above 640px), so `toHaveText`
      // reads the concatenation "PRCreate PR" and would depend on the E2E
      // window width. The accessible name stays the full action either way.
      const primaryAction = window.getByTestId('pr-status-bar-primary-action');
      await expect(primaryAction).toBeVisible({ timeout: 15_000 });
      await expect(primaryAction).toHaveAttribute(
        'aria-label',
        'Commit, push & create PR',
      );
      await expect(primaryAction).toContainText('Create PR');
      await expect(primaryAction).toBeEnabled();

      // Remote-backed repos must never gain the idle local-only "Commit"
      // button. That surface is allowed to mount only transiently while an
      // explicit commit-only operation is active (for example Branch from →
      // Commit first); the normal idle action remains the remote-aware CTA.
      await expect(prBar.getByTestId('pr-status-bar-local-commit')).toHaveCount(
        0,
      );
      await expect(
        prBar.getByRole('button', { name: 'Commit', exact: true }),
      ).toHaveCount(0);

      // DOCUMENTED LIMITATION (Spec 13 store-driven variants 823/737): the
      // label-variant assertions — "Push & create PR" for unpushed-only state,
      // and PR-badge clearing after a branch rename — require injecting
      // `githubStore` / `projectsStore` state via `window.evaluate`. Those
      // Zustand stores are not exposed on `window` in this renderer build, so
      // those variants are deferred to unit/RTL coverage rather than asserted
      // here with a fabricated state.
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // CAN-3053 attempt-2: the sidebar row's own creating chip
  // (`worktree-row-pr-creating`, `WorktreePrCreatingIndicator`,
  // `useGitHubStore.creatingPr`) turns out to be cheap to cover: with the
  // default preference (`reviewCommitMessage: false`), `createPr` sets
  // `creatingPr` SYNCHRONOUSLY, before any IPC round trip, then goes
  // straight to the ONE mockable `github:create-pr` call — no local
  // commit/push runs in the renderer action first, so mocking that single
  // handler (the same shape `installPendingMergePrIpcMock` uses for merge)
  // makes this deterministic without ever touching the bare origin.
  test('clicking "Commit, push & create PR" lights the sidebar row creating chip until the IPC call resolves', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-prcreating-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    const workspace = (seed.workspaces ?? []).find(
      (entry) => entry.id === WORKSPACE_ID,
    );
    expect(workspace).toBeTruthy();
    const repoPath = workspace.repoPath;
    const worktreePath = workspace.worktreePath;
    expect(repoPath).toBeTruthy();
    expect(worktreePath).toBeTruthy();

    const bareOriginPath = path.join(userDataDir, 'prcreating-origin.git');
    execFileSync('git', ['init', '--bare', bareOriginPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync(
      'git',
      ['-C', repoPath, 'remote', 'add', 'origin', bareOriginPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    writeFileSync(
      path.join(worktreePath, 'PR_CREATING_DIRTY.txt'),
      'dirty for create-pr chip\n',
      'utf8',
    );

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await expect(row).toBeVisible();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      await electronApp.evaluate(({ ipcMain }) => {
        globalThis.__CANOPY_E2E_RELEASE_CREATE_PR__ = undefined;
        ipcMain.removeHandler('github:create-pr');
        ipcMain.handle('github:create-pr', async () => {
          return await new Promise((resolve) => {
            globalThis.__CANOPY_E2E_RELEASE_CREATE_PR__ = () => {
              resolve({
                repos: [],
                skippedRepos: [],
                localOnlyCommittedRepos: [],
              });
            };
          });
        });
      });

      const primaryAction = window.getByTestId('pr-status-bar-primary-action');
      await expect(primaryAction).toBeVisible({ timeout: 15_000 });
      await expect(primaryAction).toHaveAttribute(
        'aria-label',
        'Commit, push & create PR',
      );
      await primaryAction.click();

      // The demo worktree keeps its default worktree-id branch name
      // (`demo-main`), so the click first raises `BranchNotRenamedWarning`
      // ("Branch not renamed") before `createPr` runs. Dismiss it — this is
      // a pre-flight confirmation, not part of the chip behavior itself.
      await window
        .getByRole('button', { name: 'Continue anyway' })
        .click({ timeout: 15_000 });

      const creatingChip = row.getByTestId('worktree-row-pr-creating');
      await expect(creatingChip).toBeVisible({ timeout: 15_000 });

      await electronApp.evaluate(() => {
        globalThis.__CANOPY_E2E_RELEASE_CREATE_PR__?.();
      });
      await expect(creatingChip).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// ---------------------------------------------------------------------------
// PR-status surfaces driven by the `injectGithubPrStatus` IPC seam
// (Spec 13 — PRs 823 / 737 / 735). Seeds a `ts-pnpm-vite` worktree, selects it,
// then emits `github:pr-status-event`s on the exact channel the main-process PR
// poller broadcasts on, and asserts the PR badge / bar / sidebar surfaces.
// No GitHub remote, token, poll, or push is involved.
// ---------------------------------------------------------------------------

const WORKTREE_ID = 'demo-main';

/**
 * Seed an isolated data dir with the `ts-pnpm-vite` demo workspace, launch the
 * app, open the main page, and select the `demo-main` worktree (mounting
 * `ChatPanel` → `PrStatusBar`). Returns the launch handles plus the driver and
 * window so each test can inject and assert.
 */
async function launchWithSelectedWorktree({
  apps = ['ts-pnpm-vite'],
  branchGroupingParentWorktreeId,
  trackedBaseBranch,
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-prstatus-'),
  );
  seedDemoWorkspaces({ userDataDir, apps });

  // The drift warning is reserved for a base the user explicitly persisted.
  // The demo seed writes `trackedBaseBranch: 'main'`, so pass `null` to model
  // a worktree whose displayed base is only the derived repo-default guess —
  // the case the bar now realigns to the PR silently.
  if (
    trackedBaseBranch !== undefined ||
    branchGroupingParentWorktreeId !== undefined
  ) {
    const worktreesPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktrees.json',
    );
    const worktreesConfig = JSON.parse(readFileSync(worktreesPath, 'utf8'));
    worktreesConfig.worktrees = worktreesConfig.worktrees.map((worktree) => {
      if (worktree.id !== WORKTREE_ID) return worktree;
      const withGrouping = {
        ...worktree,
        ...(branchGroupingParentWorktreeId !== undefined
          ? { branchGroupingParentWorktreeId }
          : {}),
      };
      if (trackedBaseBranch === null) {
        const { trackedBaseBranch: _dropped, ...rest } = withGrouping;
        return rest;
      }
      return trackedBaseBranch === undefined
        ? withGrouping
        : { ...withGrouping, trackedBaseBranch };
    });
    writeFileSync(worktreesPath, JSON.stringify(worktreesConfig, null, 2));
  }

  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);

  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();

  const row = window.locator(
    `[data-testid="worktree-row"][data-project-id="${WORKSPACE_ID}"][data-branch="${WORKTREE_BRANCH}"]`,
  );
  await expect(row).toBeVisible();

  await row.click();
  await expect(window.getByTestId('panel-content-chat')).toBeVisible();
  await expect(window.getByTestId('pr-status-bar')).toBeVisible();

  // These tests drive the PR store through the supported injection seam. Stop
  // foreground polling after selection so the remote-less demo worktree does
  // not clear a seeded status every ten seconds while a multi-step assertion
  // is interacting with it. A selection-triggered refresh may still be in
  // flight, which the injection helpers below retry conditionally.
  await window.evaluate(async () => {
    await window.api.github.setForegroundWorktree({
      projectId: null,
      worktreeId: null,
    });
  });

  // Dropping the foreground slot is not enough: the diff-stats hydration that
  // follows selection re-registers the worktree for PR polling
  // (`registerPrPolling` → `github:request-refresh`), and the resulting real
  // poll of the remote-less demo repo lands roughly half a second later,
  // clearing whatever status a test injected in the meantime. The multi-step
  // base-branch flows below cannot re-inject between every interaction, so
  // pin the seeded status with the E2E-only seam the split-PR spec uses: a
  // suspended key stops being tracked and its live poll results are never
  // sent to the renderer, leaving `injectGithubPrStatus` authoritative.
  await electronApp.evaluate(
    ({ ipcMain }, { projectId, worktreeId }) => {
      const invoked = ipcMain.emit(
        'github:e2e-suspend-pr-status-tracking',
        {},
        { projectId, worktreeId },
      );
      if (invoked !== true) {
        throw new Error('Failed to suspend PR-status tracking');
      }
    },
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );

  return { electronApp, window, app, userDataDir };
}

async function expectInjectedPrStatusSurfaces(
  electronApp,
  window,
  payload,
  { prLabel, ciLabel, sidebarLabel, timeout = 20_000 },
) {
  const prBar = window.getByTestId('pr-status-bar');
  const sidebarBadge = window.getByTestId('worktree-row-pr-badge');

  // The selected worktree can have an in-flight fast PR refresh from focus or
  // visibility handling. Re-inject inside the poll so a racing live refresh that
  // clears the store is retried away, matching other E2E snapshot seams.
  await expect
    .poll(
      async () => {
        await injectGithubPrStatus(electronApp, payload);
        const [barPrVisible, ciVisible, sidebarVisible, sidebarText] =
          await Promise.all([
            prBar
              .getByText(prLabel)
              .isVisible()
              .catch(() => false),
            ciLabel
              ? prBar
                  .getByRole('img', { name: ciLabel })
                  .isVisible()
                  .catch(() => false)
              : Promise.resolve(true),
            sidebarBadge.isVisible().catch(() => false),
            sidebarBadge.textContent({ timeout: 0 }).catch(() => null),
          ]);

        return {
          barPrVisible,
          ciVisible,
          sidebarVisible,
          sidebarText: sidebarText?.trim() ?? null,
        };
      },
      { timeout },
    )
    .toEqual({
      barPrVisible: true,
      ciVisible: true,
      sidebarVisible: true,
      sidebarText: sidebarLabel,
    });
}

async function expectInjectedPrStatusHover(
  electronApp,
  payload,
  target,
  assertHoveredState,
) {
  // Treat the injection and hover as one retryable interaction. The selected
  // worktree can still have an intentional live refresh in flight after the
  // visibility poll above; if it clears the remote-less demo status between
  // locating and hovering, re-inject and retry against the fresh element.
  await expect(async () => {
    await injectGithubPrStatus(electronApp, payload);
    await target.hover({ timeout: 2_000 });
    await assertHoveredState();
  }).toPass({ timeout: 20_000 });
}

test.describe('PR status surfaces via injectGithubPrStatus (Spec 13)', () => {
  test('done worktree status label is Done until a merged PR status is confirmed', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-prstatus-done-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    const worktreesPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktrees.json',
    );
    const worktreesConfig = JSON.parse(readFileSync(worktreesPath, 'utf8'));
    worktreesConfig.worktrees = worktreesConfig.worktrees.map((worktree) =>
      worktree.id === WORKTREE_ID
        ? { ...worktree, status: 'done', lastKnownPrStatus: null }
        : worktree,
    );
    writeFileSync(worktreesPath, JSON.stringify(worktreesConfig, null, 2));

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await expect(row).toBeVisible();
      await expect(row.getByText('Done', { exact: true })).toBeVisible();
      await expect(row.getByText('PR merged', { exact: true })).toHaveCount(0);

      await injectGithubPrStatus(
        electronApp,
        buildPrStatusEvent({
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: buildPrStatusData({
                prNumber: 985,
                state: 'merged',
              }),
            },
          ],
        }),
      );

      await expect(row.getByText('PR merged', { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(row.getByText('Done', { exact: true })).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('823 — injecting an open PR lights the PR-status bar badge and the sidebar PR badge', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      // Inject a single-repo OPEN PR #823. The store reducer keys this under
      // `demo-ts-pnpm-vite/demo-main` and mirrors it onto the worktree's
      // `lastKnownPrStatus`, lighting both the bar badge and the sidebar badge.
      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        kind: 'open-pr',
        prNumber: 823,
      });

      // Bar: the single-repo `PrStateBadge` renders a state-coloured glyph
      // plus `#823` (the redundant "PR" word lives in the icon now), and the
      // `CheckStatusBadge` renders a state dot plus `CI`, whose accessible
      // name carries the deterministic passing label `CI passing` (open-pr
      // fixture defaults to `checkStatus: 'passing'`).
      // Sidebar: the worktree row PR badge is unchanged and lights with
      // `PR #823`.
      await expectInjectedPrStatusSurfaces(electronApp, window, statusEvent, {
        prLabel: '#823',
        ciLabel: 'CI passing',
        sidebarLabel: 'PR #823',
      });

      const prBar = window.getByTestId('pr-status-bar');
      const prTooltip = window.getByTestId('pr-status-bar-pr-tooltip');
      await expectInjectedPrStatusHover(
        electronApp,
        statusEvent,
        prBar.getByText('#823', { exact: true }),
        async () => {
          await expect(prTooltip).toBeVisible();
          await expect(prTooltip).toContainText('PR #823');
          await expect(prTooltip).toContainText('CI checks: Passing');
        },
      );

      // The canonical open-PR fixture has no per-check details. The aggregate
      // CI badge still renders, but hovering it must not mount an empty popover.
      const ciBadge = prBar.getByTestId('pr-status-bar-ci-badge');
      await expectInjectedPrStatusHover(
        electronApp,
        statusEvent,
        ciBadge,
        async () => {
          await expect(ciBadge).toBeVisible();
          await expect(
            window.getByTestId('pr-status-bar-ci-popover'),
          ).toHaveCount(0);
        },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('PR status glyphs render the official Octicons on the bar and the sidebar row', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      const prBar = window.getByTestId('pr-status-bar');
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      const statusEvent = (status) =>
        buildPrStatusEvent({
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          repos: [{ repoId: WORKSPACE_ID, repoName: 'repo', status }],
        });
      const glyphOf = (locator) =>
        locator
          .locator('svg[data-app-icon="true"]')
          .first()
          .getAttribute('data-glyph', { timeout: 1_000 })
          .catch(() => null);
      // Re-inject inside the poll so a racing live refresh that clears the
      // store is retried away, as `expectInjectedPrStatusSurfaces` does.
      const expectGlyphs = async (payload, read, expected) => {
        await expect
          .poll(
            async () => {
              await injectGithubPrStatus(electronApp, payload);
              return read();
            },
            { timeout: 20_000 },
          )
          .toEqual(expected);
      };

      // Open PR: the bar's state badge leads with the pull request Octicon.
      await expectGlyphs(
        statusEvent(buildPrStatusData({ prNumber: 823 })),
        async () => ({
          bar: await glyphOf(prBar.getByLabel('Pull request #823 (open)')),
        }),
        { bar: 'git-pull-request' },
      );

      // Queued PR: the bar's merge queue control and the sidebar row's queue
      // chip both draw the merge queue Octicon, not the merged one.
      await expectGlyphs(
        statusEvent({
          ...buildPrStatusData({ prNumber: 823 }),
          mergeQueue: {
            required: true,
            inQueue: true,
            position: 2,
            phase: 'queued',
          },
        }),
        async () => ({
          bar: await glyphOf(prBar.getByTestId('pr-status-bar-merge-queue')),
          row: await glyphOf(row.getByTestId('worktree-row-pr-merge-queue')),
        }),
        { bar: 'git-merge-queue', row: 'git-merge-queue' },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('warns when the tracked base drifts from the PR and aligns it after confirmation', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree({ trackedBaseBranch: 'main' });
    try {
      await expect(
        window
          .getByTestId('pr-status-bar')
          .getByRole('button', { name: 'main', exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: {
              ...buildPrStatusData({ prNumber: 9091 }),
              baseRefName: 'release/next',
            },
          },
        ],
      });
      const warning = window.getByTestId('pr-status-base-branch-drift-warning');

      await expect
        .poll(async () => {
          await injectGithubPrStatus(electronApp, statusEvent);
          return warning.isVisible().catch(() => false);
        })
        .toBe(true);

      await warning.hover();
      const tooltip = window.getByTestId('pr-status-base-branch-drift-tooltip');
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText('Base branch drift');
      await expect(tooltip).toContainText('main');
      await expect(tooltip).toContainText('PR #9091');
      await expect(tooltip).toContainText('release/next');

      await warning.click();
      const modal = window.getByTestId('pr-status-base-branch-drift-modal');
      await expect(modal).toBeVisible();
      await expect(modal).toContainText('Align base branch with PR?');
      await expect(modal).toContainText('release/next');

      // A same-count replacement must invalidate the captured confirmation;
      // otherwise confirming would write the stale release/next target after
      // GitHub had already reported a different PR base.
      await injectGithubPrStatus(
        electronApp,
        buildPrStatusEvent({
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: {
                ...buildPrStatusData({ prNumber: 9091 }),
                baseRefName: 'release/hotfix',
              },
            },
          ],
        }),
      );
      await expect(modal).toHaveCount(0);
      await expect(warning).toBeVisible();

      await injectGithubPrStatus(electronApp, statusEvent);
      await expect(warning).toBeVisible();
      await warning.click();
      await expect(modal).toBeVisible();

      await injectGithubPrStatus(
        electronApp,
        buildPrStatusEvent({
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: {
                ...buildPrStatusData({ prNumber: 9091 }),
                baseRefName: 'main',
              },
            },
          ],
        }),
      );
      await expect(modal).toHaveCount(0);

      await injectGithubPrStatus(electronApp, statusEvent);
      await expect(warning).toBeVisible();
      await expect(modal).toHaveCount(0);

      await warning.click();
      await expect(modal).toBeVisible();

      await window.getByTestId('pr-status-base-branch-drift-confirm').click();
      await expect(warning).toHaveCount(0);
      await expect(modal).toHaveCount(0);
      await expect(
        window
          .getByTestId('pr-status-bar')
          .getByRole('button', { name: 'release/next' }),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('adopts the PR base with no warning when no base was ever tracked', async () => {
    // The seeded `trackedBaseBranch` is stripped, so the bar's `main` is the derived
    // repo-default guess rather than a user choice. A PR that targets a
    // different branch is then simply the better answer: the bar adopts it
    // and persists it, instead of asking the user to confirm a base they
    // never picked.
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree({
        trackedBaseBranch: null,
        branchGroupingParentWorktreeId: 'merged-parent',
      });
    try {
      const prBar = window.getByTestId('pr-status-bar');
      await expect(
        prBar.getByRole('button', { name: 'main', exact: true }),
      ).toBeVisible({ timeout: 20_000 });

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: {
              ...buildPrStatusData({ prNumber: 9093 }),
              baseRefName: 'release/next',
            },
          },
        ],
      });

      await expect
        .poll(async () => {
          await injectGithubPrStatus(electronApp, statusEvent);
          return prBar
            .getByText('#9093', { exact: true })
            .isVisible()
            .catch(() => false);
        })
        .toBe(true);

      // The PR's base is adopted silently: the header follows it and neither
      // the warning nor the confirmation modal ever appears.
      await expect(
        prBar.getByRole('button', { name: 'release/next' }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        window.getByTestId('pr-status-base-branch-drift-warning'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('pr-status-base-branch-drift-modal'),
      ).toHaveCount(0);

      // The adoption is durable, written through the targeted tracked-base
      // channel rather than a wholesale renderer snapshot.
      const worktreesPath = path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'worktrees.json',
      );
      await expect
        .poll(() => {
          const config = JSON.parse(readFileSync(worktreesPath, 'utf8'));
          return config.worktrees.find(
            (worktree) => worktree.id === WORKTREE_ID,
          )?.trackedBaseBranch;
        })
        .toBe('release/next');
      const persistedWorktree = JSON.parse(
        readFileSync(worktreesPath, 'utf8'),
      ).worktrees.find((worktree) => worktree.id === WORKTREE_ID);
      expect(persistedWorktree.branchGroupingParentWorktreeId).toBeUndefined();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('does not flash the drift warning while an approved PR base update refreshes', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('worktree:list-branches');
        ipcMain.handle('worktree:list-branches', () => ({
          branches: [
            {
              name: 'main',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
            {
              name: 'release/next',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
          ],
          defaultBranch: 'main',
        }));

        ipcMain.removeHandler('github:update-pr-base-branch');
        globalThis.__CANOPY_E2E_PR_BASE_UPDATE_CALLS__ = [];
        globalThis.__CANOPY_E2E_RESOLVE_PR_BASE_UPDATE__ = null;
        ipcMain.handle('github:update-pr-base-branch', (_event, request) => {
          globalThis.__CANOPY_E2E_PR_BASE_UPDATE_CALLS__.push(request);
          return new Promise((resolve) => {
            globalThis.__CANOPY_E2E_RESOLVE_PR_BASE_UPDATE__ = resolve;
          });
        });
      });

      const initialStatusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: {
              ...buildPrStatusData({ prNumber: 9092 }),
              baseRefName: 'main',
            },
          },
        ],
      });
      await expect
        .poll(async () => {
          await injectGithubPrStatus(electronApp, initialStatusEvent);
          return window
            .getByTestId('pr-status-bar')
            .getByText('#9092', { exact: true })
            .isVisible()
            .catch(() => false);
        })
        .toBe(true);

      const prBar = window.getByTestId('pr-status-bar');
      await prBar.getByRole('button', { name: 'main', exact: true }).click();
      const nextBaseOption = window
        .getByTestId('pr-status-base-branch-menu')
        .locator('[data-branch-name="release/next"]');
      await expect(nextBaseOption).toBeVisible();
      // A selection-triggered poll may still clear the injected status while
      // the picker loads. Re-inject immediately before selecting so the click
      // deterministically takes the open-PR confirmation path.
      await injectGithubPrStatus(electronApp, initialStatusEvent);
      await expect(prBar.getByText('#9092', { exact: true })).toBeVisible();
      await nextBaseOption.click();

      await expect(
        window.getByRole('heading', { name: 'Update PR base branch?' }),
      ).toBeVisible();
      await window.getByRole('button', { name: 'Yes, update PR' }).click();

      await expect(
        prBar.getByRole('button', { name: 'release/next', exact: true }),
      ).toBeVisible();
      // Keep the stale PR target visible while the mocked GitHub update is
      // pending. The old implementation rendered the warning at this point.
      await injectGithubPrStatus(electronApp, initialStatusEvent);
      await expect(prBar.getByText('#9092', { exact: true })).toBeVisible();
      await expect(
        window.getByTestId('pr-status-base-branch-drift-warning'),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__CANOPY_E2E_PR_BASE_UPDATE_CALLS__.length,
          ),
        )
        .toBe(1);

      await electronApp.evaluate(() => {
        globalThis.__CANOPY_E2E_RESOLVE_PR_BASE_UPDATE__?.({
          success: true,
          prUrl: 'https://github.com/canopy-e2e/repo/pull/9092',
        });
      });
      await expect(
        window.getByTestId('pr-status-base-branch-drift-warning'),
      ).toHaveCount(0);

      await expect
        .poll(async () => {
          await injectGithubPrStatus(
            electronApp,
            buildPrStatusEvent({
              projectId: WORKSPACE_ID,
              worktreeId: WORKTREE_ID,
              repos: [
                {
                  repoId: WORKSPACE_ID,
                  repoName: 'repo',
                  status: {
                    ...buildPrStatusData({ prNumber: 9092 }),
                    baseRefName: 'release/hotfix',
                  },
                },
              ],
            }),
          );
          return window
            .getByTestId('pr-status-base-branch-drift-warning')
            .isVisible()
            .catch(() => false);
        })
        .toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('updates the PR base when GitHub status omits the previous base branch', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('worktree:list-branches');
        ipcMain.handle('worktree:list-branches', () => ({
          branches: [
            {
              name: 'main',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
            {
              name: 'release/next',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
          ],
          defaultBranch: 'main',
        }));

        ipcMain.removeHandler('github:update-pr-base-branch');
        globalThis.__CANOPY_E2E_PR_BASE_UPDATE_CALLS__ = [];
        ipcMain.handle('github:update-pr-base-branch', (_event, request) => {
          globalThis.__CANOPY_E2E_PR_BASE_UPDATE_CALLS__.push(request);
          return {
            success: true,
            prUrl: 'https://github.com/canopy-e2e/repo/pull/9093',
          };
        });
      });

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: buildPrStatusData({ prNumber: 9093 }),
          },
        ],
      });
      await expect
        .poll(async () => {
          await injectGithubPrStatus(electronApp, statusEvent);
          return window
            .getByTestId('pr-status-bar')
            .getByText('#9093', { exact: true })
            .isVisible()
            .catch(() => false);
        })
        .toBe(true);

      const prBar = window.getByTestId('pr-status-bar');
      await prBar.getByRole('button', { name: 'main', exact: true }).click();
      const nextBaseOption = window
        .getByTestId('pr-status-base-branch-menu')
        .locator('[data-branch-name="release/next"]');
      await expect(nextBaseOption).toBeVisible();
      await injectGithubPrStatus(electronApp, statusEvent);
      await nextBaseOption.click();
      await window.getByRole('button', { name: 'Yes, update PR' }).click();

      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__CANOPY_E2E_PR_BASE_UPDATE_CALLS__,
          ),
        )
        .toEqual([
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            prNumber: 9093,
            newBaseBranch: 'release/next',
          },
        ]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('sidebar approval warning follows unresolved review threads, not total comments', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      const resolvedFeedback = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: {
              ...mergeablePrStatus({
                prNumber: 824,
                unresolvedReviewThreadCount: 0,
              }),
              commentCount: 1,
            },
          },
        ],
      });
      const unresolvedFeedback = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: {
              ...mergeablePrStatus({
                prNumber: 824,
                unresolvedReviewThreadCount: 1,
              }),
              commentCount: 1,
            },
          },
        ],
      });
      const icon = window.getByTestId('worktree-row-pr-approved');

      await expectInjectedPrStatusSurfaces(
        electronApp,
        window,
        resolvedFeedback,
        {
          prLabel: '#824',
          ciLabel: 'CI passing',
          sidebarLabel: 'PR #824',
        },
      );
      await expect(icon).toHaveAttribute(
        'aria-label',
        'Approved and ready to merge',
      );

      await expectInjectedPrStatusSurfaces(
        electronApp,
        window,
        unresolvedFeedback,
        {
          prLabel: '#824',
          ciLabel: 'CI passing',
          sidebarLabel: 'PR #824',
        },
      );
      await expect(icon).toHaveAttribute(
        'aria-label',
        'Approved and ready to merge, with unresolved comments',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('CI badge hover shows seeded per-check details in a scrollable popover', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: {
              ...buildPrStatusData({
                prNumber: 824,
                checkStatus: 'failing',
              }),
              checkDetails: [
                {
                  name: 'lint',
                  status: 'pending',
                  detailsUrl: 'https://github.com/canopy-e2e/repo/actions/1',
                },
                {
                  name: 'build',
                  status: 'failing',
                  detailsUrl: 'https://github.com/canopy-e2e/repo/actions/2',
                },
                {
                  name: 'unit-tests',
                  status: 'passing',
                  detailsUrl: 'https://github.com/canopy-e2e/repo/actions/3',
                },
              ],
            },
          },
        ],
      });

      await expectInjectedPrStatusSurfaces(electronApp, window, statusEvent, {
        prLabel: '#824',
        ciLabel: 'CI failing',
        sidebarLabel: 'PR #824',
      });

      const ciBadge = window.getByTestId('pr-status-bar-ci-badge');
      const popover = window.getByTestId('pr-status-bar-ci-popover');
      await expectInjectedPrStatusHover(
        electronApp,
        statusEvent,
        ciBadge,
        async () => {
          await expect(popover).toBeVisible();
          await expect(popover).toContainText('Checks (1/3 passing)');
          await expect(popover).toContainText('lint');
          await expect(popover).toContainText('build');
          await expect(popover).toContainText('unit-tests');
          await expect(popover.locator('.overflow-y-auto')).toBeVisible();
        },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('multi-repo PR and CI tooltips keep the PR list open when returning from nested CI details', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: 'repo-app',
            repoName: 'App',
            status: {
              ...buildPrStatusData({
                prNumber: 825,
                checkStatus: 'failing',
              }),
              title: 'Ship the app tooltip',
              body: 'App-specific pull request details.',
              checkDetails: [
                {
                  name: 'app-build',
                  status: 'failing',
                  detailsUrl:
                    'https://github.com/canopy-e2e/app/actions/runs/825',
                },
              ],
            },
          },
          {
            repoId: 'repo-docs',
            repoName: 'Docs',
            status: buildPrStatusData({
              prNumber: 826,
              checkStatus: 'passing',
            }),
          },
        ],
      });

      await expectInjectedPrStatusSurfaces(electronApp, window, statusEvent, {
        prLabel: '2 PRs',
        ciLabel: 'CI failing',
        sidebarLabel: 'PR #825',
      });

      // Keep the whole multi-step hover interaction inside the same supported
      // injection retry boundary as the simpler tooltip checks above. The
      // selection-triggered GitHub refresh can still complete after foreground
      // polling is disabled and clear this remote-less fixture exactly once.
      await expect(async () => {
        await injectGithubPrStatus(electronApp, statusEvent);
        const prListBadge = window
          .getByTestId('pr-status-bar')
          .getByText('2 PRs');
        await prListBadge.hover({ timeout: 2_000 });
        const prListPopover = window.getByTestId('pr-status-bar-repo-popover');
        await expect(prListPopover).toBeVisible({ timeout: 2_000 });
        await expect(prListPopover.getByText('App')).toBeVisible();
        await expect(prListPopover.getByText('Docs')).toBeVisible();

        await prListPopover.getByText('#825', { exact: true }).hover();
        const prTooltip = window.getByTestId(
          'pr-status-bar-repo-pr-tooltip-repo-app',
        );
        await expect(prTooltip).toBeVisible();
        await expect(prTooltip).toContainText('Ship the app tooltip');
        await expect(prTooltip).toContainText(
          'App-specific pull request details.',
        );

        const ciBadge = window.getByTestId(
          'pr-status-bar-repo-ci-badge-repo-app',
        );
        await ciBadge.hover();
        const ciPopover = window.getByTestId(
          'pr-status-bar-repo-ci-popover-repo-app',
        );
        await expect(ciPopover).toBeVisible();
        await expect(ciPopover).toContainText('Checks (0/1 passing)');
        await expect(ciPopover).toContainText('app-build');

        // Return to an actual row in the parent surface. Hovering an arbitrary
        // wrapper coordinate can land on the transparent bridge when the
        // collision layer places the popover above its trigger.
        await prListPopover.getByText('App').hover();
        await expect(ciPopover).toHaveCount(0, { timeout: 2_000 });
        await window.waitForTimeout(300);
        await expect(prListPopover).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('737 (open→none half) — injecting a no-PR status clears both PR badge surfaces', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      // First inject an open PR so both surfaces light…
      const openStatusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        kind: 'open-pr',
        prNumber: 823,
      });
      const prBar = window.getByTestId('pr-status-bar');
      await expectInjectedPrStatusSurfaces(
        electronApp,
        window,
        openStatusEvent,
        {
          prLabel: '#823',
          ciLabel: 'CI passing',
          sidebarLabel: 'PR #823',
        },
      );

      // …then inject the no-PR status. `deriveAggregatedStatus` reports
      // `hasPr: false`, so the bar's single-repo PR badge unmounts, and the
      // sidebar `lastKnownPrStatus` resolves to no open repo → badge absent.
      await injectGithubPrStatus(
        electronApp,
        buildPrStatusEvent({
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          kind: 'no-pr',
        }),
      );

      await expect(prBar.getByText('#823', { exact: true })).toHaveCount(0, {
        timeout: 10_000,
      });
      await expect(window.getByTestId('worktree-row-pr-badge')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('735 — injecting a stale-after-rename PR keeps the PR visible with a failing-check signal', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      // The stale-after-rename fixture models a still-OPEN PR (#735) that points
      // at the now-renamed head branch: `state: 'open'`, `checkStatus:
      // 'failing'`, `hasConflicts: true`. The PR object still exists, so the bar
      // keeps surfacing it — with a failing-check signal — rather than clearing.
      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        kind: 'stale-after-rename',
        prNumber: 735,
      });

      // PR still open and visible after the (modeled) rename.
      // The stale/conflict state surfaces as a failing CI badge in the bar;
      // the CI dot badge carries `CI failing` as its
      // accessible name.
      // Sidebar badge also reflects the still-open PR.
      await expectInjectedPrStatusSurfaces(electronApp, window, statusEvent, {
        prLabel: '#735',
        ciLabel: 'CI failing',
        sidebarLabel: 'PR #735',
      });

      // DOCUMENTED LIMITATION: the "Merge conflict." detail card
      // (`hasConflicts`) renders in the collapsible activity-panel
      // `PullRequestSection` (`SingleRepoDetail`), not the always-visible bar,
      // so it is not asserted here. The branch-rename WARNING itself (718) is
      // `projectsStore`-derived and not drivable through this PR-status channel.
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('merge PR button opens the unresolved-comments modal and confirms through merge IPC', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await installPrActionIpcMocks(electronApp);

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: mergeablePrStatus({
              prNumber: 901,
              unresolvedReviewThreadCount: 2,
            }),
          },
        ],
      });
      const mergeButton = window.getByTestId('pr-status-bar-merge-pr');
      await expect(async () => {
        await injectGithubPrStatus(electronApp, statusEvent);
        await expect(mergeButton).toBeVisible({ timeout: 2_000 });
        await expect(mergeButton).toHaveClass(/(^|\s)fg-warning(\s|$)/);
        // CAN-2799: the unresolved-comment warning is a rich hover tooltip,
        // not a native `title`.
        await expect(mergeButton).not.toHaveAttribute('title', /.+/);
        await mergeButton.hover();
        await expect(window.getByRole('tooltip')).toHaveText(
          'This PR has unresolved comments or an unknown review thread state',
          { timeout: 2_000 },
        );
        await window.mouse.move(0, 0);
      }).toPass({ timeout: 20_000 });

      await clickInjectedPrStatusButton(electronApp, statusEvent, mergeButton);
      const warning = window.getByTestId('pr-merge-warning-modal');
      await expect(warning).toBeVisible();
      await expect(warning.getByText('2 unresolved comments')).toBeVisible();
      await expect(window.getByTestId('pr-merge-warning-triage')).toBeVisible();

      await window.getByTestId('pr-merge-warning-confirm').click();
      await expect(warning).toHaveCount(0);

      const calls = await getPrActionIpcCalls(electronApp);
      const mergeCalls = calls.filter(
        (call) => call.channel === 'github:merge-pr',
      );
      expect(mergeCalls).toHaveLength(2);
      expect(mergeCalls[0].request).toMatchObject({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        confirmUnresolvedComments: false,
      });
      expect(mergeCalls[1].request).toMatchObject({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        confirmUnresolvedComments: true,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('REG-3025 — the shared header keeps a waiting Merge in place, unavailable with its reason', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await installPrActionIpcMocks(electronApp);
      const status = (overrides) =>
        buildPrStatusEvent({
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: { ...mergeablePrStatus({ prNumber: 907 }), ...overrides },
            },
          ],
        });
      const mergeButton = window.getByTestId('pr-status-bar-merge-pr');

      // A check still runs: Merge stays in the header, unavailable, and says
      // why on hover (it used to disappear). A click merges nothing.
      const running = status({
        checkStatus: 'pending',
        mergeableState: 'unstable',
        checkDetails: [
          {
            name: 'test',
            status: 'pending',
            url: 'https://github.com/canopy-e2e/repo/actions/runs/907',
          },
        ],
      });
      await expect(async () => {
        await injectGithubPrStatus(electronApp, running);
        await expect(mergeButton).toHaveAttribute('aria-disabled', 'true', {
          timeout: 1_000,
        });
      }).toPass({ timeout: 20_000 });
      await mergeButton.hover();
      await expect(
        window.getByRole('tooltip').filter({ visible: true }),
      ).toHaveText('Wait for the checks to finish to merge.');
      // Playwright waits for an aria-disabled control to become enabled;
      // force the click to prove that clicking it does nothing.
      await mergeButton.click({ force: true });
      expect(
        (await getPrActionIpcCalls(electronApp)).filter(
          (call) => call.channel === 'github:merge-pr',
        ),
      ).toEqual([]);

      // The checks pass: the same Merge becomes available.
      await expect(async () => {
        await injectGithubPrStatus(electronApp, status({}));
        await expect(mergeButton).not.toHaveAttribute('aria-disabled', 'true', {
          timeout: 1_000,
        });
      }).toPass({ timeout: 20_000 });
      await expect(mergeButton).toHaveText('Merge');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('CAN-3707 — Merge on a merge-queue branch reports the enqueue and shows the queued state', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await installEnqueueMergePrIpcMock(electronApp, 905);

      const mergeableEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: {
              ...mergeablePrStatus({ prNumber: 905 }),
              mergeQueue: { required: true, inQueue: false },
            },
          },
        ],
      });
      const mergeButton = window.getByTestId('pr-status-bar-merge-pr');
      await clickInjectedPrStatusButton(
        electronApp,
        mergeableEvent,
        mergeButton,
      );
      await expect(
        window.getByText('Added 1 pull request to the merge queue.'),
      ).toBeVisible({ timeout: 10_000 });
      await expect(window.getByText(/^Merged \d+ pull request/)).toHaveCount(0);

      const calls = await getPrActionIpcCalls(electronApp);
      expect(
        calls.some(
          (call) =>
            call.channel === 'github:merge-pr' && call.request.dryRun !== true,
        ),
      ).toBe(true);

      // The refreshed status reports the PR in the queue: Merge gives way to
      // the queue label, and the sidebar badge swaps its approval check for
      // the queue glyph.
      const queuedEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: {
              ...mergeablePrStatus({ prNumber: 905 }),
              mergeableState: 'blocked',
              mergeQueue: { required: true, inQueue: true, position: 2 },
            },
          },
        ],
      });
      const queueStatus = window.getByTestId('pr-status-bar-merge-queue');
      const queueGlyph = window.getByTestId('worktree-row-pr-merge-queue');
      await expect(async () => {
        await injectGithubPrStatus(electronApp, queuedEvent);
        await expect(queueStatus).toHaveAttribute(
          'aria-label',
          'Queued in the merge queue, position 2',
          { timeout: 1_000 },
        );
        await expect(mergeButton).toHaveCount(0, { timeout: 1_000 });
        await expect(queueGlyph).toHaveAttribute(
          'aria-label',
          'In merge queue, position 2',
          { timeout: 1_000 },
        );
      }).toPass({ timeout: 20_000 });
      await expect(window.getByTestId('worktree-row-pr-approved')).toHaveCount(
        0,
      );
      await expect(
        window.getByTestId('pr-status-bar').getByText('#905', { exact: true }),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test("a queued PR shows GitHub's estimate and opens the queue list", async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      const prNumber = 907;
      await electronApp.evaluate(
        ({ ipcMain }, { mine }) => {
          const calls = [];
          globalThis.__CANOPY_E2E_MERGE_QUEUE_CALLS__ = calls;
          const pr = (number, title, author) => ({
            number,
            title,
            url: `https://github.com/canopy-e2e/repo/pull/${number}`,
            author,
          });
          ipcMain.removeHandler('github:get-merge-queue');
          ipcMain.handle('github:get-merge-queue', (_event, request) => {
            calls.push(request);
            return {
              queue: {
                url: 'https://github.com/canopy-e2e/repo/queue/main',
                baseBranch: 'main',
                totalCount: 6,
                maximumEntriesToBuild: 2,
                fetchedAt: new Date().toISOString(),
                entries: [
                  [
                    'awaiting_checks',
                    240,
                    pr(901, 'Bound Git reads', 'river-ops'),
                  ],
                  [
                    'awaiting_checks',
                    480,
                    pr(902, 'Open Create a team', 'mara-k'),
                  ],
                  [
                    'queued',
                    1140,
                    pr(mine, 'Adopt the catalog rows', 'sam-lee'),
                  ],
                  ['queued', 1380, pr(903, 'Keep chat titles short', 'mara-k')],
                  ['queued', 1620, pr(904, 'Suggest automations', 'river-ops')],
                  [
                    'queued',
                    1860,
                    pr(905, 'Choose the proxy order', 'jo-park'),
                  ],
                ].map(
                  ([phase, estimatedSecondsToMerge, pullRequest], index) => ({
                    position: index + 1,
                    phase,
                    estimatedSecondsToMerge,
                    enqueuedAt: null,
                    pullRequest,
                  }),
                ),
              },
            };
          });
        },
        { mine: prNumber },
      );

      const queuedEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: {
              ...mergeablePrStatus({ prNumber }),
              mergeableState: 'blocked',
              baseRefName: 'main',
              mergeQueue: {
                required: true,
                inQueue: true,
                position: 3,
                phase: 'queued',
                estimatedSecondsToMerge: 19 * 60,
                observedAt: new Date().toISOString(),
              },
            },
          },
        ],
      });
      const label = window.getByTestId('pr-status-bar-merge-queue');
      await expect(async () => {
        await injectGithubPrStatus(electronApp, queuedEvent);
        await expect(label).toHaveAttribute(
          'aria-label',
          /^Queued in the merge queue, position 3, about (19|18) min$/,
          { timeout: 1_000 },
        );
      }).toPass({ timeout: 20_000 });
      await expect(
        window.getByTestId('pr-status-bar-merge-queue-eta'),
      ).toHaveText(/^~(19|18) min$/);
      await expect(label).toHaveAttribute('aria-expanded', 'false');
      // The queue is read only once the popover opens.
      expect(
        await electronApp.evaluate(
          () => globalThis.__CANOPY_E2E_MERGE_QUEUE_CALLS__.length,
        ),
      ).toBe(0);

      await label.click();
      const popover = window.getByTestId('pr-status-bar-merge-queue-popover');
      await expect(popover).toBeVisible();
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(label).toHaveAttribute('aria-expanded', 'true');
      expect(
        await electronApp.evaluate(
          () => globalThis.__CANOPY_E2E_MERGE_QUEUE_CALLS__,
        ),
      ).toEqual([{ repository: 'canopy-e2e/repo', baseBranch: 'main' }]);
      await expect(popover.getByText('6 pull requests')).toBeVisible();
      await expect(popover.getByText('2 at a time')).toBeVisible();
      const rows = popover.getByTestId('merge-queue-popover-row');
      // Two testing, then this pull request and the two after it.
      await expect(rows).toHaveCount(5);
      const mine = popover.locator(
        '[data-testid="merge-queue-popover-row"][aria-current="true"]',
      );
      await expect(mine).toContainText('This pull request');
      await expect(mine).toHaveAttribute(
        'href',
        `https://github.com/canopy-e2e/repo/pull/${prNumber}`,
      );
      await popover.getByTestId('merge-queue-popover-show-more').click();
      await expect(rows).toHaveCount(6);
      await expect(
        popover.getByTestId('merge-queue-popover-github'),
      ).toHaveAttribute(
        'href',
        'https://github.com/canopy-e2e/repo/queue/main',
      );

      await window.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      await expect(label).toBeFocused();
      await expect(label).toHaveAttribute('aria-expanded', 'false');

      // The next poll, read after the list, moves the pull request into the
      // merge group, where GitHub often has no estimate yet. The label
      // follows the poll, not the closed list's "Queued · #3".
      await expect(async () => {
        await injectGithubPrStatus(
          electronApp,
          buildPrStatusEvent({
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            repos: [
              {
                repoId: WORKSPACE_ID,
                repoName: 'repo',
                status: {
                  ...mergeablePrStatus({ prNumber }),
                  mergeableState: 'blocked',
                  baseRefName: 'main',
                  mergeQueue: {
                    required: true,
                    inQueue: true,
                    position: 1,
                    phase: 'awaiting_checks',
                    observedAt: new Date().toISOString(),
                  },
                },
              },
            ],
          }),
        );
        await expect(label).toHaveAttribute(
          'aria-label',
          'Testing in the merge queue',
          { timeout: 1_000 },
        );
      }).toPass({ timeout: 20_000 });
      await expect(label).toHaveText('Testing');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('CAN-3780 — the PR tooltip follows the merge queue phase through dequeue, re-enqueue, and merge', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      const prNumber = 906;
      const statusEvent = (status) =>
        buildPrStatusEvent({
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          repos: [{ repoId: WORKSPACE_ID, repoName: 'repo', status }],
        });
      const queuedStatus = (mergeQueue) => ({
        ...mergeablePrStatus({ prNumber }),
        mergeableState: 'blocked',
        mergeQueue: { required: true, inQueue: true, ...mergeQueue },
      });
      const row = window.locator(
        `[data-testid="worktree-row"][data-project-id="${WORKSPACE_ID}"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      const badge = row.getByTestId('worktree-row-pr-badge');
      const queueGlyph = window.getByTestId('worktree-row-pr-merge-queue');
      const tooltipQueueLine = window.getByTestId('pr-tooltip-merge-queue');
      const tooltipPhaseLine = window.getByTestId(
        'pr-tooltip-merge-queue-phase',
      );

      // Re-inject, re-hover, and assert as one retryable step, so a racing
      // live refresh or a still-open tooltip from the previous step cannot
      // leave a stale reading.
      const expectQueuedTooltip = async (event, position, phaseText) => {
        await expect(async () => {
          await injectGithubPrStatus(electronApp, event);
          await expect(queueGlyph).toHaveAttribute(
            'aria-label',
            `In merge queue, position ${position}`,
            { timeout: 1_000 },
          );
          await window.mouse.move(0, 0);
          await badge.hover({ timeout: 2_000 });
          await expect(tooltipQueueLine).toHaveText(
            `In merge queue (#${position})`,
            { timeout: 2_000 },
          );
          await expect(tooltipPhaseLine).toHaveText(`Queue: ${phaseText}`, {
            timeout: 1_000,
          });
          await expect(tooltipPhaseLine).not.toContainText(/merged/i);
        }).toPass({ timeout: 20_000 });
      };

      // Open, not queued: the ordinary approved badge.
      await expectInjectedPrStatusSurfaces(
        electronApp,
        window,
        statusEvent({
          ...mergeablePrStatus({ prNumber }),
          mergeQueue: { required: true, inQueue: false },
        }),
        {
          prLabel: `#${prNumber}`,
          ciLabel: 'CI passing',
          sidebarLabel: `PR #${prNumber}`,
        },
      );
      await expect(queueGlyph).toHaveCount(0);

      // Queued behind another PR while GitHub runs the queue checks.
      await expectQueuedTooltip(
        statusEvent(queuedStatus({ position: 2, phase: 'awaiting_checks' })),
        2,
        'Awaiting queue checks',
      );

      // Head of the queue with its queue checks passed.
      await expectQueuedTooltip(
        statusEvent(queuedStatus({ position: 1, phase: 'mergeable' })),
        1,
        'Queue checks passed',
      );

      // Removed from the queue: the glyph goes and the approval check returns.
      await window.mouse.move(0, 0);
      await expect(async () => {
        await injectGithubPrStatus(
          electronApp,
          statusEvent({
            ...mergeablePrStatus({ prNumber }),
            mergeQueue: { required: true, inQueue: false },
          }),
        );
        await expect(queueGlyph).toHaveCount(0, { timeout: 1_000 });
        await expect(row.getByTestId('worktree-row-pr-approved')).toBeVisible({
          timeout: 1_000,
        });
      }).toPass({ timeout: 20_000 });

      // Re-enqueued at the back of the queue.
      await expectQueuedTooltip(
        statusEvent(queuedStatus({ position: 3, phase: 'queued' })),
        3,
        'Waiting in queue',
      );

      // Merged: GitHub drops the entry, the queue state goes, and the status
      // bar reads the PR as merged.
      await window.mouse.move(0, 0);
      await expect(async () => {
        await injectGithubPrStatus(
          electronApp,
          statusEvent({
            ...buildPrStatusData({ prNumber, state: 'merged' }),
            mergeQueue: { required: true, inQueue: false },
          }),
        );
        await expect(queueGlyph).toHaveCount(0, { timeout: 1_000 });
        await expect(
          window
            .getByTestId('pr-status-bar')
            .getByLabel(`Pull request #${prNumber} (merged)`),
        ).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      await expect(tooltipPhaseLine).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('CAN-3951 — early access swaps the green check for the queue glyph on a queued PR', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await window.evaluate(() =>
        window.api.experiments.setChoice({
          experimentId: 'early-access',
          enabled: true,
        }),
      );
      const prNumber = 3951;
      const statusEvent = (status) =>
        buildPrStatusEvent({
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          repos: [{ repoId: WORKSPACE_ID, repoName: 'repo', status }],
        });
      const notQueued = statusEvent({
        ...mergeablePrStatus({ prNumber }),
        mergeQueue: { required: true, inQueue: false },
      });
      const queued = (mergeQueue) =>
        statusEvent({
          ...mergeablePrStatus({ prNumber }),
          mergeableState: 'blocked',
          mergeQueue: { required: true, inQueue: true, ...mergeQueue },
        });
      const row = window.locator(
        `[data-testid="worktree-row"][data-project-id="${WORKSPACE_ID}"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      // The focused row is mounted: one leading status and no classic badge.
      await expect(row.getByTestId('worktree-row-status')).toBeVisible();
      const queueGlyph = row.getByTestId('worktree-row-merge-queue');
      const checksPassing = row.getByTestId('worktree-row-checks-passing');
      const merged = row.getByTestId('worktree-row-merged');

      // Re-inject with the pointer off the row (hover hides the trailing
      // group), so a racing live refresh cannot leave a stale reading.
      const expectRow = async (event, assertState) => {
        await window.mouse.move(0, 0);
        await expect(async () => {
          await injectGithubPrStatus(electronApp, event);
          await assertState();
        }).toPass({ timeout: 20_000 });
      };

      // Open with CI passing, not queued: the green check.
      await expectRow(notQueued, async () => {
        await expect(checksPassing).toBeVisible({ timeout: 1_000 });
        await expect(queueGlyph).toHaveCount(0, { timeout: 1_000 });
      });
      await expect(row.getByTestId('worktree-row-pr-badge')).toHaveCount(0);

      // Queued behind another PR: the pending queue glyph replaces the check.
      await expectRow(
        queued({ position: 2, phase: 'awaiting_checks' }),
        async () => {
          await expect(queueGlyph).toHaveAttribute(
            'aria-label',
            'In merge queue, position 2. Awaiting queue checks',
            { timeout: 1_000 },
          );
          await expect(checksPassing).toHaveCount(0, { timeout: 1_000 });
        },
      );
      await expect(queueGlyph).toHaveClass(/fg-warning/);
      await expect(queueGlyph).toBeVisible();

      // The hover card carries the queue position and phase under the PR.
      await expect(async () => {
        await injectGithubPrStatus(
          electronApp,
          queued({ position: 2, phase: 'awaiting_checks' }),
        );
        await window.mouse.move(0, 0);
        await row.getByTestId('worktree-row-title').hover({ timeout: 2_000 });
        await expect(
          window.getByTestId('worktree-row-preview-pr'),
        ).toContainText('In merge queue (#2) · Awaiting queue checks', {
          timeout: 2_000,
        });
      }).toPass({ timeout: 20_000 });

      // Head of the queue with queue checks passed: still queued, not merged.
      await expectRow(queued({ position: 1, phase: 'mergeable' }), async () => {
        await expect(queueGlyph).toHaveAttribute(
          'aria-label',
          'In merge queue, position 1. Queue checks passed',
          { timeout: 1_000 },
        );
        await expect(merged).toHaveCount(0, { timeout: 1_000 });
      });

      // Removed from the queue: the check returns.
      await expectRow(notQueued, async () => {
        await expect(queueGlyph).toHaveCount(0, { timeout: 1_000 });
        await expect(checksPassing).toBeVisible({ timeout: 1_000 });
      });

      // Re-enqueued without a reported position: still reads as queued.
      await expectRow(queued({ phase: 'queued' }), async () => {
        await expect(queueGlyph).toHaveAttribute(
          'aria-label',
          'In merge queue. Waiting in queue',
          { timeout: 1_000 },
        );
      });

      // Merged: the queue glyph leaves and the merged icon takes its place.
      await expectRow(
        statusEvent({
          ...buildPrStatusData({ prNumber, state: 'merged' }),
          mergeQueue: { required: true, inQueue: false },
        }),
        async () => {
          await expect(queueGlyph).toHaveCount(0, { timeout: 1_000 });
          await expect(merged).toBeVisible({ timeout: 1_000 });
        },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('delayed unresolved-comment confirmation follows its originating worktree via toast', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree({
        apps: ['ts-pnpm-vite', 'ts-npm-next'],
      });
    try {
      await installControllableUnresolvedMergePrIpcMock(electronApp);

      const originalRow = window.locator(
        `[data-testid="worktree-row"][data-project-id="${WORKSPACE_ID}"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      const otherRow = window.locator(
        `[data-testid="worktree-row"][data-project-id="${OTHER_WORKSPACE_ID}"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await expect(originalRow).toBeVisible();
      await expect(otherRow).toBeVisible();

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: mergeablePrStatus({
              prNumber: 905,
              unresolvedReviewThreadCount: 2,
            }),
          },
        ],
      });
      const mergeButton = window.getByTestId('pr-status-bar-merge-pr');
      await clickInjectedPrStatusButton(electronApp, statusEvent, mergeButton);
      await expect
        .poll(async () => (await getPrActionIpcCalls(electronApp)).length)
        .toBe(1);

      // Leave while the fresh GitHub check is still pending. The eventual
      // response belongs to the first workspace and must never mount its modal
      // over this newly active one.
      await otherRow.click();
      await expect(otherRow).toHaveClass(/bg-muted/);
      await releaseUnresolvedMergePr(electronApp);

      const toastMessage = window.getByText(
        'This merge needs confirmation because the pull request has unresolved comments. Click to return to the worktree and review it.',
        { exact: true },
      );
      await expect(toastMessage).toBeVisible();
      await expect(window.getByTestId('pr-merge-warning-modal')).toHaveCount(0);

      // The toast is the explicit handoff: clicking it returns to the original
      // workspace and opens that workspace's stored confirmation.
      await toastMessage.click();
      const warning = window.getByTestId('pr-merge-warning-modal');
      await expect(originalRow).toHaveClass(/bg-muted/);
      await expect(warning).toBeVisible();
      await expect(warning.getByText('2 unresolved comments')).toBeVisible();

      await window.getByTestId('pr-merge-warning-confirm').click();
      await expect(warning).toHaveCount(0);

      const calls = await getPrActionIpcCalls(electronApp);
      const mergeCalls = calls.filter(
        (call) => call.channel === 'github:merge-pr',
      );
      expect(mergeCalls).toHaveLength(3);
      expect(mergeCalls[1].request).toMatchObject({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        dryRun: true,
        confirmUnresolvedComments: false,
      });
      expect(mergeCalls[2].request).toMatchObject({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        confirmUnresolvedComments: true,
      });
      expect(
        mergeCalls.some(
          (call) => call.request.projectId === OTHER_WORKSPACE_ID,
        ),
      ).toBe(false);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('merge PR progress tooltip renders queued merge progress', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await installPendingMergePrIpcMock(electronApp);

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: mergeablePrStatus({ prNumber: 904 }),
          },
        ],
      });
      await injectGithubPrStatus(electronApp, statusEvent);

      const mergeButton = window.getByTestId('pr-status-bar-merge-pr');
      await expect(mergeButton).toBeVisible({ timeout: 10_000 });
      // The Merge action takes the accent ink, not the merged status ink.
      await expect(mergeButton).toHaveClass(/(^|\s)fg-accent(\s|$)/);
      await expect(mergeButton).not.toHaveClass(/fg-special-strong/);
      await clickInjectedPrStatusButton(electronApp, statusEvent, mergeButton);
      // A running action keeps its own label and stays ENABLED — it is its own
      // cancel target now (spinner swaps to ✕ on hover). It neither renames
      // itself to "Merging…" nor greys out.
      await expect(mergeButton).toBeEnabled();
      await expect(mergeButton).toContainText('Merge');
      await expect(mergeButton).toHaveAttribute('aria-label', 'Cancel merge');
      // CAN-3053 finding 9: the sidebar row's own merging chip
      // (`WorktreePrMergingIndicator`, `useGitHubStore.mergingPr`) lights at
      // the same time as the status bar's in-flight merge button — the two
      // surfaces read the same store state.
      await expect(window.getByTestId('worktree-row-pr-merging')).toBeVisible();

      await injectMergePrProgress(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repoId: WORKSPACE_ID,
        repoName: 'repo',
        phase: 'queued',
        queuePosition: 2,
        queueLength: 3,
      });

      // GitHub can transiently flip a PR to not mergeable while Canopy's
      // merge request is still queued. The in-progress button must remain
      // mounted so the user can continue to see its state and progress.
      await injectGithubPrStatus(
        electronApp,
        buildPrStatusEvent({
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: {
                ...mergeablePrStatus({ prNumber: 904 }),
                mergeable: false,
                mergeableState: 'blocked',
              },
            },
          ],
        }),
      );
      await expect(mergeButton).toBeVisible();
      // Running actions keep their label and stay enabled — they are their own
      // cancel target.
      await expect(mergeButton).toBeEnabled();
      await expect(mergeButton).toContainText('Merge');

      await injectMergePrProgress(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repoId: WORKSPACE_ID,
        repoName: 'repo',
        phase: 'checking_mergeability',
      });
      await injectMergePrProgress(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repoId: WORKSPACE_ID,
        repoName: 'repo',
        phase: 'waiting_mergeability',
        retryDelayMs: 2_000,
      });

      await mergeButton.hover();
      // An automatic Git refresh can replace the status-bar trigger while the
      // shared progress surface remains visibly open. Assert the user-visible
      // merge checklist rather than coupling the check to the transient host.
      const tooltip = window
        .getByRole('tooltip')
        .filter({ hasText: 'Queued (2 of 3)' });
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText('In progress');
      await expect(tooltip).toContainText('Queued (2 of 3)');
      await expect(tooltip).toContainText('Checking mergeability');
      await expect(tooltip).toContainText('Waiting for GitHub (2s)');
      await expect(tooltip).toContainText('Merging pull request');
    } finally {
      await releasePendingMergePr(electronApp);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('cancels an in-flight merge through the status-bar IPC flow', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await installPendingMergePrIpcMock(electronApp);

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: mergeablePrStatus({ prNumber: 906 }),
          },
        ],
      });
      await injectGithubPrStatus(electronApp, statusEvent);

      const mergeButton = window.getByTestId('pr-status-bar-merge-pr');
      await clickInjectedPrStatusButton(electronApp, statusEvent, mergeButton);

      await expect
        .poll(async () => {
          const calls = await getPrActionIpcCalls(electronApp);
          return calls.some((call) => call.channel === 'github:merge-pr');
        })
        .toBe(true);

      // The running action is its own cancel target now — it swaps its
      // spinner for an ✕ on hover, and its own click cancels. There is no
      // separate ✕ pill to find.
      await expect(mergeButton).toHaveAttribute('aria-label', 'Cancel merge', {
        timeout: 60_000,
      });
      await expect(mergeButton).toBeEnabled();
      await mergeButton.click();
      // Once cancellation is requested there is nothing left to cancel, so the
      // button stops advertising it and goes back to spinning.
      await expect(mergeButton).not.toHaveAttribute(
        'aria-label',
        'Cancel merge',
      );

      await expect
        .poll(async () => {
          const calls = await getPrActionIpcCalls(electronApp);
          const mergeCall = calls.find(
            (call) => call.channel === 'github:merge-pr',
          );
          const cancelCall = calls.find(
            (call) => call.channel === 'github:cancel-git-action',
          );
          return {
            cancelOperationId: cancelCall?.request.operationId,
            mergeOperationId: mergeCall?.request.operationId,
          };
        })
        .toEqual({
          cancelOperationId: expect.any(String),
          mergeOperationId: expect.any(String),
        });

      const calls = await getPrActionIpcCalls(electronApp);
      const mergeCall = calls.find(
        (call) => call.channel === 'github:merge-pr',
      );
      const cancelCall = calls.find(
        (call) => call.channel === 'github:cancel-git-action',
      );
      expect(cancelCall.request.operationId).toBe(
        mergeCall.request.operationId,
      );

      await releasePendingMergePr(electronApp);
      // Back to an idle action: nothing left to cancel.
      await expect(mergeButton).not.toHaveAttribute(
        'aria-label',
        'Cancel merge',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('multi-repo merge opens the repo picker and submits selected repos', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await installPrActionIpcMocks(electronApp);

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            status: mergeablePrStatus({
              prNumber: 901,
              unresolvedReviewThreadCount: 2,
            }),
          },
          {
            repoId: 'repo-b',
            repoName: 'Repo B',
            status: mergeablePrStatus({ prNumber: 902 }),
          },
        ],
      });
      await injectGithubPrStatus(electronApp, statusEvent);

      await clickInjectedPrStatusButton(
        electronApp,
        statusEvent,
        window.getByTestId('pr-status-bar-merge-pr'),
      );
      const modal = window.getByTestId('pr-merge-multi-repo-modal');
      await expect(
        window.getByTestId('pr-merge-multi-repo-queue-hint-Repo A'),
      ).toHaveText('Uses a merge queue');
      await expect(
        window.getByTestId('pr-merge-multi-repo-queue-hint-Repo B'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('pr-merge-multi-repo-queue-note'),
      ).toContainText('open a chat');
      await expect(
        modal.getByRole('checkbox', {
          name: 'Select Repo A pull request #901 for merge',
        }),
      ).toBeEnabled();

      await expect(modal).toBeVisible();
      await expect(modal.getByText('Repo A')).toBeVisible();
      await expect(modal.getByText('Repo B')).toBeVisible();
      await expect(modal.getByText('2 unresolved')).toBeVisible();

      const repoBCheckbox = window.getByLabel(
        'Select Repo B pull request #902 for merge',
      );
      await expect(repoBCheckbox).toBeChecked();
      await repoBCheckbox.click();
      await expect(repoBCheckbox).not.toBeChecked();
      await expect(
        window.getByTestId('pr-merge-multi-repo-confirm'),
      ).toHaveText('Merge 1 PR');

      await window.getByTestId('pr-merge-multi-repo-confirm').click();
      await expect(modal).toHaveCount(0);

      const calls = await getPrActionIpcCalls(electronApp);
      const mergeCalls = calls.filter(
        (call) => call.channel === 'github:merge-pr',
      );
      expect(mergeCalls[0].request).toMatchObject({ dryRun: true });
      expect(mergeCalls[1].request).toMatchObject({
        confirmUnresolvedComments: true,
        repoIds: ['repo-a'],
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('multi-repo merge shows checking, failure, and successful retry states', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await installControllableMultiRepoCheckIpcMock(electronApp);

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            status: mergeablePrStatus({ prNumber: 901 }),
          },
          {
            repoId: 'repo-b',
            repoName: 'Repo B',
            status: mergeablePrStatus({ prNumber: 902 }),
          },
        ],
      });
      await injectGithubPrStatus(electronApp, statusEvent);

      const mergeButton = window.getByTestId('pr-status-bar-merge-pr');
      await clickInjectedPrStatusButton(electronApp, statusEvent, mergeButton);
      const modal = window.getByTestId('pr-merge-multi-repo-modal');
      await expect(
        window.getByTestId('pr-merge-multi-repo-checking'),
      ).toBeVisible();
      await expect(mergeButton).toBeEnabled();
      await expect(mergeButton).toContainText('Merge');

      await settleMultiRepoCheck(electronApp, 'reject');
      await expect(
        window.getByTestId('pr-merge-multi-repo-check-failed'),
      ).toBeVisible();
      const retryButton = window.getByTestId('pr-merge-multi-repo-retry');
      await expect(retryButton).toBeVisible();

      await retryButton.click();
      await expect(
        window.getByTestId('pr-merge-multi-repo-checking'),
      ).toBeVisible();
      await expect(mergeButton).toBeEnabled();
      await expect(mergeButton).toContainText('Merge');

      await settleMultiRepoCheck(electronApp, 'resolve');
      await expect(modal.getByText('Repo A')).toBeVisible();
      await expect(modal.getByText('Repo B')).toBeVisible();
      await expect(retryButton).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('conflict-resolution and CI-fix buttons dispatch their chat launch IPC', async () => {
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      await installPrActionIpcMocks(electronApp);

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: 'repo-conflict',
            repoName: 'Conflict Repo',
            status: {
              ...buildPrStatusData({
                prNumber: 903,
                checkStatus: 'failing',
                hasConflicts: true,
              }),
              checkDetails: failingPrStatus(903).checkDetails,
            },
          },
        ],
      });
      await injectGithubPrStatus(electronApp, statusEvent);

      await clickInjectedPrStatusButton(
        electronApp,
        statusEvent,
        window.getByTestId('pr-status-bar-resolve-conflicts'),
      );
      await clickInjectedPrStatusButton(
        electronApp,
        statusEvent,
        window.getByTestId('pr-status-bar-fix-ci'),
      );

      const calls = await getPrActionIpcCalls(electronApp);
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: 'github:start-merge-conflict-resolution',
            request: expect.objectContaining({
              projectId: WORKSPACE_ID,
              worktreeId: WORKTREE_ID,
              repoId: undefined,
              repoName: 'Conflict Repo',
            }),
          }),
          expect.objectContaining({
            channel: 'github:start-ci-check-fix',
            request: expect.objectContaining({
              projectId: WORKSPACE_ID,
              worktreeId: WORKTREE_ID,
              repoId: undefined,
              repoName: 'Conflict Repo',
            }),
          }),
        ]),
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Resolve, Commit & Push starts its chat with the user worktree approval default', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-pr-approval-default-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedBuiltinGhApprovalPreferences(userDataDir);

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await window.evaluate(async () => {
        await window.api.github.setForegroundWorktree({
          projectId: null,
          worktreeId: null,
        });
      });

      const statusEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: 'repo-conflict',
            repoName: 'Conflict Repo',
            status: buildPrStatusData({
              prNumber: 904,
              hasConflicts: true,
            }),
          },
        ],
      });
      await injectGithubPrStatus(electronApp, statusEvent);
      await clickInjectedPrStatusButton(
        electronApp,
        statusEvent,
        window.getByTestId('pr-status-bar-resolve-conflicts'),
      );

      await expect(
        window.getByRole('button', {
          name: 'Tool approval mode, current mode Accept edits',
        }),
      ).toBeVisible({ timeout: 60_000 });

      const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
      await expect
        .poll(
          () => {
            try {
              const persisted = readChatStorageTabs(workspaceRoot, WORKTREE_ID);
              const conflictTab = persisted.tabs?.find((tab) =>
                tab.messages?.some((message) =>
                  message.blocks?.some(
                    (block) =>
                      block.type === 'builtin_gh_chat_info' &&
                      block.kind === 'merge_conflict',
                  ),
                ),
              );
              return conflictTab?.approvalMode ?? 'missing';
            } catch {
              return 'missing';
            }
          },
          { timeout: 60_000 },
        )
        .toBe('auto');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
