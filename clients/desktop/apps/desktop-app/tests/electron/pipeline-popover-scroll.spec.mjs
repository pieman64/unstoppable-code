import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Pipeline hover popover with a large run list
// (`packages/ui-shared/src/components/PipelineStatusPopover.tsx`, hosted from
// `apps/desktop-app/src/renderer/src/components/worktree/WorktreeItem.tsx`).
//
// A worktree accumulates one unseen entry per completed run, so the popover
// used to grow without bound. It now keeps the header fixed, counts the
// entries, and turns the list into a scroll region past three rows.
//
// Determinism: the demo workspace and every execution are seeded on disk
// before launch. No live pipeline run, no agents, no network.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const RUN_COUNT = 9;

test('pipeline popover counts entries and scrolls a large run list', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-pl-scroll-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  for (let index = 0; index < RUN_COUNT; index += 1) {
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: `e2e-pipeline-scroll-${String(index + 1)}`,
        pipelineId: `seeded-pipeline-${String(index + 1)}`,
        pipelineName: `Seeded Pipeline ${String(index + 1)}`,
        status: 'success',
      },
    });
  }

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const row = window.locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
    );
    await expect(row).toBeVisible({ timeout: 15_000 });

    const badge = row.getByTestId('worktree-row-pipeline-glyph');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.hover();

    const popover = window.getByTestId('pipeline-status-popover');
    await expect(popover).toBeVisible({ timeout: 10_000 });

    // Header names the status and counts the runs behind it.
    const header = popover.getByTestId('pipeline-status-popover-header');
    await expect(header).toHaveText(`Workflows Completed (${RUN_COUNT})`);

    // Every run is mounted, but the list is bounded to roughly three rows.
    const list = popover.getByTestId('pipeline-status-popover-list');
    await expect(list).toHaveAttribute('data-scrollable', 'true');
    const metrics = await list.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      rowCount: el.children.length,
      firstRowHeight: el.children[0].getBoundingClientRect().height,
    }));
    expect(metrics.rowCount).toBe(RUN_COUNT);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    // Roughly three rows tall, not nine.
    expect(metrics.clientHeight).toBeLessThan(metrics.firstRowHeight * 4);

    // The pointer can move off the badge and into the list without the
    // popover closing, which is what makes the scroll region usable.
    await list.hover();
    await expect(popover).toBeVisible();

    const scrolled = await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);

    // The header does not scroll away with the list.
    await expect(header).toBeVisible();
    await expect(header).toHaveText(`Workflows Completed (${RUN_COUNT})`);
    const headerBox = await header.boundingBox();
    const listBox = await list.boundingBox();
    expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(listBox.y + 1);

    // Moving the pointer away from both the badge and the list closes it.
    await window.mouse.move(1, 1);
    await expect(popover).toBeHidden({ timeout: 5_000 });

    // Pointer-originated focus must not latch the popover open indefinitely.
    await badge.click();
    await expect(popover).toBeVisible();
    await window.mouse.move(1, 1);
    await expect(popover).toBeHidden({ timeout: 5_000 });

    // Keyboard users can open the same popover and move directly into its
    // scroll region without blur tearing the portal down.
    await badge.focus();
    await expect(popover).toBeVisible();
    await badge.press('ArrowDown');
    await expect(list).toBeFocused();
    await list.press('End');
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await expect(popover).toBeVisible();

    // Escape from the portaled list closes it and returns focus to the badge.
    await list.press('Escape');
    await expect(popover).toBeHidden();
    await expect(badge).toBeFocused();

    // The custom disclosure follows button activation semantics.
    await badge.press('Enter');
    await expect(popover).toBeVisible();
    await badge.press('Enter');
    await expect(popover).toBeHidden();
    await badge.press('Space');
    await expect(popover).toBeVisible();
    await badge.press('Space');
    await expect(popover).toBeHidden();

    // Assistive technologies activate custom role=button controls with a
    // synthetic click rather than a keydown.
    await badge.evaluate((element) => {
      element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 0 }),
      );
    });
    await expect(popover).toBeVisible();
    await badge.evaluate((element) => {
      element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 0 }),
      );
    });
    await expect(popover).toBeHidden();

    // ArrowDown reopens a disclosure that was dismissed while focus remained
    // on the controlling badge.
    await badge.press('ArrowDown');
    await expect(popover).toBeVisible();
    await expect(list).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
