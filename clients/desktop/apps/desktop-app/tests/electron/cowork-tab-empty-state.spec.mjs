import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * Cowork tab cold-start empty state — with no chat activity (the auto-provisioned
 * empty chat has messageCount 0) and only the default chat project, the Cowork
 * tab replaces the whole layout (conversation pane + workspace panel) with a
 * single centered "New Chat" CTA, mirroring the same single-centered-CTA
 * pattern the Code tab's zero-workspace Home surface uses.
 * Launches WITHOUT seeding any standalone-chat data so the app starts on a
 * genuine first-load state.
 *
 * Clicking the CTA runs startNewChat(), which flips selectedCenterPane to
 * 'active-chat' (without yet adding to `chats`), dismissing the cold-start view
 * and revealing the full split layout + composer.
 */
test('empty Cowork tab shows a centered New-Chat CTA that opens the full layout', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openChatPage();

    // The centered cold-start empty state is visible with its CTA.
    await expect(window.getByTestId('cowork-empty-state')).toBeVisible({
      timeout: 15_000,
    });
    const cta = window.getByTestId('empty-new-chat');
    await expect(cta).toBeVisible();
    // CTA renders `New ${CHAT_UNIT_LABEL}` from @canopy/protocol (default
    // brand → "New Chat"). Case-insensitive match keeps this from breaking on
    // brand label casing changes while still asserting the expected copy.
    await expect(cta).toContainText(/new chat/i);
    await expect(window.getByText('No chats yet')).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('cowork-tab-empty-state.png'),
    });

    // Clicking the CTA dismisses the cold-start view and renders the Cowork
    // panel grid. The persistent "New chat" affordance now lives in the
    // panel tab strip's `+` button.
    await cta.click();
    await expect(window.getByTestId('cowork-empty-state')).toHaveCount(0);
    await expect(
      window.locator('[data-testid^="panel-add-tab-"]').first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
