import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Moving the pointer between neighbouring buttons hands the tooltip over:
// the next label shows at once, with no frame where no tooltip is showing
// and no second hover delay. The account row's Settings and Send feedback
// buttons sit side by side and both carry the shared tooltip.
test('tooltips hand off between neighbouring buttons without blinking', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const settings = window.getByTestId('sidebar-account-action-settings');
    const feedback = window.getByTestId('sidebar-account-action-feedback');
    // The first hover waits briefly instead of flashing the label at once.
    await settings.hover();
    await window.waitForTimeout(150);
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    await expect(
      window.getByRole('tooltip', { name: 'Settings', exact: true }),
    ).toBeVisible();

    // Record, every frame, which tooltips are on screen while the pointer
    // glides over to the neighbour at hand speed, crossing the gap between
    // the two buttons.
    await window.evaluate(() => {
      const frames = [];
      const sample = () => {
        const shown = [...document.querySelectorAll('[role="tooltip"]')].filter(
          (node) => getComputedStyle(node).visibility !== 'hidden',
        );
        frames.push({
          labels: shown.map((node) => node.textContent),
          sliding: shown.some((node) => node.getAnimations().length > 0),
        });
        if (window.__tooltipSampling) requestAnimationFrame(sample);
      };
      window.__tooltipFrames = frames;
      window.__tooltipSampling = true;
      requestAnimationFrame(sample);
    });
    const from = await settings.boundingBox();
    const to = await feedback.boundingBox();
    if (!from || !to) throw new Error('Account row buttons have no box');
    const y = from.y + from.height / 2;
    const startX = from.x + from.width / 2;
    const endX = to.x + to.width / 2;
    // Send feedback sits to the left of Settings; step towards it either way.
    const step = endX > startX ? 2 : -2;
    for (let x = startX; step > 0 ? x <= endX : x >= endX; x += step) {
      await window.mouse.move(x, y);
      await window.waitForTimeout(16);
    }
    await window.mouse.move(endX, y);
    await window.waitForTimeout(100);
    await window.evaluate(() => {
      window.__tooltipSampling = false;
    });
    const frames = await window.evaluate(() => window.__tooltipFrames);

    // Never zero or two tooltips, the neighbour's label once the pointer is
    // on it, and it jumps there with no motion.
    expect(frames.every(({ labels }) => labels.length === 1)).toBe(true);
    expect(frames.at(-1)?.labels).toEqual(['Send feedback']);
    expect(frames.some(({ sliding }) => sliding)).toBe(false);
    await window.screenshot({
      path: testInfo.outputPath('tooltip-handoff.png'),
    });

    // Leaving the row keeps it for a moment, then closes it.
    await window.mouse.move(300, 300);
    await expect(window.getByRole('tooltip')).toHaveCount(1);
    await expect(window.getByRole('tooltip')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
