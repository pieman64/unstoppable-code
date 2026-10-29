// Phase 4 grid operations — maximize via the overflow ("…") menu's Full
// screen item (`panel-group-menu-${groupId}` -> `panel-group-maximize-
// ${groupId}`) and restore via the direct button shown while maximized
// (`panel-group-restore-${groupId}`).
//
// Engine semantics under maximize (SerializableGrid.serializeNode): the
// maximized leaf serializes `maximized: true`; every other leaf is hidden
// (`visible: false`) and serializes its CACHED pre-maximize size, which is
// what restore puts back — so restored sizes are asserted against the
// pre-maximize sizes within a small tolerance.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  getActiveGroupId,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

function leavesById(layout) {
  const map = new Map();
  for (const leaf of collectLeaves(layout.root)) {
    map.set(leaf.groupId, leaf);
  }
  return map;
}

test('maximize hides sibling groups and restore returns their previous sizes', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const chatGroup = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.chat}`,
    );
    const terminalGroup = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.terminal}`,
    );
    const activityGroup = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.activity}`,
    );
    const chatMenu = window.getByTestId(
      `panel-group-menu-${DEFAULT_GROUP_IDS.chat}`,
    );
    const restoreButton = window.getByTestId(
      `panel-group-restore-${DEFAULT_GROUP_IDS.chat}`,
    );

    const before = await getLayout(window);
    const beforeLeaves = leavesById(before);
    const chatBoxBefore = await chatGroup.boundingBox();
    // Not maximized: no direct restore button.
    await expect(restoreButton).toHaveCount(0);

    // --- Maximize the chat group (menu -> Full screen) ---------------------
    await chatMenu.click();
    await window
      .getByTestId(`panel-group-maximize-${DEFAULT_GROUP_IDS.chat}`)
      .click();

    await expect(restoreButton).toBeVisible();
    await expect(terminalGroup).toBeHidden();
    await expect(activityGroup).toBeHidden();
    await expect(chatGroup).toBeVisible();

    // The chat group now fills the whole grid.
    const gridBox = await window.getByTestId('panel-grid-root').boundingBox();
    const chatBoxMaximized = await chatGroup.boundingBox();
    expect(chatBoxMaximized.width).toBeGreaterThanOrEqual(gridBox.width - 4);
    expect(chatBoxMaximized.height).toBeGreaterThanOrEqual(gridBox.height - 4);
    expect(chatBoxMaximized.width).toBeGreaterThan(chatBoxBefore.width + 40);

    // Serialized state: chat leaf maximized, the siblings hidden; maximize
    // also focuses the maximized group.
    const maximized = leavesById(await getLayout(window));
    expect(maximized.get(DEFAULT_GROUP_IDS.chat).maximized).toBe(true);
    expect(maximized.get(DEFAULT_GROUP_IDS.terminal).visible).toBe(false);
    expect(maximized.get(DEFAULT_GROUP_IDS.activity).visible).toBe(false);
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    // --- Restore (direct button) -------------------------------------------
    await restoreButton.click();

    await expect(restoreButton).toHaveCount(0);
    await expect(terminalGroup).toBeVisible();
    await expect(activityGroup).toBeVisible();

    const restoredLeaves = leavesById(await getLayout(window));
    for (const groupId of Object.values(DEFAULT_GROUP_IDS)) {
      const restored = restoredLeaves.get(groupId);
      expect(restored.visible).toBe(true);
      expect(restored.maximized).toBe(false);
      // Size-cache restore (doc 02): previous sizes come back.
      expect(
        Math.abs(restored.size - beforeLeaves.get(groupId).size),
        `${groupId} restored size`,
      ).toBeLessThanOrEqual(5);
    }

    const chatBoxRestored = await chatGroup.boundingBox();
    expect(
      Math.abs(chatBoxRestored.width - chatBoxBefore.width),
    ).toBeLessThanOrEqual(5);
    expect(
      Math.abs(chatBoxRestored.height - chatBoxBefore.height),
    ).toBeLessThanOrEqual(5);

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-maximize.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
