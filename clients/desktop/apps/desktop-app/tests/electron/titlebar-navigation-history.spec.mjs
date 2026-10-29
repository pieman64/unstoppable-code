// Coverage for the persistent titlebar navigation-history arrows and the
// collapsed-sidebar corner controls:
//
//   - Back/forward arrows (`nav-history-back` / `nav-history-forward`) live in
//     the persistent titlebar corner in BOTH sidebar states and walk the
//     in-memory navigation history (page changes + worktree selections).
//   - Search lives directly below New task in the expanded sidebar and opens
//     the command palette. The keyboard shortcut remains available while the
//     sidebar is collapsed.
//   - While the sidebar is collapsed the corner also shows an icon-only
//     "New Task" button (`titlebar-create-task`, primary color, tooltip) that
//     mirrors the expanded sidebar's New Task entry (navigates to Home).
//   - The collapsed corner is transparent (`bg-transparent`) instead of the
//     sidebar tint (`bg-sidebar`), so the page's own background — including
//     gradient surfaces like Home — shows through with no sidebar-colored
//     box lingering at the window origin after collapsing.
//
// Deterministic + offline (no live agents), following the fresh-launch spec
// pattern from docs/ui-automation.md.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test.describe('titlebar navigation history', () => {
  test('arrows walk history and the collapsed corner shows New Task on a page background', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-nav-history-'),
    );

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({ userDataDir }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      const corner = window.getByTestId('app-titlebar-corner');
      const back = window.getByTestId('nav-history-back');
      const forward = window.getByTestId('nav-history-forward');

      // Both arrows render inside the persistent corner while the sidebar is
      // expanded. Nothing has been walked back yet, so forward is disabled.
      await expect(back).toBeVisible();
      await expect(forward).toBeVisible();
      await expect(forward).toBeDisabled();

      // The compact New Task action remains available in the titlebar in both
      // sidebar states, and the corner uses the sidebar background while the
      // sidebar is visible.
      const newTask = window.getByTestId('titlebar-create-task');
      await expect(newTask).toBeVisible();
      await expect(corner).toHaveClass(/app-sidebar-titlebar-surface/);

      // Search is the fixed sidebar row directly below New task. It no longer
      // consumes titlebar space, and opens the same Cmd+K command palette.
      const fixedNavigation = window.getByTestId('sidebar-fixed-navigation');
      // Each row sits inside its hover-tooltip wrapper (CAN-2673), so read the
      // rows' test ids in document order rather than relying on direct
      // children of the fixed navigation.
      const sidebarSearch = window.getByTestId('sidebar-search');
      await expect(window.getByTestId('titlebar-quick-search')).toHaveCount(0);
      await expect
        .poll(() =>
          fixedNavigation
            .locator('button[data-testid]')
            .evaluateAll((rows) =>
              rows.map((row) => row.getAttribute('data-testid')),
            ),
        )
        .toEqual(['sidebar-create-task', 'sidebar-search']);
      await expect(sidebarSearch).toHaveAttribute('aria-label', 'Search');
      await sidebarSearch.click();
      await expect(window.getByTestId('command-palette')).toBeVisible();
      await expect(window.getByTestId('command-palette-input')).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('command-palette')).toBeHidden();

      // A fresh unseeded launch lands on the Home page. Navigate away to
      // create a history entry, then walk back and forward through it.
      const home = window.getByTestId('page-home');
      await expect(home).toBeVisible();
      // Workflows opens on its Runs tab; each Workflows tab is its own
      // history entry (CAN-3981). `openPipelinesPage` goes on to the Library.
      await app.openPipelinesPage();
      const runsPage = window.getByTestId('page-workflows-runs');
      const runsTab = window.getByTestId('workflows-tab-workflows');
      const libraryTab = window.getByTestId('workflows-tab-workflows-library');

      await expect(back).toBeEnabled();
      await back.click();
      await expect(runsPage).toBeVisible();
      await expect(runsTab).toHaveAttribute('aria-selected', 'true');
      await back.click();
      await expect(home).toBeVisible();

      await expect(forward).toBeEnabled();
      await forward.click();
      await expect(runsPage).toBeVisible();
      await forward.click();
      await app.expectPipelinesPage();
      await expect(libraryTab).toHaveAttribute('aria-selected', 'true');
      await expect(forward).toBeDisabled();

      // Collapse the sidebar: the arrows stay, the New Task button joins
      // them, and the corner goes transparent so the page background shows.
      await window.getByTestId('sidebar-toggle').click();
      await expect(window.getByTestId('app-sidebar')).toBeHidden();
      await expect(corner).toHaveClass(/bg-transparent/);

      await expect(newTask).toBeVisible();
      await expect(newTask).toHaveAttribute('aria-label', 'New task');
      const sidebarToggle = window.getByTestId('sidebar-toggle');
      const [sidebarToggleBox, backBox, forwardBox, newTaskBox] =
        await Promise.all([
          sidebarToggle.boundingBox(),
          back.boundingBox(),
          forward.boundingBox(),
          newTask.boundingBox(),
        ]);
      expect(sidebarToggleBox).not.toBeNull();
      expect(backBox).not.toBeNull();
      expect(forwardBox).not.toBeNull();
      expect(newTaskBox).not.toBeNull();
      const sidebarToBackGap =
        backBox.x - (sidebarToggleBox.x + sidebarToggleBox.width);
      const forwardToNewTaskGap =
        newTaskBox.x - (forwardBox.x + forwardBox.width);
      expect(forwardToNewTaskGap).toBe(sidebarToBackGap);
      await newTask.hover();
      await expect(window.getByRole('tooltip')).toHaveText('New task');
      await expect(back).toBeVisible();
      await expect(forward).toBeVisible();
      expect(
        await sidebarSearch.evaluate(
          (element) => element.closest('[inert]') !== null,
        ),
      ).toBe(true);
      await expect(window.getByTestId('titlebar-quick-search')).toHaveCount(0);

      // The global shortcut preserves Search keyboard access while collapsed.
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+K' : 'Control+K',
      );
      await expect(window.getByTestId('command-palette')).toBeVisible();
      await window.keyboard.press('Escape');

      // New Task mirrors the sidebar entry: it navigates to Home, and that
      // navigation itself becomes a history step the back arrow can undo.
      await newTask.click();
      await expect(home).toBeVisible();
      await expect(back).toBeEnabled();
      await back.click();
      await app.expectPipelinesPage();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
