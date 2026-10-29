import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { injectCodeGraphBuildStatusEvent } from './seeders/injectCodeGraphBuildStatusEvent.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Graph-building indicator (code-graph build-status badge) — the worktree
// row hub badge (`worktree-row-graph-badge`) lights up while a code-graph
// build is in flight for that worktree, driven end-to-end by
// `codeGraphBuildStatusChanged` IPC events broadcast from the single
// off-main build-runner chokepoint (both the worktree-create scheduler and
// the agent-invoked BuildOrUpdateCodeGraph tool route through it). See
// `apps/desktop-app/src/main/code-graph/build-runner.ts`,
// `apps/desktop-app/src/main/ipc/code-graph-build-status.ts`,
// `apps/desktop-app/src/renderer/src/stores/codeGraphBuildStore.ts`, and
// `packages/ui-shared/src/components/WorktreeRow.tsx`.
//
// A real code-graph build (parsing the demo repo with web-tree-sitter) is
// slow and nondeterministic to time against in an automated spec, so this
// spec drives the SAME IPC contract the real build runner emits via
// `injectCodeGraphBuildStatusEvent` (mirrors the established
// `injectScriptRunEvent`/`injectResourceSnapshot` runtime-injection
// pattern) — a high-fidelity, deterministic exercise of the full
// IPC -> preload -> store -> hook -> WorktreeRow path without needing a real
// build to complete.
//
// Determinism: no live agents, no network, no PTY, no live code-graph build.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

test.describe('worktree-row graph-building badge', () => {
  test('lights the hub badge from a live building event WITHOUT selecting the worktree first, and clears it on idle', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-wt-graph-badge-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

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

      // Baseline: no build yet, badge absent.
      await expect(window.getByTestId('worktree-row-graph-badge')).toHaveCount(
        0,
      );

      // CORE SIGNAL — inject the live 'building' event WITHOUT ever selecting
      // the worktree first. Unlike the script rocket badge (gated on
      // `loadedWorktreeKeys`), `codeGraphBuildStore` has no such gate: the
      // badge must render for any worktree row, not just the currently open
      // one. This is the exact invariant the brief called out.
      await injectCodeGraphBuildStatusEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        status: 'building',
      });

      const graphBadge = window.getByTestId('worktree-row-graph-badge');
      await expect(graphBadge).toBeVisible({ timeout: 10_000 });
      await expect(graphBadge).toHaveAttribute(
        'aria-label',
        'Updating project graph…',
      );

      // Idle clears the badge.
      await injectCodeGraphBuildStatusEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        status: 'idle',
      });

      await expect(window.getByTestId('worktree-row-graph-badge')).toHaveCount(
        0,
        { timeout: 10_000 },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('does not light the badge for an unrelated worktree key', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-wt-graph-badge-other-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

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

      await injectCodeGraphBuildStatusEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: 'some-other-worktree',
        status: 'building',
      });

      // Give the IPC round trip a beat, then assert the badge on THIS row
      // never lit — the event was keyed to a different worktree id.
      await window.waitForTimeout(500);
      await expect(window.getByTestId('worktree-row-graph-badge')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
