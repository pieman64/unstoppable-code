// Runtime snapshot-injection seeder for GitHub PR/branch status (Doc 13 Spec 13;
// PRs 823 / 737 / 718 / 735). Like `injectResourceSnapshot` /
// `injectBrowserSnapshot`, this injects state into an ALREADY-RUNNING app by
// emitting the same IPC event the main process broadcasts, so the renderer
// `githubStore` updates without a live GitHub remote, token, or poll.
//
// WHY THIS EXISTS: the store-driven PR variants (open-PR badge, no-PR state,
// stale-PR-after-rename) were previously unreachable from the harness. The live
// poller's open-PR slice is unreachable because the GitHub mock keys off the
// `Bearer` auth scheme while Octokit sends `token` (see
// `pr-poller-live.spec.mjs`), and the Zustand stores are not exposed on
// `window` for direct injection (see `git-pr-state.spec.mjs`). Emitting the PR
// status event directly is the supported seam — it is the exact channel the
// main-process poller already broadcasts on.
//
// Source of truth for the channel + shape:
//   - Broadcast: the desktop PR-status poller broadcasts a `PrStatusEvent` on
//     `IPC_CHANNELS.githubPrStatusEvent` (`'github:pr-status-event'`).
//   - Channel constant: `packages/desktop-shared/src/types.ts`
//     `githubPrStatusEvent: 'github:pr-status-event'`.
//   - Preload: `apps/desktop-app/src/preload/index.ts` `github.onPrStatusUpdate`
//     subscribes to that channel and forwards the raw `PrStatusEvent`.
//   - Store reducer: `apps/desktop-app/src/renderer/src/stores/githubStore.ts`
//     `subscribeToEvents()` → `api.github.onPrStatusUpdate((event) => { ... })`:
//       * sets `prStatuses[`${projectId}/${worktreeId}`] = event.status`
//         (drives PrStatusBar's single/multi-repo PR badge + bar label);
//       * calls `projectsStore.setWorktreeLastKnownPrStatus(...)` (drives the
//         sidebar `worktree-row-pr-badge` via `worktree.lastKnownPrStatus`);
//       * if every repo PR is `merged`, marks the worktree `done`.
//   - Payload types: `PrStatusEvent` / `WorktreePrStatus` / `RepoPrStatus` /
//     `PrStatusData` in `packages/desktop-shared/src/types/github.ts`.
//
// SCOPE / LIMITATION — the repo-mismatch (branch-not-renamed) warning is NOT
// driven by this channel. `PrStatusBar` derives that warning from
// `shouldWarnBranchNotRenamed(...)` (`apps/desktop-app/src/renderer/src/lib/
// branchRenameWarning.ts`), whose inputs (`worktreeBranchName`,
// `hasBranchBeenPushed`, `repoBranches`) come from the `projectsStore`, not from
// the PR status event. A spec asserting the mismatch warning must drive
// `projectsStore` branch state (e.g. a worktree whose branch still equals its
// `worktreeId` and `hasBranchBeenPushed === false`), which is a separate seam
// from this PR-status injector. This helper covers the open-PR / no-PR / stale
// (post-rename, PR points at the old branch) PR-status surfaces only.

/**
 * The exact IPC channel the main process broadcasts `PrStatusEvent`s on.
 * Mirrors `IPC_CHANNELS.githubPrStatusEvent` (`'github:pr-status-event'`). Kept
 * as a literal here because the Playwright `electronApp.evaluate` callback runs
 * in the packaged main-process context and cannot import the shared TS module.
 */
const GITHUB_PR_STATUS_EVENT_CHANNEL = 'github:pr-status-event';

/**
 * Inject a `PrStatusEvent` into the running app by sending it on the same
 * channel the PR-status poller broadcasts on. The first window is the main
 * renderer window (the poller only ever broadcasts to it).
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@canopy/desktop-shared/types/github').PrStatusEvent} payload
 *   A full `PrStatusEvent`: `{ projectId, worktreeId, status }` where `status`
 *   is a `WorktreePrStatus` or `null`. Use `buildPrStatusEvent` to construct
 *   one of the canonical fixtures.
 * @returns {Promise<void>}
 */
export async function injectGithubPrStatus(electronApp, payload) {
  if (!electronApp) {
    throw new Error('injectGithubPrStatus requires an electronApp');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('injectGithubPrStatus requires a PrStatusEvent payload');
  }
  if (
    typeof payload.projectId !== 'string' ||
    typeof payload.worktreeId !== 'string'
  ) {
    throw new Error(
      'injectGithubPrStatus payload requires string projectId and worktreeId',
    );
  }
  if (!('status' in payload)) {
    throw new Error(
      'injectGithubPrStatus payload requires a `status` (WorktreePrStatus | null)',
    );
  }

  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, event }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        throw new Error('No BrowserWindow available to receive the PR status');
      }
      windows[0].webContents.send(channel, event);
    },
    { channel: GITHUB_PR_STATUS_EVENT_CHANNEL, event: payload },
  );
}

/**
 * Build a `PrStatusData` (a single repo's PR) with deterministic defaults.
 * Shape follows `PrStatusData` in `packages/desktop-shared/src/types/github.ts`.
 *
 * @param {object} options
 * @param {number} options.prNumber the PR number (e.g. 823)
 * @param {import('@canopy/desktop-shared/types/github').PrState} [options.state]
 *   defaults to `'open'`
 * @param {import('@canopy/desktop-shared/types/github').CheckStatus} [options.checkStatus]
 *   defaults to `'passing'`
 * @param {string} [options.title] defaults to `PR #<prNumber>`
 * @param {string} [options.prUrl] defaults to a github.com URL for the number
 * @param {boolean} [options.hasConflicts] defaults to `false`
 * @returns {import('@canopy/desktop-shared/types/github').PrStatusData}
 */
export function buildPrStatusData(options) {
  const {
    prNumber,
    state = 'open',
    checkStatus = 'passing',
    title = `PR #${prNumber}`,
    prUrl = `https://github.com/canopy-e2e/repo/pull/${prNumber}`,
    hasConflicts = false,
  } = options ?? {};

  if (typeof prNumber !== 'number') {
    throw new Error('buildPrStatusData requires a numeric prNumber');
  }

  return {
    prNumber,
    prUrl,
    state,
    title,
    checkStatus,
    checkDetails: [],
    reviewStatus: 'none',
    reviewers: [],
    hasConflicts,
    commentCount: 0,
    updatedAt: '2026-04-10T12:00:00.000Z',
  };
}

/**
 * Build a `PrStatusEvent` for one of three canonical PR-status fixtures used by
 * the Spec 13 PR-status coverage (PRs 823 / 737 / 718 / 735).
 *
 * Fixture selection:
 *   - `kind: 'open-pr'` (default) — a single repo with one OPEN PR. Drives the
 *     PrStatusBar single-repo PR badge (`PrStateBadge` showing `#<prNumber>` +
 *     `CheckStatusBadge`) and the sidebar `worktree-row-pr-badge`. Use
 *     `prNumber` to pin which PR surfaces (e.g. 823).
 *   - `kind: 'no-pr'` — a single repo with NO PR (`status: null`). Drives the
 *     no-PR bar state (the create-PR CTA path / absent PR badge). Asserts the
 *     PR badge does not surface for PRs that were closed/never-opened (e.g.
 *     718).
 *   - `kind: 'stale-after-rename'` — a single repo whose PR is still OPEN but
 *     points at a now-renamed head branch. Modeled as an open PR whose
 *     `state: 'open'` and `hasConflicts: true` (the post-rename PR is stale: it
 *     still references the old branch). The PR badge still surfaces (the PR
 *     object still exists) so a spec can assert the stale PR (e.g. 735) remains
 *     visible after a rename, while the separately-seeded projectsStore branch
 *     state would drive the rename warning. `prNumber` pins which PR (e.g. 735).
 *
 * For multi-repo fixtures (e.g. asserting PRs 823 + 737 together as the multi
 * "2 PRs" badge), pass an explicit `repos` array of `RepoPrStatus` entries and
 * the helper wraps them verbatim.
 *
 * @param {object} options
 * @param {string} options.projectId owning project / workspace id
 * @param {string} options.worktreeId owning worktree id
 * @param {'open-pr' | 'no-pr' | 'stale-after-rename'} [options.kind]
 *   defaults to `'open-pr'`
 * @param {number} [options.prNumber] PR number for the single-repo fixtures;
 *   defaults to `823`
 * @param {string} [options.repoId] single-repo id; defaults to `projectId`
 * @param {string} [options.repoName] single-repo name; defaults to `'repo'`
 * @param {import('@canopy/desktop-shared/types/github').RepoPrStatus[]} [options.repos]
 *   explicit multi-repo repos array; overrides the single-repo fixture
 * @param {string} [options.lastCheckedAt] ISO timestamp; defaults to a fixed time
 * @returns {import('@canopy/desktop-shared/types/github').PrStatusEvent}
 */
export function buildPrStatusEvent(options) {
  const {
    projectId,
    worktreeId,
    kind = 'open-pr',
    prNumber = 823,
    repoId,
    repoName = 'repo',
    repos,
    lastCheckedAt = '2026-04-10T12:00:00.000Z',
  } = options ?? {};

  if (typeof projectId !== 'string' || typeof worktreeId !== 'string') {
    throw new Error(
      'buildPrStatusEvent requires string projectId and worktreeId',
    );
  }

  const resolvedRepoId = repoId ?? projectId;

  /** @type {import('@canopy/desktop-shared/types/github').RepoPrStatus[]} */
  let resolvedRepos;
  if (repos) {
    resolvedRepos = repos;
  } else if (kind === 'no-pr') {
    resolvedRepos = [{ repoId: resolvedRepoId, repoName, status: null }];
  } else if (kind === 'stale-after-rename') {
    resolvedRepos = [
      {
        repoId: resolvedRepoId,
        repoName,
        // The PR still exists and is open, but is stale: it points at the old
        // (pre-rename) head branch, modeled here via `hasConflicts: true`.
        status: buildPrStatusData({
          prNumber,
          state: 'open',
          checkStatus: 'failing',
          hasConflicts: true,
          title: `PR #${prNumber} (stale head)`,
        }),
      },
    ];
  } else {
    // 'open-pr'
    resolvedRepos = [
      {
        repoId: resolvedRepoId,
        repoName,
        status: buildPrStatusData({ prNumber, state: 'open' }),
      },
    ];
  }

  /** @type {import('@canopy/desktop-shared/types/github').WorktreePrStatus} */
  const status = {
    repos: resolvedRepos,
    lastCheckedAt,
  };

  return { projectId, worktreeId, status };
}
