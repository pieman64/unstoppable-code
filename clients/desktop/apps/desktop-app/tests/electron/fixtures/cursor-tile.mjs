import { expect } from '@playwright/test';

/**
 * Waits for the Cursor tile to settle connected and idle. Like the Claude and
 * Codex rows, that state has no status line of its own: the setup and
 * progress line is gone and the signed-in line has taken its place, so the
 * tile is matched on both at once.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ timeout?: number }} [options]
 */
export async function expectCursorConnected(page, options = {}) {
  await expect(
    page.getByTestId('cursor-connection').filter({
      has: page.getByTestId('cursor-connection-account'),
      hasNot: page.getByTestId('cursor-connection-status'),
    }),
  ).toBeVisible(options);
}
