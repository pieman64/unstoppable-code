/** Cowork group menus, persisted membership and selected collapsed rows. */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import {
  ENTRY_ID,
  WORKSPACE_ID,
  seedDeliveryCoworkWorkspace,
  expandCoworkWorkspace,
  openWorkEntryMenu,
} from './coworkWorkEntryDoneFixture.mjs';

function defaultSidebarGroupName(otherGroups = []) {
  const usedNames = new Set(
    otherGroups.map((candidate) => candidate.name.toLocaleLowerCase()),
  );
  for (let index = 1; ; index += 1) {
    const candidate = `Group ${index}`;
    if (!usedNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

test('creates a Cowork group through its row menu and keeps its selected chat when collapsed', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-groups-'),
  );
  seedDeliveryCoworkWorkspace(userDataDir);
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await expandCoworkWorkspace(window, WORKSPACE_ID);
    const row = window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`);
    await row.click();
    await app.expectChatPage();
    await openWorkEntryMenu(window, ENTRY_ID);
    await window
      .getByRole('menuitem', { name: 'Add to new group', exact: true })
      .click({ timeout: 5000 });
    const name = window.getByTestId('sidebar-item-group-name');
    await expect(name).toBeVisible();
    await name.fill('Support work');
    await name.press('Enter');
    await window.keyboard.press('Escape');
    const groups = await window.evaluate(
      (workspaceLocalId) =>
        window.api.sidebarItemGroups.list({ workspaceLocalId }),
      WORKSPACE_ID,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual([ENTRY_ID]);
    const group = window.locator(
      `[data-sidebar-item-group-id="${groups[0].id}"]`,
    );
    await expect(group).toContainText('Support work');
    await group.getByTestId('sidebar-item-group-toggle').click();
    await expect(row).toBeVisible();
    await expect(
      group.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
    await group.getByTestId('sidebar-item-group-header').hover();
    await group.getByTestId('sidebar-item-group-create').click();
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(
              (workspaceLocalId) =>
                window.api.sidebarItemGroups.list({ workspaceLocalId }),
              WORKSPACE_ID,
            )
          )[0].memberIds.length,
      )
      .toBe(2);
    const createdGroup = (
      await window.evaluate(
        (workspaceLocalId) =>
          window.api.sidebarItemGroups.list({ workspaceLocalId }),
        WORKSPACE_ID,
      )
    )[0];
    const createdId = createdGroup.memberIds.find((id) => id !== ENTRY_ID);
    await expect(
      group.getByTestId(`sidebar-work-entry-${createdId}`),
    ).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(
      group.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
    await window
      .getByTestId(`sidebar-cowork-project-${WORKSPACE_ID}-toggle`)
      .click();
    await expect(
      window
        .getByTestId(
          `sidebar-cowork-project-${WORKSPACE_ID}-collapsed-selected`,
        )
        .getByTestId(`sidebar-work-entry-${createdId}`),
    ).toBeVisible();
    const projection = window.getByTestId(
      `sidebar-cowork-project-${WORKSPACE_ID}-collapsed-selected`,
    );
    await expect(
      projection.locator('[aria-roledescription="sortable"]'),
    ).toHaveCount(0);
    await expect(
      projection.locator('[data-sidebar-group-drag-source]'),
    ).toHaveCount(0);
    await expect(
      projection.getByTestId('sidebar-item-group-drop-zone'),
    ).toHaveCount(0);
    await window.reload();
    await app.waitForShell();
    const restoredGroups = await window.evaluate(
      (workspaceLocalId) =>
        window.api.sidebarItemGroups.list({ workspaceLocalId }),
      WORKSPACE_ID,
    );
    expect(restoredGroups[0]).toMatchObject({
      id: createdGroup.id,
      name: 'Support work',
      collapsed: true,
      memberIds: createdGroup.memberIds,
    });
    await expandCoworkWorkspace(window, WORKSPACE_ID);
    await expect(
      window.locator(`[data-sidebar-item-group-id="${groups[0].id}"]`),
    ).toContainText('Support work');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The cap counts complete blocks, not a slice of their member rows.
test('Chats retains an expanded block across the cap and never creates selected sticky copies', async () => {
  const { seedChatsSectionFixture, CHATS_SECTION_DEFAULT_COWORK_ID } =
    await import('./seeders/index.mjs');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-groups-cap-'),
  );
  seedChatsSectionFixture(userDataDir, {
    chatEntryCount: 10,
    worktreeCount: 2,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const scope = { workspaceLocalId: CHATS_SECTION_DEFAULT_COWORK_ID };
    const group = await window.evaluate(async (scope) => {
      const { entries } = await window.api.workEntries.list({
        projectId: scope.workspaceLocalId,
      });
      const group = await window.api.sidebarItemGroups.create({
        scope,
        itemId: entries[3].id,
        name: 'Follow-ups',
      });
      for (const entry of entries.slice(4, 9))
        await window.api.sidebarItemGroups.moveItem({
          scope,
          groupId: group.id,
          itemId: entry.id,
        });
      return group;
    }, scope);
    await window.reload();
    await app.waitForShell();
    const chats = window.getByTestId('sidebar-section-chats-content');
    await expect(chats.locator('[data-standalone-chat-id]')).toHaveCount(9);
    const block = chats.locator(`[data-sidebar-item-group-id="${group.id}"]`);
    await expect(block.locator('[data-standalone-chat-id]')).toHaveCount(6);
    await block.getByTestId('sidebar-item-group-toggle').click();
    await expect(chats.locator('[data-standalone-chat-id]')).toHaveCount(4);
    await block.getByTestId('sidebar-item-group-toggle').click();
    const selected = block.locator('[data-standalone-chat-id]').first();
    const id = await selected.getAttribute('data-standalone-chat-id');
    await selected.click();
    await block.getByTestId('sidebar-item-group-toggle').click();
    await expect(block.locator('[data-standalone-chat-id]')).toHaveCount(1);
    await expect(
      window.getByTestId(`sidebar-work-entry-${id}-pin-top`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`sidebar-work-entry-${id}-pin-bottom`),
    ).toHaveCount(0);
    await expect(chats.locator('[data-sidebar-selected-item]')).toHaveAttribute(
      'data-sidebar-selected-pin-disabled',
      '',
    );
    await expect(
      block.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

async function seedManyCowork(userDataDir, count = 24, mode = 'manual') {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const dir = seedDeliveryCoworkWorkspace(userDataDir);
  const chat = JSON.parse(
    readFileSync(path.join(dir, 'chats', `${ENTRY_ID}.json`), 'utf8'),
  );
  const ids = Array.from(
    { length: count },
    (_, index) => `entry-task-${index}`,
  );
  writeFileSync(
    path.join(dir, 'work-entries.json'),
    JSON.stringify({
      version: 1,
      entries: ids.map((id, index) => ({
        id,
        title: `Task ${index}`,
        createdAt: '2026-07-01T12:00:00.000Z',
      })),
    }),
  );
  for (const [index, id] of ids.entries())
    writeFileSync(
      path.join(dir, 'chats', `${id}.json`),
      JSON.stringify({
        ...chat,
        tabs: [{ ...chat.tabs[0], id: `chat-${id}`, title: `Task ${index}` }],
        activeTabId: `chat-${id}`,
      }),
    );
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces[0].itemSortMode = mode;
  writeFileSync(indexPath, JSON.stringify(index));
  const configPath = path.join(dir, 'workspace.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      ...JSON.parse(readFileSync(configPath, 'utf8')),
      itemSortMode: mode,
    }),
  );
  return ids;
}

for (const mode of ['manual', 'last-updated']) {
  test(`Cowork keyboard membership commits in ${mode} while Escape keeps the existing order`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cowork-keyboard-'),
    );
    const ids = await seedManyCowork(userDataDir, 4, mode);
    const { electronApp } = await launchCanopyWithLabsPagesOffered({
      userDataDir,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await expandCoworkWorkspace(window, WORKSPACE_ID);
      const scope = { workspaceLocalId: WORKSPACE_ID };
      const group = await window.evaluate(
        ({ scope, itemId }) =>
          window.api.sidebarItemGroups.create({
            scope,
            itemId,
            name: 'Support',
          }),
        { scope, itemId: ids[0] },
      );
      await window.reload();
      await app.waitForShell();
      const orderBefore = await window.evaluate(
        async (projectId) =>
          (await window.api.workEntries.list({ projectId })).entries.map(
            (entry) => entry.id,
          ),
        WORKSPACE_ID,
      );
      const row = window.getByTestId(`sidebar-work-entry-${ids[1]}`);
      await row.press('Space');
      await row.press('ArrowUp');
      await row.press('Escape');
      expect(
        (
          await window.evaluate(
            (scope) => window.api.sidebarItemGroups.list(scope),
            scope,
          )
        )[0].memberIds,
      ).toEqual([ids[0]]);
      expect(
        await window.evaluate(
          async (projectId) =>
            (await window.api.workEntries.list({ projectId })).entries.map(
              (entry) => entry.id,
            ),
          WORKSPACE_ID,
        ),
      ).toEqual(orderBefore);
      await row.press('Space');
      await row.press('ArrowUp');
      await row.press('Space');
      await expect
        .poll(
          async () =>
            (
              await window.evaluate(
                (scope) => window.api.sidebarItemGroups.list(scope),
                scope,
              )
            )[0].memberIds,
        )
        .toContain(ids[1]);
      await expect(
        window
          .locator(`[data-sidebar-item-group-id="${group.id}"]`)
          .getByTestId(`sidebar-work-entry-${ids[1]}`),
      ).toBeVisible();
      if (mode === 'last-updated')
        expect(
          await window.evaluate(
            async (projectId) =>
              (await window.api.workEntries.list({ projectId })).entries.map(
                (entry) => entry.id,
              ),
            WORKSPACE_ID,
          ),
        ).toEqual(orderBefore);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Cowork selected group header and rail follow the selected row into sticky copies', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-sticky-'),
  );
  const ids = await seedManyCowork(userDataDir);
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
    viewportSize: { width: 1000, height: 550 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await expandCoworkWorkspace(window, WORKSPACE_ID);
    const scope = { workspaceLocalId: WORKSPACE_ID };
    await window.evaluate(
      async ({ scope, ids }) => {
        const group = await window.api.sidebarItemGroups.create({
          scope,
          itemId: ids[10],
          name: 'Support work',
        });
        await window.api.sidebarItemGroups.moveItem({
          scope,
          itemId: ids[11],
          groupId: group.id,
        });
      },
      { scope, ids },
    );
    await window.reload();
    await app.waitForShell();
    const viewport = window.getByTestId('sidebar-scroll-container');
    const row = viewport.getByTestId(`sidebar-work-entry-${ids[11]}`);
    await row.click();
    await app.expectChatPage();
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    const bottom = window.getByTestId('sidebar-selected-pin-bottom');
    await expect(
      bottom.getByTestId('sidebar-item-group-header-pin-bottom'),
    ).toBeAttached();
    await expect(
      bottom.getByTestId(`sidebar-work-entry-${ids[11]}-pin-bottom`),
    ).toBeAttached();
    const offset = await row.evaluate((element) => {
      const viewport = element.closest(
        '[data-testid="sidebar-scroll-container"]',
      );
      return (
        viewport.scrollTop +
        element.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        25
      );
    });
    await viewport.evaluate((element, offset) => {
      element.scrollTop = offset;
      element.dispatchEvent(new Event('scroll'));
    }, offset);
    const top = window.getByTestId('sidebar-selected-pin-top');
    await expect(top).toBeVisible();
    await expect(
      top.getByTestId('sidebar-item-group-header-pin-top'),
    ).toBeVisible();
    await expect(top.locator('[data-sidebar-group-drag-source]')).toHaveCount(
      0,
    );
    await expect(
      top.getByTestId(`sidebar-work-entry-${ids[11]}-pin-top`),
    ).not.toHaveAttribute('aria-roledescription', 'sortable');
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(top).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Cowork pointer drops join a collapsed group and pinning removes membership', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-pointer-'),
  );
  const ids = await seedManyCowork(userDataDir, 4);
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await expandCoworkWorkspace(window, WORKSPACE_ID);
    const scope = { workspaceLocalId: WORKSPACE_ID };
    const group = await window.evaluate(
      async ({ scope, itemId }) => {
        const group = await window.api.sidebarItemGroups.create({
          scope,
          itemId,
          name: 'Support',
        });
        await window.api.sidebarItemGroups.update({
          scope,
          groupId: group.id,
          collapsed: true,
        });
        return group;
      },
      { scope, itemId: ids[0] },
    );
    await window.reload();
    await app.waitForShell();
    const source = window
      .getByTestId(`sidebar-work-entry-${ids[2]}`)
      .locator('p');
    const target = window
      .locator(`[data-sidebar-item-group-id="${group.id}"]`)
      .getByTestId('sidebar-item-group-toggle');
    const a = await source.boundingBox();
    const b = await target.boundingBox();
    if (!a || !b) throw new Error('Missing Cowork drag geometry');
    await window.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await window.mouse.down();
    await window.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, {
      steps: 4,
    });
    await expect(
      window.getByTestId('sidebar-item-group-drag-overlay'),
    ).toBeVisible();
    await expect(
      window
        .getByTestId('sidebar-item-group-drag-overlay')
        .getByText('Task 2', { exact: true }),
    ).toHaveClass(/ph-mask/);
    await window.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {
      steps: 12,
    });
    await window.mouse.up();
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(
              (scope) => window.api.sidebarItemGroups.list(scope),
              scope,
            )
          )[0].memberIds,
      )
      .toContain(ids[2]);
    // PointerSensor suppresses post-drag clicks for 50ms. Wait for its teardown.
    await window.waitForTimeout(100);
    await target.click();
    await expect(target).toHaveAttribute('aria-expanded', 'true');
    await openWorkEntryMenu(window, ids[2]);
    await window.getByTestId(`sidebar-work-entry-${ids[2]}-toggle-pin`).click();
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(
              (scope) => window.api.sidebarItemGroups.list(scope),
              scope,
            )
          )[0].memberIds,
      )
      .not.toContain(ids[2]);
    await expect(
      window
        .locator(`[data-sidebar-item-group-id="${group.id}"]`)
        .getByTestId(`sidebar-work-entry-${ids[2]}`),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const surface of ['Cowork', 'Chats']) {
  test(`${surface} hidden-label rail remains inside the sidebar and opens group options`, async () => {
    const {
      seedChatsSectionFixture,
      CHATS_SECTION_NAMED_COWORK_ID,
      CHATS_SECTION_DEFAULT_COWORK_ID,
    } = await import('./seeders/index.mjs');
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cowork-rail-'),
    );
    const seed = seedChatsSectionFixture(userDataDir, {
      chatEntryCount: 5,
      worktreeCount: 2,
    });
    const scope = {
      workspaceLocalId:
        surface === 'Cowork'
          ? CHATS_SECTION_NAMED_COWORK_ID
          : CHATS_SECTION_DEFAULT_COWORK_ID,
    };
    const { electronApp } = await launchCanopyWithLabsPagesOffered({
      userDataDir,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const createdGroup = await window.evaluate(
        ({ scope, itemId }) =>
          window.api.sidebarItemGroups.create({ scope, itemId, name: '' }),
        {
          scope,
          itemId:
            surface === 'Cowork' ? 'entry-research-plan' : seed.chatEntryIds[0],
        },
      );
      const expectedDefaultName = defaultSidebarGroupName();
      expect(createdGroup.name).toBe(expectedDefaultName);
      expect(createdGroup.labelHidden).toBe(true);
      await window.reload();
      await app.waitForShell();
      if (surface === 'Cowork')
        await expandCoworkWorkspace(window, scope.workspaceLocalId);
      const rail = window
        .getByTestId(`sidebar-cowork-project-${scope.workspaceLocalId}`)
        .getByTestId('sidebar-item-group-rail');
      await rail.scrollIntoViewIfNeeded();
      const geometry = await rail.evaluate((element) => {
        const line = element.firstElementChild;
        const viewport = element.closest(
          '[data-testid="sidebar-scroll-container"]',
        );
        if (!line || !viewport) throw new Error('Missing group rail');
        const bounds = element.getBoundingClientRect();
        const clip = viewport.getBoundingClientRect();
        const target = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return {
          left: bounds.left,
          clipLeft: clip.left,
          width: bounds.width,
          lineHeight: line.getBoundingClientRect().height,
          hit: target === element || element.contains(target),
          interceptedBy: target?.outerHTML.slice(0, 300),
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(geometry.clipLeft);
      expect(geometry.lineHeight).toBeGreaterThan(20);
      expect(geometry).toMatchObject({ hit: true });
      await rail.click({ button: 'right' });
      await expect(window.getByTestId('sidebar-item-group-menu')).toContainText(
        createdGroup.name,
      );
      await window.getByTestId('sidebar-item-group-edit').click();
      const name = window.getByTestId('sidebar-item-group-name');
      const showName = window.getByTestId('sidebar-item-group-show-name');
      await expect(name).toBeFocused();
      await expect(name).toHaveValue('');
      await expect(name).toHaveAttribute('placeholder', expectedDefaultName);
      await expect(showName).toHaveAttribute('aria-checked', 'false');
      await expect(showName).toBeDisabled();
      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('New task in group reuses and moves an empty task without accumulating blank rows', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-group-reuse-'),
  );
  seedDeliveryCoworkWorkspace(userDataDir);
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await expandCoworkWorkspace(window, WORKSPACE_ID);
    const seed = await window.evaluate(
      async ({ workspaceLocalId, itemId }) => {
        const scope = { workspaceLocalId };
        const result = await window.api.workEntries.create({
          projectId: workspaceLocalId,
        });
        const original = await window.api.sidebarItemGroups.create({
          scope,
          itemId: result.entry.id,
          name: 'Original group',
        });
        const group = await window.api.sidebarItemGroups.create({
          scope,
          itemId,
          name: 'Reuse destination',
        });
        const { entries } = await window.api.workEntries.list({
          projectId: workspaceLocalId,
        });
        return {
          group,
          originalId: original.id,
          emptyId: result.entry.id,
          count: entries.length,
        };
      },
      { workspaceLocalId: WORKSPACE_ID, itemId: ENTRY_ID },
    );
    await window.reload();
    await app.waitForShell();
    await expandCoworkWorkspace(window, WORKSPACE_ID);
    const group = window.locator(
      `[data-sidebar-item-group-id="${seed.group.id}"]`,
    );
    for (let click = 0; click < 2; click++) {
      await group.getByTestId('sidebar-item-group-header').hover();
      await group.getByTestId('sidebar-item-group-create').click();
      await expect
        .poll(async () =>
          (
            await window.evaluate(
              (workspaceLocalId) =>
                window.api.sidebarItemGroups.list({ workspaceLocalId }),
              WORKSPACE_ID,
            )
          )
            .find((group) => group.id === seed.group.id)
            ?.memberIds.includes(seed.emptyId),
        )
        .toBe(true);
      const { entries } = await window.evaluate(
        (projectId) => window.api.workEntries.list({ projectId }),
        WORKSPACE_ID,
      );
      expect(entries).toHaveLength(seed.count);
      await expect(
        group.getByTestId(`sidebar-work-entry-${seed.emptyId}`),
      ).toBeVisible();
      await expect(
        window.locator(`[data-sidebar-item-group-id="${seed.originalId}"]`),
      ).toHaveCount(0);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
