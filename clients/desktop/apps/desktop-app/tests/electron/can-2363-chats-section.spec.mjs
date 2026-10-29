/**
 * CAN-2363 — the sidebar's top-level Chats section.
 *
 * The default Cowork workspace is the catch-all for project-less chats, so it
 * no longer renders as a workspace row in the Projects list. Its Work Entries
 * render flat under a "Chats" section placed ABOVE the Projects list, capped
 * to the most recent few with the rest behind a "Show all" toggle so it stays
 * short.
 *
 * Deterministic: workspaces, worktrees, and chat transcripts are seeded on
 * disk before launch. No live agents, no network.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedChatsSectionFixture,
  CHATS_SECTION_DEFAULT_COWORK_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
} from './seeders/index.mjs';

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

async function launchSeeded(options = {}) {
  const { viewportSize = { width: 900, height: 560 }, ...seedOptions } =
    options;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chats-section-'),
  );
  const seed = seedChatsSectionFixture(userDataDir, seedOptions);
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize,
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  return { electronApp, window, app, seed, userDataDir };
}

test('lists project-less chats above the Projects list, capped', async () => {
  test.setTimeout(120_000);
  const { electronApp, window, userDataDir, seed } = await launchSeeded();

  try {
    const viewport = window.getByTestId('sidebar-scroll-container');
    const chatsSection = window.getByTestId('sidebar-section-chats');
    await expect(chatsSection).toBeVisible();
    await expect(chatsSection).toContainText('Chats');
    // CAN-3898: cloud tree-owner support must preserve the desktop's flat
    // catch-all rows and must not add a second project wrapper or tree rows.
    await expect(chatsSection.locator('[data-worktree-id]')).toHaveCount(0);
    await expect(
      chatsSection.locator('[data-standalone-chat-id]'),
    ).not.toHaveCount(0);
    // CAN-2989: desktop omits the optional shared empty-Projects slot. The
    // web account card must never appear in the existing desktop rail.
    await expect(
      window.getByTestId('portal-sidebar-guest-projects-card'),
    ).toHaveCount(0);
    await settleSidebar(viewport);

    // The default workspace contributes rows, not a workspace header.
    await expect(
      window.getByTestId(
        `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-header`,
      ),
    ).toHaveCount(0);

    // Only the most recent few show; the rest hide behind "Show all".
    const rows = window
      .getByTestId('sidebar-section-chats-content')
      .locator('[data-standalone-chat-id]');
    await expect(rows).toHaveCount(5);
    const showAll = window.getByTestId(
      `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all`,
    );
    // Label and count are separate elements: the count sits in the trailing
    // counter slot the project rows use, so the button's text runs them
    // together. The accessible name carries the whole phrase.
    await expect(showAll).toContainText('Show all');
    await expect(showAll).toHaveAttribute(
      'aria-label',
      `Show all ${seed.chatEntryIds.length} chats`,
    );
    await expect(
      showAll.getByTestId(
        `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all-count`,
      ),
    ).toHaveText(String(seed.chatEntryIds.length));
    await showAll.click();
    await expect(rows).toHaveCount(seed.chatEntryIds.length);
    await showAll.click();
    await expect(rows).toHaveCount(5);

    // A named Cowork workspace is still an ordinary Projects row.
    await expect(
      window.getByTestId(
        `sidebar-cowork-project-${CHATS_SECTION_NAMED_COWORK_ID}-header`,
      ),
    ).toBeAttached();

    // Chats sits ABOVE the Projects section, inside the masked scrolling nav
    // block so it fades as it passes beneath the sticky Projects controls.
    const order = await window.evaluate(() => {
      const chats = document.querySelector(
        '[data-testid="sidebar-section-chats"]',
      );
      const projects = document.querySelector(
        '[data-testid="sidebar-section-code"]',
      );
      if (!chats || !projects) return null;
      return {
        chatsBeforeProjects: Boolean(
          chats.compareDocumentPosition(projects) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        chatsCarriesScrollMask: Boolean(
          document.querySelector(
            '[data-testid="sidebar-section-chats-content"][data-sidebar-chats-mask]',
          ),
        ),
        chatsOutsideProjects: !projects.contains(chats),
      };
    });
    expect(order).toEqual({
      chatsBeforeProjects: true,
      chatsCarriesScrollMask: true,
      chatsOutsideProjects: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pins Projects to the foot of the rail once the chat list is expanded', async () => {
  // Chats sits ABOVE the project list in one scroll flow, so "Show all" on a
  // long history leaves the Projects band hundreds of rows down. Sticky cannot
  // rescue it — sticky never lifts an element above its own place in the flow
  // — and Chats must stay a top-level sibling of Projects, so the band cannot
  // be nested into a taller containing block either. The rail pins a stand-in
  // at its foot instead.
  const { electronApp, window, userDataDir } = await launchSeeded({
    chatEntryCount: 60,
  });
  try {
    const viewport = window.getByTestId('sidebar-scroll-container');
    await settleSidebar(viewport);

    const pin = window.getByTestId('sidebar-projects-pin-bottom');
    // No at-rest assertion here: this fixture's rail is 560px tall and the nav
    // rows plus the capped chat list already push the band past the fold, so
    // the pin is legitimately up before "Show all" is touched. What the pin
    // owes is checked below — it is pinned while the band is away, and it is a
    // way back rather than a label.

    await window
      .getByTestId(
        `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all`,
      )
      .click();
    await settleSidebar(viewport);

    await expect(pin).toBeVisible();
    const geometry = await pin.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const host = document.querySelector(
        '[data-testid="sidebar-scroll-container"]',
      );
      const hostRect = host.getBoundingClientRect();
      const root = document.querySelector('[data-testid="app-sidebar"]');
      return {
        pinBottom: rect.bottom,
        pinTop: rect.top,
        hostBottom: hostRect.bottom,
        rootBottom: root.getBoundingClientRect().bottom,
      };
    });
    // Both bounds matter, and both are asserted. `toBeVisible()` does not
    // check viewport intersection, so an element that has scrolled far BELOW
    // the rail satisfies a lower bound alone — which is exactly how the first
    // version of this test passed against the broken build.
    // Directly beneath the scroll viewport, not floating over it:
    expect(geometry.pinTop).toBeGreaterThanOrEqual(geometry.hostBottom - 2);
    // ...and still inside the sidebar's own box, not somewhere below it:
    expect(geometry.pinBottom).toBeLessThanOrEqual(geometry.rootBottom + 1);
    // No mask, no clip, no per-frame work: the pin sits outside the scroll
    // viewport, so nothing renders behind it. An overlay would have to cut the
    // rows passing underneath — a mask re-rasterised over a multi-thousand
    // pixel layer on every scroll frame, which is what made scrolling stutter
    // and tear when this was first built as an overlay.
    const scrollCost = await window
      .getByTestId('sidebar-section-chats-content')
      // Only the bottom cut is asserted. The section keeps its ordinary
      // top fade mask in every state, so `mask-image` being set says nothing
      // about whether the stand-in costs a per-frame clip.
      .evaluate((node) => ({
        cut: getComputedStyle(node)
          .getPropertyValue('--sidebar-chats-bottom-cut')
          .trim(),
      }));
    expect(
      scrollCost.cut === '' || Number.parseFloat(scrollCost.cut) === 0,
    ).toBe(true);

    // It is a way back, not just a label.
    await pin.click();
    await settleSidebar(viewport);
    const band = window.getByTestId('sidebar-more-sticky-container');
    const returned = await band.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const host = document.querySelector(
        '[data-testid="sidebar-scroll-container"]',
      );
      const hostRect = host.getBoundingClientRect();
      return {
        top: rect.top,
        hostBottom: hostRect.bottom,
      };
    });
    expect(returned.top).toBeLessThan(returned.hostBottom);
    await expect(pin).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('collapses the Chats section and restores it after a relaunch', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chats-collapse-'),
  );
  seedChatsSectionFixture(userDataDir);

  const first = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 560 },
  });
  try {
    const window = await first.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const toggle = window.getByTestId('sidebar-section-chats-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      window.getByTestId('sidebar-section-chats-content'),
    ).toBeAttached();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The preference write is fire-and-forget, so poll for it rather than
    // reading once immediately after the click.
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const prefs = await window.api.loadPreferences();
          return prefs.sidebarCoworkSectionCollapsed;
        }),
      )
      .toBe(true);
    await expect(
      window.getByTestId('sidebar-section-chats-content'),
    ).toHaveCount(0);
    // The header itself stays reachable while collapsed.
    await expect(window.getByTestId('sidebar-section-chats')).toBeVisible();
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // The collapse is a persisted preference, not component state.
  const second = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 560 },
  });
  try {
    const window = await second.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const toggle = window.getByTestId('sidebar-section-chats-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(
      window.getByTestId('sidebar-section-chats-content'),
    ).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      window.getByTestId('sidebar-section-chats-content'),
    ).toBeAttached();
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('shows the Projects pin when the rail layout is first measured mid-scroll', async () => {
  // Regression for the defect the test above structurally cannot reach.
  //
  // That fixture is short enough that the band is already past the fold at
  // rest, so the pin is up before anything is scrolled. This one starts TALL,
  // with the band comfortably on screen and the pin legitimately down, and
  // only then expands the list and scrolls. That ordering matters: the rail
  // layout cache is deliberately deferred while `scrollTop === 0`, so it is
  // built on the first real scroll — at which point the Projects band is
  // already stuck to the top of the viewport.
  //
  // The visibility test used to measure the band's own `offsetTop`, and Blink
  // reports a stuck element's `offsetTop` at its STUCK position. Cached that
  // way, the number slid with the scroll instead of naming a fixed flow
  // position, `flowTop - scrollTop` only ever shrank, and the pin never
  // appeared — an expanded chat list left Projects unreachable exactly as
  // before the pin existed.
  test.setTimeout(120_000);
  // 200 entries, not 60. At 60 the whole scroll content is ~1473px against a
  // 737px viewport, so the band lands roughly ONE viewport down and stays
  // reachable — the pin is correctly never needed and the test proves nothing.
  // The state being tested only exists once the chat list is long enough to
  // push Projects more than a full viewport below the fold.
  const { electronApp, window, userDataDir } = await launchSeeded({
    chatEntryCount: 200,
    viewportSize: { width: 900, height: 900 },
  });
  try {
    const viewport = window.getByTestId('sidebar-scroll-container');
    await settleSidebar(viewport);
    const pin = window.getByTestId('sidebar-projects-pin-bottom');

    // At rest the band is on screen, so the rail owes no stand-in.
    await expect(pin).toBeHidden();

    const showAll = window.getByTestId(
      `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all`,
    );
    await showAll.waitFor({ timeout: 30_000 });
    await showAll.click();
    await settleSidebar(viewport);

    // Visit Projects first, THEN come back up. This ordering is the whole
    // point: the rail layout cache is built on the first non-zero scroll, and
    // landing at the bottom builds it while the Projects band is STUCK to the
    // top of the viewport. Measuring the band there records its stuck position
    // rather than its flow position, and every later comparison inherits that
    // wrong origin. Building the cache on the way down — with the band still
    // far below in normal flow — reads correctly and hides the defect, which
    // is why an earlier version of this test passed against the broken build.
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await settleSidebar(viewport);
    await viewport.evaluate((element) => {
      element.scrollTop = 200;
    });
    await settleSidebar(viewport);

    const geometry = await viewport.evaluate((element) => {
      const host = element.getBoundingClientRect();
      // The Projects band: its header, which sits at the section's flow top
      // on both rails (the shared rail's list wrapper is boxless).
      const section = element.querySelector('[data-sidebar-projects-header]');
      return {
        scrollTop: Math.round(element.scrollTop),
        clientHeight: Math.round(element.clientHeight),
        bandTopRelViewport: section
          ? Math.round(section.getBoundingClientRect().top - host.top)
          : null,
      };
    });
    // Precondition: the band really is off the bottom, so a hidden pin here
    // would be the defect rather than a legitimately reachable band.
    expect(geometry.bandTopRelViewport).toBeGreaterThanOrEqual(
      geometry.clientHeight,
    );
    await expect(pin).toBeVisible();

    // And it is still a way back, not just a label.
    await pin.click();
    await settleSidebar(viewport);
    await expect(pin).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pins Projects as soon as the chat list expands, before any scroll', async () => {
  // The rail layout cache is deliberately deferred while `scrollTop === 0`, so
  // `syncStickyWorkspaceRail` — the only thing that moves the stand-in — never
  // runs at rest. Expanding Chats pushes Projects below the fold WITHOUT
  // moving the scroll position, so the stand-in has to appear on that layout
  // pass or Projects stays unreachable until the user happens to scroll,
  // which is the reachability bug this whole feature exists to fix.
  test.setTimeout(120_000);
  const { electronApp, window, userDataDir } = await launchSeeded({
    chatEntryCount: 200,
    viewportSize: { width: 900, height: 900 },
  });
  try {
    const viewport = window.getByTestId('sidebar-scroll-container');
    await settleSidebar(viewport);
    const pin = window.getByTestId('sidebar-projects-pin-bottom');
    await expect(pin).toBeHidden();

    const showAll = window.getByTestId(
      `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all`,
    );
    await showAll.waitFor({ timeout: 30_000 });
    await showAll.click();
    await settleSidebar(viewport);

    const geometry = await viewport.evaluate((element) => {
      const host = element.getBoundingClientRect();
      // The Projects band: its header, which sits at the section's flow top
      // on both rails (the shared rail's list wrapper is boxless).
      const section = element.querySelector('[data-sidebar-projects-header]');
      return {
        scrollTop: Math.round(element.scrollTop),
        clientHeight: Math.round(element.clientHeight),
        bandTopRelViewport: section
          ? Math.round(section.getBoundingClientRect().top - host.top)
          : null,
      };
    });
    // Nothing scrolled, and the band really is gone from view.
    expect(geometry.scrollTop).toBe(0);
    expect(geometry.bandTopRelViewport).toBeGreaterThanOrEqual(
      geometry.clientHeight,
    );
    await expect(pin).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('returns to the chat list when the stuck Chats header is clicked', async () => {
  // The Chats header stays pinned at the top of the rail after the Projects
  // stand-in has jumped the view down past every chat row. In that state the
  // header is the only Chats surface left on screen, so clicking it must be
  // the way back — the mirror of the Projects stand-in — rather than a
  // collapse that hides the rows the user was trying to reach.
  test.setTimeout(120_000);
  const { electronApp, window, userDataDir } = await launchSeeded({
    chatEntryCount: 60,
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

    const pin = window.getByTestId('sidebar-projects-pin-bottom');
    await expect(pin).toBeVisible();
    await pin.click();
    await settleSidebar(viewport);
    expect(await viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(
      0,
    );

    const header = window.getByTestId('sidebar-section-chats');
    const toggle = window.getByTestId('sidebar-section-chats-toggle');
    // The rail advertises the state that changes what the click means.
    await expect(header).toHaveAttribute('data-sidebar-chats-stuck', 'true');
    // Stuck, the control is no longer a disclosure, and it says so rather
    // than announcing an expanded state that activating it will not change.
    await expect(toggle).not.toHaveAttribute('aria-expanded', /.*/);
    await expect(toggle).toHaveAttribute('aria-label', /^Back to /);
    // And shows it, the way the Projects stand-in shows its own chevron. The
    // pointer is still down at the footer, so nothing here is hover state.
    const chevron = window.getByTestId('sidebar-chats-chevron');
    const stuckChevron = await chevron.evaluate((node) => {
      const style = getComputedStyle(node);
      // Tailwind v4 emits `rotate-*` as the standalone `rotate` property, not
      // a `transform` matrix, so `transform` stays `none` here.
      return { opacity: style.opacity, rotate: style.rotate };
    });
    expect(Number.parseFloat(stuckChevron.opacity)).toBe(1);
    // Pointing back up at the rows, not down at Projects.
    expect(stuckChevron.rotate).toBe('180deg');

    // Driven through the real mouse rather than `locator.click()`. Playwright
    // scrolls a target into view before every click, and the sticky header
    // sits inside the rail's `scroll-padding-top`, so that courtesy scroll
    // moves the rail ~200px — past the very boundary this test is about, and
    // the assertion then measures a state no user ever produces. `page.mouse`
    // dispatches trusted events at a coordinate and scrolls nothing.
    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    const scrollBeforeClick = await viewport.evaluate((node) => node.scrollTop);
    await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // Focusing a control can also scroll it into view. Nothing may move the
    // rail between the press and the handler's measurement, or the header
    // reads its own list as visible and collapses it.
    await settleSidebar(viewport);
    expect(scrollBeforeClick).toBeGreaterThan(0);

    // Back at the chats, still expanded — and a disclosure control again.
    expect(
      await viewport.evaluate((node) => node.scrollTop),
    ).toBeLessThanOrEqual(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).not.toHaveAttribute('aria-label', /.*/);
    await expect(
      window.getByTestId('sidebar-section-chats-content'),
    ).toBeAttached();
    await expect(header).not.toHaveAttribute(
      'data-sidebar-chats-stuck',
      'true',
    );
    // Opacity is hover state now that the pointer rests on the header, so the
    // rotation carries the claim: the chevron is no longer a way back.
    expect(
      await chevron.evaluate((node) => getComputedStyle(node).rotate),
    ).toBe('none');

    // The at-rest sync owns clearing the mark, because the scroll sync it is
    // published from is skipped at `scrollTop === 0`. Left set, it would
    // mislabel the control, not merely rotate a chevron.
    expect(
      await header.evaluate((node) =>
        node.hasAttribute('data-sidebar-chats-stuck'),
      ),
    ).toBe(false);

    // With the rows back in view the header is an ordinary collapse control
    // again — the reveal replaces the collapse only while it is stuck.
    const restBox = await toggle.boundingBox();
    expect(restBox).not.toBeNull();
    await window.mouse.click(
      restBox.x + restBox.width / 2,
      restBox.y + restBox.height / 2,
    );
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(
      window.getByTestId('sidebar-section-chats-content'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
