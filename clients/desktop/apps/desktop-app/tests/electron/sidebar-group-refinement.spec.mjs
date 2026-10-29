/** Root creation and both ungroup actions must persist in Chats and Cowork. */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  expandCoworkWorkspace,
  openWorkEntryMenu,
} from './coworkWorkEntryDoneFixture.mjs';
import {
  seedChatsSectionFixture,
  CHATS_SECTION_DEFAULT_COWORK_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
  CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
} from './seeders/seedChatsSectionFixture.mjs';

async function visibleBox(locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null)
    throw new Error('Visible sidebar element has no bounding box');
  return box;
}
test('group header places disclosure before text and yields its right counter to actions', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-layout-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 1, chatEntryCount: 2 });
  const scope = { workspaceLocalId: CHATS_SECTION_NAMED_COWORK_ID };
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const saved = await window.evaluate(
      (scope) =>
        window.api.sidebarItemGroups.create({
          scope,
          itemId: 'entry-research-plan',
          name: 'Support work',
        }),
      scope,
    );
    await window.reload();
    await app.waitForShell();
    await expandCoworkWorkspace(window, scope.workspaceLocalId);
    const group = window.locator(`[data-sidebar-item-group-id="${saved.id}"]`);
    const toggle = group.getByTestId('sidebar-item-group-toggle');
    const chevron = toggle.locator('svg');
    const label = toggle.getByText('Support work', { exact: true });
    expect((await visibleBox(chevron)).x).toBeLessThan(
      (await visibleBox(label)).x,
    );
    const projectLabel = window
      .getByTestId(`sidebar-cowork-project-${scope.workspaceLocalId}-toggle`)
      .locator('span[title]');
    expect((await visibleBox(label)).x).toBeCloseTo(
      (await visibleBox(projectLabel)).x,
      0,
    );
    await toggle.click();
    const count = group.getByText('1', { exact: true });
    await expect(count).toBeVisible();
    await expect(
      group.getByTestId('sidebar-item-group-menu-trigger'),
    ).toBeHidden();
    await expect(group.getByTestId('sidebar-item-group-create')).toBeHidden();
    const header = group.getByTestId('sidebar-item-group-header');
    const headerBox = await visibleBox(header);
    const countBox = await visibleBox(count);
    expect(
      headerBox.x + headerBox.width - (countBox.x + countBox.width),
    ).toBeLessThan(15);
    await window.mouse.move(600, 400);
    await header.hover();
    await expect(count).toBeHidden();
    await expect(
      group.getByTestId('sidebar-item-group-menu-trigger'),
    ).toBeVisible();
    await expect(group.getByTestId('sidebar-item-group-create')).toBeVisible();
    await group.getByTestId('sidebar-item-group-menu-trigger').focus();
    await window.mouse.move(600, 400);
    await expect(count).toBeHidden();
    await group.getByTestId('sidebar-item-group-menu-trigger').click();
    await window.mouse.move(600, 400);
    await expect(count).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const surface of ['Chats', 'Cowork']) {
  for (const action of ['root creation', 'remove entry', 'ungroup']) {
    test(`${surface} ${action} preserves ungrouped membership`, async () => {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'sidebar-group-refinement-'),
      );
      const fixture = seedChatsSectionFixture(userDataDir, {
        worktreeCount: 1,
        chatEntryCount: 2,
      });
      const scope = {
        workspaceLocalId:
          surface === 'Chats'
            ? CHATS_SECTION_DEFAULT_COWORK_ID
            : CHATS_SECTION_NAMED_COWORK_ID,
      };
      const itemId =
        surface === 'Chats'
          ? fixture.chatEntryIds[0]
          : CHATS_SECTION_NAMED_COWORK_ENTRY_ID;
      const { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        const saved = await window.evaluate(
          async ({ scope, itemId }) => {
            const group = await window.api.sidebarItemGroups.create({
              scope,
              itemId,
              name: 'Support work',
            });
            const empty = await window.api.workEntries.create({
              projectId: scope.workspaceLocalId,
              sidebarItemGroupId: group.id,
            });
            return { group, emptyId: empty.entry.id };
          },
          { scope, itemId },
        );
        await window.reload();
        await app.waitForShell();
        if (surface === 'Cowork')
          await expandCoworkWorkspace(window, scope.workspaceLocalId);
        const group = window.locator(
          `[data-sidebar-item-group-id="${saved.group.id}"]`,
        );
        await expect(group).toBeVisible();
        await group.getByTestId('sidebar-item-group-header').hover();
        await group.getByTestId('sidebar-item-group-create').click();
        await expect(
          group.getByTestId(`sidebar-work-entry-${saved.emptyId}`),
        ).toBeVisible();
        if (action === 'root creation') {
          const create =
            surface === 'Chats'
              ? window.getByRole('button', { name: 'New chat', exact: true })
              : window.getByTestId(
                  `sidebar-cowork-project-${scope.workspaceLocalId}-new-chat`,
                );
          // Header controls reveal on hover of their header (#4586), as a
          // pointer reaching for them would.
          await window
            .getByTestId(
              surface === 'Cowork'
                ? `sidebar-cowork-project-${scope.workspaceLocalId}-toggle`
                : 'sidebar-section-chats-toggle',
            )
            .hover();
          await create.click();
          await expect(
            group.getByTestId(`sidebar-work-entry-${saved.emptyId}`),
          ).toHaveCount(0);
          await expect(
            window.getByTestId(`sidebar-work-entry-${saved.emptyId}`),
          ).toBeVisible();
        } else if (action === 'remove entry') {
          await openWorkEntryMenu(window, saved.emptyId);
          await window
            .getByRole('menuitem', { name: 'Group', exact: true })
            .hover();
          await window
            .getByRole('menuitem', { name: 'Remove from group', exact: true })
            .click();
          await expect(
            group.getByTestId(`sidebar-work-entry-${saved.emptyId}`),
          ).toHaveCount(0);
          await expect(
            window.getByTestId(`sidebar-work-entry-${saved.emptyId}`),
          ).toBeVisible();
        } else {
          await group.getByTestId('sidebar-item-group-header').hover();
          await group.getByTestId('sidebar-item-group-menu-trigger').click();
          await window.getByTestId('sidebar-item-group-ungroup').click();
          await expect(group).toHaveCount(0);
          await expect(
            window.getByTestId(`sidebar-work-entry-${saved.emptyId}`),
          ).toBeVisible();
        }
        const expected =
          action === 'ungroup'
            ? []
            : [
                expect.objectContaining({
                  id: saved.group.id,
                  memberIds: [itemId],
                }),
              ];
        await expect
          .poll(() =>
            window.evaluate(
              (scope) => window.api.sidebarItemGroups.list(scope),
              scope,
            ),
          )
          .toEqual(expected);
        await window.getByTestId(`sidebar-work-entry-${itemId}`).click();
        await window.reload();
        await app.waitForShell();
        if (surface === 'Cowork')
          await expandCoworkWorkspace(window, scope.workspaceLocalId);
        await expect(
          window.getByTestId(`sidebar-work-entry-${itemId}`),
        ).toBeVisible();
        await expect(
          group.getByTestId(`sidebar-work-entry-${saved.emptyId}`),
        ).toHaveCount(0);
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }
}
