// A Claude chat's interface modes (the app's chat, Auto, Claude Code). The
// chat composer offers them under View in its + menu; the Claude Code
// terminal surface floats a toggle to switch back.
import { expect } from '@playwright/test';

/**
 * Switches the chat in `scope` (a chat panel or the App Advisor surface) to
 * `mode`: through the terminal's floating toggle when it is showing, else
 * through the composer's + menu.
 */
export async function chooseChatInterfaceMode(window, scope, mode) {
  const floating = scope
    .locator(`[data-testid="chat-interface-mode-toggle-${mode}"]:visible`)
    .first();
  if (await floating.isVisible()) {
    await floating.click();
    return;
  }
  await scope
    .locator('[data-testid="chat-input-plus-button"]:visible')
    .first()
    .click();
  const option = window.getByTestId(`chat-interface-mode-option-${mode}`);
  await expect(option).toBeVisible();
  await option.click();
}

/** Opens the composer's + menu and returns the View rows' container. */
export async function openChatInterfaceModeMenu(window, scope) {
  await scope
    .locator('[data-testid="chat-input-plus-button"]:visible')
    .first()
    .click();
  const view = window.getByTestId('chat-input-plus-view');
  await expect(view).toBeVisible();
  return view;
}
