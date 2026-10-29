import { test, expect } from '@playwright/test';
import { launchPortalChatsGroupCompositionHarness } from './portal-chats-group-composition-harness.mjs';
import { closeCanopy } from './launchCanopy.mjs';
test('Portal grouped Chats retain group actions and viewer notification choices together', async () => {
  const app = await launchPortalChatsGroupCompositionHarness();
  try {
    const row = app.window.getByTestId('portal-chats-work-entry-entry-a');
    await row.hover();
    // #4586 named the shared row ••• "More actions".
    await row
      .getByRole('button', { name: 'More actions', exact: true })
      .click();
    await expect(
      app.window.getByRole('menuitem', { name: 'Group', exact: true }),
    ).toBeVisible();
    await app.window
      .getByRole('menuitemradio', { name: 'Mute', exact: true })
      .click();
    await expect(
      app.window.getByTestId('fixture-notification-choice'),
    ).toHaveText('mute');
  } finally {
    await closeCanopy(app.electronApp, app.userDataDir);
  }
});
test('Portal collapsed grouped Chats retain just the selected entry without group drag controls', async () => {
  const app = await launchPortalChatsGroupCompositionHarness();
  try {
    await app.window.getByTestId('fixture-chats-toggle').click();
    await expect(
      app.window.getByTestId('portal-chats-work-entry-entry-a'),
    ).toBeVisible();
    await expect(
      app.window.getByTestId('portal-chats-work-entry-entry-b'),
    ).toHaveCount(0);
    await expect(
      app.window.locator('[data-sidebar-item-group-id]'),
    ).toHaveCount(0);
    await expect(app.window.getByTestId('sidebar-item-group-drag')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(app.electronApp, app.userDataDir);
  }
});
