/**
 * The selected Chats row stays in view while the rail scrolls.
 *
 * Worktree and project-scoped chat selections have always stayed pinned: the
 * rail seats a copy of the selected row beneath its project header once the
 * row would scroll out above, and at the foot of the rail once it would scroll
 * out below. CAN-2363 moved the project-less chats into their own Chats
 * section ABOVE Projects and opted those rows out of that pin, because the pin
 * seats copies against the Projects band and the Chats rows have no project
 * header there. The result was reported from #design: a selected chat simply
 * scrolls away. These specs walk that flow on both desktop rails.
 *
 * Deterministic: workspaces, worktrees, and chat transcripts are seeded on
 * disk before launch. No live agents, no network.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  CHATS_SECTION_DEFAULT_COWORK_ID,
  seedChatsSectionFixture,
} from './seeders/index.mjs';

const SHARED_SIDEBAR_STORAGE_KEY = 'canopy.desktop.sharedSidebar';

async function settleSidebar(viewport) {
  await viewport.evaluate(async (element) => {
    let previousScrollTop = element.scrollTop;
    let stableSince = performance.now();
    const deadline = stableSince + 5_000;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const nextScrollTop = element.scrollTop;
      if (Math.abs(nextScrollTop - previousScrollTop) > 0.01) {
        stableSince = performance.now();
      }
      previousScrollTop = nextScrollTop;
      if (performance.now() - stableSince >= 800) break;
    }
  });
}

async function launchSeeded({ sharedSidebar = false, ...seedOptions } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chats-selected-pin-'),
  );
  const seed = seedChatsSectionFixture(userDataDir, seedOptions);
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
    viewportSize: { width: 900, height: 560 },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  if (sharedSidebar) {
    await window.evaluate((key) => {
      window.localStorage.setItem(key, '1');
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
  }
  return { electronApp, window, seed, userDataDir };
}

/**
 * Every rendering of the selected chat that a user can actually see and
 * click: inside the rail's scroll viewport, below the sticky Chats header,
 * painted (no hidden ancestor, non-zero opacity), and the topmost element at
 * its own centre. The in-flow row and any pinned copy both qualify, so the
 * count also proves the rail never shows the selection twice.
 */
async function reachableSelectedChat(window, entryId) {
  return window.evaluate((id) => {
    const viewport = document.querySelector(
      '[data-testid="sidebar-scroll-container"]',
    );
    const header = document.querySelector('[data-sidebar-chats-header]');
    if (!(viewport instanceof HTMLElement) || !(header instanceof HTMLElement))
      return [];
    const viewportRect = viewport.getBoundingClientRect();
    const headerBottom = header.getBoundingClientRect().bottom;
    const painted = (element) => {
      for (let node = element; node; node = node.parentElement) {
        if (node.hidden) return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden')
          return false;
        if (Number.parseFloat(style.opacity) === 0) return false;
      }
      return true;
    };
    const exact = new RegExp(`^sidebar-work-entry-${id}(-pin-(top|bottom))?$`);
    return Array.from(document.querySelectorAll('[data-testid]'))
      .filter(
        (node) =>
          node instanceof HTMLElement && exact.test(node.dataset.testid ?? ''),
      )
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const centreX = rect.left + rect.width / 2;
        const centreY = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(centreX, centreY);
        return {
          testId: node.dataset.testid,
          top: rect.top,
          bottom: rect.bottom,
          onScreen:
            rect.height > 0 &&
            rect.top >= headerBottom - 1 &&
            rect.bottom <= viewportRect.bottom + 1,
          painted: painted(node),
          topmost: hit instanceof Node && node.contains(hit),
        };
      })
      .filter((copy) => copy.onScreen && copy.painted && copy.topmost);
  }, entryId);
}

async function wheelRail(window, deltaY, steps) {
  const viewport = window.getByTestId('sidebar-scroll-container');
  const box = await viewport.boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let n = 0; n < steps; n += 1) {
    await window.mouse.wheel(0, deltaY);
    await window.waitForTimeout(40);
  }
  await settleSidebar(viewport);
}

/**
 * Scrolls the rail programmatically by the distance `delta` computes from
 * live geometry (the in-flow row's top, the Chats header's bottom, and the
 * Chats list's bottom edge), so a step can land on an exact boundary.
 */
async function scrollRailTo(window, delta, entryId) {
  const viewport = window.getByTestId('sidebar-scroll-container');
  const geometry = await window.evaluate((id) => {
    const header = document.querySelector('[data-sidebar-chats-header]');
    const content = document.querySelector('[data-sidebar-chats-mask]');
    const row = document.querySelector(
      `[data-testid="sidebar-work-entry-${id}"]`,
    );
    return {
      headerBottom: header?.getBoundingClientRect().bottom ?? 0,
      contentBottom: content?.getBoundingClientRect().bottom ?? 0,
      rowTop: row?.getBoundingClientRect().top ?? 0,
    };
  }, entryId);
  await viewport.evaluate((node, by) => {
    node.scrollTop += by;
  }, delta(geometry));
  await settleSidebar(viewport);
}

/** The chat rows' entry ids, in the order the Chats section renders them. */
async function renderedChatIds(window) {
  return window
    .getByTestId('sidebar-section-chats-content')
    .evaluate((content) =>
      Array.from(content.querySelectorAll('[data-standalone-chat-id]')).map(
        (row) => row.getAttribute('data-standalone-chat-id'),
      ),
    );
}

async function selectChat(window, entryId) {
  await window.getByTestId(`sidebar-work-entry-${entryId}`).click();
  await expect(
    window.getByTestId(`sidebar-work-entry-${entryId}`),
  ).toHaveAttribute('data-sidebar-selected-item', '');
}

async function expectPinnedBelowChatsHeader(window, entryId) {
  const reachable = await reachableSelectedChat(window, entryId);
  expect(reachable).toHaveLength(1);
  // A copy, not the in-flow row: the list itself scrolled away.
  expect(reachable[0].testId).toBe(`sidebar-work-entry-${entryId}-pin-top`);
  const layout = await window.evaluate(() => {
    const header = document.querySelector('[data-sidebar-chats-header]');
    const band = document.querySelector(
      '[data-testid="sidebar-more-sticky-container"]',
    );
    return {
      headerBottom: header?.getBoundingClientRect().bottom ?? null,
      bandTop: band?.getBoundingClientRect().top ?? null,
    };
  });
  // Seated directly under its own header, and the Projects band stacks below
  // it instead of drawing over it.
  expect(Math.abs(reachable[0].top - layout.headerBottom)).toBeLessThanOrEqual(
    1,
  );
  expect(layout.bandTop).toBeGreaterThanOrEqual(reachable[0].bottom - 1);
}

/**
 * The pin surface does not occlude on its own (it is frosted, not painted, on
 * the translucent sidebar), so the Chats list must be masked off from the
 * pin's top edge down.
 */
async function expectChatsCutAtBottomPin(window) {
  const cut = await window.evaluate(() => {
    const content = document.querySelector('[data-sidebar-chats-mask]');
    const pin = document.querySelector('[data-sidebar-selected-pin-bottom]');
    if (!(content instanceof HTMLElement) || !(pin instanceof HTMLElement)) {
      return null;
    }
    return {
      needed: Math.max(
        0,
        content.getBoundingClientRect().bottom -
          pin.getBoundingClientRect().top,
      ),
      applied: Number.parseFloat(
        getComputedStyle(content).getPropertyValue(
          '--sidebar-chats-bottom-cut',
        ),
      ),
    };
  });
  expect(cut).not.toBeNull();
  expect(cut.needed).toBeGreaterThan(0);
  expect(cut.applied).toBeGreaterThanOrEqual(cut.needed - 1);
}

for (const sharedSidebar of [false, true]) {
  const rail = sharedSidebar ? 'shared rail' : 'legacy rail';

  test(`${rail}: the selected chat pins under the Chats header while Projects scroll`, async () => {
    test.setTimeout(180_000);
    const { electronApp, window, seed, userDataDir } = await launchSeeded({
      sharedSidebar,
      worktreeCount: 40,
      chatEntryCount: 8,
    });
    try {
      const viewport = window.getByTestId('sidebar-scroll-container');
      await settleSidebar(viewport);
      const [entryId] = await renderedChatIds(window);
      expect(seed.chatEntryIds).toContain(entryId);
      await selectChat(window, entryId);
      await settleSidebar(viewport);

      // At rest the in-flow row is the only rendering.
      const atRest = await reachableSelectedChat(window, entryId);
      expect(atRest.map((copy) => copy.testId)).toEqual([
        `sidebar-work-entry-${entryId}`,
      ]);

      // Deep into the project list: every chat row has scrolled under the
      // Chats header, and the Projects band is stuck.
      await wheelRail(window, 200, 12);
      expect(await viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(
        400,
      );
      await expectPinnedBelowChatsHeader(window, entryId);

      // The copy is the real row: activating it keeps the chat open.
      await window
        .getByTestId(`sidebar-work-entry-${entryId}-pin-top`)
        .evaluate((node) => {
          if (!(node instanceof HTMLElement)) throw new Error('no copy');
          node.click();
        });
      await expect(
        window.getByTestId(`sidebar-work-entry-${entryId}`),
      ).toHaveAttribute('data-sidebar-selected-item', '');

      // Released while still scrolled: once the row clears the header again
      // the copy stands down in the same pass, with no double rendering.
      await scrollRailTo(
        window,
        (geometry) => geometry.rowTop - (geometry.headerBottom + 10),
        entryId,
      );
      expect(await viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(
        0,
      );
      const released = await reachableSelectedChat(window, entryId);
      expect(released.map((copy) => copy.testId)).toEqual([
        `sidebar-work-entry-${entryId}`,
      ]);

      // The copy occludes the rows too: with only the list's tail behind it,
      // the header announces the way back — and a click must take it rather
      // than collapse the section.
      await scrollRailTo(
        window,
        (geometry) => geometry.contentBottom - (geometry.headerBottom + 10),
        entryId,
      );
      await expectPinnedBelowChatsHeader(window, entryId);
      const toggle = window.getByTestId('sidebar-section-chats-toggle');
      await expect(toggle).toHaveAttribute('aria-label', /^Back to /);
      const toggleBox = await toggle.boundingBox();
      expect(toggleBox).not.toBeNull();
      await window.mouse.click(
        toggleBox.x + toggleBox.width / 2,
        toggleBox.y + toggleBox.height / 2,
      );
      await settleSidebar(viewport);
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(
        await viewport.evaluate((node) => node.scrollTop),
      ).toBeLessThanOrEqual(1);

      // Back at the top the pin stands down and the row is in flow again.
      await wheelRail(window, -200, 20);
      expect(await viewport.evaluate((node) => node.scrollTop)).toBe(0);
      const restored = await reachableSelectedChat(window, entryId);
      expect(restored.map((copy) => copy.testId)).toEqual([
        `sidebar-work-entry-${entryId}`,
      ]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const sharedSidebar of [false, true]) {
  const rail = sharedSidebar ? 'shared rail' : 'legacy rail';

  test(`${rail}: a selected chat below the fold pins to the foot of the rail`, async () => {
    test.setTimeout(180_000);
    const { electronApp, window, seed, userDataDir } = await launchSeeded({
      sharedSidebar,
      worktreeCount: 12,
      chatEntryCount: 40,
    });
    try {
      const viewport = window.getByTestId('sidebar-scroll-container');
      await settleSidebar(viewport);
      await window
        .getByTestId(
          `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all`,
        )
        .click();
      await settleSidebar(viewport);
      const entryId = (await renderedChatIds(window))[30];
      expect(seed.chatEntryIds).toContain(entryId);
      await selectChat(window, entryId);
      await settleSidebar(viewport);

      // Back to the top: the selection is now far below the fold.
      await wheelRail(window, -200, 20);
      expect(await viewport.evaluate((node) => node.scrollTop)).toBe(0);

      const reachable = await reachableSelectedChat(window, entryId);
      expect(reachable).toHaveLength(1);
      expect(reachable[0].testId).toBe(
        `sidebar-work-entry-${entryId}-pin-bottom`,
      );
      // No project header is pinned with it: the Chats header already names
      // the section, and it is still on screen at the top of the rail.
      await expect(
        window.locator(
          '[data-sidebar-selected-pin-bottom] [data-sidebar-selected-pin-part="header"]',
        ),
      ).toBeHidden();
      // The rows under the pin are cut away rather than painting through it.
      await expectChatsCutAtBottomPin(window);

      // A layout pass at rest (here a window resize) re-derives the pin without
      // any scroll, and must keep the cut too.
      await window.setViewportSize({ width: 900, height: 540 });
      await settleSidebar(viewport);
      const afterLayout = await reachableSelectedChat(window, entryId);
      expect(afterLayout.map((copy) => copy.testId)).toEqual([
        `sidebar-work-entry-${entryId}-pin-bottom`,
      ]);
      await expectChatsCutAtBottomPin(window);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const sharedSidebar of [false, true]) {
  const rail = sharedSidebar ? 'shared rail' : 'legacy rail';

  // A collapsed project keeps exactly its selected row under its header. The
  // Chats section collapsed everything, so collapsing it while one of its
  // chats was open made the selection vanish from the rail.
  test(`${rail}: collapsing Chats keeps only the selected chat`, async () => {
    test.setTimeout(180_000);
    const { electronApp, window, seed, userDataDir } = await launchSeeded({
      sharedSidebar,
      worktreeCount: 40,
      chatEntryCount: 8,
    });
    try {
      const viewport = window.getByTestId('sidebar-scroll-container');
      const toggle = window.getByTestId('sidebar-section-chats-toggle');
      const content = window.getByTestId('sidebar-section-chats-content');
      await settleSidebar(viewport);
      const listed = await renderedChatIds(window);
      expect(listed.length).toBeGreaterThan(2);
      const entryId = listed[2];
      expect(seed.chatEntryIds).toContain(entryId);

      // Nothing in Chats selected yet: a collapse hides every row.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(content).toHaveCount(0);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await selectChat(window, entryId);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await settleSidebar(viewport);

      // Exactly the selected chat stays, in flow under the header.
      const collapsed = await reachableSelectedChat(window, entryId);
      expect(collapsed.map((copy) => copy.testId)).toEqual([
        `sidebar-work-entry-${entryId}`,
      ]);
      expect(await renderedChatIds(window)).toEqual([entryId]);
      await expect(
        window.getByTestId(
          `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all`,
        ),
      ).toHaveCount(0);

      // Scrolled deep, it pins under the header like an expanded selection,
      // and the header is stuck over its one kept row exactly as it is over
      // an expanded list: it offers the way back to Chats, and a click takes
      // it rather than expanding the section.
      await wheelRail(window, 200, 12);
      expect(await viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(
        400,
      );
      await expectPinnedBelowChatsHeader(window, entryId);
      await expect(window.getByTestId('sidebar-section-chats')).toHaveAttribute(
        'data-sidebar-chats-stuck',
        'true',
      );
      await expect(toggle).not.toHaveAttribute('aria-expanded', /.*/);
      await expect(toggle).toHaveAttribute('aria-label', /^Back to /);
      const stuckRotate = await window
        .getByTestId('sidebar-chats-chevron')
        .evaluate((node) => getComputedStyle(node).rotate);
      expect(stuckRotate).toBe('180deg');
      // Through the real mouse: `locator.click()` scrolls its target into
      // view first, which would un-stick the header before the click lands.
      const stuckBox = await toggle.boundingBox();
      expect(stuckBox).not.toBeNull();
      await window.mouse.click(
        stuckBox.x + stuckBox.width / 2,
        stuckBox.y + stuckBox.height / 2,
      );
      await expect
        .poll(() => viewport.evaluate((node) => node.scrollTop))
        .toBeLessThanOrEqual(1);
      await settleSidebar(viewport);
      // Still collapsed, back at its section, its one row in flow and the
      // pinned copy stood down: a single copy of the selection.
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).not.toHaveAttribute('aria-label', /^Back to /);
      expect(await renderedChatIds(window)).toEqual([entryId]);
      const returned = await reachableSelectedChat(window, entryId);
      expect(returned.map((copy) => copy.testId)).toEqual([
        `sidebar-work-entry-${entryId}`,
      ]);

      // Not stuck, the header is the disclosure again: a click expands.
      const restBox = await toggle.boundingBox();
      expect(restBox).not.toBeNull();
      await window.mouse.click(
        restBox.x + restBox.width / 2,
        restBox.y + restBox.height / 2,
      );
      await expect
        .poll(async () => (await renderedChatIds(window)).length)
        .toBeGreaterThan(1);

      // Expanding restores the full list, the selection still marked.
      expect(await viewport.evaluate((node) => node.scrollTop)).toBe(0);
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const restored = await renderedChatIds(window);
      expect(restored.length).toBeGreaterThan(1);
      expect(restored).toContain(entryId);
      const expanded = await reachableSelectedChat(window, entryId);
      expect(expanded.map((copy) => copy.testId)).toEqual([
        `sidebar-work-entry-${entryId}`,
      ]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
