// Regression: on worktree navigation, each panel group's active (selected) tab
// must be scrolled into view within its horizontal tab strip.
//
// The default layout build moves the active chat tab to the FRONT of the strip,
// so it is trivially in view there. The bug only manifests with a PERSISTED
// layout whose active tab is elsewhere (e.g. the rightmost, off-screen tab):
// the panel grid sizes each group's tab strip in the grid host's own layout
// effect, which React runs AFTER the portaled tab bar's layout effect, so a
// synchronous reveal measured a 0-width strip and no-oped, and never re-ran
// once the strip had a real width. See PanelTabBar's post-paint reveal fallback.
//
// This reproduces a real persisted layout by:
//   Launch 1 — build the default layout, select the last-positioned tab so it
//              becomes active-but-rightmost, and let it persist to disk.
//   Launch 2 — restore that layout with a single navigation and assert the
//              active (rightmost) tab is scrolled into view.

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

const TAB_COUNT = 16;
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

// Geometry of the chat group's active tab relative to its (overflowing) strip.
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

test('reveals the active (rightmost) tab into view when navigating to a worktree', async () => {
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
    // panel so the test proves overflow reveal rather than a default ordering.
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

    // Precondition: the restored active tab really is the off-screen rightmost
    // tab in an overflowing strip (otherwise the test would pass vacuously).
    const initial = await activeTabGeometry(window);
    expect(initial?.activeIsLastInOrder).toBe(true);
    expect(initial?.overflowing).toBe(true);

    // The reveal runs post-paint; poll until the active tab is scrolled in.
    await expect
      .poll(async () => (await activeTabGeometry(window))?.inView, {
        timeout: 5_000,
      })
      .toBe(true);

    const settled = await activeTabGeometry(window);
    expect(settled?.scrollLeft).toBeGreaterThan(0);

    await window.evaluate(() => {
      document.documentElement.dataset.scrollbarBehavior = 'hover';
    });
    const strip = window.getByTestId(
      `panel-tab-strip-${DEFAULT_GROUP_IDS.chat}`,
    );
    const thumb = strip.locator('..').locator('.canopy-scroll-thumb');
    await strip.hover();
    await expect(thumb).toHaveAttribute('data-revealed', 'true');
    await thumb.hover();
    await expect(thumb).toHaveAttribute('data-revealed', 'true');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
