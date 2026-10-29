// Phase 4 grid operations — splitting groups through the chrome split menu
// (`panel-group-menu-${groupId}` -> `panel-group-split-${groupId}-${direction}`), plus one API-driven
// split for parity. Contract (splitGroup in panelLayoutStore, instance-model
// rework): panels are per-entity units, so a split no longer clones the
// active tab —
//
//   - a split creates a NEW, EMPTY group next to the reference group (the
//     add-tab affordance is how content arrives),
//   - the new group becomes the active (focused) group,
//   - the grid tree grows a nested branch whose orientation is orthogonal to
//     the parent branch (engine invariant), and
//   - exactly one group carries `data-active="true"` at all times.

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

/** The single-active-group DOM invariant (doc 04). */
async function expectOneActiveGroup(window, groupId) {
  const active = window.locator('.canopy-panel-group[data-active="true"]');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute('data-group-id', groupId);
}

/** A split-created group: empty tab strip, no active panel, add affordance. */
async function expectEmptySplitGroup(window, leaf) {
  expect(leaf.type).toBe('leaf');
  expect(leaf.panels).toHaveLength(0);
  expect(leaf.activePanelId).toBeNull();
  await expect(
    window.getByTestId(`panel-add-panel-${leaf.groupId}`),
  ).toBeVisible();
  await expect(
    window.getByTestId(`panel-empty-group-${leaf.groupId}`),
  ).toBeVisible();
}

test('split menu splits right then down, focusing a new empty group each time', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    expect(await countLeaves(window)).toBe(3);

    // --- UI split right on the chat group ---------------------------------
    await window.getByTestId('panel-group-menu-group-chat').click();
    await window.getByTestId('panel-group-split-group-chat-right').click();

    await expect.poll(() => countLeaves(window)).toBe(4);

    // Tree shape: root horizontal [ vertical [ horizontal [chat, NEW],
    // terminal ], activity ] — the chat leaf became an orthogonal branch.
    let layout = await getLayout(window);
    const column = layout.root.children[0];
    expect(column.type).toBe('branch');
    expect(column.orientation).toBe('vertical');
    const chatRow = column.children[0];
    expect(chatRow.type).toBe('branch');
    expect(chatRow.orientation).toBe('horizontal');
    expect(chatRow.children).toHaveLength(2);
    expect(chatRow.children[0]).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.chat,
    });

    const rightGroup = chatRow.children[1];
    expect(rightGroup.groupId).not.toBe(DEFAULT_GROUP_IDS.chat);
    await expectEmptySplitGroup(window, rightGroup);

    // The new group is focused, in the store and in the DOM.
    expect(await getActiveGroupId(window)).toBe(rightGroup.groupId);
    await expect(
      window.getByTestId(`panel-group-${rightGroup.groupId}`),
    ).toBeVisible();
    await expectOneActiveGroup(window, rightGroup.groupId);

    // --- UI split down on the chat group (orientation flips again) --------
    await window.getByTestId('panel-group-menu-group-chat').click();
    await window.getByTestId('panel-group-split-group-chat-down').click();

    await expect.poll(() => countLeaves(window)).toBe(5);

    layout = await getLayout(window);
    const chatCell = layout.root.children[0].children[0].children[0];
    expect(chatCell.type).toBe('branch');
    expect(chatCell.orientation).toBe('vertical');
    expect(chatCell.children[0]).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.chat,
    });
    const downGroup = chatCell.children[1];
    await expectEmptySplitGroup(window, downGroup);
    expect(await getActiveGroupId(window)).toBe(downGroup.groupId);
    await expectOneActiveGroup(window, downGroup.groupId);

    // --- API parity: splitPanel through __canopyPanelTestApi ---------------
    const apiGroupId = await splitViaApi(
      window,
      DEFAULT_GROUP_IDS.activity,
      'down',
    );
    expect(apiGroupId).toBeTruthy();
    await expect.poll(() => countLeaves(window)).toBe(6);
    expect(await getActiveGroupId(window)).toBe(apiGroupId);
    await expect(window.getByTestId(`panel-group-${apiGroupId}`)).toBeVisible();
    await expectOneActiveGroup(window, apiGroupId);

    // Content units are never duplicated by splits: the original three
    // panels are still the only tabs; the three new groups are empty.
    const leaves = collectLeaves((await getLayout(window)).root);
    expect(
      leaves.flatMap((leaf) => leaf.panels.map((panel) => panel.kind)).sort(),
    ).toEqual(['activity-section', 'chat', 'terminal']);
    expect(leaves.filter((leaf) => leaf.panels.length === 0)).toHaveLength(3);

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-split.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
