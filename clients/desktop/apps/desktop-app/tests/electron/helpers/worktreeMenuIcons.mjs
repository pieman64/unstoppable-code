import { expect } from '@playwright/test';

/** Check rendered icon content and real label geometry, including colored dots. */
export async function expectAlignedWorktreeMenuIcons(menu) {
  await expect(menu).toBeVisible();
  const rows = await menu.getByRole('menuitem').evaluateAll((elements) =>
    elements.map((row) => {
      const slot = row.firstElementChild;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let label;
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim()) {
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          label =
            range.getBoundingClientRect().left -
            row.getBoundingClientRect().left;
          break;
        }
      }
      return { label, hasIcon: !!slot?.firstElementChild };
    }),
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.hasIcon)).toBe(true);
  expect(rows.every((row) => typeof row.label === 'number')).toBe(true);
  const positions = rows.map((row) => row.label);
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(
    1,
  );
}
