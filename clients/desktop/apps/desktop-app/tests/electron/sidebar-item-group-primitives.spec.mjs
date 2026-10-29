import { expect, test } from '@playwright/test';
import { seedPanelWorktree } from './panelHarness.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { launchSidebarItemGroupHarness } from './sidebar-item-group-harness.mjs';

test('panel add submenu supports ArrowRight, ArrowLeft and Escape focus return', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    await window.getByTestId('panel-add-panel-group-chat').click();
    const trigger = window.getByTestId('panel-add-menu-terminal-submenu');
    await trigger.focus();
    await trigger.press('ArrowRight');
    const flyout = window.getByTestId('panel-add-menu-terminal-shells-group');
    await expect(flyout).toBeVisible();
    await window.keyboard.press('ArrowLeft');
    await expect(flyout).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.press('ArrowRight');
    await expect(flyout).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(flyout).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(window.getByTestId('panel-add-menu')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('shared group header, nested row menu, editor and legacy swatches remain keyboard operable', async () => {
  const { electronApp, userDataDir, window } =
    await launchSidebarItemGroupHarness();
  try {
    await window.getByTestId('sidebar-item-group-toggle').click();
    await expect(
      window.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(window.getByTestId('selected-member')).toBeVisible();
    await expect(
      window.getByText('Dark mode polish', { exact: true }),
    ).toBeHidden();
    await window.getByTestId('row-menu').press('Enter');
    const groupTrigger = window.getByTestId('sidebar-group-organize');
    await expect(groupTrigger).toBeFocused();
    await groupTrigger.press('ArrowRight');
    await expect(
      window.getByText('Edit group…', { exact: true }),
    ).toBeFocused();
    await window.keyboard.press('ArrowLeft');
    await expect(groupTrigger).toBeFocused();
    await groupTrigger.press('ArrowRight');
    await window.keyboard.press('Enter');
    const input = window.getByTestId('sidebar-item-group-name');
    await expect(input).toBeFocused();
    await input.fill('Discard this');
    await input.press('Escape');
    await expect(window.getByTestId('sidebar-item-group-toggle')).toContainText(
      'Frontend',
    );
    await expect(window.getByTestId('row-menu')).toBeFocused();
    await window.getByTestId('sidebar-item-group-header').hover();
    await window.getByTestId('sidebar-item-group-menu-trigger').click();
    await window.getByTestId('sidebar-item-group-edit').click();
    await input.fill('  Payments  ');
    await input.press('Enter');
    await window.getByRole('button', { name: 'Color 2', exact: true }).click();
    await window.getByTestId('sidebar-item-group-editor-close').click();
    await expect(window.getByTestId('sidebar-item-group-toggle')).toContainText(
      'Payments',
    );
    await expect(
      window.getByTestId('sidebar-item-group-menu-trigger'),
    ).toBeFocused();
    await window
      .getByTestId('legacy-swatches')
      .getByRole('button', { name: 'Color #0EA5E9', exact: true })
      .click();
    await expect(window.getByTestId('legacy-color')).toHaveText('#0EA5E9');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('hidden-label rail opens group options and ungroup returns focus to the former member', async () => {
  const { electronApp, userDataDir, window } =
    await launchSidebarItemGroupHarness();
  try {
    await window
      .getByTestId('sidebar-item-group-rail')
      .click({ button: 'right' });
    await window.getByTestId('sidebar-item-group-edit').click();
    await window.getByTestId('sidebar-item-group-name').press('Escape');
    await expect(window.getByTestId('selected-member')).toBeFocused();
    await window.getByTestId('sidebar-item-group-header').hover();
    await window.getByTestId('sidebar-item-group-menu-trigger').click();
    await window.getByTestId('sidebar-item-group-edit').click();
    await window.getByTestId('sidebar-item-group-show-name').click();
    await window.getByTestId('sidebar-item-group-editor-close').click();
    await expect(window.getByTestId('sidebar-item-group-header')).toHaveCount(
      0,
    );
    await window
      .getByTestId('sidebar-item-group-rail')
      .click({ button: 'right' });
    await expect(window.getByTestId('sidebar-item-group-menu')).toContainText(
      'Frontend · 2 worktrees',
    );
    await window.getByTestId('sidebar-item-group-ungroup').click();
    await expect(window.getByTestId('sidebar-item-group-rail')).toHaveCount(0);
    await expect(window.getByTestId('selected-member')).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('rail-menu collapse returns focus to the header when the first member is hidden', async () => {
  const { electronApp, userDataDir, window } =
    await launchSidebarItemGroupHarness('after', {
      hideFirstMemberOnCollapse: true,
    });
  try {
    await window
      .getByTestId('sidebar-item-group-rail')
      .click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Collapse group', exact: true })
      .click();
    await expect(window.getByTestId('selected-member')).toHaveCount(0);
    await expect(window.getByTestId('sidebar-item-group-toggle')).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Portal renderer expires an edit when the owner changes behind a stable client', async () => {
  const { launchPortalItemGroupOwnerHarness } =
    await import('./portal-item-group-owner-harness.mjs');
  const { electronApp, userDataDir, window } =
    await launchPortalItemGroupOwnerHarness();
  try {
    await window.getByTestId('sidebar-item-group-header').hover();
    await window.getByTestId('sidebar-item-group-menu-trigger').click();
    await window.getByTestId('sidebar-item-group-edit').click();
    await window.getByTestId('sidebar-item-group-name').fill('Local edit');
    await window.getByTestId('sidebar-item-group-name').press('Enter');
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('sidebar-item-group-header')).toContainText(
      'Local edit',
    );
    await window.getByTestId('replace-owner').click();
    await expect(window.getByTestId('sidebar-item-group-header')).toContainText(
      'Review',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Portal renderer does not apply a held creation ACK over a newer owner projection', async () => {
  const { launchPortalItemGroupOwnerHarness } =
    await import('./portal-item-group-owner-harness.mjs');
  const { electronApp, userDataDir, window } =
    await launchPortalItemGroupOwnerHarness();
  try {
    await window.getByTestId('sidebar-item-group-header').hover();
    await window.getByTestId('sidebar-item-group-create').click();
    await window.getByTestId('newer-projection').click();
    const destination = window.getByTestId(
      'sidebar-item-group-grp-destination',
    );
    await expect(destination.getByTestId('created-entry')).toBeVisible();
    await window.getByTestId('release-creation').click();
    await expect(window.getByTestId('fixture-selected')).toHaveText('created');
    await expect(destination).toContainText('Release');
    await expect(destination.getByTestId('created-entry')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
