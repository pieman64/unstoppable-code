import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { saveGitHubPat } from './helpers/github-pat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';

// ECW-8121 (Task 13) — Electron UI automation for the tabbed "Create-from"
// dropdown that Tasks 10–12 shipped. The Home composer's branch picker
// (`home-branch-picker-button`) is now a Conductor-style tabbed dropdown
// (New worktree · PRs · Branches · Issues) that REPLACED both the old flat
// branch list and the standalone `home-create-from-button` (which is gone).
//
// Entry point: the standalone Home page reached by `sidebar-create-task` — the
// same scaffolding `home-surface.spec.mjs` uses — is the most robust surface
// the harness reaches (no worktree selection or Code-tab empty-state
// prerequisite), so both dropdown tests drive the picker from there.
//
// Coverage:
//   Test 1 — the Branches-tab happy path end to end: open the picker, switch
//     to the Branches tab, filter, select the seeded `existing-feature-branch`,
//     confirm the trigger label updates, send a short message, and assert the
//     created sidebar worktree row is checked out on that branch.
//   Test 2 — the search auto-detect: a pasted GitHub PR URL typed from the
//     Branches tab flips the active tab to PRs (whose offline fetch surfaces a
//     graceful error state). The seeded repo has no remote, so the cross-repo
//     scan matches no workspace and the "Add {owner}/{repo} as a project…"
//     offer row replaces the resolve row. A manual click back to Branches
//     sticks.
//   Test 3 — CAN-4529 title-search fallback: 51 open PRs, where the target is
//     the oldest and so outside the 50-row initial list. Searching its title
//     word finds it under "From GitHub" through one mocked GraphQL search;
//     selecting it and sending creates the worktree on its head branch.
//
// The Create Task modal (`create-task-modal`) still exists with its four
// Branch/PR/Linear pills, but it no longer has a harness-reachable open path.
// Its former `requestCreateTask` navigationStore plumbing (whose only caller,
// the Home "Create from…" button, was replaced by the tabbed dropdown) was
// removed as dead code. The modal's only live opener is WorktreeManager's
// kanban titlebar direct-open button, gated on the sidebar being hidden, which
// the harness cannot reach (the kanban nav is only reachable while the sidebar
// is shown, and `sidebar-toggle` is a no-op once on the kanban page). The
// modal's pill rendering and the bidirectional auto-detect are covered at unit
// level instead
// (`CreateTaskModal` / `HomeBranchPicker` unit tests + `detectCreateFromReference`).

const DEMO_APP_ID = 'ts-pnpm-vite';
const WORKSPACE_ID = `demo-${DEMO_APP_ID}`;
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const BRANCH_NAME = 'existing-feature-branch';

// CAN-4529 PR title search. The mock keys scenarios by bearer token, so this
// test owns its token and request records.
const PR_SEARCH_TOKEN = 'ghp_e2e_pr_picker_search';
const PR_SEARCH_REPO = 'acme/demo';
const PR_SEARCH_TARGET = 113;
const PR_SEARCH_TITLE = 'Older login rework';
const PR_SEARCH_HEAD = 'feat/older-login-rework';
const PR_SEARCH_FILLER_NEWEST = 250;

function mockPull(number, title, headRef, updatedAt) {
  const repo = { full_name: PR_SEARCH_REPO };
  return {
    id: 10_000 + number,
    number,
    html_url: `https://github.com/${PR_SEARCH_REPO}/pull/${number}`,
    title,
    state: 'open',
    draft: false,
    updated_at: updatedAt,
    user: { login: 'canopy-e2e' },
    head: { ref: headRef, sha: 'a'.repeat(40), repo },
    base: { ref: 'main', repo },
  };
}

// 50 recently updated fillers plus one older target, which ranks 51st.
async function setPrSearchScenario() {
  const pulls = [
    mockPull(
      PR_SEARCH_TARGET,
      PR_SEARCH_TITLE,
      PR_SEARCH_HEAD,
      '2026-01-01T00:00:00Z',
    ),
  ];
  for (let index = 0; index < 50; index += 1) {
    const number = PR_SEARCH_FILLER_NEWEST - index;
    const minute = String(59 - index).padStart(2, '0');
    pulls.push(
      mockPull(
        number,
        `Filler change ${number}`,
        `filler/${number}`,
        `2026-10-01T00:${minute}:00Z`,
      ),
    );
  }
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key: PR_SEARCH_TOKEN,
      scenario: { github: { pulls } },
    }),
  });
  expect(response.ok).toBe(true);
}

async function prPickerSearchQueries() {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(PR_SEARCH_TOKEN)}`,
  );
  expect(response.ok).toBe(true);
  const { scenario } = await response.json();
  return (scenario.github?.prPickerSearchRequests ?? []).map(
    (entry) => entry.q,
  );
}

// Seed a single-repo demo workspace (no worktree, so the post-flow sidebar row
// count is unambiguous) and create `existing-feature-branch` in its source repo
// BEFORE launch so the picker's Branches tab can offer it as a checkout target.
function seedWorkspaceWithBranch(userDataDir) {
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: [DEMO_APP_ID],
    createWorktrees: false,
  });
  const workspace = seed.workspaces.find((entry) => entry.id === WORKSPACE_ID);
  if (!workspace?.repoPath) {
    throw new Error(
      `seedWorkspaceWithBranch: missing repoPath for ${WORKSPACE_ID}`,
    );
  }
  execFileSync('git', ['branch', BRANCH_NAME], { cwd: workspace.repoPath });
  return seed;
}

// Navigate to the standalone Home page and wait for the seeded workspace to be
// the auto-selected send target (so the non-cowork branch picker renders).
async function openHomeWithWorkspace(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });

  await window.getByTestId('sidebar-create-task').click();
  const homePage = window.getByTestId('page-home');
  await expect(homePage).toBeVisible();
  await expect(homePage.getByTestId('home-workspace-select')).toContainText(
    WORKSPACE_NAME,
  );
  return homePage;
}

test.describe('Create-from dropdown', () => {
  test('Branches tab end-to-end: filter, select the branch, send, and the worktree is checked out on it', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-create-from-branch-'),
    );
    seedWorkspaceWithBranch(userDataDir);

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const homePage = await openHomeWithWorkspace(window);

      // Open the tabbed picker and switch to the Branches tab.
      const trigger = homePage.getByTestId('home-branch-picker-button');
      await trigger.click();
      await window.getByTestId('home-branch-picker-tab-branches').click();
      await expect(
        window.getByTestId('home-branch-picker-tab-branches'),
      ).toHaveAttribute('aria-selected', 'true');

      // Filter to the seeded branch (a plain branch-like fragment never
      // switches tabs — only PR/Linear references auto-detect) and select it.
      await window
        .getByTestId('home-branch-picker-search')
        .fill('existing-feature');
      const branchRow = window.getByTestId(
        `home-branch-picker-branch-${BRANCH_NAME}`,
      );
      await expect(branchRow).toBeVisible({ timeout: 30_000 });
      await branchRow.click();

      // The trigger label now shows the selected branch (the picker closed).
      await expect(trigger).toContainText(BRANCH_NAME);

      // Send a short message. The branch target maps to an `existingBranch`
      // create option, so the send provisions a worktree checked out on the
      // branch and navigates to Code (the Home page unmounts).
      await homePage.getByTestId('home-composer-editor').click();
      await homePage
        .getByTestId('home-composer-editor')
        .fill('Look at the existing feature branch.');
      await homePage.getByTestId('home-send-button').click();

      await expect(homePage).toHaveCount(0);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible({
        timeout: 15_000,
      });

      // The new sidebar worktree row is the branch checkout (reusing the
      // `worktree-row` + `data-branch` locator pattern). This workspace was
      // seeded with zero worktrees, so the row unambiguously belongs to the
      // Branches-tab flow.
      const worktreeRow = window.locator(
        `[data-testid="worktree-row"][data-branch="${BRANCH_NAME}"]`,
      );
      await expect(worktreeRow).toBeVisible({ timeout: 60_000 });
      await expect(worktreeRow).toContainText(BRANCH_NAME);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('search auto-detect: a PR URL flips Branches→PRs (offline error + add-workspace offer surface), a manual tab click sticks', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-create-from-detect-'),
    );
    seedWorkspaceWithBranch(userDataDir);

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const homePage = await openHomeWithWorkspace(window);

      const branchesTab = window.getByTestId('home-branch-picker-tab-branches');
      const prsTab = window.getByTestId('home-branch-picker-tab-prs');

      // Open the picker and start on the Branches tab.
      await homePage.getByTestId('home-branch-picker-button').click();
      await branchesTab.click();
      await expect(branchesTab).toHaveAttribute('aria-selected', 'true');

      // Typing a GitHub PR URL into the shared search auto-detects a PR
      // reference and switches the active tab to PRs.
      await window
        .getByTestId('home-branch-picker-search')
        .fill('https://github.com/acme/demo/pull/12');
      await expect(prsTab).toHaveAttribute('aria-selected', 'true');
      await expect(branchesTab).toHaveAttribute('aria-selected', 'false');

      // The demo repo has no GitHub origin remote, so the open-PR list fetch
      // fails offline. The failure must surface as the error state rather than
      // hang or crash.
      await expect(
        window.getByTestId('home-branch-picker-pr-error'),
      ).toBeVisible({ timeout: 15_000 });

      // With no remote on the seeded repo, the cross-repo auto-switch scan
      // finds no workspace that owns `acme/demo`, so the offer row replaces the
      // dead-end resolve row (its click would open the pre-filled Add Workspace
      // modal — not exercised here).
      await expect(
        window.getByTestId('home-branch-picker-pr-add-workspace'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByTestId('home-branch-picker-pr-resolve'),
      ).toHaveCount(0);

      // Precondition: the search box still holds the typed PR URL, so the
      // manual click below is a genuine "stickiness" check — there is still a
      // PR reference present that a re-detect could steal focus back to.
      await expect(window.getByTestId('home-branch-picker-search')).toHaveValue(
        'https://github.com/acme/demo/pull/12',
      );

      // A manual tab click always sticks: switching back to Branches while the
      // PR URL text is still in the search does not re-detect (nothing
      // re-classifies on click), so PRs does not steal focus back.
      await branchesTab.click();
      await expect(branchesTab).toHaveAttribute('aria-selected', 'true');
      await expect(prsTab).toHaveAttribute('aria-selected', 'false');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('PR title search: finds an open PR outside the first 50, selects it, and creates the worktree on its head branch', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-create-from-pr-search-'),
    );
    const seed = seedWorkspaceWithBranch(userDataDir);
    const repoPath = seed.workspaces.find(
      (entry) => entry.id === WORKSPACE_ID,
    )?.repoPath;
    if (!repoPath) throw new Error(`missing repoPath for ${WORKSPACE_ID}`);
    // A GitHub-shaped origin scopes the list and search to acme/demo. The
    // target's head branch exists locally and as a remote-tracking ref, so
    // creating the worktree needs no network.
    execFileSync(
      'git',
      ['remote', 'add', 'origin', `https://github.com/${PR_SEARCH_REPO}.git`],
      { cwd: repoPath },
    );
    // Keep the origin unreachable: creating from an existing branch fetches
    // origin first, and a real github.com fetch stalled on the CI runner.
    execFileSync('git', ['config', 'protocol.https.allow', 'never'], {
      cwd: repoPath,
    });
    expect(() =>
      execFileSync('git', ['fetch', 'origin'], {
        cwd: repoPath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        stdio: 'pipe',
        timeout: 10_000,
      }),
    ).toThrow(/transport 'https' not allowed/);
    execFileSync('git', ['branch', PR_SEARCH_HEAD], { cwd: repoPath });
    execFileSync(
      'git',
      ['update-ref', `refs/remotes/origin/${PR_SEARCH_HEAD}`, 'HEAD'],
      { cwd: repoPath },
    );
    await setPrSearchScenario();

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      // The mock answers this test's scenario for requests bearing its PAT.
      await saveGitHubPat(window, app, PR_SEARCH_TOKEN);
      const homePage = await openHomeWithWorkspace(window);

      const trigger = homePage.getByTestId('home-branch-picker-button');
      await trigger.click();
      await window.getByTestId('home-branch-picker-tab-prs').click();

      // The initial list holds the 50 most recently updated PRs only.
      await expect(
        window.getByTestId(`home-branch-picker-pr-${PR_SEARCH_FILLER_NEWEST}`),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        window.getByTestId(`home-branch-picker-pr-${PR_SEARCH_TARGET}`),
      ).toHaveCount(0);

      await window.getByTestId('home-branch-picker-search').fill('rework');
      const results = window.getByTestId(
        'home-branch-picker-pr-search-results',
      );
      await expect(results).toContainText('From GitHub', { timeout: 15_000 });
      const targetRow = results.getByTestId(
        `home-branch-picker-pr-${PR_SEARCH_TARGET}`,
      );
      await expect(targetRow).toContainText(PR_SEARCH_TITLE);
      expect(await prPickerSearchQueries()).toEqual([
        `repo:${PR_SEARCH_REPO} is:pr is:open in:title "rework"`,
      ]);

      // Even equivalent input starts a fresh UI generation immediately. The
      // host may reuse its normalized cache once the new debounce elapses.
      await window.getByTestId('home-branch-picker-search').fill('rework ');
      await expect(
        window.getByTestId('home-branch-picker-pr-search-loading'),
      ).toBeVisible();
      await expect(targetRow).toHaveCount(0);
      await expect(targetRow).toBeVisible();
      expect(await prPickerSearchQueries()).toHaveLength(1);

      await targetRow.click();
      await expect(trigger).toContainText(`PR #${PR_SEARCH_TARGET}`);

      await homePage.getByTestId('home-composer-editor').click();
      await homePage
        .getByTestId('home-composer-editor')
        .fill('Review the older login rework.');
      await homePage.getByTestId('home-send-button').click();

      await expect(homePage).toHaveCount(0);
      const worktreeRow = window.locator(
        `[data-testid="worktree-row"][data-branch="${PR_SEARCH_HEAD}"]`,
      );
      await expect(worktreeRow).toBeVisible({ timeout: 60_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await fetch(
        `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(PR_SEARCH_TOKEN)}`,
        { method: 'DELETE' },
      ).catch(() => undefined);
    }
  });
});
