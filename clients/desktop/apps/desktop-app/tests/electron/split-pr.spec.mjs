import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  buildSplitPrStatusData,
  injectGithubPrStatus,
  registerScenario,
  seedSplitPrPreferences,
  seedSplitPrOpenPrStatus,
  seedInterruptedSplitMap,
  writeJson,
} from './seeders/index.mjs';

// Split PR — UI automation (Task 16).
//
// Covers the checklist from the Task 16 brief:
//   1. `split-pr-button` visible only when: `splitPrEnabled` pref ON + a
//      single-repo worktree's PERSISTED `lastKnownPrStatus` has an OPEN PR
//      whose (additions + deletions) is >= `splitPrThresholdLines`. Hidden
//      when: under threshold / toggle OFF / no PR.
//   2. Clicking the button (against a real single-repo git worktree whose
//      pre-flight gates pass — see "Pre-flight" below) opens the plan modal
//      via the Task 7 `CANOPY_TEST_SPLIT_PLAN_FIXTURE` hook, showing the
//      aggregate check + (for an invalid plan) the error/warning banners.
//   3. Approve is enabled for a valid plan and disabled for an invalid one.
//   4. GitTab's `split-pr-enabled-toggle` / `split-pr-threshold-input`
//      persist across a relaunch (same pattern as the git-agent-rebase
//      toggle spec in `git-pr-state.spec.mjs`).
//
// ---------------------------------------------------------------------------
// Eligibility is PERSISTED-ONLY (resolves the "does split-pr-button gating
// need a live PR?" question definitively — NO):
//   `PullRequestSection.tsx` reads `prStatus = useGitHubStore((s) =>
//   s.prStatuses[key])`. `githubStore.hydratePersistedPrStatuses` (called
//   from `projectsStore.ts` on ordinary sidebar/worktree load, NOT gated
//   behind a live poll) sets `prStatuses[key] = worktree.lastKnownPrStatus`
//   straight from the persisted `WorktreesFile` entry. `isSplitPrEligible`
//   (stores/githubStore.ts) then only needs `splitPrEnabled`,
//   `splitPrThresholdLines` (both from `preferences.json`, hydrated by
//   `useSplitPrGatingPreferences`), the owning workspace's
//   `type === 'single-repo'`, and the persisted PR's `state`/`additions`/
//   `deletions`. None of this requires a live GitHub/Octokit round trip, so
//   the gating tests below seed `lastKnownPrStatus` directly into
//   `worktrees.json` and never touch the mock GitHub server.
//
// ---------------------------------------------------------------------------
// Pre-flight for the fixture-hook (plan-modal) tests:
//   `planPrSplit` (apps/desktop-app/src/main/lib/pr-split-planner.ts)
//   ALWAYS runs `gatherPlanningInputs` (steps 1-4: single-repo check,
//   `getCurrentBranch` + `fetchRepoPrTrackingData` [a REAL Octokit call,
//   redirected to the mock GitHub server], fork check, base-branch
//   detection, `fetchOrigin` + `resolveRefSha('origin/<base>')` +
//   `resolveRefSha('HEAD')` + `isAncestor` [ALL real git], then
//   `gatherPrDiffSnapshot` [a real `git diff`]) BEFORE checking
//   `CANOPY_TEST_SPLIT_PLAN_FIXTURE` — the fixture only replaces the LLM
//   planner call (steps 5-6). So reaching the fixture path requires:
//     - a real single-repo worktree (`ts-pnpm-vite` demo app)
//     - a real `origin` remote shaped like a `github.com` URL (so
//       `parseGitHubRemote` resolves owner/repo for Octokit) — but real
//       network fetches against it are never required to succeed: git's
//       `fetchOrigin` swallows failures (`git.ts` wraps it in
//       `.catch(() => undefined)`), so we synthesize `refs/remotes/origin/main`
//       locally via `git update-ref` instead of a real push/fetch (see
//       `buildGithubTopology` below)
//     - the GitHub mock's `open-pr` scenario driven by an EXPLICIT `pulls`
//       array override (not the `variant` shorthand — the shorthand's
//       canned PR hardcodes `head.sha: 'a'.repeat(40)`, which can never
//       equal a real git SHA and would unconditionally fail the
//       `head_out_of_sync` gate) whose `head.sha` is the worktree's actual
//       HEAD and whose `base.ref`/`base.sha` are the real local `main`
//     - a GitHub PAT seeded through the Account settings UI (the same
//       mechanism `pr-poller-live.spec.mjs` uses) so `getGitHubClient()` can
//       resolve a token at all
//
// `split-pr-refusal` IS reachable through this same real pre-flight (by
// registering a mock PR whose `head.sha` does NOT match the real worktree
// HEAD, tripping `head_out_of_sync`) and is asserted below.
//
// ---------------------------------------------------------------------------
// "Approve disabled for an invalid fixture plan" — mechanically UNREACHABLE
// through the real `CANOPY_TEST_SPLIT_PLAN_FIXTURE` round trip: the fixture
// loader (`buildFixturePlanResponse`) validates the fixture plan against the
// gathered snapshot and THROWS (surfacing as the `split-pr-refusal` banner,
// not the modal) whenever `validateSplitPlan` reports any `severity: 'error'`
// issue. The modal's own Approve button is gated on that exact same
// `validateSplitPlan(plan, snapshot)` call over the exact same snapshot
// object the main process already validated — so a plan that reaches the
// modal can never fail that same check. To exercise the modal's
// disabled-Approve behavior deterministically, we stub the
// `github:split-workflow-start` IPC handler directly (same established
// technique as `installPrActionIpcMocks` in `git-pr-state.spec.mjs`) to hand
// the renderer an `ok` result carrying a structurally-valid `SplitPlan`
// (`isSplitPlan(...) === true`) that nonetheless leaves a hunk unassigned —
// this is a pure test-harness seam, not an app-source change, and it
// exercises the exact same `SplitPlanReviewModal` validation/Approve-gating
// code the fixture-hook path would.
//
// Determinism: no live agents. Split PR's Phase B (execute/carve) is NOT
// exercised here — Task 11 covers execute-phase mutation against real git.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_BRANCH = 'demo-main';
const MOCK_OWNER = 'canopy-e2e';
const MOCK_REPO = 'ts-pnpm-vite';
const MOCK_ORIGIN_URL = `https://github.com/${MOCK_OWNER}/${MOCK_REPO}.git`;
const MOCK_PAT = 'ghp_e2e_split_pr_scenario_key';

// `normalizePreferences()` (`apps/desktop-app/src/main/lib/preferences-store.ts`)
// clamps `splitPrThresholdLines` to a [50, 100_000] floor on every read — the
// same floor `GitTab.tsx`'s threshold `<input min={50}>` enforces client-side.
// A test-seeded threshold below 50 is silently raised to 50, so the added
// file's line count must be >= 50 for `isSplitPrEligible`'s `additions +
// deletions >= thresholdLines` gate to ever pass. `ADDED_FILE_LINE_COUNT`
// drives both the seeded file content and every additions/deletions/hunk
// fixture below so they stay in lockstep.
const ADDED_FILE_LINE_COUNT = 50;
const ADDED_FILE_CONTENT = `${Array.from(
  { length: ADDED_FILE_LINE_COUNT },
  (_, i) => `line ${i + 1}`,
).join('\n')}\n`;

async function clearScenario(key) {
  await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  ).catch(() => undefined);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Build the real git topology `planPrSplit`'s pre-flight needs: a
 * `github.com`-shaped `origin` remote (for Octokit owner/repo parsing) with a
 * LOCALLY synthesized `refs/remotes/origin/main` (so `resolveRefSha` and
 * `isAncestor` succeed without ever actually fetching over the network — the
 * real `git fetch origin` this triggers is allowed to fail; the planner
 * swallows that error), one new committed file on the worktree branch (so
 * the diff snapshot has exactly one file / one hunk / a whole-file addition,
 * keeping the fixture plan trivial to construct), and the branch pushed to
 * nothing (never actually pushed — the mock is the sole source of PR truth).
 *
 * @returns {{ headSha: string, baseSha: string, addedFile: string, additions: number }}
 */
function buildGithubTopology(repoPath, worktreePath) {
  execFileSync(
    'git',
    ['-C', repoPath, 'remote', 'add', 'origin', MOCK_ORIGIN_URL],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // The planner really runs `git fetch origin` against this remote, and no
  // repository exists at that URL. Route this repository's HTTP through a
  // port nothing listens on so the fetch fails at once on every host, without
  // reaching GitHub or asking for the host's credentials. This relies on
  // `MOCK_ORIGIN_URL` being an https URL: `http.proxy` covers nothing else.
  git(['config', 'http.proxy', 'http://127.0.0.1:1'], repoPath);
  const baseSha = git(['rev-parse', 'main'], repoPath);
  git(['update-ref', 'refs/remotes/origin/main', baseSha], repoPath);

  const { addedFile, headSha, additions } =
    commitSplitFeatureFile(worktreePath);

  return { headSha, baseSha, addedFile, additions };
}

/**
 * Just the "commit one new file" half of {@link buildGithubTopology}, with NO
 * `origin` remote added. Used by tests that stub the
 * `github:split-workflow-start` IPC handler directly and never exercise the
 * real pre-flight: adding a real
 * `github.com`-shaped `origin` remote would make `getCurrentBranch` +
 * `fetchRepoPrTrackingData` resolve a real remote in the main-process PR-status
 * POLLER (`github-poller.ts`, ticks within ~1s of worktree selection,
 * independent of any IPC stub). That poller persists whatever it fetches —
 * `status: null` on any failure (including "no GitHub token configured") —
 * clobbering the seeded `lastKnownPrStatus` this test relies on to keep
 * `split-pr-button` eligible. Keeping this worktree remote-less means the
 * poller's `getRemoteUrl` short-circuits to `null` (`github-pr.ts`) and the
 * seeded PR status is left alone, exactly like the button-gating tests above.
 *
 * @returns {{ headSha: string, addedFile: string, additions: number }}
 */
function commitSplitFeatureFile(worktreePath) {
  const addedFile = 'split-pr-feature.txt';
  writeFileSync(path.join(worktreePath, addedFile), ADDED_FILE_CONTENT, 'utf8');
  git(['add', addedFile], worktreePath);
  git(['commit', '-m', 'Add split PR feature file'], worktreePath);
  const headSha = git(['rev-parse', 'HEAD'], worktreePath);

  return { headSha, addedFile, additions: ADDED_FILE_LINE_COUNT };
}

// `additions`/`deletions` matter here beyond cosmetics: the real PR-status
// poller (`github-poller.ts`) fires within ~1s of worktree selection once a
// real `origin` remote + GitHub PAT are present (both required for the
// fixture-hook pre-flight — see the file header). It calls the same mock
// `pulls.get` this scenario serves and PERSISTS the result over the
// `seedSplitPrOpenPrStatus`-seeded `lastKnownPrStatus` (`persistLastKnownPrStatus`
// in `github-poller.ts`). `buildStatus` (`apps/desktop-app/src/main/lib/
// github-pr.ts`) only sets `PrStatusData.additions`/`.deletions` `if (typeof
// args.pr.additions === 'number')` — so an Octokit pull payload missing those
// fields clobbers the seeded eligibility-driving line counts with `undefined`,
// which then falls through `isSplitPrEligible` to local `diffStats` (possibly
// `undefined` for an uncommitted/unpushed branch) and can flip `split-pr-button`
// back to hidden after the poller's first tick. Always pass the same
// additions/deletions the test also seeds via `seedSplitPrOpenPrStatus` so the
// poller's live refresh is a no-op change, not a silent regression.
function buildMockPull({ headSha, baseSha, additions, deletions }) {
  return {
    id: 5001,
    number: 501,
    node_id: 'PR_split_501',
    html_url: `https://github.com/${MOCK_OWNER}/${MOCK_REPO}/pull/501`,
    url: `https://api.github.com/repos/${MOCK_OWNER}/${MOCK_REPO}/pulls/501`,
    title: 'Large PR ready to split',
    body: 'Seeded open PR for Split PR UI automation.',
    state: 'open',
    draft: false,
    merged_at: null,
    closed_at: null,
    merge_commit_sha: null,
    merged_by: null,
    mergeable: true,
    mergeable_state: 'clean',
    comments: 0,
    review_comments: 0,
    additions,
    deletions,
    changed_files: 1,
    created_at: '2026-04-10T12:00:00Z',
    updated_at: '2026-04-10T12:00:00Z',
    user: { login: MOCK_OWNER },
    labels: [],
    assignees: [],
    requested_reviewers: [],
    head: {
      ref: WORKTREE_BRANCH,
      sha: headSha,
      repo: { full_name: `${MOCK_OWNER}/${MOCK_REPO}` },
    },
    base: {
      ref: 'main',
      sha: baseSha,
      repo: { full_name: `${MOCK_OWNER}/${MOCK_REPO}` },
    },
  };
}

/** A structurally valid, snapshot-consistent `SplitPlan`: one child owns the
 * whole added file, `unassignedHunks` is empty, and aggregate line stats
 * match the single-file addition built by `buildGithubTopology`. */
function buildValidSplitPlan(addedFile) {
  return {
    finalGoal: 'Land the seeded feature file as its own reviewable child PR.',
    concerns: [{ concern: 'New file addition', kind: 'behavior' }],
    children: [
      {
        index: 1,
        title: 'feat: add split PR feature file',
        type: 'feature',
        dependsOn: [],
        changes: [{ file: addedFile, hunks: 'all' }],
        renames: [],
        testProof: 'Covered by the Split PR E2E fixture.',
        risk: 'low',
        rationale: 'Single self-contained new file.',
      },
    ],
    parallelizable: 'N/A — single child.',
    landOrder: '1',
    buildTestCommand: 'npm test',
    unassignedHunks: [],
  };
}

/** Structurally valid (`isSplitPlan` passes) but fails `validateSplitPlan`:
 * the child declares NO changes at all, so the added file's hunk has no
 * owning child (`unassigned-hunk`, severity `error`), and the aggregate line
 * stats mismatch the snapshot totals (`aggregate-mismatch`, severity
 * `error`). Used only via IPC-handler stubbing (see file header) since the
 * real fixture-hook round trip would refuse this before ever reaching the
 * modal. */
function buildInvalidSplitPlan() {
  return {
    finalGoal: 'Intentionally invalid plan for Approve-disabled coverage.',
    concerns: [],
    children: [
      {
        index: 1,
        title: 'feat: incomplete split',
        type: 'feature',
        dependsOn: [],
        changes: [],
        renames: [],
        testProof: '',
        risk: 'low',
        rationale: 'Deliberately leaves the diff unassigned.',
      },
    ],
    parallelizable: 'N/A',
    landOrder: '1',
    buildTestCommand: '',
    unassignedHunks: [],
  };
}

async function registerSplitPrScenario(pull) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, MOCK_PAT, {
    github: { pulls: [pull] },
  });
}

async function seedGithubPatThroughUi(app, win) {
  await app.openSettings();
  await app.openAccountSettingsPage('integrations');
  const githubPanel = win.getByTestId('auth-panel-github');
  await expect(githubPanel).toBeVisible();
  await githubPanel
    .getByRole('button', { name: 'Personal Access Token' })
    .click();
  const patInput = win.getByTestId('auth-panel-github-pat-input');
  await expect(patInput).toBeVisible();
  await patInput.fill(MOCK_PAT);
  await expect(patInput).toHaveValue(MOCK_PAT);
  await expect
    .poll(
      async () =>
        (await win.evaluate(() => window.api.loadGitHubPat()))?.length ?? 0,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  await app.closeSettings();
}

async function selectDemoWorktree(app, win) {
  await app.openMainPage();
  const row = win.locator(
    `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
  );
  await expect(row).toBeVisible();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(win.getByTestId('activity-panel')).toBeVisible();
}

/**
 * Click `split-pr-button` against a worktree whose real main-process
 * PR-status POLLER (`github-poller.ts`) is also live for that worktree.
 *
 * The poller's very first tick fires within ~1s of app startup (its internal
 * per-queue cooldown timestamps are zero-initialized, so the first check for
 * any tracked worktree is due immediately) and unconditionally PERSISTS +
 * broadcasts whatever it fetches — including a `status: null` "no PR" result
 * when the repo has no real `origin` remote, or when `fetchRepoPrTrackingData`
 * fails for any other reason. That broadcast (`IPC_CHANNELS.githubPrStatusEvent`)
 * overwrites the renderer's `githubStore.prStatuses[key]` unconditionally
 * (`prStatuses: { ...state.prStatuses, [key]: event.status }`,
 * `stores/githubStore.ts`), clobbering a file-seeded `lastKnownPrStatus`
 * moments after `waitForShell()` returns — well before a human-paced test can
 * click the button. `git-pr-state.spec.mjs`'s `clickInjectedPrStatusButton`
 * solves the identical race for its own PR-action buttons by re-injecting the
 * desired `PrStatusEvent` immediately before every click attempt inside an
 * `expect.poll`, so the injected state always wins the last write. Reuse that
 * exact pattern here instead of trusting a one-shot file seed to survive.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@playwright/test').Page} win
 * @param {{ projectId: string, worktreeId: string, status: import('@canopy/desktop-shared/types/github').WorktreePrStatus | null }} statusPayload
 * @param {{ timeout?: number }} [options]
 */
async function clickSplitPrButtonWithStableStatus(
  electronApp,
  win,
  statusPayload,
  { timeout = 15_000 } = {},
) {
  const button = win.getByTestId('split-pr-button');
  await expect
    .poll(
      async () => {
        await injectGithubPrStatus(electronApp, statusPayload);
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

/**
 * A4-A8 changed every split-PR launch surface (worktree-row menu item, PR
 * panel button, PR status-bar button, post-failure "Plan new split" button)
 * to open the shared `SplitPreflightModal` instead of planning directly (see
 * `SplitPreflightModalHost.tsx`). This helper wraps
 * `clickSplitPrButtonWithStableStatus` and drives the pre-flight modal's
 * Start button so a fresh-launch test reaches the exact same "planning
 * kicked off" state the old direct-click flow used to land on synchronously.
 * `startSplitWorkflow` (invoked by Start) begins the real pre-flight
 * (git/GitHub checks) — callers still need their own `await expect(...)`
 * against whatever lands next (the refusal banner, or the locked
 * `split-workflow-view` with its embedded `split-plan-panel`).
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@playwright/test').Page} win
 * @param {{ projectId: string, worktreeId: string, status: import('@canopy/desktop-shared/types/github').WorktreePrStatus | null }} statusPayload
 * @param {{ timeout?: number }} [options]
 */
async function startSplitWorkflowFromButton(
  electronApp,
  win,
  statusPayload,
  { timeout = 15_000 } = {},
) {
  await clickSplitPrButtonWithStableStatus(electronApp, win, statusPayload, {
    timeout,
  });
  const preflight = win.getByTestId('split-preflight-modal');
  await expect(preflight).toBeVisible({ timeout: 15_000 });
  const start = win.getByTestId('split-preflight-start');
  await expect(start).toBeEnabled();
  await start.click();
  await expect(preflight).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// 1. Button gating — persisted-only, no live GitHub involved.
// ---------------------------------------------------------------------------

test.describe('split-pr-button gating (persisted PR status only)', () => {
  test('visible when enabled + open PR + over threshold (single-repo)', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-gate-over-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 823,
      additions: 400,
      deletions: 200, // 600 total >= 500 threshold
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const statusPayload = {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        status: {
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: buildSplitPrStatusData({
                prNumber: 823,
                additions: 400,
                deletions: 200,
              }),
            },
          ],
          lastCheckedAt: '2026-04-10T12:00:00.000Z',
        },
      };
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await selectDemoWorktree(app, win);

      await expect
        .poll(
          async () => {
            await injectGithubPrStatus(electronApp, statusPayload);
            const button = win.getByTestId('split-pr-button');
            if (!(await button.isVisible().catch(() => false))) {
              return 'hidden';
            }
            return (await button.textContent()) ?? '';
          },
          { timeout: 15_000, intervals: [100, 250, 500] },
        )
        .toContain('600 changed lines');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('hidden when under the changed-lines threshold', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-gate-under-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 824,
      additions: 100,
      deletions: 50, // 150 total < 500 threshold
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await selectDemoWorktree(app, win);

      // Give the persisted-status hydration + preferences load time to settle,
      // then assert the button never appears.
      await expect(win.getByTestId('pr-status-bar')).toBeVisible({
        timeout: 15_000,
      });
      await win.waitForTimeout(1_000);
      await expect(win.getByTestId('split-pr-button')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('hidden when the splitPrEnabled toggle is off', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-gate-off-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: false,
      splitPrThresholdLines: 500,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 825,
      additions: 400,
      deletions: 200,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await selectDemoWorktree(app, win);

      await expect(win.getByTestId('pr-status-bar')).toBeVisible({
        timeout: 15_000,
      });
      await win.waitForTimeout(1_000);
      await expect(win.getByTestId('split-pr-button')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('hidden when there is no open PR', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-gate-nopr-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
    });
    // No `seedSplitPrOpenPrStatus` call: `lastKnownPrStatus` stays absent/null.

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await selectDemoWorktree(app, win);

      // No PR at all means the Pull Requests section itself never populates,
      // so assert against the settled main page instead of the section.
      await expect(win.getByTestId('pr-status-bar')).toBeVisible({
        timeout: 15_000,
      });
      await win.waitForTimeout(1_000);
      await expect(win.getByTestId('split-pr-button')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. Plan modal via the CANOPY_TEST_SPLIT_PLAN_FIXTURE hook.
// ---------------------------------------------------------------------------

test.describe('split-pr-button click opens the plan modal (fixture hook)', () => {
  test('opens the modal with the aggregate check for a valid fixture plan; Approve is enabled', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-modal-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = (seed.workspaces ?? []).find(
      (entry) => entry.id === WORKSPACE_ID,
    );
    expect(workspace).toBeTruthy();
    const { repoPath, worktreePath } = workspace;

    const { headSha, baseSha, addedFile, additions } = buildGithubTopology(
      repoPath,
      worktreePath,
    );
    await registerSplitPrScenario(
      buildMockPull({ headSha, baseSha, additions, deletions: 0 }),
    );

    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      // `normalizePreferences()` floors this at 50 regardless, so pin the
      // seeded value there directly instead of relying on a lower value
      // getting silently raised — the added file is exactly
      // `ADDED_FILE_LINE_COUNT` (50) additions, so the `>=` gate passes exactly.
      splitPrThresholdLines: ADDED_FILE_LINE_COUNT,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 501,
      additions,
      deletions: 0,
    });

    const fixturePath = path.join(userDataDir, 'split-plan-fixture.json');
    writeJson(fixturePath, buildValidSplitPlan(addedFile));

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_TEST_SPLIT_PLAN_FIXTURE: fixturePath },
    });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await seedGithubPatThroughUi(app, win);
      await selectDemoWorktree(app, win);

      await startSplitWorkflowFromButton(electronApp, win, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        status: {
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: buildSplitPrStatusData({
                prNumber: 501,
                additions,
                deletions: 0,
              }),
            },
          ],
          lastCheckedAt: '2026-04-10T12:00:00.000Z',
        },
      });

      // Start acquires the lock and kicks off the real pre-flight plan; the
      // worktree's central panel is replaced by the locked workflow view,
      // which lands on the Review step (the embedded `split-plan-panel`)
      // once the fixture-served plan comes back.
      const workflowView = win.getByTestId('split-workflow-view');
      await expect(workflowView).toBeVisible({ timeout: 30_000 });
      await expect(
        win.getByTestId('split-workflow-step-review'),
      ).toHaveAttribute('data-active', 'true', { timeout: 30_000 });

      const panel = win.getByTestId('split-plan-panel');
      await expect(panel).toBeVisible();
      await expect(win.getByTestId('split-plan-aggregate-check')).toBeVisible();
      await expect(win.getByTestId('split-plan-build-command')).toHaveValue(
        'npm test',
      );
      await expect(win.getByTestId('split-plan-row-1')).toBeVisible();
      // A valid, snapshot-consistent plan: no error banner, aggregate matches.
      await expect(win.getByTestId('split-plan-error-banner')).toHaveCount(0);

      const approve = win.getByTestId('split-plan-approve');
      await expect(approve).toBeVisible();
      await expect(approve).toBeEnabled();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(MOCK_PAT);
    }
  });

  test('split-pr-refusal renders when the PR head is out of sync with local HEAD', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-refusal-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = (seed.workspaces ?? []).find(
      (entry) => entry.id === WORKSPACE_ID,
    );
    expect(workspace).toBeTruthy();
    const { repoPath, worktreePath } = workspace;

    const { baseSha } = buildGithubTopology(repoPath, worktreePath);
    // A stale head SHA the real worktree can never match — trips
    // `head_out_of_sync` inside `gatherPlanningInputs` (pr-split-planner.ts).
    const staleHeadSha = 'f'.repeat(40);
    await registerSplitPrScenario(
      buildMockPull({
        headSha: staleHeadSha,
        baseSha,
        additions: ADDED_FILE_LINE_COUNT,
        deletions: 0,
      }),
    );

    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: ADDED_FILE_LINE_COUNT,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 501,
      additions: ADDED_FILE_LINE_COUNT,
      deletions: 0,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await seedGithubPatThroughUi(app, win);
      await selectDemoWorktree(app, win);

      await startSplitWorkflowFromButton(electronApp, win, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        status: {
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: buildSplitPrStatusData({
                prNumber: 501,
                additions: ADDED_FILE_LINE_COUNT,
                deletions: 0,
              }),
            },
          ],
          lastCheckedAt: '2026-04-10T12:00:00.000Z',
        },
      });

      // A plan-time refusal while locked auto-exits `SplitWorkflowView`
      // (releasing the lock) so the normal UX's own refusal banner is what
      // the user lands on — see `refusalWhileLocked` in
      // `SplitWorkflowView.tsx`.
      await expect(win.getByTestId('split-pr-refusal')).toBeVisible({
        timeout: 30_000,
      });
      await expect(win.getByTestId('split-workflow-view')).toHaveCount(0);
      await expect(win.getByTestId('split-plan-panel')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(MOCK_PAT);
    }
  });
});

// ---------------------------------------------------------------------------
// 3b. Approve disabled for an invalid plan — via IPC-handler stubbing.
//
// See the file header: the real fixture-hook round trip cannot reach the
// modal with an invalid plan (the main process refuses it before rendering),
// so this exercises the modal's own `validateSplitPlan`-driven Approve gating
// directly, the same way `git-pr-state.spec.mjs` stubs PR-action IPC
// handlers for deterministic coverage of otherwise-unreachable states.
// ---------------------------------------------------------------------------

test.describe('split-plan-approve gating', () => {
  test('Approve is disabled for a structurally valid but unassigned-hunk plan', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-invalid-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = (seed.workspaces ?? []).find(
      (entry) => entry.id === WORKSPACE_ID,
    );
    expect(workspace).toBeTruthy();
    const { worktreePath } = workspace;
    const { headSha, addedFile } = commitSplitFeatureFile(worktreePath);

    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: ADDED_FILE_LINE_COUNT,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 501,
      additions: ADDED_FILE_LINE_COUNT,
      deletions: 0,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });

      // Stub the split-WORKFLOW-start IPC handler (not the standalone
      // `github:split-pr-plan` handler — the pre-flight modal's Start button
      // calls `startSplitWorkflow`, which invokes `planPrSplit` DIRECTLY
      // inside the `github:split-workflow-start` handler rather than going
      // through the `github:split-pr-plan` channel; see
      // `githubSplitWorkflowStart`'s `mode: 'plan'` branch in
      // `apps/desktop-app/src/main/ipc/github.ts`). Hand back a
      // `SplitWorkflowStartResult` carrying a structurally-valid
      // (`isSplitPlan` true) but validation-failing plan, built against a
      // minimal one-file snapshot matching `addedFile`.
      //
      // The real handler's SIDE EFFECT of acquiring the split lock (which
      // broadcasts `github:split-lock-event` — the ONLY channel
      // `githubStore.splitLockedWorktrees` listens on, per
      // `onSplitLockChange` in `githubStore.ts`) is bypassed by stubbing the
      // handler wholesale, so `SplitWorkflowView` would never mount without
      // also emitting that event here to mirror `acquireSplitLock`'s
      // broadcast.
      await electronApp.evaluate(
        (
          { ipcMain, BrowserWindow },
          { addedFile, headSha, additions, invalidPlan, projectId, worktreeId },
        ) => {
          const channel = 'github:split-workflow-start';
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, () => {
            const windows = BrowserWindow.getAllWindows();
            if (windows.length > 0) {
              windows[0].webContents.send('github:split-lock-event', {
                workspaceId: projectId,
                worktreeId,
                locked: true,
              });
            }
            return {
              mode: 'plan',
              result: {
                status: 'ok',
                response: {
                  plan: invalidPlan,
                  snapshot: {
                    baseRef: 'e2e-base-sha',
                    headRef: headSha,
                    totalAdditions: additions,
                    totalDeletions: 0,
                    files: [
                      {
                        path: addedFile,
                        kind: 'added',
                        isBinary: false,
                        additions,
                        deletions: 0,
                        hunks: [
                          {
                            file: addedFile,
                            hunkIndex: 0,
                            header: `@@ -0,0 +1,${additions} @@`,
                            contentHash: 'e2e-content-hash',
                            coreLines: ['+line 1', '+line 2', '+line 3'],
                            occurrenceIndex: 0,
                            additions,
                            deletions: 0,
                            preview: '+line 1\n+line 2\n+line 3\n…',
                          },
                        ],
                      },
                    ],
                  },
                  originalPr: {
                    prNumber: 501,
                    prUrl: `https://github.com/${'canopy-e2e'}/${'ts-pnpm-vite'}/pull/501`,
                    baseBranch: 'main',
                    headBranch: 'demo-main',
                    headSha,
                  },
                },
              },
            };
          });
        },
        {
          addedFile,
          headSha,
          additions: ADDED_FILE_LINE_COUNT,
          invalidPlan: buildInvalidSplitPlan(),
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_BRANCH,
        },
      );

      await selectDemoWorktree(app, win);

      await startSplitWorkflowFromButton(electronApp, win, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        status: {
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: buildSplitPrStatusData({
                prNumber: 501,
                additions: ADDED_FILE_LINE_COUNT,
                deletions: 0,
              }),
            },
          ],
          lastCheckedAt: '2026-04-10T12:00:00.000Z',
        },
      });

      await expect(win.getByTestId('split-workflow-view')).toBeVisible({
        timeout: 15_000,
      });

      // The sidebar row should reflect the split's Review step. PR status has
      // higher icon priority than split status, so this PR-backed workflow
      // keeps its PR icon and surfaces the split state in the subtitle.
      const worktreeRow = win.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_BRANCH}"]`,
      );
      await expect(worktreeRow).toBeVisible({ timeout: 15_000 });
      await expect(
        worktreeRow
          .getByTestId('worktree-row-subtitle')
          .getByText('Waiting for your plan approval'),
      ).toBeVisible();

      const panel = win.getByTestId('split-plan-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(win.getByTestId('split-plan-error-banner')).toBeVisible();

      const approve = win.getByTestId('split-plan-approve');
      await expect(approve).toBeVisible();
      await expect(approve).toBeDisabled();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. GitTab split-pr controls persist across reload.
// ---------------------------------------------------------------------------

test.describe('Git settings — Split PR controls (persistence)', () => {
  test('split-pr-enabled-toggle and split-pr-threshold-input persist across relaunch', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-settings-'),
    );

    const first = await launchCanopy({ userDataDir });
    try {
      const win = await first.electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('git');

      const toggle = win.getByTestId('split-pr-enabled-toggle');
      await expect(toggle).toBeVisible();
      // Default is ON (`splitPrEnabled: true` in preferences-store.ts).
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      const thresholdInput = win.getByTestId('split-pr-threshold-input');
      await expect(thresholdInput).toBeVisible();
      await expect(thresholdInput).toHaveValue('500');

      // Flip the toggle off and change the threshold through the UI only.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      await thresholdInput.fill('750');
      await thresholdInput.blur();
      await expect(thresholdInput).toHaveValue('750');
    } finally {
      await closeCanopy(first.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    const second = await launchCanopy({ userDataDir });
    try {
      const win = await second.electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('git');

      const toggle = win.getByTestId('split-pr-enabled-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      const thresholdInput = win.getByTestId('split-pr-threshold-input');
      await expect(thresholdInput).toBeVisible();
      await expect(thresholdInput).toHaveValue('750');
    } finally {
      await closeCanopy(second.electronApp, userDataDir, {
        keepUserData: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Three-surface gating with a seeded blocker (Task A9 §2).
//
// `merge_conflicts` (seeded via `buildSplitPrStatusData({ hasConflicts:
// true })`) is one of the five `SplitPrBlocker`s that disable+tooltip the
// menu item and PR-panel button. The status-bar button stays in place,
// unavailable with the same reason (REG-3025: a blocked action is shown
// disabled with why, never hidden). This is purely
// persisted-state driven (same as the button-gating describe block above):
// no live GitHub call, no poller race, since the demo repo has no real
// `origin` remote and the poller's `getRemoteUrl` short-circuits to `null`.
// ---------------------------------------------------------------------------

test.describe('split-pr three-surface gating with a seeded blocker', () => {
  test('menu item, panel button and status-bar button disabled with tooltip; clearing the blocker restores them', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-blocker-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 826,
      additions: 400,
      deletions: 200, // 600 total >= 500 threshold: eligible.
      hasConflicts: true, // merge_conflicts blocker.
    });

    const conflictedStatusPayload = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      status: {
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: buildSplitPrStatusData({
              prNumber: 826,
              additions: 400,
              deletions: 200,
              hasConflicts: true,
            }),
          },
        ],
        lastCheckedAt: '2026-04-10T12:00:00.000Z',
      },
    };

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await selectDemoWorktree(app, win);

      // This spec owns the PR-status state after selection. Suspend this target
      // through the build-gated E2E seam before injecting the fixture so an
      // already-running or later poll cannot overwrite it. Unlike repeated
      // injection, the target-scoped seam does not replace button DOM nodes
      // while Playwright is interacting with them.
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
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_BRANCH },
      );

      const panelButton = win.getByTestId('split-pr-button');
      await injectGithubPrStatus(electronApp, conflictedStatusPayload);
      await expect(panelButton).toBeDisabled({ timeout: 15_000 });

      // Status-bar button: in place but unavailable while blocked (eligible
      // but blockers > 0), with the blocker as its tooltip.
      await expect(win.getByTestId('pr-status-bar')).toBeVisible({
        timeout: 15_000,
      });
      const statusBarButton = win.getByTestId('split-pr-status-bar-button');
      await expect(statusBarButton).toHaveAttribute('aria-disabled', 'true', {
        timeout: 15_000,
      });
      await statusBarButton.hover();
      await expect(
        win.getByRole('tooltip').filter({
          hasText: 'Resolve the merge conflicts reported by GitHub first',
        }),
      ).toBeVisible({ timeout: 5_000 });
      await win.mouse.move(0, 0);

      // PR panel button: rendered, disabled, with a tooltip on hover.
      await expect
        .poll(async () => panelButton.isDisabled(), { timeout: 15_000 })
        .toBe(true);
      await panelButton.hover();
      await expect(
        win.getByText('Resolve the merge conflicts reported by GitHub first', {
          exact: false,
        }),
      ).toBeVisible({ timeout: 5_000 });

      // Worktree-row menu item: rendered, disabled, with the same tooltip.
      // With target polling suspended, the menu reads the same snapshot
      // without repeated injections that would replace its DOM node.
      const row = win.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await row.hover();
      const menuButton = win.getByTestId('worktree-actions-menu-button');
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      const menuItem = win.getByTestId('worktree-actions-menu-split-pr');
      await expect(menuItem).toBeVisible();
      await expect(menuItem).toBeDisabled();
      await menuItem.hover();
      await expect(
        win.getByText('Resolve the merge conflicts reported by GitHub first', {
          exact: false,
        }),
      ).toBeVisible({ timeout: 5_000 });
      await win.keyboard.press('Escape');

      // Clear the blocker: inject a fresh `PrStatusEvent` (same live channel
      // the main-process poller broadcasts on — see `injectGithubPrStatus`)
      // carrying `hasConflicts: false`. `useSplitPrReadiness` is a reactive
      // subscription on `githubStore.prStatuses`, so the status-bar button
      // becomes available again without a reload.
      const unblockedStatusPayload = {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        status: {
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: buildSplitPrStatusData({
                prNumber: 826,
                additions: 400,
                deletions: 200,
                hasConflicts: false,
              }),
            },
          ],
          lastCheckedAt: '2026-04-10T12:10:00.000Z',
        },
      };

      await expect
        .poll(
          async () => {
            await injectGithubPrStatus(electronApp, unblockedStatusPayload);
            const button = win.getByTestId('split-pr-status-bar-button');
            return (
              (await button.isVisible().catch(() => false)) &&
              (await button.getAttribute('aria-disabled')) !== 'true'
            );
          },
          { timeout: 15_000, intervals: [100, 250, 500] },
        )
        .toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Pre-flight modal contents (Task A9 §3).
//
// Purely persisted-state driven like the gating block above — no live
// GitHub/pre-flight round trip is needed since the modal's own content
// (steps list, lock notice, termination warning, blockers) is derived from
// `readiness` + live resource-store subscriptions, not from a plan result.
// ---------------------------------------------------------------------------

test.describe('split-preflight-modal contents', () => {
  test('shows the steps list and lock notice, no termination warning without live resources, Start enabled when ready', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-preflight-content-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 827,
      additions: 400,
      deletions: 200,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await selectDemoWorktree(app, win);

      await clickSplitPrButtonWithStableStatus(electronApp, win, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        status: {
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: buildSplitPrStatusData({
                prNumber: 827,
                additions: 400,
                deletions: 200,
              }),
            },
          ],
          lastCheckedAt: '2026-04-10T12:00:00.000Z',
        },
      });

      const modal = win.getByTestId('split-preflight-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });

      const steps = win.getByTestId('split-preflight-steps');
      await expect(steps).toBeVisible();
      await expect(steps).toContainText('Plan');
      await expect(steps).toContainText('Review');
      await expect(steps).toContainText('Finalize');

      await expect(
        win.getByTestId('split-preflight-lock-notice'),
      ).toBeVisible();
      await expect(
        win.getByTestId('split-preflight-lock-notice'),
      ).toContainText('locked while the split runs');

      // No terminals/browsers/scripts are running for this fresh worktree.
      await expect(
        win.getByTestId('split-preflight-termination-warning'),
      ).toHaveCount(0);
      // No blockers seeded: readiness is clean.
      await expect(win.getByTestId('split-preflight-blockers')).toHaveCount(0);

      const start = win.getByTestId('split-preflight-start');
      await expect(start).toBeVisible();
      await expect(start).toBeEnabled();

      // Cancel exits the modal without starting the workflow. Re-inject the
      // same PR status (poller-clobber guard, same pattern as
      // `clickSplitPrButtonWithStableStatus`) before the final check so a
      // live poller tick landing right after Cancel can't transiently hide
      // the button.
      await win.getByTestId('split-preflight-cancel').click();
      await expect(modal).toHaveCount(0);
      await expect(win.getByTestId('split-workflow-view')).toHaveCount(0);
      const panelButton = win.getByTestId('split-pr-button');
      await expect
        .poll(
          async () => {
            await injectGithubPrStatus(electronApp, {
              projectId: WORKSPACE_ID,
              worktreeId: WORKTREE_BRANCH,
              status: {
                repos: [
                  {
                    repoId: WORKSPACE_ID,
                    repoName: 'repo',
                    status: buildSplitPrStatusData({
                      prNumber: 827,
                      additions: 400,
                      deletions: 200,
                    }),
                  },
                ],
                lastCheckedAt: '2026-04-10T12:20:00.000Z',
              },
            });
            return panelButton.isVisible();
          },
          { timeout: 15_000, intervals: [100, 250, 500] },
        )
        .toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('lists an open in-app browser in the termination warning, and drops it once the browser closes', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-preflight-browser-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 828,
      additions: 400,
      deletions: 200,
    });
    const prStatus = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      status: {
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: buildSplitPrStatusData({
              prNumber: 828,
              additions: 400,
              deletions: 200,
            }),
          },
        ],
        lastCheckedAt: '2026-04-10T12:00:00.000Z',
      },
    };

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await selectDemoWorktree(app, win);

      // Open an in-app browser through the panel `+` menu and wait for its
      // backend session to go live; the preflight counts live sessions.
      const browserTabs = win.locator(
        '[data-testid^="panel-tab-panel-browser-"]:not([data-testid*="panel-tab-close"])',
      );
      await win.getByTestId('panel-add-tab-group-terminal').click();
      await expect(win.getByTestId('panel-add-menu')).toBeVisible();
      await win.getByTestId('panel-add-menu-item-browser').click();
      await expect(browserTabs).toHaveCount(1);
      const browserPanelId = (
        await browserTabs.first().getAttribute('data-testid')
      ).replace(/^panel-tab-/, '');
      const browserId = browserPanelId.replace(/^panel-browser-/, '');
      await expect(
        win.getByTestId(`browser-pane-${browserId}`),
      ).toHaveAttribute('data-browser-state', 'live', { timeout: 30_000 });

      await clickSplitPrButtonWithStableStatus(electronApp, win, prStatus);
      const modal = win.getByTestId('split-preflight-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      const warning = win.getByTestId('split-preflight-termination-warning');
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('1 browser tab');
      await win.getByTestId('split-preflight-cancel').click();
      await expect(modal).toHaveCount(0);

      // Closing the browser removes it from the warning. The close control is
      // revealed on hover, and the tab title still wins hit-testing over it,
      // so the click is forced (as archive-worktree-chat.spec.mjs does).
      await browserTabs.first().hover();
      await win
        .getByTestId(`panel-tab-close-${browserPanelId}`)
        .click({ force: true });
      await expect(browserTabs).toHaveCount(0);
      await clickSplitPrButtonWithStableStatus(electronApp, win, prStatus);
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await expect(warning).toHaveCount(0);
      await win.getByTestId('split-preflight-cancel').click();
      await expect(modal).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Workflow view + lockdown smoke (Task A9 §4).
//
// Reuses the real fixture-hook pre-flight topology from the "opens the plan
// modal" describe block above (real single-repo worktree, real git origin +
// synthesized `origin/main`, mock GitHub `open-pr` scenario, GitHub PAT
// seeded through the UI, and `CANOPY_TEST_SPLIT_PLAN_FIXTURE`), then drives
// the FULL pre-flight -> Start -> locked workflow -> lockdown-guard ->
// Cancel -> unlock path.
//
// Lockdown assertion choice: while locked, `pipeline-dispatch-open` (the
// UI's only pipeline-start affordance) is NOT unmounted but hidden via the
// `worktree-central-panels` wrapper's `className="hidden"` (see
// `WorktreeManager.tsx`), so it fails Playwright visibility checks and can't
// be clicked through the UI at all while locked — there is no UI path to
// exercise the guard. The strongest reachable assertion is therefore to
// drive the REAL renderer-to-main IPC call directly:
// `window.pipelines.execute(...)` via `page.evaluate`, scoped
// `{ scope: 'worktree', projectId, worktreeId }` for the locked worktree.
// `startPipelineExecutionFromMain` (`pipeline-handlers.ts`) calls
// `assertNotSplitLocked` before any other work and, on throw, the handler's
// catch returns a RESOLVED `{ success: false, error: <SplitLockError.message> }`
// (not a rejected promise — `formatPipelineExecutionError` stringifies any
// thrown `Error`), so the refusal is asserted on the resolved `IPCResult`
// rather than a catch block.
// ---------------------------------------------------------------------------

test.describe('split-workflow-view + lockdown smoke', () => {
  test('Start locks the worktree and runs Plan -> Review; a guarded IPC call refuses while locked; Cancel unlocks', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-workflow-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = (seed.workspaces ?? []).find(
      (entry) => entry.id === WORKSPACE_ID,
    );
    expect(workspace).toBeTruthy();
    const { repoPath, worktreePath } = workspace;

    const { headSha, baseSha, addedFile, additions } = buildGithubTopology(
      repoPath,
      worktreePath,
    );
    await registerSplitPrScenario(
      buildMockPull({ headSha, baseSha, additions, deletions: 0 }),
    );

    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: ADDED_FILE_LINE_COUNT,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 501,
      additions,
      deletions: 0,
    });

    const fixturePath = path.join(
      userDataDir,
      'split-plan-fixture-workflow.json',
    );
    writeJson(fixturePath, buildValidSplitPlan(addedFile));

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_TEST_SPLIT_PLAN_FIXTURE: fixturePath },
    });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await seedGithubPatThroughUi(app, win);
      await selectDemoWorktree(app, win);

      await startSplitWorkflowFromButton(electronApp, win, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_BRANCH,
        status: {
          repos: [
            {
              repoId: WORKSPACE_ID,
              repoName: 'repo',
              status: buildSplitPrStatusData({
                prNumber: 501,
                additions,
                deletions: 0,
              }),
            },
          ],
          lastCheckedAt: '2026-04-10T12:00:00.000Z',
        },
      });

      const workflowView = win.getByTestId('split-workflow-view');
      await expect(workflowView).toBeVisible({ timeout: 30_000 });
      // Plan step runs first (real pre-flight + fixture-served plan), then
      // Review becomes active once the plan lands.
      await expect(
        win.getByTestId('split-workflow-step-review'),
      ).toHaveAttribute('data-active', 'true', { timeout: 30_000 });
      await expect(win.getByTestId('split-plan-panel')).toBeVisible();

      // The normal central panel is hidden (not unmounted) while locked —
      // the Pipeline Dispatch button is unreachable through the UI.
      await expect(win.getByTestId('worktree-central-panels')).toHaveClass(
        /hidden/,
      );

      // Lockdown guard: a direct worktree-scoped pipeline EXECUTE IPC call
      // must refuse with the typed `SplitLockError` message while locked.
      const executeResult = await win.evaluate(
        async ({ projectId, worktreeId, cwd }) => {
          const pipeline = {
            name: 'e2e-lockdown-probe',
            on: 'dispatch',
            jobs: {
              noop: { name: 'Noop', steps: [{ id: 'noop', run: 'true' }] },
            },
          };
          return window.pipelines.execute(pipeline, {
            cwd,
            pipelineId: 'e2e-lockdown-probe',
            scope: 'worktree',
            projectId,
            worktreeId,
          });
        },
        {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_BRANCH,
          cwd: worktreePath,
        },
      );
      expect(executeResult.success).toBe(false);
      expect(executeResult.error).toContain(
        'This worktree is locked while a Split PR is in progress',
      );
      expect(executeResult.error).toContain('running a workflow');

      // Cancel exits the locked workflow; normal UX (and a launch surface)
      // returns. Assert via the status-bar button (fully ready: eligible +
      // zero blockers, matching this scenario's real mock-server PR) rather
      // than the PR-panel button, which can sit scrolled out of the
      // activity panel's viewport depending on section order.
      await win.getByTestId('split-plan-cancel').click();
      await expect(workflowView).toHaveCount(0);
      await expect(win.getByTestId('worktree-central-panels')).not.toHaveClass(
        /hidden/,
      );
      await expect(win.getByTestId('split-pr-status-bar-button')).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(MOCK_PAT);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Interrupted-split modal (Task A9 §5).
//
// Seeds an open PR plus a persisted `SplitPrMap` with `status: 'executing'`
// directly (via `seedInterruptedSplitMap`) with NO live split lock (the lock is
// in-memory-only and never survives a fresh app launch — see
// `split-lock-service.ts`), which `PullRequestSection`'s `staleExecutingMap`
// detection treats as a crash/reload remnant. The open PR keeps the shared
// Activity panel's Pull Request section mounted so it can hydrate the split map.
// ---------------------------------------------------------------------------

test.describe('split-interrupted-modal', () => {
  test('shows on worktree open for a stale executing split map; Dismiss closes it', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-splitpr-interrupted-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedSplitPrPreferences({
      userDataDir,
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
    });
    seedSplitPrOpenPrStatus({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 828,
      additions: 400,
      deletions: 200,
    });
    seedInterruptedSplitMap({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      prNumber: 828,
      childCount: 2,
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await selectDemoWorktree(app, win);

      const modal = win.getByTestId('split-interrupted-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await expect(
        win.getByTestId('split-interrupted-resume-note'),
      ).toBeVisible();
      await expect(modal).toContainText('2 children');

      await win.getByTestId('split-interrupted-dismiss').click();
      await expect(modal).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
