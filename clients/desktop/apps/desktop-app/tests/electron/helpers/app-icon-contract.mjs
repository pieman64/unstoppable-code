import { expect } from '@playwright/test';

/** Verify actual host CSS, rather than only the generated SVG attributes. */
export async function expectAppIconContract(page) {
  const icons = page.locator(
    'svg[data-app-icon="true"][data-icon-family="lucide"]',
  );
  await expect(icons.first()).toBeVisible();
  const measurements = await icons.evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const css = getComputedStyle(element);
        return {
          glyph: element.dataset.glyph,
          width: Number.parseFloat(css.width),
          height: Number.parseFloat(css.height),
          stroke: css.strokeWidth,
        };
      }),
  );
  expect(measurements.length).toBeGreaterThan(5);
  expect(
    measurements.filter(
      (icon) =>
        ![14, 20].includes(icon.width) ||
        icon.width !== icon.height ||
        icon.stroke !== '2px',
    ),
  ).toEqual([]);
  expect(measurements.some((icon) => icon.width === 14)).toBe(true);
}

/** Project identities use compact filled white folders inside colored badges. */
export async function expectCompactProjectFolder(page, kind = 'single-repo') {
  const badge = page
    .locator(
      `[data-testid="workspace-kind-badge"][data-kind="${kind}"]:visible`,
    )
    .first();
  await expect(badge).toBeVisible();
  const icon = badge.locator('svg');
  await expect(icon).toHaveAttribute('data-glyph', 'folder-fill1');
  await expect(icon).toHaveCSS('width', '14px');
  await expect(icon).toHaveCSS('height', '14px');
  await expect(badge).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(badge).toHaveCSS('width', '16px');
  await expect(badge).toHaveCSS('height', '16px');
  const paint = await icon.evaluate((el) => ({
    color: getComputedStyle(el).color,
    fill: getComputedStyle(el.querySelector('path')).fill,
  }));
  const artwork = await icon.boundingBox();
  expect(artwork?.width).toBeCloseTo(10.5, 1);
  expect(artwork?.height).toBeCloseTo(10.5, 1);
  expect(paint.fill).toBe(paint.color);
  expect(paint.fill).toBe('rgb(255, 255, 255)');
}

export async function expectCoworkProjectFolder(page) {
  await expectCompactProjectFolder(page, 'cowork');
}
