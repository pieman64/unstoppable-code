// Phase 3 panel cutover — the worktree content area is a VS Code-style panel
// grid (WorktreePart -> PanelGridHost). This spec pins the default layout
// contract that every other panel-grid spec builds on:
//
//   1. Selecting a worktree renders `worktree-part` -> `panel-grid-root` with
//      the three default groups (stable ids `group-chat`, `group-terminal`,
//      `group-activity`) and the right `panel-content-<kind>` frame in each.
//   2. `window.__canopyPanelTestApi.getSerializedLayout()` reports the
//      expected default tree: horizontal [ vertical [chat, terminal],
//      activity ] — 3 leaves, kinds chat/terminal/activity-section — with
//      `group-chat` active, `group-terminal` collapsed to the bottom, and
//      (CAN-2836) `group-activity` collapsed to the right so a new chat
//      opens without the right sidebar of empty sections
//      (default-layout.ts refocuses chat after the terminal split/collapse).
//   3. Navigating away and back preserves the layout object exactly
//      (MainPage stays mounted with `className="hidden"` — the remount guard
//      — and layouts are keyed per worktree in the panel layout store).
//
// Grid *operations* (split/move/close/maximize) get their own specs in
// Phase 4; this spec only covers the default arrangement + persistence
// across navigation.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  countLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getActiveGroupId,
  getLayout,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
} from './panelHarness.mjs';

test('default worktree panel layout renders three groups and serializes the expected tree', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // --- DOM: grid root + the three default groups -----------------------
    await expect(window.getByTestId('worktree-part')).toBeVisible();
    const gridRoot = window.getByTestId('panel-grid-root');
    await expect(gridRoot).toBeVisible();
    await expect(gridRoot).toHaveAttribute('data-window', 'main');

    const chatGroup = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.chat}`,
    );
    const terminalGroup = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.terminal}`,
    );
    const activityGroup = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.activity}`,
    );
    await expect(chatGroup).toBeVisible();
    await expect(terminalGroup).toBeVisible();
    await expect(activityGroup).toBeVisible();

    // Each group hosts exactly its kind's content frame.
    await expect(chatGroup.getByTestId('panel-content-chat')).toBeVisible();
    await expect(
      terminalGroup.getByTestId('panel-content-terminal'),
    ).toHaveCount(1);
    await expect(terminalGroup.getByTestId('terminal-surface')).toBeHidden();
    await expect(
      terminalGroup.getByTestId(
        `panel-collapsed-bar-${DEFAULT_GROUP_IDS.terminal}`,
      ),
    ).toBeVisible();
    await expect(
      terminalGroup.getByTestId(
        `panel-collapsed-bar-${DEFAULT_GROUP_IDS.terminal}`,
      ),
    ).toHaveAttribute('data-edge', 'bottom');
    // CAN-2836: the activity rail seeds COLLAPSED — its content frame stays
    // mounted (hidden) behind a right-edge collapsed bar, so the rail is
    // hidden but reopenable rather than removed from the layout.
    await expect(
      activityGroup.getByTestId('panel-content-activity-section'),
    ).toBeHidden();
    const activityCollapsedBar = activityGroup.getByTestId(
      `panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`,
    );
    await expect(activityCollapsedBar).toBeVisible();
    await expect(activityCollapsedBar).toHaveAttribute('data-edge', 'right');

    // The chat group is the default active group (data attr mirrors the
    // store's activeGroupId).
    await expect(chatGroup).toHaveAttribute('data-active', 'true');
    await expect(terminalGroup).toHaveAttribute('data-active', 'false');
    await expect(activityGroup).toHaveAttribute('data-active', 'false');

    // --- Serialized tree via the panel test API --------------------------
    expect(await countLeaves(window)).toBe(3);
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    const layout = await getLayout(window);
    expect(layout).not.toBeNull();
    expect(layout.activeGroupId).toBe(DEFAULT_GROUP_IDS.chat);

    // Root: horizontal branch [ vertical [chat, terminal], activity ].
    expect(layout.root.type).toBe('branch');
    expect(layout.root.orientation).toBe('horizontal');
    expect(layout.root.children).toHaveLength(2);

    const [chatColumn, activityLeaf] = layout.root.children;
    expect(chatColumn.type).toBe('branch');
    expect(chatColumn.orientation).toBe('vertical');
    expect(chatColumn.children).toHaveLength(2);

    const [chatLeaf, terminalLeaf] = chatColumn.children;
    expect(chatLeaf).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.chat,
      activePanelId: DEFAULT_PANEL_IDS.chat,
      // The chat panel is INSTANCE-BOUND to the seeded chat tab (per-tab
      // panels): derived panel id + chatTabId binding.
      panels: [
        {
          panelId: DEFAULT_PANEL_IDS.chat,
          kind: 'chat',
          instance: { chatTabId: SEEDED_CHAT_TAB_ID },
        },
      ],
      maximized: false,
    });
    expect(terminalLeaf).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.terminal,
      activePanelId: DEFAULT_PANEL_IDS.terminal,
      panels: [{ panelId: DEFAULT_PANEL_IDS.terminal, kind: 'terminal' }],
      maximized: false,
      collapsed: 'bottom',
    });
    expect(activityLeaf).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.activity,
      activePanelId: DEFAULT_PANEL_IDS.activity,
      panels: [
        { panelId: DEFAULT_PANEL_IDS.activity, kind: 'activity-section' },
      ],
      maximized: false,
      // CAN-2836: collapsed, but still a leaf carrying its activity panel —
      // hidden by default WITHOUT being dropped from the seeded layout.
      collapsed: 'right',
    });

    // Leaf kinds in document order — the canonical 3-leaf assertion.
    expect(
      collectLeaves(layout.root).map((leaf) => leaf.panels[0].kind),
    ).toEqual(['chat', 'terminal', 'activity-section']);

    // --- Reopening the collapsed rail ------------------------------------
    // The "collapsed but reopenable" half of the CAN-2836 contract: the
    // collapsed bar's expand affordance restores a real, usable panel body.
    await activityGroup
      .getByTestId(`panel-group-expand-${DEFAULT_GROUP_IDS.activity}`)
      .click();
    await expect(
      activityGroup.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    // Regression guard: each content frame FILLS its group body (the
    // `.canopy-panel-content` wrapper must stretch its flex-1 frame — a
    // collapsed frame previously left the terminal xterm pane at 0px).
    // Measured with the rail reopened, since a collapsed group has no body.
    for (const [groupId, kind] of [
      [DEFAULT_GROUP_IDS.chat, 'chat'],
      [DEFAULT_GROUP_IDS.activity, 'activity-section'],
    ]) {
      const bodyBox = await window
        .getByTestId(`panel-group-body-${groupId}`)
        .boundingBox();
      const frameBox = await window
        .getByTestId(`panel-content-${kind}`)
        .boundingBox();
      expect(bodyBox, `${groupId} body box`).not.toBeNull();
      expect(frameBox, `${kind} frame box`).not.toBeNull();
      expect(frameBox.height).toBeGreaterThanOrEqual(bodyBox.height - 2);
      expect(frameBox.height).toBeGreaterThan(100);
    }

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-default-layout.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('panel layout survives navigating away and back (always-mounted remount guard)', async () => {
  const { electronApp, userDataDir, window, app } = await seedPanelWorktree();

  try {
    const before = await getLayout(window);
    expect(before).not.toBeNull();
    expect(collectLeaves(before.root)).toHaveLength(3);

    // Leave the main page entirely (MainPage stays mounted but hidden), then
    // come back. The grid must not have been rebuilt: the serialized layout —
    // tree shape, group/panel ids, sizes, and active group — is identical.
    await app.openPipelinesPage();
    // Return through the visible worktree row instead of the global shortcut.
    // The persistent Pipeline Assistant composer can reclaim focus after blur,
    // causing the editable-target guard to intentionally ignore Cmd/Ctrl+2.
    await app.selectWorktree('demo-main', {
      expandDefaultActivityRail: false,
    });
    await app.expectMainPage();

    await expect(window.getByTestId('panel-grid-root')).toBeVisible();
    // Poll: returning re-fires the host ResizeObserver; wait until the
    // relayout (a no-op at the same viewport) has settled back to `before`.
    await expect
      .poll(() => getLayout(window), { timeout: 10_000 })
      .toEqual(before);

    // Returning to the worktree reattaches the grid and delivers a fresh
    // ResizeObserver measurement. Assert the real content frames receive
    // usable initial geometry rather than remaining at a zero-size attach.
    // Only chat is measured: the activity rail seeds collapsed (CAN-2836),
    // so its frame is intentionally hidden behind the collapsed bar here.
    for (const kind of ['chat']) {
      const frame = window.getByTestId(`panel-content-${kind}`);
      await expect(frame).toBeVisible();
      await expect
        .poll(async () => {
          const box = await frame.boundingBox();
          return Boolean(box && box.width > 100 && box.height > 100);
        })
        .toBe(true);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-2836 — the new collapsed-by-default rail is a DEFAULT, not a policy:
// once the user opens the rail themselves, nothing re-collapses it.
test('a rail the user opens stays open across navigation', async () => {
  const { electronApp, userDataDir, window, app } = await seedPanelWorktree();

  try {
    const activityGroup = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.activity}`,
    );
    // Seeded collapsed…
    await expect(
      activityGroup.getByTestId(
        `panel-collapsed-bar-${DEFAULT_GROUP_IDS.activity}`,
      ),
    ).toBeVisible();

    // …then opened by the user.
    await activityGroup
      .getByTestId(`panel-group-expand-${DEFAULT_GROUP_IDS.activity}`)
      .click();
    await expect(
      activityGroup.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    await app.openPipelinesPage();
    await app.selectWorktree('demo-main', {
      expandDefaultActivityRail: false,
    });
    await app.expectMainPage();

    // The user's choice survives: re-entering the worktree must not re-apply
    // the collapsed default over it.
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();
    await expect(
      activityGroup.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const layout = await getLayout(window);
        return (
          collectLeaves(layout?.root).find(
            (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
          )?.collapsed ?? null
        );
      })
      .toBeNull();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
