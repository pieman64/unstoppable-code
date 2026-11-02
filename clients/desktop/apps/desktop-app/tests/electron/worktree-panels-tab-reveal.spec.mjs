// A persisted layout restores its active tab even when that tab is last in
// the saved order. Filled tabs compress to fit the strip after Labs graduation,
// so the restored rightmost tab must remain visible without horizontal scroll.
//
// Launch 1 selects and durably saves the last-positioned tab. Launch 2 restores
// that layout with one navigation and checks selection, order, and geometry.

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import {
  getLayout,
  collectLeaves,
  DEFAULT_GROUP_IDS,
} from './panelHarness.mjs';

// Few enough to share the row above the tabs' 96px floor, without scrolling.
const TAB_COUNT = 5;
const BRANCH = 'demo-main';
const APP = 'ts-pnpm-vite';
const WORKSPACE_ID = `demo-${APP}`;

function layoutFilePath(userDataDir) {
  return path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    BRANCH,
    'panel-layout.json',
  );
}

function persistedActiveChatId(userDataDir) {
  try {
    return readChatStorageIndexes(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID),
      BRANCH,
    ).live.activeTabId;
  } catch {
    return null;
  }
}

function persistedChatLeaf(userDataDir) {
  const p = layoutFilePath(userDataDir);
  if (!existsSync(p)) return null;

  try {
    const layout = JSON.parse(readFileSync(p, 'utf8'));
    const leaves = [];
    const walk = (node) => {
      if (!node) return;
      if (node.type === 'leaf') {
        leaves.push(node);
        return;
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(walk);
      }
    };
    walk(layout?.grid?.root);
    return (
      leaves.find((leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat) ?? null
    );
  } catch {
    return null;
  }
}

async function waitForChatPanels(window) {
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
  await expect
    .poll(() => window.evaluate(() => Boolean(window.__canopyPanelTestApi)), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect
    .poll(
      async () => {
        const layout = await getLayout(window);
        if (!layout) return -1;
        const leaf = collectLeaves(layout.root).find(
          (n) => n.groupId === DEFAULT_GROUP_IDS.chat,
        );
        return leaf?.panels?.length ?? -1;
      },
      { timeout: 20_000 },
    )
    .toBe(TAB_COUNT);
}

// Geometry of the chat group's active tab relative to its filled strip.
function activeTabGeometry(window) {
  return window.evaluate(
    ([groupId]) => {
      const layout = window.__canopyPanelTestApi?.getSerializedLayout() ?? null;
      const flat = [];
      const walk = (node) => {
        if (!node) return;
        if (node.type === 'leaf') flat.push(node);
        else node.children.forEach(walk);
      };
      walk(layout?.root);
      const chatLeaf = flat.find((n) => n.groupId === groupId);
      const activePanelId = chatLeaf?.activePanelId ?? null;
      const panels = chatLeaf?.panels ?? [];
      const strip = document.querySelector(
        `[data-testid="panel-tab-strip-${groupId}"]`,
      );
      const activeTab = activePanelId
        ? document.querySelector(`[data-testid="panel-tab-${activePanelId}"]`)
        : null;
      if (
        !(strip instanceof HTMLElement) ||
        !(activeTab instanceof HTMLElement)
      )
        return null;
      const stripRect = strip.getBoundingClientRect();
      const tabRect = activeTab.getBoundingClientRect();
      return {
        activePanelId,
        activeIsLastInOrder:
          panels[panels.length - 1]?.panelId === activePanelId,
        overflowing: strip.scrollWidth - strip.clientWidth > 1,
        scrollLeft: strip.scrollLeft,
        inView:
          tabRect.left >= stripRect.left - 1 &&
          tabRect.right <= stripRect.right + 1,
      };
    },
    [DEFAULT_GROUP_IDS.chat],
  );
}

test('keeps the restored rightmost tab visible in the filled strip', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-tab-reveal-'));
  seedDemoWorkspaces({ userDataDir, apps: [APP] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: BRANCH,
    providerType: 'claude',
    tabs: Array.from({ length: TAB_COUNT }, (_v, i) => ({
      id: `chat-${i + 1}`,
      title: `Conversation number ${i + 1} long title`,
    })),
    activeTabId: `chat-${TAB_COUNT}`,
  });

  let rightmostPanel;
  let rightmostChatId;

  // -- Launch 1: persist a layout whose active tab is the rightmost ----------
  let launched = await launchCanopy({ userDataDir });
  {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(BRANCH);
    await waitForChatPanels(window);
    // Hydration may preserve a different tab order. Select the actual last
    // panel so the test proves persisted selection rather than a default ordering.
    const layout = await getLayout(window);
    const chatLeaf = collectLeaves(layout.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    rightmostPanel = chatLeaf.panels[chatLeaf.panels.length - 1].panelId;
    rightmostChatId = rightmostPanel.replace(/^panel-chat-/, '');

    await window.evaluate(
      ([groupId, panelId]) => {
        window.__canopyPanelTestApi?.focusPanel(groupId, panelId);
      },
      [DEFAULT_GROUP_IDS.chat, rightmostPanel],
    );

    await expect
      .poll(async () => (await activeTabGeometry(window))?.activePanelId, {
        timeout: 15_000,
      })
      .toBe(rightmostPanel);
    await expect
      .poll(
        async () => (await activeTabGeometry(window))?.activeIsLastInOrder,
        {
          timeout: 15_000,
        },
      )
      .toBe(true);

    // Wait for the debounced save to write the active tab to disk. Checking
    // for the target id as a substring is insufficient because every tab id is
    // present in the file even when a previous activePanelId was saved.
    await expect
      .poll(
        () => {
          const leaf = persistedChatLeaf(userDataDir);
          const panels = Array.isArray(leaf?.panels) ? leaf.panels : [];
          return (
            leaf?.activePanelId === rightmostPanel &&
            panels[panels.length - 1]?.panelId === rightmostPanel
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // The panel selection also drives the chat store's activeTabId. If this
    // save lags behind the panel-layout save, launch 2 can hydrate the stale
    // chat-active tab and select it back over the restored panel-active tab.
    await expect
      .poll(() => persistedActiveChatId(userDataDir), { timeout: 15_000 })
      .toBe(rightmostChatId);
  }
  await closeCanopy(launched.electronApp, userDataDir, { keepUserData: true });

  // -- Launch 2: restore the persisted layout, single navigation, assert -----
  launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(BRANCH);
    await waitForChatPanels(window);

    // The saved active tab must remain last; hydration must not silently move
    // it to the front and make the visibility assertion pass vacuously.
    const initial = await activeTabGeometry(window);
    expect(initial?.activePanelId).toBe(rightmostPanel);
    expect(initial?.activeIsLastInOrder).toBe(true);
    expect(initial?.overflowing).toBe(false);

    // Layout settles post-paint; poll until the restored active tab is visible.
    await expect
      .poll(async () => (await activeTabGeometry(window))?.inView, {
        timeout: 5_000,
      })
      .toBe(true);

    const settled = await activeTabGeometry(window);
    expect(settled?.scrollLeft).toBe(0);

    await window.evaluate(() => {
      document.documentElement.dataset.scrollbarBehavior = 'hover';
    });
    const strip = window.getByTestId(
      `panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`,
    );
    const thumb = strip.locator('..').locator('.canopy-scroll-thumb');
    await strip.hover();
    await expect(thumb).toBeHidden();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
