import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

// Split PR (Task 16) — seeders for the button-gating preconditions.
//
// `split-pr-button` (PullRequestSection.tsx) is eligible purely from
// PERSISTED state hydrated at startup — no live GitHub call is required:
//   - `splitPrEnabled` / `splitPrThresholdLines` (PreferencesData,
//     packages/desktop-shared/src/types.ts) drive `useSplitPrGatingPreferences`
//     (apps/desktop-app/src/renderer/src/hooks/useSplitPrPreferences.ts).
//   - `WorktreeData.lastKnownPrStatus` (packages/desktop-shared/src/types.ts)
//     is hydrated into `githubStore.prStatuses` by `hydratePersistedPrStatuses`
//     (stores/githubStore.ts), called from `projectsStore.ts` on normal
//     worktree/sidebar load — NOT gated behind a live poll.
// `isSplitPrEligible` (stores/githubStore.ts) additionally requires the PR's
// `state === 'open'` and `additions + deletions >= thresholdLines` (using the
// PR's own additions/deletions when both are defined, else the cached local
// diff stats), and the owning workspace to be `type: 'single-repo'`.

/**
 * Merge Split PR gating fields into a hand-written `preferences.json`
 * (`{ version: 1, preferences: {...} }`, matching the shape every other spec
 * that hand-writes preferences uses — see `multi-agent.spec.mjs`,
 * `app-advisor-mode.spec.mjs`).
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {boolean} [options.splitPrEnabled] defaults to `true` (matches the
 *   backend default in `preferences-store.ts`)
 * @param {number} [options.splitPrThresholdLines] defaults to `500` (matches
 *   the backend default)
 * @param {Record<string, unknown>} [options.extraPreferences] additional
 *   preference fields to merge in (e.g. `onboardingCompleted`)
 * @returns {{ filePath: string }}
 */
export function seedSplitPrPreferences(options) {
  const {
    userDataDir,
    splitPrEnabled = true,
    splitPrThresholdLines = 500,
    extraPreferences = {},
  } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedSplitPrPreferences requires userDataDir');
  }

  const preferencesPath = path.join(userDataDir, 'preferences.json');
  let existing = {};
  if (existsSync(preferencesPath)) {
    try {
      existing = JSON.parse(readFileSync(preferencesPath, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const existingPreferences =
    existing && typeof existing === 'object' && existing.preferences
      ? existing.preferences
      : {};

  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    preferencesPath,
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          ...existingPreferences,
          ...extraPreferences,
          splitPrEnabled,
          splitPrThresholdLines,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { filePath: preferencesPath };
}

/**
 * Build a `PrStatusData` (single repo's PR) carrying `additions`/`deletions`
 * so `isSplitPrEligible`'s line-count gate can be driven directly (the
 * shared `buildPrStatusData` in `injectGithubPrStatus.mjs` does not expose
 * those fields). Shape follows `PrStatusData` in
 * `packages/desktop-shared/src/types/github.ts`.
 *
 * @param {object} options
 * @param {number} options.prNumber
 * @param {number} options.additions
 * @param {number} options.deletions
 * @param {import('@canopy/desktop-shared/types/github').PrState} [options.state] defaults to `'open'`
 * @param {string} [options.title] defaults to `PR #<prNumber>`
 * @param {string} [options.prUrl]
 * @param {string} [options.headSha]
 * @param {boolean} [options.hasConflicts] defaults to `false`. Set `true` to
 *   drive the `merge_conflicts` `SplitPrBlocker` (see
 *   `deriveSplitPrReadiness` in `splitPrEligibilityInputs.ts`): the button
 *   stays eligible (shown disabled+tooltip on the menu/panel surfaces) but
 *   the status-bar surface — which requires zero blockers — hides entirely.
 * @returns {import('@canopy/desktop-shared/types/github').PrStatusData}
 */
export function buildSplitPrStatusData(options) {
  const {
    prNumber,
    additions,
    deletions,
    state = 'open',
    title = `PR #${prNumber}`,
    prUrl = `https://github.com/canopy-e2e/repo/pull/${prNumber}`,
    headSha,
    hasConflicts = false,
  } = options ?? {};

  if (typeof prNumber !== 'number') {
    throw new Error('buildSplitPrStatusData requires a numeric prNumber');
  }
  if (typeof additions !== 'number' || typeof deletions !== 'number') {
    throw new Error(
      'buildSplitPrStatusData requires numeric additions and deletions',
    );
  }

  return {
    prNumber,
    prUrl,
    ...(headSha ? { headSha } : {}),
    state,
    title,
    checkStatus: 'passing',
    checkDetails: [],
    reviewStatus: 'none',
    reviewers: [],
    hasConflicts,
    commentCount: 0,
    updatedAt: '2026-04-10T12:00:00.000Z',
    additions,
    deletions,
  };
}

/**
 * Merge a `lastKnownPrStatus` onto one worktree entry in an already-seeded
 * `workspaces/{workspaceId}/worktrees.json` (written by `seedDemoWorkspaces`
 * via `demo-apps/seed-canopy-data.mjs`). Read-modify-write so it does not
 * clobber the discovery/branch fields the demo seed already wrote.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {string} options.workspaceId owning workspace id
 * @param {string} options.worktreeId worktree id to patch
 * @param {import('@canopy/desktop-shared/types/github').WorktreePrStatus | null} options.lastKnownPrStatus
 * @returns {{ filePath: string }}
 */
export function seedWorktreeLastKnownPrStatus(options) {
  const { userDataDir, workspaceId, worktreeId, lastKnownPrStatus } =
    options ?? {};

  if (!userDataDir) {
    throw new Error('seedWorktreeLastKnownPrStatus requires userDataDir');
  }
  if (!workspaceId) {
    throw new Error('seedWorktreeLastKnownPrStatus requires workspaceId');
  }
  if (!worktreeId) {
    throw new Error('seedWorktreeLastKnownPrStatus requires worktreeId');
  }
  if (lastKnownPrStatus === undefined) {
    throw new Error(
      'seedWorktreeLastKnownPrStatus requires lastKnownPrStatus (WorktreePrStatus | null)',
    );
  }

  const filePath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktrees.json',
  );
  if (!existsSync(filePath)) {
    throw new Error(
      `seedWorktreeLastKnownPrStatus: ${filePath} does not exist yet — seed the workspace/worktree first`,
    );
  }

  const file = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!file || !Array.isArray(file.worktrees)) {
    throw new Error(
      `seedWorktreeLastKnownPrStatus: ${filePath} is not a valid WorktreesFile`,
    );
  }

  let found = false;
  const nextWorktrees = file.worktrees.map((worktree) => {
    if (worktree.id !== worktreeId) {
      return worktree;
    }
    found = true;
    return { ...worktree, lastKnownPrStatus };
  });

  if (!found) {
    throw new Error(
      `seedWorktreeLastKnownPrStatus: worktree "${worktreeId}" not found in ${filePath}`,
    );
  }

  writeJson(filePath, { ...file, worktrees: nextWorktrees });
  return { filePath };
}

/**
 * Convenience: build a single-repo `WorktreePrStatus` wrapping one
 * `PrStatusData` (via {@link buildSplitPrStatusData}) and write it onto the
 * worktree in one call.
 *
 * @param {object} options same as {@link seedWorktreeLastKnownPrStatus} plus:
 * @param {number} options.prNumber
 * @param {number} options.additions
 * @param {number} options.deletions
 * @param {import('@canopy/desktop-shared/types/github').PrState} [options.state]
 * @param {string} [options.repoId] defaults to `workspaceId`
 * @param {string} [options.repoName] defaults to `'repo'`
 * @param {boolean} [options.hasConflicts] defaults to `false`; see
 *   {@link buildSplitPrStatusData}
 * @returns {{ filePath: string }}
 */
export function seedSplitPrOpenPrStatus(options) {
  const {
    userDataDir,
    workspaceId,
    worktreeId,
    prNumber,
    additions,
    deletions,
    state = 'open',
    repoId = workspaceId,
    repoName = 'repo',
    hasConflicts = false,
  } = options ?? {};

  const status = buildSplitPrStatusData({
    prNumber,
    additions,
    deletions,
    state,
    hasConflicts,
  });

  return seedWorktreeLastKnownPrStatus({
    userDataDir,
    workspaceId,
    worktreeId,
    lastKnownPrStatus: {
      repos: [{ repoId, repoName, status }],
      lastCheckedAt: '2026-04-10T12:00:00.000Z',
    },
  });
}

/**
 * Seed a persisted `SplitPrMap` file directly at
 * `workspaces/{workspaceId}/split-maps/{worktreeId}.json` — the exact file
 * `readSplitPrMap` / `writeSplitPrMap` (`apps/desktop-app/src/main/lib/
 * split-pr-persistence.ts`) read/write, shaped `{ version: 1, map }`.
 *
 * With `status: 'executing'` and NO live split lock held for the key (the
 * lock is in-memory-only and never survives a fresh app launch — see
 * `split-lock-service.ts`), `PullRequestSection`'s `staleExecutingMap`
 * detection treats this as an interrupted run and shows
 * `SplitInterruptedModal` once the worktree is selected (the modal's
 * backing `splitPrResults[key]` is hydrated by `loadSplitPrMap`, which fires
 * from `PullRequestSection`'s mount effect — so a worktree selection is
 * required, not just app launch).
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {string} options.workspaceId owning workspace id
 * @param {string} options.worktreeId owning worktree id
 * @param {number} [options.prNumber] defaults to `501`
 * @param {number} [options.childCount] number of `SplitPrChild` entries to
 *   seed; defaults to `2`
 * @param {import('@canopy/desktop-shared/types/github').SplitPrMap['status']} [options.status]
 *   defaults to `'executing'`
 * @returns {{ filePath: string, map: object }}
 */
export function seedInterruptedSplitMap(options) {
  const {
    userDataDir,
    workspaceId,
    worktreeId,
    prNumber = 501,
    childCount = 2,
    status = 'executing',
  } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedInterruptedSplitMap requires userDataDir');
  }
  if (!workspaceId) {
    throw new Error('seedInterruptedSplitMap requires workspaceId');
  }
  if (!worktreeId) {
    throw new Error('seedInterruptedSplitMap requires worktreeId');
  }

  const children = Array.from({ length: childCount }, (_, i) => ({
    index: i + 1,
    title: `feat: child ${i + 1}`,
    type: 'feature',
    branchName: `split/${worktreeId}/child-${i + 1}`,
    baseBranch: 'main',
    dependsOn: [],
    changes: [{ file: `child-${i + 1}.txt`, hunks: 'all' }],
    verifyStatus: i === 0 ? 'green' : 'pending',
  }));

  const map = {
    version: 1,
    originalPrNumber: prNumber,
    originalPrUrl: `https://github.com/canopy-e2e/repo/pull/${prNumber}`,
    originalBaseBranch: 'main',
    originalHeadBranch: worktreeId,
    originalHeadSha: 'a'.repeat(40),
    integrationBranch: `split/${worktreeId}/integration`,
    originalWorktreeId: worktreeId,
    children,
    status,
    createdAt: '2026-04-10T12:00:00.000Z',
    updatedAt: '2026-04-10T12:05:00.000Z',
  };

  const filePath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'split-maps',
    `${worktreeId}.json`,
  );
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeJson(filePath, { version: 1, map });
  return { filePath, map };
}
