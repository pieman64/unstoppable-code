import { rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedNativeClaudeStore } from './seeders/seedNativeClaudeStore.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

// Modals opened from the Home composer must cover the Getting started
// checklist below it.
//
// The composer shell is transformed (-translate-y-1/2), which makes it a
// stacking context. A modal rendered inline inside it is trapped there, so
// the checklist's later, positioned rows painted over the modal: the import
// row's label showed through the Plugins dialog while the unpositioned
// heading stayed hidden. The check asks the renderer which element is on top
// at the row's center rather than reading class names, so it fails on the
// real paint order.
//
// The import entry exists only when a Claude or Codex store is present, so a
// native Claude transcript is seeded into the harness's isolated
// CLAUDE_CONFIG_DIR.

async function expectRowCoveredBy(window, rowTestId, dialogContentTestId) {
  await expect
    .poll(() =>
      window.evaluate(
        ({ row, dialogContent }) => {
          const rowElement = document.querySelector(`[data-testid="${row}"]`);
          const dialogElement = document
            .querySelector(`[data-testid="${dialogContent}"]`)
            ?.closest('[role="dialog"]');
          if (!rowElement || !dialogElement) return 'missing';
          const rect = rowElement.getBoundingClientRect();
          const top = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          if (!top) return 'nothing';
          if (rowElement.contains(top)) return 'checklist row';
          // The overlay is the dialog's parent; either one on top covers the row.
          const overlay = dialogElement.parentElement ?? dialogElement;
          return overlay.contains(top) ? 'modal' : 'other';
        },
        { row: rowTestId, dialogContent: dialogContentTestId },
      ),
    )
    .toBe('modal');
}

test('Home composer modals cover the underlying composer', async () => {
  const userDataDir = seedWelcomeChecklist({ pendingEntry: 'import-projects' });
  const externalRoot = seedNativeClaudeStore(userDataDir, {
    prefix: 'canopy-home-modal-stacking-',
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();

    const importRow = window
      .getByTestId('page-home')
      .getByTestId('home-composer-editor');
    await expect(importRow).toBeVisible({ timeout: 30_000 });

    await window
      .getByTestId('page-home')
      .getByTestId('home-composer-plus-button')
      .click();
    await window.getByTestId('home-plugins-button').click();
    await expect(window.getByTestId('plugin-picker-region')).toBeVisible();
    await expectRowCoveredBy(
      window,
      'home-composer-editor',
      'plugin-picker-region',
    );
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('plugin-picker-region')).toHaveCount(0);
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
    await closeCanopy(electronApp, userDataDir);
  }
});
