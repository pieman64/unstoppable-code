// Phase 6 grid arrangement — the deterministic IMPERATIVE twin of
// worktree-panels-dragdrop.spec.mjs: the same end-states produced through
// `__canopyPanelTestApi.movePanel` + `splitPanel` (which dispatch through the
// same panelLayoutStore actions the DnD drop handlers call), asserted on the
// serialized grid tree. No DOM drag events anywhere.
//
// Tab reordering has no test-API surface (`reorderTab` is a UI-drop-only
// intent), so the reorder end-state is covered exclusively by the synthetic
// DnD spec.
//
// Stages:
//   1. movePanel(panel-terminal, group-chat, 'center') — dock as tab; the
//      emptied terminal group closes and its parent branch collapses.
//   2. movePanel(panel-activity, group-chat, 'left') — edge split: a new
//      group appears left of chat, the emptied activity group closes.
//   3. splitPanel (now an EMPTY group — per-entity panels are never cloned)
//      + a movePanel center round-trip that restores the stage-2 topology.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getActiveGroupId,
  getLayout,
  movePanelViaApi,
  seedPanelWorktree,
  splitViaApi,
} from './panelHarness.mjs';

test('imperative movePanel and splitPanel produce the drag-and-drop end-states', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Default tree: horizontal [ vertical [chat, terminal], activity ].
    expect(collectLeaves((await getLayout(window)).root)).toHaveLength(3);

    // --- Stage 1: center merge ---------------------------------------------
    await movePanelViaApi(
      window,
      DEFAULT_PANEL_IDS.terminal,
      DEFAULT_GROUP_IDS.chat,
      'center',
    );

    // The single-child vertical branch collapses: horizontal [chat, activity].
    let layout = await getLayout(window);
    expect(layout.root.type).toBe('branch');
    expect(layout.root.orientation).toBe('horizontal');
    expect(layout.root.children).toHaveLength(2);
    expect(layout.root.children[0]).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.chat,
      activePanelId: DEFAULT_PANEL_IDS.terminal,
      panels: [
        { panelId: DEFAULT_PANEL_IDS.chat, kind: 'chat' },
        { panelId: DEFAULT_PANEL_IDS.terminal, kind: 'terminal' },
      ],
    });
    expect(layout.root.children[1]).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.activity,
    });
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    // DOM parity: the terminal tab renders in the chat group's strip.
    await expect(
      window
        .getByTestId(`panel-group-${DEFAULT_GROUP_IDS.chat}`)
        .getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.terminal}`),
    ).toBeVisible();

    // --- Stage 2: edge split (left of chat) --------------------------------
    await movePanelViaApi(
      window,
      DEFAULT_PANEL_IDS.activity,
      DEFAULT_GROUP_IDS.chat,
      'left',
    );

    // Same-orientation insert into the root row, then the emptied activity
    // group closes: horizontal [ NEW(activity), chat ].
    layout = await getLayout(window);
    expect(layout.root.type).toBe('branch');
    expect(layout.root.orientation).toBe('horizontal');
    expect(layout.root.children).toHaveLength(2);

    const [newGroupLeaf, chatLeaf] = layout.root.children;
    expect(newGroupLeaf.type).toBe('leaf');
    expect(newGroupLeaf.groupId).not.toBe(DEFAULT_GROUP_IDS.activity);
    expect(newGroupLeaf.panels).toEqual([
      { panelId: DEFAULT_PANEL_IDS.activity, kind: 'activity-section' },
    ]);
    expect(newGroupLeaf.activePanelId).toBe(DEFAULT_PANEL_IDS.activity);
    expect(chatLeaf).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.chat,
    });
    // The moved-into group is focused (matches the DnD drop behavior).
    expect(await getActiveGroupId(window)).toBe(newGroupLeaf.groupId);
    await expect(
      window.getByTestId(`panel-group-${newGroupLeaf.groupId}`),
    ).toBeVisible();

    // --- Stage 3: empty split + move round-trip -----------------------------
    // Splits no longer clone (panels are per-entity units): the new group is
    // EMPTY; moving a real panel into it and back restores the topology.
    const splitGroupId = await splitViaApi(
      window,
      DEFAULT_GROUP_IDS.chat,
      'down',
    );
    expect(splitGroupId).toBeTruthy();

    layout = await getLayout(window);
    expect(collectLeaves(layout.root)).toHaveLength(3);
    const splitLeaf = collectLeaves(layout.root).find(
      (leaf) => leaf.groupId === splitGroupId,
    );
    expect(splitLeaf.panels).toHaveLength(0);
    expect(splitLeaf.activePanelId).toBeNull();

    // Move the real terminal panel into the empty split group...
    await movePanelViaApi(
      window,
      DEFAULT_PANEL_IDS.terminal,
      splitGroupId,
      'center',
    );
    layout = await getLayout(window);
    expect(
      collectLeaves(layout.root).find((leaf) => leaf.groupId === splitGroupId),
    ).toMatchObject({
      panels: [{ panelId: DEFAULT_PANEL_IDS.terminal, kind: 'terminal' }],
      activePanelId: DEFAULT_PANEL_IDS.terminal,
    });

    // ...and back: the emptied split group auto-closes and the stage-2
    // topology returns with the terminal re-docked as the second tab.
    await movePanelViaApi(
      window,
      DEFAULT_PANEL_IDS.terminal,
      DEFAULT_GROUP_IDS.chat,
      'center',
    );
    layout = await getLayout(window);
    expect(layout.root.orientation).toBe('horizontal');
    expect(layout.root.children).toHaveLength(2);
    expect(collectLeaves(layout.root).map((leaf) => leaf.groupId)).toEqual([
      newGroupLeaf.groupId,
      DEFAULT_GROUP_IDS.chat,
    ]);
    expect(layout.root.children[1]).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.chat,
      activePanelId: DEFAULT_PANEL_IDS.terminal,
      panels: [
        { panelId: DEFAULT_PANEL_IDS.chat, kind: 'chat' },
        { panelId: DEFAULT_PANEL_IDS.terminal, kind: 'terminal' },
      ],
    });
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-arrange.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
