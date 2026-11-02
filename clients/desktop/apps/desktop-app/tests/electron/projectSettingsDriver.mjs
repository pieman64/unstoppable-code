// Drives single-repo project settings, a page shaped like Settings: a rail
// of pages beside the 640px column, with changes saved as they are made.
// Kept out of canopyApp.mjs, whose bytes the performance harness pins.
import { expect } from '@playwright/test';

/** The project settings page, a dialog named for the project. */
export function projectSettingsPage(app) {
  return app.window.getByTestId('project-settings-page');
}

/**
 * A page in the project settings rail: `general`, `scripts` (scripts and
 * hooks), `plans`, `plugins`, `environment`, `start-page` or `code-graph`.
 */
export function projectSettingsNav(app, page) {
  return app.window.getByTestId(`project-settings-nav-${page}`);
}

export async function openProjectSettingsPage(app, page) {
  await projectSettingsNav(app, page).click();
  await expect(
    app.window.getByTestId(`project-settings-page-${page}`),
  ).toBeVisible();
}

/**
 * Waits for the page to say "Saved" after a change. Call it right after the
 * first change on a resting line: an earlier change keeps saying "Saved" for
 * a moment, so after one use `expectStoredProject` instead.
 */
export async function waitForProjectSettingsSaved(app) {
  await expect(
    projectSettingsPage(app).getByTestId('settings-save-status'),
  ).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
}

/**
 * Waits until the stored project named `name` satisfies `matches`, read
 * through `loadProjects`, so a check proves this change was written.
 */
export async function expectStoredProject(app, name, matches) {
  await expect
    .poll(
      async () =>
        matches(
          await app.window.evaluate(
            async (projectName) =>
              (await window.api.loadProjects()).items.find(
                (item) => item.name === projectName,
              ) ?? null,
            name,
          ),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}
