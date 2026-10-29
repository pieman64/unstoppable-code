// @capture-keep: canonical reusable PR-section visual comparison
// @capture-reference: docs/planning/2026-07-21-can-1528-pr-section-extraction/README.md
// Run with: pnpm run test:electron:captures:built can-1528-pr-section.capture-spec.ts
// Color modes: run each documented stage normally for light, then append `--dark-mode` for dark.
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  buildPrStatusData,
  buildPrStatusEvent,
  injectGithubPrStatus,
} from './seeders/index.mjs';

// CAN-1528 — desktop PullRequestSection visual-evidence captures.
//
// Renders the activity-rail Pull Requests section in its rich deterministic
// states (single-repo card with checks/reviews/labels/comments, and the
// multi-repo grouped rows with both repos expanded) via the supported
// `injectGithubPrStatus` IPC seam, then screenshots the section container.
//
// The captures are the extraction-parity evidence for the CAN-1528 brick:
// run once with `CAN1528_STAGE=before` on the pre-extraction tree and once
// with `CAN1528_STAGE=after` post-extraction; the paired PNGs under
// `.playwright/can-1528/` must be pixel-identical. The spec also doubles as a
// deterministic regression harness for the section body itself, so it stays
// in the suite after the brick lands (default stage: `after`).

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const SECTION_TEST_ID = 'activity-section-pull-request';

const STAGE = process.env.CAN1528_STAGE === 'before' ? 'before' : 'after';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-1528');

/** Rich single-repo PR: mixed checks with details links, approval, labels. */
function richSingleRepoStatus(): ReturnType<typeof buildPrStatusData> {
  return {
    ...buildPrStatusData({
      prNumber: 1528,
      title: 'feat(ui-app): render desktop PullRequestSection on both surfaces',
      prUrl: 'https://github.com/canopy-e2e/repo/pull/1528',
    }),
    checkStatus: 'pending',
    checkDetails: [
      {
        name: 'Lint & Typecheck',
        status: 'passing',
        detailsUrl: 'https://github.com/canopy-e2e/repo/actions/runs/1',
      },
      {
        name: 'Unit Tests',
        status: 'failing',
        detailsUrl: 'https://github.com/canopy-e2e/repo/actions/runs/2',
      },
      {
        name: 'UI Automation',
        status: 'pending',
        detailsUrl: null,
      },
      {
        name: 'CodeQL',
        status: 'neutral',
        detailsUrl: 'https://github.com/canopy-e2e/repo/actions/runs/3',
      },
    ],
    reviewStatus: 'approved',
    reviewers: [{ login: 'canopy-e2e', state: 'approved' }],
    labels: [
      { name: 'refactor', color: '1d76db', description: 'Refactoring only' },
      { name: 'ui-parity', color: 'fbca04', description: null },
    ],
    mergeableState: 'blocked',
    commentCount: 3,
  };
}

/** Second repo for the multi-repo fixture: failing checks + conflicts. */
function conflictedRepoStatus(): ReturnType<typeof buildPrStatusData> {
  return {
    ...buildPrStatusData({
      prNumber: 1529,
      title: 'Sibling repo PR with conflicts',
      prUrl: 'https://github.com/canopy-e2e/repo-b/pull/1529',
      checkStatus: 'failing',
      hasConflicts: true,
    }),
    checkDetails: [
      {
        name: 'Build',
        status: 'failing',
        detailsUrl: 'https://github.com/canopy-e2e/repo-b/actions/runs/9',
      },
    ],
    reviewStatus: 'changes_requested',
    commentCount: 1,
  };
}

async function launchWithSelectedWorktree() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-can1528-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);

  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  const row = window.locator(
    `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
  );
  await expect(row).toBeVisible();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(window.getByTestId('panel-content-chat')).toBeVisible();

  // This capture drives PR state explicitly. Disable the foreground poller's
  // ten-second cadence so the remote-less demo worktree cannot clear the card
  // mid-capture; injectUntilVisible still handles the one selection-triggered
  // refresh that may already be in flight.
  await window.evaluate(async () => {
    await window.api.github.setForegroundWorktree({
      projectId: null,
      worktreeId: null,
    });
  });

  return { electronApp, window, userDataDir };
}

/** Expand the section if the collapsed-state expand affordance is present. */
async function expandSection(locator: Locator): Promise<void> {
  const expandButton = locator.locator('[aria-label="Expand section"]');
  if (await expandButton.count()) {
    await expandButton.first().click();
  }
}

/**
 * Inject inside an `expect.poll` so a racing live PR refresh (which clears
 * the store for the remote-less demo worktree) is retried away — the same
 * pattern as `git-pr-state.spec.mjs`.
 */
async function injectUntilVisible(
  electronApp: ElectronApplication,
  window: Page,
  payload: Parameters<typeof injectGithubPrStatus>[1],
  expectedText: string,
): Promise<Locator> {
  const section = window.getByTestId(SECTION_TEST_ID);
  await expect
    .poll(
      async () => {
        await injectGithubPrStatus(electronApp, payload);
        await expandSection(section).catch(() => undefined);
        return section
          .getByText(expectedText)
          .first()
          .isVisible()
          .catch(() => false);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return section;
}

/**
 * Screenshot the section, then confirm the sentinel content is STILL visible:
 * the live PR refresher can clear the injected status between an assertion
 * and the screenshot (the remote-less demo worktree resolves to no PR), which
 * would silently capture the empty state. Re-inject and retry when raced.
 */
async function captureSection(
  section: Locator,
  name: string,
  testInfo: TestInfo,
  {
    electronApp,
    window,
    payload,
    sentinelText,
  }: {
    electronApp: ElectronApplication;
    window: Page;
    payload: Parameters<typeof injectGithubPrStatus>[1];
    sentinelText: string;
  },
): Promise<void> {
  const file = path.join(captureDir, `${name}-${STAGE}.png`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await injectUntilVisible(electronApp, window, payload, sentinelText);
    await section.screenshot({ path: file });
    const stillVisible = await section
      .getByText(sentinelText)
      .first()
      .isVisible()
      .catch(() => false);
    if (stillVisible) {
      await testInfo.attach(`${name}-${STAGE}`, {
        path: file,
        contentType: 'image/png',
      });
      return;
    }
  }
  throw new Error(`PR section content raced away while capturing ${name}`);
}

test.describe('CAN-1528 PullRequestSection captures', () => {
  test('captures the rich single-repo and multi-repo PR section states', async ({}, testInfo) => {
    test.setTimeout(180_000);
    mkdirSync(captureDir, { recursive: true });
    const { electronApp, window, userDataDir } =
      await launchWithSelectedWorktree();
    try {
      // --- Single-repo rich card -----------------------------------------
      const singleEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: WORKSPACE_ID,
            repoName: 'repo',
            status: richSingleRepoStatus(),
          },
        ],
      });
      const section = await injectUntilVisible(
        electronApp,
        window,
        singleEvent,
        'PR #1528',
      );
      await section.scrollIntoViewIfNeeded();
      // The full card is rendered: checks summary, review badge, labels,
      // comment count. Keep the injection and the assertions in one retryable
      // unit so an in-flight live refresh cannot clear the remote-less demo
      // status between the sentinel check and the richer card assertions.
      await expect(async () => {
        await injectUntilVisible(electronApp, window, singleEvent, 'PR #1528');
        await expect(section.getByText('Checks (1/4 passing)')).toBeVisible({
          timeout: 2_000,
        });
        await expect(section.getByText('Approved')).toBeVisible({
          timeout: 2_000,
        });
        await expect(section.getByTestId('pr-labels-section')).toBeVisible({
          timeout: 2_000,
        });
        await expect(section.getByText('3 comments')).toBeVisible({
          timeout: 2_000,
        });
      }).toPass({ timeout: 20_000 });
      await captureSection(section, 'desktop-single', testInfo, {
        electronApp,
        window,
        payload: singleEvent,
        sentinelText: '3 comments',
      });

      // --- Multi-repo grouped rows, both expanded -------------------------
      const multiEvent = buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'repo-a',
            status: richSingleRepoStatus(),
          },
          {
            repoId: 'repo-b',
            repoName: 'repo-b',
            status: conflictedRepoStatus(),
          },
        ],
      });
      await injectUntilVisible(electronApp, window, multiEvent, 'repo-b');
      await section
        .locator('button')
        .filter({ hasText: 'repo-a' })
        .first()
        .click({ timeout: 10_000 });
      await expect(section.getByText('Checks (1/4 passing)')).toBeVisible();
      await section
        .locator('button')
        .filter({ hasText: 'repo-b' })
        .first()
        .click();
      await expect(section.getByText('Merge conflict.')).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      // `expandedRepos` is component-local state, so the expansion survives a
      // raced clear + re-inject inside captureSection.
      await captureSection(section, 'desktop-multi', testInfo, {
        electronApp,
        window,
        payload: multiEvent,
        sentinelText: 'Merge conflict.',
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
