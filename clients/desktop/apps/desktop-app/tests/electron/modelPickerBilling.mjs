import { expect } from '@playwright/test';

/**
 * The composer's harness model picker sets billing from each model's own
 * menu (Auto included); there is no chat-wide billing toggle. These helpers
 * drive that menu the way a user does.
 */

const visible = (root, testId) =>
  root.locator(`[data-testid="${testId}"]:visible`).first();

/**
 * Scrolling the list suppresses row hover until the pointer moves with real
 * movement, which a person always does on the way to a row. Automation mouse
 * moves report zero movement, so send that one move.
 */
async function nudgePointer(locator) {
  await locator.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        movementX: 1,
        movementY: 1,
      }),
    );
  });
}

/** Open the visible composer's model picker if it is not open yet. */
export async function openModelPicker(window) {
  const menu = window.getByTestId('chat-model-menu');
  if (!(await menu.isVisible())) {
    await window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first()
      .click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

/** Close the picker and any flyout or row menu open inside it. */
export async function closeModelPicker(window) {
  const menu = window.getByTestId('chat-model-menu');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await menu.count()) === 0) return;
    await window.keyboard.press('Escape');
  }
  await expect(menu).toHaveCount(0, { timeout: 10_000 });
}

/**
 * Reveal a model's row in All, opening its vendor's Legacy models flyout
 * when the model is a legacy one.
 */
async function revealModelRow(window, menu, modelId) {
  const row = visible(window, `chat-model-option-${modelId}`);
  if (await row.isVisible()) return row;
  const triggers = await menu
    .locator('[data-testid^="chat-model-more-"]:visible')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('data-testid') ?? '')
        .filter((testId) => !testId.startsWith('chat-model-more-group-')),
    );
  for (const testId of triggers) {
    await visible(menu, testId).click();
    if (await row.isVisible()) return row;
  }
  await expect(row).toBeVisible();
  return row;
}

/**
 * Open `modelId`'s billing menu from the composer picker and return its
 * choices. `aria-checked` marks the chat's current billing.
 */
export async function openModelBillingMenu(window, modelId) {
  const menu = await openModelPicker(window);
  const allTab = menu.getByTestId('chat-model-harness-tab-all');
  if ((await allTab.count()) > 0) await allTab.click();
  const row = await revealModelRow(window, menu, modelId);
  await row.scrollIntoViewIfNeeded();
  await nudgePointer(row);
  await row.hover();
  const trigger = window
    .locator(
      `[data-testid="chat-model-billing-${modelId}"]:visible, [data-testid="chat-model-harness-control-${modelId}"]:visible`,
    )
    .first();
  await trigger.click();
  const billingMenu = window.getByTestId(`chat-model-billing-menu-${modelId}`);
  await expect(billingMenu).toBeVisible();
  return {
    subscription: billingMenu.getByTestId(
      `chat-model-billing-subscription-${modelId}`,
    ),
    credits: billingMenu.getByTestId(`chat-model-billing-credits-${modelId}`),
  };
}

/**
 * Whether any row in the open picker offers a billing menu. Billing that is
 * locked for this chat offers none.
 */
export function offeredBillingMenus(window) {
  // Row menu triggers mark themselves when their menu holds billing choices,
  // whether they show as ••• or as the row's harness icon.
  return window.locator(
    '[data-testid="chat-model-menu"] [data-billing-menu="true"]',
  );
}

/** Open the billing menu of whichever model the chat has selected. */
export async function openSelectedModelBillingMenu(window) {
  const menu = await openModelPicker(window);
  const allTab = menu.getByTestId('chat-model-harness-tab-all');
  if ((await allTab.count()) > 0) await allTab.click();
  const selected = menu
    .locator('[data-model-id][aria-checked="true"]:visible')
    .first();
  await expect(selected).toBeVisible();
  const modelId = await selected.getAttribute('data-model-id');
  if (!modelId) throw new Error('The selected row has no model id');
  return openModelBillingMenu(window, modelId);
}
