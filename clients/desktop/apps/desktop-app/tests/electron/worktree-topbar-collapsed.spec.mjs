// Regression: when the sidebar is collapsed the worktree top bar
// (WorktreeTopBar / PrStatusBar) is the leftmost element in the content region,
// so it slides flush against the window's left edge. The persistent titlebar
// corner overlay (the app-wide sidebar toggle, an absolute `left-0 z-40` element
// rendered by App.tsx) sits on top of that origin. Without a reserved spacer the
// overlay paints over the start of the branch breadcrumb.
// WorktreeTopBar reserves the corner's width with the same animated
// spacer PageTitlebar uses, but only in list view (in kanban view the board sits
// to the left and already reserves it). This spec pins that reservation.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';

test('collapsed sidebar does not cover the worktree top bar left edge', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const topBar = window.getByTestId('worktree-top-bar');
    await expect(topBar).toBeVisible();
    const topBarSeparatorHeight = await topBar.evaluate(
      (element) => window.getComputedStyle(element, '::after').height,
    );
    const expectedHairlineWidth = await window.evaluate(() =>
      window.devicePixelRatio >= 2 ? '0.5px' : '1px',
    );
    expect(topBarSeparatorHeight).toBe(expectedHairlineWidth);

    const statusBar = window.getByTestId('pr-status-bar');
    await expect(statusBar).toBeVisible();

    // The reservation spacer lives inside the top bar in list view (the default
    // for the worktree page). It shares the CollapsedTitlebarToggle testid.
    const spacer = topBar.getByTestId('page-titlebar-spacer');
    await expect(spacer).toHaveCount(1);

    const corner = window.getByTestId('app-titlebar-corner');
    await expect(corner).toBeVisible();
    const cornerBox = await corner.boundingBox();
    expect(cornerBox, 'titlebar corner bounding box').not.toBeNull();
    const cornerRight = cornerBox.x + cornerBox.width;

    // Collapse the sidebar via the single app-wide toggle. The content region
    // widens to the window origin and the top bar slides under the corner.
    const toggle = window.getByTestId('sidebar-toggle');
    await toggle.click();
    await expect(window.getByTestId('app-sidebar')).toBeHidden();

    // The status bar — the leftmost visible content of the top bar now that
    // New Chat left it — must clear the corner's right edge (the spacer
    // animates 0 → corner width, ~200ms). Before the fix the bar's leading
    // content sat under the overlay.
    await expect
      .poll(async () => (await statusBar.boundingBox())?.x ?? 0, {
        timeout: 5_000,
      })
      .toBeGreaterThanOrEqual(cornerRight - 1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
