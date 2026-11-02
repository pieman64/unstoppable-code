import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import { buildSyntheticTranscriptMessages } from '../performance/scenarios.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const LARGE_CHAT_ID = 'large-transcript-navigation';
const SECOND_CHAT_ID = 'large-transcript-second';
const WATCHER_CHAT_ID = 'watcher-heavy-transcript';
const HISTORICAL_FILE_PATH = 'src/status.ts';
const TURN_COUNT = 160;
const DENSE_MESSAGE_COUNT = 11_500;
const DENSE_MESSAGE_BYTES = 1_200;
const STARTED_AT = Date.parse('2026-04-10T12:00:00.000Z');
const LIVE_MARKER = 'Canopy-CLARGE';
const LIVE_REPLY = 'Windowed transcript live reply';
const DENSE_LIVE_MARKER = 'Canopy-CLARGE-DENSE';
const DENSE_LIVE_REPLY = 'Dense windowed transcript live reply';
const HIDDEN_PROMPT_MARKER = 'Hidden collapsed prompt search marker';

const SEND_MESSAGE_INPUT = JSON.stringify({
  to: 'large-transcript-reviewer',
  summary: 'Review the recent transcript tail',
  message: 'Confirm the variable-height tail remains usable.',
});

function buildLargeTranscript() {
  const messages = [];
  for (let index = 0; index < TURN_COUNT; index += 1) {
    const turnNumber = index + 1;
    const turnStartedAt = STARTED_AT + index * 60_000;
    const isFirst = index === 0;
    const isLast = index === TURN_COUNT - 1;
    const assistantBlocks = isLast
      ? [
          {
            type: 'text',
            text: [
              '## Recent transcript tail',
              '',
              '- [x] Recent Markdown remains interactive',
              '',
              '| Surface | State |',
              '| --- | --- |',
              '| Large transcript | Ready |',
              '',
              '> Variable-height content must preserve the bottom anchor.',
            ].join('\n'),
          },
          {
            type: 'tool_use',
            toolUseId: 'large-transcript-send-message',
            toolName: 'SendMessage',
            input: SEND_MESSAGE_INPUT,
          },
          {
            type: 'tool_result',
            toolUseId: 'large-transcript-send-message',
            toolName: 'SendMessage',
            output: 'Large transcript review delivered',
            isError: false,
          },
        ]
      : [
          {
            type: 'text',
            text: isFirst
              ? [
                  '## Unique historical transcript marker',
                  '',
                  `Open **${HISTORICAL_FILE_PATH}** from this old turn.`,
                ].join('\n')
              : `Historical assistant response ${turnNumber}.`,
          },
        ];

    messages.push(
      {
        id: `large-user-${turnNumber}`,
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: isFirst
              ? [
                  'Large transcript request 1.',
                  'Context row two.',
                  'Context row three.',
                  'Context row four.',
                  HIDDEN_PROMPT_MARKER,
                ].join('\n')
              : `Large transcript request ${turnNumber}.`,
          },
        ],
        timestamp: turnStartedAt,
      },
      {
        id: `large-assistant-${turnNumber}`,
        role: 'assistant',
        blocks: assistantBlocks,
        timestamp: turnStartedAt + 10_000,
      },
      {
        id: `large-timer-${turnNumber}`,
        role: 'system',
        blocks: [
          {
            type: 'turn_timer',
            startedAt: turnStartedAt,
            completedAt: turnStartedAt + 30_000,
          },
        ],
        timestamp: turnStartedAt + 20_000,
      },
    );
  }
  return messages;
}

function buildPerformanceDenseTranscript() {
  return buildSyntheticTranscriptMessages({
    transcriptId: 'dense-e2e',
    messageCount: DENSE_MESSAGE_COUNT,
    messageBytes: DENSE_MESSAGE_BYTES,
    shape: 'dense',
  });
}

function buildWatcherHeavyTranscript() {
  let userTurnIndex = 0;
  return buildLargeTranscript().map((message) => {
    if (message.role !== 'user') return message;
    userTurnIndex += 1;
    return userTurnIndex === 1
      ? message
      : {
          ...message,
          watcherFired: { kind: 'Pipeline completion (Deploy)' },
        };
  });
}

async function waitForStableTranscriptViewport(scroller) {
  let previous = null;
  let stableSamples = 0;
  let settled = null;
  await expect
    .poll(
      async () => {
        const current = await scroller.evaluate((element) => {
          const scrollerBox = element.getBoundingClientRect();
          const rows = [
            ...element.querySelectorAll(
              '[data-testid="chat-transcript-virtual-window"] > [data-index]',
            ),
          ];
          const anchor = rows.find((row) => {
            const box = row.getBoundingClientRect();
            return box.bottom > scrollerBox.top;
          });
          if (!(anchor instanceof HTMLElement)) return null;
          return {
            scrollTop: Math.round(element.scrollTop),
            anchorIndex: Number(anchor.dataset.index),
            anchorTop:
              Math.round(
                (anchor.getBoundingClientRect().top - scrollerBox.top) * 10,
              ) / 10,
          };
        });
        const signature = JSON.stringify(current);
        stableSamples = signature === previous ? stableSamples + 1 : 0;
        previous = signature;
        if (stableSamples >= 2) settled = current;
        return stableSamples;
      },
      { intervals: [100, 100, 100, 200, 200], timeout: 5000 },
    )
    .toBeGreaterThanOrEqual(2);
  return settled;
}

async function scrollTranscriptToTop(scroller) {
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        const reachedTop = await scroller.evaluate(async (element) => {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          element.scrollTo({ top: 0, behavior: 'instant' });
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return (
            Math.round(element.scrollTop) <= 2 &&
            element.querySelector(
              '[data-testid="chat-transcript-virtual-window"] > [data-index="0"]',
            ) !== null
          );
        });
        stableSamples = reachedTop ? stableSamples + 1 : 0;
        return stableSamples;
      },
      { intervals: [100, 100, 200, 200, 500], timeout: 5000 },
    )
    .toBeGreaterThanOrEqual(2);
}

test('watcher-heavy transcripts keep virtual rows bounded', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-heavy-transcript-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: WATCHER_CHAT_ID,
    tabs: [
      {
        id: WATCHER_CHAT_ID,
        title: 'Watcher-heavy transcript',
        messages: buildWatcherHeavyTranscript(),
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await window.evaluate(() => {
      const probe = {
        reads: 0,
        readsAfterWrite: 0,
        writes: 0,
        deferredCollapsed: 0,
        checkedCollapsed: 0,
      };
      window.__stickyGeometryProbe = probe;
      const NativeResizeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeResizeObserver {
        constructor(callback) {
          super((entries, observer) => {
            callback(entries, observer);
            for (const entry of entries) {
              const wrapper = entry.target;
              if (!wrapper.matches('[data-testid="sticky-user-message"]'))
                continue;
              const content = wrapper.querySelector(
                '[data-testid="user-message-content"]',
              );
              const height = entry.borderBoxSize[0]?.blockSize;
              if (height === undefined) continue;
              const clamp = Number.parseFloat(
                content?.dataset.collapsedMaxPx ?? '',
              );
              if (content?.dataset.collapsed === 'false' && height > clamp)
                continue;
              probe.checkedCollapsed++;
              const section = wrapper.closest('[data-chat-sticky-section]');
              if (
                section?.getAttribute('data-chat-sticky-user-height') !==
                `${Math.round(height)}px`
              ) {
                probe.deferredCollapsed++;
              }
            }
          });
        }
      };
      let wroteGeometry = false;
      const reset = () => {
        wroteGeometry = false;
        requestAnimationFrame(reset);
      };
      requestAnimationFrame(reset);
      const height = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'offsetHeight',
      );
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        ...height,
        get() {
          if (this.matches('[data-testid="sticky-user-message"]')) {
            probe.reads++;
            if (wroteGeometry) probe.readsAfterWrite++;
          }
          return height.get.call(this);
        },
      });
      // The pinned height is published on the section (and copied to its
      // summary chips) rather than as an inherited custom property.
      const setAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (name === 'data-chat-sticky-user-height') {
          wroteGeometry = true;
          probe.writes++;
        }
        return setAttribute.call(this, name, value);
      };
    });
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${WATCHER_CHAT_ID}"]`,
    );
    await expect(chatPanel).toBeVisible({ timeout: 60_000 });
    await expect(
      chatPanel.getByTestId('chat-transcript-virtual-window'),
    ).toBeVisible();
    const mountedRows = chatPanel.locator('[data-section-item-count]');
    await expect.poll(() => mountedRows.count()).toBeGreaterThan(1);
    const mountedItemCounts = await mountedRows.evaluateAll((rows) =>
      rows.map((row) => Number(row.getAttribute('data-section-item-count'))),
    );
    expect(mountedItemCounts.every((count) => count <= 20)).toBe(true);
    await expect
      .poll(() => window.evaluate(() => window.__stickyGeometryProbe.writes))
      .toBeGreaterThan(1);
    expect(
      await window.evaluate(() => window.__stickyGeometryProbe.reads),
    ).toBe(0);
    expect(
      await window.evaluate(
        () => window.__stickyGeometryProbe.checkedCollapsed,
      ),
    ).toBeGreaterThan(0);
    expect(
      await window.evaluate(
        () => window.__stickyGeometryProbe.deferredCollapsed,
      ),
    ).toBe(0);
    expect(
      await window.evaluate(() => window.__stickyGeometryProbe.readsAfterWrite),
    ).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('dense performance-sized transcript exposes a prompt appended during initial measurement', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-dense-transcript-append-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: LARGE_CHAT_ID,
    tabs: [
      {
        id: LARGE_CHAT_ID,
        title: 'Dense performance transcript',
        messages: buildPerformanceDenseTranscript(),
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, DENSE_LIVE_MARKER, {
    llm: {
      steps: [{ text: DENSE_LIVE_REPLY, stopReason: 'end_turn' }],
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${LARGE_CHAT_ID}"]`,
    );
    await expect(chatPanel).toBeVisible({ timeout: 60_000 });
    await expect(
      chatPanel.getByTestId('chat-message-list-scroll'),
    ).toBeVisible();

    const liveMessage = `[${DENSE_LIVE_MARKER}] Append while measuring.`;
    await chatPanel.getByRole('textbox').first().fill(liveMessage);
    await chatPanel.getByRole('button', { name: 'Send message' }).click();
    await expect(chatPanel.getByText(liveMessage).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(chatPanel.getByText(DENSE_LIVE_REPLY).first()).toBeVisible({
      timeout: 90_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('large transcript preserves tail, historical navigation, rich blocks, and restored scroll', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-large-transcript-navigation-'),
  );
  const demoSeed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: LARGE_CHAT_ID,
    tabs: [
      {
        id: LARGE_CHAT_ID,
        title: 'Large transcript navigation',
        messages: buildLargeTranscript(),
      },
      {
        id: SECOND_CHAT_ID,
        title: 'Large transcript second',
        forkedFrom: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: LARGE_CHAT_ID,
        },
        messages: [
          {
            id: 'large-second-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Second chat marker' }],
            timestamp: STARTED_AT,
          },
          {
            id: 'large-second-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Second chat reply' }],
            timestamp: STARTED_AT + 1_000,
          },
          {
            id: 'large-second-timer',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: STARTED_AT,
                completedAt: STARTED_AT + 2_000,
              },
            ],
            timestamp: STARTED_AT + 2_000,
          },
        ],
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, LIVE_MARKER, {
    llm: {
      steps: [{ text: LIVE_REPLY, stopReason: 'end_turn' }],
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${LARGE_CHAT_ID}"]`,
    );
    const scroller = chatPanel.getByTestId('chat-message-list-scroll');
    await expect(chatPanel).toBeVisible();
    await expect(scroller).toBeVisible();

    // Sending immediately after selection must advance a windowed transcript
    // to its new tail even if its initial estimated measurements are still
    // settling.
    const liveMessage = `[${LIVE_MARKER}] Append to the large transcript.`;
    const composer = chatPanel.getByRole('textbox').first();
    await composer.fill(liveMessage);
    await chatPanel.getByRole('button', { name: 'Send message' }).click();
    await expect(chatPanel.getByText(liveMessage).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(chatPanel.getByText(LIVE_REPLY).first()).toBeVisible({
      timeout: 90_000,
    });
    // The live turn renders its reply exactly once: per-frame rendering of
    // streamed state (phase 12) must not duplicate or drop it. The SendMessage
    // assertions below cover the completed tail turn's merged tool result.
    const liveTurn = chatPanel
      .locator('[data-chat-turn-group]')
      .filter({ hasText: LIVE_REPLY });
    await expect(liveTurn).toHaveCount(1);
    expect((await liveTurn.innerText()).split(LIVE_REPLY).length - 1).toBe(1);

    // A first visit to a long transcript starts at the usable recent tail.
    await expect(
      chatPanel.getByRole('heading', {
        name: 'Recent transcript tail',
      }),
    ).toBeVisible();
    const checkedTask = chatPanel.locator('input[type="checkbox"][checked]');
    await expect(checkedTask).toHaveCount(1);
    await expect(checkedTask).toBeDisabled();
    await expect(chatPanel.getByRole('cell', { name: 'Ready' })).toBeVisible();

    // The seeded SendMessage belongs to the final reply, so Detailed keeps
    // its row inline; it does not create an intermediate Agent steps group.
    const sendMessageCard = chatPanel
      .locator('button[aria-expanded][data-step-row]')
      .filter({ hasText: 'Agent message' })
      .filter({ hasText: 'Review the recent transcript tail' });
    await expect(sendMessageCard).toBeVisible();
    await sendMessageCard.click();
    await expect(sendMessageCard).toHaveAttribute('aria-expanded', 'true');
    await expect(
      chatPanel.getByText('Large transcript review delivered', {
        exact: true,
      }),
    ).toBeVisible();

    // Interacting with a stateful row retains that row outside the ordinary
    // virtual range. Continue scrolling through automatic history pages; each
    // prepend preserves the current anchor instead of jumping to the start.
    const historicalHeading = chatPanel.getByRole('heading', {
      name: 'Unique historical transcript marker',
    });
    await scroller.hover();
    await expect
      .poll(
        async () => {
          if (await historicalHeading.isVisible()) return true;
          await window.mouse.wheel(0, -20000);
          return historicalHeading.isVisible();
        },
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(sendMessageCard).toBeVisible();
    await expect(sendMessageCard).toHaveAttribute('aria-expanded', 'true');

    // DOM-backed transcript search must discover and reveal an old turn even
    // when a rendering optimization initially omits it from the viewport.
    await window.keyboard.press('ControlOrMeta+f');
    const searchBar = window.getByTestId('content-search-bar');
    await expect(searchBar).toBeVisible();
    await searchBar
      .getByRole('textbox')
      .fill('Unique historical transcript marker');
    await expect(searchBar.getByText('1 of 1', { exact: true })).toBeVisible();
    await expect(sendMessageCard).toHaveAttribute('aria-expanded', 'true');
    await expect(
      chatPanel.getByRole('heading', {
        name: 'Unique historical transcript marker',
      }),
    ).toBeVisible();

    await searchBar.getByRole('textbox').fill(HIDDEN_PROMPT_MARKER);
    await expect(searchBar.getByText('1 of 1', { exact: true })).toBeVisible();
    const hiddenPromptContent = chatPanel
      .getByTestId('user-message-content')
      .filter({ hasText: HIDDEN_PROMPT_MARKER })
      .first();
    await expect(hiddenPromptContent).toBeVisible();
    await expect(hiddenPromptContent).toHaveAttribute(
      'data-collapsed',
      'false',
    );

    const searchInput = searchBar.getByRole('textbox');
    expect(
      await searchInput.evaluate((input) => {
        const rect = input.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit === input || input.contains(hit);
      }),
    ).toBe(true);
    await searchBar.getByRole('button', { name: 'Close search' }).click();
    await expect(sendMessageCard).toHaveAttribute('aria-expanded', 'true');

    // A manually selected position survives a tab round trip. It sits in the
    // middle of the third turn, so the first turn stays inside the window's
    // two-row overscan, where the reconcile below can prove every row above it
    // is measured. It is read from the rendered rows because turn heights
    // follow the footer and bubble design; a fixed pixel offset drifts into
    // the fourth turn when they change.
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    let restorationOffset = null;
    await expect
      .poll(async () => {
        restorationOffset = await scroller.evaluate((element, marker) => {
          const panel = element.closest('[data-testid="panel-content-chat"]');
          const prompt = Array.from(
            panel?.querySelectorAll('[data-testid="user-message-content"]') ??
              [],
          ).find((node) => node.textContent?.includes(marker));
          const virtualWindow = panel?.querySelector(
            '[data-testid="chat-transcript-virtual-window"]',
          );
          if (
            panel?.querySelector('[data-testid="content-search-bar"]') ||
            prompt?.getAttribute('data-collapsed') !== 'true'
          ) {
            return null;
          }
          let expectedStart = 0;
          for (let index = 0; index < 3; index += 1) {
            const row = virtualWindow?.querySelector(
              `:scope > [data-index="${index}"]`,
            );
            if (!(row instanceof HTMLElement)) return null;
            const height = Math.round(row.getBoundingClientRect().height);
            if (
              Number.parseFloat(row.style.top) !== expectedStart ||
              height <= 0
            ) {
              return null;
            }
            if (index === 2) return expectedStart + Math.floor(height / 2);
            expectedStart += height;
          }
          return null;
        }, HIDDEN_PROMPT_MARKER);
        return restorationOffset;
      })
      .not.toBeNull();
    const reconcileTranscriptGeometry = (setOffset) =>
      scroller.evaluate(
        (element, { destination, marker, setDestination }) => {
          const panel = element.closest('[data-testid="panel-content-chat"]');
          const content = panel?.querySelector(
            '[data-testid="chat-message-list-content"]',
          );
          const virtualWindow = panel?.querySelector(
            '[data-testid="chat-transcript-virtual-window"]',
          );
          const prompt = Array.from(
            panel?.querySelectorAll('[data-testid="user-message-content"]') ??
              [],
          ).find((node) => node.textContent?.includes(marker));
          if (
            !panel ||
            panel.querySelector('[data-testid="content-search-bar"]') ||
            prompt?.getAttribute('data-collapsed') !== 'true' ||
            !(content instanceof HTMLElement) ||
            Number.parseFloat(getComputedStyle(content).paddingTop) !== 0 ||
            !(virtualWindow instanceof HTMLElement) ||
            element.clientHeight <= 0 ||
            element.scrollHeight - element.clientHeight < destination
          ) {
            return false;
          }

          const rows = new Map();
          for (const row of virtualWindow.children) {
            if (
              !(row instanceof HTMLElement) ||
              !/^\d+$/.test(row.dataset.index ?? '')
            ) {
              continue;
            }
            const index = Number(row.dataset.index);
            if (rows.has(index)) return false;
            rows.set(index, {
              height: row.getBoundingClientRect().height,
              start: Number.parseFloat(row.style.top),
            });
          }

          let index = 0;
          let row = rows.get(index);
          if (!row || row.start !== 0) return false;
          while (row.start <= destination) {
            const next = rows.get(index + 1);
            if (
              !next ||
              !Number.isFinite(row.start) ||
              !Number.isFinite(row.height) ||
              row.height <= 0 ||
              !Number.isFinite(next.start) ||
              next.start !== row.start + Math.round(row.height)
            ) {
              return false;
            }
            index += 1;
            row = next;
          }
          if (!Number.isFinite(row.height) || row.height <= 0) return false;
          if (setDestination) {
            element.scrollTop = destination;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
          return true;
        },
        {
          destination: restorationOffset,
          marker: HIDDEN_PROMPT_MARKER,
          setDestination: setOffset,
        },
      );
    await scroller.evaluate((element, destination) => {
      element.scrollTop = destination;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, restorationOffset);
    await expect.poll(() => reconcileTranscriptGeometry(false)).toBe(true);
    await expect.poll(() => reconcileTranscriptGeometry(true)).toBe(true);
    await expect(
      window.getByRole('button', { name: 'Scroll to bottom' }),
    ).toBeVisible();
    const restorationAnchor = chatPanel.locator('p', {
      hasText: /^Historical assistant response 4\.$/,
    });
    await expect(restorationAnchor).toBeVisible();
    const savedPosition = await scroller.evaluate(
      (element, anchor) => ({
        anchorTop:
          anchor.getBoundingClientRect().top -
          element.getBoundingClientRect().top,
        scrollTop: element.scrollTop,
      }),
      await restorationAnchor.elementHandle(),
    );
    expect(savedPosition.scrollTop).toBe(restorationOffset);
    const savedOffset = savedPosition.scrollTop;
    const savedAnchorTop = savedPosition.anchorTop;

    await window.getByTestId(`panel-tab-panel-chat-${SECOND_CHAT_ID}`).click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${SECOND_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
    const secondChatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${SECOND_CHAT_ID}"]`,
    );
    const forkDivider = secondChatPanel.getByRole('button', {
      name: 'Forked from conversation',
    });
    const secondPrompt = secondChatPanel.getByText('Second chat marker', {
      exact: true,
    });
    await expect(forkDivider).toBeVisible();
    await expect(secondPrompt).toBeVisible();
    expect(
      await forkDivider.evaluate(
        (divider, prompt) => {
          return Boolean(
            divider.compareDocumentPosition(prompt) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          );
        },
        await secondPrompt.elementHandle(),
      ),
    ).toBe(true);
    await window.getByTestId(`panel-tab-panel-chat-${LARGE_CHAT_ID}`).click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${LARGE_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(async () => scroller.evaluate((element) => element.scrollTop))
      .toBe(savedOffset);
    await expect(restorationAnchor).toBeVisible();
    const restoredPosition = await scroller.evaluate(
      (element, anchor) => ({
        anchorTop:
          anchor.getBoundingClientRect().top -
          element.getBoundingClientRect().top,
        scrollTop: element.scrollTop,
      }),
      await restorationAnchor.elementHandle(),
    );
    expect(restoredPosition.scrollTop).toBe(savedOffset);
    expect(restoredPosition.anchorTop).toBe(savedAnchorTop);

    // Scrolling to the historical boundary materializes its file decorator;
    // the transcript owns index loading and does not rely on Cmd+P warming it.
    await scrollTranscriptToTop(scroller);
    const historicalMention = chatPanel.getByRole('button', {
      name: `Open ${HISTORICAL_FILE_PATH}`,
    });
    await expect(historicalMention).toBeVisible({ timeout: 30_000 });
    await historicalMention.click();
    const historicalAbsolutePath = path.join(
      worktreePath,
      HISTORICAL_FILE_PATH,
    );
    await expect
      .poll(
        async () => {
          const layout = await getLayout(window);
          return collectLeaves(layout?.root).some((leaf) =>
            leaf.panels.some(
              (panel) =>
                panel.kind === 'file-diff' &&
                panel.instance?.filePath === historicalAbsolutePath,
            ),
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Raw 500-row projections must be upgraded to the bounded turn-aware view.
// An in-turn answer is still human-authored, but cannot replace the original
// prompt/timer frame (Gorilla's 538-message completed turn regression).
test('retains the prompt and completed frame when a bounded transcript arrives', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-turn-completion-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const messages = [
    {
      id: 'completion-user',
      role: 'user',
      timestamp: STARTED_AT,
      blocks: [{ type: 'text', text: 'Verify this long-running task.' }],
    },
    {
      id: 'completion-timer',
      role: 'system',
      timestamp: STARTED_AT,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: STARTED_AT,
          completedAt: STARTED_AT + 60_000,
        },
      ],
    },
    ...Array.from({ length: 534 }, (_, index) => ({
      id: `completion-tool-${index}`,
      role: 'system',
      timestamp: STARTED_AT + index + 1,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: `completion-tool-${index}`,
          toolName: 'command',
          input: 'git status --short',
        },
        {
          type: 'tool_result',
          toolUseId: `completion-tool-${index}`,
          toolName: 'command',
          output: 'clean',
          isError: false,
        },
      ],
    })),
    {
      id: 'completion-answer',
      role: 'user',
      timestamp: STARTED_AT + 58_000,
      blocks: [
        {
          type: 'text',
          text: 'Keep the review manual.',
          asyncQuestionAnswer: {
            requestId: 'completion-question',
            startsTurn: false,
            answers: [],
          },
        },
      ],
    },
    {
      id: 'completion-final',
      role: 'assistant',
      timestamp: STARTED_AT + 59_000,
      blocks: [{ type: 'text', text: 'The long-running task is complete.' }],
    },
  ];
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: LARGE_CHAT_ID,
    tabs: [{ id: LARGE_CHAT_ID, title: 'Turn completion', messages }],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Exercise compatibility with an already loaded raw page. Read that page
    // from real storage; do not fabricate missing rows or terminal events.
    await electronApp.evaluate(({ ipcMain }, chatId) => {
      const getState = ipcMain._invokeHandlers.get('chat:get-state');
      const getPage = ipcMain._invokeHandlers.get('chat:get-transcript-page');
      globalThis.__rawCompletionPages = 0;
      ipcMain.removeHandler('chat:get-state');
      ipcMain.handle('chat:get-state', async (event, target) => {
        const snapshot = await getState(event, target);
        if (
          target.projectId !== 'demo-ts-pnpm-vite' ||
          target.worktreeId !== 'demo-main'
        )
          return snapshot;
        const page = await getPage(event, { ...target, chatId });
        const { messages, ...transcriptWindow } = page;
        globalThis.__rawCompletionPages++;
        return {
          ...snapshot,
          tabsFile: {
            ...snapshot.tabsFile,
            tabs: snapshot.tabsFile.tabs.map((tab) =>
              tab.id === chatId
                ? { ...tab, messages, transcriptWindow, transcriptLoaded: true }
                : tab,
            ),
          },
        };
      });
    }, LARGE_CHAT_ID);
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${LARGE_CHAT_ID}"]`,
    );
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__rawCompletionPages))
      .toBeGreaterThan(0);
    await expect(
      panel.getByText('The long-running task is complete.', { exact: true }),
    ).toBeVisible();
    await expect(panel.getByTestId('turn-timer')).toHaveAttribute(
      'data-state',
      'completed',
      { timeout: 5_000 },
    );
    await expect(
      panel.locator('[data-chat-turn-group="completion-user"]'),
    ).toBeVisible();
    await expect(
      panel.getByText('git status --short', { exact: true }),
    ).toHaveCount(0);
    await expect(panel.getByTestId('chat-stop-generation')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
