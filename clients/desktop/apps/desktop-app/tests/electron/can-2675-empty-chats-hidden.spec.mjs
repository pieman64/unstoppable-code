import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-2675: retain the header creation path while hiding the empty body.
// The default harness profile provisions the catch-all with zero work
// entries; provider traffic uses the harness mock server.
//
// CAN-2363 moved that workspace out of the Projects list into the top-level
// Chats section, so it is addressed by its fixed id rather than by name, it
// no longer carries `data-workspace-expanded` (it has no row header to
// expand), and its creation control is the Chats header's "+".
const WORKSPACE_ID = 'cowork-default';

test('an empty Chats section hides its body and shows the first chat without reload', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const chatsSection = window.getByTestId('sidebar-section-chats-content');
    const workspace = window.getByTestId(
      `sidebar-cowork-project-${WORKSPACE_ID}`,
    );
    await expect(workspace).toHaveCount(1);

    // Empty: no body, no rows, and no "No chats" placeholder anywhere in the
    // section — the point of CAN-2675.
    await expect(
      window.getByTestId(`sidebar-cowork-project-${WORKSPACE_ID}-empty`),
    ).toHaveCount(0);
    await expect(workspace).not.toContainText('No chats');
    await expect(chatsSection).not.toContainText('No chats');
    const body = workspace.locator(
      '[data-sidebar-folder-content="cowork-workspace"]',
    );
    await expect(body).toHaveCount(0);
    await expect(workspace.locator('[data-standalone-chat-id]')).toHaveCount(0);

    // The creation path survives: the Chats header keeps its "+" (the only
    // entry point besides New task on a fresh install), and Home composes
    // into the catch-all directly.
    const newChat = window.getByTestId('sidebar-section-chats-new-chat');
    await expect(newChat).toHaveCount(1);
    // ...and shows it at rest like the Projects "+", not only on hover.
    // `toBeVisible` accepts opacity 0, so read the computed opacity with the
    // pointer parked away from the rail.
    await window.mouse.move(0, 0);
    await expect
      .poll(() =>
        newChat.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe('1');
    // CAN-3973: an empty install lists no project either, so the Projects
    // "+" matches the Chats "+" at rest.
    const addProject = window.getByTestId('sidebar-section-code-add');
    await expect(addProject).toHaveCount(1);
    await expect
      .poll(() =>
        addProject.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe('1');
    // Required creation actions remain visible while both empty sections rest.
    for (const [toggleId, create] of [
      ['sidebar-section-chats-toggle', newChat],
      ['sidebar-section-code-toggle', addProject],
    ]) {
      const toggle = window.getByTestId(toggleId);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(create).toBeVisible();
      await expect(create).toHaveCSS('opacity', '1');
      await toggle.click();
      await toggle.focus();
      await toggle.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toBeFocused();
      await expect(create).toBeVisible();
      await expect(create).toHaveCSS('opacity', '1');
      await toggle.click();
    }
    const home = window.getByTestId('page-home');
    await expect(home).toBeVisible();
    await home
      .getByTestId('home-composer-editor')
      .fill('Write a short welcome message.');
    await home.getByTestId('home-send-button').click();

    await expect(body).toBeVisible();
    await expect(body.locator('[data-standalone-chat-id]')).toHaveCount(1);
    await expect(body.locator('[data-standalone-chat-id]')).toBeVisible();
    await expect(workspace).not.toContainText('No chats');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
