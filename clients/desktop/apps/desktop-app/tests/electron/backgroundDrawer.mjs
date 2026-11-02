import { expect } from '@playwright/test';

/** Counts stay readable beside Needs you in a narrow split-pane drawer. */
export async function expectDrawerSummaryFits(drawer) {
  const previous = await drawer.evaluate((element) => {
    const style = element.getAttribute('style');
    element.style.width = '320px';
    element.style.maxWidth = '320px';
    return style;
  });
  try {
    const summary = drawer.getByTestId('composer-work-drawer-toggle');
    const attention = await summary
      .getByTestId('composer-work-summary-attention')
      .boundingBox();
    const summaryBox = await summary.boundingBox();
    expect(attention).not.toBeNull();
    expect(summaryBox).not.toBeNull();
    const items = summary.getByTestId('composer-work-summary-item');
    expect(await items.count()).toBeGreaterThan(0);
    for (const item of await items.all()) {
      const box = await item.boundingBox();
      expect(box).not.toBeNull();
      expect(box.x + box.width).toBeLessThanOrEqual(attention.x);
      expect(box.y).toBeGreaterThanOrEqual(summaryBox.y);
      expect(box.y + box.height).toBeLessThanOrEqual(
        summaryBox.y + summaryBox.height,
      );
    }
  } finally {
    await drawer.evaluate((element, style) => {
      if (style === null) element.removeAttribute('style');
      else element.setAttribute('style', style);
    }, previous);
  }
}

/**
 * Opens the composer's background drawer in `panel` and returns it. The
 * drawer lists the chat's background agents, tasks and live runs, with their
 * Stop and Stop all (background drawer D2).
 */
export async function openBackgroundDrawer(panel, { timeout = 30_000 } = {}) {
  const tray = panel.getByTestId('composer-work-drawer');
  await expect(tray).toBeVisible({ timeout });
  if (
    (await tray
      .getByTestId('composer-work-drawer-toggle')
      .getAttribute('aria-expanded')) !== 'true'
  ) {
    await tray.getByTestId('composer-work-drawer-toggle').click();
  }
  await expect(tray.getByTestId('composer-work-drawer-toggle')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  return tray;
}

/** Running job indicators move, and remain still under reduced motion. */
export async function expectDrawerSpinnerMotion(page, scope) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const spinner = scope
    .getByTestId('dag-progress-dots')
    .locator('[data-spinner="comet"]')
    .first();
  await spinner.scrollIntoViewIfNeeded();
  const currentTime = () =>
    spinner.evaluate((element) => {
      const animation = element
        .getAnimations({ subtree: true })
        .find((entry) => entry.playState === 'running');
      return typeof animation?.currentTime === 'number'
        ? animation.currentTime
        : 0;
    });
  const start = await currentTime();
  await expect.poll(currentTime).toBeGreaterThan(start + 20);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      spinner.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some((entry) => entry.playState === 'running'),
      ),
    )
    .toBe(false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}
