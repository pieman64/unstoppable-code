// Nested pane corners: every rounded control inside a rounded pane surface
// takes that surface's radius less the gap between their edges, never below
// 6px. The chat pane (fill tabs, Activity toggle), the Browser pane (toolbar
// and address field) and the collapsed Side Panel rail are measured in the
// real window, at the default window corner and at a 10px one, where the
// card itself and every control in it land on the 6px floor.
//
// Run after building the implementation:
//   pnpm run test:electron:built pane-nested-corners.spec.mjs --reporter=line
//
// Determinism: the worktree and chats are seeded on disk with no messages;
// the Browser shows a local HTTP fixture and no provider request runs.

import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree, seedVisibleBrowserPanel } from './panelHarness.mjs';

const APP = 'ts-pnpm-vite';
const BRANCH = 'demo-main';
const CHAT_TAB_ID = 'corners-chat-1';

async function startLocalPage() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><title>Corners fixture</title><body style="margin:0">Corners fixture</body>',
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('Local browser fixture did not receive a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function launch() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-corners-'));
  seedDemoWorkspaces({ userDataDir, apps: [APP] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: `demo-${APP}`,
    worktreeId: BRANCH,
    providerType: 'claude',
    tabs: [
      { id: CHAT_TAB_ID, title: 'Nested corners' },
      { id: 'corners-chat-2', title: 'Second chat' },
    ],
    activeTabId: CHAT_TAB_ID,
  });
  const dataDir = path.join(
    userDataDir,
    'workspaces',
    `demo-${APP}`,
    'worktree-data',
    BRANCH,
  );
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
  );
  seedEarlyAccess({ userDataDir });
  const launched = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  await expect(launched.window.getByTestId('worktree-top-bar')).toBeVisible({
    timeout: 20_000,
  });
  return { ...launched, userDataDir };
}

/**
 * Each nested pair's outer and inner corner radius and the gap between their
 * top-left edges, in CSS px.
 */
function readCorners(window) {
  return window.evaluate(() => {
    const radius = (element) =>
      Number.parseFloat(getComputedStyle(element).borderTopLeftRadius);
    const pair = (outer, inner, gapEdges = ['left', 'top']) => {
      if (!outer || !inner) return null;
      const o = outer.getBoundingClientRect();
      const i = inner.getBoundingClientRect();
      const gaps = {
        left: i.left - o.left,
        top: i.top - o.top,
        right: o.right - i.right,
      };
      return {
        outer: radius(outer),
        inner: radius(inner),
        gaps: gapEdges.map((edge) => Math.round(gaps[edge] * 2) / 2),
      };
    };
    const chat = document.querySelector(
      '.canopy-panel-group:has([data-testid="worktree-activity-card-toggle"])',
    );
    const browser = document.querySelector(
      '.canopy-panel-group:has([data-testid="browser-bar"])',
    );
    const rail = document.querySelector('.canopy-panel-collapsed-bar-vertical');
    const tab = chat?.querySelector('.canopy-panel-tab');
    return {
      cardTile: pair(chat, tab),
      tileClose: pair(
        tab,
        tab?.querySelector('.canopy-panel-tab-close') ?? null,
        ['right'],
      ),
      activity: radius(
        document.querySelector('[data-testid="worktree-activity-card-toggle"]'),
      ),
      addTab: radius(chat?.querySelector('.canopy-panel-add-tab')),
      chrome: [...(chat?.querySelectorAll('.canopy-panel-chrome button') ?? [])]
        .filter((button) => button.getBoundingClientRect().width > 0)
        .map(radius),
      toolbar: [
        ...(browser?.querySelectorAll(
          '[data-testid="browser-bar"] :is(button, input)',
        ) ?? []),
      ]
        .filter((control) => control.getBoundingClientRect().width > 0)
        .map(radius),
      railButton: pair(rail, rail?.querySelector('button') ?? null, [
        'left',
        'top',
        'right',
      ]),
    };
  });
}

function expectNested(pairValue, gap) {
  expect(pairValue).not.toBeNull();
  expect(pairValue.inner).toBe(Math.max(6, pairValue.outer - gap));
}

test('nested pane corners follow the card, with a 6px floor', async () => {
  test.setTimeout(180_000);
  const page = await startLocalPage();
  const { electronApp, window, userDataDir } = await launch();
  try {
    const { panelId } = await seedVisibleBrowserPanel(
      window,
      { projectId: `demo-${APP}`, worktreeId: BRANCH, url: page.url },
      { originChatTabId: CHAT_TAB_ID },
    );
    await expect(window.getByTestId(`panel-tab-${panelId}`)).toBeVisible();
    await expect(window.getByTestId('browser-bar')).toBeVisible();
    await expect(
      window.getByTestId('worktree-activity-card-toggle'),
    ).toBeVisible();
    await expect(
      window.locator('.canopy-panel-collapsed-bar-vertical'),
    ).toBeVisible();

    const corners = await readCorners(window);
    // The default 16px window corner: a 10px card.
    expect(corners.cardTile.outer).toBe(10);
    // Tiles sit 4px in from the card's top and side: 10 - 4.
    expect(corners.cardTile.gaps).toEqual([4, 4]);
    expectNested(corners.cardTile, 4);
    expect(corners.cardTile.inner).toBe(6);
    // The close button sits 2px inside its tile and nests exactly (6 - 2),
    // the one named exception to the 6px floor.
    expect(corners.tileClose.gaps).toEqual([2]);
    expect(corners.tileClose.inner).toBe(4);
    // Every other control in the row, the Activity toggle included, and the
    // Browser toolbar take the tile radius.
    expect(corners.activity).toBe(6);
    expect(corners.addTab).toBe(6);
    expect(corners.chrome.length).toBeGreaterThan(0);
    expect(new Set(corners.chrome)).toEqual(new Set([6]));
    expect(corners.toolbar.length).toBeGreaterThan(0);
    expect(new Set(corners.toolbar)).toEqual(new Set([6]));
    // The rail's controls sit one inset from its top and both sides; 10 - 7
    // lands on the floor.
    expect(corners.railButton.gaps).toEqual([7, 7, 7]);
    expectNested(corners.railButton, 7);
    expect(corners.railButton.inner).toBe(6);

    // A 10px window corner (macOS 11-15, or a high interface zoom) leaves
    // 4px of card: the card and everything nested in it hold the floor.
    await window.evaluate(() =>
      document.documentElement.style.setProperty(
        '--window-corner-radius',
        '10px',
      ),
    );
    const small = await readCorners(window);
    expect(small.cardTile.outer).toBe(6);
    expect(small.cardTile.inner).toBe(6);
    expect(small.tileClose.inner).toBe(4);
    expect(small.activity).toBe(6);
    expect(new Set(small.toolbar)).toEqual(new Set([6]));
    expect(small.railButton.outer).toBe(6);
    expect(small.railButton.inner).toBe(6);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await page.close();
  }
});
