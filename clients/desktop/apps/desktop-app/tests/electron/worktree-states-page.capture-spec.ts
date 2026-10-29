// @capture-keep: reusable visual catalog for the E2E-only worktree states page
// @capture-reference: docs/sidebar-worktree-status.md
// Run with: pnpm run test:electron:captures:built worktree-states-page.capture-spec.ts
// Color modes: run each documented stage normally for light, then append `--dark-mode` for dark.
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Worktree States gallery page (sidebar status-system work, 2026-08-18).
//
// The dev/E2E-only "Worktree States" page renders the shared WorktreeRow in
// every state it can express via direct props — including states with no
// runtime seeding seam (split-PR phases, setup phases, discovery) — plus the
// color legend (cyan = running now vs blue = finished-unseen). The sidebar
// More menu gains a dev/E2E-gated entry that opens it.
//
// Stages:
//   WTSTATES_STAGE=before  — run against the unmodified tree: asserts the More
//                            menu has NO Worktree States entry and captures the
//                            menu as evidence the surface is new.
//   (default: after)       — opens the page through the More menu, asserts the
//                            catalog renders real WorktreeRow states (question
//                            glyph, red pipeline glyph, terminal tints, split
//                            review, setup loader), checks the hover contract
//                            (trailing status cluster sits left of the action
//                            chip), and captures the legend + every section
//                            into `.playwright/worktree-states-page/`.
//
// Determinism: the page is a pure props-driven catalog — no live agents, no
// network, no seeded workspaces; captures disable animations.

const STAGE = process.env.WTSTATES_STAGE === 'before' ? 'before' : 'after';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'worktree-states-page');

test('worktree states gallery page renders every row state', async () => {
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-wt-states-e2e-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();

    if (STAGE === 'before') {
      await expect(
        window.getByTestId('sidebar-more-item-worktree-states'),
      ).toHaveCount(0);
      await window.getByTestId('sidebar-more-menu').screenshot({
        path: path.join(captureDir, `more-menu-${STAGE}.png`),
        animations: 'disabled',
      });
      return;
    }

    await window.getByTestId('sidebar-more-menu').screenshot({
      path: path.join(captureDir, `more-menu-${STAGE}.png`),
      animations: 'disabled',
    });
    // Every dev page lives behind one More entry with tabs.
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-worktree-states').click();

    const page = window.getByTestId('page-worktree-states');
    await expect(page).toBeVisible();

    // Legend explains the cyan-vs-blue vocabulary.
    const legend = window.getByTestId('state-color-legend');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('running now');
    await expect(legend).toContainText('finished, not seen');
    await legend.screenshot({
      path: path.join(captureDir, `legend-${STAGE}.png`),
      animations: 'disabled',
    });

    // Leading-icon priority list: visible, and drag actually reorders.
    const priorityList = window.getByTestId('leading-priority-list');
    await expect(priorityList).toBeVisible();
    await priorityList.screenshot({
      path: path.join(captureDir, `priority-list-${STAGE}.png`),
      animations: 'disabled',
    });
    const priorityQuestionRow = window.getByTestId('priority-row-question');
    // Drag the question row above the current top entry (pipeline paused —
    // done now sits at the bottom of the chain as the quiet-state fallback).
    const priorityTopRow = window.getByTestId('priority-row-pipeline-paused');
    const questionBox = await priorityQuestionRow.boundingBox();
    const topBox = await priorityTopRow.boundingBox();
    await window.mouse.move(
      questionBox.x + 16,
      questionBox.y + questionBox.height / 2,
    );
    await window.mouse.down();
    // dnd-kit PointerSensor needs movement past its 4px activation distance.
    await window.mouse.move(topBox.x + 16, topBox.y + 2, { steps: 8 });
    await window.mouse.move(topBox.x + 16, topBox.y - 4, { steps: 4 });
    await window.mouse.up();
    const rankAfterDrag = await window
      .getByTestId('priority-row-question')
      .locator('span')
      .nth(1)
      .innerText();
    expect(rankAfterDrag.trim()).toBe('1');
    await window.getByTestId('priority-reset').click();
    await window.mouse.move(0, 0);

    // Hovering the blue unread dot opens the real chat-preview popover.
    // Hover the row first: entering the row shifts the trailing cluster left
    // (action-chip reserve), so aiming at the dot from outside would chase a
    // moving target.
    await window.getByTestId('gallery-worktree-row-unread').hover();
    const unreadDot = window
      .getByTestId('gallery-row-unread')
      .getByTestId('worktree-row-unread');
    await unreadDot.hover();
    await expect(window.getByText('Fix flaky sidebar spec')).toBeVisible();
    const popover = window
      .locator('div')
      .filter({ hasText: 'Fix flaky sidebar spec' })
      .last();
    await popover.screenshot({
      path: path.join(captureDir, `unread-preview-${STAGE}.png`),
      animations: 'disabled',
    });
    await window.mouse.move(0, 0);

    // Real WorktreeRow output, not lookalike markup.
    const questionRow = window.getByTestId('gallery-row-question');
    await expect(
      questionRow.getByTestId('worktree-row-question-glyph'),
    ).toBeVisible();

    const failedGlyph = window
      .getByTestId('gallery-row-pipeline-failed')
      .getByTestId('worktree-row-pipeline-glyph');
    await expect(failedGlyph).toBeVisible();
    expect(await failedGlyph.innerHTML()).toContain('fg-destructive');

    await expect(
      window
        .getByTestId('gallery-row-terminal-running')
        .locator('[data-terminal-status="running"]'),
    ).toBeVisible();

    // States with no runtime seeding seam are still on the page.
    await expect(window.getByTestId('gallery-row-split-review')).toBeVisible();
    await expect(window.getByTestId('gallery-row-discovery')).toBeVisible();
    await expect(
      window
        .getByTestId('gallery-row-setup-running')
        .locator('[aria-label="Running setup…"]'),
    ).toBeVisible();

    // Hover contract: the trailing status cluster of the composite row stays
    // visible and sits fully left of the hover action chip.
    const compositeRow = window.getByTestId('gallery-worktree-row-composite');
    await compositeRow.scrollIntoViewIfNeeded();
    await compositeRow.hover();
    const trailing = compositeRow.getByTestId('worktree-row-trailing-slot');
    await expect(trailing).toBeVisible();
    const chip = compositeRow.getByTestId('worktree-row-action-chip');
    await expect(chip).toBeVisible();
    const trailingBox = await trailing.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(trailingBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    expect(trailingBox.x + trailingBox.width).toBeLessThanOrEqual(
      chipBox.x + 1,
    );
    await compositeRow.screenshot({
      path: path.join(captureDir, `composite-hover-${STAGE}.png`),
      animations: 'disabled',
    });
    await window.mouse.move(0, 0);

    // Capture every section for the report.
    const sections = window.locator('[data-testid^="gallery-section-"]');
    const sectionCount = await sections.count();
    expect(sectionCount).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < sectionCount; i += 1) {
      const section = sections.nth(i);
      const testId = await section.getAttribute('data-testid');
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({
        path: path.join(captureDir, `${testId}-${STAGE}.png`),
        animations: 'disabled',
      });
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
