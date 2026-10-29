/**
 * Recipient-side invitation actions (CAN-4052).
 *
 * A pending share's sidebar row opens a dialog; accepting and removing happen
 * there. Every spec that accepts or removes an invitation goes through these
 * helpers, so the flow is described once.
 */
import { expect } from '@playwright/test';

const DIALOG_TEST_ID = 'shared-container-invitation-dialog';

/** Opens the invitation dialog from the share's sidebar row. */
export async function openSharedContainerInvitation(window, containerId) {
  await window
    .getByTestId(`shared-container-invitation-${containerId}`)
    .click();
  const dialog = window.getByTestId(DIALOG_TEST_ID);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Accepts an invitation and waits for its dialog to close, which is when the
 * acceptance has been recorded and the share has become an accepted row.
 */
export async function acceptSharedContainerInvitation(window, containerId) {
  const dialog = await openSharedContainerInvitation(window, containerId);
  await window.getByTestId(`${DIALOG_TEST_ID}-accept`).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Removes an invitation. There is no second confirmation: the share can be
 * restored from Past shares.
 */
export async function removeSharedContainerInvitation(window, containerId) {
  const dialog = await openSharedContainerInvitation(window, containerId);
  await window.getByTestId(`${DIALOG_TEST_ID}-remove`).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}
