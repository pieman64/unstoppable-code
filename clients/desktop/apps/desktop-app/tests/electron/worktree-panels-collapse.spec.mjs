// Collapse and recursive subtree promotion through real panel chrome, with restart coverage.

import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { closeCanopy } from './launchCanopy.mjs';
import {
  constrainActivityHeader,
  expectCaretAfterMenu,
  expectLayoutMenuAnchored,
} from './panelChromeOrder.mjs';
import { seedInnerPanelLayout } from './seeders/seedInnerPanelLayout.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  expandDefaultActivityRail,
  getActiveGroupId,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

function leavesById(layout) {
  return new Map(
    collectLeaves(layout.root).map((leaf) => [leaf.groupId, leaf]),
  );
}

async function innerBoxes(window) {
  return window.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid^="panel-group-inner-"]')].map(
        (element) => {
          // Collapse and sash geometry use the allocated cell, outside the
          // inset card margins introduced by the graduated window layout.
          const { x, y, width, height } = element
            .closest('.canopy-panel-leaf')
            .getBoundingClientRect();
          return [
            element
              .getAttribute('data-testid')
              .replace('panel-group-inner-', ''),
            { x, y, width, height },
          ];
        },
      ),
    ),
  );
}

function expectBox(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) {
    expect(Math.abs(actual[key] - expected[key]), key).toBeLessThanOrEqual(1);
  }
}

/**
 * Wait for the expand transition to settle before comparing geometry.
 *
 * `innerBoxes` sampled immediately after the last expand click caught a
 * mid-transition frame on loaded CI runners — a restored group measured ~20px
 * from its resting position against a 1px tolerance. Poll until the geometry
 * matches, then assert once more so a genuine mismatch still reports which
 * axis drifted.
 */
async function expectInnerBoxesRestored(window, before, ids) {
  await expect
    .poll(
      async () => {
        const after = await innerBoxes(window);
        return ids.every((id) =>
          ['x', 'y', 'width', 'height'].every(
            (key) => Math.abs(after[id][key] - before[id][key]) <= 1,
          ),
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const after = await innerBoxes(window);
  for (const id of ids) expectBox(after[id], before[id]);
}

test('inner siblings collapse locally, preserve chat content, and restore on relaunch', async () => {
  const userDataDir = seedInnerPanelLayout();
  const first = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    viewportSize: { width: 1900, height: 1050 },
  });
  try {
    const { window } = first;
    await expect(window.getByTestId('panel-group-inner-C')).toBeVisible();
    const before = await innerBoxes(window);
    const content = window
      .getByTestId('panel-group-inner-B')
      .getByTestId('panel-content-chat');
    const handle = await content.elementHandle();
    const collapseB = window.getByTestId('panel-group-collapse-inner-B');
    await expect(collapseB).toBeVisible();
    await collapseB.click();
    await expect(
      window.getByTestId('panel-collapsed-bar-inner-B'),
    ).toBeVisible();
    await expect(
      window.getByTestId('panel-group-collapse-inner-C'),
    ).toBeEnabled();
    const collapsed = await innerBoxes(window);
    expect(collapsed.B.width).toBe(48);
    expect(
      Math.abs(collapsed.C.width - (before.B.width + before.C.width - 48)),
    ).toBeLessThanOrEqual(1);
    for (const id of ['A', 'D', 'E', 'F', 'G', 'H', 'I'])
      expectBox(collapsed[id], before[id]);
    await window.getByTestId('panel-group-expand-inner-B').click();
    expect(await handle.evaluate((element) => element.isConnected)).toBe(true);
    await expect(content).toBeVisible();
    expectBox((await innerBoxes(window)).B, before.B);

    await window.getByTestId('panel-group-collapse-inner-C').click();
    await expect(
      window.getByTestId('panel-group-collapse-inner-B'),
    ).toBeEnabled();
    await window.getByTestId('panel-group-collapse-inner-F').click();
    const after = await innerBoxes(window);
    expect(after.F.height).toBe(48);
    expectBox(after.E, before.E);
    expect(
      Math.abs(after.G.height - (before.F.height + before.G.height - 48)),
    ).toBeLessThanOrEqual(1);
    for (const id of ['A', 'D', 'H', 'I']) expectBox(after[id], before[id]);
    // The save crosses the real renderer debounce and main-process persistence.
    await window.waitForTimeout(1500);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }
  const second = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    viewportSize: { width: 1900, height: 1050 },
  });
  try {
    for (const id of ['C', 'F']) {
      await expect(
        second.window.getByTestId(`panel-collapsed-bar-inner-${id}`),
      ).toBeVisible();
      await second.window.getByTestId(`panel-group-expand-inner-${id}`).click();
      await expect(
        second.window.getByTestId(`panel-collapsed-bar-inner-${id}`),
      ).toHaveCount(0);
    }
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('collapse via chrome button shows the icon bar and pins the leaf size', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    // The rail now seeds collapsed (CAN-2836); this test's subject is the
    // chrome collapse affordance, so open it first.
    await expandDefaultActivityRail(window);
    const collapseButton = window.getByTestId(
      `panel-group-collapse-${DEFAULT_GROUP_IDS.activity}`,
    );
    await expect(collapseButton).toBeVisible();
    await collapseButton.click();

    const bar = window.getByTestId(
      `panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`,
    );
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-edge', 'right');

    const leaves = leavesById(await getLayout(window));
    expect(leaves.get(DEFAULT_GROUP_IDS.activity).collapsed).toBe('right');
    // The leaf is pinned to PANEL_COLLAPSED_BAR_SIZE (48px); allow one pixel
    // for split-view layout rounding in the reported geometry.
    const collapsedSize = leaves.get(DEFAULT_GROUP_IDS.activity).size;
    expect(collapsedSize).toBeGreaterThanOrEqual(47);
    expect(collapsedSize).toBeLessThanOrEqual(49);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the collapse caret trails the layout menu in expanded and collapsed chrome', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    const activity = DEFAULT_GROUP_IDS.activity;
    await expandDefaultActivityRail(window);

    // Expanded side panel header: … → layout menu → collapse caret.
    const menu = window.getByTestId(`panel-group-menu-${activity}`);
    const collapse = window.getByTestId(`panel-group-collapse-${activity}`);
    await expect(menu).toBeVisible();
    await expect(collapse).toBeVisible();
    await expectCaretAfterMenu(window, {
      menuId: `panel-group-menu-${activity}`,
      caretId: `panel-group-collapse-${activity}`,
      nextId: null,
      axis: 'row',
    });

    // Exercise the real minimum width and the menu beside the viewport edge.
    await constrainActivityHeader(window, activity);
    await expectLayoutMenuAnchored(window, activity);

    // Keyboard order follows the visual order: menu → caret.
    await menu.focus();
    await window.keyboard.press('Tab');
    await expect(collapse).toBeFocused();
    await window.keyboard.press('Enter');

    // Vertical collapsed strip: … → layout menu → expand caret → tab icons.
    const bar = window.getByTestId(`panel-collapsed-bar-${activity}`);
    await expect(bar).toBeVisible();
    const edge = await bar.getAttribute('data-edge');
    const vertical = edge === 'left' || edge === 'right';
    const firstTabId = vertical
      ? await bar
          .locator('[data-testid^="panel-collapsed-tab-"]')
          .first()
          .getAttribute('data-testid')
      : null;
    await expectCaretAfterMenu(window, {
      menuId: `panel-group-menu-${activity}`,
      caretId: `panel-group-expand-${activity}`,
      nextId: firstTabId,
      axis: vertical ? 'column' : 'row',
    });
    await window.getByTestId(`panel-group-expand-${activity}`).click();
    await expect(bar).toHaveCount(0);
    await expect(collapse).toBeVisible();

    // Bottom drawer (seeded collapsed): horizontal bar ends with the caret,
    // then the expanded drawer header ends with the collapse caret.
    const terminal = DEFAULT_GROUP_IDS.terminal;
    await expect(
      window.getByTestId(`panel-collapsed-bar-${terminal}`),
    ).toHaveAttribute('data-edge', 'bottom');
    await expectCaretAfterMenu(window, {
      menuId: `panel-group-menu-${terminal}`,
      caretId: `panel-group-expand-${terminal}`,
      nextId: null,
      axis: 'row',
    });
    await window.getByTestId(`panel-group-expand-${terminal}`).click();
    await expect(
      window.getByTestId(`panel-collapsed-bar-${terminal}`),
    ).toHaveCount(0);
    await expectCaretAfterMenu(window, {
      menuId: `panel-group-menu-${terminal}`,
      caretId: `panel-group-collapse-${terminal}`,
      nextId: null,
      axis: 'row',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('activity rail compatibility expansion preserves the previously active group', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    await window.evaluate((groupId) => {
      window.__canopyPanelTestApi.focusPanel(groupId);
    }, DEFAULT_GROUP_IDS.chat);
    await expect
      .poll(() => getActiveGroupId(window))
      .toBe(DEFAULT_GROUP_IDS.chat);

    await expandDefaultActivityRail(window);

    await expect(
      window.getByTestId(`panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`),
    ).toHaveCount(0);
    await expect
      .poll(() => getActiveGroupId(window))
      .toBe(DEFAULT_GROUP_IDS.chat);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('clicking a collapsed tab icon expands the group and activates that tab', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    // Open the seeded-collapsed rail (CAN-2836) so the collapse below is the
    // chrome-driven one this test is about.
    await expandDefaultActivityRail(window);
    await window
      .getByTestId(`panel-group-collapse-${DEFAULT_GROUP_IDS.activity}`)
      .click();
    const before = leavesById(await getLayout(window));
    const firstPanelId = before.get(DEFAULT_GROUP_IDS.activity).panels[0]
      .panelId;

    await window.getByTestId(`panel-collapsed-tab-${firstPanelId}`).click();

    await expect(
      window.getByTestId(`panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`),
    ).toHaveCount(0);
    const after = leavesById(await getLayout(window));
    expect(after.get(DEFAULT_GROUP_IDS.activity).collapsed).toBe(null);
    expect(after.get(DEFAULT_GROUP_IDS.activity).activePanelId).toBe(
      firstPanelId,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the final expanded panel shows a disabled chevron and can be re-enabled', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    // Restore this test's premise: chat AND the rail expanded, terminal
    // collapsed. CAN-2836 seeds the rail collapsed too, which would already
    // make chat the last expanded panel and disable its chevron up front.
    await expandDefaultActivityRail(window);
    await expect(
      window.getByTestId(`panel-collapsed-bar-${DEFAULT_GROUP_IDS.terminal}`),
    ).toBeVisible();
    const chatCollapse = window.getByTestId(
      `panel-group-collapse-${DEFAULT_GROUP_IDS.chat}`,
    );
    await expect(chatCollapse).toBeEnabled();
    await chatCollapse.click();
    await expect(
      window.getByTestId(`panel-branch-bar-${DEFAULT_GROUP_IDS.chat}`),
    ).toBeVisible();
    const finalCollapse = window.getByTestId(
      `panel-group-collapse-${DEFAULT_GROUP_IDS.activity}`,
    );
    await expect(finalCollapse).toBeDisabled();
    await finalCollapse.locator('..').hover();
    await expect(window.getByRole('tooltip')).toContainText(
      'At least one panel must stay expanded',
    );
    await window
      .getByTestId(`panel-branch-expand-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await expect(finalCollapse).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('collapsed bar keeps working controls: add + overflow menu, and maximize expands then maximizes', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    await expandDefaultActivityRail(window);
    await window
      .getByTestId(`panel-group-collapse-${DEFAULT_GROUP_IDS.activity}`)
      .click();

    // The add-panel button and overflow menu stay reachable while collapsed.
    await expect(
      window.getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.activity}`),
    ).toBeVisible();
    const menu = window.getByTestId(
      `panel-group-menu-${DEFAULT_GROUP_IDS.activity}`,
    );
    await expect(menu).toBeVisible();

    // The overflow menu portals to the body so it escapes the ~36px leaf clip;
    // its "Full screen" item is actually clickable and expands-then-maximizes.
    await menu.click();
    const maximizeItem = window.getByTestId(
      `panel-group-maximize-${DEFAULT_GROUP_IDS.activity}`,
    );
    await expect(maximizeItem).toBeVisible();
    await maximizeItem.click();

    await expect(
      window.getByTestId(`panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`),
    ).toHaveCount(0);
    const leaves = leavesById(await getLayout(window));
    expect(leaves.get(DEFAULT_GROUP_IDS.activity).collapsed).toBe(null);
    expect(leaves.get(DEFAULT_GROUP_IDS.activity).maximized).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('collapsed state persists across app restart', async () => {
  // ---- Launch 1: collapse activity via the test API and let the save land.
  const first = await seedPanelWorktree();
  const { userDataDir } = first;

  try {
    // Expand the seeded-collapsed rail first (CAN-2836): otherwise the
    // collapse below is a no-op on an already-collapsed group and the restart
    // assertion would pass on the seeded default rather than on a persisted
    // user collapse.
    await expandDefaultActivityRail(first.window);
    await first.window.evaluate(
      (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      DEFAULT_GROUP_IDS.activity,
    );

    await expect(
      first.window.getByTestId(
        `panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`,
      ),
    ).toBeVisible();

    // Renderer save debounce is 500ms; give it margin to reach main before
    // quitting (main's own 100ms disk debounce flushes on app quit).
    await first.window.waitForTimeout(1500);
  } finally {
    // Keep the data dir so the relaunch can read panel-layout.json.
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // ---- Launch 2 (same userDataDir): the collapsed edge must be restored. --
  const second = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });

  try {
    await expect(
      second.window.getByTestId(
        `panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`,
      ),
    ).toBeVisible();

    const leaves = leavesById(await getLayout(second.window));
    expect(leaves.get(DEFAULT_GROUP_IDS.activity).collapsed).toBe('right');
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('recursive branch collapse leaves one expanded panel and restores a selected descendant', async () => {
  const userDataDir = seedInnerPanelLayout();
  const first = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    viewportSize: { width: 1900, height: 1050 },
  });
  try {
    const { window } = first;
    await expect(window.getByTestId('panel-group-inner-C')).toBeVisible();
    const before = await innerBoxes(window);
    const content = await window
      .getByTestId('panel-group-inner-B')
      .getByTestId('panel-content-chat')
      .elementHandle();
    for (const id of ['E', 'F', 'G'])
      await window.getByTestId(`panel-group-collapse-inner-${id}`).click();
    const column = window.getByTestId('panel-branch-bar-inner-E');
    await expect(column).toBeVisible();
    expect(
      await column.evaluate(
        (element) => element.parentElement.getBoundingClientRect().width,
      ),
    ).toBe(48);
    const after = await innerBoxes(window);
    for (const id of ['A', 'B', 'C', 'D']) expectBox(after[id], before[id]);
    for (const id of ['H', 'I'])
      expect(
        Math.abs(after[id].width - (before[id].width + before.E.width - 48)),
      ).toBeLessThanOrEqual(1);
    for (const id of ['B', 'C'])
      await window.getByTestId(`panel-group-collapse-inner-${id}`).click();
    const row = window.getByTestId('panel-branch-bar-inner-B');
    await expect(row).toBeVisible();
    expect(
      await row.evaluate(
        (element) => element.parentElement.getBoundingClientRect().height,
      ),
    ).toBe(48);
    await window.getByTestId('panel-group-collapse-inner-D').click();
    await expect(row).toHaveAttribute('data-edge', 'right');
    for (const id of ['H', 'I'])
      await window.getByTestId(`panel-group-collapse-inner-${id}`).click();
    await expect(
      window.getByTestId('panel-group-collapse-inner-A'),
    ).toBeDisabled();
    for (const id of ['B', 'E', 'H'])
      await expect(
        window.getByTestId(`panel-branch-bar-inner-${id}`),
      ).toHaveAttribute('data-edge', 'right');
    expect(await content.evaluate((element) => element.isConnected)).toBe(true);
    await window.getByTestId('panel-branch-expand-inner-B').click();
    await expect(
      window
        .getByTestId('panel-group-inner-B')
        .getByTestId('panel-content-chat'),
    ).toBeVisible();
    expect(await content.evaluate((element) => element.isConnected)).toBe(true);
    await window.getByTestId('panel-branch-expand-inner-F').click();
    await expect(window.getByTestId('panel-group-inner-F')).toBeVisible();
    expect((await innerBoxes(window)).F.width).toBeGreaterThan(48);
    await window.getByTestId('panel-group-collapse-inner-F').click();
    await window.waitForTimeout(1500);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }
  const second = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    viewportSize: { width: 1900, height: 1050 },
  });
  try {
    await expect(
      second.window.getByTestId('panel-branch-bar-inner-E'),
    ).toBeVisible();
    await second.window.getByTestId('panel-branch-tab-inner-panel-G').click();
    await expect(
      second.window.getByTestId('panel-group-inner-G'),
    ).toBeVisible();
    await expect(
      second.window.getByTestId('panel-collapsed-bar-inner-E'),
    ).toBeVisible();
    await expect(
      second.window.getByTestId('panel-collapsed-bar-inner-F'),
    ).toBeVisible();
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('leaving fixed topology restores a compact branch', async () => {
  const userDataDir = seedInnerPanelLayout();
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    viewportSize: { width: 1900, height: 1050 },
  });
  try {
    for (const id of ['E', 'F', 'G'])
      await window.getByTestId(`panel-group-collapse-inner-${id}`).click();
    await expect(window.getByTestId('panel-branch-bar-inner-E')).toBeVisible();

    await window.evaluate(() =>
      window.__canopyPanelTestApi.setFixedTopology(true),
    );
    await expect(window.getByTestId('panel-branch-bar-inner-E')).toHaveCount(0);

    await window.evaluate(() =>
      window.__canopyPanelTestApi.setFixedTopology(false),
    );

    await expect(window.getByTestId('panel-branch-bar-inner-E')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('maximize fills the grid beside an unrelated compact branch', async () => {
  const userDataDir = seedInnerPanelLayout();
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    viewportSize: { width: 1900, height: 1050 },
  });
  try {
    for (const id of ['E', 'F', 'G'])
      await window.getByTestId(`panel-group-collapse-inner-${id}`).click();
    await expect(window.getByTestId('panel-branch-bar-inner-E')).toBeVisible();

    await window.getByTestId('panel-group-menu-inner-A').click();
    await window.getByTestId('panel-group-maximize-inner-A').click();

    await expect(
      window.getByTestId('panel-group-restore-inner-A'),
    ).toBeVisible();
    expect(
      await window.evaluate(() =>
        window.__canopyPanelTestApi.getCollapsedBranchCount(),
      ),
    ).toBe(0);
    await expect(window.getByTestId('panel-branch-bar-inner-E')).toHaveCount(0);
    const gridBox = await window.getByTestId('panel-grid-root').boundingBox();
    const groupBox = await window
      .getByTestId('panel-group-inner-A')
      .locator('xpath=..')
      .boundingBox();
    expectBox(groupBox, gridBox);

    await window.getByTestId('panel-group-restore-inner-A').click();
    await expect(window.getByTestId('panel-branch-bar-inner-E')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const collapseOrder of [
  ['I', 'H'],
  ['H', 'I'],
]) {
  for (const expandOrder of [
    ['I', 'H'],
    ['H', 'I'],
  ]) {
    test(`stacked groups restore sizes: collapse ${collapseOrder}, expand ${expandOrder}`, async () => {
      const userDataDir = seedInnerPanelLayout();
      const { electronApp, window } = await seedPanelWorktree({
        userDataDir,
        seedDemoWorkspaces: false,
        viewportSize: { width: 1900, height: 1050 },
      });
      try {
        await expect(window.getByTestId('panel-group-inner-I')).toBeVisible();
        const before = await innerBoxes(window);
        for (const id of collapseOrder)
          await window.getByTestId(`panel-group-collapse-inner-${id}`).click();
        await window
          .getByTestId(`panel-branch-expand-inner-${expandOrder[0]}`)
          .click();
        await window
          .getByTestId(`panel-group-expand-inner-${expandOrder[1]}`)
          .click();
        await expectInnerBoxesRestored(window, before, ['H', 'I']);
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }
}

for (const legacy of [false, true]) {
  test(`stacked group ratios survive restart (legacy: ${legacy})`, async () => {
    const userDataDir = seedInnerPanelLayout();
    const options = {
      userDataDir,
      seedDemoWorkspaces: false,
      viewportSize: { width: 1900, height: 1050 },
    };
    const first = await seedPanelWorktree(options);
    let before;
    try {
      await expect(
        first.window.getByTestId('panel-group-inner-I'),
      ).toBeVisible();
      before = await innerBoxes(first.window);
      for (const id of legacy ? ['I'] : ['I', 'H'])
        await first.window
          .getByTestId(`panel-group-collapse-inner-${id}`)
          .click();
      await expect(
        first.window.getByTestId(
          legacy ? 'panel-group-expand-inner-I' : 'panel-branch-expand-inner-I',
        ),
      ).toBeVisible();
      await first.window.waitForTimeout(1500);
    } finally {
      await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
    }
    if (legacy) {
      const file = path.join(
        userDataDir,
        'workspaces',
        'demo-ts-pnpm-vite',
        'worktree-data',
        'demo-main',
        'panel-layout.json',
      );
      const layout = JSON.parse(readFileSync(file, 'utf8'), (key, value) =>
        key === 'expandedSizes' ? undefined : value,
      );
      writeFileSync(file, JSON.stringify(layout));
    }
    const second = await seedPanelWorktree(options);
    try {
      if (legacy)
        await second.window.getByTestId('panel-group-collapse-inner-H').click();
      await second.window.getByTestId('panel-branch-expand-inner-I').click();
      await second.window.getByTestId('panel-group-expand-inner-H').click();
      await expectInnerBoxesRestored(second.window, before, ['H', 'I']);
    } finally {
      await closeCanopy(second.electronApp, userDataDir);
    }
  });
}

test('divider dragging while a sibling is collapsed persists as the new expanded split', async () => {
  const userDataDir = seedInnerPanelLayout();
  const options = {
    userDataDir,
    seedDemoWorkspaces: false,
    viewportSize: { width: 1900, height: 1050 },
  };
  const first = await seedPanelWorktree(options);
  let before;
  let delta;
  try {
    const { window } = first;
    await expect(window.getByTestId('panel-group-inner-G')).toBeVisible();
    before = await innerBoxes(window);
    await window.getByTestId('panel-group-collapse-inner-E').click();
    // Let the collapse itself finish saving before the divider drag. The
    // drag must schedule a distinct persistence write rather than hitchhike
    // on the collapse debounce.
    await window.waitForTimeout(1500);
    const collapsed = await innerBoxes(window);
    const x = collapsed.F.x + collapsed.F.width / 2;
    const y = collapsed.F.y + collapsed.F.height;
    await window.mouse.move(x, y);
    await window.mouse.down();
    await window.mouse.move(x, y + 60, { steps: 8 });
    await window.mouse.up();
    const resized = await innerBoxes(window);
    delta = resized.F.height - collapsed.F.height;
    expect(delta).toBeGreaterThan(50);
    await window.waitForTimeout(1500);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  const second = await seedPanelWorktree(options);
  try {
    await second.window.getByTestId('panel-group-expand-inner-E').click();
    const after = await innerBoxes(second.window);
    expect(Math.abs(after.E.height - before.E.height)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(after.F.height - before.F.height - delta),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(after.G.height - before.G.height + delta),
    ).toBeLessThanOrEqual(1);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});
