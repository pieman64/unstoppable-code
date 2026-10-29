import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Reworked for the unified sidebar (left-panel rework, T1–T8).
//
// The old icon-rail collapse mode (with per-nav-button portaled `role="tooltip"`
// panels shown only while collapsed) was replaced by a hide/show sidebar.
// Main sidebar nav rows name themselves, so New task, Search, every main nav
// row, the More row, and the More-menu entries carry NO hover tooltip (the
// CAN-2673 section descriptions were removed after design review). The small
// utility buttons keep theirs: Settings and Send feedback in the account row.
// The toggle carries NO visual tooltip either (CAN-2415): hovering it
// reveals the sidebar itself, so a portalled label would float over the panel
// it just opened. Its `aria-label` still flips between "Hide sidebar" and
// "Show sidebar" for assistive technology. Exactly one `sidebar-toggle`
// element exists app-wide: the single fixed titlebar-layer toggle rendered by
// App.tsx, which stays at constant window coordinates in both the expanded and
// hidden sidebar states (Task 14).
test('sidebar toggle and main nav rows show no tooltip while utility buttons keep theirs', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    // More is empty by default. Model a user who moved Overview there after
    // the startup migration, so this test still exercises the More controls.
    await window.evaluate(async () => {
      const preferences = await window.api.loadPreferences();
      const order = preferences.sidebarNavLayout.order.filter(
        (key) => key !== 'overview',
      );
      await window.api.savePreferences({
        sidebarNavLayout: {
          order: [...order, 'overview'],
          moreStartIndex: order.length,
        },
      });
    });
    await window.reload();
    await app.waitForShell();

    // The sidebar defaults to visible. While visible, the toggle reads
    // "Hide sidebar".
    const toggle = window.getByTestId('sidebar-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-label', 'Hide sidebar');
    await toggle.hover();
    await expect(window.getByRole('tooltip')).toHaveCount(0);

    // The shared tooltip opens on pointer-enter; give each row a moment to
    // (wrongly) open one before asserting there is none.
    const expectNoTooltipOnHover = async (locator) => {
      await locator.hover();
      await window.waitForTimeout(250);
      await expect(window.getByRole('tooltip')).toHaveCount(0);
    };

    // New task, Search, and the main nav rows carry no tooltip.
    for (const testId of [
      'sidebar-create-task',
      'sidebar-search',
      'sidebar-nav-app-advisor',
      'sidebar-nav-plugins',
      'sidebar-nav-workflows',
    ]) {
      await expectNoTooltipOnHover(window.getByTestId(testId));
    }
    // Customize draws the briefcase; the storefront stays on marketplaces.
    await expect(
      window.getByTestId('sidebar-nav-plugins').locator('svg'),
    ).toHaveAttribute('data-glyph', 'briefcase');

    // Neither the More row nor its menu entries carry one.
    const more = window.getByTestId('sidebar-more');
    await expectNoTooltipOnHover(more);
    await more.click();
    await expectNoTooltipOnHover(
      window.getByTestId('sidebar-more-item-overview'),
    );
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('sidebar-more-menu')).toBeHidden();

    // The small utility buttons keep their tooltips.
    await window.getByTestId('sidebar-account-action-settings').hover();
    await expect(
      window.getByRole('tooltip', { name: 'Settings', exact: true }),
    ).toBeVisible();
    await window.screenshot({
      path: testInfo.outputPath('sidebar-tooltip-visible.png'),
    });
    await window.mouse.move(300, 300);
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    await window.getByTestId('sidebar-account-action-feedback').hover();
    await expect(
      window.getByRole('tooltip', { name: 'Send feedback', exact: true }),
    ).toBeVisible();
    await window.mouse.move(300, 300);
    await expect(window.getByRole('tooltip')).toHaveCount(0);

    // Hide the sidebar via the toggle. The aside stays mounted and animates
    // to width 0, and the same fixed toggle now reads "Show sidebar".
    await toggle.click();
    await expect(window.getByTestId('app-sidebar')).toBeHidden();
    const showToggle = window.getByTestId('sidebar-toggle');
    await expect(showToggle).toBeVisible();
    await expect(showToggle).toHaveAttribute('aria-label', 'Show sidebar');
    // The toggle stays at the same window coordinates while its tooltip
    // wrapper is replaced. Move the pointer away so the next hover produces a
    // real pointer-enter event for the new wrapper.
    await window.mouse.move(300, 300);
    await showToggle.hover();
    await expect(window.getByRole('tooltip')).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('sidebar-tooltip-hidden.png'),
    });

    // Re-show it to leave the app in a normal state.
    await showToggle.click();
    await expect(window.getByTestId('app-sidebar')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
