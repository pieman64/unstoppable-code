// Status glyphs (design review, 23 Oct): one shared glyph and one ink per
// state on every surface. Running is the neutral shared spinner, Cancelled
// has its own stop glyph so it never reads as Done, and a done worktree wears
// the same green Done check as a finished run (no purple, no accent).
//
// Deterministic and offline: seeded demo workspace, worktree status and
// pipeline executions; no live agents.

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

/** Flip the demo worktree's persisted status to done before launch. */
function markWorktreeDone(userDataDir) {
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees.json',
  );
  const worktreesConfig = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  worktreesConfig.worktrees = worktreesConfig.worktrees.map((worktree) =>
    worktree.id === WORKTREE_ID ? { ...worktree, status: 'done' } : worktree,
  );
  writeJson(worktreesPath, worktreesConfig);
}

test.describe('status glyphs', () => {
  test('Workflows runs draw one shared glyph per status, with a stop glyph for Cancelled', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-status-glyphs-runs-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const run = (id, pipelineName, status, minute) =>
      seedPipelineExecution({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        execution: {
          id,
          pipelineName,
          status,
          startedAt: `2026-04-10T12:0${minute}:00.000Z`,
          completedAt: `2026-04-10T12:0${minute + 1}:00.000Z`,
        },
      });
    run('glyph-failed', 'Security scan', 'failure', 1);
    run('glyph-passed', 'Release notes', 'success', 2);
    run('glyph-cancelled', 'Nightly dependency check', 'cancelled', 3);

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openWorkflowsTab('runs');

      const glyphOf = (id) =>
        window
          .locator(
            `[data-testid="workflows-run-row"][data-run-key="pipeline-run:${id}"]`,
          )
          .getByTestId('workflows-run-status')
          .locator('[data-status-glyph]');

      await expect(glyphOf('glyph-failed')).toHaveAttribute(
        'data-status-glyph',
        'failed',
      );
      await expect(glyphOf('glyph-passed')).toHaveAttribute(
        'data-status-glyph',
        'done',
      );
      const cancelled = glyphOf('glyph-cancelled');
      await expect(cancelled).toHaveAttribute('data-status-glyph', 'cancelled');
      // Cancelled is its own stop glyph, not the finished check or the
      // failed x, and it carries no state colour of its own.
      await expect(
        cancelled.locator('svg[data-glyph="circle-stop"]'),
      ).toHaveCount(1);
      await expect(cancelled).toHaveClass(/fg-tertiary/);
      // No status mark is a bare dot any more.
      await expect(
        window.locator('[data-testid="workflows-run-status"] > .rounded-full'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a done worktree wears the shared green Done glyph in the sidebar', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-status-glyphs-done-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    markWorktreeDone(userDataDir);

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
      const done = row.locator('[aria-label="Done"] [data-status-glyph]');
      await expect(done).toHaveAttribute('data-status-glyph', 'done');
      await expect(done).toHaveClass(/fg-success-strong/);
      await expect(done.locator('svg[data-glyph="circle-check"]')).toHaveCount(
        1,
      );
      // Done is green now, never the purple it used to share with Merged.
      await expect(row.locator('.fg-purple')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
