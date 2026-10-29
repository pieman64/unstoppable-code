// Shared assertion for panel chrome control order (CAN-4271): the collapse /
// expand caret is the trailing control after the layout menu.

import { expect } from '@playwright/test';

/**
 * Asserts the layout menu precedes the collapse/expand caret in DOM order and
 * on screen: along a row the caret's left edge clears the menu's right edge;
 * down a vertical strip the caret sits below the menu and above the first
 * tab icon. Retries until layout settles.
 */
export async function expectCaretAfterMenu(
  page,
  { menuId, caretId, nextId, axis },
) {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ menuId, caretId, nextId, axis }) => {
            const byId = (id) =>
              id === null
                ? null
                : document.querySelector(`[data-testid="${id}"]`);
            const menu = byId(menuId);
            const caret = byId(caretId);
            const next = byId(nextId);
            if (menu === null || caret === null) return 'missing';
            if (nextId !== null && next === null) return 'missing next';
            const following = (a, b) =>
              Boolean(
                a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
              );
            if (!following(menu, caret)) return 'caret before menu';
            if (next !== null && !following(caret, next)) {
              return 'caret after next';
            }
            const m = menu.getBoundingClientRect();
            const c = caret.getBoundingClientRect();
            if (
              m.width === 0 ||
              c.width === 0 ||
              m.height === 0 ||
              c.height === 0
            )
              return 'unsized';
            if (axis === 'row') {
              if (Math.abs(c.top - m.top) > 1) return 'wrapped';
              const header = caret.closest(
                '.canopy-panel-group-title, .canopy-panel-collapsed-bar',
              );
              if (
                header === null ||
                header
                  .querySelectorAll('button')
                  .item(header.querySelectorAll('button').length - 1) !== caret
              )
                return 'caret not last';
              return c.left >= m.right - 0.5 ? 'ok' : 'overlap';
            }
            if (c.top < m.bottom - 0.5) return 'overlap';
            if (next === null) return 'missing first tab';
            const n = next.getBoundingClientRect();
            if (n.width === 0 || n.height === 0) return 'unsized next';
            return n.top >= c.bottom - 0.5 ? 'ok' : 'overlap next';
          },
          { menuId, caretId, nextId, axis },
        ),
      { timeout: 10_000 },
    )
    .toBe('ok');
}

/** Resize the right activity group to its real minimum through its sash. */
export async function constrainActivityHeader(page, groupId) {
  const sash = page.locator('.canopy-sash.vertical:visible');
  await expect(sash).toHaveCount(1);
  const box = await sash.boundingBox();
  expect(box).not.toBeNull();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + 500, y, { steps: 10 });
  } finally {
    await page.mouse.up();
  }
  const header = page.getByTestId(`panel-group-title-${groupId}`);
  await expect
    .poll(async () => (await header.boundingBox())?.width)
    .toBeLessThanOrEqual(321);
  await expectCaretAfterMenu(page, {
    menuId: `panel-group-menu-${groupId}`,
    caretId: `panel-group-collapse-${groupId}`,
    nextId: null,
    axis: 'row',
  });
  for (const id of [
    `panel-group-menu-${groupId}`,
    `panel-group-collapse-${groupId}`,
  ]) {
    await expect
      .poll(() =>
        page.getByTestId(id).evaluate((button) => {
          const bounds = button
            .closest('.canopy-panel-group-title')
            .getBoundingClientRect();
          const rect = button.getBoundingClientRect();
          return (
            rect.left >= bounds.left &&
            rect.right <= bounds.right &&
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom
          );
        }),
      )
      .toBe(true);
  }
}

/** Check the relocated menu at the right viewport edge, then dismiss it. */
export async function expectLayoutMenuAnchored(page, groupId) {
  const trigger = page.getByTestId(`panel-group-menu-${groupId}`);
  const menu = page.getByTestId(`panel-group-actions-menu-${groupId}`);
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect
    .poll(async () => {
      const t = await trigger.boundingBox();
      const m = await menu.boundingBox();
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      if (t === null || m === null) return false;
      return (
        viewport.width - t.x - t.width <= 100 &&
        Math.abs(m.x + m.width - t.x - t.width) <= 1 &&
        Math.abs(m.y - t.y - t.height - 4) <= 1 &&
        m.x >= 0 &&
        m.y >= 0 &&
        m.x + m.width <= viewport.width &&
        m.y + m.height <= viewport.height
      );
    })
    .toBe(true);
  await expect(
    page.getByTestId(`panel-group-split-${groupId}-left`),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
}
