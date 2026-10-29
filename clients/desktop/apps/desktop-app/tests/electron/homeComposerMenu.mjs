// The New task (Home) composer keeps Plan mode and Pipeline in its + menu,
// under Current settings. While Plan is on, its tile sits beside +, as in a
// chat composer; Pipeline lights + instead.
import { expect } from '@playwright/test';

export const HOME_PLAN_MODE_ITEM = 'home-plan-mode-button';
export const HOME_PIPELINE_MODE_ITEM = 'home-pipeline-mode-button';

/** Opens the Home composer's + menu and picks the row `itemTestId`. */
export async function pickHomeComposerMenuItem(window, home, itemTestId) {
  await home.getByTestId('home-composer-plus-button').click();
  const item = window.getByTestId(itemTestId);
  await expect(item).toBeVisible();
  await item.click();
}

/** Toggles Pipeline mode from the Home composer's + menu. */
export async function toggleHomePipelineMode(window, home) {
  await pickHomeComposerMenuItem(window, home, HOME_PIPELINE_MODE_ITEM);
}

/** Toggles Plan mode from the Home composer's + menu. */
export async function toggleHomePlanMode(window, home) {
  await pickHomeComposerMenuItem(window, home, HOME_PLAN_MODE_ITEM);
}
