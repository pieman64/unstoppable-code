// Early access inset window layout: with "Try new features early" on, the
// sidebar and the worktree top bar sit on the window material and the panel
// grid under the top bar is one card, inset 4px from the window's right and
// bottom edges, with corners concentric with the OS window and a hairline
// edge. Pages without a top bar of their own (New Task, Automations) keep the
// top bar row empty and start their card where a worktree's grid does. With
// early access off the flat layout is unchanged.
//
// Run after building the implementation:
//   pnpm run test:electron:built inset-window-layout.spec.mjs --reporter=line
//
// Set INSET_LAYOUT_CAPTURE_DIR to an absolute directory to also save light
// and dark window captures there.
//
// Determinism: the worktree and its chat are seeded on disk with no messages;
// no provider or network request runs.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree, seedVisibleBrowserPanel } from './panelHarness.mjs';

const APP = 'ts-pnpm-vite';
const BRANCH = 'demo-main';
const CAPTURE_DIR = process.env.INSET_LAYOUT_CAPTURE_DIR;

async function launch({ earlyAccess }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-inset-'));
  seedDemoWorkspaces({ userDataDir, apps: [APP] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: `demo-${APP}`,
    worktreeId: BRANCH,
    providerType: 'claude',
    tabs: [{ id: 'inset-chat-1', title: 'Inset layout' }],
    activeTabId: 'inset-chat-1',
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
    JSON.stringify({ version: 1, mode: 'minimal' }),
  );
  if (earlyAccess) {
    seedEarlyAccess({ userDataDir });
  }
  const launched = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  await expect(launched.window.getByTestId('worktree-top-bar')).toBeVisible({
    timeout: 20_000,
  });
  return { ...launched, userDataDir };
}

/** Computed frame of an element, in CSS px. */
function readFrame(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      radius: style.borderTopLeftRadius,
      background: style.backgroundColor,
      marginTop: style.marginTop,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
    };
  });
}

/**
 * The card radius concentric with the OS window corner: the published window
 * radius over the interface zoom, minus the 4px inset, never under 4px.
 */
function expectedCardRadius(window) {
  return window.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    // A square window (Windows 10) publishes 0px; only an unset value falls
    // back to the stylesheet's 16px.
    const published = Number.parseFloat(
      style.getPropertyValue('--window-corner-radius'),
    );
    const windowRadius = Number.isFinite(published) ? published : 16;
    const zoom = Number.parseFloat(style.getPropertyValue('--ui-zoom')) || 1;
    return `${Math.max(windowRadius / zoom - 4, 4)}px`;
  });
}

function readBackground(locator) {
  return locator.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
}

async function capture(window, name) {
  if (!CAPTURE_DIR) return;
  mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const mode of ['light', 'dark']) {
    await window.evaluate((dark) => {
      document.documentElement.classList.toggle('dark', dark);
    }, mode === 'dark');
    await window.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    await window.screenshot({
      path: path.join(CAPTURE_DIR, `${name}-desktop-${mode}.png`),
    });
  }
  await window.evaluate(() => {
    document.documentElement.classList.remove('dark');
  });
}

/**
 * A card's edge, resolved in the live theme: the design system's 2xs surface
 * shadow in light mode, one neutral hairline around the card in dark mode.
 */
function readCardEdgeShadow(window) {
  return window.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.boxShadow = document.documentElement.classList.contains('dark')
      ? '0 0 0 var(--border-hairline) var(--inset-card-edge-color)'
      : 'var(--shadow-2xs)';
    // Inside the layout root: the edge color is defined on it.
    (document.querySelector('[data-window-layout]') ?? document.body).append(
      probe,
    );
    const shadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    return shadow;
  });
}

/** Every visible panel card in the grid: its frame and its window insets. */
function readPanelCards(window) {
  return window.getByTestId('panel-grid-root').evaluate((root) =>
    Array.from(root.querySelectorAll('.canopy-panel-group'))
      .map((group) => {
        const rect = group.getBoundingClientRect();
        const style = getComputedStyle(group);
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          radius: style.borderTopLeftRadius,
          boxShadow: style.boxShadow,
          outlineStyle: style.outlineStyle,
          backgroundImage: style.backgroundImage,
        };
      })
      .filter((card) => card.width > 0 && card.height > 0),
  );
}

test('early access puts each panel on its own inset card under a window-level top bar', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launch({
    earlyAccess: true,
  });
  try {
    await expect(window.locator('[data-window-layout="inset"]')).toHaveCount(1);
    // Open the Side Panel so the chat and the panel are two cards.
    const sidePanelToggle = window.getByTestId(
      'workspace-layout-side-panel-toggle',
    );
    if (
      (await sidePanelToggle.count()) > 0 &&
      (await sidePanelToggle.getAttribute('aria-pressed')) !== 'true'
    ) {
      await sidePanelToggle.click();
    }
    const radius = await expectedCardRadius(window);
    await expect
      .poll(async () => (await readPanelCards(window)).length)
      .toBeGreaterThanOrEqual(2);
    // The cards ease into place with the sidebar (their left inset animates
    // for 200ms), so read them once they have stopped 4px from the right edge.
    await expect
      .poll(async () => {
        const settling = await readPanelCards(window);
        const innerWidth = await window.evaluate(() => window.innerWidth);
        return Math.abs(
          innerWidth - Math.max(...settling.map((card) => card.right)) - 4,
        );
      })
      .toBeLessThan(0.5);
    const cards = await readPanelCards(window);
    // Each card's edge is the design system's 2xs surface shadow (a hairline
    // ring with a 1px fall; one brighter hairline in dark mode), not a local
    // outline.
    const surfaceShadow = await readCardEdgeShadow(window);
    expect(surfaceShadow).not.toBe('none');
    for (const card of cards) {
      expect(card.radius).toBe(radius);
      expect(card.boxShadow).toBe(surfaceShadow);
      expect(card.outlineStyle).toBe('none');
    }
    // A square OS window (0px corners) still keeps 4px card corners.
    const publishedRadius = await window.evaluate(() => {
      const root = document.documentElement;
      const previous = root.style.getPropertyValue('--window-corner-radius');
      root.style.setProperty('--window-corner-radius', '0px');
      return previous;
    });
    expect(await expectedCardRadius(window)).toBe('4px');
    for (const card of await readPanelCards(window)) {
      expect(card.radius).toBe('4px');
    }
    await window.evaluate((previous) => {
      const root = document.documentElement;
      if (previous) root.style.setProperty('--window-corner-radius', previous);
      else root.style.removeProperty('--window-corner-radius');
    }, publishedRadius);
    const viewport = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const rightmost = Math.max(...cards.map((card) => card.right));
    const lowest = Math.max(...cards.map((card) => card.bottom));
    expect(viewport.width - rightmost).toBeCloseTo(4, 0);
    expect(viewport.height - lowest).toBeCloseTo(4, 0);
    // Side by side cards are 4px apart.
    const [chat, side] = [...cards].sort((a, b) => a.left - b.left);
    expect(side.left - chat.right).toBeCloseTo(4, 0);
    // The cards start right under the top bar.
    const topBarBottom = await window
      .getByTestId('worktree-top-bar')
      .evaluate((element) => element.getBoundingClientRect().bottom);
    expect(Math.min(...cards.map((card) => card.top))).toBeCloseTo(
      topBarBottom,
      0,
    );

    // The top bar and the shell behind it show the window material.
    expect(await readBackground(window.getByTestId('worktree-top-bar'))).toBe(
      'rgba(0, 0, 0, 0)',
    );
    expect(await readBackground(window.getByTestId('app-main-shell'))).toBe(
      'rgba(0, 0, 0, 0)',
    );
    // The top bar's bottom hairline is gone: the card edges replace it.
    expect(
      await window
        .getByTestId('worktree-top-bar')
        .evaluate((element) => getComputedStyle(element, '::after').display),
    ).toBe('none');

    await capture(window, 'worktree-after');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** The edge line a resize handle draws (its `::after`), in viewport px. */
function readEdgeLine(handle) {
  return handle.evaluate((element) => {
    const line = getComputedStyle(element, '::after');
    if (line.content === 'none') return { content: line.content };
    const rect = element.getBoundingClientRect();
    const top = Number.parseFloat(line.top);
    const bottom = Number.parseFloat(line.bottom);
    const x = rect.left + rect.width / 2 + 0.25;
    const y = rect.top + (top + rect.height - bottom) / 2;
    return {
      content: line.content,
      backgroundImage: line.backgroundImage,
      top: rect.top + top,
      bottom: rect.bottom - bottom,
      // The handle must be the topmost thing on the edge, or page content
      // would cover the line.
      handleOnTop: document.elementFromPoint(x, y) === element,
    };
  });
}

async function readSelectedLineColor(window) {
  return window.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--line-selected)';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

/** Hovers a handle at mid-height and returns the pointer's viewport y. */
async function hoverHandle(window, handle) {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y - 8);
  await window.mouse.move(x, y, { steps: 2 });
  return { x, y };
}

/** The line is drawn around the pointer, within the card's edge. */
async function expectEdgeLine(window, handle, { pointerY, cardTop }) {
  const radius = Number.parseFloat(await expectedCardRadius(window));
  const selectedLine = await readSelectedLineColor(window);
  const line = await readEdgeLine(handle);
  expect(line.content).not.toBe('none');
  expect(line.backgroundImage).toContain('linear-gradient');
  expect(line.backgroundImage).toContain(selectedLine);
  expect(line.handleOnTop).toBe(true);
  expect(line.top).toBeCloseTo(cardTop + radius, 0);
  const viewportHeight = await window.evaluate(() => window.innerHeight);
  expect(viewportHeight - line.bottom).toBeCloseTo(4 + radius, 0);
  expect(pointerY).toBeGreaterThan(line.top);
  expect(pointerY).toBeLessThan(line.bottom);
}

test('resizing the sidebar draws a short line on the edge beside it, not the sidebar', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launch({
    earlyAccess: true,
  });
  try {
    const handle = window.getByTestId('sidebar-resize-handle');
    const topBarBottom = await window
      .getByTestId('worktree-top-bar')
      .evaluate((element) => element.getBoundingClientRect().bottom);
    expect((await readEdgeLine(handle)).content).toBe('none');

    const { x, y } = await hoverHandle(window, handle);
    await window.mouse.down();
    await window.mouse.move(x + 24, y, { steps: 4 });
    await expect(handle).toHaveAttribute('data-resizing', 'true');
    await expectEdgeLine(window, handle, {
      pointerY: y,
      cardTop: topBarBottom,
    });
    // The sidebar's own divider stays off.
    expect(
      await window
        .getByTestId('sidebar-panel')
        .evaluate((element) => getComputedStyle(element).borderRightColor),
    ).toBe('rgba(0, 0, 0, 0)');
    await capture(window, 'sidebar-drag-worktree-after');

    await window.mouse.up();
    await window.mouse.move(x + 200, y);
    await expect
      .poll(async () => (await readEdgeLine(handle)).content)
      .toBe('none');

    // New Task: its card starts under the empty top bar row.
    await window
      .getByTestId('app-sidebar')
      .getByRole('button', { name: 'New task', exact: true })
      .first()
      .click();
    const newTask = window.locator('main[data-main-frame="card-below-bar"]');
    await expect(newTask).toHaveCount(1);
    const newTaskTop = await newTask.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    const newTaskPointer = await hoverHandle(window, handle);
    await expectEdgeLine(window, handle, {
      pointerY: newTaskPointer.y,
      cardTop: newTaskTop,
    });
    await capture(window, 'sidebar-drag-new-task-after');
    await window.mouse.move(newTaskPointer.x + 200, newTaskPointer.y);

    // Workflows keeps the same empty top bar row.
    await window.getByTestId('sidebar-nav-workflows').click();
    const automations = window.locator('main[data-main-frame="card"]');
    await expect(automations).toHaveCount(1);
    const automationsTop = await automations.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    const automationsPointer = await hoverHandle(window, handle);
    await expectEdgeLine(window, handle, {
      pointerY: automationsPointer.y,
      cardTop: automationsTop,
    });
    await capture(window, 'sidebar-drag-automations-after');
    await window.mouse.move(automationsPointer.x + 200, automationsPointer.y);

    // Settings has its own sidebar and resize handle.
    await new CanopyAppDriver(window).openSettings();
    const settingsHandle = window.getByTestId('settings-sidebar-resize-handle');
    await expect(settingsHandle).toBeVisible();
    // Let the settings page finish sliding in: no time-based animation still
    // running (scroll-linked ones always report running, and a spinner's
    // never ends).
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === 'running' &&
                  animation.timeline === document.timeline &&
                  animation.effect?.getTiming().iterations !== Infinity,
              ).length,
        ),
      )
      .toBe(0);
    // The Settings page is one card in the same frame as every other page:
    // 46px under the window's top row, 4px from the right and bottom edges.
    const settingsCard = await window
      .locator('[data-testid="settings-content"]')
      .evaluate((card) => {
        const rect = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        return {
          top: rect.top,
          right: window.innerWidth - rect.right,
          bottom: window.innerHeight - rect.bottom,
          radius: style.borderTopLeftRadius,
          boxShadow: style.boxShadow,
        };
      });
    expect(settingsCard.top).toBeCloseTo(46, 0);
    expect(settingsCard.right).toBeCloseTo(4, 0);
    expect(settingsCard.bottom).toBeCloseTo(4, 0);
    expect(settingsCard.radius).toBe(await expectedCardRadius(window));
    expect(settingsCard.boxShadow).toBe(await readCardEdgeShadow(window));
    const settingsPointer = await hoverHandle(window, settingsHandle);
    const settingsLine = await readEdgeLine(settingsHandle);
    expect(settingsLine.content).not.toBe('none');
    expect(settingsLine.handleOnTop).toBe(true);
    expect(settingsPointer.y).toBeGreaterThan(settingsLine.top);
    expect(settingsPointer.y).toBeLessThan(settingsLine.bottom);
    await capture(window, 'sidebar-drag-settings-after');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Whether the window can be dragged from a point: the nearest element there
 * (or an ancestor) with an explicit app region says `drag`.
 */
function isWindowDragRegion(window, x, y) {
  return window.evaluate(
    ([px, py]) => {
      for (
        let element = document.elementFromPoint(px, py);
        element;
        element = element.parentElement
      ) {
        const region =
          getComputedStyle(element).getPropertyValue('-webkit-app-region');
        if (region === 'drag') return true;
        if (region === 'no-drag') return false;
      }
      return false;
    },
    [x, y],
  );
}

test('a page without a top bar keeps the top bar row empty above its card', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launch({
    earlyAccess: true,
  });
  try {
    const gridTop = Math.min(
      ...(await readPanelCards(window)).map((card) => card.top),
    );
    await window.getByTestId('sidebar-nav-workflows').click();
    const main = window.locator('main[data-main-frame="card"]');
    await expect(main).toHaveCount(1);
    await expect
      .poll(async () => (await readFrame(main)).radius)
      .toBe(await expectedCardRadius(window));
    const frame = await readFrame(main);
    expect(frame.marginTop).toBe('46px');
    expect(frame.right).toBeCloseTo(4, 0);
    expect(frame.bottom).toBeCloseTo(4, 0);
    const rect = await main.evaluate((element) => {
      const { left, top } = element.getBoundingClientRect();
      return { left, top };
    });
    expect(rect.top).toBeCloseTo(gridTop, 0);
    // The empty row still drags the window, as New Task's does.
    expect(await isWindowDragRegion(window, rect.left + 120, 20)).toBe(true);

    await capture(window, 'automations-after');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the chat page without a top bar is one card while a worktree stays selected', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launch({
    earlyAccess: true,
  });
  try {
    const gridTop = Math.min(
      ...(await readPanelCards(window)).map((card) => card.top),
    );
    // The chat page's empty state has no top bar of its own. The worktree
    // page stays mounted, hidden, beside it; a top bar left there (as a
    // selected worktree renders) must not take the chat page's card away.
    await new CanopyAppDriver(window).openChatPage();
    await expect(window.getByTestId('page-main')).toBeHidden();
    await window.getByTestId('page-main').evaluate((page) => {
      const bar = document.createElement('div');
      bar.dataset.testid = 'worktree-top-bar';
      page.append(bar);
    });
    await expect(window.getByTestId('cowork-top-bar')).toHaveCount(0);
    const main = window.locator('main[data-main-frame="split"]');
    await expect(main).toHaveCount(1);
    await expect
      .poll(async () => (await readFrame(main)).radius)
      .toBe(await expectedCardRadius(window));
    const frame = await readFrame(main);
    expect(frame.marginTop).toBe('46px');
    expect(frame.right).toBeCloseTo(4, 0);
    expect(frame.bottom).toBeCloseTo(4, 0);
    expect(
      await main.evaluate((element) => getComputedStyle(element).boxShadow),
    ).toBe(await readCardEdgeShadow(window));
    const cardTop = await main.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(cardTop).toBeCloseTo(gridTop, 0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('New Task keeps an empty top bar row and starts its card where a worktree does', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launch({
    earlyAccess: true,
  });
  try {
    const gridTop = Math.min(
      ...(await readPanelCards(window)).map((card) => card.top),
    );
    await window
      .getByTestId('app-sidebar')
      .getByRole('button', { name: 'New task', exact: true })
      .first()
      .click();
    const main = window.locator('main[data-main-frame="card-below-bar"]');
    await expect(main).toHaveCount(1);
    await expect
      .poll(async () => (await readFrame(main)).radius)
      .toBe(await expectedCardRadius(window));
    const cardTop = await main.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(cardTop).toBeCloseTo(gridTop, 0);
    const left = await main.evaluate(
      (element) => element.getBoundingClientRect().left,
    );
    expect(await isWindowDragRegion(window, left + 120, 20)).toBe(true);

    // The composer sits in the middle of the card: the scrollbar's reserved
    // strip is matched on the left.
    const insets = await main.evaluate((element) => {
      const card = element.getBoundingClientRect();
      const composer = element
        .querySelector('[data-testid="home-composer"]')
        ?.getBoundingClientRect();
      return composer
        ? {
            left: composer.left - card.left,
            right: card.right - composer.right,
          }
        : null;
    });
    expect(insets).not.toBeNull();
    expect(Math.abs(insets.left - insets.right)).toBeLessThanOrEqual(1);

    await capture(window, 'new-task-after');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the Browser page fills its card and rounds only the card corners', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launch({
    earlyAccess: true,
  });
  try {
    const { panelId } = await seedVisibleBrowserPanel(
      window,
      { projectId: `demo-${APP}`, worktreeId: BRANCH, url: 'about:blank' },
      { originChatTabId: 'inset-chat-1' },
    );
    await expect(window.getByTestId(`panel-tab-${panelId}`)).toBeVisible();
    const pageArea = window.getByTestId('browser-page-area');
    await expect(pageArea).toBeVisible();

    // The native page cannot be clipped by the card, so its area fills the
    // card's body edge to edge, square under the toolbar, and hands the
    // card's bottom corners to the native view.
    const cardRadius = Number.parseFloat(await expectedCardRadius(window));
    const frame = await pageArea.evaluate((element) => {
      const style = getComputedStyle(element);
      const card = element.closest('.canopy-panel-group');
      const rect = element.getBoundingClientRect();
      const cardRect = card?.getBoundingClientRect();
      return {
        radii: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ].map((value) => Number.parseFloat(value)),
        left: cardRect ? rect.left - cardRect.left : null,
        right: cardRect ? cardRect.right - rect.right : null,
        bottom: cardRect ? cardRect.bottom - rect.bottom : null,
      };
    });
    expect(frame.radii[0]).toBe(0);
    expect(frame.radii[1]).toBe(0);
    expect(frame.radii[2]).toBeCloseTo(cardRadius, 1);
    expect(frame.radii[3]).toBeCloseTo(cardRadius, 1);
    expect(frame.left).toBeCloseTo(0, 0);
    expect(frame.right).toBeCloseTo(0, 0);
    expect(frame.bottom).toBeCloseTo(0, 0);

    await capture(window, 'browser-after');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('with early access off the flat layout is unchanged', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launch({
    earlyAccess: false,
  });
  try {
    await expect(window.locator('[data-window-layout]')).toHaveCount(0);
    const frame = await readFrame(window.getByTestId('panel-grid-root'));
    expect(frame.radius).toBe('0px');
    expect(frame.right).toBeCloseTo(0, 0);
    expect(frame.bottom).toBeCloseTo(0, 0);
    expect(
      await readBackground(window.getByTestId('worktree-top-bar')),
    ).not.toBe('rgba(0, 0, 0, 0)');

    await capture(window, 'worktree-before');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
