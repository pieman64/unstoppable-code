import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'watcher-sticky-durable';
const BASE = Date.parse('2026-08-19T12:00:00.000Z');
const LONG_PROMPT = [
  'Review the rollout from start to finish:',
  '1. [migrate staging](https://example.test/staging) before production starts,',
  '2. run [database changes](https://example.test/database) inside a transaction,',
  '3. wait for every [health check](https://example.test/health) to pass,',
  '4. [notify the on-call channel](https://example.test/on-call) when complete.',
].join('\n');

function tallReply(marker, paragraphs) {
  return Array.from(
    { length: paragraphs },
    (_, index) => `${marker} paragraph ${index + 1} of the response.`,
  ).join('\n\n');
}

function buildTurn(userId, text, reply, timestamp, userFields = {}) {
  return [
    {
      id: userId,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp,
      ...userFields,
    },
    {
      id: `${userId}-tools`,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: `${userId}-tool`,
          toolName: 'Bash',
          input: JSON.stringify({ command: 'echo checking' }),
        },
        {
          type: 'tool_result',
          toolUseId: `${userId}-tool`,
          toolName: 'Bash',
          output: 'checking',
          isError: false,
        },
      ],
      timestamp: timestamp + 1_000,
    },
    {
      id: `${userId}-reply`,
      role: 'assistant',
      blocks: [{ type: 'text', text: reply }],
      timestamp: timestamp + 2_000,
    },
    {
      id: `${userId}-timer`,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: timestamp,
          completedAt: timestamp + 3_000,
        },
      ],
      timestamp: timestamp + 3_000,
    },
  ];
}

function seedChat(userDataDir) {
  const firstTurn = buildTurn(
    'user-1',
    LONG_PROMPT,
    tallReply('REPLY-ONE', 24),
    BASE,
  );
  firstTurn.splice(
    -1,
    0,
    {
      id: 'steer-1',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Steer the completed turn',
          steering: { startsTurn: false },
        },
      ],
      timestamp: BASE + 2_500,
    },
    {
      id: 'steer-1-reply',
      role: 'assistant',
      blocks: [{ type: 'text', text: tallReply('AFTER-STEER', 12) }],
      timestamp: BASE + 2_750,
    },
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Watcher sticky durable coverage',
        messages: [
          ...firstTurn,
          ...buildTurn(
            'user-2',
            'Watch the deploy pipeline',
            tallReply('REPLY-TWO', 12),
            BASE + 10_000,
          ),
          ...buildTurn(
            'watcher-1',
            'Canopy watcher fired.\nDeploy pipeline finished',
            tallReply('WATCHER-REPLY', 12),
            BASE + 20_000,
            { watcherFired: { kind: 'Pipeline completion (Deploy)' } },
          ),
          ...buildTurn(
            'user-3',
            'Summarize the rollout',
            tallReply('REPLY-THREE', 4),
            BASE + 30_000,
          ),
        ],
      },
    ],
  });
}

async function injectWatcherQueue(electronApp) {
  const combinedWatchers = [
    {
      kind: 'GitHub workflow run (acme/api)',
      text: 'Canopy watcher fired.\nCI checks completed for the API deployment.',
    },
    {
      kind: 'Pipeline completion (Deploy web)',
      text: 'Canopy watcher fired.\nThe web deployment completed successfully.',
    },
    {
      kind: 'Hook (Post-deploy checks)',
      text: 'Canopy watcher fired.\nPost-deploy health checks passed in every region.',
    },
    {
      kind: 'Automation run (Notify stakeholders)',
      text: 'Canopy watcher fired.\nThe stakeholder notification automation completed.',
    },
    {
      kind: 'Chat completion (Release notes)',
      text: 'Canopy watcher fired.\nThe release-notes chat produced its final report.',
    },
    {
      kind: 'New chat started (Incident follow-up)',
      text: 'Canopy watcher fired.\nA new incident follow-up chat has started.',
    },
  ];
  await electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Expected a browser window');
      window.webContents.send('chat:queue-updated', payload);
    },
    {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      queue: [
        {
          id: 'queued-watcher',
          text: combinedWatchers
            .map((watcher) => watcher.text.split('\n').slice(1).join('\n'))
            .join('\n\n'),
          origin: 'desktop',
          enqueuedAtMs: BASE + 40_000,
          watcherFired: {
            kind: `Multiple watchers fired (${combinedWatchers.length})`,
            combinedWatchers,
          },
        },
      ],
    },
  );
}

async function scrollAnchorToTop(window, scroller, anchor, offset) {
  // The transcript can re-render while sticky sections and watcher bubbles
  // settle. Retry the reveal and geometry read together so a detached node or
  // transient null box cannot fail an otherwise stable interaction.
  let scrollerBox;
  let anchorBox;
  await expect(async () => {
    await anchor.scrollIntoViewIfNeeded();
    scrollerBox = await scroller.boundingBox();
    anchorBox = await anchor.boundingBox();
    if (!scrollerBox || !anchorBox) throw new Error('Missing scroll geometry');
  }).toPass({ timeout: 15_000 });
  await scroller.evaluate(
    (element, delta) => {
      element.scrollTop += delta;
    },
    anchorBox.y - scrollerBox.y - offset,
  );
  await window.waitForTimeout(100);
}

const TALL_CHAT_ID = 'sticky-bottom-edge';
const TALL_PARAGRAPHS = 48;
const TALL_PROMPT = Array.from(
  { length: TALL_PARAGRAPHS },
  (_, index) =>
    `TALL marker ${index + 1} of ${TALL_PARAGRAPHS} — oversized prompt content line.`,
).join('\n\n');

function seedTallChat(userDataDir) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: TALL_CHAT_ID,
    tabs: [
      {
        id: TALL_CHAT_ID,
        title: 'Sticky bottom edge coverage',
        messages: [
          ...buildTurn(
            'user-tall',
            TALL_PROMPT,
            tallReply('TALL-REPLY', 24),
            BASE,
          ),
          ...buildTurn(
            'watcher-tall',
            'Watcher follow-up for the oversized prompt.',
            tallReply('WATCHER-TAIL', 8),
            BASE + 10_000,
            { watcherFired: { kind: 'Pipeline completion (Deploy)' } },
          ),
          ...buildTurn(
            'user-end',
            'Wrap up the oversized prompt review.',
            tallReply('END-REPLY', 4),
            BASE + 20_000,
          ),
        ],
      },
    ],
  });
}

const VIRTUALIZED_CHAT_ID = 'sticky-continuation-jump';

function seedVirtualizedContinuationChat(userDataDir) {
  const watcherTurns = Array.from({ length: 65 }, (_, index) =>
    buildTurn(
      `watcher-continuation-${index + 1}`,
      `Watcher continuation ${index + 1}`,
      `WATCHER-CONTINUATION-${index + 1}`,
      BASE + (index + 1) * 10_000,
      { watcherFired: { kind: 'Pipeline completion (Deploy)' } },
    ),
  ).flat();
  const trailingTurns = Array.from({ length: 20 }, (_, index) =>
    buildTurn(
      `trailing-user-${index + 1}`,
      `Trailing user prompt ${index + 1}`,
      `TRAILING-REPLY-${index + 1}`,
      BASE + (index + 70) * 10_000,
    ),
  ).flat();

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: VIRTUALIZED_CHAT_ID,
    tabs: [
      {
        id: VIRTUALIZED_CHAT_ID,
        title: 'Sticky continuation jump coverage',
        messages: [
          ...buildTurn(
            'user-canonical',
            'Canonical prompt for every continuation.',
            'CANONICAL-REPLY',
            BASE,
          ),
          ...watcherTurns,
          ...trailingTurns,
        ],
      },
    ],
  });
}

test('virtualized sticky continuation headers jump to the canonical user message', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sticky-continuation-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedVirtualizedContinuationChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.getByTestId('panel-content-chat');
    const scroller = chatPanel.getByTestId('chat-message-list-scroll');
    await expect(chatPanel).toBeVisible();
    await expect(
      window.getByText('TRAILING-REPLY-20', { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    // Walk past enough split continuation rows that overscan no longer keeps
    // the canonical first row mounted. This exercises the virtualizer-driven
    // jump rather than merely finding the original section in nearby DOM.
    for (let index = 0; index < 3; index += 1) {
      const currentRow = chatPanel.locator(`[data-index="${index}"]`);
      await expect(currentRow).toBeAttached();
      const nextTop = await currentRow.evaluate(
        (element) => element.offsetTop + element.getBoundingClientRect().height,
      );
      await scroller.evaluate((element, top) => {
        element.scrollTop = top + 24;
      }, nextTop);
    }

    await expect(
      chatPanel.locator('[data-chat-sticky-section="user-canonical"]'),
    ).toHaveCount(0);

    const continuation = chatPanel.locator(
      '[data-index="3"] [data-chat-sticky-section^="user-canonical:continuation:"]',
    );
    await expect(continuation).toBeAttached();
    await continuation
      .getByTestId('portal-chat-message-content')
      .first()
      .click({ position: { x: 24, y: 24 } });

    const canonicalSection = chatPanel.locator(
      '[data-chat-sticky-section="user-canonical"]',
    );
    await expect(canonicalSection).toBeAttached({ timeout: 10_000 });
    await expect
      .poll(async () => {
        const sectionBox = await canonicalSection.boundingBox();
        const viewportBox = await scroller.boundingBox();
        if (!sectionBox || !viewportBox) return Number.POSITIVE_INFINITY;
        return Math.abs(sectionBox.y - (viewportBox.y + 8));
      })
      .toBeLessThan(6);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('oversized expanded prompts pin their bottom edge and user messages click-jump to their history position', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sticky-bottom-edge-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedTallChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.getByTestId('panel-content-chat');
    const scroller = chatPanel.getByTestId('chat-message-list-scroll');
    await expect(chatPanel).toBeVisible();
    await expect(
      window.getByText('END-REPLY paragraph 4', { exact: false }),
    ).toBeVisible({ timeout: 20_000 });

    const stickyTall = chatPanel.locator(
      '[data-sticky-user-message-id="user-tall"]',
    );
    const tallSection = chatPanel.locator(
      '[data-chat-sticky-section="user-tall"]',
    );
    const tallPill = stickyTall
      .getByTestId('portal-chat-message-content')
      .first();
    const tallContent = stickyTall.getByTestId('user-message-content');
    const firstMarker = window.getByText(
      `TALL marker 1 of ${TALL_PARAGRAPHS}`,
      { exact: false },
    );
    const lastMarker = window.getByText(
      `TALL marker ${TALL_PARAGRAPHS} of ${TALL_PARAGRAPHS}`,
      { exact: false },
    );

    // Pin the tall prompt (collapsed) by scrolling into its reply.
    await scrollAnchorToTop(
      window,
      scroller,
      window.getByText('TALL-REPLY paragraph 12', { exact: false }),
      120,
    );
    await expect(stickyTall).toHaveAttribute('data-stuck', 'true');

    // The bubble body advertises the click-to-jump affordance.
    await expect
      .poll(() =>
        tallPill.evaluate((element) => window.getComputedStyle(element).cursor),
      )
      .toBe('pointer');

    // Expanding the pinned oversize prompt moves the pin to its BOTTOM edge:
    // the sticky top goes negative by the expansion overflow, so the message
    // first returns to natural flow (readable by plain scrolling) …
    await stickyTall.getByTestId('user-message-show-more').click();
    await expect(tallContent).toHaveAttribute('data-collapsed', 'false');
    await expect
      .poll(
        () =>
          stickyTall.evaluate((element) =>
            Number.parseFloat(element.style.top),
          ),
        { timeout: 10_000 },
      )
      .toBeLessThan(-100);

    // … and once the reader scrolls past the whole expansion, only the
    // collapsed-sized tail (with its Show less toggle) pins at the top while
    // the head sits out of view above.
    await scrollAnchorToTop(
      window,
      scroller,
      window.getByText('TALL-REPLY paragraph 20', { exact: false }),
      120,
    );
    await expect(stickyTall).toHaveAttribute('data-stuck', 'true');
    let scrollerBox;
    // The sticky section can replace its DOM nodes after a scroll. Resolve
    // and check the complete geometry together, as scrollAnchorToTop does,
    // instead of treating one detached bounding-box handle as a layout failure.
    await expect(async () => {
      scrollerBox = await scroller.boundingBox();
      const lastMarkerBox = await lastMarker.boundingBox();
      const firstMarkerBox = await firstMarker.boundingBox();
      if (!scrollerBox || !lastMarkerBox || !firstMarkerBox) {
        throw new Error(
          `Missing pinned-tail geometry: ${JSON.stringify({ scrollerBox, lastMarkerBox, firstMarkerBox })}`,
        );
      }
      expect(lastMarkerBox.y).toBeGreaterThan(scrollerBox.y);
      expect(lastMarkerBox.y + lastMarkerBox.height).toBeLessThan(
        scrollerBox.y + scrollerBox.height,
      );
      expect(firstMarkerBox.y).toBeLessThan(scrollerBox.y);
    }).toPass({ timeout: 10_000 });
    await expect(
      stickyTall.getByTestId('user-message-show-less'),
    ).toBeVisible();

    // Clicking the pinned bubble body jumps to the message's own position in
    // history: the section top lands at the top of the panel, the header
    // unsticks, and the head of the message is readable again.
    const pinnedPillBox = await tallPill.boundingBox();
    if (!pinnedPillBox) throw new Error('Missing pinned pill geometry');
    await window.mouse.click(
      pinnedPillBox.x + 24,
      pinnedPillBox.y + pinnedPillBox.height - 44,
    );
    await expect
      .poll(
        async () => {
          const sectionBox = await tallSection.boundingBox();
          const viewportBox = await scroller.boundingBox();
          if (!sectionBox || !viewportBox) return Number.POSITIVE_INFINITY;
          return Math.abs(sectionBox.y - (viewportBox.y + 8));
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(6);
    await expect(stickyTall).not.toHaveAttribute('data-stuck', 'true');
    const restoredFirstMarkerBox = await firstMarker.boundingBox();
    if (!restoredFirstMarkerBox) throw new Error('Missing head geometry');
    expect(restoredFirstMarkerBox.y).toBeGreaterThan(scrollerBox.y - 1);

    // An in-flow (watcher-fired) user message jumps to sit just below its
    // section's pinned head prompt instead of hiding behind it.
    const watcherPill = chatPanel
      .locator(
        '[data-chat-turn-group="watcher-tall"] [data-testid="portal-chat-message-content"]',
      )
      .first();
    await scrollAnchorToTop(
      window,
      scroller,
      window.getByText('Watcher follow-up for the oversized prompt', {
        exact: false,
      }),
      200,
    );
    const watcherPillBox = await watcherPill.boundingBox();
    if (!watcherPillBox) throw new Error('Missing watcher pill geometry');
    await window.mouse.click(
      watcherPillBox.x + 30,
      watcherPillBox.y + watcherPillBox.height - 8,
    );
    await expect
      .poll(
        async () => {
          const headerBox = await stickyTall.boundingBox();
          const pillBox = await watcherPill.boundingBox();
          if (!headerBox || !pillBox) return Number.POSITIVE_INFINITY;
          return Math.abs(pillBox.y - (headerBox.y + headerBox.height + 8));
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(6);
    await expect(stickyTall).toHaveAttribute('data-stuck', 'true');

    // Show less still works from the pinned tail and restores the top-edge pin.
    await stickyTall.getByTestId('user-message-show-less').click();
    await expect(tallContent).toHaveAttribute('data-collapsed', 'true');
    await expect
      .poll(() => stickyTall.evaluate((element) => element.style.top), {
        timeout: 10_000,
      })
      .toBe('0px');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('watcher bubbles, sticky handoff, pinned summaries, and disclosure controls remain durable', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-sticky-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.getByTestId('panel-content-chat');
    const scroller = chatPanel.getByTestId('chat-message-list-scroll');
    await expect(chatPanel).toBeVisible();
    await expect(
      window.getByText('REPLY-THREE paragraph 4', { exact: false }),
    ).toBeVisible({ timeout: 20_000 });

    await injectWatcherQueue(electronApp);
    await expect(
      chatPanel
        .locator('[data-role="user"]')
        .filter({ hasText: 'Deploy pipeline finished' })
        .getByTestId('watcher-fired-title'),
    ).toHaveText('Pipeline completion (Deploy) watcher has fired');
    const queuedWatcher = chatPanel
      .getByTestId('queued-message-bubble')
      .filter({ hasText: 'CI checks completed' });
    const combinedWatcherTitle = queuedWatcher.getByTestId(
      'watcher-fired-title',
    );
    await expect(combinedWatcherTitle).toHaveText(
      'Multiple watchers fired (6)',
    );
    // Rich tooltips open on focus only for keyboard-reached focus (native
    // :focus-visible semantics), so put the app in keyboard modality the way
    // a user tabbing to the title would before focusing it.
    await window.keyboard.press('Shift');
    await combinedWatcherTitle.focus();
    await combinedWatcherTitle.press('Enter');
    const combinedWatcherTooltip = window.getByTestId('watcher-fired-tooltip');
    await expect(combinedWatcherTooltip).toContainText(
      'GitHub workflow run (acme/api) watcher has fired',
    );
    await expect(combinedWatcherTooltip).toContainText(
      'New chat started (Incident follow-up) watcher has fired',
    );
    const tooltipScroller = combinedWatcherTooltip.getByRole('region', {
      name: 'Combined watcher details',
    });
    await expect(tooltipScroller).toBeFocused();
    await expect
      .poll(() =>
        tooltipScroller.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await tooltipScroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => tooltipScroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await tooltipScroller.press('Escape');
    await expect(combinedWatcherTooltip).toHaveCount(0);
    await expect(combinedWatcherTitle).toBeFocused();
    await queuedWatcher.getByTestId('queued-message-more').click();
    await expect(window.getByTestId('queued-message-edit')).toBeVisible();
    await expect(window.getByTestId('queued-message-cancel')).toBeVisible();
    await window.keyboard.press('Escape');

    await scrollAnchorToTop(
      window,
      scroller,
      window.getByText('REPLY-ONE paragraph 18', { exact: false }),
      120,
    );
    const stickyUser1 = chatPanel.locator(
      '[data-sticky-user-message-id="user-1"]',
    );
    const firstSection = chatPanel.locator(
      '[data-chat-sticky-section="user-1"]',
    );
    await expect(firstSection.locator('xpath=..')).toHaveClass(/space-y-2/);
    await expect(firstSection.locator('xpath=..')).not.toHaveClass(/contents/);
    await expect(stickyUser1).toHaveAttribute('data-stuck', 'true');
    const summary1 = chatPanel
      .locator('[data-chat-turn-group="user-1"]')
      .getByTestId('sticky-turn-summary');
    await expect(summary1).toHaveAttribute('data-pinned', '');
    await expect(
      chatPanel.locator('[data-chat-sticky-section="user-1"]'),
    ).toHaveAttribute('data-chat-sticky-summary-pinned', '');

    await summary1.getByRole('button', { name: /^Agent steps:/ }).click();
    await expect(
      summary1.getByRole('button', { name: /^Agent steps:/ }),
    ).toHaveAttribute('aria-expanded', 'true');
    const steeringBubble = chatPanel
      .locator('[data-chat-turn-group="user-1"]')
      .getByTestId('portal-chat-message-content')
      .filter({ hasText: 'Steer the completed turn' });
    await scrollAnchorToTop(window, scroller, steeringBubble, 160);
    await expect(async () => {
      const state = await scroller.evaluate((element) => {
        const header = element.querySelector(
          '[data-sticky-user-message-id="user-1"]',
        );
        const bubble = element.querySelector(
          '[data-chat-turn-group="user-1"] [data-testid="steering-title"]',
        );
        const bubbleContent = bubble?.closest(
          '[data-testid="portal-chat-message-content"]',
        );
        if (!header || !bubbleContent)
          throw new Error('Missing steering geometry');
        const target = header.getBoundingClientRect().bottom - 12;
        element.scrollTop += bubbleContent.getBoundingClientRect().top - target;
        const headerRect = header.getBoundingClientRect();
        const bubbleRect = bubbleContent.getBoundingClientRect();
        return {
          straddles:
            bubbleRect.top < headerRect.bottom - 1 &&
            bubbleRect.bottom > headerRect.bottom,
          chipPinned: element
            .querySelector(
              '[data-chat-turn-group="user-1"] [data-testid="sticky-turn-summary"]',
            )
            ?.hasAttribute('data-pinned'),
        };
      });
      expect(state.straddles).toBe(true);
      expect(state.chipPinned).toBe(true);
    }).toPass({ timeout: 10_000 });
    await expect(stickyUser1).not.toHaveAttribute('data-underlap');

    const showMore = stickyUser1.getByTestId('user-message-show-more');
    const collapsibleContent = stickyUser1.getByTestId('user-message-content');
    await expect(showMore).toBeVisible();
    await expect(collapsibleContent).not.toHaveAttribute('inert');
    await expect(collapsibleContent).not.toHaveAttribute('aria-hidden');

    const suppressionState = async () =>
      collapsibleContent.evaluate((content) => {
        const boundary =
          content.getBoundingClientRect().top +
          Number.parseFloat(content.style.maxHeight);
        return Array.from(content.querySelectorAll('a[href]')).map((link) => ({
          href: link.getAttribute('href'),
          clipped: link.getBoundingClientRect().top >= boundary,
          suppressed:
            link.getAttribute('tabindex') === '-1' &&
            link.getAttribute('aria-hidden') === 'true',
        }));
      });
    const beforeResizeState = await suppressionState();
    expect(beforeResizeState.some((state) => !state.clipped)).toBe(true);
    expect(beforeResizeState.some((state) => state.clipped)).toBe(true);
    expect(
      beforeResizeState.every((state) => state.clipped === state.suppressed),
    ).toBe(true);
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(820, 900);
    });
    await expect
      .poll(async () => {
        const state = await suppressionState();
        return state.every((entry) => entry.clipped === entry.suppressed);
      })
      .toBe(true);

    await showMore.click();
    await expect(collapsibleContent).not.toHaveAttribute('inert');
    await expect(collapsibleContent).not.toHaveAttribute('aria-hidden');
    await expect(
      stickyUser1.getByTestId('user-message-show-less'),
    ).toBeVisible();
    await expect(
      stickyUser1.getByText('notify the on-call channel', { exact: false }),
    ).toBeVisible();
    await stickyUser1.getByTestId('user-message-show-less').click();

    // A follow-up bubble in the same section (watcher-fired here, steering
    // likewise) slides under the pinned header. Where it straddles the
    // header's bottom edge, the header's opaque backing cuts it into a
    // flat-topped, square-cornered slab unless the seam fade is on.
    const stickyUser2 = chatPanel.locator(
      '[data-sticky-user-message-id="user-2"]',
    );
    const watcherBubble = chatPanel
      .locator('[data-chat-turn-group="watcher-1"]')
      .getByTestId('portal-chat-message-content');
    await scrollAnchorToTop(window, scroller, watcherBubble, 160);
    await expect(async () => {
      const straddle = await scroller.evaluate((element) => {
        const header = element.querySelector(
          '[data-sticky-user-message-id="user-2"]',
        );
        const bubble = element.querySelector(
          '[data-chat-turn-group="watcher-1"] [data-testid="portal-chat-message-content"]',
        );
        if (!header || !bubble) throw new Error('Missing straddle geometry');
        const target = header.getBoundingClientRect().bottom - 12;
        element.scrollTop += bubble.getBoundingClientRect().top - target;
        const headerRect = header.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        return (
          bubbleRect.top < headerRect.bottom - 1 &&
          bubbleRect.bottom > headerRect.bottom
        );
      });
      expect(straddle).toBe(true);
    }).toPass({ timeout: 10_000 });
    await expect(stickyUser2).toHaveAttribute('data-stuck', 'true');
    await expect(stickyUser2).toHaveAttribute('data-underlap', '');

    await scrollAnchorToTop(
      window,
      scroller,
      window.getByText('WATCHER-REPLY paragraph 6', { exact: false }),
      160,
    );
    await expect(
      chatPanel.locator('[data-sticky-user-message-id="user-2"]'),
    ).toHaveAttribute('data-stuck', 'true');
    await expect(
      chatPanel.locator('[data-sticky-user-message-id="watcher-1"]'),
    ).toHaveCount(0);
    await expect(
      chatPanel
        .locator('[data-chat-turn-group="watcher-1"]')
        .getByTestId('sticky-turn-summary'),
    ).toHaveAttribute('data-pinned', '');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('expanding a watcher-fired turn keeps that turn in view below its pinned section head', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-steps-scroll-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.getByTestId('panel-content-chat');
    const scroller = chatPanel.getByTestId('chat-message-list-scroll');
    await expect(
      window.getByText('REPLY-THREE paragraph 4', { exact: false }),
    ).toBeVisible({ timeout: 20_000 });

    const watcherSteps = chatPanel
      .locator('[data-chat-turn-group="watcher-1"]')
      .getByRole('button', { name: /^Agent steps:/ });
    await scrollAnchorToTop(window, scroller, watcherSteps, 240);
    await watcherSteps.click();
    await expect(watcherSteps).toHaveAttribute('aria-expanded', 'true');

    // The watcher turn shares user-2's section, so user-2 stays pinned. The
    // expand travel must land on the watcher's own bubble just below that
    // pinned head, not on the section head (user-2) far above it.
    const readGeometry = () =>
      scroller.evaluate((element) => {
        const header = element.querySelector(
          '[data-sticky-user-message-id="user-2"]',
        );
        const bubble = element.querySelector(
          '[data-chat-turn-group="watcher-1"] [data-role="user"]',
        );
        if (!header || !bubble) throw new Error('Missing watcher geometry');
        const scrollerRect = element.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        return {
          headerBottom: header.getBoundingClientRect().bottom,
          bubbleTop: bubbleRect.top,
          bubbleBottom: bubbleRect.bottom,
          viewportTop: scrollerRect.top,
          viewportBottom: scrollerRect.bottom,
          stuck: header.getAttribute('data-stuck') === 'true',
        };
      });
    await expect(async () => {
      const geometry = await readGeometry();
      expect(geometry.stuck).toBe(true);
      expect(geometry.bubbleTop).toBeGreaterThanOrEqual(
        geometry.headerBottom - 1,
      );
      expect(geometry.bubbleTop).toBeLessThanOrEqual(
        geometry.headerBottom + 48,
      );
    }).toPass({ timeout: 5_000 });

    // Let the expand travel finish first, as a reader would. Mid-travel the
    // toggle can sit under the pinned head's backing; Playwright then scrolls
    // it into view, near the tail, and the collapse pins the transcript there.
    await expect
      .poll(async () => {
        const before = await scroller.evaluate((element) => element.scrollTop);
        await window.waitForTimeout(100);
        return scroller.evaluate(
          (element, top) => element.scrollTop === top,
          before,
        );
      })
      .toBe(true);

    // Collapsing again leaves the watcher turn on screen.
    await watcherSteps.click();
    await expect(watcherSteps).toHaveAttribute('aria-expanded', 'false');
    await expect(async () => {
      const geometry = await readGeometry();
      expect(geometry.bubbleBottom).toBeGreaterThan(geometry.viewportTop);
      expect(geometry.bubbleTop).toBeLessThan(geometry.viewportBottom);
    }).toPass({ timeout: 5_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

async function composerText(editor) {
  return editor.evaluate((element) =>
    Array.from(element.children)
      .filter((node) => node.getAttribute('data-slate-node') === 'element')
      .map((node) => {
        const line = node.cloneNode(true);
        line
          .querySelectorAll('[data-slate-placeholder]')
          .forEach((placeholder) => placeholder.remove());
        return (line.textContent ?? '').replace(/[\u200b\ufeff]/g, '');
      })
      .join('\n')
      .trim(),
  );
}

test('composer Up/Down history skips watcher-fired user turns', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-history-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.getByTestId('panel-content-chat');
    await expect(chatPanel).toBeVisible();
    await expect(
      window.getByText('REPLY-THREE paragraph 4', { exact: false }),
    ).toBeVisible({ timeout: 20_000 });

    const editor = window.getByRole('textbox').last();
    await editor.click();
    await expect.poll(() => composerText(editor)).toBe('');

    // Seed order of typed prompts: LONG_PROMPT, the steer, "Watch the deploy
    // pipeline", then "Summarize the rollout". The watcher turn sits between
    // the last two and must never be recalled. Check after every press so an
    // intermediate recall cannot hide behind a later overwrite.
    const firstLongPromptLine = LONG_PROMPT.split('\n')[0];
    const steps = [
      ['ArrowUp', (text) => expect(text).toBe('Summarize the rollout')],
      ['ArrowUp', (text) => expect(text).toBe('Watch the deploy pipeline')],
      ['ArrowUp', (text) => expect(text).toBe('Steer the completed turn')],
      ['ArrowUp', (text) => expect(text).toContain(firstLongPromptLine)],
      ['ArrowDown', (text) => expect(text).toBe('Steer the completed turn')],
      ['ArrowDown', (text) => expect(text).toBe('Watch the deploy pipeline')],
      ['ArrowDown', (text) => expect(text).toBe('Summarize the rollout')],
      ['ArrowDown', (text) => expect(text).toBe('')],
    ];
    for (const [key, assertText] of steps) {
      await editor.press(key);
      await expect(async () => {
        const text = await composerText(editor);
        expect(text).not.toContain('Canopy watcher fired.');
        assertText(text);
      }).toPass({ timeout: 5_000 });
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
