/** Durable Advisor UI group creation, selection and registry-order coverage. */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedAdvisorGroups } from './seeders/advisorItemGroupsFixture.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('Advisor creates a named group through its row menu and retains selected collapsed chat', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-advisor-groups-'),
  );
  seedAdvisorGroups(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const main = await electronApp.firstWindow();
    const app = new CanopyAppDriver(main);
    await app.waitForShell();
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const first = advisor.getByTestId('app-advisor-nav-entry-advisor-first');
    await expect(first).toBeVisible();
    await first.click();
    await first.getByTestId('app-advisor-nav-entry-advisor-first-menu').click();
    await advisor
      .getByRole('menuitem', { name: 'Add to new group', exact: true })
      .click({ timeout: 5000 });
    await advisor.getByTestId('sidebar-item-group-name').fill('Investigations');
    await advisor.getByTestId('sidebar-item-group-name').press('Enter');
    await expect(advisor.getByTestId('sidebar-item-group-editor')).toHaveCount(
      0,
    );
    const groups = await advisor.evaluate(() =>
      window.api.sidebarItemGroups.list({ appAdvisor: true }),
    );
    expect(groups).toHaveLength(1);
    const group = advisor.locator(
      `[data-sidebar-item-group-id="${groups[0].id}"]`,
    );
    await expect(group).toContainText('Investigations');
    await group.getByTestId('sidebar-item-group-header').hover();
    await group.getByTestId('sidebar-item-group-menu-trigger').click();
    await advisor
      .getByRole('menuitem', { name: 'Edit group…', exact: true })
      .click();
    await expect(advisor.getByTestId('sidebar-item-group-name')).toBeVisible();
    await expect
      .poll(
        async () =>
          (await dispatchAdvisorAction(electronApp, null)).uiState.snapshot
            .appAdvisor.groupEditorId,
      )
      .toBe(groups[0].id);
    await advisor.keyboard.press('Escape');
    await expect
      .poll(
        async () =>
          (await dispatchAdvisorAction(electronApp, null)).uiState.snapshot
            .appAdvisor.groupEditorId,
      )
      .toBeNull();

    await group.getByTestId('sidebar-item-group-toggle').click();
    await expect(first).toBeVisible();
    await expect(
      group.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

async function dispatchAdvisorAction(electronApp, action) {
  return electronApp.evaluate(({ BrowserWindow, ipcMain }, action) => {
    const main = BrowserWindow.getAllWindows().find(
      (w) => !w.webContents.getURL().includes('surface=app-advisor'),
    );
    if (!main) throw new Error('Main window missing');
    ipcMain.removeHandler('app-advisor:tool-response');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeHandler('app-advisor:tool-response');
        reject(new Error('Advisor action timeout'));
      }, 15000);
      ipcMain.handleOnce('app-advisor:tool-response', (_event, result) => {
        clearTimeout(timer);
        resolve(result);
      });
      main.webContents.send('app-advisor:tool-request', {
        kind: action === null ? 'get_current_ui_state' : 'dispatch_action',
        requestId: `groups-${Date.now()}`,
        action,
      });
    });
  }, action);
}

test('Advisor typed group commands persist the same metadata and update its other window', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-advisor-actions-'),
  );
  seedAdvisorGroups(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const main = await electronApp.firstWindow();
    const app = new CanopyAppDriver(main);
    await app.waitForShell();
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const scope = { appAdvisor: true };
    const created = await dispatchAdvisorAction(electronApp, {
      type: 'sidebar.item_groups.create',
      scope,
      itemId: 'advisor-first',
      name: 'Action group',
    });
    expect(created.ok).toBe(true);
    const groupId = created.result.groupId;
    await expect(
      advisor.locator(`[data-sidebar-item-group-id="${groupId}"]`),
    ).toContainText('Action group');
    expect(
      (
        await dispatchAdvisorAction(electronApp, {
          type: 'sidebar.item_groups.move_item',
          scope,
          itemId: 'advisor-second',
          groupId,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await dispatchAdvisorAction(electronApp, {
          type: 'sidebar.item_groups.update',
          scope,
          groupId,
          color: 'categorical-3',
          name: 'Updated group',
          collapsed: true,
        })
      ).ok,
    ).toBe(true);
    const listed = await dispatchAdvisorAction(electronApp, {
      type: 'sidebar.item_groups.list',
      scope,
    });
    expect(listed.result.groups).toEqual([
      {
        id: groupId,
        name: 'Updated group',
        color: 'categorical-3',
        collapsed: true,
        memberIds: ['advisor-first', 'advisor-second'],
        order: 0,
      },
    ]);
    await expect(
      advisor.locator(`[data-sidebar-item-group-id="${groupId}"]`),
    ).toContainText('Updated group');
    expect(
      (
        await dispatchAdvisorAction(electronApp, {
          type: 'sidebar.item_groups.move_item',
          scope,
          itemId: 'advisor-first',
          groupId: null,
          after: 'advisor-second',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await dispatchAdvisorAction(electronApp, {
          type: 'sidebar.item_groups.move_group',
          scope,
          groupId,
          after: 'advisor-first',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await dispatchAdvisorAction(electronApp, {
          type: 'sidebar.item_groups.ungroup',
          scope,
          groupId,
        })
      ).ok,
    ).toBe(true);
    await expect(advisor.locator('[data-sidebar-item-group-id]')).toHaveCount(
      0,
    );
    const entries = await advisor.evaluate(() =>
      window.api.workEntries.list({ projectId: 'app-advisor' }),
    );
    expect(entries.entries.map((e) => e.id)).toEqual([
      'advisor-first',
      'advisor-second',
    ]);
    for (const invalid of [
      {
        type: 'sidebar.item_groups.create',
        scope: { workspaceLocalId: 'missing-workspace' },
        itemId: 'advisor-first',
      },
      {
        type: 'sidebar.item_groups.create',
        scope: { appAdvisor: true, workspaceLocalId: 'missing-workspace' },
        itemId: 'advisor-first',
      },
      { type: 'sidebar.item_groups.create', scope, itemId: 'outside-item' },
      {
        type: 'sidebar.item_groups.move_item',
        scope,
        itemId: 'advisor-first',
        groupId: null,
        before: 'advisor-second',
        after: 'advisor-second',
      },
    ])
      expect((await dispatchAdvisorAction(electronApp, invalid)).ok).toBe(
        false,
      );
    expect(
      await advisor.evaluate(() =>
        window.api.sidebarItemGroups.list({ appAdvisor: true }),
      ),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Advisor keyboard row ordering survives reload and group creation confirms before projection', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-advisor-order-'),
  );
  seedAdvisorGroups(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const main = await electronApp.firstWindow();
    const app = new CanopyAppDriver(main);
    await app.waitForShell();
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const first = advisor.getByTestId('app-advisor-nav-entry-advisor-first');
    await first.focus();
    await first.press('Space');
    await first.press('ArrowDown');
    await first.press('Space');
    await expect
      .poll(async () =>
        (
          await advisor.evaluate(() =>
            window.api.workEntries.list({ projectId: 'app-advisor' }),
          )
        ).entries.map((e) => e.id),
      )
      .toEqual(['advisor-second', 'advisor-first']);
    const created = await advisor.evaluate(() =>
      window.api.sidebarItemGroups.create({
        scope: { appAdvisor: true },
        itemId: 'advisor-first',
        name: 'Creation group',
      }),
    );
    const group = advisor.locator(
      `[data-sidebar-item-group-id="${created.id}"]`,
    );
    await group.getByTestId('sidebar-item-group-header').hover();
    await group.getByTestId('sidebar-item-group-create').click();
    await expect
      .poll(
        async () =>
          await group
            .locator('[data-standalone-chat-id][aria-current="page"]')
            .getAttribute('data-standalone-chat-id'),
      )
      .not.toBeNull();
    const selectedId = await group
      .locator('[data-standalone-chat-id][aria-current="page"]')
      .getAttribute('data-standalone-chat-id');
    const groups = await advisor.evaluate(() =>
      window.api.sidebarItemGroups.list({ appAdvisor: true }),
    );
    expect(groups[0].memberIds).toContain(selectedId);
    await expect(
      group.getByTestId(`app-advisor-nav-entry-${selectedId}`),
    ).toBeVisible();
    await advisor.reload();
    await expect(group).toContainText('Creation group');
    expect(
      (
        await advisor.evaluate(() =>
          window.api.sidebarItemGroups.list({ appAdvisor: true }),
        )
      )[0].memberIds,
    ).toContain(selectedId);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Advisor pointer drops into a collapsed group and its unnamed rail moves the complete group', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-advisor-pointer-'),
  );
  seedAdvisorGroups(userDataDir, { includeThird: true });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const main = await electronApp.firstWindow();
    const app = new CanopyAppDriver(main);
    await app.waitForShell();
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const group = await advisor.evaluate(() =>
      window.api.sidebarItemGroups.create({
        scope: { appAdvisor: true },
        itemId: 'advisor-first',
        name: 'Drop destination',
      }),
    );
    const container = advisor.locator(
      `[data-sidebar-item-group-id="${group.id}"]`,
    );
    await advisor.evaluate(
      (groupId) =>
        window.api.sidebarItemGroups.update({
          scope: { appAdvisor: true },
          groupId,
          collapsed: true,
        }),
      group.id,
    );
    const rail = container.getByTestId('sidebar-item-group-rail');
    await expect(
      container.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
    async function drag(source, target, fraction = 0.5) {
      const a = await source.boundingBox();
      const b = await target.boundingBox();
      if (!a || !b) throw new Error('Advisor drag geometry missing');
      await advisor.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await advisor.mouse.down();
      await advisor.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, {
        steps: 4,
      });
      await expect(
        advisor.getByTestId('sidebar-item-group-drag-overlay'),
      ).toBeVisible();
      await advisor.mouse.move(b.x + b.width / 2, b.y + b.height * fraction, {
        steps: 12,
      });
      await advisor.mouse.up();
      await expect(
        advisor.getByTestId('sidebar-item-group-drag-overlay'),
      ).toHaveCount(0);
      await advisor.waitForTimeout(60);
    }
    // The title joins at the end; the retained selected row below it would
    // place the drop beside itself instead.
    await drag(
      advisor.getByTestId('app-advisor-nav-entry-advisor-second').locator('p'),
      container.getByTestId('sidebar-item-group-toggle'),
    );
    await expect
      .poll(
        async () =>
          (
            await advisor.evaluate(() =>
              window.api.sidebarItemGroups.list({ appAdvisor: true }),
            )
          )[0].memberIds,
      )
      .toEqual(['advisor-first', 'advisor-second']);
    await advisor.evaluate(
      (groupId) =>
        window.api.sidebarItemGroups.update({
          scope: { appAdvisor: true },
          groupId,
          name: '',
          collapsed: false,
        }),
      group.id,
    );
    await expect(rail).toBeVisible();
    await drag(
      rail,
      advisor.getByTestId('app-advisor-nav-entry-advisor-third'),
      0.8,
    );
    await expect
      .poll(async () =>
        (
          await advisor.evaluate(() =>
            window.api.workEntries.list({ projectId: 'app-advisor' }),
          )
        ).entries.map((e) => e.id),
      )
      .toEqual(['advisor-third', 'advisor-first', 'advisor-second']);
    await advisor.reload();
    await expect(
      container.getByTestId('app-advisor-nav-entry-advisor-second'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Advisor archive removes durable membership and restore returns the chat ungrouped', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-advisor-archive-'),
  );
  seedAdvisorGroups(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const main = await electronApp.firstWindow();
    const app = new CanopyAppDriver(main);
    await app.waitForShell();
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const group = await advisor.evaluate(async () => {
      const group = await window.api.sidebarItemGroups.create({
        scope: { appAdvisor: true },
        itemId: 'advisor-first',
        name: 'Retained group',
      });
      await window.api.sidebarItemGroups.moveItem({
        scope: { appAdvisor: true },
        itemId: 'advisor-second',
        groupId: group.id,
      });
      return group;
    });
    const first = advisor.getByTestId('app-advisor-nav-entry-advisor-first');
    await expect(
      advisor
        .locator(`[data-sidebar-item-group-id="${group.id}"]`)
        .getByTestId('app-advisor-nav-entry-advisor-first'),
    ).toBeVisible();
    await first.click();
    await first.hover();
    await first.getByTestId('app-advisor-nav-entry-advisor-first-menu').click();
    await advisor
      .getByRole('menuitem', { name: 'Archive', exact: true })
      .click();
    await advisor
      .getByTestId('app-advisor-nav-entry-advisor-first-confirm-delete')
      .click();
    await expect(first).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await advisor.evaluate(() =>
              window.api.sidebarItemGroups.list({ appAdvisor: true }),
            )
          )[0].memberIds,
      )
      .toEqual(['advisor-second']);
    const restored = await advisor.evaluate(() =>
      window.api.archivedContainers.restore({
        projectId: 'app-advisor',
        containerId: 'advisor-first',
      }),
    );
    expect(restored.kind).toBe('work-entry');
    await expect(
      advisor.getByTestId(`app-advisor-nav-entry-${restored.restoredEntryId}`),
    ).toBeVisible();
    const current = await advisor.evaluate(() =>
      window.api.sidebarItemGroups.list({ appAdvisor: true }),
    );
    expect(current).toEqual([
      expect.objectContaining({ id: group.id, memberIds: ['advisor-second'] }),
    ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const action of ['archive anchor', 'create first member']) {
  test(`Advisor empty group retains its position after ${action}`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'advisor-empty-slot-'),
    );
    seedAdvisorGroups(userDataDir, { includeThird: true, withMessages: true });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const main = await electronApp.firstWindow();
      const app = new CanopyAppDriver(main);
      await app.waitForShell();
      const advisor = await app.openAppAdvisorWindow(electronApp);
      const group = await advisor.evaluate(async () => {
        const scope = { appAdvisor: true };
        const group = await window.api.sidebarItemGroups.create({
          scope,
          itemId: 'advisor-first',
          name: 'Kept position',
        });
        await window.api.sidebarItemGroups.update({
          scope,
          groupId: group.id,
          keepWhenEmpty: true,
        });
        await window.api.sidebarItemGroups.moveItem({
          scope,
          itemId: 'advisor-first',
          groupId: null,
        });
        return group;
      });
      const block = advisor.locator(
        `[data-sidebar-item-group-id="${group.id}"]`,
      );
      // A kept group collapses when its last member leaves.
      await expect(
        block.getByTestId('sidebar-item-group-toggle'),
      ).toHaveAttribute('aria-expanded', 'false');
      await expect(block.getByTestId('sidebar-item-group-empty')).toHaveCount(
        0,
      );
      const first = advisor.getByTestId('app-advisor-nav-entry-advisor-first');
      if (action === 'archive anchor') {
        const anchor = advisor.getByTestId(
          'app-advisor-nav-entry-advisor-second',
        );
        await anchor.hover();
        await anchor
          .getByTestId('app-advisor-nav-entry-advisor-second-menu')
          .click();
        await advisor
          .getByRole('menuitem', { name: 'Archive', exact: true })
          .click();
        await advisor
          .getByTestId('app-advisor-nav-entry-advisor-second-confirm-delete')
          .click();
        await expect(anchor).toHaveCount(0);
        await expect
          .poll(
            async () =>
              (
                await advisor.evaluate(() =>
                  window.api.sidebarItemGroups.list({ appAdvisor: true }),
                )
              )[0]?.emptyAnchorId,
          )
          .toBe('advisor-third');
      } else {
        await block.getByTestId('sidebar-item-group-header').hover();
        await block.getByTestId('sidebar-item-group-create').click();
        // The created chat joins the group, which opens again.
        await expect
          .poll(
            async () =>
              (
                await advisor.evaluate(() =>
                  window.api.sidebarItemGroups.list({ appAdvisor: true }),
                )
              ).find((item) => item.id === group.id)?.memberIds.length,
          )
          .toBe(1);
        await expect(
          block.getByTestId('sidebar-item-group-toggle'),
        ).toHaveAttribute('aria-expanded', 'true');
        await expect(block.getByTestId('sidebar-item-group-empty')).toHaveCount(
          0,
        );
      }
      await expect
        .poll(async () => {
          const a = await first.boundingBox();
          const b = await block.boundingBox();
          return Boolean(a && b && a.y + a.height <= b.y);
        })
        .toBe(true);
      const following = advisor.getByTestId(
        `app-advisor-nav-entry-${action === 'archive anchor' ? 'advisor-third' : 'advisor-second'}`,
      );
      await expect
        .poll(async () => {
          const a = await block.boundingBox();
          const b = await following.boundingBox();
          return Boolean(a && b && a.y + a.height <= b.y);
        })
        .toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
