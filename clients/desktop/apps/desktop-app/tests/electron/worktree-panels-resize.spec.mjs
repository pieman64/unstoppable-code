// Phase 4 grid operations — sash drag-resize. The engine renders sashes as
// `.canopy-sash` elements (class `horizontal` resizes the groups above/below,
// `vertical` resizes left/right); they carry NO testids yet (doc-09 proposes
// `panel-sash-*` ids as a follow-up), so specs address them by orientation
// class inside `panel-grid-root` — the default layout has exactly one of
// each — and drive them by bounding-box pointer drags.
//
// Assertions are direction-of-change with tolerance bands (never exact
// pixels), plus layout-consistency checks (leaf count and per-branch size
// sums unchanged) as the cheap perf/consistency sanity for a scripted drag.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  countLeaves,
  DEFAULT_GROUP_IDS,
  expandDefaultActivityRail,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

function leafByGroupId(layout, groupId) {
  const leaf = collectLeaves(layout.root).find(
    (node) => node.groupId === groupId,
  );
  if (!leaf) {
    throw new Error(`No leaf for group ${groupId}`);
  }
  return leaf;
}

/** Drags from a sash's center by (dx, dy), asserting the engine marks it active mid-drag. */
async function dragSash(window, sash, dx, dy) {
  const box = await sash.boundingBox();
  expect(box).not.toBeNull();
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await window.mouse.move(startX, startY);
  await window.mouse.down();
  await window.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 4 });
  // The engine adds `.active` to the dragged sash on drag start (the
  // doc-09 `panel-sash-active` signal, expressed as a class today).
  await expect(window.locator('.canopy-sash.active')).toHaveCount(1);
  await window.mouse.move(startX + dx, startY + dy, { steps: 4 });
  await window.mouse.up();
  await expect(window.locator('.canopy-sash.active')).toHaveCount(0);
}

test('dragging the sashes resizes adjacent groups in the drag direction and keeps the layout consistent', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Both optional regions seed collapsed (terminal, and the activity rail
    // since CAN-2836). A collapsed leaf is pinned to the collapsed-bar size on
    // its axis, so the sashes beside them cannot resize anything until they
    // are open — expand both to get the three-way default split back.
    await window
      .getByTestId(`panel-group-expand-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await expandDefaultActivityRail(window);

    const gridRoot = window.getByTestId('panel-grid-root');
    // Default layout: one horizontal sash (chat above / terminal below) and
    // one vertical sash (chat column left / activity right).
    const horizontalSash = gridRoot.locator('.canopy-sash.horizontal');
    const verticalSash = gridRoot.locator('.canopy-sash.vertical');
    await expect(horizontalSash).toHaveCount(1);
    await expect(verticalSash).toHaveCount(1);

    const before = await getLayout(window);
    // Serialized leaf sizes are along the parent branch axis: heights for
    // chat/terminal (vertical column), width for the activity leaf.
    const chatHeightBefore = leafByGroupId(before, DEFAULT_GROUP_IDS.chat).size;
    const terminalHeightBefore = leafByGroupId(
      before,
      DEFAULT_GROUP_IDS.terminal,
    ).size;
    const columnWidthBefore = before.root.children[0].size;
    const activityWidthBefore = leafByGroupId(
      before,
      DEFAULT_GROUP_IDS.activity,
    ).size;

    // --- Horizontal sash: drag UP 120px -> chat shrinks, terminal grows ----
    await dragSash(window, horizontalSash, 0, -120);

    let layout = await getLayout(window);
    const chatHeightAfter = leafByGroupId(layout, DEFAULT_GROUP_IDS.chat).size;
    const terminalHeightAfter = leafByGroupId(
      layout,
      DEFAULT_GROUP_IDS.terminal,
    ).size;
    expect(chatHeightAfter).toBeLessThan(chatHeightBefore - 60);
    expect(terminalHeightAfter).toBeGreaterThan(terminalHeightBefore + 60);
    // Complementary within the column: the total height is conserved.
    expect(
      Math.abs(
        chatHeightAfter +
          terminalHeightAfter -
          (chatHeightBefore + terminalHeightBefore),
      ),
    ).toBeLessThanOrEqual(4);

    // --- Vertical sash: drag LEFT 100px -> column shrinks, activity grows --
    // Leftward on purpose: the default layout already sits the Activity
    // column at the leaf minimum width, so a rightward drag has nowhere to
    // go. The chat/terminal column has plenty of room to give up.
    await dragSash(window, verticalSash, -100, 0);

    layout = await getLayout(window);
    const columnWidthAfter = layout.root.children[0].size;
    const activityWidthAfter = leafByGroupId(
      layout,
      DEFAULT_GROUP_IDS.activity,
    ).size;
    expect(columnWidthAfter).toBeLessThan(columnWidthBefore - 50);
    expect(activityWidthAfter).toBeGreaterThan(activityWidthBefore + 50);
    expect(
      Math.abs(
        columnWidthAfter +
          activityWidthAfter -
          (columnWidthBefore + activityWidthBefore),
      ),
    ).toBeLessThanOrEqual(4);

    // --- Consistency sanity after both drags -------------------------------
    expect(await countLeaves(window)).toBe(3);
    expect(layout.activeGroupId).toBe(before.activeGroupId);
    // Root branch children still span the full grid width.
    const rootChildrenWidth = layout.root.children.reduce(
      (sum, child) => sum + child.size,
      0,
    );
    expect(Math.abs(rootChildrenWidth - layout.width)).toBeLessThanOrEqual(4);
    // And the groups are still visible and content-bearing.
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await expect(window.getByTestId('panel-content-terminal')).toBeVisible();
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-resize.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
