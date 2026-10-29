// Phase 6 drag-and-drop — rearranging panels by dragging tabs, driven with
// SYNTHETIC DragEvents (native HTML5 DnD is not drivable by Playwright's
// input primitives; see docs/planning/2026-06-27-vs-code-panels/07 §C5).
// Every stage dispatches the real event sequence the wiring listens for —
// dragstart on a tab, dragenter/dragover on a target (group body at an
// edge/center position, or a tab-strip tab), drop, dragend — through the
// same React handlers + DragAndDropObserver used by real pointer drags. The
// in-process drag identity travels through the LocalSelectionTransfer
// singleton, seeded by the dispatched dragstart.
//
// The imperative twin (worktree-panels-arrange.spec.mjs) produces the same
// end-states through __canopyPanelTestApi without any DOM drag.
//
// Coverage:
//   1. Center merge — drag the terminal tab onto the chat group body center:
//      overlay shows data-direction="center", drop docks the tab, the
//      emptied terminal group closes.
//   2. Edge split — drag the activity tab onto the chat group body's LEFT
//      edge strip: overlay shows data-direction="left", drop creates a new
//      group left of chat and closes the emptied activity group.
//   3. Tab reorder — drag the terminal tab onto the left half of the chat
//      tab in the same strip: insertion indicator renders, drop reorders the
//      group's tabs (store reorderTab; no topology change).
//   4. Root-edge drop (separate test) — drag the terminal tab onto the RIGHT
//      root-edge strip: a new FULL-HEIGHT group is created as a direct child
//      of the grid root (the arrangement a group-body edge drop cannot
//      produce when that side is vertically split).
//   5. Real-pointer-shaped root-edge drop (separate test) — same move, but
//      every dragenter/dragover/drop is dispatched to
//      `document.elementFromPoint(x, y)` (the DEEPEST element a real pointer
//      targets) instead of directly to the strip, plus the no-op affordance
//      guard: dragging the ACTIVITY tab (already the rightmost sole-tab
//      root-level group) renders NO right strip and NO full-edge highlight,
//      so the UI never advertises a drop the store would refuse.

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { closeCanopy } from './launchCanopy.mjs';
import { seedInnerPanelLayout } from './seeders/seedInnerPanelLayout.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  expandDefaultActivityRail,
  getActiveGroupId,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

/** Starts a synthetic tab drag; returns the DataTransfer handle to thread
 * through the rest of the sequence. */
async function beginTabDrag(window, panelId) {
  const dataTransfer = await window.evaluateHandle(() => new DataTransfer());
  await window.dispatchEvent(
    `[data-testid="panel-tab-${panelId}"]`,
    'dragstart',
    { dataTransfer },
  );
  return dataTransfer;
}

/**
 * The default terminal group starts collapsed; expand it before tab DnD.
 *
 * Expanding is a reveal gesture, so this also AUTO-STARTS the terminal. Two
 * consequences for callers:
 *
 * 1. The panel becomes BOUND, so assertions on its shape must use
 *    `toMatchObject` — a structural `toEqual` fails on `instance.terminalId`.
 * 2. The spawn finishes asynchronously and ends in
 *    `ensureTerminalPanelVisible(..., { focus: true })`, which un-maximizes,
 *    selects, and FOCUSES the terminal group. A late `focusGroup` would
 *    otherwise land in the middle of a later stage and flip `activeGroupId`
 *    out from under an assertion. Waiting for the pane here drains that.
 */
async function expandDefaultTerminalDrawer(window) {
  const expand = window.getByTestId(
    `panel-group-expand-${DEFAULT_GROUP_IDS.terminal}`,
  );
  if ((await expand.count()) > 0 && (await expand.isVisible())) {
    await expand.click();
  }
  await expect(
    window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.terminal}`),
  ).toBeVisible();
  await expect(window.getByTestId('terminal-pane')).toBeVisible({
    timeout: 30_000,
  });
}

/** Drags over `selector` at viewport coordinates (dragenter + dragover). */
async function dragOverAt(window, selector, dataTransfer, clientX, clientY) {
  await window.dispatchEvent(selector, 'dragenter', {
    dataTransfer,
    clientX,
    clientY,
  });
  await window.dispatchEvent(selector, 'dragover', {
    dataTransfer,
    clientX,
    clientY,
  });
}

/** Drops on `selector` and fires dragend on the source tab. */
async function dropAt(
  window,
  selector,
  dataTransfer,
  clientX,
  clientY,
  sourcePanelId,
) {
  await window.dispatchEvent(selector, 'drop', {
    dataTransfer,
    clientX,
    clientY,
  });
  await window.dispatchEvent(
    `[data-testid="panel-tab-${sourcePanelId}"]`,
    'dragend',
    { dataTransfer },
  );
}

/**
 * Dispatches a drag event to whatever element is topmost at (x, y) — the
 * element a REAL pointer targets (native hit-testing dispatches to the
 * deepest element under the cursor, never to whichever node a test picked).
 * Returns the resolved target's test id (or class list) for diagnostics.
 */
async function dispatchDragAtPoint(window, type, dataTransfer, x, y) {
  return window.evaluate(
    ([eventType, dt, px, py]) => {
      const target = document.elementFromPoint(px, py);
      if (!target) {
        throw new Error(`no element at (${px}, ${py})`);
      }
      const event = new DragEvent(eventType, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: px,
        clientY: py,
      });
      Object.defineProperty(event, 'dataTransfer', { value: dt });
      target.dispatchEvent(event);
      return target.getAttribute('data-testid') ?? String(target.className);
    },
    [type, dataTransfer, x, y],
  );
}

/** Viewport point inside a group body: fractions of its bounding box. */
async function bodyPoint(window, groupId, fractionX, fractionY) {
  const box = await window
    .getByTestId(`panel-group-body-${groupId}`)
    .boundingBox();
  expect(box, `${groupId} body box`).not.toBeNull();
  return {
    x: box.x + box.width * fractionX,
    y: box.y + box.height * fractionY,
  };
}

test('dragging tabs merges into a group center, splits at an edge, and reorders within a strip', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const chatBodySelector = `[data-testid="panel-group-body-${DEFAULT_GROUP_IDS.chat}"]`;
    const overlay = window.getByTestId(
      `panel-drop-overlay-${DEFAULT_GROUP_IDS.chat}`,
    );

    // --- Stage 1: center merge (terminal tab -> chat body center) ----------
    await expandDefaultTerminalDrawer(window);
    let dataTransfer = await beginTabDrag(window, DEFAULT_PANEL_IDS.terminal);
    let point = await bodyPoint(window, DEFAULT_GROUP_IDS.chat, 0.5, 0.5);
    await dragOverAt(window, chatBodySelector, dataTransfer, point.x, point.y);

    // Overlay feedback: visible, classified center, zones addressable.
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute('data-direction', 'center');
    await expect(
      window.getByTestId(`panel-drop-zone-${DEFAULT_GROUP_IDS.chat}-center`),
    ).toBeAttached();

    await dropAt(
      window,
      chatBodySelector,
      dataTransfer,
      point.x,
      point.y,
      DEFAULT_PANEL_IDS.terminal,
    );

    // Overlay cleared; terminal group merged away.
    await expect(overlay).toHaveCount(0);
    await expect
      .poll(async () =>
        collectLeaves((await getLayout(window)).root).map(
          (leaf) => leaf.groupId,
        ),
      )
      .toEqual([DEFAULT_GROUP_IDS.chat, DEFAULT_GROUP_IDS.activity]);

    let layout = await getLayout(window);
    const chatLeaf = collectLeaves(layout.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    expect(chatLeaf.panels).toMatchObject([
      { panelId: DEFAULT_PANEL_IDS.chat, kind: 'chat' },
      { panelId: DEFAULT_PANEL_IDS.terminal, kind: 'terminal' },
    ]);
    expect(chatLeaf.activePanelId).toBe(DEFAULT_PANEL_IDS.terminal);
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    // DOM: the terminal tab now renders in the chat group's strip.
    await expect(
      window
        .getByTestId(`panel-group-${DEFAULT_GROUP_IDS.chat}`)
        .getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.terminal}`),
    ).toBeVisible();

    // --- Stage 2: edge split (activity tab -> chat body left edge) ---------
    // The rail seeds collapsed (CAN-2836) and a collapsed group renders no
    // tab strip, so open it to get the drag source back.
    await expandDefaultActivityRail(window);
    dataTransfer = await beginTabDrag(window, DEFAULT_PANEL_IDS.activity);
    point = await bodyPoint(window, DEFAULT_GROUP_IDS.chat, 0.05, 0.5);
    await dragOverAt(window, chatBodySelector, dataTransfer, point.x, point.y);
    await expect(overlay).toHaveAttribute('data-direction', 'left');

    await dropAt(
      window,
      chatBodySelector,
      dataTransfer,
      point.x,
      point.y,
      DEFAULT_PANEL_IDS.activity,
    );

    // Emptied activity group closed; a NEW group holds the activity panel
    // and sits before (left of) the chat group in document order.
    await expect
      .poll(async () => {
        const leaves = collectLeaves((await getLayout(window)).root);
        return leaves.some(
          (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
        );
      })
      .toBe(false);

    layout = await getLayout(window);
    const leaves = collectLeaves(layout.root);
    expect(leaves).toHaveLength(2);
    const [newGroupLeaf, mergedChatLeaf] = leaves;
    expect(newGroupLeaf.panels).toEqual([
      { panelId: DEFAULT_PANEL_IDS.activity, kind: 'activity-section' },
    ]);
    expect(mergedChatLeaf.groupId).toBe(DEFAULT_GROUP_IDS.chat);
    expect(await getActiveGroupId(window)).toBe(newGroupLeaf.groupId);

    // --- Stage 3: tab reorder within the chat group's strip ----------------
    // Chat strip is [panel-chat, panel-terminal]; drop the terminal tab on
    // the LEFT HALF of the chat tab -> insertion index 0 -> final order
    // [panel-terminal, panel-chat]. Pure metadata: still 2 leaves.
    dataTransfer = await beginTabDrag(window, DEFAULT_PANEL_IDS.terminal);
    const chatTab = window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`);
    const chatTabBox = await chatTab.boundingBox();
    expect(chatTabBox).not.toBeNull();
    const stripX = chatTabBox.x + 2;
    const stripY = chatTabBox.y + chatTabBox.height / 2;
    const chatTabSelector = `[data-testid="panel-tab-${DEFAULT_PANEL_IDS.chat}"]`;

    await dragOverAt(window, chatTabSelector, dataTransfer, stripX, stripY);
    // Insertion indicator renders at the drop boundary.
    await expect(window.locator('.canopy-panel-tab-drop-before')).toHaveCount(
      1,
    );

    await dropAt(
      window,
      chatTabSelector,
      dataTransfer,
      stripX,
      stripY,
      DEFAULT_PANEL_IDS.terminal,
    );

    await expect
      .poll(async () => {
        const chat = collectLeaves((await getLayout(window)).root).find(
          (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
        );
        return chat.panels.map((panel) => panel.panelId);
      })
      .toEqual([DEFAULT_PANEL_IDS.terminal, DEFAULT_PANEL_IDS.chat]);

    // Indicator cleared; still two leaves (no topology change); the active
    // tab is unchanged by a reorder.
    await expect(window.locator('.canopy-panel-tab-drop-before')).toHaveCount(
      0,
    );
    layout = await getLayout(window);
    expect(collectLeaves(layout.root)).toHaveLength(2);
    const reorderedChatLeaf = collectLeaves(layout.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    expect(reorderedChatLeaf.activePanelId).toBe(DEFAULT_PANEL_IDS.terminal);
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-dragdrop.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('dragging a tab from another panel inserts it at the indicated tab-strip position', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const chatBodySelector = `[data-testid="panel-group-body-${DEFAULT_GROUP_IDS.chat}"]`;

    // Give the target group two tabs: [chat, terminal].
    await expandDefaultTerminalDrawer(window);
    let dataTransfer = await beginTabDrag(window, DEFAULT_PANEL_IDS.terminal);
    let point = await bodyPoint(window, DEFAULT_GROUP_IDS.chat, 0.5, 0.5);
    await dragOverAt(window, chatBodySelector, dataTransfer, point.x, point.y);
    await dropAt(
      window,
      chatBodySelector,
      dataTransfer,
      point.x,
      point.y,
      DEFAULT_PANEL_IDS.terminal,
    );

    // Drag activity from its own group to the boundary between the two target
    // tabs. The visible indicator is immediately before terminal. The rail
    // seeds collapsed (CAN-2836), so open it for its tab strip first.
    await expandDefaultActivityRail(window);
    dataTransfer = await beginTabDrag(window, DEFAULT_PANEL_IDS.activity);
    const terminalTab = window.getByTestId(
      `panel-tab-${DEFAULT_PANEL_IDS.terminal}`,
    );
    const terminalBox = await terminalTab.boundingBox();
    expect(terminalBox).not.toBeNull();
    point = {
      x: terminalBox.x + 2,
      y: terminalBox.y + terminalBox.height / 2,
    };
    const terminalSelector = `[data-testid="panel-tab-${DEFAULT_PANEL_IDS.terminal}"]`;

    await dragOverAt(window, terminalSelector, dataTransfer, point.x, point.y);
    await expect(terminalTab).toHaveClass(/canopy-panel-tab-drop-before/);

    await dropAt(
      window,
      terminalSelector,
      dataTransfer,
      point.x,
      point.y,
      DEFAULT_PANEL_IDS.activity,
    );

    await expect
      .poll(async () => {
        const chat = collectLeaves((await getLayout(window)).root).find(
          (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
        );
        return chat.panels.map((panel) => panel.panelId);
      })
      .toEqual([
        DEFAULT_PANEL_IDS.chat,
        DEFAULT_PANEL_IDS.activity,
        DEFAULT_PANEL_IDS.terminal,
      ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('dragging a tab onto the RIGHT root-edge strip creates a full-height root-level group', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Default layout: horizontal root [ vertical [chat, terminal], activity ]
    // — 2 root children. A group-body edge drop can only split a GROUP, so a
    // full-height right column is unreachable that way; the root-edge strip
    // must produce it.
    let layout = await getLayout(window);
    expect(layout.root.type).toBe('branch');
    expect(layout.root.orientation).toBe('horizontal');
    expect(layout.root.children).toHaveLength(2);

    // The root-edge strips exist only while a panel-tab drag is armed.
    await expect(window.getByTestId('panel-drop-zone-root-right')).toHaveCount(
      0,
    );

    await expandDefaultTerminalDrawer(window);
    const dataTransfer = await beginTabDrag(window, DEFAULT_PANEL_IDS.terminal);
    // Arm the host: any dragenter over the grid root while the in-process
    // panel-tab transfer is active renders the four strips.
    await window.dispatchEvent('[data-testid="panel-grid-root"]', 'dragenter', {
      dataTransfer,
    });
    const strip = window.getByTestId('panel-drop-zone-root-right');
    await expect(strip).toBeAttached();

    const stripBox = await strip.boundingBox();
    expect(stripBox, 'right root strip box').not.toBeNull();
    // Full-height hit strip inset over the grid's right edge.
    const gridBox = await window.getByTestId('panel-grid-root').boundingBox();
    expect(stripBox.height).toBeGreaterThan(gridBox.height * 0.9);
    const point = {
      x: stripBox.x + stripBox.width / 2,
      y: stripBox.y + stripBox.height / 2,
    };

    const stripSelector = '[data-testid="panel-drop-zone-root-right"]';
    await dragOverAt(window, stripSelector, dataTransfer, point.x, point.y);

    // Full-edge highlight overlay for the hovered strip.
    const rootOverlay = window.getByTestId('panel-drop-overlay-root');
    await expect(rootOverlay).toBeVisible();
    await expect(rootOverlay).toHaveAttribute('data-edge', 'right');

    await dropAt(
      window,
      stripSelector,
      dataTransfer,
      point.x,
      point.y,
      DEFAULT_PANEL_IDS.terminal,
    );

    // Root children grew 2 -> 3: the moved panel's new group is a DIRECT
    // child of the root at the right edge (full height), and the emptied
    // terminal group's removal collapsed the left column to the chat leaf.
    await expect
      .poll(async () => (await getLayout(window)).root.children.length)
      .toBe(3);

    layout = await getLayout(window);
    expect(layout.root.type).toBe('branch');
    expect(layout.root.orientation).toBe('horizontal');
    const rightColumn = layout.root.children[2];
    expect(rightColumn.type).toBe('leaf');
    // `toMatchObject`, not `toEqual`: expanding the drawer above is a reveal
    // gesture, so the terminal panel is now BOUND and carries an
    // `instance.terminalId`. The identity and arity are what this test is
    // about; the binding belongs to the auto-start specs.
    expect(rightColumn.panels).toMatchObject([
      { panelId: DEFAULT_PANEL_IDS.terminal, kind: 'terminal' },
    ]);
    expect(rightColumn.activePanelId).toBe(DEFAULT_PANEL_IDS.terminal);
    const leaves = collectLeaves(layout.root);
    expect(leaves.map((leaf) => leaf.groupId)).toEqual([
      DEFAULT_GROUP_IDS.chat,
      DEFAULT_GROUP_IDS.activity,
      rightColumn.groupId,
    ]);
    expect(await getActiveGroupId(window)).toBe(rightColumn.groupId);

    // Strips and overlay disarmed after the drop; the new group is rendered
    // full height in the DOM (spans the grid root's height).
    await expect(window.getByTestId('panel-drop-zone-root-right')).toHaveCount(
      0,
    );
    await expect(rootOverlay).toHaveCount(0);
    const newGroupBox = await window
      .getByTestId(`panel-group-${rightColumn.groupId}`)
      .boundingBox();
    expect(newGroupBox.height).toBeGreaterThan(gridBox.height * 0.9);

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-root-edge-drop.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('orthogonal root-edge drop preserves a collapsed sibling ratio across expand and restart', async () => {
  const first = await seedPanelWorktree();
  const { userDataDir } = first;
  const options = { userDataDir, seedDemoWorkspaces: false };
  let expectedActivityWidth;

  try {
    const { window } = first;
    // This test collapses the rail through its chrome and checks the restored
    // ratio, so it needs the EXPANDED width as its baseline — CAN-2836 seeds
    // the rail collapsed.
    await expandDefaultActivityRail(window);
    const activity = window.getByTestId(
      `panel-group-${DEFAULT_GROUP_IDS.activity}`,
    );
    const before = await activity.boundingBox();
    expect(before, 'activity group box before collapse').not.toBeNull();
    expectedActivityWidth = before.width;

    await window
      .getByTestId(`panel-group-collapse-${DEFAULT_GROUP_IDS.activity}`)
      .click();
    await expect(
      window.getByTestId(`panel-group-expand-${DEFAULT_GROUP_IDS.activity}`),
    ).toBeVisible();

    await expandDefaultTerminalDrawer(window);
    // Keep the source group alive after moving its terminal tab so this is
    // the pure orthogonal-wrap path under review, not a second topology
    // mutation caused by removing an emptied source group.
    await window
      .getByTestId(`panel-add-panel-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(
      window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.terminal}`),
    ).toBeVisible();
    const dataTransfer = await beginTabDrag(window, DEFAULT_PANEL_IDS.terminal);
    await window.dispatchEvent('[data-testid="panel-grid-root"]', 'dragenter', {
      dataTransfer,
    });
    const strip = window.getByTestId('panel-drop-zone-root-top');
    await expect(strip).toBeAttached();
    const stripBox = await strip.boundingBox();
    expect(stripBox, 'top root strip box').not.toBeNull();
    const point = {
      x: stripBox.x + stripBox.width / 2,
      y: stripBox.y + stripBox.height / 2,
    };
    const selector = '[data-testid="panel-drop-zone-root-top"]';
    await dragOverAt(window, selector, dataTransfer, point.x, point.y);
    await dropAt(
      window,
      selector,
      dataTransfer,
      point.x,
      point.y,
      DEFAULT_PANEL_IDS.terminal,
    );

    await window.waitForTimeout(1500);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  const persisted = JSON.parse(
    readFileSync(
      path.join(
        userDataDir,
        'workspaces',
        'demo-ts-pnpm-vite',
        'worktree-data',
        'demo-main',
        'panel-layout.json',
      ),
      'utf8',
    ),
  );
  const wrapped = persisted.grid.root.children[1];
  expect(wrapped.type).toBe('branch');
  expect(wrapped.expandedSizes).toEqual(expect.any(Array));

  const second = await seedPanelWorktree(options);
  try {
    await second.window
      .getByTestId(`panel-group-expand-${DEFAULT_GROUP_IDS.activity}`)
      .click();
    const restored = await second.window
      .getByTestId(`panel-group-${DEFAULT_GROUP_IDS.activity}`)
      .boundingBox();
    expect(restored, 'activity group box after restart').not.toBeNull();
    expect(restored.width).toBeCloseTo(expectedActivityWidth, 0);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('real-pointer-shaped root-edge drop: hit-tested dispatch works and no-op edges render no affordance', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const gridBox = await window.getByTestId('panel-grid-root').boundingBox();
    // Real drags target the deepest element under the cursor; these are the
    // hit-test points a pointer would pass through on the way to (and at)
    // the right window edge.
    const armPoint = {
      x: gridBox.x + gridBox.width / 2,
      y: gridBox.y + gridBox.height / 2,
    };
    const rightEdgePoint = {
      x: gridBox.x + gridBox.width - 12,
      y: gridBox.y + gridBox.height / 2,
    };

    // --- Stage 1: the lying-affordance guard (user-reported bug) ------------
    // The activity panel is already the rightmost sole-tab root-level group,
    // so a right root-edge drop would silently no-op in the store. The host
    // must render NO right strip and NO full-height highlight for it — the
    // other edges keep their strips (those drops are real).
    // The activity tab is this stage's drag source; CAN-2836 seeds the rail
    // collapsed, which renders an icon bar instead of that tab strip.
    await expandDefaultActivityRail(window);
    let dataTransfer = await window.evaluateHandle(() => new DataTransfer());
    await window.dispatchEvent(
      `[data-testid="panel-tab-${DEFAULT_PANEL_IDS.activity}"]`,
      'dragstart',
      { dataTransfer },
    );
    await dispatchDragAtPoint(
      window,
      'dragenter',
      dataTransfer,
      armPoint.x,
      armPoint.y,
    );
    await expect(
      window.getByTestId('panel-drop-zone-root-left'),
    ).toBeAttached();
    await expect(window.getByTestId('panel-drop-zone-root-top')).toBeAttached();
    await expect(
      window.getByTestId('panel-drop-zone-root-bottom'),
    ).toBeAttached();
    await expect(window.getByTestId('panel-drop-zone-root-right')).toHaveCount(
      0,
    );

    // Hovering the right edge shows no full-edge highlight either: the band
    // falls through to the activity group's own body zones.
    await dispatchDragAtPoint(
      window,
      'dragenter',
      dataTransfer,
      rightEdgePoint.x,
      rightEdgePoint.y,
    );
    await dispatchDragAtPoint(
      window,
      'dragover',
      dataTransfer,
      rightEdgePoint.x,
      rightEdgePoint.y,
    );
    await expect(window.getByTestId('panel-drop-overlay-root')).toHaveCount(0);

    // Abort the drag; the layout is untouched.
    await window.dispatchEvent(
      `[data-testid="panel-tab-${DEFAULT_PANEL_IDS.activity}"]`,
      'dragend',
      { dataTransfer },
    );
    let layout = await getLayout(window);
    expect(layout.root.children).toHaveLength(2);

    // --- Stage 2: hit-tested drop for a REAL move (terminal -> right) ------
    // Same move as the direct-dispatch test above, but every event goes to
    // document.elementFromPoint: whatever element is actually topmost at the
    // strip's coordinates must receive and service the drop.
    await expandDefaultTerminalDrawer(window);
    dataTransfer = await window.evaluateHandle(() => new DataTransfer());
    await window.dispatchEvent(
      `[data-testid="panel-tab-${DEFAULT_PANEL_IDS.terminal}"]`,
      'dragstart',
      { dataTransfer },
    );
    await dispatchDragAtPoint(
      window,
      'dragenter',
      dataTransfer,
      armPoint.x,
      armPoint.y,
    );
    const strip = window.getByTestId('panel-drop-zone-root-right');
    await expect(strip).toBeAttached();
    const stripBox = await strip.boundingBox();
    const stripPoint = {
      x: stripBox.x + stripBox.width / 2,
      y: stripBox.y + stripBox.height / 2,
    };

    // The strip itself must be what a real pointer hits within its band.
    const enterTarget = await dispatchDragAtPoint(
      window,
      'dragenter',
      dataTransfer,
      stripPoint.x,
      stripPoint.y,
    );
    expect(enterTarget).toBe('panel-drop-zone-root-right');
    await dispatchDragAtPoint(
      window,
      'dragover',
      dataTransfer,
      stripPoint.x,
      stripPoint.y,
    );
    const rootOverlay = window.getByTestId('panel-drop-overlay-root');
    await expect(rootOverlay).toBeVisible();
    await expect(rootOverlay).toHaveAttribute('data-edge', 'right');

    await dispatchDragAtPoint(
      window,
      'drop',
      dataTransfer,
      stripPoint.x,
      stripPoint.y,
    );
    await window.dispatchEvent(
      `[data-testid="panel-tab-${DEFAULT_PANEL_IDS.terminal}"]`,
      'dragend',
      { dataTransfer },
    );

    // The hit-tested drop produced the full-height root-level column.
    await expect
      .poll(async () => (await getLayout(window)).root.children.length)
      .toBe(3);
    layout = await getLayout(window);
    const rightColumn = layout.root.children[2];
    expect(rightColumn.type).toBe('leaf');
    // `toMatchObject`, not `toEqual`: expanding the drawer above is a reveal
    // gesture, so the terminal panel is now BOUND and carries an
    // `instance.terminalId`. The identity and arity are what this test is
    // about; the binding belongs to the auto-start specs.
    expect(rightColumn.panels).toMatchObject([
      { panelId: DEFAULT_PANEL_IDS.terminal, kind: 'terminal' },
    ]);
    expect(await getActiveGroupId(window)).toBe(rightColumn.groupId);
    await expect(window.getByTestId('panel-drop-zone-root-right')).toHaveCount(
      0,
    );
    await expect(rootOverlay).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-root-edge-real-shaped.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('dropping a tab onto a compact branch restores the selected group and docks the tab', async () => {
  const seeded = await seedPanelWorktree({
    userDataDir: seedInnerPanelLayout(),
    seedDemoWorkspaces: false,
    viewportSize: { width: 1900, height: 1050 },
  });
  const { window } = seeded;
  try {
    for (const id of ['E', 'F', 'G'])
      await window.getByTestId(`panel-group-collapse-inner-${id}`).click();
    const target = window.getByTestId('panel-branch-expand-inner-F');
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    const dataTransfer = await beginTabDrag(window, 'inner-panel-C');
    for (const type of ['dragenter', 'dragover', 'drop'])
      await dispatchDragAtPoint(
        window,
        type,
        dataTransfer,
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
    await window
      .getByTestId('panel-tab-inner-panel-C')
      .dispatchEvent('dragend', { dataTransfer });
    await expect(
      window
        .getByTestId('panel-group-inner-F')
        .getByTestId('panel-tab-inner-panel-C'),
    ).toBeVisible();
    await expect(window.getByTestId('panel-group-inner-C')).toHaveCount(0);
    const leaves = collectLeaves((await getLayout(window)).root);
    const restored = leaves.find((leaf) => leaf.groupId === 'inner-F');
    expect(restored.collapsed).toBeNull();
    expect(
      restored.panels.some((panel) => panel.panelId === 'inner-panel-C'),
    ).toBe(true);
  } finally {
    await closeCanopy(seeded.electronApp, seeded.userDataDir);
  }
});
