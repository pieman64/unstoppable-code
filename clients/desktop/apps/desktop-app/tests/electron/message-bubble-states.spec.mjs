import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Message bubble surface — durable regression coverage for the chat user
// bubble rework (PR #2529).
//
// `CollapsibleUserMessageContent` clamps a long user message to four rows —
// three fully visible plus a fourth faded out under a mask — behind a Show
// more pill that is revealed on hover. `StickyUserMessageHeader` hoists a
// section's head user message so it pins while that section scrolls. This
// spec pins the parts unit tests cannot reach, because they depend on real
// layout: the clamp only engages against a measured line-height, the pill's
// reveal is a computed opacity transition, and the pin only means anything
// inside a real scrolling transcript.
//
// Two surfaces are exercised:
//   1. The dev/E2E-only Message Bubbles gallery, which renders the real
//      components in every state via direct props (short, long, queued).
//   2. A seeded worktree transcript, which is the only place the sticky
//      section header actually pins.
//
// Determinism: the gallery is a pure props-driven catalog, and the transcript
// is seeded on disk. No live agents, no provider calls, no network.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'bubble-states-chat';

/** A user message tall enough to overflow the four-row clamp. */
const LONG_PROMPT = Array.from(
  { length: 12 },
  (_, index) =>
    `Paragraph ${index + 1}: pasted specs and stack traces run long, so the bubble clamps and offers Show more rather than growing without bound.`,
).join('\n\n');

function seedLongTranscript(userDataDir) {
  const turn = (index) => [
    {
      id: `user-${index}`,
      role: 'user',
      timestamp: 1_700_000_000_000 + index * 1000,
      blocks: [
        {
          type: 'text',
          text: index === 0 ? LONG_PROMPT : `Follow-up prompt ${index}`,
        },
      ],
    },
    {
      id: `assistant-${index}`,
      role: 'assistant',
      timestamp: 1_700_000_000_500 + index * 1000,
      blocks: [
        {
          type: 'text',
          // Long enough that each turn can fill the viewport, which is what
          // makes the preceding bubble pin and then get pushed off.
          text: Array.from(
            { length: 24 },
            (_, line) => `Reply ${index} line ${line + 1}.`,
          ).join('\n\n'),
        },
      ],
    },
    // Two tool calls per turn, so each section renders the collapsed
    // indicator strip whose expand-and-scroll behavior is asserted below.
    // Each call has its result: a settled turn counts a resultless call as
    // interrupted (CAN-5178).
    ...[1, 2].map((step) => ({
      id: `tool-${index}-${step}`,
      role: 'assistant',
      timestamp: 1_700_000_000_200 + index * 1000 + step,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: `tool-use-${index}-${step}`,
          toolName: 'Bash',
          input: '{"command":"ls"}',
        },
        {
          type: 'tool_result',
          toolUseId: `tool-use-${index}-${step}`,
          toolName: 'Bash',
          output: 'README.md',
          isError: false,
        },
      ],
    })),
    {
      id: `timer-${index}`,
      role: 'system',
      timestamp: 1_700_000_001_000 + index * 1000,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: 1_700_000_000_000 + index * 1000,
          completedAt: 1_700_000_001_000 + index * 1000,
        },
      ],
    },
  ];

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Bubble states',
        providerType: 'claude',
        // Enough turns to cross MIN_VIRTUALIZED_TRANSCRIPT_ITEMS, so the
        // transcript virtualizes. That matters: expanding a turn re-measures
        // its rows and repositions every later one, which invalidates any
        // scroll offset captured before the relayout.
        messages: Array.from({ length: 24 }, (_, index) => turn(index)).flat(),
      },
    ],
  });
}

let sharedLongTranscriptHarness;

async function resetSharedLongTranscriptHarness() {
  const { app, window } = sharedLongTranscriptHarness;
  await window.emulateMedia({ reducedMotion: 'no-preference' });
  await window.mouse.move(5, 5);
  await app.openMainPage();
  await window
    .locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"][data-project-id="${WORKSPACE_ID}"]`,
    )
    .click();
  const scroller = window.getByTestId('chat-message-list-scroll');
  await expect(scroller).toBeVisible({ timeout: 20_000 });
  const expanded = window.locator(
    'button[aria-label^="Agent steps"][aria-expanded="true"]',
  );
  while ((await expanded.count()) > 0) {
    await expanded.first().click();
  }
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
}

async function getSharedLongTranscriptHarness() {
  if (!sharedLongTranscriptHarness) {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-bubble-shared-transcript-e2e-'),
    );
    seedDemoWorkspaces({ userDataDir });
    seedLongTranscript(userDataDir);
    const launched = await launchCanopy({ userDataDir });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    sharedLongTranscriptHarness = { ...launched, window, app };
  }
  await resetSharedLongTranscriptHarness();
  return sharedLongTranscriptHarness;
}

async function closeBubbleFixture(electronApp, userDataDir) {
  if (sharedLongTranscriptHarness?.electronApp === electronApp) {
    await resetSharedLongTranscriptHarness();
    return;
  }
  await closeCanopy(electronApp, userDataDir);
}

test.afterAll(async () => {
  if (sharedLongTranscriptHarness) {
    await closeCanopy(
      sharedLongTranscriptHarness.electronApp,
      sharedLongTranscriptHarness.userDataDir,
    );
  }
});

test('message bubble gallery clamps long content behind a hover-revealed toggle', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-bubble-gallery-e2e-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await window.evaluate(() => {
      const measured = new WeakSet();
      const OriginalResizeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends OriginalResizeObserver {
        constructor(callback) {
          super((entries, observer) => {
            for (const entry of entries) measured.add(entry.target);
            callback(entries, observer);
          });
        }
      };
      const read = Element.prototype.getBoundingClientRect;
      window.__earlyPromptGeometryReads = 0;
      Element.prototype.getBoundingClientRect = function () {
        if (
          this.getAttribute('data-testid') === 'user-message-content' &&
          !measured.has(this)
        )
          window.__earlyPromptGeometryReads += 1;
        return read.call(this);
      };
    });
    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
    // Every dev page lives behind one More entry with tabs.
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-message-bubble-states').click();

    await expect(
      window.getByTestId('page-message-bubble-states'),
    ).toBeVisible();

    // A short prompt fits, so it must carry no toggle AND no height cap —
    // clamping without a toggle would hide content unreachably.
    const shortRow = window.getByTestId('bubble-gallery-row-short-text');
    await expect(shortRow).toBeVisible();
    await expect(shortRow.getByTestId('user-message-show-more')).toHaveCount(0);

    // The long fixture clamps and offers Show more.
    const longRow = window.getByTestId('bubble-gallery-row-very-long');
    const showMore = longRow.getByTestId('user-message-show-more');
    await expect(showMore).toContainText('Show more');
    await expect(showMore).toHaveAttribute('aria-expanded', 'false');

    // `user-message-content` is the clamped box itself.
    const content = longRow.getByTestId('user-message-content');
    await expect(content).toHaveAttribute('data-collapsed', 'true');
    expect(await window.evaluate(() => window.__earlyPromptGeometryReads)).toBe(
      0,
    );

    // The clamp is expressed in real line boxes, not `line-height × 4`:
    // paragraph margins make that product drift and land the cut mid-row.
    // Measuring the rendered rows here is what proves the fix — an
    // off-by-one row reads as "three lines" to the eye.
    const clampMetrics = await content.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const originTop = el.getBoundingClientRect().top;
      const boxes = [];
      for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
      ) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.height <= 0 || rect.width <= 0) continue;
          boxes.push({
            top: rect.top - originTop,
            bottom: rect.bottom - originTop,
          });
        }
      }
      boxes.sort((a, b) => a.top - b.top);
      const rows = [];
      for (const box of boxes) {
        const previous = rows[rows.length - 1];
        if (previous && Math.abs(previous.top - box.top) < 1) {
          previous.bottom = Math.max(previous.bottom, box.bottom);
          continue;
        }
        rows.push({ ...box });
      }
      return {
        height: el.getBoundingClientRect().height,
        rows,
        maskImage: window.getComputedStyle(el).maskImage,
      };
    });

    // More content than the clamp shows, and four rows start inside it.
    expect(clampMetrics.rows.length).toBeGreaterThan(4);
    const rowsStartedInsideClamp = clampMetrics.rows.filter(
      (row) => row.top < clampMetrics.height - 1,
    );
    expect(rowsStartedInsideClamp).toHaveLength(4);
    // The cut lands past the fourth row's top but short of the fifth's, so
    // the fourth is shown (fading under the mask) and the fifth never
    // appears. Both edges are off-by-one failures that look plausible:
    // stopping above the fourth row shows three lines, reaching the fifth
    // shows five.
    expect(clampMetrics.height).toBeGreaterThan(clampMetrics.rows[3].top + 1);
    expect(clampMetrics.height).toBeLessThan(clampMetrics.rows[4].top - 1);
    // And that fourth row fades rather than being hard-clipped.
    expect(clampMetrics.maskImage).toContain('gradient');

    // The pill stays out of the way until the bubble is hovered, so a
    // resting transcript is not littered with affordances.
    const pillOpacity = () =>
      showMore.evaluate(
        (el) => window.getComputedStyle(el.parentElement).opacity,
      );
    expect(await pillOpacity()).toBe('0');
    await longRow.getByTestId('user-message-content').hover();
    await expect.poll(pillOpacity).toBe('1');

    // Expanding reveals the whole message.
    await showMore.click();
    const showLess = longRow.getByTestId('user-message-show-less');
    await expect(showLess).toContainText('Show less');
    await expect(showLess).toHaveAttribute('aria-expanded', 'true');
    await expect(content).toHaveAttribute('data-collapsed', 'false');

    const expandedMetrics = await content.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(expandedMetrics.height).toBeGreaterThan(clampMetrics.height);
    // Fully revealed: no residual clipping once expanded.
    expect(expandedMetrics.scrollHeight).toBeLessThanOrEqual(
      expandedMetrics.clientHeight + 1,
    );

    await showLess.click();
    await expect(content).toHaveAttribute('data-collapsed', 'true');

    // Queued bubbles render their variants through the real component.
    await expect(
      window.getByTestId('bubble-gallery-row-queued-default'),
    ).toBeVisible();
    await expect(
      window
        .getByTestId('bubble-gallery-row-queued-default')
        .getByTestId('queued-message-setup-quote'),
    ).toHaveCount(0);
    await expect(
      window
        .getByTestId('bubble-gallery-row-queued-setup')
        .getByTestId('queued-message-setup-quote'),
    ).toBeVisible();
    // Setup gallery clocks are fixed through the desktop wrapper, so the
    // examples stay deterministic while the live queue clocks elsewhere tick.
    await expect(
      window.getByTestId('bubble-gallery-row-queued-setup'),
    ).toContainText('0:12 elapsed');
    await expect(
      window.getByTestId('bubble-gallery-row-queued-setup-estimate'),
    ).toContainText('about 0:15 left');
    const scheduledRow = window.getByTestId('bubble-gallery-row-scheduled');
    await expect(scheduledRow).toBeVisible();
    // One-time sends keep the bubble with a single "Sends …" row.
    await expect(
      scheduledRow.getByTestId('scheduled-message-send-label'),
    ).toContainText('Sends ');
    await expect(scheduledRow).not.toContainText('Scheduled Message');

    // Recurring automations render as a composer notice, never a bubble.
    const recurringRow = window.getByTestId(
      'bubble-gallery-row-scheduled-recurring-notice',
    );
    await expect(recurringRow).toBeVisible();
    await expect(
      recurringRow.getByTestId('chat-input-scheduled-automations-notice'),
    ).toContainText('Every hour');
    await expect(recurringRow.getByTestId('queued-message-bubble')).toHaveCount(
      0,
    );
  } finally {
    await closeBubbleFixture(electronApp, userDataDir);
  }
});

test('user bubbles pin while their turn scrolls and are pushed off by the next turn', async () => {
  const { electronApp, userDataDir } = await getSharedLongTranscriptHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    // Every demo workspace seeds a `demo-main` branch, so the row must also
    // be scoped by workspace to stay unambiguous.
    await window
      .locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"][data-project-id="${WORKSPACE_ID}"]`,
      )
      .click();

    const scroller = window.getByTestId('chat-message-list-scroll');
    await expect(scroller).toBeVisible({ timeout: 20_000 });

    // The head user message of each section is hoisted into a sticky header
    // (`StickyUserMessageHeader`), so that is what carries the pin.
    const stickyHead = window.getByTestId('sticky-user-message').first();
    await expect(stickyHead).toBeVisible({ timeout: 20_000 });

    const position = await stickyHead.evaluate(
      (el) => window.getComputedStyle(el).position,
    );
    expect(position).toBe('sticky');

    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    const scrollerBox = await scroller.boundingBox();
    const restingTop = (await stickyHead.boundingBox()).y;

    // Scroll into the middle of the first section: the head message should
    // stop at the sticky line rather than travelling with the content.
    await scroller.evaluate((el) => {
      el.scrollTop = 240;
    });
    const pinnedTop = (await stickyHead.boundingBox()).y;
    expect(pinnedTop).toBeGreaterThan(restingTop - 240);
    expect(pinnedTop).toBeLessThan(scrollerBox.y + 80);
  } finally {
    await closeBubbleFixture(electronApp, userDataDir);
  }
});

test("expanding a turn's indicator strip brings its prompt back to the top", async () => {
  const { electronApp, userDataDir } = await getSharedLongTranscriptHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await window
      .locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"][data-project-id="${WORKSPACE_ID}"]`,
      )
      .click();

    const scroller = window.getByTestId('chat-message-list-scroll');
    await expect(scroller).toBeVisible({ timeout: 20_000 });

    // Park at the very bottom. This is the case that used to fail: growing
    // the transcript while the reader is near the bottom re-pins it there,
    // which silently swallowed the scroll-into-view.
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() =>
        scroller.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(2);

    const summaries = window.locator('button[aria-label^="Agent steps"]');
    await expect(summaries.first()).toBeAttached({ timeout: 20_000 });
    await summaries.last().click();

    // The section head lands at the top of the scrollport, one resting inset
    // down — the scrollport's own top padding. Landing flush instead would
    // scroll that padding away and close the gap between the last banner and
    // the content beneath it, so the turn would read tighter after the travel
    // than it does anywhere else.
    await expect
      .poll(
        () =>
          window.evaluate(() => {
            const sections = document.querySelectorAll(
              '[data-chat-sticky-section]',
            );
            const section = sections[sections.length - 1];
            const el = document.querySelector(
              '[data-testid="chat-message-list-scroll"]',
            );
            if (
              !(section instanceof HTMLElement) ||
              !(el instanceof HTMLElement)
            ) {
              return null;
            }
            const inset =
              Number.parseFloat(window.getComputedStyle(el).paddingTop) || 0;
            return Math.round(
              section.getBoundingClientRect().top -
                el.getBoundingClientRect().top -
                inset,
            );
          }),
        { timeout: 5000 },
      )
      .toBeLessThan(2);
  } finally {
    await closeBubbleFixture(electronApp, userDataDir);
  }
});

test('a Clean turn footer stays visible while its prompt is hovered', async () => {
  const { electronApp, userDataDir } = await getSharedLongTranscriptHarness();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await window
      .locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"][data-project-id="${WORKSPACE_ID}"]`,
      )
      .click();

    const scroller = window.getByTestId('chat-message-list-scroll');
    await expect(scroller).toBeVisible({ timeout: 20_000 });
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });

    // Clean chat keeps the timestamp visible even when its hoisted prompt
    // is outside the turn wrapper. Hovering must not hide it.
    const stampOpacity = () =>
      window.evaluate(() => {
        const el = document.querySelector(
          '[data-testid="turn-timer"][data-state="completed"] [data-testid="turn-timer-relative"]',
        );
        return el ? window.getComputedStyle(el).opacity : null;
      });

    const sidebarBox = await window.getByTestId('app-sidebar').boundingBox();
    expect(sidebarBox).not.toBeNull();
    const outsidePoint = {
      x: sidebarBox.x + sidebarBox.width / 2,
      y: sidebarBox.y + sidebarBox.height / 2,
    };
    await window.mouse.move(outsidePoint.x, outsidePoint.y);
    expect(
      await window.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return Boolean(
          hit?.closest(
            '[data-role="user"], [data-role="assistant"], [data-testid="sticky-user-message"]',
          ),
        );
      }, outsidePoint),
    ).toBe(false);
    await expect.poll(stampOpacity).toBe('1');

    await window
      .locator('[data-testid="sticky-user-message"] [data-role="user"]')
      .first()
      .hover();
    await expect.poll(stampOpacity).toBe('1');

    await window.mouse.move(5, 5);
    await expect.poll(stampOpacity).toBe('1');
  } finally {
    await closeBubbleFixture(electronApp, userDataDir);
  }
});

test('hovering a navigable prompt keeps its surface and clicking it jumps to the turn', async () => {
  const { electronApp, userDataDir } = await getSharedLongTranscriptHarness();
  const window = await electronApp.firstWindow();
  const initialTheme = await window.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    colorMode: document.documentElement.getAttribute('data-color-mode'),
  }));

  try {
    const scroller = window.getByTestId('chat-message-list-scroll');
    // `(?!\d)` keeps "Follow-up prompt 1" from matching prompts 10–19.
    const row = window
      .locator('[data-role="user"]', { hasText: /Follow-up prompt 1(?!\d)/ })
      .first();
    const surface = row.getByTestId('portal-chat-message-content');
    const copy = row.getByRole('button', { name: 'Copy your message' });
    await expect(surface).toBeVisible({ timeout: 20_000 });
    await surface.scrollIntoViewIfNeeded();

    const sidebarBox = await window.getByTestId('app-sidebar').boundingBox();
    expect(sidebarBox).not.toBeNull();
    const parkOutside = () =>
      window.mouse.move(
        sidebarBox.x + sidebarBox.width / 2,
        sidebarBox.y + sidebarBox.height / 2,
      );
    const readSurface = () =>
      surface.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          cursor: style.cursor,
        };
      });
    // The Copy badge's own opacity stays 1 while an ancestor hides it, so
    // read the product of the whole ancestor chain.
    const copyOpacity = () =>
      copy.evaluate((el) => {
        let opacity = 1;
        for (let node = el; node; node = node.parentElement) {
          opacity *= Number(window.getComputedStyle(node).opacity);
        }
        return opacity;
      });
    // A body point in the bubble's left padding, clear of the text, links,
    // Show more, and the corner badges, so the hover lands on the surface
    // itself rather than an excluded interactive descendant.
    const bodyPoint = async () => {
      const box = await surface.boundingBox();
      expect(box).not.toBeNull();
      return { x: box.x + 4, y: box.y + box.height / 2 };
    };

    for (const theme of ['light', 'dark']) {
      await window.evaluate((dark) => {
        document.documentElement.classList.toggle('dark', dark);
        document.documentElement.setAttribute(
          'data-color-mode',
          dark ? 'dark' : 'light',
        );
      }, theme === 'dark');

      await parkOutside();
      await expect.poll(copyOpacity).toBe(0);
      const rest = await readSurface();
      expect(rest.backgroundImage, theme).toBe('none');

      const point = await bodyPoint();
      await window.mouse.move(point.x, point.y);
      await expect.poll(copyOpacity).toBe(1);
      // The pointer cursor is the whole navigation affordance; the surface
      // keeps its resting fill rather than gaining a hover overlay.
      expect(await readSurface(), theme).toEqual({
        ...rest,
        cursor: 'pointer',
      });

      await parkOutside();
      await expect.poll(copyOpacity).toBe(0);
      expect(await readSurface(), theme).toEqual(rest);
      await copy.focus();
      await expect(copy).toBeFocused();
      await expect.poll(copyOpacity).toBe(1);
      await copy.evaluate((element) => element.blur());
      await expect.poll(copyOpacity).toBe(0);
    }

    // Offset of the turn's section from the scrollport's resting inset —
    // the position a jump lands it at.
    const sectionOffset = () =>
      window.evaluate(() => {
        const section = document.querySelector(
          '[data-chat-sticky-section="user-1"]',
        );
        const el = document.querySelector(
          '[data-testid="chat-message-list-scroll"]',
        );
        if (!(section instanceof HTMLElement) || !(el instanceof HTMLElement)) {
          return null;
        }
        const inset =
          Number.parseFloat(window.getComputedStyle(el).paddingTop) || 0;
        return Math.round(
          section.getBoundingClientRect().top -
            el.getBoundingClientRect().top -
            inset,
        );
      });

    // Start from the top of the transcript, so the turn sits well below the
    // landing position with plenty of scroll room beneath it.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(surface).toBeVisible();
    await surface.scrollIntoViewIfNeeded();
    const before = await sectionOffset();
    expect(before).not.toBeNull();
    expect(before).toBeGreaterThan(20);

    // Copy acts on its own and does not navigate.
    const copyPoint = await bodyPoint();
    await window.mouse.move(copyPoint.x, copyPoint.y);
    await expect.poll(copyOpacity).toBe(1);
    const scrollBeforeCopy = await scroller.evaluate((el) => el.scrollTop);
    await electronApp.evaluate(({ clipboard }) => clipboard.clear());
    await copy.click();
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('Follow-up prompt 1');
    await window.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(
      scrollBeforeCopy,
    );

    // A body click jumps the turn to the top of the scrollport.
    const clickPoint = await bodyPoint();
    await window.mouse.click(clickPoint.x, clickPoint.y);
    await expect
      .poll(() => sectionOffset().then((offset) => Math.abs(offset ?? 999)), {
        timeout: 5000,
      })
      .toBeLessThan(2);
  } finally {
    await window.evaluate(({ dark, colorMode }) => {
      document.documentElement.classList.toggle('dark', dark);
      if (colorMode === null) {
        document.documentElement.removeAttribute('data-color-mode');
      } else {
        document.documentElement.setAttribute('data-color-mode', colorMode);
      }
    }, initialTheme);
    await closeBubbleFixture(electronApp, userDataDir);
  }
});

test('Clean turn footers stay visible across prompt hover and keyboard focus', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-bubble-scope-e2e-'),
  );
  seedDemoWorkspaces({ userDataDir });

  // A watcher-fired turn deliberately does NOT start its own sticky section
  // (`startsStickySection`), so it is grouped under the head turn's pinned
  // prompt. That makes this the case where a too-wide hover scope shows: the
  // reveal must stay on the hovered turn instead of firing for every turn
  // sharing the section.
  const timer = (index) => ({
    id: `timer-${index}`,
    role: 'system',
    timestamp: 1_700_000_001_000 + index * 1000,
    blocks: [
      {
        type: 'turn_timer',
        startedAt: 1_700_000_000_000 + index * 1000,
        completedAt: 1_700_000_001_000 + index * 1000,
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: 'bubble-scope-chat',
        title: 'Hover scope',
        providerType: 'claude',
        messages: [
          {
            id: 'user-head',
            role: 'user',
            timestamp: 1_700_000_000_000,
            blocks: [{ type: 'text', text: 'Head prompt of the section' }],
          },
          {
            id: 'assistant-head',
            role: 'assistant',
            timestamp: 1_700_000_000_500,
            blocks: [{ type: 'text', text: 'Head reply.' }],
          },
          timer(0),
          {
            id: 'user-watcher',
            role: 'user',
            timestamp: 1_700_000_002_000,
            watcherFired: { watcherName: 'demo' },
            blocks: [{ type: 'text', text: 'Watcher follow-up prompt' }],
          },
          {
            id: 'assistant-watcher',
            role: 'assistant',
            timestamp: 1_700_000_002_500,
            blocks: [{ type: 'text', text: 'Follow-up reply.' }],
          },
          timer(2),
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await window
      .locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"][data-project-id="${WORKSPACE_ID}"]`,
      )
      .click();

    const scroller = window.getByTestId('chat-message-list-scroll');
    await expect(scroller).toBeVisible({ timeout: 20_000 });

    const revealed = () =>
      window.evaluate(() => {
        const footers = Array.from(
          document.querySelectorAll(
            '[data-testid="turn-timer"][data-state="completed"] [data-testid="turn-timer-relative"]',
          ),
        );
        return footers.filter(
          (el) => window.getComputedStyle(el).opacity !== '0',
        ).length;
      });

    // Both turns share one sticky section; both footers must remain visible.
    expect(
      await window.evaluate(
        () => document.querySelectorAll('[data-chat-sticky-section]').length,
      ),
    ).toBe(1);
    expect(
      await window.evaluate(() => {
        const section = document.querySelector('[data-chat-sticky-section]');
        return section
          ? section.querySelectorAll('[data-chat-turn-group]').length
          : 0;
      }),
    ).toBeGreaterThan(1);

    await window.mouse.move(5, 5);
    await expect.poll(revealed).toBe(2);

    await window
      .locator('[data-testid="sticky-user-message"] [data-role="user"]')
      .first()
      .hover();
    // Hovering one prompt must leave both Clean footers visible.
    await expect.poll(revealed).toBe(2);
    await window
      .getByTestId('turn-timer')
      .first()
      .getByTestId('turn-copy-message')
      .focus();
    await window.mouse.move(5, 5);
    // Keyboard focus and clearing mirrored hover also preserve both footers.
    await expect.poll(revealed).toBe(2);
    await window.getByTestId('app-sidebar').getByRole('button').first().focus();
    await expect.poll(revealed).toBe(2);
  } finally {
    await closeBubbleFixture(electronApp, userDataDir);
  }
});

test('content that is tall without being wordy still clamps', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-bubble-overflow-e2e-'),
  );
  seedDemoWorkspaces({ userDataDir });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: 'bubble-overflow-chat',
        title: 'Overflow',
        providerType: 'claude',
        messages: [
          {
            id: 'user-caption',
            role: 'user',
            timestamp: 1_700_000_000_000,
            blocks: [{ type: 'text', text: 'Caption above a tall block.' }],
          },
          {
            id: 'assistant-caption',
            role: 'assistant',
            timestamp: 1_700_000_000_500,
            blocks: [{ type: 'text', text: 'Reply.' }],
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await window
      .locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"][data-project-id="${WORKSPACE_ID}"]`,
      )
      .click();

    const content = window.getByTestId('user-message-content').first();
    await expect(content).toBeVisible({ timeout: 20_000 });
    // A one-line message fits, so nothing clamps yet.
    await expect(content).toHaveAttribute('data-collapsed', 'false');

    // Now make it tall WITHOUT adding text. The clamp measures line boxes to
    // place its cut, and a message can be enormous while rendering only a
    // couple of them — a caption above a large image is the real case. The
    // block is injected because the transcript's markdown renderer does not
    // inline images, and the point under test is the geometry, not the
    // markup that produces it: deciding collapsibility from the row count
    // alone waved exactly this shape past the clamp.
    await content.evaluate((el) => {
      const block = document.createElement('div');
      block.style.height = '300px';
      block.setAttribute('data-testid', 'synthetic-tall-block');
      el.appendChild(block);
    });

    await expect(content).toHaveAttribute('data-collapsed', 'true');
    await expect(
      window.getByTestId('user-message-show-more').first(),
    ).toBeAttached();
    const metrics = await content.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      scrollHeight: el.scrollHeight,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.height * 2);
  } finally {
    await closeBubbleFixture(electronApp, userDataDir);
  }
});

// CAN-2811: a prompt typed with deliberate single line breaks must render on
// those lines. Markdown treats a lone newline as a soft break, which the
// browser collapses to a space, so "line one / line two / line three" used to
// fold into one paragraph. Only the user bubble opts in; agent prose keeps
// standard soft-break handling.
test('user bubbles keep the single line breaks the user typed', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-bubble-line-breaks-e2e-'),
  );
  seedDemoWorkspaces({ userDataDir });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: 'bubble-line-breaks-chat',
        title: 'Line breaks',
        providerType: 'claude',
        messages: [
          {
            id: 'user-single-line',
            role: 'user',
            timestamp: 1_700_000_000_000,
            blocks: [{ type: 'text', text: 'A single line prompt.' }],
          },
          {
            id: 'assistant-single-line',
            role: 'assistant',
            timestamp: 1_700_000_000_500,
            blocks: [{ type: 'text', text: 'reply one\nreply two' }],
          },
          {
            id: 'user-multi-line',
            role: 'user',
            timestamp: 1_700_000_001_000,
            blocks: [{ type: 'text', text: 'line one\nline two\nline three' }],
          },
          {
            id: 'assistant-multi-line',
            role: 'assistant',
            timestamp: 1_700_000_001_500,
            blocks: [{ type: 'text', text: 'Reply.' }],
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await window
      .locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"][data-project-id="${WORKSPACE_ID}"]`,
      )
      .click();

    const contents = window.getByTestId('user-message-content');
    await expect(contents).toHaveCount(2, { timeout: 20_000 });
    const singleLine = contents.nth(0);
    const multiLine = contents.nth(1);
    await expect(singleLine).toBeVisible();
    await expect(multiLine).toBeVisible();

    // The three typed lines render as three lines: two <br> elements inside
    // one paragraph, and a bubble roughly three text rows tall rather than
    // the one row a collapsed soft break would leave.
    await expect(multiLine.locator('p br')).toHaveCount(2);
    await expect(multiLine).toContainText('line one');
    await expect(multiLine).toContainText('line three');
    const heights = await window.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll('[data-testid="user-message-content"]'),
      );
      return nodes.map((node) => node.getBoundingClientRect().height);
    });
    expect(heights).toHaveLength(2);
    expect(heights[1]).toBeGreaterThan(heights[0] * 2.5);
    // Three rows do not reach the four-row clamp, so nothing collapses.
    await expect(multiLine).toHaveAttribute('data-collapsed', 'false');

    // Agent prose is untouched: its soft break still collapses (no <br>).
    const assistantParagraphs = window
      .locator('[data-role="assistant"] p')
      .filter({ hasText: 'reply one' });
    await expect(assistantParagraphs).toHaveCount(1);
    await expect(assistantParagraphs.locator('br')).toHaveCount(0);
  } finally {
    await closeBubbleFixture(electronApp, userDataDir);
  }
});

test('reduced motion jumps to the expanded turn instead of animating', async () => {
  const { electronApp, userDataDir } = await getSharedLongTranscriptHarness();

  try {
    const window = await electronApp.firstWindow();
    await window.emulateMedia({ reducedMotion: 'reduce' });
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await window
      .locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"][data-project-id="${WORKSPACE_ID}"]`,
      )
      .click();

    const scroller = window.getByTestId('chat-message-list-scroll');
    await expect(scroller).toBeVisible({ timeout: 20_000 });
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    const summaries = window.locator('button[aria-label^="Agent steps"]');
    await expect(summaries.first()).toBeAttached({ timeout: 20_000 });

    // Sample scrollTop every frame across the travel. Eased motion passes
    // through many intermediate positions; honouring the setting means going
    // straight to the destination.
    await window.evaluate(() => {
      window.__scrollSamples = [];
      const el = document.querySelector(
        '[data-testid="chat-message-list-scroll"]',
      );
      const started = performance.now();
      const sample = () => {
        window.__scrollSamples.push(Math.round(el.scrollTop));
        if (performance.now() - started < 900) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await summaries.last().click();
    await window.waitForTimeout(1200);

    const distinct = await window.evaluate(
      () => new Set(window.__scrollSamples).size,
    );
    // Two: where it started, and where it landed.
    expect(distinct).toBeLessThanOrEqual(3);
  } finally {
    await closeBubbleFixture(electronApp, userDataDir);
  }
});

async function setDesktopColourMode(electronApp, window, mode) {
  await electronApp.evaluate(({ nativeTheme }, themeSource) => {
    nativeTheme.themeSource = themeSource;
  }, mode);
  await window.emulateMedia({ colorScheme: mode });
  await window.evaluate((dark) => {
    document.documentElement.classList.toggle('dark', dark);
  }, mode === 'dark');
  if (mode === 'dark') {
    await expect(window.locator('html')).toContainClass('dark');
  } else {
    await expect(window.locator('html')).not.toContainClass('dark');
  }
}

function readSummarySurface(locator) {
  return locator.evaluate(async (element) => {
    // Wait for the foreground transition rather than sampling an intermediate color.
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
    const style = window.getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderWidths: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ],
      radii: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ],
      boxShadow: style.boxShadow,
      color: style.color,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
}

/** Clean chat draws the keyboard ring on the step-row button itself. */
function readSummaryFocusRing(locator) {
  return locator.evaluate((element) => {
    const ring = window.getComputedStyle(element);
    return {
      isStepRow: element.hasAttribute('data-step-row'),
      outlineStyle: ring.outlineStyle,
      outlineWidth: ring.outlineWidth,
      outlineColor: ring.outlineColor,
      outlineOffset: ring.outlineOffset,
    };
  });
}

function expectRowFocusRing(ring) {
  const detail = JSON.stringify(ring);
  expect(ring.isStepRow, detail).toBe(true);
  expect(ring.outlineStyle, detail).toBe('solid');
  expect(ring.outlineWidth, detail).toBe('2px');
  expect(ring.outlineOffset, detail).toBe('2px');
  expect(ring.outlineColor, detail).not.toBe('rgba(0, 0, 0, 0)');
}

function expectFlatSummary(surface) {
  expect(surface.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(surface.borderWidths).toEqual(['0px', '0px', '0px', '0px']);
  expect(surface.radii).toEqual(['4px', '4px', '4px', '4px']);
  expect(surface.boxShadow).toBe('none');
}

// CAN-4281: the collapsed agent step summary sits on the chat background, in
// flow and pinned. The sticky wrapper keeps its opaque backing so content
// scrolling under the pinned row stays masked.
test('the agent step summary row is flat in flow and while pinned', async () => {
  const { electronApp, userDataDir } = await getSharedLongTranscriptHarness();

  try {
    const window = await electronApp.firstWindow();
    const scroller = window.getByTestId('chat-message-list-scroll');
    await expect(scroller).toBeVisible({ timeout: 20_000 });

    // A known completed turn: the second section, headed by `user-1`.
    const section = window.locator('[data-chat-sticky-section]').filter({
      has: window.locator('[data-sticky-user-message-id="user-1"]'),
    });
    const turn = window.locator('[data-chat-turn-group="user-1"]');
    const wrapper = section.getByTestId('sticky-turn-summary');
    const summary = wrapper.locator('button[aria-label^="Agent steps"]');
    await expect(summary).toBeVisible({ timeout: 20_000 });
    const ariaLabel = await summary.getAttribute('aria-label');
    expect(ariaLabel).toBe('Agent steps: Ran 2 commands');

    for (const mode of ['light', 'dark']) {
      await setDesktopColourMode(electronApp, window, mode);
      await window.mouse.move(5, 5);
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(summary).toHaveAttribute('aria-expanded', 'false');

      // In flow.
      const resting = await readSummarySurface(summary);
      expectFlatSummary(resting);

      // Pinned: scroll into the section, then confirm the row holds still
      // while the content keeps moving under it.
      const sectionTop = await section.evaluate(
        (element, scrollerElement) =>
          element.getBoundingClientRect().top -
          scrollerElement.getBoundingClientRect().top +
          scrollerElement.scrollTop,
        await scroller.elementHandle(),
      );
      await scroller.evaluate((element, top) => {
        element.scrollTop = top + 240;
      }, sectionTop);
      const pinnedY = (await summary.boundingBox()).y;
      await scroller.evaluate((element) => {
        element.scrollTop += 120;
      });
      await expect
        .poll(async () => Math.round((await summary.boundingBox()).y))
        .toBe(Math.round(pinnedY));
      expectFlatSummary(await readSummarySurface(summary));
      const backing = await wrapper
        .locator(':scope > div')
        .evaluate(
          (element) => window.getComputedStyle(element).backgroundColor,
        );
      expect(backing).not.toBe('rgba(0, 0, 0, 0)');
      // Opaque: no `rgba(…, <1)` and no `color(… / <1)` alpha.
      expect(backing).not.toMatch(/(,|\/)\s*0?\.\d+\)$|(,|\/)\s*0\)$/);

      // Hover changes the foreground only.
      await summary.hover();
      await expect
        .poll(async () => (await readSummarySurface(summary)).color)
        .not.toBe(resting.color);
      expectFlatSummary(await readSummarySurface(summary));
      await window.mouse.move(5, 5);

      // Keyboard focus: Tab from the focusable just before the row.
      await summary.evaluate((element) => {
        const focusable = Array.from(
          document.querySelectorAll(
            'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter(
          (node) =>
            node instanceof HTMLElement &&
            !node.hasAttribute('disabled') &&
            node.getClientRects().length > 0,
        );
        const anchor = focusable[focusable.indexOf(element) - 1];
        if (!(anchor instanceof HTMLElement)) {
          throw new Error('No focusable element precedes the summary row');
        }
        anchor.focus({ preventScroll: true });
      });
      let reached = false;
      for (let step = 0; step < 10 && !reached; step += 1) {
        await window.keyboard.press('Tab');
        reached = await summary.evaluate(
          (element) => element === document.activeElement,
        );
      }
      if (!reached) {
        throw new Error('Keyboard navigation never reached the summary row');
      }
      expectRowFocusRing(await readSummaryFocusRing(summary));

      // Keyboard expands, pointer collapses; counts never change.
      const collapsedHeight = (await turn.boundingBox()).height;
      await window.keyboard.press('Enter');
      await expect(summary).toHaveAttribute('aria-expanded', 'true');
      await expect
        .poll(async () => (await turn.boundingBox()).height)
        .toBeGreaterThan(collapsedHeight);
      await window.mouse.move(5, 5);
      expectFlatSummary(await readSummarySurface(summary));
      await expect(summary).toHaveAttribute('aria-label', ariaLabel);

      await summary.click();
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await expect
        .poll(async () => Math.round((await turn.boundingBox()).height))
        .toBe(Math.round(collapsedHeight));
      await expect(summary).toHaveAttribute('aria-label', ariaLabel);

      // Space uses native button activation too; one press must toggle once.
      await window.keyboard.press('Space');
      await expect(summary).toHaveAttribute('aria-expanded', 'true');
      await expect
        .poll(async () => (await turn.boundingBox()).height)
        .toBeGreaterThan(collapsedHeight);
      await window.keyboard.press('Space');
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await expect
        .poll(async () => Math.round((await turn.boundingBox()).height))
        .toBe(Math.round(collapsedHeight));
      await expect(summary).toHaveAttribute('aria-label', ariaLabel);
    }
  } finally {
    const window = await electronApp.firstWindow();
    await setDesktopColourMode(electronApp, window, 'light');
    await closeBubbleFixture(electronApp, userDataDir);
  }
});
