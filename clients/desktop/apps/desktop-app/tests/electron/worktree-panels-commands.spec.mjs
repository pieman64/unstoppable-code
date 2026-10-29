// Phase 6b — panel operations via the command palette and global keyboard
// shortcuts (doc 12 §1). Both callers dispatch through the same
// `lib/panels/commands.ts` layer onto the panel layout store, so this spec
// asserts the end-to-end wiring, not the grid semantics (covered by the
// worktree-panels-split/maximize specs):
//
//   1. palette: "Split panel right" splits the ACTIVE group, focuses the new
//      EMPTY group, and dismisses the palette (closePalette: true);
//   2. shortcut: Cmd/Ctrl+Shift+F toggles maximize on the active group
//      (maximized leaf + hidden siblings, then restored);
//   3. guard: with the chat composer focused, the split shortcut must NOT
//      fire (editable-target guard), while the same key works after focusing
//      a non-editable surface.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  countLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getActiveGroupId,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const PALETTE_SHORTCUT = `${MOD}+K`;
const MAXIMIZE_SHORTCUT = `${MOD}+Shift+F`;
const SPLIT_RIGHT_SHORTCUT = `${MOD}+Backslash`;

function leavesById(layout) {
  const map = new Map();
  for (const leaf of collectLeaves(layout.root)) {
    map.set(leaf.groupId, leaf);
  }
  return map;
}

async function getNewEmptyActiveLeaf(page) {
  const layout = await getLayout(page);
  if (!layout) {
    return null;
  }

  const leaves = collectLeaves(layout.root);
  if (leaves.length !== 4) {
    return null;
  }

  const newLeaf = leaves.find(
    (leaf) => !Object.values(DEFAULT_GROUP_IDS).includes(leaf.groupId),
  );
  if (!newLeaf || newLeaf.panels.length > 0) {
    return null;
  }

  return layout.activeGroupId === newLeaf.groupId ? newLeaf : null;
}

test('palette runs Split Panel Right against the active group', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    expect(await countLeaves(window)).toBe(3);

    // Make the terminal group active so the palette op provably targets the
    // ACTIVE group, not a default.
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi?.focusPanel(groupId),
      DEFAULT_GROUP_IDS.terminal,
    );
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.terminal);

    await window.keyboard.press(PALETTE_SHORTCUT);
    await expect(window.getByTestId('command-palette')).toBeVisible();
    await window.getByTestId('command-palette-input').fill('Split panel right');
    const option = window.getByRole('option', { name: 'Split panel right' });
    await expect(option).toBeVisible();
    await option.click();

    // Panel commands return closePalette: true.
    await expect(window.getByTestId('command-palette')).toBeHidden();

    // Splits create EMPTY groups (no clone) — the new group has no tabs and
    // is focused, ready for the add-tab affordance to bring content in.
    await expect
      .poll(
        async () => (await getNewEmptyActiveLeaf(window))?.groupId ?? null,
        {
          timeout: 15_000,
        },
      )
      .not.toBeNull();
    const layout = await getLayout(window);
    const newLeaf = collectLeaves(layout.root).find(
      (leaf) => !Object.values(DEFAULT_GROUP_IDS).includes(leaf.groupId),
    );
    expect(newLeaf).toBeDefined();
    expect(newLeaf.panels).toHaveLength(0);
    expect(await getActiveGroupId(window)).toBe(newLeaf.groupId);

    await window.screenshot({
      path: testInfo.outputPath('panel-commands-palette-split.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keyboard shortcut toggles maximize and respects the composer guard', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Focus a non-editable surface: the chat group's tab bar tab.
    await window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`).click();
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    // --- Maximize toggle (Cmd/Ctrl+Shift+F) ---------------------------------
    await window.keyboard.press(MAXIMIZE_SHORTCUT);

    await expect(
      window.getByTestId(`panel-group-${DEFAULT_GROUP_IDS.terminal}`),
    ).toBeHidden();
    let leaves = leavesById(await getLayout(window));
    expect(leaves.get(DEFAULT_GROUP_IDS.chat).maximized).toBe(true);
    expect(leaves.get(DEFAULT_GROUP_IDS.activity).visible).toBe(false);

    // Toggle back — everything visible again.
    await window.keyboard.press(MAXIMIZE_SHORTCUT);
    await expect(
      window.getByTestId(`panel-group-${DEFAULT_GROUP_IDS.terminal}`),
    ).toBeVisible();
    leaves = leavesById(await getLayout(window));
    expect(leaves.get(DEFAULT_GROUP_IDS.chat).maximized).toBe(false);
    expect(leaves.get(DEFAULT_GROUP_IDS.activity).visible).toBe(true);

    // --- Editable-target guard ---------------------------------------------
    // Focus the chat composer (Slate contenteditable); the split shortcut
    // must not fire while typing there.
    const composer = window.locator('[contenteditable="true"]').first();
    await composer.click();
    const before = await countLeaves(window);
    await window.keyboard.press(SPLIT_RIGHT_SHORTCUT);
    // Give a wrongly-dispatched split a moment to land before asserting.
    await window.waitForTimeout(250);
    expect(await countLeaves(window)).toBe(before);

    // Same shortcut from a non-editable target splits the active group.
    await window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`).click();
    await window.keyboard.press(SPLIT_RIGHT_SHORTCUT);
    await expect.poll(() => countLeaves(window)).toBe(before + 1);

    await window.screenshot({
      path: testInfo.outputPath('panel-commands-shortcuts.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
