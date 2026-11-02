import { expect } from '@playwright/test';

/**
 * App Advisor opens as a floating view, which has no Work Entry nav. Expand it
 * into the full window so a spec can switch entries. A no-op once the window
 * is already full (for example, when the opening helper expanded it).
 */
export async function expandAppAdvisorToFullWindow(advisor) {
  const floating = advisor.getByTestId('app-advisor-floating');
  const nav = advisor.getByTestId('app-advisor-nav');
  await expect(floating.or(nav)).toBeVisible();
  if (await floating.isVisible()) {
    await floating.getByRole('button', { name: 'Open full window' }).click();
  }
  await expect(nav).toBeVisible();
}
