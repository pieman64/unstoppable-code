import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';
import { seedAdvancedDefaultPanelLayout } from './seeders/seedAdvancedDefaultPanelLayout.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const OTHER_WORKSPACE_ID = 'demo-ts-npm-next';
const WORKTREE_ID = 'demo-main';
const OTHER_CHAT_ID = 'scroll-restore-other-worktree';
const FIRST_CHAT_ID = 'scroll-restore-first';
const SECOND_CHAT_ID = 'scroll-restore-second';

function buildLongTranscript(turnCount = 48) {
  const messages = [];
  const startedAt = Date.parse('2026-04-10T12:00:00.000Z');
  for (let index = 0; index < turnCount; index += 1) {
    const turnStartedAt = startedAt + index * 60_000;
    messages.push(
      {
        id: `scroll-user-${index + 1}`,
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: `First chat transcript request ${index + 1}`,
          },
        ],
        timestamp: turnStartedAt,
      },
      {
        id: `scroll-assistant-${index + 1}`,
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text:
              index === 0
                ? 'Unique offscreen transcript marker'
                : `First seeded transcript line ${index + 1}`,
          },
        ],
        timestamp: turnStartedAt + 1_000,
      },
      {
        id: `scroll-timer-${index + 1}`,
        role: 'system',
        blocks: [
          {
            type: 'turn_timer',
            startedAt: turnStartedAt,
            completedAt: turnStartedAt + 2_000,
          },
        ],
        timestamp: turnStartedAt + 2_000,
      },
    );
  }
  return messages;
}

function distanceFromBottom(scroller) {
  return scroller.evaluate(
    (element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

// Transcript sections carry `data-chat-sticky-section` with or without
// virtualization; `data-index` exists only on virtualized rows.
function topVisibleText(scroller) {
  return scroller.evaluate((element) => {
    const viewportTop = element.getBoundingClientRect().top;
    const section = Array.from(
      element.querySelectorAll('[data-chat-sticky-section]'),
    ).find((node) => node.getBoundingClientRect().bottom > viewportTop);
    return section?.textContent?.trim().slice(0, 120) ?? '';
  });
}

test('chat restores its scroll offset after ResizeObserver-driven content growth', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-scroll-restore-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: FIRST_CHAT_ID,
    tabs: [
      {
        id: FIRST_CHAT_ID,
        title: 'Scroll restore first',
        // Keep enough complete turns to exercise offscreen transcript
        // rendering, search, and a 320px restored scroll range.
        messages: buildLongTranscript(),
      },
      {
        id: SECOND_CHAT_ID,
        title: 'Scroll restore second',
        blocks: [{ type: 'text', text: 'Second seeded transcript' }],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const visibleScroller = window.locator(
      '[data-testid="chat-message-list-scroll"]:visible',
    );
    const firstScroller = visibleScroller;
    await expect(firstScroller).toBeVisible();

    await firstScroller.evaluate((element) => {
      // OverlayScrollArea adds its own content wrapper around the transcript;
      // target the observed chat content rather than that wrapper so this
      // simulates the late transcript growth the component handles.
      const content = element.querySelector(
        '[data-testid="chat-message-list-content"]',
      );
      if (!(content instanceof HTMLElement)) {
        throw new Error('Expected chat transcript content');
      }
      const lateContent = document.createElement('div');
      lateContent.dataset.testid = 'late-chat-content';
      lateContent.style.height = '2400px';
      content.appendChild(lateContent);
    });

    await expect
      .poll(async () =>
        firstScroller.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);

    // The bottom offset above was saved programmatically by ResizeObserver.
    // Switch away before any user scroll so the real Chromium collapse and
    // unmount timing cannot replace that offset with the collapsed scrollTop
    // of 0, then revisit and verify that the transcript is still at bottom.
    await window.getByTestId(`panel-tab-panel-chat-${SECOND_CHAT_ID}`).click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${SECOND_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
    await window.getByTestId(`panel-tab-panel-chat-${FIRST_CHAT_ID}`).click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${FIRST_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(async () =>
        visibleScroller.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);

    // Searching must continue to discover and reveal text in an old offscreen
    // turn. This covers content-skipping optimizations that preserve the full
    // transcript DOM and user-visible search semantics.
    await window.keyboard.press('ControlOrMeta+f');
    const searchBar = window.getByTestId('content-search-bar');
    await expect(searchBar).toBeVisible();
    await searchBar
      .getByRole('textbox')
      .fill('Unique offscreen transcript marker');
    await expect(searchBar.getByText('1 of 1', { exact: true })).toBeVisible();
    await expect
      .poll(async () => firstScroller.evaluate((element) => element.scrollTop))
      .toBeLessThan(320);
    await searchBar.getByRole('button', { name: 'Close search' }).click();
    await expect(searchBar).toHaveCount(0);

    // Retry until the component's one-frame programmatic-scroll guard has
    // cleared and the manual scroll is accepted. The visible button proves
    // the scroll handler updated both near-bottom and persisted state.
    await expect
      .poll(async () => {
        await firstScroller.evaluate((element) => {
          element.scrollTop = 320;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        return window
          .getByRole('button', { name: 'Scroll to bottom' })
          .isVisible();
      })
      .toBe(true);
    const jumpButton = window.getByRole('button', { name: 'Scroll to bottom' });
    for (const width of [1800, 1000]) {
      await window.setViewportSize({ width, height: 1100 });
      await expect
        .poll(async () => {
          const button = await jumpButton.boundingBox();
          const composer = await window
            .locator('[data-chat-textarea]')
            .first()
            .boundingBox();
          if (!button || !composer) return Infinity;
          return Math.abs(
            button.x + button.width / 2 - composer.x - composer.width / 2,
          );
        })
        .toBeLessThanOrEqual(2);
    }
    await firstScroller.evaluate((element) => {
      element.scrollTop = 320;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const savedOffset = await firstScroller.evaluate(
      (element) => element.scrollTop,
    );
    expect(savedOffset).toBe(320);

    await window.getByTestId(`panel-tab-panel-chat-${SECOND_CHAT_ID}`).click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${SECOND_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
    await window.getByTestId(`panel-tab-panel-chat-${FIRST_CHAT_ID}`).click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${FIRST_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');

    await expect
      .poll(async () =>
        visibleScroller.evaluate((element) => element.scrollTop),
      )
      .toBe(savedOffset);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// A reply long enough to fill the viewport once Markdown renders each
// blank-line-separated line as its own paragraph.
function awayReply(id) {
  return Array.from(
    { length: 40 },
    (_, index) => `Away reply ${id} line ${index + 1}`,
  ).join('\n\n');
}

// Commit a complete agent reply to a chat through the main-process E2E
// ingress. The turn boundary marks a chat on another tab unread, which the
// renderer applies after the reply itself, so the unread dot proves the
// hidden chat received the reply before the test returns to it.
async function injectAwayReply(electronApp, window, id) {
  for (const event of [
    {
      type: 'item.completed',
      item: {
        id,
        type: 'agent_message',
        phase: 'final_answer',
        text: awayReply(id),
      },
    },
    { type: 'turn.completed', status: 'completed' },
  ]) {
    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: FIRST_CHAT_ID,
      data: { type: 'codex', event },
    });
  }
  await expect(
    window.getByTestId(`panel-tab-unread-${FIRST_CHAT_ID}`),
  ).toBeVisible();
}

for (const { label, turnCount } of [
  { label: 'a short', turnCount: 48 },
  // At least 80 turns enables transcript virtualization.
  { label: 'a virtualized', turnCount: 120 },
]) {
  test(`${label} chat returns to its reading position after a reply arrives on another tab`, async () => {
    test.setTimeout(90_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-scroll-tab-return-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: FIRST_CHAT_ID,
      tabs: [
        {
          id: FIRST_CHAT_ID,
          title: 'Scroll restore first',
          messages: buildLongTranscript(turnCount),
        },
        {
          id: SECOND_CHAT_ID,
          title: 'Scroll restore second',
          blocks: [{ type: 'text', text: 'Second seeded transcript' }],
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);

      const scroller = window.locator(
        '[data-testid="chat-message-list-scroll"]:visible',
      );
      const selectTab = async (chatId) => {
        const tab = window.getByTestId(`panel-tab-panel-chat-${chatId}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
      };
      const returnAfterReply = async (replyId) => {
        await selectTab(SECOND_CHAT_ID);
        await injectAwayReply(electronApp, window, replyId);
        await selectTab(FIRST_CHAT_ID);
        await expect(scroller).toBeVisible();
      };

      await expect(scroller).toBeVisible();
      await expect
        .poll(() => distanceFromBottom(scroller), { timeout: 10_000 })
        .toBeLessThanOrEqual(1);
      const oldBottom = await scroller.evaluate((element) => element.scrollTop);
      expect(oldBottom).toBeGreaterThan(320);

      // A chat left at the bottom reopens at the reply that arrived while
      // the person was on another tab, not at the old bottom offset.
      await returnAfterReply('away-reply-1');
      await expect(
        window.getByText('Away reply away-reply-1 line 40', { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => distanceFromBottom(scroller), { timeout: 10_000 })
        .toBeLessThanOrEqual(1);
      expect(
        await scroller.evaluate((element) => element.scrollTop),
      ).toBeGreaterThan(oldBottom);

      // A chat read mid-transcript reopens with the same rows in view.
      await expect
        .poll(async () => {
          await scroller.evaluate((element) => {
            element.scrollTop = 320;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
          return window
            .getByRole('button', { name: 'Scroll to bottom' })
            .isVisible();
        })
        .toBe(true);
      let settledOffset = -1;
      await expect
        .poll(async () => {
          const top = await scroller.evaluate((element) => element.scrollTop);
          const settled = top === settledOffset;
          settledOffset = top;
          return settled;
        })
        .toBe(true);
      const leftText = await topVisibleText(scroller);
      expect(leftText).not.toBe('');

      await returnAfterReply('away-reply-2');
      await expect
        .poll(async () => scroller.evaluate((element) => element.scrollTop), {
          timeout: 10_000,
        })
        .toBe(settledOffset);
      await expect.poll(() => topVisibleText(scroller)).toBe(leftText);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

function seedLayoutMode(userDataDir, mode) {
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    const dataDir = path.join(
      userDataDir,
      'workspaces',
      workspaceId,
      'worktree-data',
      WORKTREE_ID,
    );
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, 'panel-layout-mode.json'),
      JSON.stringify({ version: 1, mode }),
    );
  }
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { workspaceDefaultLayoutMode: mode },
    }),
  );
  if (mode === 'advanced') seedAdvancedDefaultPanelLayout({ userDataDir });
}

for (const { label, turnCount, layoutMode, restarted = false } of [
  // At least 80 turns enables transcript virtualization.
  { label: 'a virtualized', turnCount: 120, layoutMode: 'minimal' },
  { label: 'an Advanced layout', turnCount: 120, layoutMode: 'advanced' },
  // After a restart, chats hydrate without their body and load their
  // transcript page while the restored chat is already mounted; the grid then
  // re-adopts the panel container, which resets its scroll offset.
  {
    label: 'a restarted',
    turnCount: 200,
    layoutMode: 'minimal',
    restarted: true,
  },
  {
    label: 'an Advanced layout restarted',
    turnCount: 200,
    layoutMode: 'advanced',
    restarted: true,
  },
]) {
  test(`${label} chat keeps its scroll position across a worktree switch`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-scroll-worktree-switch-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite', 'ts-npm-next'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      activeTabId: FIRST_CHAT_ID,
      tabs: [
        {
          id: FIRST_CHAT_ID,
          title: 'Scroll restore first',
          messages: buildLongTranscript(turnCount),
        },
      ],
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: OTHER_WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      activeTabId: OTHER_CHAT_ID,
      tabs: [
        {
          id: OTHER_CHAT_ID,
          title: 'Other worktree chat',
          blocks: [{ type: 'text', text: 'Other worktree transcript' }],
        },
      ],
    });
    seedLayoutMode(userDataDir, layoutMode);

    if (restarted) {
      // Import the seeded chats on a first launch, then quit so the next
      // launch reads them back from canonical storage.
      const { electronApp: firstApp } = await launchCanopy({ userDataDir });
      try {
        const firstWindow = await firstApp.firstWindow();
        const firstDriver = new CanopyAppDriver(firstWindow);
        await firstDriver.waitForShell({ timeout: 30_000 });
        await firstDriver.openMainPage();
        for (const workspaceId of [OTHER_WORKSPACE_ID, WORKSPACE_ID]) {
          await firstWindow
            .locator(
              `[data-testid="worktree-row"][data-project-id="${workspaceId}"][data-worktree-id="${WORKTREE_ID}"]`,
            )
            .click();
          await expect(
            firstWindow.locator(
              '[data-testid="chat-message-list-scroll"]:visible',
            ),
          ).toBeVisible();
        }
      } finally {
        await closeCanopy(firstApp, userDataDir, { keepUserData: true });
      }
    }

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const worktreeRow = (workspaceId) =>
        window.locator(
          `[data-testid="worktree-row"][data-project-id="${workspaceId}"][data-worktree-id="${WORKTREE_ID}"]`,
        );
      const scroller = window.locator(
        '[data-testid="chat-message-list-scroll"]:visible',
      );
      const switchAwayAndBack = async () => {
        await worktreeRow(OTHER_WORKSPACE_ID).click();
        await expect(
          window.getByText('Other worktree transcript', { exact: true }),
        ).toBeVisible();
        await worktreeRow(WORKSPACE_ID).click();
        await expect(
          window.getByTestId(`panel-tab-panel-chat-${FIRST_CHAT_ID}`),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(scroller).toBeVisible();
      };

      await worktreeRow(WORKSPACE_ID).click();
      await expect(scroller).toBeVisible();
      // A first visit starts at the latest message.
      await expect
        .poll(() => distanceFromBottom(scroller), { timeout: 10_000 })
        .toBeLessThanOrEqual(1);
      expect(
        await scroller.evaluate((element) => element.scrollTop),
      ).toBeGreaterThan(320);

      // Returning to a chat that was left at the bottom lands at the bottom,
      // not at the start of the transcript.
      await switchAwayAndBack();
      await expect
        .poll(() => distanceFromBottom(scroller), { timeout: 10_000 })
        .toBeLessThanOrEqual(1);

      // A manually scrolled offset is restored after a worktree switch.
      await expect
        .poll(async () => {
          await scroller.evaluate((element) => {
            element.scrollTop = 320;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
          return window
            .getByRole('button', { name: 'Scroll to bottom' })
            .isVisible();
        })
        .toBe(true);
      // A chat opens at its tail, so scrolling up loads the older transcript
      // page and measures sections placed from estimates. Both keep the same
      // rows in view but move the raw offset, so restore the settled offset.
      let settledOffset = -1;
      await expect
        .poll(async () => {
          const top = await scroller.evaluate((element) => element.scrollTop);
          const settled = top === settledOffset;
          settledOffset = top;
          return settled;
        })
        .toBe(true);
      const leftText = await topVisibleText(scroller);
      expect(leftText).not.toBe('');
      await switchAwayAndBack();
      if (restarted) {
        // A remount reloads a different transcript window, so the same raw
        // offset cannot address the same row. It must still not jump to the
        // start of the transcript.
        await expect
          .poll(async () => scroller.evaluate((element) => element.scrollTop), {
            timeout: 10_000,
          })
          .toBeGreaterThan(0);
        // A transcript page loading after the remount is not a send, so the
        // mid-transcript reader is not pulled to the newest content.
        await window.waitForTimeout(500);
        expect(await distanceFromBottom(scroller)).toBeGreaterThan(320);
      } else {
        await expect
          .poll(async () => scroller.evaluate((element) => element.scrollTop), {
            timeout: 10_000,
          })
          .toBe(settledOffset);
        await expect.poll(() => topVisibleText(scroller)).toBe(leftText);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

function buildLongPromptTranscript(chatId, turnCount = 12) {
  const startedAt = Date.parse('2026-04-10T12:00:00.000Z');
  return Array.from({ length: turnCount }, (_, index) => {
    const at = startedAt + index * 60_000;
    return [
      {
        id: `${chatId}-user-${index + 1}`,
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: Array.from(
              { length: 8 },
              (_, line) => `${chatId} prompt ${index + 1} line ${line + 1}`,
            ).join('\n'),
          },
        ],
        timestamp: at,
      },
      {
        id: `${chatId}-assistant-${index + 1}`,
        role: 'assistant',
        blocks: [{ type: 'text', text: `${chatId} reply ${index + 1}` }],
        timestamp: at + 1_000,
      },
    ];
  }).flat();
}

test('switching back to a chat tab draws long prompts collapsed from the first frame', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-tab-switch-prompts-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: FIRST_CHAT_ID,
    tabs: [
      {
        id: FIRST_CHAT_ID,
        title: 'Scroll restore first',
        messages: buildLongPromptTranscript(FIRST_CHAT_ID),
      },
      {
        id: SECOND_CHAT_ID,
        title: 'Scroll restore second',
        messages: buildLongPromptTranscript(SECOND_CHAT_ID),
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const scroller = window.locator(
      '[data-testid="chat-message-list-scroll"]:visible',
    );
    const collapsedPrompts = scroller.locator(
      '[data-testid="user-message-content"][data-collapsed="true"]',
    );
    const selectTab = async (chatId) => {
      const tab = window.getByTestId(`panel-tab-panel-chat-${chatId}`);
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    };

    // Visit both chats so each prompt has been measured once.
    await expect(collapsedPrompts.first()).toBeVisible();
    await selectTab(SECOND_CHAT_ID);
    await expect(collapsedPrompts.first()).toBeVisible();

    // Mutation callbacks run after React commits and before the browser
    // paints, so they see each prompt exactly as its first frame shows it.
    await window.evaluate(() => {
      const seen = [];
      window.__tabSwitchPromptStates = seen;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const prompts = node.matches('[data-testid="user-message-content"]')
              ? [node]
              : node.querySelectorAll('[data-testid="user-message-content"]');
            for (const prompt of prompts) {
              seen.push(prompt.getAttribute('data-collapsed'));
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await selectTab(FIRST_CHAT_ID);
    await expect(collapsedPrompts.first()).toBeVisible();
    await expect
      .poll(() => distanceFromBottom(scroller), { timeout: 10_000 })
      .toBeLessThanOrEqual(1);

    const firstFrameStates = await window.evaluate(
      () => window.__tabSwitchPromptStates,
    );
    expect(firstFrameStates.length).toBeGreaterThan(0);
    expect(firstFrameStates.filter((state) => state !== 'true')).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
