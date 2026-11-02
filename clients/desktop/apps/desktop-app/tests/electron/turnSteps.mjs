import { expect } from '@playwright/test';

/** Expand retained work headers and any nested summary they reveal. */
export async function expandTurnSteps(page) {
  const toggles = page.locator(
    '[data-testid="chat-turn-summary"], [data-testid="chat-message-list-scroll"] button[data-step-row][aria-expanded]',
  );
  await expect(toggles.first()).toBeVisible();
  const collapsed = page.locator(
    '[data-testid="chat-turn-summary"][aria-expanded="false"], [data-testid="chat-message-list-scroll"] button[data-step-row][aria-expanded="false"]',
  );
  for (let pass = 0; pass < 10 && (await collapsed.count()) > 0; pass += 1) {
    const toggle = await collapsed.first().elementHandle();
    if (!toggle) throw new Error('Collapsed turn control disappeared');
    await toggle.click();
    await expect
      .poll(() =>
        toggle.evaluate(
          (element) =>
            !element.isConnected ||
            element.getAttribute('aria-expanded') === 'true',
        ),
      )
      .toBe(true);
  }
  await expect(collapsed).toHaveCount(0);
}
