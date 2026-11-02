// Chrome-style panel tabs (the `fill` tab style; the classic tabs are covered
// by the worktree-panels specs): the unpinned tabs of a group all take one
// default width (room for a 28-character title) while they fit, with the
// add-tab button and the ⌄ all-tabs button right after them. Once they do not
// fit, they split the strip equally and fill it, shrinking as more open down
// to a readable 96px; past that the strip scrolls (wheel, or a thin line on
// the row's hairline that drags like an overlay scrollbar) and keeps the
// selected tab in view. ⌄ shows only once the tabs no longer fit, with a dot
// while an unread tab is out of view. Closing a tab re-shares the row at once;
// while the row is crowded the last tab stays at its end, so its close button
// lands under the pointer.
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
import { evaluateWithSyntheticIpcEvent } from './syntheticIpcEvent.mjs';
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
      const list = bar?.querySelector('.canopy-panel-tab-list-root');
      const barRect = bar?.getBoundingClientRect();
      const addRect = add?.getBoundingClientRect();
      return {
        left: stripRect.left,
        right: stripRect.right,
        addLeft: addRect?.left ?? Number.NaN,
        addRight: addRect?.right ?? Number.NaN,
        // ⌄ shows only once the tabs no longer fit; it ends the row.
        listShown:
          list !== null &&
          list !== undefined &&
          getComputedStyle(list).display !== 'none',
        listUnread: list?.hasAttribute('data-unread') ?? false,
        listLeft: list?.getBoundingClientRect().left ?? Number.NaN,
        listRight: list?.getBoundingClientRect().right ?? Number.NaN,
        barRight: barRect?.right ?? Number.NaN,
        overflowing: strip.scrollWidth - strip.clientWidth > 1,
        tabs,
      };
    });
}

const inactive = (tabs) => tabs.filter((tab) => !tab.active);

// Marks seeded chats as streaming through the chat-state channel the runtime
// uses, so their tabs show the running spinner (no provider runs).
async function markStreaming(electronApp, chatIds) {
  await evaluateWithSyntheticIpcEvent(
    electronApp,
    async ({ ipcMain }, { event, args }) => {
      const snapshot = await ipcMain._invokeHandlers.get('chat:get-state')(
        event,
        { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' },
      );
      event.sender.send('chat:state-changed', {
        projectId: snapshot.projectId,
        worktreeId: snapshot.worktreeId,
        schemaVersion: 1,
        eventId: `crowded-streaming-${args.join('-')}`,
        occurredAt: new Date().toISOString(),
        baseRevision: snapshot.revision,
        revision: snapshot.revision + 1,
        changes: args.map((chatId) => ({
          type: 'runtime.patched',
          chatId,
          runtime: { status: 'streaming', queuedMessageIds: [] },
        })),
      });
    },
    chatIds,
  );
}

function widthSpread(tabs) {
  const widths = tabs.map((tab) => tab.width);
  return Math.max(...widths) - Math.min(...widths);
}

test('tabs that fit take one default width, with the add button after them', async () => {
  test.setTimeout(120_000);
  // The last title is 28 characters, the length the default width holds.
  // Two tabs: the test window's pane holds two at the default width.
  const titles = ['New chat', 'Fix PR-attributed CI failure'];
  const { electronApp, userDataDir, window } = await launchWithChats(titles);
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(2);
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
    // Every tab fits, so there is no ⌄.
    expect(geometry.listShown).toBe(false);
    expect(geometry.barRight - geometry.addRight).toBeGreaterThan(100);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('tabs that do not fit share the row equally before any scrolling', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(5),
  );
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(5);
    const geometry = await stripGeometry(window);
    expect(geometry.overflowing).toBe(false);
    // Every tab shares the row equally, above the 96px floor and under the
    // default width, with its title and × still on its line.
    expect(widthSpread(geometry.tabs)).toBeLessThanOrEqual(1);
    for (const tab of geometry.tabs) {
      expect(tab.width).toBeGreaterThan(96);
      expect(tab.width).toBeLessThan(224);
      expect(tab.labelShown).toBe(true);
      expect(tab.left).toBeGreaterThanOrEqual(geometry.left - 1);
      expect(tab.right).toBeLessThanOrEqual(geometry.right + 1);
    }
    // Squeezed, so ⌄ shows and ends the row.
    expect(geometry.listShown).toBe(true);
    const lastTab = geometry.tabs[geometry.tabs.length - 1];
    expect(geometry.addLeft - lastTab.right).toBeLessThanOrEqual(12);
    expect(geometry.barRight - geometry.listRight).toBeLessThanOrEqual(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('closing a tab re-shares the row at once, keeping the last tab under the pointer', async () => {
  test.setTimeout(120_000);
  // Enough tabs that, even after one closes, they share the row rather than
  // sit at their default width, and few enough that none reaches the floor.
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(6),
  );
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(6);
    const before = await stripGeometry(window);
    expect(before.barRight - before.listRight).toBeLessThanOrEqual(1);
    const last = before.tabs[before.tabs.length - 1];
    const lastPanelId = last.testId.replace(/^panel-tab-/, '');

    await window.getByTestId(last.testId).hover();
    await window.getByTestId(`panel-tab-close-${lastPanelId}`).click();

    // No hold: the five left share the row right away, with the pointer
    // still on the strip, and the new last tab ends where the closed one did.
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(5);
    const after = await stripGeometry(window);
    expect(after.barRight - after.listRight).toBeLessThanOrEqual(1);
    const newLast = after.tabs[after.tabs.length - 1];
    expect(Math.abs(newLast.right - last.right)).toBeLessThanOrEqual(1);
    expect(inactive(after.tabs)[0].width).toBeGreaterThan(
      inactive(before.tabs)[0].width + 1,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a row of 30 tabs keeps + enabled and takes a new chat', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(30),
  );
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(30);
    const add = window.getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.chat}`);
    await expect(add).toBeEnabled();

    // Cmd/Ctrl+T opens a 31st chat in the same row: there is no tab limit.
    await window
      .getByTestId(`panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`)
      .locator('[role="tab"][data-active="true"]')
      .click();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+t' : 'Control+t',
    );
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(31);
    const layout = await getLayout(window);
    const chatLeaf = collectLeaves(layout.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    expect(chatLeaf?.panels).toHaveLength(31);
    // The new chat is selected and scrolled into view.
    const geometry = await stripGeometry(window);
    const selected = geometry.tabs.find((tab) => tab.active);
    expect(selected?.right).toBeLessThanOrEqual(geometry.right + 1);
    expect(selected?.left).toBeGreaterThanOrEqual(geometry.left - 1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('turning early access off preserves filled tabs', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(20),
  );
  const bar = window
    .getByTestId(`panel-group-title-${DEFAULT_GROUP_IDS.chat}`)
    .locator('.canopy-panel-tab-bar');
  try {
    await expect(bar).toHaveAttribute('data-tab-style', 'fill');

    // The preferences push reaches the tab bar without a reload.
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: false,
      }),
    );
    await expect(bar).toHaveAttribute('data-tab-style', 'fill');

    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: true,
      }),
    );
    await expect(bar).toHaveAttribute('data-tab-style', 'fill');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('once every tab is at its 96px floor, the strip scrolls and keeps the selected tab in view', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(40),
  );
  const strip = window.getByTestId(`panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`);
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(40);
    let geometry = await stripGeometry(window);
    expect(geometry.overflowing).toBe(true);
    // Every tab stops shrinking at a readable 96px, 4px apart.
    for (const tab of inactive(geometry.tabs)) {
      expect(Math.abs(tab.width - 96)).toBeLessThanOrEqual(0.5);
      expect(tab.labelShown).toBe(true);
    }
    expect(geometry.listShown).toBe(true);
    expect(geometry.tabs[1].left - geometry.tabs[0].right).toBeCloseTo(4, 0);
    expect(
      Math.abs((geometry.tabs.find((tab) => tab.active)?.width ?? 0) - 96),
    ).toBeLessThanOrEqual(1);
    // The + and ⌄ stay put at the end of the row.
    expect(geometry.barRight - geometry.listRight).toBeLessThanOrEqual(1);

    // The wheel pans the strip.
    await strip.hover();
    await window.mouse.wheel(0, 400);
    await expect
      .poll(() => strip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);

    // Choosing the last tab from the ⌄ list scrolls it into view.
    await window
      .getByTestId(`panel-tab-list-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    await window
      .getByTestId('panel-tab-list-row-panel-chat-fill-chat-40')
      .click();
    await expect
      .poll(async () => {
        geometry = await stripGeometry(window);
        const selected = geometry.tabs.find((tab) => tab.active);
        return (
          selected?.testId === 'panel-tab-panel-chat-fill-chat-40' &&
          selected.right <= geometry.right + 1 &&
          selected.left >= geometry.left - 1
        );
      })
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the ⌄ list shows every tab, searches them, and closes one in place', async () => {
  test.setTimeout(180_000);
  const titles = longTitles(24);
  titles[16] = 'Release notes draft';
  const { electronApp, userDataDir, window } = await launchWithChats(titles);
  const menu = window.getByTestId(
    `panel-tab-list-menu-${DEFAULT_GROUP_IDS.chat}`,
  );
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(24);
    await window
      .getByTestId(`panel-tab-list-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    await expect(menu.locator('[role="option"]')).toHaveCount(24);
    // Rows show the tab's number and title; the selected tab is marked.
    await expect(
      window.getByTestId('panel-tab-list-row-panel-chat-fill-chat-1'),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      window.getByTestId('panel-tab-list-row-panel-chat-fill-chat-2'),
    ).toContainText('2');

    // × in a row closes that tab and leaves the list open.
    await window
      .getByTestId('panel-tab-list-row-panel-chat-fill-chat-3')
      .hover();
    await window
      .getByTestId('panel-tab-list-close-panel-chat-fill-chat-3')
      .click();
    await expect(menu.locator('[role="option"]')).toHaveCount(23);
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(23);

    // The search field keeps focus; typing filters, Enter opens the match.
    await window.keyboard.type('release');
    await expect(menu.locator('[role="option"]')).toHaveCount(1);
    await window.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(
      window.getByTestId('panel-tab-panel-chat-fill-chat-17'),
    ).toHaveAttribute('data-active', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a running tab out of view adds nothing to the row; an unread one dots ⌄ after a pause', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(40),
  );
  const strip = window.getByTestId(`panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`);
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(40);
    await markStreaming(electronApp, ['fill-chat-30']);
    await expect(
      window
        .getByTestId('panel-tab-panel-chat-fill-chat-30')
        .locator('[data-panel-tab-busy]'),
    ).toHaveCount(1);
    // No "N running" count in a fill row.
    await expect(window.locator('.canopy-panel-tab-edge-count')).toHaveCount(0);
    // Chat 2 is marked unread from its tab menu while it shows: no dot.
    await window
      .getByTestId('panel-tab-panel-chat-fill-chat-2')
      .click({ button: 'right' });
    await window.getByTestId('panel-tab-context-mark-unread').click();
    await expect(
      window.getByTestId('panel-tab-unread-dot-fill-chat-2'),
    ).toHaveCount(1);
    await window.waitForTimeout(800);
    expect((await stripGeometry(window)).listUnread).toBe(false);

    // Scrolled to the end, chat 2 is out of view: ⌄ takes its dot after the
    // pause.
    await strip.hover();
    await window.mouse.wheel(0, 20_000);
    await expect
      .poll(async () => (await stripGeometry(window)).listUnread, {
        timeout: 5_000,
      })
      .toBe(true);

    // Back at the start, chat 2 shows and the dot goes.
    await window.mouse.wheel(0, -20_000);
    await expect
      .poll(async () => (await stripGeometry(window)).listUnread, {
        timeout: 5_000,
      })
      .toBe(false);

    // The ⌄ list keeps the running row numbered with its spinner on the
    // right, and the unread row's dot.
    await window
      .getByTestId(`panel-tab-list-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    const running = window
      .getByTestId('panel-tab-list-row-panel-chat-fill-chat-30')
      .locator('xpath=..');
    await expect(running.getByTestId('panel-tab-number')).toHaveText('30');
    await expect(running.locator('.canopy-panel-tab-list-busy')).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('dragging the thin scrollbar keeps the grab point, and the selected tab never pulls it back', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window } = await launchWithChats(
    longTitles(40),
  );
  const strip = window.getByTestId(`panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`);
  const track = window.getByTestId(
    `panel-tab-scroll-track-${DEFAULT_GROUP_IDS.chat}`,
  );
  const thumbBox = () =>
    strip.evaluate((element) => {
      const thumb = element.parentElement?.querySelector(
        '.canopy-scroll-thumb',
      );
      const rect = thumb?.getBoundingClientRect();
      return rect
        ? { left: rect.left, width: rect.width, height: rect.height }
        : null;
    });
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(40);
    const box = await track.boundingBox();
    if (!box) throw new Error('no scroll track');
    const y = box.y + box.height / 2;
    // Hovering the line grows it.
    await window.mouse.move(box.x + 10, y);
    await expect
      .poll(async () => (await thumbBox())?.height ?? 0)
      .toBeCloseTo(6, 0);
    const start = await thumbBox();
    if (!start) throw new Error('no thumb');
    const grab = start.left + 20;
    await window.mouse.move(grab, y);
    await window.mouse.down();
    const offsets = [];
    for (let step = 1; step <= 10; step += 1) {
      // Mid-drag the selected tab's chat starts streaming, which re-renders
      // the row; the drag must not be pulled back to the selected tab.
      if (step === 5) await markStreaming(electronApp, ['fill-chat-1']);
      // Leaving the 8px zone keeps the drag.
      await window.mouse.move(grab + step * 15, y + (step > 6 ? 40 : 0));
      const now = await thumbBox();
      offsets.push(grab + step * 15 - (now?.left ?? 0));
    }
    await window.mouse.up();
    for (const offset of offsets) {
      expect(Math.abs(offset - 20)).toBeLessThanOrEqual(2);
    }
    expect(
      await strip.evaluate((element) => element.scrollLeft),
    ).toBeGreaterThan(0);
    // No page text was selected by the drag.
    expect(await window.evaluate(() => String(getSelection()))).toBe('');
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

test('a crowded row keeps a selected pinned tile square while the other tabs scroll', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithChats([
    'Pinned chat',
    ...longTitles(39),
  ]);
  const pinnedStrip = window
    .getByTestId(`panel-group-title-${DEFAULT_GROUP_IDS.chat}`)
    .locator('.canopy-panel-tab-strip-wrap-pinned');
  try {
    await expect
      .poll(async () => (await stripGeometry(window)).tabs.length)
      .toBe(40);
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
    const tile = await pinnedStrip.evaluate((strip) => {
      const rect = strip
        .querySelector('.canopy-panel-tab-pinned')
        ?.getBoundingClientRect();
      return { width: rect?.width ?? Number.NaN, height: rect?.height ?? 0 };
    });
    // Still square, as wide as it is tall.
    expect(Math.abs(tile.width - 28)).toBeLessThanOrEqual(1);
    expect(Math.abs(tile.width - tile.height)).toBeLessThanOrEqual(1);
    // The other tabs keep their square floor and scroll instead.
    const geometry = await stripGeometry(window);
    expect(geometry.overflowing).toBe(true);
    for (const tab of geometry.tabs) {
      expect(tab.width).toBeGreaterThanOrEqual(27.5);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the strip edge follows the shown tab regardless of early access', async () => {
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
    await expect(group).toHaveAttribute('data-title-edge', 'scrolled');
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

// The selected fill tab is marked by its muted fill alone, with no accent
// underline (CAN-4789 added one; it was taken back out), in states that
// geometry-only tests do not cover. Drag uses the real live pointer path.
for (const mode of ['light', 'dark']) {
  test(`selected fill tab has no underline in pinned, focus and live drag states in ${mode}`, async () => {
    const { electronApp, userDataDir, window } = await launchWithChats([
      'Pinned',
      ...longTitles(10),
    ]);
    try {
      await window.evaluate(
        (theme) =>
          document.documentElement.classList.toggle('dark', theme === 'dark'),
        mode,
      );
      const pinned = window.getByTestId('panel-tab-panel-chat-fill-chat-1');
      await pinned.click({ button: 'right' });
      await window.getByTestId('panel-tab-context-pin').click();
      await expect(pinned).toHaveClass(/canopy-panel-tab-pinned/);
      const noUnderline = async (tab) => {
        await expect(tab).toHaveAttribute('data-active', 'true');
        const after = await tab.evaluate(
          (element) => getComputedStyle(element, '::after').content,
        );
        expect(after).toBe('none');
      };
      const filled = async (tab) => {
        const color = await tab.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        expect(color).not.toBe('rgba(0, 0, 0, 0)');
      };
      await noUnderline(pinned);
      await filled(pinned);
      await pinned.focus();
      await window.keyboard.press('Tab');
      await noUnderline(pinned);
      const tab = window.getByTestId('panel-tab-panel-chat-fill-chat-2');
      await tab.click();
      await noUnderline(tab);
      await filled(tab);
      await expect(pinned).toHaveAttribute('data-active', 'false');
      const from = await tab.boundingBox();
      const to = await window
        .getByTestId('panel-tab-panel-chat-fill-chat-4')
        .boundingBox();
      await window.mouse.move(
        from.x + from.width / 2,
        from.y + from.height / 2,
      );
      await window.mouse.down();
      try {
        await window.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
          steps: 12,
        });
        await expect(tab).toHaveAttribute('data-live-drag', 'strip');
        await noUnderline(tab);
      } finally {
        await window.mouse.up();
      }
      await noUnderline(tab);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
