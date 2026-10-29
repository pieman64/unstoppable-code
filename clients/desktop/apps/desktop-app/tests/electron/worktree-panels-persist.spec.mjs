// Phase 5 panel persistence — per-worktree `panel-layout.json` round-trip.
//
// Flow: seed a demo worktree, mutate the default grid topology through the
// panel test API (split the chat group right → 4 leaves), wait out the
// renderer's 500ms debounced save (main's 100ms write debounce also flushes
// on quit), then relaunch against the SAME user data dir and assert the
// restored grid deep-equals the pre-relaunch layout:
//
//   - tree SHAPE (branch/leaf structure, orientations, group ids, panel
//     ids/kinds, active panel per group, maximized flags) must be identical;
//   - SIZES are compared within a small band (both launches use the same
//     1400x900 viewport, but the host ResizeObserver relayout may shift
//     px sizes by rounding).
//
// The restore path is the persistence bridge (`ensureWorktreePanelLayout`):
// selecting the worktree loads `panel-layout.json` over IPC and rebuilds the
// grid via `restoreLayout` BEFORE any default layout is built.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  countLeaves,
  DEFAULT_GROUP_IDS,
  getActiveGroupId,
  getLayout,
  seedPanelWorktree,
  splitViaApi,
} from './panelHarness.mjs';

/** Size tolerance: |a - b| <= max(8px, 5% of the expected size). */
function expectSizeClose(actual, expected, label) {
  const tolerance = Math.max(8, Math.abs(expected) * 0.05);
  expect(
    Math.abs(actual - expected),
    `${label}: ${actual} vs ${expected} (tolerance ${tolerance})`,
  ).toBeLessThanOrEqual(tolerance);
}

/**
 * Structural projection of a serialized node tree: everything except sizes
 * (compared exactly), plus a parallel walk that compares sizes with the band.
 */
function toShape(node) {
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      groupId: node.groupId,
      panels: node.panels,
      activePanelId: node.activePanelId,
      maximized: node.maximized,
    };
  }
  return {
    type: 'branch',
    orientation: node.orientation,
    children: node.children.map((child) => toShape(child)),
  };
}

function expectSizesClose(actual, expected, path = 'root') {
  expectSizeClose(actual.size, expected.size, `${path}.size`);
  if (expected.type === 'branch') {
    expect(actual.children.length).toBe(expected.children.length);
    expected.children.forEach((expectedChild, index) => {
      expectSizesClose(
        actual.children[index],
        expectedChild,
        `${path}.children[${index}]`,
      );
    });
  }
}

test('worktree panel layout persists across app relaunches', async () => {
  // ---- Launch 1: mutate the default topology and let the save land. ------
  const first = await seedPanelWorktree();
  const { userDataDir } = first;
  let before = null;

  try {
    expect(await countLeaves(first.window)).toBe(3);

    // Split the chat group to the right — a topology mutation the default
    // builder never produces, so a successful relaunch match proves the
    // restore path (not a rebuilt default) rendered the grid.
    const newGroupId = await splitViaApi(
      first.window,
      DEFAULT_GROUP_IDS.chat,
      'right',
    );
    expect(newGroupId).toBeTruthy();
    await expect.poll(() => countLeaves(first.window)).toBe(4);
    // The split focuses the new group.
    expect(await getActiveGroupId(first.window)).toBe(newGroupId);

    before = await getLayout(first.window);
    expect(before).not.toBeNull();

    // Renderer save debounce is 500ms; give it margin to reach main before
    // quitting (main's own 100ms disk debounce flushes on app quit).
    await first.window.waitForTimeout(1500);
  } finally {
    // Keep the data dir so the relaunch can read panel-layout.json.
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // ---- Launch 2 (same userDataDir): the layout must be restored. ---------
  const second = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });

  try {
    // Restore lands before the grid mounts; poll for the 4-leaf topology in
    // case the harness caught the placeholder frame.
    await expect.poll(() => countLeaves(second.window)).toBe(4);

    const after = await getLayout(second.window);
    expect(after).not.toBeNull();

    // Tree shape, ids, kinds, active tabs, maximize flags: exact match.
    expect(toShape(after.root)).toEqual(toShape(before.root));
    expect(after.activeGroupId).toBe(before.activeGroupId);

    // Group ids/kinds in document order (redundant with the shape check but
    // gives a readable failure for partial restores).
    expect(
      collectLeaves(after.root).map((leaf) => [
        leaf.groupId,
        leaf.panels.map((panel) => panel.kind).join(','),
      ]),
    ).toEqual(
      collectLeaves(before.root).map((leaf) => [
        leaf.groupId,
        leaf.panels.map((panel) => panel.kind).join(','),
      ]),
    );

    // Sizes within the tolerance band, node by node.
    expectSizesClose(after.root, before.root);
    expectSizeClose(after.width, before.width, 'grid.width');
    expectSizeClose(after.height, before.height, 'grid.height');
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});
