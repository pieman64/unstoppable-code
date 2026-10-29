// Early access keeps chats in the main chat group: a chat cannot be moved
// into the bottom drawer or split out of its group, and dragging a chat tab
// offers no drop the move would refuse (no root-edge strips, no edge
// highlight on its own group). With early access off, the same moves and
// drop affordances work as before.
//
// Run after building the implementation:
//   pnpm run test:electron:built early-access-chat-group.spec.mjs --reporter=line
//
// Determinism: the worktree and its chat are seeded on disk with no messages;
// no provider or network request runs.

import { expect, test } from '@playwright/test';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getLayout,
  movePanelViaApi,
  seedPanelWorktree,
} from './panelHarness.mjs';

async function chatGroupOf(window) {
  const layout = await getLayout(window);
  if (!layout) return null;
  const leaf = collectLeaves(layout.root).find((candidate) =>
    candidate.panels.some((panel) => panel.panelId === DEFAULT_PANEL_IDS.chat),
  );
  return leaf?.groupId ?? null;
}

async function leafCount(window) {
  const layout = await getLayout(window);
  return layout ? collectLeaves(layout.root).length : 0;
}

for (const earlyAccess of [true, false]) {
  test(`chat moves out of the chat group ${earlyAccess ? 'are refused with' : 'work without'} early access`, async () => {
    const launched = await seedPanelWorktree({
      onBeforeLaunch: ({ userDataDir }) => {
        if (earlyAccess) {
          seedEarlyAccess({ userDataDir });
        }
      },
    });
    const { electronApp, userDataDir, window } = launched;
    try {
      await expect.poll(() => chatGroupOf(window)).toBe(DEFAULT_GROUP_IDS.chat);
      const leavesBefore = await leafCount(window);

      // Splitting the chat to the right of its own group.
      await movePanelViaApi(
        window,
        DEFAULT_PANEL_IDS.chat,
        DEFAULT_GROUP_IDS.chat,
        'right',
      );
      if (earlyAccess) {
        // Give a (wrong) move time to land before asserting it did not.
        await window.waitForTimeout(300);
        expect(await chatGroupOf(window)).toBe(DEFAULT_GROUP_IDS.chat);
        expect(await leafCount(window)).toBe(leavesBefore);
      } else {
        await expect
          .poll(() => chatGroupOf(window))
          .not.toBe(DEFAULT_GROUP_IDS.chat);
      }

      // Docking the chat into the bottom drawer.
      await movePanelViaApi(
        window,
        DEFAULT_PANEL_IDS.chat,
        DEFAULT_GROUP_IDS.terminal,
        'center',
      );
      if (earlyAccess) {
        await window.waitForTimeout(300);
        expect(await chatGroupOf(window)).toBe(DEFAULT_GROUP_IDS.chat);
      } else {
        await expect
          .poll(() => chatGroupOf(window))
          .toBe(DEFAULT_GROUP_IDS.terminal);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

/** Dispatches a drag event to whatever element is topmost at (x, y). */
async function dispatchDragAtPoint(window, type, dataTransfer, x, y) {
  await window.evaluate(
    ([eventType, dt, px, py]) => {
      const target = document.elementFromPoint(px, py);
      if (!target) throw new Error(`no element at (${px}, ${py})`);
      const event = new DragEvent(eventType, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: px,
        clientY: py,
      });
      Object.defineProperty(event, 'dataTransfer', { value: dt });
      target.dispatchEvent(event);
    },
    [type, dataTransfer, x, y],
  );
}

for (const earlyAccess of [true, false]) {
  test(`dragging a chat tab ${earlyAccess ? 'offers no refused drops with' : 'offers every drop without'} early access`, async () => {
    const launched = await seedPanelWorktree({
      onBeforeLaunch: ({ userDataDir }) => {
        if (earlyAccess) {
          seedEarlyAccess({ userDataDir });
        }
      },
    });
    const { electronApp, userDataDir, window } = launched;
    try {
      await expect.poll(() => chatGroupOf(window)).toBe(DEFAULT_GROUP_IDS.chat);
      const body = await window
        .getByTestId(`panel-group-body-${DEFAULT_GROUP_IDS.chat}`)
        .boundingBox();
      expect(body).not.toBeNull();
      const dataTransfer = await window.evaluateHandle(
        () => new DataTransfer(),
      );
      await window.dispatchEvent(
        `[data-testid="panel-tab-${DEFAULT_PANEL_IDS.chat}"]`,
        'dragstart',
        { dataTransfer },
      );
      const center = {
        x: body.x + body.width / 2,
        y: body.y + body.height / 2,
      };
      const rightEdge = { x: body.x + body.width - 4, y: center.y };
      await dispatchDragAtPoint(
        window,
        'dragenter',
        dataTransfer,
        center.x,
        center.y,
      );

      const rootStrips = window.locator(
        '[data-testid^="panel-drop-zone-root-"]',
      );
      const overlay = window.getByTestId(
        `panel-drop-overlay-${DEFAULT_GROUP_IDS.chat}`,
      );
      if (earlyAccess) {
        await expect(rootStrips).toHaveCount(0);
      } else {
        await expect.poll(() => rootStrips.count()).toBeGreaterThan(0);
      }

      // The group's own center (docking back in place) is always offered.
      await dispatchDragAtPoint(
        window,
        'dragover',
        dataTransfer,
        center.x,
        center.y,
      );
      await expect(overlay).toHaveAttribute('data-direction', 'center');

      // Its right edge would split the chat out of the chat group.
      await dispatchDragAtPoint(
        window,
        'dragover',
        dataTransfer,
        rightEdge.x,
        rightEdge.y,
      );
      if (earlyAccess) {
        await expect(overlay).not.toHaveAttribute('data-direction', /.+/);
      } else {
        await expect(overlay).toHaveAttribute('data-direction', 'right');
      }

      await window.dispatchEvent(
        `[data-testid="panel-tab-${DEFAULT_PANEL_IDS.chat}"]`,
        'dragend',
        { dataTransfer },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
