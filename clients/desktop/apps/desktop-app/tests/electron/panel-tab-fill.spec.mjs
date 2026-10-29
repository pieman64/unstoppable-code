// Chrome-style panel tabs (the `fill` tab style, shown with early access on;
// the classic tabs are covered by the worktree-panels specs): the unpinned
// tabs of a group all take one default width (room for a 28-character title)
// while they fit, with the add-tab button right after them. Once they do not
// fit, they split the strip equally and fill it, shrinking as more open
// instead of scrolling. Closing a tab re-shares the row at once; while the row
// is crowded the last tab stays at its end, so its close button lands under
// the pointer.
//
// Run after building the implementation:
//   pnpm run test:electron:built panel-tab-fill.spec.mjs --reporter=line
//
// Determinism: the worktree and its chats are seeded on disk with no messages;
// no provider or network request runs.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

const APP = 'ts-pnpm-vite';
const BRANCH = 'demo-main';

const longTitles = (count) =>
  Array.from(
    { length: count },
    (_value, index) => `Conversation number ${index + 1} with a long title`,
  );

async function launchWithChats(titles, { mode = 'advanced' } = {}) {
  const count = titles.length;
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-tab-fill-'));
  seedDemoWorkspaces({ userDataDir, apps: [APP] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: `demo-${APP}`,
    worktreeId: BRANCH,
    providerType: 'claude',
    // A title, or a tab definition with extra persisted fields (`pinned`,
    // `blocks`).
    tabs: titles.map((entry, index) => ({
      id: `fill-chat-${index + 1}`,
      ...(typeof entry === 'string' ? { title: entry } : entry),
    })),
    activeTabId: 'fill-chat-1',
  });
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    `demo-${APP}`,
    'worktree-data',
    BRANCH,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode }),
    'utf8',
  );
  seedEarlyAccess({ userDataDir });
  const launched = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  await expect
    .poll(
      async () => {
        const layout = await getLayout(launched.window);
        const leaf = layout
          ? collectLeaves(layout.root).find(
              (candidate) => candidate.groupId === DEFAULT_GROUP_IDS.chat,
            )
          : undefined;
        return leaf?.panels.length ?? -1;
      },
      { timeout: 20_000 },
    )
    .toBe(count);
  return { ...launched, userDataDir };
}

// Geometry of the chat group's unpinned strip and its tabs, in strip order,
// plus where the row's add-tab button sits: it follows the last tab, and once
// the tabs fill the row it reaches the far end of the tab bar.
function stripGeometry(window) {
  return window
    .getByTestId(`panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`)
    .evaluate((strip) => {
      const onVisibleLine = (tab, selector) => {
        const main = tab.querySelector('.canopy-panel-tab-main');
        const item = tab.querySelector(selector);
        if (!main || !item) return false;
        const mainRect = main.getBoundingClientRect();
        return item.getBoundingClientRect().top < mainRect.bottom;
      };
      const stripRect = strip.getBoundingClientRect();
      const tabs = Array.from(strip.querySelectorAll('[role="tab"]')).map(
        (tab) => {
          const rect = tab.getBoundingClientRect();
          return {
            testId: tab.getAttribute('data-testid'),
            left: rect.left,
            right: rect.right,
            width: rect.width,
            active: tab.getAttribute('data-active') === 'true',
            labelClipped: Array.from(
              tab.querySelectorAll('.canopy-panel-tab-title'),
            ).some((label) => label.scrollWidth > label.clientWidth + 1),
            // The tab's line wraps what does not fit onto a hidden second
            // line; these report what is on the visible one.
            labelShown: onVisibleLine(tab, '.canopy-panel-tab-title'),
            closeShown: onVisibleLine(tab, '.canopy-panel-tab-close'),
          };
        },
      );
      const bar = strip.closest('.canopy-panel-tab-bar');
      const add = bar?.querySelector('.canopy-panel-add-tab-root');
      const barRect = bar?.getBoundingClientRect();
      const addRect = add?.getBoundingClientRect();
      return {
        left: stripRect.left,
        right: stripRect.right,
        addLeft: addRect?.left ?? Number.NaN,
        addRight: addRect?.right ?? Number.NaN,
        barRight: barRect?.right ?? Number.NaN,
        // The tiles' floor the tab bar sets once 20px tiles stop fitting.
        tileFloor:
          Number.parseFloat(
            bar instanceof HTMLElement
              ? bar.style.getPropertyValue('--canopy-panel-tab-floor')
              : '',
          ) || 20,
        overflowing: strip.scrollWidth - strip.clientWidth > 1,
        tabs,
      };
    });
}

const inactive = (tabs) => tabs.filter((tab) => !tab.active);

function widthSpread(tabs) {
  const widths = tabs.map((tab) => tab.width);
  return Math.max(...widths) - Math.min(...widths);
}

test('tabs that fit take one default width, with the add button after them', async () => {
  test.setTimeout(120_000);
  // The last title is 28 characters, the length the default width holds.
  const titles = ['Fix login', 'New chat', 'Fix PR-attributed CI failure'];
  const { electronApp, userDataDir, window } = await launchWithChats(titles);
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(3);
    const geometry = await stripGeometry(window);
    expect(geometry.overflowing).toBe(false);
    expect(geometry.tabs.some((tab) => tab.labelClipped)).toBe(false);
    expect(geometry.tabs.every((tab) => tab.labelShown && tab.closeShown)).toBe(
      true,
    );
    // Short and long titles alike: every tab is the 224px default.
    expect(widthSpread(geometry.tabs)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.tabs[0].width - 224)).toBeLessThanOrEqual(1);
    const lastTab = geometry.tabs[geometry.tabs.length - 1];
    expect(geometry.addLeft - lastTab.right).toBeLessThanOrEqual(12);
    expect(geometry.barRight - geometry.addRight).toBeGreaterThan(100);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('tabs that do not fit share the row equally instead of scrolling', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(14),
  );
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(14);
    const geometry = await stripGeometry(window);
    expect(geometry.overflowing).toBe(false);
    // The inactive tabs share the row equally.
    expect(widthSpread(inactive(geometry.tabs))).toBeLessThanOrEqual(1);
    // The selected tab stops at its own 96px floor, so a few characters of
    // its title stay visible.
    const activeTab = geometry.tabs.find((tab) => tab.active);
    expect(activeTab).toBeDefined();
    expect(Math.abs((activeTab?.width ?? 0) - 96)).toBeLessThanOrEqual(1);
    expect(activeTab?.labelShown).toBe(true);
    // Inactive tabs this narrow offer no close button. They keep a truncated
    // label down to a 65px tile (the icon, the insets, and 24px of text) and
    // show only their icon below that.
    for (const tab of inactive(geometry.tabs)) {
      expect(tab.width).toBeLessThan(83);
      expect(tab.closeShown).toBe(false);
      if (Math.abs(tab.width - 65) > 0.5) {
        expect(tab.labelShown).toBe(tab.width > 65);
      }
    }
    for (const tab of geometry.tabs) {
      expect(tab.left).toBeGreaterThanOrEqual(geometry.left - 1);
      expect(tab.right).toBeLessThanOrEqual(geometry.right + 1);
    }
    const lastTab = geometry.tabs[geometry.tabs.length - 1];
    expect(geometry.addLeft - lastTab.right).toBeLessThanOrEqual(12);
    expect(geometry.barRight - geometry.addRight).toBeLessThanOrEqual(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('closing a tab re-shares the row at once, keeping the last tab under the pointer', async () => {
  test.setTimeout(120_000);
  // Enough tabs that, even after one closes, they share the row rather than
  // sit at their default width.
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(7),
  );
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(7);
    const before = await stripGeometry(window);
    expect(before.barRight - before.addRight).toBeLessThanOrEqual(1);
    const last = before.tabs[before.tabs.length - 1];
    const lastPanelId = last.testId.replace(/^panel-tab-/, '');

    await window.getByTestId(last.testId).hover();
    await window.getByTestId(`panel-tab-close-${lastPanelId}`).click();

    // No hold: the six left share the row right away, with the pointer still
    // on the strip, and the new last tab ends where the closed one did.
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(6);
    const after = await stripGeometry(window);
    expect(after.barRight - after.addRight).toBeLessThanOrEqual(1);
    const newLast = after.tabs[after.tabs.length - 1];
    expect(Math.abs(newLast.right - last.right)).toBeLessThanOrEqual(1);
    expect(inactive(after.tabs)[0].width).toBeGreaterThan(
      inactive(before.tabs)[0].width + 1,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a full row of 20 tabs disables + and refuses a new chat with a note', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(20),
  );
  const note = 'Tab limit reached (20)';
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(20);
    const add = window.getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.chat}`);
    await expect(add).toBeDisabled();

    // Cmd/Ctrl+T into the full row is refused before a chat is created.
    await window
      .getByTestId(`panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`)
      .locator('[role="tab"][data-active="true"]')
      .click();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+t' : 'Control+t',
    );
    await expect(window.getByText(note).first()).toBeVisible();
    expect((await stripGeometry(window)).tabs).toHaveLength(20);
    const layout = await getLayout(window);
    const chatLeaf = collectLeaves(layout.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    expect(chatLeaf?.panels).toHaveLength(20);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('turning early access off brings back the classic tabs and lifts the limit', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(20),
  );
  const bar = window
    .getByTestId(`panel-group-title-${DEFAULT_GROUP_IDS.chat}`)
    .locator('.canopy-panel-tab-bar');
  const add = window.getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.chat}`);
  try {
    await expect(bar).toHaveAttribute('data-tab-style', 'fill');
    await expect(add).toBeDisabled();

    // The preferences push reaches the tab bar without a reload.
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: false,
      }),
    );
    await expect(bar).toHaveAttribute('data-tab-style', 'classic');
    // Classic rows scroll, so a full row of 20 takes more tabs again.
    await expect(add).toBeEnabled();

    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: true,
      }),
    );
    await expect(bar).toHaveAttribute('data-tab-style', 'fill');
    await expect(add).toBeDisabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a narrow row shrinks every tab to fit instead of hiding any', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(20),
  );
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(20);
    // Narrow the chat row until 20px tiles no longer fit it. (The headless
    // test window does not resize, so the bar itself is narrowed; the tab
    // bar's own observer picks the change up as it would a window resize.)
    await window
      .getByTestId(`panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`)
      .evaluate((strip) => {
        const bar = strip.closest('.canopy-panel-tab-bar');
        if (bar instanceof HTMLElement) {
          bar.style.maxWidth = '420px';
        }
      });
    // The row is narrow enough that 20px tiles no longer fit...
    await expect
      .poll(async () => (await stripGeometry(window)).tileFloor)
      .toBeLessThan(20);
    // ...and every tab still sits inside the row.
    const geometry = await stripGeometry(window);
    for (const tab of geometry.tabs) {
      expect(tab.left).toBeGreaterThanOrEqual(geometry.left - 1);
      expect(tab.right).toBeLessThanOrEqual(geometry.right + 1);
    }
    expect(geometry.overflowing).toBe(false);
    expect(geometry.addRight).toBeLessThanOrEqual(geometry.barRight + 1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The minimal layout locks which group a tab lives in, but a tab can still be
// dragged along its own strip to reorder it. Driven with synthetic DragEvents
// (see worktree-panels-dragdrop.spec.mjs).
test('in the minimal layout, dragging a tab along its strip reorders it', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    ['First chat', 'Second chat', 'Third chat'],
    { mode: 'minimal' },
  );
  const chatPanelIds = async () => {
    const layout = await getLayout(window);
    const leaf = collectLeaves(layout.root).find(
      (candidate) => candidate.groupId === DEFAULT_GROUP_IDS.chat,
    );
    return leaf.panels.map((panel) => panel.panelId);
  };
  try {
    const before = await chatPanelIds();
    expect(before).toHaveLength(3);
    const groupCount = collectLeaves((await getLayout(window)).root).length;
    const [first, , third] = before;
    const thirdSelector = `[data-testid="panel-tab-${third}"]`;
    const firstSelector = `[data-testid="panel-tab-${first}"]`;
    await expect(window.locator(thirdSelector)).toHaveAttribute(
      'draggable',
      'true',
    );

    await window.locator(thirdSelector).hover();
    const thirdBox = await window.locator(thirdSelector).boundingBox();
    expect(thirdBox).not.toBeNull();
    const firstBox = await window.locator(firstSelector).boundingBox();
    expect(firstBox).not.toBeNull();
    const x = firstBox.x + 2;
    const y = firstBox.y + firstBox.height / 2;
    const dataTransfer = await window.evaluateHandle(() => new DataTransfer());
    await window.dispatchEvent(thirdSelector, 'dragstart', {
      dataTransfer,
      clientX: thirdBox.x + thirdBox.width / 2,
      clientY: thirdBox.y + thirdBox.height / 2,
    });
    for (const type of ['dragenter', 'dragover']) {
      await window.dispatchEvent(firstSelector, type, {
        dataTransfer,
        clientX: x,
        clientY: y,
      });
    }
    // Fill tabs now move under the pointer before the drop (#4958), with
    // their neighbours sliding aside instead of an insertion marker.
    const reordered = [third, ...before.filter((id) => id !== third)];
    await expect
      .poll(async () =>
        (await stripGeometry(window)).tabs
          .sort((a, b) => a.left - b.left)
          .map((tab) => tab.testId),
      )
      .toEqual(reordered.map((id) => `panel-tab-${id}`));
    await expect(
      window.locator(
        '.canopy-panel-tab-drop-before, .canopy-panel-tab-drop-after',
      ),
    ).toHaveCount(0);
    await window.dispatchEvent(firstSelector, 'drop', {
      dataTransfer,
      clientX: x,
      clientY: y,
    });
    await window.dispatchEvent(thirdSelector, 'dragend', { dataTransfer });

    await expect.poll(chatPanelIds).toEqual(reordered);
    // Reordering leaves the groups as they were.
    expect(collectLeaves((await getLayout(window)).root)).toHaveLength(
      groupCount,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a pinned tile keeps its 28px square instead of the default tab width', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithChats([
    'Pinned chat',
    'Fix login',
    'New chat',
  ]);
  const pinnedStrip = window
    .getByTestId(`panel-group-title-${DEFAULT_GROUP_IDS.chat}`)
    .locator('.canopy-panel-tab-strip-wrap-pinned');
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(3);
    const first = (await stripGeometry(window)).tabs[0];
    await window.getByTestId(first.testId).click({ button: 'right' });
    await window.getByTestId('panel-tab-context-pin').click();
    await expect(pinnedStrip.locator('.canopy-panel-tab-pinned')).toHaveCount(
      1,
    );
    const geometry = await pinnedStrip.evaluate((strip) => {
      const tile = strip.querySelector('.canopy-panel-tab-pinned');
      return {
        strip: strip.getBoundingClientRect().width,
        tile: tile?.getBoundingClientRect().width ?? Number.NaN,
      };
    });
    expect(Math.abs(geometry.tile - 28)).toBeLessThanOrEqual(1);
    // The strip holds the tile and its end padding, not a 224px tab.
    expect(geometry.strip).toBeLessThan(60);
    // The unpinned tabs keep the default width.
    const unpinned = await stripGeometry(window);
    expect(Math.abs(unpinned.tabs[0].width - 224)).toBeLessThanOrEqual(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a narrow row keeps a selected pinned tile square while the other tabs give way', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithChats([
    'Pinned chat',
    ...longTitles(11),
  ]);
  const pinnedStrip = window
    .getByTestId(`panel-group-title-${DEFAULT_GROUP_IDS.chat}`)
    .locator('.canopy-panel-tab-strip-wrap-pinned');
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(12);
    // Pin the first (selected) tab.
    const first = (await stripGeometry(window)).tabs[0];
    await window.getByTestId(first.testId).click({ button: 'right' });
    await window.getByTestId('panel-tab-context-pin').click();
    await expect(pinnedStrip.locator('.canopy-panel-tab-pinned')).toHaveCount(
      1,
    );
    await expect(
      pinnedStrip.locator('.canopy-panel-tab-pinned[data-active="true"]'),
    ).toHaveCount(1);
    // Narrow the row until the tabs share it below 20px (see the narrow-row
    // test above for why the bar itself is narrowed).
    await pinnedStrip.evaluate((strip) => {
      const bar = strip.closest('.canopy-panel-tab-bar');
      if (bar instanceof HTMLElement) {
        bar.style.maxWidth = '300px';
      }
    });
    await expect
      .poll(async () => (await stripGeometry(window)).tileFloor)
      .toBeLessThan(20);
    const tile = await pinnedStrip.evaluate((strip) => {
      const rect = strip
        .querySelector('.canopy-panel-tab-pinned')
        ?.getBoundingClientRect();
      return { width: rect?.width ?? Number.NaN, height: rect?.height ?? 0 };
    });
    // Still square, as wide as it is tall, rather than squeezed to the floor.
    expect(Math.abs(tile.width - 28)).toBeLessThanOrEqual(1);
    expect(Math.abs(tile.width - tile.height)).toBeLessThanOrEqual(1);
    // The other tabs gave up the room, and all still fit their strip.
    const geometry = await stripGeometry(window);
    for (const tab of geometry.tabs) {
      expect(tab.right).toBeLessThanOrEqual(geometry.right + 1);
    }
    expect(geometry.overflowing).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the strip edge follows the shown tab, and only with early access on', async () => {
  test.setTimeout(120_000);
  const longReply = Array.from(
    { length: 120 },
    (_value, index) => `Line ${index + 1} of a long reply.`,
  ).join('\n\n');
  const { electronApp, userDataDir, window } = await launchWithChats([
    {
      title: 'Long chat',
      blocks: [{ type: 'text', text: longReply }],
    },
    'Empty chat',
  ]);
  const group = window.getByTestId(`panel-group-${DEFAULT_GROUP_IDS.chat}`);
  const strip = window.getByTestId(`panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`);
  const selectTab = (index) => strip.locator('[role="tab"]').nth(index).click();
  try {
    // The long chat opens at its bottom, scrolled under the strip.
    await expect(group).toHaveAttribute('data-title-edge', 'scrolled', {
      timeout: 20_000,
    });
    // Scroll the long chat partway up, off its bottom, so showing it again
    // does not re-pin it there (which would fire a scroll event).
    await window
      .getByTestId(`panel-group-body-${DEFAULT_GROUP_IDS.chat}`)
      .evaluate((body) => {
        const scroller = Array.from(body.querySelectorAll('*')).find(
          (element) =>
            element instanceof HTMLElement &&
            element.scrollHeight > element.clientHeight + 1 &&
            ['auto', 'scroll'].includes(getComputedStyle(element).overflowY),
        );
        if (scroller instanceof HTMLElement) {
          scroller.scrollTop = Math.floor(scroller.scrollHeight / 3);
        }
      });
    await expect(group).toHaveAttribute('data-title-edge', 'scrolled');
    await selectTab(1);
    await expect(group).toHaveAttribute('data-title-edge', 'top');
    // Showing the scrolled chat again fires no scroll event; the edge is
    // measured instead.
    await selectTab(0);
    await expect(group).toHaveAttribute('data-title-edge', 'scrolled');

    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: false,
      }),
    );
    await expect(group).not.toHaveAttribute('data-title-edge', /.*/);
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: true,
      }),
    );
    await expect(group).toHaveAttribute('data-title-edge', 'scrolled');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
