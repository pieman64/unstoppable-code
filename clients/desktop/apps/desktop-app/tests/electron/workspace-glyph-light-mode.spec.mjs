import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// The workspace-kind glyphs used to paint `fill="white"` literally, so no
// `color` utility could reach them. On an ordinary surface in LIGHT mode that
// is an invisible glyph; dark mode was accidentally fine, which is why this
// shipped. The glyphs are now monochrome and `currentColor`-driven.
//
// The desktop surface this spec walks is the "Add project" modal's "Project
// type" segmented control, where the mismatch was visible without any special
// state: the Temporary tab's glyph already tracked its button's text color
// while the other three were stuck white.
//
// Asserted by reading back COMPUTED color (CAN-2734): a class name on an SVG
// proves nothing about what the glyph actually paints, and `fill` in
// particular is an attribute the class cannot override.
//
// Two tests, because the fix has two halves:
//
//  1. Bare renders (the Add project modal) must now track their container's
//     text color — THE FIX.
//  2. Badge renders (sidebar workspace rows) must still paint white on their
//     saturated categorical square — THE NO-REGRESSION CONTROL. The white did
//     not disappear, it moved into `WorkspaceKindBadge`, and if that ever
//     stopped re-supplying it every badge in the app would silently flip to a
//     dark glyph on a colored square.
//
// Deterministic: a fresh user-data dir with `colorMode: 'light'` seeded on
// disk, committed demo fixtures for the badge case, no live agents, no
// network.

const WHITE = 'rgb(255, 255, 255)';

function lightModeProfile() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-glyph-'),
  );
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      { version: 1, preferences: { colorMode: 'light' } },
      null,
      2,
    ),
    'utf8',
  );
  return userDataDir;
}

/**
 * The button's own text color plus every paint its glyph resolves to. A
 * `currentColor` glyph collapses to a single value equal to the button color;
 * the old hard-coded white stayed white no matter what the button did.
 */
async function readGlyphPaints(button) {
  return button.evaluate((element) => {
    const buttonColor = getComputedStyle(element).color;
    const paints = [];
    for (const path of element.querySelectorAll('svg path')) {
      const computed = getComputedStyle(path);
      for (const property of ['fill', 'stroke']) {
        const value = computed[property];
        if (value && value !== 'none') paints.push(value);
      }
    }
    return { buttonColor, paints };
  });
}

/**
 * Every paint a badge's glyph resolves to, plus the badge's own background.
 * The badge is the one surface that WANTS white: it draws on a saturated
 * categorical square, so `text-white` is re-supplied there on purpose.
 */
async function readBadgePaints(badge) {
  return badge.evaluate((element) => {
    const paints = [];
    for (const path of element.querySelectorAll('svg path')) {
      const computed = getComputedStyle(path);
      for (const property of ['fill', 'stroke']) {
        const value = computed[property];
        if (value && value !== 'none') paints.push(value);
      }
    }
    return {
      backgroundColor: getComputedStyle(element).backgroundColor,
      paints,
    };
  });
}

test.describe('workspace glyphs in light mode', () => {
  test('Add project “Project type” glyphs track their button color', async () => {
    test.setTimeout(120_000);

    const userDataDir = lightModeProfile();
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await expect(window.locator('html')).not.toHaveClass(/dark/);

      await window.getByTestId('sidebar-section-code-toggle').hover();
      await window.getByTestId('sidebar-section-code-add').click();
      const modal = window.getByTestId('add-workspace-modal');
      await expect(modal).toBeVisible();
      await window.getByTestId('add-workspace-mode-create').click();

      // Temporary is offered only once there are worktrees to combine, so it
      // alone is asserted opportunistically. The other three are REQUIRED: a
      // blanket `count() === 0 -> continue` would let a renamed testid turn
      // this spec vacuously green, which is precisely the regression it exists
      // to catch.
      const requiredTestIds = [
        'add-workspace-type-single-repo',
        'add-workspace-type-multi-repo',
        'add-workspace-type-cowork',
      ];
      const optionalTestIds = ['add-workspace-type-temporary'];

      for (const testId of [...requiredTestIds, ...optionalTestIds]) {
        const button = modal.getByTestId(testId);
        if (requiredTestIds.includes(testId)) {
          await expect(button, `${testId} is present`).toHaveCount(1);
        } else if (
          (await button.count()) === 0 ||
          (await button.getAttribute('aria-disabled')) === 'true'
        ) {
          // Shown but unavailable until there are projects to combine.
          continue;
        }

        // Both states matter: the selected tab reads `fg-primary` and the rest
        // `fg-secondary`, and a white glyph was wrong against both.
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');

        const selected = await readGlyphPaints(button);
        expect(
          selected.paints.length,
          `${testId} renders a glyph`,
        ).toBeGreaterThan(0);
        expect(selected.buttonColor, `${testId} button color`).not.toBe(WHITE);
        for (const paint of selected.paints) {
          expect(paint, `${testId} selected glyph paint`).toBe(
            selected.buttonColor,
          );
        }
      }

      // Leave a non-cowork tab selected so the last-asserted tab is also
      // checked in its UNSELECTED state.
      await modal.getByTestId('add-workspace-type-single-repo').click();
      const cowork = modal.getByTestId('add-workspace-type-cowork');
      await expect(cowork).toHaveAttribute('aria-pressed', 'false');

      const unselected = await readGlyphPaints(cowork);
      expect(unselected.buttonColor, 'unselected button color').not.toBe(WHITE);
      for (const paint of unselected.paints) {
        expect(paint, 'unselected glyph paint').toBe(unselected.buttonColor);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // The OTHER half of the fix, and the one with real blast radius: the white
  // did not disappear, it moved into `WorkspaceKindBadge`. If the badge ever
  // stopped re-supplying it, every badge in the app would silently flip to a
  // dark glyph on a saturated colored square. A class-name assertion cannot
  // catch that (CAN-2734: a class on an SVG proves nothing about what the
  // glyph paints), so this reads back COMPUTED color on a real seeded row.
  test('sidebar workspace badges still paint their glyph white', async () => {
    test.setTimeout(180_000);

    const userDataDir = lightModeProfile();
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await expect(window.locator('html')).not.toHaveClass(/dark/);

      const codeSection = window.getByTestId('sidebar-section-code');
      await expect(codeSection).toBeVisible({ timeout: 30_000 });

      // `toBeAttached`, not `toBeVisible`: `ProjectIcon` keeps the badge
      // mounted-but-`invisible` behind a loaded GitHub owner avatar. The demo
      // fixture has no remote, so the badge paints — but the assertion is
      // about the glyph's computed color, not about which layer won.
      const badge = codeSection
        .locator('[data-testid="workspace-kind-badge"]')
        .first();
      await expect(badge).toBeAttached({ timeout: 30_000 });

      const { backgroundColor, paints } = await readBadgePaints(badge);

      expect(paints.length, 'badge renders a glyph').toBeGreaterThan(0);
      for (const paint of paints) {
        expect(paint, 'badge glyph paint').toBe(WHITE);
      }
      // Guard against a vacuous pass: white-on-white would satisfy the loop
      // above while being exactly as unreadable as the bug this PR fixes.
      expect(backgroundColor, 'badge background').not.toBe(WHITE);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
