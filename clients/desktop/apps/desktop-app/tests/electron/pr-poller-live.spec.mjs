import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';

// Doc 8 — auto-firing PR-status poller against the build-gated GitHub mock.
//
// The desktop PR-status poller (apps/desktop-app/src/main/lib/github-poller.ts)
// auto-fires when a worktree is foregrounded: selecting a worktree in the
// renderer calls `window.api.github.setForegroundWorktree` (chatStore.ts), which
// the main process maps to the poller's `setForegroundWorktree` → priority queue
// → `refreshNow`. For each repo, `refreshNow` calls `fetchRepoPrTrackingData`
// (lib/github-pr.ts), which:
//   1. reads the repo's `origin` remote URL and parses it for `owner/repo`
//      (`parseGitHubRemote`); a repo with NO GitHub origin is skipped (its
//      `status` stays null and the section is never populated);
//   2. drives Octokit (`octokit.pulls.list` + `pulls.get` + `checks.listForRef`
//      + `pulls.listReviews`). Under an E2E build (`if (__CANOPY_E2E__)`),
//      `github-client.ts` sets Octokit's `baseUrl` to
//      `CANOPY_GITHUB_API_BASE_URL` (the shared mock server), so those REST
//      calls hit `mock-server/routes/github.mjs` instead of live GitHub.
//
// This spec proves the auto-firing poller reaches the redirected GitHub REST
// surface for a seeded, origin-backed worktree and renders the mock's
// deterministic state in the Pull Requests activity section
// (`PullRequestSection.tsx`, `pr-status-badge` testid).
//
// ─────────────────────────────────────────────────────────────────────────────
// Determinism: no live agents, no live GitHub, no real push. The `origin` URL is
// a parseable GitHub HTTPS URL only — the poller performs no git network ops
// against it (only Octokit, which is redirected to the mock).

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_BRANCH = 'demo-main';

// A GitHub-format HTTPS origin so `parseGitHubRemote` yields owner/repo. The URL
// is never fetched/pushed — the poller only drives Octokit (mock-redirected).
const MOCK_OWNER = 'canopy-e2e';
const MOCK_REPO = 'ts-pnpm-vite';
const MOCK_ORIGIN_URL = `https://github.com/${MOCK_OWNER}/${MOCK_REPO}.git`;

// The PAT we seed via the UI. We register the github scenario under this exact
// string so the wiring is correct should the mock later key off the `token`
// scheme (see the limitation note above).
const MOCK_PAT = 'ghp_e2e_pr_poller_scenario_key';
const MOCK_FALLBACK_SCENARIO_KEY = '__github-rest-fallback__';
const ANCIENT_CHECKED_AT = '2000-01-01T00:00:00.000Z';

const MOCK_BASE_URL = DEFAULT_MOCK_BASE_URL;

async function registerScenario(key, scenario) {
  // The shared mock server is started by Playwright's `webServer` block and its
  // `/healthz` URL is reachable before tests run; a small retry absorbs any
  // brief cold-start window so registration never races the server boot.
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${MOCK_BASE_URL}/__mock/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, scenario }),
      });
      if (!response.ok) {
        throw new Error(
          `Mock scenario register responded ${response.status}: ${await response.text()}`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `Failed to register mock scenario after retries: ${String(lastError)}`,
  );
}

async function clearScenario(key) {
  await fetch(`${MOCK_BASE_URL}/__mock/state/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

function readWorktrees(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

async function requestFastRefreshAndWaitForUpdate(
  win,
  { projectId, worktreeId, skipIfFresh, timeoutMs = 10_000 },
) {
  return win.evaluate(
    ({
      projectId: requestedProjectId,
      worktreeId: requestedWorktreeId,
      skip,
      timeout,
    }) =>
      new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error('Timed out waiting for PR status update'));
        }, timeout);
        unsubscribe = window.api.github.onPrStatusUpdate((event) => {
          if (
            event.projectId !== requestedProjectId ||
            event.worktreeId !== requestedWorktreeId
          ) {
            return;
          }
          clearTimeout(timer);
          unsubscribe();
          resolve(event);
        });
        Promise.resolve(
          window.api.github.requestFastRefresh({
            projectId: requestedProjectId,
            worktreeId: requestedWorktreeId,
            skipIfFresh: skip,
          }),
        ).catch((error) => {
          clearTimeout(timer);
          unsubscribe();
          reject(error);
        });
      }),
    { projectId, worktreeId, skip: skipIfFresh, timeout: timeoutMs },
  );
}

async function requestFastRefreshAndObserveNoUpdate(
  win,
  { projectId, worktreeId, observationMs = 2_500 },
) {
  return win.evaluate(
    ({
      projectId: requestedProjectId,
      worktreeId: requestedWorktreeId,
      timeout,
    }) =>
      new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => {
          unsubscribe();
          resolve(null);
        }, timeout);
        unsubscribe = window.api.github.onPrStatusUpdate((event) => {
          if (
            event.projectId !== requestedProjectId ||
            event.worktreeId !== requestedWorktreeId
          ) {
            return;
          }
          clearTimeout(timer);
          unsubscribe();
          resolve(event);
        });
        Promise.resolve(
          window.api.github.requestFastRefresh({
            projectId: requestedProjectId,
            worktreeId: requestedWorktreeId,
            skipIfFresh: true,
          }),
        ).catch((error) => {
          clearTimeout(timer);
          unsubscribe();
          reject(error);
        });
      }),
    { projectId, worktreeId, timeout: observationMs },
  );
}

test.describe('Auto-firing PR-status poller against the GitHub mock (Doc 8)', () => {
  test('poller auto-fires for an origin-backed worktree, reaches the redirected REST mock, and renders an open PR', async () => {
    await registerScenario(MOCK_PAT, {
      github: { variant: 'open-pr' },
    });
    // A relaunched app cannot recover the plaintext PAT from Electron's
    // process-local safeStorage fixture, so the GitHub mock deliberately offers
    // a fallback scenario for cross-process lifecycle coverage.
    await registerScenario(MOCK_FALLBACK_SCENARIO_KEY, {
      github: { variant: 'open-pr' },
    });

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-pr-poller-'),
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
    const worktreesFilePath = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'worktrees.json',
    );
    const refreshLedgerFilePath = path.join(
      userDataDir,
      'github-refresh-ledger.json',
    );
    const seededWorktree = readWorktrees(worktreesFilePath).worktrees.find(
      (entry) => entry.branchName === WORKTREE_BRANCH,
    );
    expect(seededWorktree?.id).toBeTruthy();
    const worktreeId = seededWorktree.id;

    // Attach a GitHub-format origin to the source repo. A git worktree shares
    // the parent repo's config, so `getRemoteUrl` resolves it from the worktree
    // path and `parseGitHubRemote` yields `canopy-e2e/ts-pnpm-vite`. Nothing is
    // ever fetched or pushed against this URL.
    execFileSync(
      'git',
      ['-C', repoPath, 'remote', 'add', 'origin', MOCK_ORIGIN_URL],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const originUrl = execFileSync(
      'git',
      ['-C', worktreePath, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8' },
    ).trim();
    expect(originUrl).toBe(MOCK_ORIGIN_URL);

    let electronApp = null;
    try {
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });

      // ---- Seed the PAT through the UI so a GitHub token is available. ----
      // Without a token, `getOctokit` throws and the poller never reaches the
      // REST mock. Seeding the PAT (saveGitHubPat) invalidates the token cache
      // and resets the Octokit client, so the next poll carries it.
      await app.openSettings();
      await app.openAccountSettingsPage('integrations');

      const githubPanel = win.getByTestId('auth-panel-github');
      await expect(githubPanel).toBeVisible();
      // The GitHub panel defaults to CLI-managed (oauth) mode when no PAT is
      // stored. Switch to the Personal Access Token tab to reveal the input.
      await githubPanel
        .getByRole('button', { name: 'Personal Access Token' })
        .click();
      const patInput = win.getByTestId('auth-panel-github-pat-input');
      await expect(patInput).toBeVisible();
      await patInput.fill(MOCK_PAT);
      await expect(patInput).toHaveValue(MOCK_PAT);
      // The save is debounced (~600ms); allow it to persist + invalidate caches
      // before the poll reads the token.
      await expect
        .poll(
          async () =>
            (await win.evaluate(() => window.api.loadGitHubPat()))?.length ?? 0,
          {
            timeout: 10_000,
          },
        )
        .toBeGreaterThan(0);

      await app.closeSettings();

      // ---- Select the worktree → foregrounds it → poller fires. ----
      await app.openMainPage();
      const row = win.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(win.getByTestId('panel-content-chat')).toBeVisible();

      // The PR status bar mounts immediately for the origin-backed worktree.
      await expect(win.getByTestId('pr-status-bar')).toBeVisible();

      // The Pull Requests activity section lives in the activity panel, which
      // renders expanded inside the panel grid (no collapse chrome). Wait for
      // the panel content so the section (entirely absent until a poll first
      // sets `prStatus`) can show.
      await expect(
        win.getByTestId('panel-content-activity-section'),
      ).toBeVisible();

      // The poller is async (immediate-tick delay + Octokit round-trips to the
      // mock). Assert the open-PR fixture, not merely the section shell, so a
      // swallowed GitHub client failure cannot satisfy this test as "no PR".
      await expect(win.getByText('Pull requests')).toBeVisible({
        timeout: 45_000,
      });
      // Scope inside the activity panel's content frame: the panel-grid
      // cutover wrapped the whole worktree content area in a `<section>`
      // (worktree-part), so an unscoped `locator('section')` now matches two
      // ancestors of the Pull Requests heading (strict-mode violation).
      const pullRequestSection = win
        .getByTestId('panel-content-activity-section')
        .locator('section')
        .filter({
          has: win.getByRole('heading', { name: 'Pull requests' }),
        });
      await expect(pullRequestSection.getByText('1 pull request')).toBeVisible({
        timeout: 45_000,
      });
      await expect(pullRequestSection.getByText('PR #101')).toBeVisible({
        timeout: 45_000,
      });
      await expect(
        pullRequestSection.getByText('Add E2E mock PR'),
      ).toBeVisible();
      await expect(
        pullRequestSection.getByTestId('pr-status-badge'),
      ).toBeVisible();
      await expect(
        pullRequestSection.getByText('Checks (2/2 passing)'),
      ).toBeVisible();
      await expect(
        pullRequestSection.getByText('build', { exact: true }),
      ).toBeVisible();
      await expect(
        pullRequestSection.getByText('test', { exact: true }),
      ).toBeVisible();

      // Labels section renders the mock PR's labels as GitHub-style pills below
      // the Reviews section. The mock `open-pr` fixture carries `bug` and
      // `enhancement` labels.
      const labelsSection = pullRequestSection.getByTestId('pr-labels-section');
      await expect(labelsSection).toBeVisible();
      await expect(labelsSection.getByText('Labels')).toBeVisible();
      await expect(
        labelsSection.getByTestId('pr-label').filter({ hasText: 'bug' }),
      ).toBeVisible();
      await expect(
        labelsSection
          .getByTestId('pr-label')
          .filter({ hasText: 'enhancement' }),
      ).toBeVisible();

      // Characterize the relaunch freshness bug before changing production
      // code. The successful forced refresh below returns the same PR payload,
      // so the current persistence optimization leaves this deliberately stale
      // timestamp in worktrees.json even though the in-memory entry is fresh.
      const persistedAfterInitialPoll = readWorktrees(worktreesFilePath);
      const initiallyPolledWorktree = persistedAfterInitialPoll.worktrees.find(
        (entry) => entry.id === worktreeId,
      );
      expect(initiallyPolledWorktree?.lastKnownPrStatus?.repos?.length).toBe(1);
      initiallyPolledWorktree.lastKnownPrStatus.lastCheckedAt =
        ANCIENT_CHECKED_AT;
      writeFileSync(
        worktreesFilePath,
        `${JSON.stringify(persistedAfterInitialPoll, null, 2)}\n`,
        'utf8',
      );

      const unchangedRefresh = await requestFastRefreshAndWaitForUpdate(win, {
        projectId: workspace.id,
        worktreeId,
        skipIfFresh: false,
      });
      expect(unchangedRefresh.status.repos).toEqual(
        initiallyPolledWorktree.lastKnownPrStatus.repos,
      );
      expect(unchangedRefresh.status.lastCheckedAt).not.toBe(
        ANCIENT_CHECKED_AT,
      );
      await expect
        .poll(
          () =>
            readWorktrees(worktreesFilePath).worktrees.find(
              (entry) => entry.id === worktreeId,
            )?.lastKnownPrStatus?.lastCheckedAt,
          { timeout: 5_000 },
        )
        .toBe(ANCIENT_CHECKED_AT);
      await expect
        .poll(
          () => {
            try {
              const lastSuccessAt = JSON.parse(
                readFileSync(refreshLedgerFilePath, 'utf8'),
              ).entries?.[`${workspace.id}/${worktreeId}`]?.lastSuccessAt;
              return (
                Date.parse(lastSuccessAt ?? '') >=
                Date.parse(unchangedRefresh.status.lastCheckedAt)
              );
            } catch {
              return false;
            }
          },
          {
            timeout: 10_000,
            message: 'unchanged refresh success persisted to sidecar ledger',
          },
        )
        .toBe(true);

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = null;

      ({ electronApp } = await launchCanopy({ userDataDir }));
      const relaunchedWindow = await electronApp.firstWindow();
      const relaunchedApp = new CanopyAppDriver(relaunchedWindow);
      await relaunchedApp.waitForShell({ timeout: 30_000 });
      await relaunchedApp.openMainPage();
      await expect(
        relaunchedWindow.locator(
          `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
        ),
      ).toBeVisible();

      // The unchanged success is now durable independently of worktrees.json,
      // so skipIfFresh must not enqueue another GitHub request after relaunch.
      const redundantRefresh = await requestFastRefreshAndObserveNoUpdate(
        relaunchedWindow,
        {
          projectId: workspace.id,
          worktreeId,
        },
      );
      expect(redundantRefresh).toBeNull();
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
      await clearScenario(MOCK_PAT);
      await clearScenario(MOCK_FALLBACK_SCENARIO_KEY);
    }
  });
});
