import { expect } from '@playwright/test';
import { SUBAGENT_VIEWER_LONG_WRITE_PATHS } from './seeders/subagentViewerCapture.mjs';

/**
 * Long write paths collapse behind Show more, and the open details scroll
 * inside the panel instead of pushing the transcript and composer out of it.
 * Pass the paths the host delivers when it bounds the list (the Portal wire
 * projection keeps the most recent eight).
 */
export async function expectLongDetailsScrollWithinPanel(
  chat,
  writePaths = SUBAGENT_VIEWER_LONG_WRITE_PATHS,
) {
  const total = writePaths.length;
  const paths = chat.locator(
    '[data-testid="subagent-chat-permissions-paths"] li',
  );
  await expect(chat.getByTestId('subagent-chat-details-setup')).toContainText(
    `Read/search and edits within ${total} paths`,
  );
  await expect(paths).toHaveCount(5);
  const toggle = chat.getByTestId('subagent-chat-permissions-toggle');
  await expect(toggle).toHaveText(`Show more (${total - 5})`);
  await toggle.click();
  await expect(paths).toHaveCount(total);
  await expect(toggle).toHaveText('Show less');
  await expect(paths).toHaveText(writePaths);
  await expect(paths.locator('.ph-no-capture')).toHaveCount(total);
  await expect(
    toggle.locator('xpath=ancestor::*[contains(@class, "ph-no-capture")]'),
  ).toHaveCount(0);

  await toggle.click();
  await expect(paths).toHaveText(writePaths.slice(0, 5));
  await expect(paths.locator('.ph-no-capture')).toHaveCount(5);
  await toggle.click();
  await expect(paths).toHaveText(writePaths);

  const details = chat.getByTestId('subagent-chat-details');
  await expect
    .poll(() =>
      details.evaluate((element) => ({
        scrolls: element.scrollHeight > element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
      })),
    )
    .toEqual({ scrolls: true, overflowY: 'auto' });
  const panelBox = await chat.boundingBox();
  const detailsBox = await details.boundingBox();
  if (!panelBox || !detailsBox) throw new Error('details are not laid out');
  expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(
    panelBox.y + panelBox.height / 2 + 120,
  );
  await expect(chat.getByTestId('subagent-composer')).toBeInViewport();
  await expect
    .poll(() =>
      chat
        .getByTestId('subagent-chat-scroll')
        .evaluate((element) => element.clientHeight),
    )
    .toBeGreaterThan(0);

  const lastPath = paths.last();
  await lastPath.scrollIntoViewIfNeeded();
  await expect(lastPath).toBeInViewport();
  await expect(lastPath).toHaveText(writePaths[total - 1]);
}
