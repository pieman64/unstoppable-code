import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAlignedWorktreeMenuIcons } from './helpers/worktreeMenuIcons.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  seedChatsSectionFixture,
  CHATS_SECTION_CODE_WORKSPACE_ID,
} from './seeders/seedChatsSectionFixture.mjs';

test('Code row groups expose group access, editor and retained collapsed selection', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-code-groups-'),
  );
  const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 18,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const rows = window
      .getByTestId('sidebar-shared-rail')
      .getByTestId('worktree-row');
    await rows.first().click({ button: 'right' });
    const addGroup = window.getByRole('menuitem', {
      name: 'Add to new group',
      exact: true,
    });
    await expect(addGroup.locator('svg')).toHaveCount(1);
    await expectAlignedWorktreeMenuIcons(
      window.getByRole('menu').filter({ has: addGroup }),
    );
    await addGroup.click();
    const editor = window.getByRole('dialog', {
      name: 'Edit group',
      exact: true,
    });
    await expect(editor).toBeVisible();
    await editor
      .getByRole('textbox', { name: 'Group name' })
      .fill('Release polish');
    await editor.getByRole('textbox', { name: 'Group name' }).press('Enter');
    await editor.getByRole('button', { name: 'Close group editor' }).click();
    const group = window.getByTestId('sidebar-item-group-header');
    await expect(group).toContainText('Release polish');
    await rows.first().click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Group', exact: true }).hover();
    await expectAlignedWorktreeMenuIcons(
      window.getByTestId('sidebar-group-organize-menu'),
    );
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');
    await rows.first().click();
    await window.getByTestId('sidebar-item-group-toggle').click();
    await expect(
      window.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(window.locator('[data-sidebar-selected-item]')).toHaveCount(1);
    await window.reload();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await expect(window.getByTestId('sidebar-item-group-header')).toContainText(
      'Release polish',
    );
    const file = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          CHATS_SECTION_CODE_WORKSPACE_ID,
          'sidebar-item-groups.json',
        ),
        'utf8',
      ),
    );
    expect(file.groups[0].memberIds).toEqual([worktreeIds[0]]);
    expect(file.groups[0].collapsed).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code hidden-label groups keep their default name in menus and collapse to a count', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-hidden-label-'),
  );
  const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 3,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const row = (id) =>
      window.locator(
        `[data-sidebar-group-drag-source="item:${id}"] [data-testid="worktree-row"]`,
      );
    const firstRow = row(worktreeIds[0]);
    const secondRow = row(worktreeIds[1]);
    const thirdRow = row(worktreeIds[2]);
    await firstRow.click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to new group', exact: true })
      .click();

    const editor = window.getByTestId('sidebar-item-group-editor');
    await expect(editor).toBeVisible();
    const [initialGroup] = await groups(window);
    const expectedDefaultName = defaultGroupName([]);
    expect(initialGroup.name).toBe(expectedDefaultName);
    expect(initialGroup.labelHidden).toBe(true);
    const nameInput = editor.getByTestId('sidebar-item-group-name');
    const showName = editor.getByTestId('sidebar-item-group-show-name');
    await expect(nameInput).toHaveValue('');
    await expect(nameInput).toHaveAttribute('placeholder', expectedDefaultName);
    await expect(showName).toHaveAttribute('aria-checked', 'false');
    await expect(showName).toBeDisabled();
    await editor.getByTestId('sidebar-item-group-editor-close').click();

    const groupRoot = window.locator(
      `[data-sidebar-item-group-id="${initialGroup.id}"]`,
    );
    await expect(groupRoot).toBeVisible();
    await expect(
      groupRoot.getByTestId('sidebar-item-group-header'),
    ).toHaveCount(0);
    await expect(
      groupRoot.locator(
        `[data-sidebar-group-drag-source="item:${worktreeIds[0]}"]`,
      ),
    ).toBeVisible();

    await secondRow.click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to group', exact: true })
      .hover();
    const defaultDestination = window.getByRole('menuitem', {
      name: expectedDefaultName,
      exact: true,
    });
    await expect(defaultDestination).toBeVisible();
    await defaultDestination.click();
    await expect(
      groupRoot.locator(
        `[data-sidebar-group-drag-source="item:${worktreeIds[1]}"]`,
      ),
    ).toBeVisible();

    await firstRow.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Group', exact: true }).hover();
    await expect(
      window.getByText(expectedDefaultName, { exact: true }),
    ).toBeVisible();
    await window.keyboard.press('Escape');

    const rail = groupRoot.getByTestId('sidebar-item-group-rail');
    await rail.click({ button: 'right' });
    const groupMenu = window.getByTestId('sidebar-item-group-menu');
    await expect(groupMenu).toContainText(
      `${expectedDefaultName} · 2 worktrees`,
    );
    await window.getByTestId('sidebar-item-group-edit').click();
    const hiddenEditor = window.getByTestId('sidebar-item-group-editor');
    const hiddenNameInput = hiddenEditor.getByTestId('sidebar-item-group-name');
    const hiddenShowName = hiddenEditor.getByTestId(
      'sidebar-item-group-show-name',
    );
    await expect(hiddenNameInput).toHaveValue('');
    await expect(hiddenNameInput).toHaveAttribute(
      'placeholder',
      expectedDefaultName,
    );
    await expect(hiddenShowName).toHaveAttribute('aria-checked', 'false');
    await expect(hiddenShowName).toBeDisabled();
    await hiddenNameInput.fill('Release polish');
    await expect(hiddenShowName).toBeEnabled();
    await expect(hiddenShowName).toHaveAttribute('aria-checked', 'true');
    await hiddenEditor.getByTestId('sidebar-item-group-editor-close').click();
    await expect(
      groupRoot.getByTestId('sidebar-item-group-header'),
    ).toContainText('Release polish');

    await groupRoot.getByTestId('sidebar-item-group-header').hover();
    await groupRoot.getByTestId('sidebar-item-group-menu-trigger').click();
    await window.getByTestId('sidebar-item-group-edit').click();
    const namedEditor = window.getByTestId('sidebar-item-group-editor');
    const namedShowName = namedEditor.getByTestId(
      'sidebar-item-group-show-name',
    );
    await expect(
      namedEditor.getByTestId('sidebar-item-group-name'),
    ).toHaveValue('Release polish');
    await namedShowName.click();
    await expect(namedShowName).toHaveAttribute('aria-checked', 'false');
    await namedEditor.getByTestId('sidebar-item-group-editor-close').click();
    await expect(
      groupRoot.getByTestId('sidebar-item-group-header'),
    ).toHaveCount(0);
    await expect(groupRoot).toHaveAttribute(
      'aria-label',
      'Release polish group',
    );

    await thirdRow.click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to group', exact: true })
      .hover();
    await expect(
      window.getByRole('menuitem', { name: 'Release polish', exact: true }),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await firstRow.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Group', exact: true }).hover();
    await expect(
      window.getByText('Release polish', { exact: true }),
    ).toBeVisible();
    await window.keyboard.press('Escape');

    await rail.click({ button: 'right' });
    await expect(groupMenu).toContainText('Release polish · 2 worktrees');
    await groupMenu.getByRole('menuitem', { name: 'Collapse group' }).click();
    const collapsedHeader = groupRoot.getByTestId('sidebar-item-group-header');
    await expect(collapsedHeader).toBeVisible();
    await expect(collapsedHeader).toContainText('2 worktrees');
    // The hidden name stays available to assistive tech only.
    await expect(
      collapsedHeader.getByText('Release polish', { exact: false }),
    ).toHaveClass(/sr-only/);
    await expect(
      groupRoot.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code row menus list group destinations in left-nav order', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-order-'),
  );
  const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 3,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    // Created bottom row first, so stored order is the reverse of nav order.
    await seedGroup(window, worktreeIds[2], [], 'Nav later');
    await seedGroup(window, worktreeIds[0], [], 'Nav first');
    const stored = json(
      path.join(
        userDataDir,
        'workspaces',
        CHATS_SECTION_CODE_WORKSPACE_ID,
        'sidebar-item-groups.json',
      ),
    );
    expect(stored.groups.map((group) => group.name)).toEqual([
      'Nav later',
      'Nav first',
    ]);
    await refresh(window);
    const headers = window.getByTestId('sidebar-item-group-header');
    await expect(headers).toHaveText([/Nav first/, /Nav later/]);

    await window
      .locator(
        `[data-sidebar-group-drag-source="item:${worktreeIds[1]}"] [data-testid="worktree-row"]`,
      )
      .click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to group', exact: true })
      .hover();
    const submenu = window.getByTestId('sidebar-group-organize-menu');
    await expect(submenu.getByRole('menuitem')).toHaveText([
      'New group',
      'Nav first',
      'Nav later',
    ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

for (const mode of ['manual', 'last-updated']) {
  test(`Code keyboard membership and Escape preserve ${mode} order`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'sidebar-group-keyboard-'),
    );
    const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
      worktreeCount: 4,
      chatEntryCount: 1,
    });
    const metadata = path.join(
      userDataDir,
      'workspaces',
      CHATS_SECTION_CODE_WORKSPACE_ID,
      'workspace.json',
    );
    const { writeFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync(metadata, 'utf8'));
    writeFileSync(metadata, JSON.stringify({ ...config, itemSortMode: mode }));
    const { electronApp } = await launchCanopyWithLabsPagesOffered({
      userDataDir,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const scope = { workspaceLocalId: CHATS_SECTION_CODE_WORKSPACE_ID };
      const group = await window.evaluate(
        ({ scope, itemId }) =>
          window.api.sidebarItemGroups.create({
            scope,
            itemId,
            name: 'Keyboard destination',
          }),
        { scope, itemId: worktreeIds[0] },
      );
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      const handle = window
        .locator(`[data-sidebar-group-drag-source="item:${worktreeIds[1]}"]`)
        .locator('button[aria-roledescription="sortable"]');
      const registry = path.join(
        userDataDir,
        'workspaces',
        CHATS_SECTION_CODE_WORKSPACE_ID,
        'worktrees.json',
      );
      const before = JSON.parse(readFileSync(registry, 'utf8')).worktrees.map(
        (row) => row.id,
      );
      await handle.press('Space');
      await handle.press('ArrowUp');
      await handle.press('Escape');
      expect(
        JSON.parse(readFileSync(registry, 'utf8')).worktrees.map(
          (row) => row.id,
        ),
      ).toEqual(before);
      await handle.press('Space');
      await handle.press('ArrowUp');
      await handle.press('Space');
      await expect
        .poll(
          async () =>
            (
              await window.evaluate(
                (scope) => window.api.sidebarItemGroups.list(scope),
                scope,
              )
            ).find((item) => item.id === group.id)?.memberIds,
        )
        .toContain(worktreeIds[1]);
      if (mode === 'last-updated')
        expect(
          JSON.parse(readFileSync(registry, 'utf8')).worktrees.map(
            (row) => row.id,
          ),
        ).toEqual(before);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}

const codeScope = { workspaceLocalId: CHATS_SECTION_CODE_WORKSPACE_ID };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
async function seedGroup(
  window,
  itemId,
  memberIds = [],
  name = 'Release polish',
) {
  const group = await window.evaluate(
    ({ itemId, name, scope }) =>
      window.api.sidebarItemGroups.create({ scope, itemId, name }),
    { itemId, name, scope: codeScope },
  );
  for (const id of memberIds)
    await window.evaluate(
      ({ itemId, groupId, scope }) =>
        window.api.sidebarItemGroups.moveItem({ scope, itemId, groupId }),
      { itemId: id, groupId: group.id, scope: codeScope },
    );
  return group;
}
function defaultGroupName(otherGroups) {
  const usedNames = new Set(
    otherGroups.map((candidate) => candidate.name.toLocaleLowerCase()),
  );
  for (let index = 1; ; index += 1) {
    const candidate = `Group ${index}`;
    if (!usedNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
async function refresh(window) {
  await window.reload();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await expect(window.getByTestId('worktree-row').first()).toBeVisible();
}
async function groups(window) {
  return window.evaluate(
    (scope) => window.api.sidebarItemGroups.list(scope),
    codeScope,
  );
}
async function dragTo(window, source, target, fraction = 0.5) {
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b)
    throw new Error('Expected drag source and destination geometry');
  await window.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await window.mouse.down();
  await window.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, {
    steps: 4,
  });
  await expect(
    window.getByTestId('sidebar-item-group-drag-overlay'),
  ).toBeVisible();
  await window.mouse.move(b.x + b.width / 2, b.y + b.height * fraction, {
    steps: 12,
  });
  await window.mouse.up();
  await expect(
    window.getByTestId('sidebar-item-group-drag-overlay'),
  ).toHaveCount(0);
  // dnd-kit keeps capture click/selection listeners for 50ms after pointer release.
  // Let that documented gesture teardown finish before the next control click.
  await window.waitForTimeout(60);
}

test('grouping in Last updated keeps the same Manual slot after registry reconciliation', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-mode-switch-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 4,
    chatEntryCount: 1,
  });
  const metadata = path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_CODE_WORKSPACE_ID,
    'workspace.json',
  );
  const config = json(metadata);
  writeFileSync(
    metadata,
    JSON.stringify({ ...config, itemSortMode: 'last-updated' }),
  );
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    const group = await seedGroup(window, ids[2], [ids[0]], 'Mode switch');
    writeFileSync(
      metadata,
      JSON.stringify({ ...config, itemSortMode: 'manual' }),
    );
    await refresh(window);
    const header = window.locator(`[data-sidebar-item-group-id="${group.id}"]`);
    const neighbor = window.locator(
      `[data-sidebar-group-drag-source="item:${ids[1]}"]`,
    );
    const assertCanonicalSlot = async () => {
      const groupBox = await header.boundingBox();
      const neighborBox = await neighbor.boundingBox();
      expect(groupBox).not.toBeNull();
      expect(neighborBox).not.toBeNull();
      expect(groupBox.y).toBeLessThan(neighborBox.y);
    };
    await assertCanonicalSlot();
    await window.evaluate(
      ({ scope, groupId }) =>
        window.api.sidebarItemGroups.update({
          scope,
          groupId,
          name: 'Mode switch',
        }),
      { scope: codeScope, groupId: group.id },
    );
    await refresh(window);
    await assertCanonicalSlot();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code menu membership keeps a later group below its neighbors through drag, creation and reload', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-order-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 6,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const neighbor = await seedGroup(window, ids[1], [], 'Neighbor');
    const destination = await seedGroup(window, ids[3], [], 'Destination');
    await refresh(window);
    const block = window.locator(
      `[data-sidebar-item-group-id="${destination.id}"]`,
    );
    const row = (id) =>
      window.locator(
        `[data-sidebar-group-drag-source="item:${id}"] [data-testid="worktree-row"]`,
      );
    const registry = path.join(
      userDataDir,
      'workspaces',
      CHATS_SECTION_CODE_WORKSPACE_ID,
      'worktrees.json',
    );
    const assertPosition = async () => {
      await expect
        .poll(() =>
          json(registry)
            .worktrees.map((row) => row.id)
            .filter((id) => [ids[1], ids[2], ids[3], ids[5]].includes(id)),
        )
        .toEqual([ids[1], ids[2], ids[3], ids[5]]);
      const top = await window
        .locator(`[data-sidebar-item-group-id="${neighbor.id}"]`)
        .boundingBox();
      const middle = await row(ids[2]).boundingBox();
      const bottom = await block.boundingBox();
      expect(top).not.toBeNull();
      expect(middle).not.toBeNull();
      expect(bottom).not.toBeNull();
      expect(top.y).toBeLessThan(middle.y);
      expect(middle.y).toBeLessThan(bottom.y);
    };
    await row(ids[0]).click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to group', exact: true })
      .hover();
    // Membership reaches the sidebar before main's session snapshot brings the
    // new row order. Log every committed order from here on: the group keeps
    // its slot and never jumps up to an incoming row, and each joining row
    // takes its registry slot at once instead of hopping there: after the
    // group's member for the menu move, before it for the drop on its top.
    await window.evaluate(
      ({ groupId, middleId, movedId, memberId, droppedId }) => {
        const log = {
          committed: 0,
          groupAboveMiddle: false,
          movedAboveMember: false,
          droppedBelowMember: false,
        };
        const source = (id) =>
          document.querySelector(
            `[data-sidebar-group-drag-source="item:${id}"]`,
          );
        const precedes = (first, second) =>
          Boolean(
            first.compareDocumentPosition(second) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          );
        new MutationObserver(() => {
          const group = document.querySelector(
            `[data-sidebar-item-group-id="${groupId}"]`,
          );
          const middle = source(middleId);
          const moved = source(movedId);
          const member = source(memberId);
          if (!group || !middle || !moved || !member) return;
          log.committed += 1;
          if (precedes(group, middle)) log.groupAboveMiddle = true;
          if (group.contains(moved) && precedes(moved, member))
            log.movedAboveMember = true;
          const dropped = source(droppedId);
          if (dropped && group.contains(dropped) && precedes(member, dropped))
            log.droppedBelowMember = true;
        }).observe(document.body, { childList: true, subtree: true });
        window.__sidebarGroupMoveLog = log;
      },
      {
        groupId: destination.id,
        middleId: ids[2],
        movedId: ids[0],
        memberId: ids[3],
        droppedId: ids[4],
      },
    );
    await window
      .getByRole('menuitem', { name: 'Destination', exact: true })
      .click();
    await expect(
      block.locator(`[data-sidebar-group-drag-source="item:${ids[0]}"]`),
    ).toBeVisible();
    await assertPosition();
    await dragTo(
      window,
      window.locator(
        `[data-sidebar-group-drag-source="item:${ids[4]}"] button[aria-roledescription="sortable"]`,
      ),
      row(ids[3]),
      0.2,
    );
    await expect(
      block.locator(`[data-sidebar-group-drag-source="item:${ids[4]}"]`),
    ).toBeVisible();
    await assertPosition();
    await block.getByTestId('sidebar-item-group-header').hover();
    await block.getByTestId('sidebar-item-group-create').click();
    await expect
      .poll(
        async () =>
          (await groups(window)).find((group) => group.id === destination.id)
            ?.memberIds.length,
      )
      .toBe(4);
    await assertPosition();
    const moveLog = await window.evaluate(() => window.__sidebarGroupMoveLog);
    expect(moveLog.committed).toBeGreaterThan(0);
    expect(moveLog).toMatchObject({
      groupAboveMiddle: false,
      movedAboveMember: false,
      droppedBelowMember: false,
    });
    await refresh(window);
    await assertPosition();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code pointer destinations distinguish row halves, group headers, group edges and whole groups', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-pointer-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 6,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const group = await seedGroup(window, ids[0], [ids[1]]);
    await refresh(window);
    const source = (id) =>
      window.locator(
        `[data-sidebar-group-drag-source="item:${id}"] button[aria-roledescription="sortable"]`,
      );
    const row = (id) =>
      window.locator(
        `[data-sidebar-group-drag-source="item:${id}"] [data-testid="worktree-row"]`,
      );
    await dragTo(window, source(ids[2]), row(ids[1]), 0.8);
    await expect
      .poll(async () => (await groups(window))[0].memberIds)
      .toContain(ids[2]);
    await window.getByTestId('sidebar-item-group-toggle').click();
    await expect(
      window.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
    await dragTo(
      window,
      source(ids[3]),
      window.getByTestId('sidebar-item-group-header'),
      0.5,
    );
    await expect
      .poll(async () => (await groups(window))[0].memberIds)
      .toContain(ids[3]);
    // Anywhere on the header joins, even near its edges.
    await dragTo(
      window,
      source(ids[4]),
      window.getByTestId('sidebar-item-group-header'),
      0.12,
    );
    await expect
      .poll(async () => (await groups(window))[0].memberIds)
      .toContain(ids[4]);
    const registry = path.join(
      userDataDir,
      'workspaces',
      CHATS_SECTION_CODE_WORKSPACE_ID,
      'worktrees.json',
    );
    await expect
      .poll(() => json(registry).worktrees.map((entry) => entry.id))
      .toEqual([ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]]);
    // Only the thin edges just outside the group place a row beside it.
    await dragTo(
      window,
      source(ids[5]),
      window.getByTestId('sidebar-item-group-header'),
      -0.1,
    );
    await expect
      .poll(() => json(registry).worktrees.map((entry) => entry.id))
      .toEqual([ids[5], ids[0], ids[1], ids[2], ids[3], ids[4]]);
    expect((await groups(window))[0].memberIds).not.toContain(ids[5]);
    await expect
      .poll(async () => {
        const preceding = await row(ids[5]).boundingBox();
        const header = await window
          .getByTestId('sidebar-item-group-header')
          .boundingBox();
        return Boolean(
          preceding && header && preceding.y + preceding.height <= header.y,
        );
      })
      .toBe(true);
    await dragTo(
      window,
      source(ids[5]),
      window.getByTestId('sidebar-item-group-header'),
      1.1,
    );
    await expect
      .poll(() => json(registry).worktrees.map((entry) => entry.id))
      .toEqual([ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]]);
    // The registry commits before its renderer projection. Measure the next
    // gesture only after the header has moved above the ungrouped row.
    await expect
      .poll(async () => {
        const header = await window
          .getByTestId('sidebar-item-group-header')
          .boundingBox();
        const following = await row(ids[5]).boundingBox();
        return Boolean(
          header && following && header.y + header.height <= following.y,
        );
      })
      .toBe(true);
    await dragTo(
      window,
      window.getByTestId('sidebar-item-group-toggle'),
      row(ids[5]),
      0.8,
    );
    await expect
      .poll(() => json(registry).worktrees.map((entry) => entry.id))
      .toEqual([ids[5], ids[0], ids[1], ids[2], ids[3], ids[4]]);
    expect((await groups(window))[0].id).toBe(group.id);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code group drags only land beside whole blocks, chosen by the hovered half', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-block-halves-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 6,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const first = await seedGroup(window, ids[0], [ids[1]], 'First');
    const second = await seedGroup(window, ids[2], [ids[3]], 'Second');
    await refresh(window);
    const registry = path.join(
      userDataDir,
      'workspaces',
      CHATS_SECTION_CODE_WORKSPACE_ID,
      'worktrees.json',
    );
    const order = () => json(registry).worktrees.map((entry) => entry.id);
    const toggle = (groupId) =>
      window.locator(
        `[data-sidebar-item-group-id="${groupId}"] [data-testid="sidebar-item-group-toggle"]`,
      );
    const block = (groupId) =>
      window.locator(`[data-sidebar-group-block="${groupId}"]`);
    const indicator = window.getByTestId('sidebar-item-group-drop-indicator');
    // Hovers the target at each fraction and reports where the line landed.
    async function hover(handle, target, fractions) {
      const a = await handle.boundingBox();
      if (!a) throw new Error('Missing drag handle');
      await window.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await window.mouse.down();
      await window.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, {
        steps: 4,
      });
      await expect(
        window.getByTestId('sidebar-item-group-drag-overlay'),
      ).toBeVisible();
      // No row inside any group accepts a group.
      await expect(
        window.locator(
          '[data-sidebar-group-drag-source] .pointer-events-auto[data-drop-zone]',
        ),
      ).toHaveCount(0);
      const b = await target.boundingBox();
      if (!b) throw new Error('Missing drop target');
      const lines = [];
      for (const fraction of fractions) {
        await window.mouse.move(b.x + b.width / 2, b.y + b.height * fraction, {
          steps: 8,
        });
        await expect(indicator).toHaveCount(1);
        const zone = JSON.parse(
          await indicator.evaluate(
            (element) =>
              element
                .closest('[data-drop-zone]')
                ?.getAttribute('data-drop-zone') ?? '{}',
          ),
        );
        const line = await indicator.boundingBox();
        lines.push({
          edge: zone.edge,
          blockId: zone.blockId,
          atTop: Boolean(line && Math.abs(line.y - b.y) <= 2),
          atBottom: Boolean(
            line && Math.abs(line.y + line.height - (b.y + b.height)) <= 2,
          ),
        });
      }
      return lines;
    }
    // Upper half of a group (over its first row) is before it; lower half after.
    expect(await hover(toggle(first.id), block(second.id), [0.3, 0.8])).toEqual(
      [
        { edge: 'before', blockId: second.id, atTop: true, atBottom: false },
        { edge: 'after', blockId: second.id, atTop: false, atBottom: true },
      ],
    );
    await window.mouse.up();
    await expect
      .poll(order)
      .toEqual([ids[2], ids[3], ids[0], ids[1], ids[4], ids[5]]);
    await window.waitForTimeout(60);
    // Ungrouped rows split the same way.
    const ungrouped = window.locator(
      `[data-sidebar-group-drag-source="item:${ids[4]}"]`,
    );
    expect(await hover(toggle(second.id), ungrouped, [0.3])).toEqual([
      { edge: 'before', blockId: ids[4], atTop: true, atBottom: false },
    ]);
    await window.mouse.up();
    await expect
      .poll(order)
      .toEqual([ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code grouped selection pins its header and restores flow without duplicated interactive identities', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-pins-'),
  );
  // Enough Chats rows that the project header starts below its bottom seat,
  // whatever the nav rows above it measure.
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 30,
    chatEntryCount: 4,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
    viewportSize: { width: 900, height: 560 },
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await seedGroup(window, ids[0], ids.slice(1, 12));
    await refresh(window);
    const viewport = window.getByTestId('sidebar-scroll-container');
    const selected = viewport.locator(
      `[data-sidebar-group-drag-source="item:${ids[10]}"] [data-testid="worktree-row"]`,
    );
    await selected.click();
    // The bottom pin copies a header only once the flow header would sit
    // inside the pin stack. Seat the project header halfway into its slot
    // above the group header and selected row, rather than relying on where
    // scroll zero leaves it.
    const seatedOffset = await viewport.evaluate((element) => {
      const flowTop = (node) =>
        element.scrollTop +
        node.getBoundingClientRect().top -
        element.getBoundingClientRect().top;
      const row = element.querySelector(
        '[data-sidebar-selected-item]:not([data-sidebar-selected-pin-seat="chats"])',
      );
      const groupHeader = row
        ?.closest('[data-sidebar-item-group-id]')
        ?.querySelector('[data-sidebar-item-group-header]');
      const header = row
        ?.closest('[data-sidebar-workspace-id]')
        ?.querySelector('.sidebar-workspace-sticky-header');
      if (!row || !groupHeader || !header) {
        throw new Error(
          'Missing selected row, group header, or project header',
        );
      }
      const headerSeatTop =
        element.clientHeight -
        row.offsetHeight -
        groupHeader.offsetHeight -
        header.offsetHeight;
      return flowTop(header) - headerSeatTop - header.offsetHeight / 2;
    });
    expect(seatedOffset).toBeGreaterThan(0);
    await viewport.evaluate((element, offset) => {
      element.scrollTop = offset;
      element.dispatchEvent(new Event('scroll'));
    }, seatedOffset);
    const bottom = window.getByTestId('sidebar-selected-pin-bottom');
    await expect(bottom).toBeVisible();
    await expect(
      bottom.locator('[data-sidebar-selected-pin-part="header"]'),
    ).toBeVisible();
    await expect(
      bottom.locator('[data-sidebar-selected-pin-part="group-header"]'),
    ).toBeVisible();
    const headerOffset = await viewport
      .getByTestId('sidebar-item-group-header')
      .evaluate((header) => {
        const viewport = header.closest(
          '[data-testid="sidebar-scroll-container"]',
        );
        if (!viewport) throw new Error('Missing viewport');
        return (
          viewport.scrollTop +
          header.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          150
        );
      });
    await viewport.evaluate((element, offset) => {
      element.scrollTop = offset;
      element.dispatchEvent(new Event('scroll'));
    }, headerOffset);
    await expect(bottom).toBeVisible();
    await expect(
      bottom.locator('[data-sidebar-selected-pin-part="group-header"]'),
    ).toBeHidden();
    const top = window.getByTestId('sidebar-selected-pin-top');
    const pinOffset = await selected.evaluate((element) => {
      const viewport = element.closest(
        '[data-testid="sidebar-scroll-container"]',
      );
      if (!viewport) throw new Error('Missing viewport');
      return (
        viewport.scrollTop +
        element.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        10
      );
    });
    await viewport.evaluate((element, offset) => {
      element.scrollTop = offset;
      element.dispatchEvent(new Event('scroll'));
    }, pinOffset);
    await expect(top).toBeVisible();
    await expect(
      top.getByTestId('sidebar-item-group-header-pin-top'),
    ).toBeVisible();
    await expect(top.getByTestId('sidebar-item-group-header')).toHaveCount(0);
    const header = viewport.getByTestId('sidebar-item-group-header');
    await expect(header).toHaveAttribute(
      'data-sidebar-selected-pin-flow-hidden',
      'true',
    );
    await expect
      .poll(() =>
        header.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe('0');
    await expect(header).toHaveAttribute('inert', '');
    // The pin stands in for the header, so the covered header must not also
    // stick below it and cut the group's next rows out of view.
    const [pinBottom, headerPosition, contentClip] = await viewport.evaluate(
      (element) => {
        const group = element.querySelector('[data-sidebar-item-group-id]');
        return [
          element
            .querySelector('[data-sidebar-selected-pin-top]')
            .getBoundingClientRect().bottom,
          getComputedStyle(
            group.querySelector('[data-sidebar-item-group-header]'),
          ).position,
          getComputedStyle(
            group.querySelector('[data-sidebar-item-group-content]'),
          ).clipPath,
        ];
      },
    );
    expect(pinBottom).toBeGreaterThan(0);
    expect(headerPosition).not.toBe('sticky');
    expect(contentClip).toBe('none');
    // Restore the header in the viewport; only the seated start needs its copy.
    await viewport.evaluate((element, offset) => {
      element.scrollTop = offset;
      element.dispatchEvent(new Event('scroll'));
    }, headerOffset);
    await expect(top).toBeHidden();
    await expect(
      bottom.locator('[data-sidebar-selected-pin-part="group-header"]'),
    ).toBeHidden();
    await expect(header).not.toHaveAttribute('inert', '');
    await expect
      .poll(() =>
        header.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe('1');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code group header sticks under the stuck project header until its group scrolls past', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-sticky-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 30,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
    viewportSize: { width: 900, height: 560 },
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await seedGroup(window, ids[0], ids.slice(1, 12));
    await refresh(window);
    // Select outside the group so no selected-row pin takes the seat.
    await window
      .getByTestId('sidebar-scroll-container')
      .locator(
        `[data-sidebar-group-drag-source="item:${ids[29]}"] [data-testid="worktree-row"]`,
      )
      .click();
    const viewport = window.getByTestId('sidebar-scroll-container');
    // Scrolls so the group's top edge sits `edge` px from the band's bottom
    // (negative: above it), then reports the header against that line.
    const sample = (edge) =>
      viewport.evaluate(async (element, edge) => {
        const frames = () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        const group = element.querySelector('[data-sidebar-item-group-id]');
        const header = group?.querySelector('[data-sidebar-item-group-header]');
        const slot = element.querySelector(
          '[data-testid="sidebar-sticky-workspace-slot"]',
        );
        if (!group || !header || !slot) throw new Error('Missing group/slot');
        for (let pass = 0; pass < 3; pass += 1) {
          // Repeat: the band's depth settles once the slot stands in.
          element.scrollTop +=
            group.getBoundingClientRect().top -
            slot.getBoundingClientRect().bottom -
            edge;
          element.dispatchEvent(new Event('scroll'));
          await frames();
        }
        const rect = header.getBoundingClientRect();
        const hit = window.document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        // Where the group's content is cut, so rows never paint through the
        // header's transparent box.
        const content = group.querySelector(
          '[data-sidebar-item-group-content]',
        );
        const contentRect = content.getBoundingClientRect();
        const inset = getComputedStyle(content).clipPath.match(
          /^inset\(([-\d.]+)(px|%)/,
        );
        const cut = inset
          ? contentRect.top +
            Number(inset[1]) * (inset[2] === '%' ? contentRect.height / 100 : 1)
          : Number.NaN;
        return {
          slotActive: !slot.hidden,
          line: slot.getBoundingClientRect().bottom,
          top: rect.top,
          bottom: rect.bottom,
          cut,
          groupBottom: group.getBoundingClientRect().bottom,
          opacity: getComputedStyle(header).opacity,
          hit: header.contains(hit),
        };
      }, edge);

    // Mid-group: the header holds the line under the stuck project header and
    // takes pointer hits over the rows passing beneath it.
    const inside = await sample(-120);
    expect(inside.slotActive).toBe(true);
    expect(Math.abs(inside.top - inside.line)).toBeLessThanOrEqual(1);
    expect(inside.opacity).toBe('1');
    expect(inside.hit).toBe(true);
    expect(Math.abs(inside.cut - inside.bottom)).toBeLessThanOrEqual(1.5);

    // The group's end pushes it off rather than leaving it over later rows.
    const past = await sample(-2000);
    expect(past.bottom).toBeLessThanOrEqual(past.groupBottom + 0.5);
    expect(past.bottom).toBeLessThanOrEqual(past.line + 0.5);

    // Collapsing from the stuck header keeps that header in view at its seat
    // rather than letting it fall away above the band with its rows.
    await sample(-120);
    const toggle = viewport.getByTestId('sidebar-item-group-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect
      .poll(async () => {
        const collapsed = await viewport.evaluate((element) => {
          const header = element.querySelector(
            '[data-sidebar-item-group-header]',
          );
          const rect = header.getBoundingClientRect();
          const hit = window.document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return {
            offset:
              rect.top -
              element
                .querySelector('[data-testid="sidebar-sticky-workspace-slot"]')
                .getBoundingClientRect().bottom,
            hit: header.contains(hit),
          };
        });
        return collapsed.hit && Math.abs(collapsed.offset) <= 1;
      })
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code create-in-group keeps the pending and registered row inside durable membership', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-create-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 3,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  const sidecar = path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_CODE_WORKSPACE_ID,
    'sidebar-item-groups.json',
  );
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const group = await seedGroup(window, ids[0]);
    await refresh(window);
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible();
    const { writeFileSync, existsSync } = await import('node:fs');
    writeFileSync(`${sidecar}.e2e-hold`, 'hold');
    await electronApp.evaluate(() => {
      process.env.CANOPY_E2E_SIDEBAR_ITEM_GROUP_HOLD_WRITES = '1';
    });
    const header = window.getByTestId('sidebar-item-group-header');
    await header.hover();
    await window.getByTestId('sidebar-item-group-create').click();
    await expect.poll(() => existsSync(`${sidecar}.e2e-entered`)).toBe(true);
    const groupElement = window.locator(
      `[data-sidebar-item-group-id="${group.id}"]`,
    );
    await expect(
      groupElement.getByTestId('sidebar-worktree-creating-placeholder'),
    ).toBeVisible();
    await expect(
      groupElement.locator('[data-testid="worktree-row"]'),
    ).toHaveCount(1);
    rmSync(`${sidecar}.e2e-hold`);
    await expect(
      groupElement.getByTestId('sidebar-worktree-creating-placeholder'),
    ).toHaveCount(0);
    await expect(
      groupElement.locator('[data-testid="worktree-row"]'),
    ).toHaveCount(2);
    const current = (await groups(window)).find(
      (entry) => entry.id === group.id,
    );
    expect(current.memberIds.length).toBe(2);
    expect(current.memberIds).toContain(ids[0]);
    const created = current.memberIds.find((id) => id !== ids[0]);
    await expect(
      groupElement.locator(
        '[data-sidebar-selected-item] [data-testid="worktree-row"]',
      ),
    ).toHaveAttribute('data-worktree-id', created);
    await expect(window.getByTestId('page-home')).not.toBeVisible();
    await expect(window.getByTestId('page-main')).toBeVisible();
  } finally {
    rmSync(`${sidecar}.e2e-hold`, { force: true });
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code row menus reconcile pin and hide membership and ungroup without deleting worktrees', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-lifecycle-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 3,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const group = await seedGroup(window, ids[0], [ids[1], ids[2]]);
    await refresh(window);
    const row = (id) =>
      window.locator(
        `[data-sidebar-group-drag-source="item:${id}"] [data-testid="worktree-row"]`,
      );
    await row(ids[0]).click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Pin to top', exact: true })
      .click();
    await expect
      .poll(async () => (await groups(window))[0]?.memberIds)
      .toEqual([ids[1], ids[2]]);
    await row(ids[1]).click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Hide', exact: true }).click();
    await expect
      .poll(async () => (await groups(window))[0]?.memberIds)
      .toEqual([ids[2]]);
    await window.getByTestId('sidebar-item-group-header').hover();
    await window.getByTestId('sidebar-item-group-menu-trigger').click();
    await window
      .getByRole('menuitem', { name: 'Ungroup', exact: true })
      .click();
    await expect.poll(() => groups(window)).toEqual([]);
    expect(
      json(
        path.join(
          userDataDir,
          'workspaces',
          CHATS_SECTION_CODE_WORKSPACE_ID,
          'worktrees.json',
        ),
      ).worktrees.map((entry) => entry.id),
    ).toEqual(ids);
    await expect(
      window.locator(`[data-sidebar-item-group-id="${group.id}"]`),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code item groups keep branch-stack children attached and reorder them only inside their stack', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-stack-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 4,
    chatEntryCount: 1,
  });
  const registry = path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_CODE_WORKSPACE_ID,
    'worktrees.json',
  );
  const { writeFileSync } = await import('node:fs');
  const content = json(registry);
  for (const entry of content.worktrees.slice(1, 3)) {
    entry.branchGroupingParentWorktreeId = ids[0];
    entry.trackedBaseBranch = ids[0];
  }
  writeFileSync(registry, JSON.stringify(content));
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const group = await seedGroup(window, ids[0], [ids[3]]);
    await refresh(window);
    const child = window.locator(
      `[data-sidebar-group-drag-source="child:${ids[1]}"]`,
    );
    await expect(child.getByTestId('worktree-nesting-rail')).toBeVisible();
    await child.getByTestId('worktree-row').click({ button: 'right' });
    await expect(
      window.getByRole('menuitem', { name: 'Group', exact: true }),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    const handle = child.locator('button[aria-roledescription="sortable"]');
    await handle.press('Space');
    await handle.press('ArrowDown');
    await handle.press('Space');
    await expect
      .poll(() => json(registry).worktrees.map((entry) => entry.id))
      .toEqual([ids[0], ids[2], ids[1], ids[3]]);
    const sibling = window.locator(
      `[data-sidebar-group-drag-source="child:${ids[2]}"] [data-testid="worktree-row"]`,
    );
    const visibleChildIds = () =>
      window
        .locator('[data-sidebar-group-drag-source^="child:"]')
        .evaluateAll((children) =>
          children.map((element) =>
            element.getAttribute('data-child-worktree-id'),
          ),
        );
    // The owner writes before the acknowledged renderer refresh. Wait for the
    // visible reorder before measuring the next pointer gesture's row edges.
    await expect.poll(visibleChildIds).toEqual([ids[2], ids[1]]);
    await dragTo(window, handle, sibling, 0.2);
    await expect
      .poll(() => json(registry).worktrees.map((entry) => entry.id))
      .toEqual([ids[0], ids[1], ids[2], ids[3]]);
    await expect.poll(visibleChildIds).toEqual([ids[1], ids[2]]);
    await dragTo(window, handle, sibling, 0.8);
    await expect
      .poll(() => json(registry).worktrees.map((entry) => entry.id))
      .toEqual([ids[0], ids[2], ids[1], ids[3]]);
    const current = (await groups(window)).find(
      (entry) => entry.id === group.id,
    );
    expect(new Set(current.memberIds)).toEqual(new Set([ids[0], ids[3]]));
    await child.getByTestId('worktree-row').click();
    await window.getByTestId('sidebar-item-group-toggle').click();
    await expect(
      window.locator(
        `[data-sidebar-item-group-id="${group.id}"] [data-testid="worktree-row"]`,
      ),
    ).toHaveCount(1);
    await expect(child.getByTestId('worktree-row')).toBeVisible();
    const collapsedOrder = json(registry).worktrees.map((entry) => entry.id);
    await handle.press('Space');
    await handle.press('ArrowUp');
    await handle.press('Space');
    expect(json(registry).worktrees.map((entry) => entry.id)).toEqual(
      collapsedOrder,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('hidden-label Code group rail stays inside the viewport and opens its menu', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-rail-'),
  );
  const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 3,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const group = await seedGroup(window, worktreeIds[0], [worktreeIds[1]], '');
    expect(group.name).toBe(defaultGroupName([]));
    expect(group.labelHidden).toBe(true);
    await refresh(window);
    const viewport = window.getByTestId('sidebar-scroll-container');
    const rail = viewport.getByTestId('sidebar-item-group-rail');
    const geometry = await rail.evaluate((element) => {
      const line = element.firstElementChild;
      const viewport = element.closest(
        '[data-testid="sidebar-scroll-container"]',
      );
      if (!line || !viewport) throw new Error('Missing rail geometry');
      const bounds = element.getBoundingClientRect();
      const clip = viewport.getBoundingClientRect();
      return {
        left: bounds.left,
        clipLeft: clip.left,
        width: bounds.width,
        lineHeight: line.getBoundingClientRect().height,
        color: getComputedStyle(line).backgroundColor,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.clipLeft);
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.lineHeight).toBeGreaterThan(20);
    expect(geometry.color).not.toBe('rgba(0, 0, 0, 0)');
    await rail.click({ button: 'right' });
    await expect(window.getByTestId('sidebar-item-group-menu')).toContainText(
      `${group.name} · 2 worktrees`,
    );
    await window.getByTestId('sidebar-item-group-edit').click();
    await expect(
      window.getByRole('dialog', { name: 'Edit group', exact: true }),
    ).toBeVisible();
    await window.getByRole('button', { name: 'Close group editor' }).click();
    await window.getByTestId('app-sidebar').getByRole('button').first().focus();
    let reached = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      await window.keyboard.press('Tab');
      if (
        await rail.evaluate((element) => element === document.activeElement)
      ) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
    await window.keyboard.press('Space');
    await window.keyboard.press('ArrowDown');
    await window.keyboard.press('Space');
    const registry = path.join(
      userDataDir,
      'workspaces',
      CHATS_SECTION_CODE_WORKSPACE_ID,
      'worktrees.json',
    );
    await expect
      .poll(() => json(registry).worktrees.map((entry) => entry.id))
      .toEqual([worktreeIds[2], worktreeIds[0], worktreeIds[1]]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code root and whole-group pointer previews include every branch descendant in order', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-stack-preview-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 4,
    chatEntryCount: 1,
  });
  const registry = path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_CODE_WORKSPACE_ID,
    'worktrees.json',
  );
  const { writeFileSync } = await import('node:fs');
  const content = json(registry);
  for (const entry of content.worktrees.slice(1, 3)) {
    entry.branchGroupingParentWorktreeId = ids[0];
    entry.trackedBaseBranch = ids[0];
  }
  writeFileSync(registry, JSON.stringify(content));
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await seedGroup(window, ids[0], [ids[3]]);
    await refresh(window);
    for (const kind of ['item', 'group']) {
      const handle =
        kind === 'item'
          ? window.locator(
              `[data-sidebar-group-drag-source="item:${ids[0]}"] button[aria-roledescription="sortable"]`,
            )
          : window.getByTestId('sidebar-item-group-toggle');
      const box = await handle.boundingBox();
      if (!box) throw new Error('Missing drag handle');
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await window.mouse.down();
      await window.mouse.move(
        box.x + box.width / 2 + 12,
        box.y + box.height / 2,
        { steps: 4 },
      );
      const overlay = window.getByTestId('sidebar-item-group-drag-overlay');
      await expect(overlay).toBeVisible();
      // Floating previews deliberately omit the in-flow row identity hooks.
      const labels = await overlay.textContent();
      let previousIndex = -1;
      for (let index = 0; index < (kind === 'item' ? 3 : 4); index++) {
        const labelIndex = labels?.indexOf(`feature-0${index + 1}`) ?? -1;
        expect(labelIndex).toBeGreaterThan(previousIndex);
        previousIndex = labelIndex;
      }
      await window.keyboard.press('Escape');
      await window.mouse.up();
      await expect(overlay).toHaveCount(0);
      await window.waitForTimeout(60);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Branch from a member of a named group must not disturb the manual sequence:
// an unrelated row and an earlier named group sit above the target group, and
// the branched worktree joins its parent's stack inside that group instead of
// landing elsewhere in the registry and dragging the group out of its slot.
// The optimistic sidebar can look right while the saved order is wrong, so the
// registry, the owner's group list and the DOM are all checked after reload.
test('Code Branch from keeps named groups in their manual slots and nests the branch under its parent', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-branch-from-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 6,
    chatEntryCount: 1,
  });
  const registry = path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_CODE_WORKSPACE_ID,
    'worktrees.json',
  );
  const registryIds = () => json(registry).worktrees.map((entry) => entry.id);
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
    viewportSize: { width: 1280, height: 1180 },
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    // ids[0] unrelated, [ids[1]] earlier group, ids[2] unrelated,
    // [ids[3], ids[4]] target group, ids[5] unrelated.
    const earlier = await seedGroup(window, ids[1], [], 'Earlier group');
    const target = await seedGroup(window, ids[3], [ids[4]], 'Target group');
    await refresh(window);
    await expect.poll(registryIds).toEqual(ids);
    const groupSnapshot = async () =>
      (await groups(window)).map((group) => ({
        id: group.id,
        name: group.name,
        memberIds: group.memberIds,
      }));
    const expectedGroups = [
      { id: earlier.id, name: 'Earlier group', memberIds: [ids[1]] },
      { id: target.id, name: 'Target group', memberIds: [ids[3], ids[4]] },
    ];
    expect(await groupSnapshot()).toEqual(expectedGroups);

    const workRow = (id) =>
      window.locator(`[data-testid="worktree-row"][data-worktree-id="${id}"]`);
    const groupBlock = (id) =>
      window.locator(`[data-sidebar-item-group-id="${id}"]`);
    const branchFrom = async (sourceId) => {
      const before = new Set(registryIds());
      const sourceBranch = json(registry).worktrees.find(
        (entry) => entry.id === sourceId,
      ).branchName;
      const source = workRow(sourceId);
      // Select the source first so its Git status is hydrated, as a user would.
      await source.click();
      await expect(window.getByTestId('page-main')).toBeVisible();
      await source.hover();
      await source.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-create-branch').click();
      // The seeded worktrees are clean; tolerate the uncommitted-changes
      // prompt anyway so a status race cannot stall the flow.
      const warning = window.getByTestId('branch-from-uncommitted-warning');
      const prompted = await warning
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (prompted) {
        await warning.getByRole('button', { name: 'Continue' }).click();
        await window.getByRole('menuitem', { name: 'Do not commit' }).click();
      }
      // Wait for the git-ready registration: a Branch from child records its
      // parent or tracks the parent's branch.
      let createdId;
      await expect
        .poll(
          () => {
            const created = json(registry).worktrees.find(
              (entry) => !before.has(entry.id),
            );
            createdId = created?.id;
            return Boolean(
              created &&
              (created.branchGroupingParentWorktreeId === sourceId ||
                created.trackedBaseBranch === sourceBranch),
            );
          },
          { timeout: 90_000 },
        )
        .toBe(true);
      return createdId;
    };
    // Registry: the original rows keep their sequence and every branch sits
    // inside the target group's span, after the parent, before the trailing
    // unrelated row.
    const assertRegistry = async (stack) => {
      await expect
        .poll(() => registryIds().filter((id) => ids.includes(id)))
        .toEqual(ids);
      const order = registryIds();
      expect(order).toHaveLength(ids.length + stack.length);
      // Descendants may keep their supplied sibling order; each only has to
      // stay inside the root's stack span, between the root and the trailing
      // unrelated row. The painted parent-before-descendant order is checked
      // in the sidebar.
      for (const id of stack) {
        const index = order.indexOf(id);
        expect(index, `${id} follows the stack root`).toBeGreaterThan(
          order.indexOf(ids[3]),
        );
        expect(index, `${id} stays inside the target group`).toBeLessThan(
          order.indexOf(ids[5]),
        );
      }
    };
    const assertSidebar = async (stack) => {
      const block = groupBlock(target.id);
      await expect(
        block.locator(`[data-worktree-id="${ids[3]}"]`).first(),
      ).toBeVisible();
      const boxes = [
        await workRow(ids[0]).boundingBox(),
        await groupBlock(earlier.id).boundingBox(),
        await workRow(ids[2]).boundingBox(),
        await block.boundingBox(),
        await workRow(ids[5]).boundingBox(),
      ];
      for (const box of boxes) expect(box).not.toBeNull();
      for (let index = 1; index < boxes.length; index++)
        expect(boxes[index - 1].y).toBeLessThan(boxes[index].y);
      let previous = await workRow(ids[3]).boundingBox();
      for (const id of stack) {
        const child = block.locator(
          `[data-sidebar-group-drag-source="child:${id}"]`,
        );
        await expect(child).toBeVisible();
        await expect(child.getByTestId('worktree-nesting-rail')).toBeVisible();
        const box = await child.boundingBox();
        expect(box.y).toBeGreaterThan(previous.y);
        previous = box;
      }
      await expect(
        window.locator(`[data-sidebar-group-drag-source="item:${stack[0]}"]`),
      ).toHaveCount(0);
    };

    const child = await branchFrom(ids[3]);
    await assertRegistry([child]);
    await expect.poll(groupSnapshot).toEqual(expectedGroups);
    await assertSidebar([child]);
    await refresh(window);
    await assertRegistry([child]);
    expect(await groupSnapshot()).toEqual(expectedGroups);
    await assertSidebar([child]);

    // Branching from the branch keeps the whole stack inside the group.
    const grandchild = await branchFrom(child);
    await assertRegistry([child, grandchild]);
    await expect.poll(groupSnapshot).toEqual(expectedGroups);
    await refresh(window);
    await assertRegistry([child, grandchild]);
    expect(await groupSnapshot()).toEqual(expectedGroups);
    await assertSidebar([child, grandchild]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code retained groups collapse and expand through row menus', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-retained-menu-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 3,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const group = await seedGroup(window, ids[1]);
    await window.evaluate(
      ({ groupId, scope }) =>
        window.api.sidebarItemGroups.update({
          scope,
          groupId,
          keepWhenEmpty: true,
        }),
      { groupId: group.id, scope: codeScope },
    );
    await refresh(window);
    const block = window.locator(`[data-sidebar-item-group-id="${group.id}"]`);
    const toggle = block.getByTestId('sidebar-item-group-toggle');
    const row = (id) =>
      window.locator(
        `[data-sidebar-group-drag-source="item:${id}"] [data-testid="worktree-row"]`,
      );
    await row(ids[1]).click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Group', exact: true }).hover();
    await window
      .getByRole('menuitem', { name: 'Remove from group', exact: true })
      .click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect
      .poll(async () => (await groups(window))[0])
      .toMatchObject({
        memberIds: [],
        collapsed: true,
      });
    await row(ids[1]).click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to group', exact: true })
      .hover();
    await window
      .getByRole('menuitem', { name: 'Release polish', exact: true })
      .click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(row(ids[1])).toBeVisible();
    await toggle.click();
    await row(ids[2]).click({ button: 'right' });
    await window
      .getByRole('menuitem', { name: 'Add to group', exact: true })
      .hover();
    await window
      .getByRole('menuitem', { name: 'Release polish', exact: true })
      .click();
    await expect
      .poll(async () => (await groups(window))[0])
      .toMatchObject({
        memberIds: [ids[1], ids[2]],
        collapsed: true,
      });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Code kept groups hold their slot when empty and highlight every drop that joins them', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-kept-empty-'),
  );
  const { worktreeIds: ids } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 4,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const group = await seedGroup(window, ids[1]);
    await window.evaluate(
      ({ groupId, scope }) =>
        window.api.sidebarItemGroups.update({
          scope,
          groupId,
          keepWhenEmpty: true,
        }),
      { groupId: group.id, scope: codeScope },
    );
    await window.evaluate(
      ({ itemId, scope }) =>
        window.api.sidebarItemGroups.moveItem({ scope, itemId, groupId: null }),
      { itemId: ids[1], scope: codeScope },
    );
    await refresh(window);
    const block = window.locator(`[data-sidebar-group-block="${group.id}"]`);
    // The emptied group stays above the row that followed it.
    const known = new Set([group.id, ...ids.map((id) => `item:${id}`)]);
    const sequence = async () =>
      (
        await window
          .locator(
            `[data-sidebar-group-block="${group.id}"], [data-sidebar-group-drag-source^="item:"]`,
          )
          .evaluateAll((nodes) =>
            nodes.map(
              (node) =>
                node.getAttribute('data-sidebar-group-block') ??
                node.getAttribute('data-sidebar-group-drag-source'),
            ),
          )
      ).filter((id) => known.has(id));
    await expect
      .poll(sequence)
      .toEqual([
        `item:${ids[0]}`,
        `item:${ids[1]}`,
        group.id,
        `item:${ids[2]}`,
        `item:${ids[3]}`,
      ]);
    await expect(
      block.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
    // The empty group moves by its header, and the drag carries the group.
    const toggle = block.getByTestId('sidebar-item-group-toggle');
    const t = await toggle.boundingBox();
    const top = await window
      .locator(
        `[data-sidebar-group-drag-source="item:${ids[0]}"] [data-testid="worktree-row"]`,
      )
      .boundingBox();
    if (!t || !top) throw new Error('Expected group drag geometry');
    await window.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await window.mouse.down();
    await window.mouse.move(t.x + t.width / 2 + 12, t.y + t.height / 2, {
      steps: 4,
    });
    await window.mouse.move(top.x + top.width / 2, top.y + top.height * 0.2, {
      steps: 12,
    });
    await expect(
      window.getByTestId('sidebar-item-group-drag-preview'),
    ).toContainText('Release polish');
    await window.mouse.up();
    await window.waitForTimeout(60);
    await expect
      .poll(sequence)
      .toEqual([
        group.id,
        `item:${ids[0]}`,
        `item:${ids[1]}`,
        `item:${ids[2]}`,
        `item:${ids[3]}`,
      ]);
    const source = (id) =>
      window.locator(
        `[data-sidebar-group-drag-source="item:${id}"] button[aria-roledescription="sortable"]`,
      );
    const header = block.getByTestId('sidebar-item-group-header');
    const a = await source(ids[3]).boundingBox();
    const b = await header.boundingBox();
    if (!a || !b) throw new Error('Expected drag geometry');
    await window.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await window.mouse.down();
    await window.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, {
      steps: 4,
    });
    await window.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {
      steps: 12,
    });
    await expect(block).toHaveAttribute('data-drop-target', 'true');
    await window.mouse.up();
    await window.waitForTimeout(60);
    await expect
      .poll(async () => (await groups(window))[0].memberIds)
      .toEqual([ids[3]]);
    // The joining row moved into the group's slot.
    await expect
      .poll(sequence)
      .toEqual([
        group.id,
        `item:${ids[3]}`,
        `item:${ids[0]}`,
        `item:${ids[1]}`,
        `item:${ids[2]}`,
      ]);
    await expect(block.getByTestId('sidebar-item-group-empty')).toHaveCount(0);
    await expect(
      block.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(block).not.toHaveAttribute('data-drop-target');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
